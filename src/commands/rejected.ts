import { readConfig } from '../orchestrator/lib/config.js';
import {
  getRejectedRecords,
  getRejectedSources,
  restoreRejectedRecord,
} from '../orchestrator/pipeline/rejected.js';
import { openListDb } from '../orchestrator/runtime/db.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';

export const rejectedSourcesCommand = ({ list }: { list: string }) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: true });
  try {
    return getRejectedSources({ db, config });
  } finally {
    db.close();
  }
};

export const rejectedListCommand = ({
  list,
  source = '',
  limit = 100,
  offset = 0,
}: {
  list: string;
  source?: string;
  limit?: number;
  offset?: number;
}) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: true });
  try {
    return getRejectedRecords({ db, config, source, limit, offset });
  } finally {
    db.close();
  }
};

export const rejectedRestoreCommand = ({
  list,
  ref,
  reason = '',
}: {
  list: string;
  ref: string;
  reason?: string;
}) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: false });
  try {
    return db.transaction(() => restoreRejectedRecord({
      db,
      config,
      ref,
      reason,
      createdBy: 'rejected:cli',
    }))();
  } finally {
    db.close();
  }
};
