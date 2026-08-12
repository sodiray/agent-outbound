import { ensureRecordColumns, upsertRecord } from '../runtime/db.js';
import { hasAllDeclaredOutputs } from '../lib/declared-outputs.js';
import { getTargetColumnsForStepConfig } from '../lib/step-columns.js';
import { readStaleness, writeStaleness } from '../enrichment/runner.js';
import { getRecordRowId, stableHash } from '../lib/record.js';
import {
  requiredInputNonExecutionReason,
  resolveStageInputs,
  stageInputRecord,
} from '../lib/stage-inputs.js';

export const EXTRACTOR_NAMES = ['email', 'phone', 'url'] as const;

export type ExtractorName = typeof EXTRACTOR_NAMES[number];
export type ExtractSelect = 'first' | 'last' | 'all';
export type ExtractOutputType = 'string' | 'string[]';

type Candidate = {
  value: string;
  domain: string;
  sourceIndex: number;
  position: number;
};

type ExtractOutputDefinition = {
  type: ExtractOutputType;
};

type ExtractStep = Record<string, unknown> & {
  from?: unknown;
  using?: unknown;
  select?: unknown;
  exclude?: unknown;
  outputs?: unknown;
  config?: unknown;
};

type ExtractExecutionResult = {
  value: string | string[];
  matches: string[];
  sourceField: string;
};

const EMAIL_CANDIDATE = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}/g;
const URL_CANDIDATE = /https?:\/\/[^\s<>"']+/gi;
const PHONE_CANDIDATE = /(?:\+?\d|\(\d{1,4}\))[\d .()\-]{4,}\d/g;
const ASSET_TLDS = new Set(['avif', 'bmp', 'css', 'eot', 'gif', 'ico', 'jpeg', 'jpg', 'js', 'map', 'pdf', 'png', 'svg', 'tif', 'tiff', 'ttf', 'webp', 'woff', 'woff2']);
const FREE_EMAIL_DOMAINS = new Set(['aol.com', 'gmail.com', 'hotmail.com', 'icloud.com', 'live.com', 'msn.com', 'outlook.com', 'proton.me', 'protonmail.com', 'yahoo.com']);
const DEFAULT_EMAIL_EXCLUSIONS = ['example.com', 'godaddy', 'sentry.io', 'squarespace', 'wixpress'];

const text = (value: unknown): string => String(value || '').trim();

const sourceFieldsFor = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(text).filter(Boolean)
    : [text(value)].filter(Boolean)
);

const exclusionsFor = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(text).filter(Boolean)
    : []
);

const outputDefinitionsFor = (step: ExtractStep): Record<string, ExtractOutputDefinition> => {
  const config = step.config && typeof step.config === 'object' && !Array.isArray(step.config)
    ? step.config as Record<string, unknown>
    : step as Record<string, unknown>;
  const outputs = config.outputs && typeof config.outputs === 'object' && !Array.isArray(config.outputs)
    ? config.outputs as Record<string, unknown>
    : {};
  return Object.fromEntries(Object.entries(outputs).flatMap(([name, definition]) => {
    if (!name || !definition || typeof definition !== 'object' || Array.isArray(definition)) return [];
    const type = text((definition as Record<string, unknown>).type);
    if (type !== 'string' && type !== 'string[]') return [];
    return [[name, { type }]];
  }));
};

const materialExtractConfig = (step: ExtractStep): Record<string, unknown> => ({
  from: step.from,
  using: step.using,
  select: step.select || 'first',
  exclude: step.exclude || [],
  outputs: outputDefinitionsFor(step),
});

export const extractDependencyHash = ({ step, record }: {
  step: ExtractStep;
  record: Record<string, unknown>;
}): string => stableHash({
  inputs: resolveStageInputs({ step, record }).values,
  config: materialExtractConfig(step),
});

const domainFrom = (value: string): string => {
  const raw = value.trim().toLowerCase();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const emailDomain = (value: string): string => value.slice(value.lastIndexOf('@') + 1).toLowerCase();

const isValidEmail = (value: string): boolean => {
  const at = value.lastIndexOf('@');
  if (at <= 0 || at !== value.indexOf('@') || value.length > 254) return false;
  const local = value.slice(0, at);
  const domain = emailDomain(value);
  const labels = domain.split('.');
  if (local.length > 64 || labels.length < 2 || labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) return false;
  const tld = labels.at(-1) || '';
  return !ASSET_TLDS.has(tld.toLowerCase());
};

const globMatches = (value: string, pattern: string): boolean => {
  const parts = pattern.split('*');
  const initial = parts[0];
  if (initial && !value.startsWith(initial)) return false;
  const matched = parts.slice(1).reduce(({ index, ok }, part, partIndex) => {
    if (!ok || !part) return { index, ok };
    const found = value.indexOf(part, index);
    if (found < 0) return { index, ok: false };
    if (partIndex === parts.length - 2 && !pattern.endsWith('*') && !value.endsWith(part)) return { index, ok: false };
    return { index: found + part.length, ok: true };
  }, { index: initial.length, ok: true });
  return matched.ok;
};

const isExcluded = (candidate: Candidate, exclusions: string[]): boolean => (
  exclusions.some((raw) => {
    const exclusion = raw.toLowerCase();
    if (!exclusion) return false;
    const values = [candidate.value.toLowerCase(), candidate.domain];
    if (exclusion.includes('*')) return values.some((value) => globMatches(value, exclusion));
    return values.some((value) => value.includes(exclusion));
  })
);

const emailCandidates = (source: string, sourceIndex: number): Candidate[] => {
  EMAIL_CANDIDATE.lastIndex = 0;
  return Array.from(source.matchAll(EMAIL_CANDIDATE)).flatMap((match) => {
    const value = match[0];
    if (!isValidEmail(value)) return [];
    return [{ value, domain: emailDomain(value), sourceIndex, position: match.index ?? 0 }];
  });
};

const urlCandidates = (source: string, sourceIndex: number): Candidate[] => {
  URL_CANDIDATE.lastIndex = 0;
  return Array.from(source.matchAll(URL_CANDIDATE)).flatMap((match) => {
    const value = match[0].replace(/[),.;:!?}\]]+$/g, '');
    try {
      const parsed = new URL(value);
      if (!parsed.hostname) return [];
      return [{ value, domain: parsed.hostname.toLowerCase(), sourceIndex, position: match.index ?? 0 }];
    } catch {
      return [];
    }
  });
};

const phoneCandidates = (source: string, sourceIndex: number): Candidate[] => {
  PHONE_CANDIDATE.lastIndex = 0;
  return Array.from(source.matchAll(PHONE_CANDIDATE)).flatMap((match) => {
    const value = match[0].trim();
    const digits = value.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return [];
    return [{ value, domain: '', sourceIndex, position: match.index ?? 0 }];
  });
};

const candidatesFor = ({ source, sourceIndex, extractor }: { source: string; sourceIndex: number; extractor: ExtractorName }): Candidate[] => {
  if (extractor === 'email') return emailCandidates(source, sourceIndex);
  if (extractor === 'phone') return phoneCandidates(source, sourceIndex);
  return urlCandidates(source, sourceIndex);
};

const ownDomainsFor = (record: Record<string, unknown>): string[] => [record.domain, record.website]
  .map((value) => domainFrom(text(value)))
  .filter(Boolean);

const candidateRank = ({ candidate, ownDomains }: { candidate: Candidate; ownDomains: string[] }): number => {
  if (ownDomains.some((domain) => candidate.domain === domain || candidate.domain.endsWith(`.${domain}`))) return 0;
  if (candidate.domain && !FREE_EMAIL_DOMAINS.has(candidate.domain)) return 1;
  return 2;
};

const orderedMatches = ({ candidates, record, exclusions }: { candidates: Candidate[]; record: Record<string, unknown>; exclusions: string[] }): string[] => {
  const unique = candidates.reduce((byValue, candidate) => {
    const key = candidate.value.toLowerCase();
    if (!byValue.has(key) && !isExcluded(candidate, exclusions)) byValue.set(key, candidate);
    return byValue;
  }, new Map<string, Candidate>());
  const ownDomains = ownDomainsFor(record);
  return [...unique.values()]
    .sort((left, right) => (
      candidateRank({ candidate: left, ownDomains }) - candidateRank({ candidate: right, ownDomains })
      || left.sourceIndex - right.sourceIndex
      || left.position - right.position
      || left.value.localeCompare(right.value)
    ))
    .map((candidate) => candidate.value);
};

export const extractFromRecord = ({ step, record }: { step: ExtractStep; record: Record<string, unknown> }): ExtractExecutionResult => {
  const config = step.config && typeof step.config === 'object' && !Array.isArray(step.config)
    ? { ...step, ...(step.config as Record<string, unknown>) }
    : step;
  const inputs = stageInputRecord({ step: config, record });
  const fields = sourceFieldsFor(config.from);
  const extractor = text(config.using) as ExtractorName;
  const select = text(config.select || 'first') as ExtractSelect;
  const exclusions = extractor === 'email'
    ? [...DEFAULT_EMAIL_EXCLUSIONS, ...exclusionsFor(config.exclude)]
    : exclusionsFor(config.exclude);
  const source = fields
    .map((field, sourceIndex) => ({ field, sourceIndex, value: text(inputs[field]) }))
    .find((entry) => orderedMatches({
      candidates: candidatesFor({ source: entry.value, sourceIndex: entry.sourceIndex, extractor }),
      record: inputs,
      exclusions,
    }).length > 0);
  const matches = source
    ? orderedMatches({
      candidates: candidatesFor({ source: source.value, sourceIndex: source.sourceIndex, extractor }),
      record: inputs,
      exclusions,
    })
    : [];
  const value = select === 'all'
    ? matches
    : (select === 'last' ? matches.at(-1) : matches[0]) || '';
  return { value, matches, sourceField: source?.field || '' };
};

export const executeExtractStepOnRecords = ({
  db,
  step,
  rows,
  force = false,
}: {
  db: unknown;
  step: ExtractStep;
  rows: Array<Record<string, unknown>>;
  force?: boolean;
}): Map<string, { passed: boolean; reason: string; errored?: boolean; executed?: boolean; declaredOutputWrites: Record<string, { provided: boolean; value: unknown }> }> => {
  const config = step.config && typeof step.config === 'object' && !Array.isArray(step.config)
    ? { ...step, ...(step.config as Record<string, unknown>) }
    : step;
  const outputs = outputDefinitionsFor(config);
  const extractor = text(config.using);
  const select = text(config.select || 'first');
  const sourceFields = sourceFieldsFor(config.from);
  const outcomes = new Map<string, { passed: boolean; reason: string; errored?: boolean; executed?: boolean; declaredOutputWrites: Record<string, { provided: boolean; value: unknown }> }>();
  if (!EXTRACTOR_NAMES.includes(extractor as ExtractorName) || !['first', 'last', 'all'].includes(select) || sourceFields.length === 0 || Object.keys(outputs).length === 0) {
    rows.forEach((row) => {
      outcomes.set(getRecordRowId(row), {
        passed: false,
        errored: true,
        reason: 'invalid_extract_step',
        declaredOutputWrites: {},
      });
    });
    return outcomes;
  }
  const allSelection = select === 'all';
  if (Object.values(outputs).some((definition) => (definition.type === 'string[]') !== allSelection)) {
    rows.forEach((row) => {
      outcomes.set(getRecordRowId(row), {
        passed: false,
        errored: true,
        reason: 'extract_output_type_must_match_select',
        declaredOutputWrites: {},
      });
    });
    return outcomes;
  }
  ensureRecordColumns({ db, columns: getTargetColumnsForStepConfig(config) });
  rows.forEach((row) => {
    const recordId = getRecordRowId(row);
    try {
      // Map-form inputs honour required + min_chars the same way compose/score do.
      // Array-form inputs have no per-input options; resolve returns empty skip lists.
      const requiredSkip = requiredInputNonExecutionReason(resolveStageInputs({ step: config, record: row }));
      if (requiredSkip) {
        outcomes.set(recordId, {
          passed: true,
          executed: false,
          reason: requiredSkip,
          declaredOutputWrites: {},
        });
        return;
      }
      const depHash = extractDependencyHash({ step: config, record: row });
      const cached = readStaleness({ db, recordId, stepId: String(config.id || '') });
      const outputKeys = Object.keys(outputs);
      // Presence is judged on the durable row so a stale batch snapshot cannot
      // force a false re-run or a false skip. Empty outputs mean re-run.
      const persistedForSkip = (db as { prepare: (sql: string) => { get: (...params: unknown[]) => unknown } })
        .prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1')
        .get(recordId, recordId);
      const durableRow = persistedForSkip && typeof persistedForSkip === 'object' && !Array.isArray(persistedForSkip)
        ? { ...row, ...(persistedForSkip as Record<string, unknown>) }
        : row;
      if (
        !force
        && String(cached?.dep_hash || '') === depHash
        && hasAllDeclaredOutputs({ record: durableRow, outputKeys })
      ) {
        outcomes.set(recordId, {
          passed: true,
          executed: false,
          reason: 'skipped_unchanged_inputs',
          declaredOutputWrites: Object.fromEntries(outputKeys.map((name) => [name, {
            provided: true,
            value: durableRow[name],
          }])),
        });
        return;
      }
      const result = extractFromRecord({ step: config, record: row });
      const persistedValue = Array.isArray(result.value) ? JSON.stringify(result.value) : result.value;
      const patch = Object.fromEntries(Object.keys(outputs).map((name) => [name, persistedValue]));
      upsertRecord({ db, row: { ...row, ...patch } });
      writeStaleness({
        db,
        recordId,
        stepId: String(config.id || ''),
        depHash,
        cacheTtl: '',
        cacheTtlSeconds: 0,
      });
      outcomes.set(recordId, {
        passed: true,
        reason: `extracted:${extractor}:${result.matches.length}${result.sourceField ? `:${result.sourceField}` : ''}`,
        declaredOutputWrites: Object.fromEntries(Object.keys(outputs).map((name) => [name, {
          provided: true,
          value: persistedValue,
        }])),
      });
    } catch (error) {
      outcomes.set(recordId, {
        passed: false,
        errored: true,
        reason: String((error as Error)?.message || error),
        declaredOutputWrites: {},
      });
    }
  });
  return outcomes;
};
