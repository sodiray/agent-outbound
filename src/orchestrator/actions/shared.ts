import { existsSync, readFileSync } from 'node:fs';
import { resolveListPath } from '../runtime/paths.js';

export const renderPromptTemplate = ({ template, vars = {} }) => {
  let out = String(template || '');
  for (const [key, value] of Object.entries(vars || {})) {
    const token = `{{${key}}}`;
    out = out.split(token).join(String(value ?? ''));
  }
  return out;
};

export const readPromptFileIfAny = ({ listDir, promptFile }) => {
  const ref = String(promptFile || '').trim();
  if (!ref) return '';
  const path = resolveListPath({ listDir, filePath: ref, allowRelative: true });
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
};

export const toBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y';
};

export const safeJsonParse = (value, fallback = null) => {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
};
