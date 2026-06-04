import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { runPipelineDataflow } from '../orchestrator/pipeline/dataflow.js';
import { runScoring } from '../orchestrator/scoring/runner.js';
import { addSingleLead } from '../orchestrator/sourcing/single-lead.js';

const sqlString = (value: string) => `'${String(value || '').replace(/'/g, "''")}'`;

export const leadAddCommand = async ({
  list,
  name,
  near = '',
  query = '',
  run = false,
  dryRun = false,
  max = 5,
}: {
  list: string;
  name: string;
  near?: string;
  query?: string;
  run?: boolean;
  dryRun?: boolean;
  max?: number;
}) => {
  const listDir = resolveListDir(list);
  const intake = await addSingleLead({
    listDir,
    name,
    near,
    query,
    max,
    dryRun,
  });
  const rowId = String(intake.record?.row_id || '').trim();
  const where = rowId ? `_row_id = ${sqlString(rowId)}` : '';
  const pipelineAndScore = async () => {
    if (!run || dryRun || !rowId) return null;
    const pipeline = await runPipelineDataflow({ listDir, where });
    const score = await runScoring({ listDir, where });
    return {
      where,
      pipeline,
      score,
    };
  };

  return {
    ...intake,
    run: await pipelineAndScore(),
  };
};
