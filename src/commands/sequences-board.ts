import { getSequenceBoard } from '../orchestrator/pipeline/sequences-board.js';
import { readConfig } from '../orchestrator/lib/config.js';
import { listConfiguredSequences } from '../orchestrator/lib/sequence-resolution.js';
import { openListDb } from '../orchestrator/runtime/db.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';

export const sequencesListCommand = ({ list }: { list: string }) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const sequences = listConfiguredSequences({ config });
  return { count: sequences.length, sequences };
};

export const sequencesBoardCommand = ({
  list,
  sequence,
  limit = 50,
}: {
  list: string;
  sequence: string;
  limit?: number;
}) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: true });
  try {
    return getSequenceBoard({ db, config, sequence, limitPerBucket: limit });
  } finally {
    db.close();
  }
};
