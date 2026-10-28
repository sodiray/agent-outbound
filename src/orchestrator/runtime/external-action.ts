import { executeToolCallAction } from '../enrichment/actions/tool-call.js';
import { ensureRecordColumns, getRecordById, upsertRecord } from './db.js';
import type { openListDb } from './db.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { externalObject, externalText, validateExternalOutputs } from './external-values.js';

const DEFERRED_OUTCOME_KEY = 'ao_outcome';
const DEFERRED_ALLOWED_KEYS = new Set([DEFERRED_OUTCOME_KEY, 'reason', 'retry_after']);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const deferredOutcome = (value: unknown): { reason: string; retryAfter: string } | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (!(DEFERRED_OUTCOME_KEY in result)) return null;
  if (result[DEFERRED_OUTCOME_KEY] !== 'deferred') throw new Error('Invalid ao_outcome value.');
  if (Object.keys(result).some((key) => !DEFERRED_ALLOWED_KEYS.has(key))) {
    throw new Error('Deferred action result must not contain outputs.');
  }
  const reason = typeof result.reason === 'string' ? result.reason.trim() : '';
  if (!reason || reason.length > 280) throw new Error('Deferred action result requires a short reason.');
  const retryAfter = result.retry_after === undefined ? '' : String(result.retry_after).trim();
  if (retryAfter && (!ISO_TIMESTAMP.test(retryAfter) || !Number.isFinite(Date.parse(retryAfter)))) {
    throw new Error('Deferred action retry_after must be an ISO-8601 timestamp.');
  }
  return { reason, retryAfter };
};

export const executeExternalAction = async ({ db, listDir, step, record, mcp, toolCatalog }: {
  db: ReturnType<typeof openListDb>; listDir: string; step: Record<string, unknown>; record: Record<string, unknown>;
  mcp?: Client; toolCatalog?: unknown;
}) => {
  if (step.side_effecting !== true || !step.idempotency) throw new Error('Action nodes require a declared effect and idempotency.');
  const result = await executeToolCallAction({ listDir, stepId: externalText(step.id),
    stepConfig: { ...step, action: 'tool_call', external_send: true }, record, mcp, toolCatalog });
  if (result.reason) throw new Error(result.reason);
  const deferred = deferredOutcome(result.rawResult);
  if (deferred) {
    return {
      passed: false,
      deferred: true,
      reason: deferred.reason,
      retryAfter: deferred.retryAfter,
    };
  }
  const values = validateExternalOutputs(step.outputs, result.outputs);
  db.transaction(() => {
    ensureRecordColumns({ db, columns: Object.keys(values) });
    upsertRecord({ db, row: { ...getRecordById({ db, id: record._row_id }), ...values } });
  })();
  return { passed: true, reason: 'external_action_completed', declaredOutputWrites: Object.fromEntries(Object.entries(values).map(([field, value]) => [field, { provided: true, value }])) };
};
