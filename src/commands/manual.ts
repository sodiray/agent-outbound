import { completeManualTask, listAwaitingManualTasks } from '../orchestrator/pipeline/manual.js';
import { readConfig } from '../orchestrator/lib/config.js';
import { openListDb } from '../orchestrator/runtime/db.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';

export const manualListCommand = ({
  list,
  taskType = '',
  limit = 100,
  offset = 0,
}: {
  list: string;
  taskType?: string;
  limit?: number;
  offset?: number;
}) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    return listAwaitingManualTasks({ db, taskType, limit, offset });
  } finally {
    db.close();
  }
};

export const manualCompleteCommand = ({
  list,
  record,
  step,
  note = '',
  skip = false,
}: {
  list: string;
  record: string;
  step: string;
  note?: string;
  skip?: boolean;
}) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: false });
  try {
    return completeManualTask({
      db,
      config,
      recordId: record,
      stepId: step,
      note,
      skip,
    });
  } finally {
    db.close();
  }
};
