import { readConfig } from '../orchestrator/lib/config.js';
import { openListDb } from '../orchestrator/runtime/db.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import {
  getLiveInteractionBudgetStatus,
  resolveLiveInteractionBudget,
} from '../orchestrator/runtime/live-interaction-budget.js';

export const liveInteractionBudgetCommand = ({
  list,
  limit = 100,
}: {
  list: string;
  limit?: number;
}) => {
  const listDir = resolveListDir(list);
  const loaded = readConfig(listDir);
  if (loaded.errors.length > 0) {
    throw new Error(`Cannot read live interaction budget config: ${loaded.errors.join('; ')}`);
  }
  const db = openListDb({ listDir, readonly: false });
  try {
    return getLiveInteractionBudgetStatus({
      db,
      budget: resolveLiveInteractionBudget(loaded.config),
      limit,
    });
  } finally {
    db.close();
  }
};
