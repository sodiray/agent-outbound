import { completeManualTask, listAwaitingManualTasks } from '../orchestrator/pipeline/manual.js';
import { readConfig } from '../orchestrator/lib/config.js';
import { openListDb } from '../orchestrator/runtime/db.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { assertRecordAccessForMutation } from '../orchestrator/policy/canary-isolation.js';

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

export const manualCompleteCommand = async ({
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
  assertRecordAccessForMutation({ listDir, recordId: record });
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: false });
  try {
    return await completeManualTask({
      db,
      config,
      listDir,
      recordId: record,
      stepId: step,
      note,
      skip,
    });
  } finally {
    db.close();
  }
};
