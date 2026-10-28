import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { getRecordById, ensureRecordColumns, insertPipelineEvent, upsertRecord } from './db.js';
import type { openListDb } from './db.js';
import { flattenPipelineSteps } from '../lib/subpipelines.js';
import { assertRecordAccessForMutation } from '../policy/canary-isolation.js';
import { reconcileIdempotencyProviderAccepted } from './idempotency.js';
import { externalObject, externalText, validateExternalOutputs } from './external-values.js';

type OperationContext = { key: string; recordId: string; stepId: string };
const context = new AsyncLocalStorage<OperationContext>();
export const externalOperationKey = (listDir: string, scope: string, key: string) => createHash('sha256').update(JSON.stringify([listDir, scope, key])).digest('hex');
export const withExternalOperation = <T>(operation: OperationContext, run: () => Promise<T>) => context.run(operation, run);
export const externalOperationEnv = (): Record<string, string> => {
  const active = context.getStore();
  return active ? { AO_OPERATION_KEY: active.key, AO_RECORD_ID: active.recordId, AO_STEP_ID: active.stepId } : {};
};
type Db = ReturnType<typeof openListDb>;
export const listExternalOperations = (db: Db) => (db.prepare('SELECT * FROM idempotency ORDER BY created_at').all() as Array<Record<string, unknown>>)
  .flatMap((row) => {
    const payload = externalObject(JSON.parse(externalText(row.payload_json) || '{}'));
    return payload.operation_key ? [{ operation_key: payload.operation_key, record_id: payload.record_id, step_id: payload.step_id,
      state: row.status === 'sent' ? 'completed' : row.status, outputs: payload.outputs || {}, updated_at: row.updated_at }] : [];
  });
export const operationOutputs = (db: Db, recordId: string, step: Record<string, unknown>) => {
  const current = externalObject(getRecordById({ db, id: recordId }));
  return Object.fromEntries(Object.keys(externalObject(step.outputs)).map((key) => [key, current[key]]));
};
export const reconcileExternalOperation = ({ db, config, listDir, receipt }: { db: Db; config: unknown; listDir: string; receipt: unknown }) => {
  const input = externalObject(receipt);
  const rows = db.prepare('SELECT * FROM idempotency').all() as Array<Record<string, unknown>>;
  const found = rows.find((r) => externalObject(JSON.parse(externalText(r.payload_json) || '{}')).operation_key === input.operation_key);
  if (!found) throw new Error('Unknown external operation key.');
  const metadata = externalObject(JSON.parse(externalText(found.payload_json)));
  const recordId = externalText(metadata.record_id);
  assertRecordAccessForMutation({ listDir, recordId });
  if (input.status !== 'succeeded') return { operation_key: input.operation_key, state: 'unknown', reconciled: false };
  const step = flattenPipelineSteps(config).find((s) => s.id === metadata.step_id);
  if (!step) throw new Error('The operation step no longer exists in the configured graph.');
  const values = validateExternalOutputs(step.outputs, input.outputs);
  const current = getRecordById({ db, id: recordId });
  if (!current) throw new Error('The operation record no longer exists.');
  if (found.status === 'sent') {
    if (JSON.stringify(metadata.outputs) !== JSON.stringify(values)) throw new Error('Receipt conflicts with completed operation outputs.');
    return { operation_key: input.operation_key, state: 'completed', reconciled: false };
  }
  return db.transaction(() => {
    ensureRecordColumns({ db, columns: Object.keys(values) });
    upsertRecord({ db, row: { ...current, ...values } });
    const result = reconcileIdempotencyProviderAccepted({ db, idemKey: externalText(found.idem_key), scope: externalText(found.scope),
      providerId: externalText(input.operation_key), payload: { outputs: values, external_receipt: true } });
    if (!result.reconciled) throw new Error(`Operation reconciliation refused: ${result.reason}`);
    insertPipelineEvent({ db, event: { id: randomUUID(), record_id: recordId, step_id: step.id, kind: step.kind, passed: true, reason: 'external_operation_reconciled' } });
    return { operation_key: input.operation_key, state: 'completed', reconciled: true, outputs: values };
  })();
};
