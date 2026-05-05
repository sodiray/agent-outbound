import { AgentOutboundError } from '../runtime/contract.js';
import {
  type ActionRole,
  parseProviderModel,
  resolveConfiguredModelRef,
} from '../runtime/models.js';
import { assertSupportedModel } from '../runtime/model-store.js';

type ModelRef = {
  path: string;
  model: string;
  role: ActionRole;
  resolved: boolean;
};

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
  for (const [index, filter] of asArray(config?.source?.filters).entries()) {
    addExplicitRef(refs, `source.filters[${index}].config.model`, filter?.config?.model, 'evaluation');
  }
  for (const [index, step] of asArray(config?.enrich).entries()) {
    addExplicitRef(refs, `enrich[${index}].config.model`, step?.config?.model, 'research');
  }
  addExplicitRef(refs, 'score.fit.model', config?.score?.fit?.model, 'evaluation');
  addExplicitRef(refs, 'score.trigger.model', config?.score?.trigger?.model, 'evaluation');
  for (const [index, criterion] of asArray(config?.score?.fit?.criteria).entries()) {
    addExplicitRef(refs, `score.fit.criteria[${index}].config.model`, criterion?.config?.model, 'evaluation');
  }
  for (const [index, criterion] of asArray(config?.score?.trigger?.criteria).entries()) {
    addExplicitRef(refs, `score.trigger.criteria[${index}].config.model`, criterion?.config?.model, 'evaluation');
  }
  for (const [sequenceName, sequence] of Object.entries(config?.sequences || {})) {
    addExplicitRef(refs, `sequences.${sequenceName}.reply_check.model`, (sequence as any)?.reply_check?.model, 'evaluation');
    for (const [index, step] of asArray((sequence as any)?.steps).entries()) {
      addExplicitRef(refs, `sequences.${sequenceName}.steps[${index}].config.model`, step?.config?.model, 'research');
    }
  }
  addExplicitRef(refs, 'crm.model', config?.crm?.model, 'research');
  return refs;
};

const collectPhaseModelRefs = ({ config, phase }: { config: any; phase: 'source' | 'enrich' | 'score' | 'sequence' | 'crm' }) => {
  const refs: ModelRef[] = [];
  const aiConfig = config?.ai || {};
  if (phase === 'source') {
    for (const [index, search] of asArray(config?.source?.searches).entries()) {
      addResolvedRef(refs, `source.searches[${index}]`, search?.model, 'research', aiConfig);
    }
    for (const [index, filter] of asArray(config?.source?.filters).entries()) {
      addResolvedRef(refs, `source.filters[${index}]`, filter?.config?.model, 'evaluation', aiConfig);
    }
    addResolvedRef(refs, 'source.dedup', '', 'evaluation', aiConfig);
    return refs;
  }
  if (phase === 'enrich') {
    for (const [index, step] of asArray(config?.enrich).entries()) {
      addResolvedRef(refs, `enrich[${index}]`, step?.config?.model, 'research', aiConfig);
    }
    return refs;
  }
  if (phase === 'score') {
    addResolvedRef(refs, 'score.fit', config?.score?.fit?.model, 'evaluation', aiConfig);
    addResolvedRef(refs, 'score.trigger', config?.score?.trigger?.model, 'evaluation', aiConfig);
    for (const [index, criterion] of asArray(config?.score?.fit?.criteria).entries()) {
      addResolvedRef(refs, `score.fit.criteria[${index}]`, criterion?.config?.model, 'evaluation', aiConfig);
    }
    for (const [index, criterion] of asArray(config?.score?.trigger?.criteria).entries()) {
      addResolvedRef(refs, `score.trigger.criteria[${index}]`, criterion?.config?.model, 'evaluation', aiConfig);
    }
    return refs;
  }
  if (phase === 'sequence') {
    for (const [sequenceName, sequence] of Object.entries(config?.sequences || {})) {
      addResolvedRef(refs, `sequences.${sequenceName}.reply_check`, (sequence as any)?.reply_check?.model, 'evaluation', aiConfig);
      for (const [index, step] of asArray((sequence as any)?.steps).entries()) {
        addResolvedRef(refs, `sequences.${sequenceName}.steps[${index}]`, step?.config?.model, 'copywriting', aiConfig);
      }
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
  phase: 'source' | 'enrich' | 'score' | 'sequence' | 'crm';
}) => {
  const refs = dedupeRefs(collectPhaseModelRefs({ config: config || {}, phase }));
  for (const ref of refs) {
    assertRefModel(ref);
  }
};
