import { getRecordRowId, normalizeDomain } from '../lib/record.js';

export const NEAR_DUPLICATE_SIGNALS = [
  'name_and_address',
  'name_and_domain',
  'shared_phone',
  'shared_domain',
  'person_at_shared_address_or_domain',
] as const;

export type NearDuplicateSignal = typeof NEAR_DUPLICATE_SIGNALS[number];

export type NearDuplicateConfig = {
  enabled?: boolean;
  signals?: NearDuplicateSignal[];
  name_similarity_threshold?: number;
};

export type NearDuplicateMatch = {
  candidate: Record<string, unknown>;
  signals: NearDuplicateSignal[];
  name_similarity: number;
  reason: string;
};

const LEGAL_ENTITY_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'pllc', 'plc', 'pc', 'corp', 'corporation', 'co', 'company',
]);
const PERSON_HONORIFICS = new Set(['dr', 'doctor', 'mr', 'mrs', 'ms', 'prof']);

const text = (value: unknown) => String(value || '').trim();

const tokens = (value: unknown) => text(value)
  .normalize('NFKD')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .toLowerCase()
  .split(/\s+/)
  .filter(Boolean);

const normalizedNameTokens = (value: unknown) => tokens(value)
  .filter((token) => !LEGAL_ENTITY_SUFFIXES.has(token));

const normalizedName = (value: unknown) => normalizedNameTokens(value).join(' ');

const normalizedAddress = (value: unknown) => text(value)
  .toLowerCase()
  .replace(/(?:\bsuite\b|\bste\b|\bunit\b|#)\s*([a-z0-9-]+)/gu, ' unit $1 ')
  .replace(/\broad\b/gu, ' rd ')
  .replace(/\bstreet\b/gu, ' st ')
  .replace(/\bavenue\b/gu, ' ave ')
  .replace(/\bdrive\b/gu, ' dr ')
  .replace(/\s+/gu, ' ')
  .replace(/[^a-z0-9\s]/gu, '')
  .trim();

const normalizedPhone = (value: unknown) => {
  const digits = text(value).replace(/\D/gu, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return national.length >= 10 ? national : '';
};

const editDistance = (left: string, right: string) => {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const final = [...left].reduce((last, leftChar, leftIndex) => {
    const next = [leftIndex + 1];
    [...right].forEach((rightChar, rightIndex) => {
      const substitution = last[rightIndex] + (leftChar === rightChar ? 0 : 1);
      next.push(Math.min(next[rightIndex] + 1, last[rightIndex + 1] + 1, substitution));
    });
    return next;
  }, previous);
  return final[final.length - 1];
};

export const nameSimilarity = (left: unknown, right: unknown) => {
  const normalizedLeft = normalizedName(left);
  const normalizedRight = normalizedName(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  const longest = Math.max(normalizedLeft.length, normalizedRight.length);
  return 1 - (editDistance(normalizedLeft, normalizedRight) / longest);
};

const isLikelyPersonName = (value: unknown) => {
  const nameTokens = normalizedNameTokens(value);
  const allAlphabetic = nameTokens.every((token) => /^\p{L}+$/u.test(token));
  if (!allAlphabetic) return false;
  const rawTokens = tokens(value);
  const hasHonorific = PERSON_HONORIFICS.has(rawTokens[0] || '');
  if (hasHonorific && nameTokens.length >= 2 && nameTokens.length <= 4) return true;
  if (nameTokens.length !== 3) return false;
  return nameTokens[1].length === 1 || nameTokens[2].length === 1;
};

const isLikelyOrganizationName = (value: unknown) => {
  const rawTokens = tokens(value);
  return rawTokens.some((token) => LEGAL_ENTITY_SUFFIXES.has(token));
};

const nameFor = (row: Record<string, unknown>) => row.business_name || row.name || '';

const domainFor = (row: Record<string, unknown>) => normalizeDomain(row.domain || row.website || '');

const configuredSignalSet = (config: NearDuplicateConfig) => new Set(config.signals || []);

const matchingSignalsFor = ({
  row,
  candidate,
  config,
}: {
  row: Record<string, unknown>;
  candidate: Record<string, unknown>;
  config: NearDuplicateConfig;
}) => {
  const configuredSignals = configuredSignalSet(config);
  const similarity = nameSimilarity(nameFor(row), nameFor(candidate));
  const sameAddress = normalizedAddress(row.address) !== ''
    && normalizedAddress(row.address) === normalizedAddress(candidate.address);
  const rowDomain = domainFor(row);
  const candidateDomain = domainFor(candidate);
  const sameDomain = rowDomain !== '' && rowDomain === candidateDomain;
  const rowPhone = normalizedPhone(row.phone);
  const candidatePhone = normalizedPhone(candidate.phone);
  const samePhone = rowPhone !== '' && rowPhone === candidatePhone;
  const requiredSimilarity = Number(config.name_similarity_threshold ?? 1);
  const nameMatches = similarity >= requiredSimilarity;
  const personAndOrganization = (
    (isLikelyPersonName(nameFor(row)) && isLikelyOrganizationName(nameFor(candidate)))
    || (isLikelyOrganizationName(nameFor(row)) && isLikelyPersonName(nameFor(candidate)))
  );
  const signals = NEAR_DUPLICATE_SIGNALS.filter((signal) => {
    if (!configuredSignals.has(signal)) return false;
    if (signal === 'name_and_address') return nameMatches && sameAddress;
    if (signal === 'name_and_domain') return nameMatches && sameDomain;
    if (signal === 'shared_phone') return samePhone;
    if (signal === 'shared_domain') return sameDomain;
    return personAndOrganization && (sameAddress || sameDomain);
  });
  return { signals, similarity };
};

const reasonFor = ({ signals, similarity }: { signals: NearDuplicateSignal[]; similarity: number }) => (
  `near_duplicate: ${signals.join(', ')}; name_similarity=${similarity.toFixed(2)}`
);

export const findNearDuplicateMatch = ({
  row,
  candidates,
  config,
}: {
  row: Record<string, unknown>;
  candidates: Record<string, unknown>[];
  config: NearDuplicateConfig;
}): NearDuplicateMatch | null => {
  if (!config.enabled || (config.signals || []).length === 0) return null;
  const rowId = getRecordRowId(row);
  const matches = candidates
    .filter((candidate) => getRecordRowId(candidate) !== rowId)
    .map((candidate) => ({ candidate, ...matchingSignalsFor({ row, candidate, config }) }))
    .filter((match) => match.signals.length > 0)
    .sort((left, right) => (
      (right.signals.length - left.signals.length)
      || (right.similarity - left.similarity)
      || getRecordRowId(left.candidate).localeCompare(getRecordRowId(right.candidate))
    ));
  const match = matches[0];
  if (!match) return null;
  return {
    candidate: match.candidate,
    signals: match.signals,
    name_similarity: match.similarity,
    reason: reasonFor({ signals: match.signals, similarity: match.similarity }),
  };
};

export const findNearDuplicatePairs = ({
  rows,
  config,
}: {
  rows: Record<string, unknown>[];
  config: NearDuplicateConfig;
}) => rows.flatMap((row, index) => rows
  .slice(index + 1)
  .map((candidate) => {
    const result = findNearDuplicateMatch({ row, candidates: [candidate], config });
    return result ? { row, ...result } : null;
  })
  .filter((result): result is NonNullable<typeof result> => result !== null));
