import { AgentOutboundError } from '../runtime/contract.js';
import {
  type ActionRole,
  parseProviderModel,
  resolveConfiguredModelRef,
} from '../runtime/models.js';
import { assertSupportedModel } from '../runtime/model-store.js';
import { flattenPipelineSteps } from './subpipelines.js';

type ModelRef = {
  path: string;
  model: string;
  role: ActionRole;
  resolved: boolean;
};

const MODEL_FREE_PIPELINE_KINDS = new Set(['contact_source']);

const asArray = (value: any) => (Array.isArray(value) ? value : []);

const addExplicitRef = (refs: ModelRef[], path: string, model: any, role: ActionRole) => {
  const raw = String(model || '').trim();
  if (!raw) return;
  refs.push({ path, model: raw, role, resolved: false });
};

const addResolvedRef = (refs: ModelRef[], path: string, model: any, role: ActionRole, aiConfig: any) => {
  try {
    const resolved = resolveConfiguredModelRef({
      model: String(model || '').trim(),
      role,
      aiConfig,
    });
    refs.push({ path, model: String(resolved.modelRef || '').trim(), role, resolved: true });
  } catch (error) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `${path}: ${String((error as any)?.message || error)}`,
      retryable: false,
      fields: { path, role },
      status: 400,
    });
  }
};

const collectConfigModelRefs = (config: any): ModelRef[] => {
  const refs: ModelRef[] = [];
  addExplicitRef(refs, 'ai.default_model', config?.ai?.default_model, 'research');
  addExplicitRef(refs, 'ai.defaults.evaluation', config?.ai?.defaults?.evaluation, 'evaluation');
  addExplicitRef(refs, 'ai.defaults.copywriting', config?.ai?.defaults?.copywriting, 'copywriting');
  addExplicitRef(refs, 'ai.defaults.research', config?.ai?.defaults?.research, 'research');

  for (const [index, search] of asArray(config?.source?.searches).entries()) {
    addExplicitRef(refs, `source.searches[${index}].model`, search?.model, 'research');
  }
  for (const [index, step] of flattenPipelineSteps(config).entries()) {
    const kind = String(step?.kind || '');
    addExplicitRef(refs, `pipeline[${index}].model`, step?.model, kind === 'filter' ? 'evaluation' : 'research');
    if (kind === 'assign') {
      for (const [ruleIndex, rule] of asArray(step?.rules).entries()) {
        addExplicitRef(refs, `pipeline[${index}].rules[${ruleIndex}].model`, rule?.model, 'evaluation');
      }
    }
  }
  addExplicitRef(refs, 'score.model', config?.score?.model, 'evaluation');
  for (const [sequenceName, sequence] of Object.entries(config?.sequences || {})) {
    addExplicitRef(refs, `sequences.${sequenceName}.reply_check.classifier.model`, (sequence as any)?.reply_check?.classifier?.model, 'evaluation');
  }
  addExplicitRef(refs, 'crm.model', config?.crm?.model, 'research');
  return refs;
};

const collectPhaseModelRefs = ({ config, phase }: { config: any; phase: 'source' | 'pipeline' | 'score' | 'sequence' | 'crm' }) => {
  const refs: ModelRef[] = [];
  const aiConfig = config?.ai || {};
  if (phase === 'source') {
    for (const [index, search] of asArray(config?.source?.searches).entries()) {
      addResolvedRef(refs, `source.searches[${index}]`, search?.model, 'research', aiConfig);
    }
    addResolvedRef(refs, 'source.dedup', '', 'evaluation', aiConfig);
    return refs;
  }
  if (phase === 'pipeline') {
    for (const [index, step] of flattenPipelineSteps(config).entries()) {
      const kind = String(step?.kind || '');
      if (kind !== 'assign' && !MODEL_FREE_PIPELINE_KINDS.has(kind)) {
        addResolvedRef(refs, `pipeline[${index}]`, step?.model, kind === 'filter' ? 'evaluation' : 'research', aiConfig);
      }
      if (kind === 'assign') {
        for (const [ruleIndex, rule] of asArray(step?.rules).entries()) {
          if (String(rule?.type || 'field_check') !== 'semantic') continue;
          addResolvedRef(refs, `pipeline[${index}].rules[${ruleIndex}]`, rule?.model, 'evaluation', aiConfig);
        }
      }
    }
    return refs;
  }
  if (phase === 'score') {
    for (const [index, step] of flattenPipelineSteps(config).entries()) {
      if (String(step?.kind || '') !== 'score') continue;
      addResolvedRef(refs, `pipeline[${index}]`, step?.model, 'evaluation', aiConfig);
    }
    return refs;
  }
  if (phase === 'sequence') {
    for (const [sequenceName, sequence] of Object.entries(config?.sequences || {})) {
      addResolvedRef(refs, `sequences.${sequenceName}.reply_check.classifier`, (sequence as any)?.reply_check?.classifier?.model, 'evaluation', aiConfig);
    }
    addResolvedRef(refs, 'sequence.condition_eval', '', 'evaluation', aiConfig);
    addResolvedRef(refs, 'sequence.plan_route', '', 'research', aiConfig);
    return refs;
  }
  if (phase === 'crm') {
    addResolvedRef(refs, 'crm.model', config?.crm?.model, 'research', aiConfig);
    return refs;
  }
  return refs;
};

const assertRefModel = (ref: ModelRef) => {
  let parsed;
  try {
    parsed = parseProviderModel(ref.model);
  } catch (error) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `${ref.path}: ${String((error as any)?.message || error)}`,
      retryable: false,
      fields: { path: ref.path, model: ref.model, role: ref.role },
      status: 400,
    });
  }
  try {
    assertSupportedModel(parsed.modelRef);
  } catch (error) {
    if (error instanceof AgentOutboundError) {
      error.fields = {
        ...(error.fields || {}),
        path: ref.path,
        role: ref.role,
      };
    }
    throw error;
  }
};

const dedupeRefs = (refs: ModelRef[]) => {
  const seen = new Set<string>();
  const out: ModelRef[] = [];
  for (const ref of refs) {
    const key = `${ref.model}|${ref.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
};

export const assertConfigModelReferences = (config: any) => {
  const refs = dedupeRefs(collectConfigModelRefs(config || {}));
  for (const ref of refs) {
    assertRefModel(ref);
  }
};

export const assertPhaseModelReferences = ({
  config,
  phase,
}: {
  config: any;
  phase: 'source' | 'pipeline' | 'score' | 'sequence' | 'crm';
}) => {
  const refs = dedupeRefs(collectPhaseModelRefs({ config: config || {}, phase }));
  for (const ref of refs) {
    assertRefModel(ref);
  }
};
