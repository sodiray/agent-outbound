const TITLE_PHRASES = [
  'chief technology officer',
  'chief executive officer',
  'principal engineer',
  'managing partner',
  'general manager',
  'business owner',
  'self-employed',
  'sole proprietor',
  'co-founder',
  'co-owner',
  'entrepreneur',
  'proprietor',
  'president',
  'principal',
  'operator',
  'founder',
  'investor',
  'advisor',
  'partner',
  'owner',
  'cto',
  'ceo',
] as const;

const GENERIC_COMPANY_WORDS = new Set([
  'business',
  'company',
  'group',
  'service',
  'services',
  'solutions',
  'studio',
]);

const DISTINCTIVE_TOKEN_STOPWORDS = new Set([
  'the',
  'and',
  'of',
  'llc',
  'inc',
  'co',
  'company',
  'group',
  'studio',
  'services',
  'service',
  'design',
  'interior',
]);

const normalizeWhitespace = (value: string) => value.replace(/\s+/gu, ' ').trim();

const normalizeForComparison = (value: string) => normalizeWhitespace(value)
  .normalize('NFKC')
  .replace(/[\u2018\u2019\u02BC]/gu, "'")
  .toLowerCase();

const normalizePhrase = (value: string) => normalizeForComparison(value)
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const titleWords = new Set(TITLE_PHRASES.flatMap((phrase) => normalizePhrase(phrase).split(' ')));
const titleSequenceWords = new Set([...titleWords, 'and', 'at', 'of']);

const phraseTokens = (value: string) => normalizePhrase(value).split(' ').filter(Boolean);

const containsTitle = (value: string) => phraseTokens(value).some((token) => titleWords.has(token));

const isTitleOnly = (value: string) => {
  const tokens = phraseTokens(value);
  return tokens.length > 0 && tokens.every((token) => titleSequenceWords.has(token));
};

const isTitleSequence = (value: string) => {
  const tokens = phraseTokens(value);
  return tokens.length > 0 && tokens.every((token) => titleSequenceWords.has(token));
};

const genericCategoryIn = (value: string): string | null => {
  const normalized = normalizePhrase(value);
  const tokens = normalized.split(' ').filter(Boolean);
  if (!tokens.length || !tokens.every((token) => GENERIC_COMPANY_WORDS.has(token))) return null;
  return normalized;
};

const isGenericCategory = (value: string) => Boolean(genericCategoryIn(value));

const isNonDistinctiveSingleWord = (value: string) => {
  const tokens = phraseTokens(value);
  return tokens.length === 1 && GENERIC_COMPANY_WORDS.has(tokens[0]);
};

const cleanCandidate = (value: string) => normalizeWhitespace(value)
  .replace(/^[\s&,:/|–—-]+/u, '')
  .replace(/^and\b[\s&,:/|–—-]*/iu, '')
  .replace(/[\s|]+$/u, '')
  .trim();

const stripLeadingTitles = (value: string, matched = false): { candidate: string; matched: boolean } => {
  const cleaned = cleanCandidate(value);
  const normalized = normalizeForComparison(cleaned);
  const title = TITLE_PHRASES.find((phrase) => (
    normalized === phrase || normalized.startsWith(`${phrase} `)
  ));

  if (!title) return { candidate: cleaned, matched };

  return stripLeadingTitles(cleaned.slice(title.length), true);
};

const findTitleConnector = (headline: string): { index: number; end: number } | null => {
  const wordConnectors = Array.from(headline.matchAll(/\b(?:at|of)\b/giu))
    .map((match) => ({
      index: match.index,
      end: match.index + match[0].length,
    }))
    .filter((match) => containsTitle(headline.slice(0, match.index)));

  const structuralConnectors = Array.from(headline.matchAll(/,|\/|\s+[-–—]\s+/gu))
    .map((match) => ({
      index: match.index,
      end: match.index + match[0].length,
    }))
    .filter((match) => isTitleSequence(headline.slice(0, match.index)));

  return [...wordConnectors, ...structuralConnectors]
    .sort((left, right) => left.index - right.index)
    .at(-1) || null;
};

const extractConnectedCandidate = (headline: string): { candidate: string | null; matched: boolean } => {
  const connector = findTitleConnector(headline);
  if (!connector) return { candidate: null, matched: false };

  return {
    candidate: cleanCandidate(headline.slice(connector.end)) || null,
    matched: true,
  };
};

const extractBareCandidate = (headline: string): string | null => {
  const stripped = stripLeadingTitles(headline);
  if (!stripped.matched || !stripped.candidate) return null;
  return stripped.candidate;
};

const tokenize = (value: string) => normalizeForComparison(value)
  .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) || [];

const extractTitleLedPipeCandidate = (segments: string[]): string | null => {
  if (!segments.some(isTitleOnly)) return null;

  const candidates = segments
    .filter((segment) => !isTitleOnly(segment))
    .filter((segment) => !isGenericCategory(segment))
    .map(cleanCandidate)
    .filter(Boolean);

  if (candidates.length !== 1) return null;

  const candidate = candidates[0];
  const distinctiveTokens = new Set(
    tokenize(candidate).filter((token) => !DISTINCTIVE_TOKEN_STOPWORDS.has(token)),
  );

  return distinctiveTokens.size >= 2 ? candidate : null;
};

export const parseCompanyFromHeadline = (headline: string): { company: string | null; reason: string } => {
  const pipeSegments = normalizeWhitespace(headline)
    .split(/\s*\|\s*/u)
    .map(normalizeWhitespace)
    .filter(Boolean);
  const primarySegment = pipeSegments[0] || '';

  if (!primarySegment) {
    return { company: null, reason: 'The headline is empty.' };
  }

  const connectedSegment = pipeSegments
    .map((segment) => ({
      ...extractConnectedCandidate(segment),
      segment,
    }))
    .filter((result) => result.matched)
    .at(-1);
  const candidate = connectedSegment
    ? connectedSegment.candidate
    : extractTitleLedPipeCandidate(pipeSegments) || extractBareCandidate(primarySegment);
  const genericDescriptor = connectedSegment
    ? genericCategoryIn(connectedSegment.segment)
    : pipeSegments.map(genericCategoryIn).find(Boolean) || null;

  if (genericDescriptor) {
    return {
      company: null,
      reason: `The headline names a generic business category (${genericDescriptor}), not a distinct company.`,
    };
  }

  if (!candidate) {
    return { company: null, reason: 'The headline contains a title but does not name a company.' };
  }

  if (isTitleOnly(candidate)) {
    return { company: null, reason: 'The candidate contains only a title or connector, not a company.' };
  }

  if (isGenericCategory(candidate)) {
    return {
      company: null,
      reason: `The headline names a generic business category (${candidate}), not a distinct company.`,
    };
  }

  if (isNonDistinctiveSingleWord(candidate)) {
    return {
      company: null,
      reason: `The candidate is only a common business noun (${candidate}), not a distinctive company name.`,
    };
  }

  return { company: candidate, reason: 'Extracted a company name following a recognized title cue.' };
};

export const confirmResolution = ({
  parsedCompany,
  candidateName,
}: {
  parsedCompany: string;
  candidateName: string;
}): { confirmed: boolean; headToken: string } => {
  const headToken = tokenize(parsedCompany)
    .find((token) => !DISTINCTIVE_TOKEN_STOPWORDS.has(token)) || '';
  const candidateTokens = new Set(tokenize(candidateName));

  return {
    confirmed: Boolean(headToken) && candidateTokens.has(headToken),
    headToken,
  };
};
