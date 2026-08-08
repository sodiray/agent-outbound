import {
  ensureRecordColumns,
  listContactsByRecord,
  upsertRecord,
} from '../runtime/db.js';
import { getRecordRowId } from '../lib/record.js';
import { hydrateActiveContactOntoRecord, type ContactRow } from './load-contacts.js';
import {
  evaluateSequenceReachability,
  reenteredSequencePatch,
  unreachableSequencePatch,
} from './sequence-reachability.js';

export type SequenceReachabilityReconciliation = {
  reachable: boolean;
  record: Record<string, unknown>;
};

type SequenceReachabilityDb = {
  prepare: (sql: string) => {
    all: (...args: unknown[]) => ContactRow[];
    get: (...args: unknown[]) => ContactRow | undefined;
  };
};

export const reconcileSequenceReachability = ({
  db,
  record,
  persist = true,
}: {
  db: SequenceReachabilityDb;
  record: Record<string, unknown>;
  persist?: boolean;
}): SequenceReachabilityReconciliation => {
  const hydrated = hydrateActiveContactOntoRecord({ db, record });
  const targetRecord = hydrated.record;
  const reachability = evaluateSequenceReachability({
    record: targetRecord,
    contacts: listContactsByRecord({ db, recordId: getRecordRowId(targetRecord) }),
  });
  if (!reachability.applicable || reachability.reachable) {
    const shouldReenter = reachability.applicable
      && String(targetRecord.account_sequence_state || '').trim().toLowerCase() === 'unreachable';
    const reentered: Record<string, unknown> = shouldReenter
      ? { ...targetRecord, ...reenteredSequencePatch() }
      : targetRecord;
    if (shouldReenter && persist) {
      ensureRecordColumns({ db, columns: ['sequence_status', 'account_sequence_state', 'last_error'] });
      upsertRecord({ db, row: reentered });
    }
    return { reachable: true, record: reentered };
  }

  const parked: Record<string, unknown> = { ...targetRecord, ...unreachableSequencePatch() };
  if (persist) {
    ensureRecordColumns({
      db,
      columns: ['sequence_status', 'account_sequence_state', 'next_action_date', 'last_error'],
    });
    upsertRecord({ db, row: parked });
  }
  return { reachable: false, record: parked };
};
