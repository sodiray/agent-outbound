export type BooleanishOptions = {
  /**
   * Unknown values are treated as enabled when the flag protects a contact
   * from outreach. This is deliberate: ambiguity must withhold contact.
   */
  failClosed?: boolean;
  affirmativeAliases?: readonly string[];
};

const NEGATIVE_BOOLEANISH_VALUES = new Set(['', '0', 'false', 'no', 'off']);
const AFFIRMATIVE_BOOLEANISH_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * Coerce SQLite/CSV/JSON boolean-like values without JavaScript truthiness.
 * Missing and explicit negative values are false. Unknown values are false by
 * default (so they cannot satisfy readiness), or true with failClosed for
 * suppression and other contact-protecting gates.
 */
export const isAffirmativeFlag = (
  value: unknown,
  options: BooleanishOptions = {},
): boolean => {
  if (value === null || value === undefined) return false;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;

  const normalized = String(value).trim().toLowerCase();
  if (NEGATIVE_BOOLEANISH_VALUES.has(normalized)) return false;
  if (AFFIRMATIVE_BOOLEANISH_VALUES.has(normalized)) return true;
  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric === 0) return false;
  if (Number.isFinite(numeric) && numeric === 1) return true;
  if (options.affirmativeAliases?.includes(normalized)) return true;
  return options.failClosed === true;
};
