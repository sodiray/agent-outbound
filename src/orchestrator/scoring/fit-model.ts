import { flattenPipelineSteps } from '../lib/subpipelines.js';
import type { FitModelConfigInput } from '../policy/scoring.js';

export type PipelineFitModelResolution = {
  fitModel: FitModelConfigInput | undefined;
  declared: boolean;
  stageId: string | null;
};

/**
 * Resolves the effective fit model from the final fit score stage in pipeline
 * order. Later fit stages overwrite fit_score, so policy recomputation must
 * use that same declaration.
 */
export const resolvePipelineFitModel = (config: Record<string, unknown>): PipelineFitModelResolution => {
  const fitStages = flattenPipelineSteps(config).filter((step) => (
    String(step.kind || '').trim().toLowerCase() === 'score'
    && String(step.key || '').trim() === 'fit'
  ));
  const stage = fitStages.at(-1);
  if (!stage) {
    return { fitModel: undefined, declared: false, stageId: null };
  }
  return {
    fitModel: {
      criteria: Array.isArray(stage.criteria) ? stage.criteria : [],
      modelVersion: String((config.policy as Record<string, unknown> | undefined)?.fit_rule_version || '').trim(),
    },
    declared: true,
    stageId: String(stage.id || '').trim() || null,
  };
};
