import type { DecisionMakerCandidate } from './types.js';

export const text = (value: unknown) => String(value || '').trim();

export const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

export const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export const numeric = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const emptyCandidate = (source: string): DecisionMakerCandidate => ({
  provider_candidate_id: '',
  first_name: '',
  last_name: '',
  name: '',
  title: '',
  email: '',
  phone: '',
  seniority: '',
  department: '',
  linkedin: '',
  confidence: 0,
  source_domain: '',
  source_organization: '',
  source,
  source_query: '',
  email_verification_status: '',
  email_verification_confidence: 0,
});

export const mergeCandidate = (
  base: DecisionMakerCandidate,
  patch: Partial<DecisionMakerCandidate>,
): DecisionMakerCandidate => ({
  ...base,
  ...Object.fromEntries(Object.entries(patch).filter(([, value]) => (
    value !== undefined && value !== '' && value !== 0
  ))),
});
