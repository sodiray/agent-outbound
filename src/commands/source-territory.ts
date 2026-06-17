import { sourceTerritory } from '../orchestrator/sourcing/territory.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';

export const sourceTerritoryCommand = async ({
  list,
  territoryId,
  r0 = 350,
  floor = 60,
  dryRun = false,
  maxCalls = 400,
  concurrency = 5,
}: {
  list: string;
  territoryId: string;
  r0?: number;
  floor?: number;
  dryRun?: boolean;
  maxCalls?: number;
  concurrency?: number;
}) => {
  const listDir = resolveListDir(list);
  return sourceTerritory({
    listDir,
    territoryId,
    opts: {
      r0,
      floor,
      dryRun,
      maxCalls,
      concurrency,
    },
  });
};
