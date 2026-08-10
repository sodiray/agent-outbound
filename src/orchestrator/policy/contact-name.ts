const HONORIFICS = new Set([
  'dr',
  'mr',
  'ms',
  'mrs',
  'prof',
]);

const SUFFIXES = new Set([
  'jr',
  'sr',
  'i',
  'ii',
  'iii',
  'iv',
  'v',
  'esq',
  'phd',
  'md',
  'do',
  'dc',
  'dds',
  'dmd',
  'jd',
  'mba',
  'rn',
  'np',
  'pa',
  'cpa',
  'pe',
  'llc',
  'pllc',
  'llp',
  'lp',
  'inc',
  'ltd',
  'co',
  'corp',
  'corporation',
  'company',
]);

const ORGANIZATION_SUFFIXES = new Set([
  'llc',
  'pllc',
  'llp',
  'lp',
  'inc',
  'ltd',
  'co',
  'corp',
  'corporation',
  'company',
]);

const NON_PERSON_TOKENS = new Set([
  'admin',
  'administrator',
  'billing',
  'contact',
  'customer',
  'department',
  'help',
  'info',
  'marketing',
  'office',
  'owner',
  'sales',
  'service',
  'support',
  'team',
  'unknown',
]);

const normalizeToken = (value: string): string => value
  .trim()
  .replace(/^[.]+|[.]+$/g, '')
  .toLowerCase();

/** Single letter, optional trailing period — middle initial, not a usable first name. */
const isInitialToken = (value: string): boolean => /^[\p{L}]\.?$/u.test(value.trim());

/**
 * Professional credential / designation written in all caps (MC, LPC, CISM, LMFT, …).
 * Deliberately requires uppercase form so title-case name words are never stripped.
 */
const isCredentialToken = (value: string): boolean => {
  const letters = value.trim().replace(/\./g, '');
  if (!/^[A-Za-z]{2,8}$/.test(letters)) return false;
  return letters === letters.toUpperCase() && letters !== letters.toLowerCase();
};

const isSuffixOrCredential = (value: string): boolean => (
  SUFFIXES.has(normalizeToken(value)) || isCredentialToken(value)
);

/**
 * Person-name token: letters with optional internal apostrophe/hyphen.
 * Rejects multi-letter ALL-CAPS (acronyms). Allows single-letter initials (with
 * optional period) so middle initials do not poison first-name derivation.
 */
const isNameToken = (value: string): boolean => {
  if (isInitialToken(value)) return true;
  return (
    /^[\p{L}]+(?:['’-][\p{L}]+)*$/u.test(value)
      && !(value === value.toUpperCase() && value !== value.toLowerCase())
  );
};

const hasOnlySuffixes = (tokens: string[]): boolean => (
  tokens.length > 0 && tokens.every((token) => isSuffixOrCredential(token))
);

export const deriveContactFirstName = (value: unknown): string => {
  const raw = String(value || '').trim();
  if (!raw || /[@/\\&|<>{}\d]/.test(raw)) return '';

  const segments = raw.split(',').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return '';
  if (segments.length > 1 && !segments.slice(1).every((segment) => hasOnlySuffixes(segment.split(/\s+/)))) {
    return '';
  }

  const tokens = segments[0].split(/\s+/).filter(Boolean);
  const suffixTokens = [...tokens, ...segments.slice(1).flatMap((segment) => segment.split(/\s+/))];
  if (suffixTokens.some((token) => ORGANIZATION_SUFFIXES.has(normalizeToken(token)))) return '';
  const withoutHonorifics = tokens.slice();
  while (HONORIFICS.has(normalizeToken(withoutHonorifics[0] || ''))) withoutHonorifics.shift();
  const withoutSuffixes = withoutHonorifics.slice();
  while (isSuffixOrCredential(withoutSuffixes.at(-1) || '')) withoutSuffixes.pop();
  if (withoutSuffixes.length === 0 || !withoutSuffixes.every(isNameToken)) return '';

  const firstName = withoutSuffixes[0];
  // Initials-only first token is not a usable greeting name ("Hi J").
  if (isInitialToken(firstName)) return '';
  if (NON_PERSON_TOKENS.has(normalizeToken(firstName))) return '';
  return firstName;
};
