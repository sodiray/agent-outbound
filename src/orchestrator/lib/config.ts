import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { normalizeConfig } from '../../schemas/config.js';

export const getConfigPath = (listDir) => join(listDir, 'outbound.yaml');

export const readConfig = (listDir) => {
  const path = getConfigPath(listDir);
  if (!existsSync(path)) {
    return {
      path,
      raw: {},
      config: normalizeConfig({}).config,
      errors: [],
    };
  }

  try {
    const rawText = readFileSync(path, 'utf8');
    const raw = yaml.load(rawText) || {};
    const normalized = normalizeConfig(raw);
    return {
      path,
      raw,
      config: normalized.config,
      errors: normalized.error ? [normalized.error] : [],
    };
  } catch (error) {
    return {
      path,
      raw: {},
      config: normalizeConfig({}).config,
      errors: [String(error?.message || error)],
    };
  }
};

export const writeConfig = (listDir, config) => {
  const path = getConfigPath(listDir);
  const normalized = normalizeConfig(config || {});
  if (normalized.error) {
    const current = readConfig(listDir);
    return {
      path,
      errors: [normalized.error],
      config: current.config,
      written: false,
    };
  }
  const dumped = yaml.dump(normalized.config, {
    noRefs: true,
    lineWidth: 120,
    sortKeys: false,
  });
  writeFileSync(path, dumped);
  return {
    path,
    errors: [],
    config: normalized.config,
    written: true,
  };
};

export const deepMergeConfig = (target, patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...(target || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMergeConfig(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
};

const tokenizePath = (path) => String(path || '').match(/[^.[\]]+/g) || [];

const setAtPath = (obj, path, value) => {
  const tokens = tokenizePath(path);
  if (tokens.length === 0) return obj;
  const root = structuredClone(obj || {});
  let current = root;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    const nextToken = tokens[i + 1];
    if (current[token] === undefined || current[token] === null) {
      current[token] = /^\d+$/.test(nextToken) ? [] : {};
    }
    current = current[token];
  }
  current[tokens[tokens.length - 1]] = value;
  return root;
};

const modifyInArray = (arr, id, patch) => {
  const idx = arr.findIndex((item) => item.id === id);
  if (idx < 0) return arr;
  const updated = [...arr];
  updated[idx] = deepMergeConfig(updated[idx], patch);
  return updated;
};

const removeFromArray = (arr, id) => arr.filter((item) => item.id !== id);

export const applyConfigChange = (config, change) => {
  const next = structuredClone(config || {});
  const op = String(change?.op || '');

  if (op === 'add_search') {
    const arr = Array.isArray(next?.source?.searches) ? next.source.searches : [];
    return setAtPath(next, 'source.searches', [...arr, change.search]);
  }

  if (op === 'add_filter') {
    const arr = Array.isArray(next?.source?.filters) ? next.source.filters : [];
    return setAtPath(next, 'source.filters', [...arr, change.filter]);
  }

  if (op === 'add_enrich') {
    const arr = Array.isArray(next?.enrich) ? next.enrich : [];
    return setAtPath(next, 'enrich', [...arr, change.step]);
  }

  if (op === 'add_sequence_step') {
    const sequence = String(change?.sequence || 'default');
    const base = next?.sequences?.[sequence] || { steps: [] };
    const arr = Array.isArray(base.steps) ? base.steps : [];
    const updated = { ...base, steps: [...arr, change.step] };
    return setAtPath(next, `sequences.${sequence}`, updated);
  }

  if (op === 'set_score_axis') {
    const axis = String(change?.axis || 'fit');
    const current = next?.score?.[axis] || {};
    return setAtPath(next, `score.${axis}`, deepMergeConfig(current, change.patch || {}));
  }

  if (op === 'modify_search') {
    const searches = Array.isArray(next?.source?.searches) ? next.source.searches : [];
    return setAtPath(next, 'source.searches', modifyInArray(searches, change.id, change.patch || {}));
  }

  if (op === 'modify_filter') {
    const filters = Array.isArray(next?.source?.filters) ? next.source.filters : [];
    return setAtPath(next, 'source.filters', modifyInArray(filters, change.id, change.patch || {}));
  }

  if (op === 'modify_enrich') {
    const steps = Array.isArray(next?.enrich) ? next.enrich : [];
    return setAtPath(next, 'enrich', modifyInArray(steps, change.id, change.patch || {}));
  }

  if (op === 'modify_sequence_step') {
    const sequence = String(change?.sequence || 'default');
    const base = next?.sequences?.[sequence] || { steps: [] };
    const steps = Array.isArray(base.steps) ? base.steps : [];
    const updated = { ...base, steps: modifyInArray(steps, change.id, change.patch || {}) };
    return setAtPath(next, `sequences.${sequence}`, updated);
  }

  if (op === 'remove_search') {
    const searches = Array.isArray(next?.source?.searches) ? next.source.searches : [];
    return setAtPath(next, 'source.searches', removeFromArray(searches, change.id));
  }

  if (op === 'remove_filter') {
    const filters = Array.isArray(next?.source?.filters) ? next.source.filters : [];
    return setAtPath(next, 'source.filters', removeFromArray(filters, change.id));
  }

  if (op === 'remove_enrich') {
    const steps = Array.isArray(next?.enrich) ? next.enrich : [];
    return setAtPath(next, 'enrich', removeFromArray(steps, change.id));
  }

  if (op === 'remove_sequence_step') {
    const sequence = String(change?.sequence || 'default');
    const base = next?.sequences?.[sequence] || { steps: [] };
    const steps = Array.isArray(base.steps) ? base.steps : [];
    const updated = { ...base, steps: removeFromArray(steps, change.id) };
    return setAtPath(next, `sequences.${sequence}`, updated);
  }

  if (op === 'set_identity') {
    return setAtPath(next, 'source.identity', change.identity || []);
  }

  if (op === 'set_channel') {
    const channel = String(change?.channel || '');
    const current = next?.channels?.[channel] || {};
    return setAtPath(next, `channels.${channel}`, deepMergeConfig(current, change.patch || {}));
  }

  if (op === 'set_territory') {
    const current = next?.list?.territory || {};
    return setAtPath(next, 'list.territory', deepMergeConfig(current, change.patch || {}));
  }

  return next;
};

export const applyConfigChanges = (config, changes = []) => {
  let next = structuredClone(config || {});
  for (const change of changes) {
    next = applyConfigChange(next, change);
  }
  return next;
};

export const getDependentsOfStep = (config: any, stepId: string) => {
  const targetId = String(stepId || '').trim();
  const steps = Array.isArray(config?.enrich) ? config.enrich : [];
  const dependents: Array<{ stepId: string; description: string; dependencyRef: string }> = [];
  for (const step of steps) {
    const id = String(step?.id || '').trim();
    if (!id || id === targetId) continue;
    const dependsOn = Array.isArray(step?.config?.depends_on) ? step.config.depends_on : [];
    for (const dep of dependsOn) {
      const depText = String(dep || '').trim();
      if (depText === targetId || depText.startsWith(`${targetId}.`)) {
        dependents.push({
          stepId: id,
          description: String(step?.description || id),
          dependencyRef: depText,
        });
        break;
      }
    }
  }
  return dependents;
};

export const validateStepRemoval = (config: any, stepId: string, force = false) => {
  const dependents = getDependentsOfStep(config, stepId);
  if (dependents.length > 0 && !force) {
    return {
      ok: false,
      dependents,
      error: `Cannot remove "${stepId}": ${dependents.length} step(s) depend on it.`,
    };
  }
  return { ok: true, dependents };
};
