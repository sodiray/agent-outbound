import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  listContactsByRecord,
  syncPrimaryContactProjection,
  upsertContact,
} from '../../runtime/db.js';
import { executeComposioTool } from '../../runtime/tools.js';
import { getMcpClient } from '../../runtime/mcp.js';
import { getEnv } from '../../runtime/env.js';
import { getRecordRowId } from '../../lib/record.js';

type DecisionMakerCandidate = {
  first_name: string;
  last_name: string;
  name: string;
  title: string;
  email: string;
  phone: string;
  seniority: string;
  department: string;
  linkedin: string;
  confidence: number;
  source_domain: string;
  source_organization: string;
  source: 'hunter';
  source_query: string;
};

type DecisionMakerActionInput = {
  db?: Parameters<typeof upsertContact>[0]['db'];
  mcp?: Client | null;
  listDir: string;
  stepId: string;
  stepConfig: Record<string, unknown>;
  record: Record<string, unknown>;
  aiConfig?: Record<string, unknown>;
  emailVerifier?: EmailVerifier;
};

type DecisionMakerActionResult = {
  outputs: Record<string, unknown>;
  usage?: Record<string, unknown>;
  model?: string;
  provider?: string;
};

export type HunterEmailVerification = {
  status: string;
  confidence: number;
  smtp_check: boolean;
  disposable: boolean;
};

export type EmailVerifier = (email: string) => Promise<HunterEmailVerification | null>;

const PRODUCT_AND_LEGAL_TOKENS = new Set([
  'fiber',
  'internet',
  'broadband',
  'networks',
  'network',
  'communications',
  'telecom',
  'wireless',
  'services',
  'service',
  'solutions',
  'systems',
  'group',
  'holdings',
  'company',
  'co',
  'corp',
  'corporation',
  'incorporated',
  'inc',
  'llc',
  'ltd',
  'lp',
  'pllc',
  'the',
]);

const emptyDecisionMakerOutputs = (candidates: DecisionMakerCandidate[] = []) => ({
  decision_maker_name: '',
  decision_maker_title: '',
  decision_maker_email: '',
  decision_maker_linkedin: '',
  decision_maker_confidence: 0,
  decision_maker_candidates: candidates.length > 0 ? JSON.stringify(candidates) : '',
});

const text = (value: unknown) => String(value || '').trim();

const normalizeToken = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const tokensFor = (value: string) => value
  .split(/[^a-zA-Z0-9]+/)
  .map(normalizeToken)
  .filter(Boolean);

const uniqueCandidates = (candidates: DecisionMakerCandidate[]) => {
  const byKey = new Map<string, DecisionMakerCandidate>();
  candidates.forEach((candidate) => {
    const key = candidate.email || `${candidate.name.toLowerCase()}|${candidate.title.toLowerCase()}`;
    if (!key || byKey.has(key)) return;
    byKey.set(key, candidate);
  });
  return [...byKey.values()].slice(0, 10);
};

const bareDomainFrom = (record: Record<string, unknown>) => {
  const raw = text(record.domain) || text(record.website);
  if (!raw) return '';
  try {
    const parsed = new URL(raw.match(/^https?:\/\//i) ? raw : `https://${raw}`);
    return parsed.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .split('?')[0]
      .trim()
      .toLowerCase();
  }
};

const normalizedDomain = (domain: string) => text(domain)
  .replace(/^https?:\/\//i, '')
  .split('/')[0]
  .split('?')[0]
  .replace(/^www\./i, '')
  .replace(/\.$/, '')
  .toLowerCase();

const sourceDomainMatchesRecordDomain = ({
  sourceDomain,
  recordDomain,
}: {
  sourceDomain: string;
  recordDomain: string;
}) => {
  const source = normalizedDomain(sourceDomain);
  const record = normalizedDomain(recordDomain);
  if (!source || !record) return false;
  return source === record;
};

export const deriveDecisionMakerBrandRoot = (businessName: unknown) => {
  const originalTokens = tokensFor(text(businessName));
  const stripped = originalTokens.filter((token) => !PRODUCT_AND_LEGAL_TOKENS.has(token));
  const brandTokens = stripped.length > 0 ? stripped : originalTokens;
  return brandTokens.join(' ').trim();
};

const significantBrandTokens = (brandRoot: string) => tokensFor(brandRoot)
  .filter((token) => token.length >= 3 && !PRODUCT_AND_LEGAL_TOKENS.has(token));

const companySearchMatchesBrand = ({
  brandRoot,
  organization,
  domain,
}: {
  brandRoot: string;
  organization: string;
  domain: string;
}) => {
  const tokens = significantBrandTokens(brandRoot);
  if (tokens.length === 0) return false;
  const normalizedBrandRoot = normalizeToken(brandRoot);
  const haystack = normalizeToken(`${organization} ${domain}`);
  if (normalizedBrandRoot.length >= 5 && haystack.includes(normalizedBrandRoot)) return true;
  return tokens.length > 1 && tokens.every((token) => haystack.includes(token));
};

const nestedRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const nestedArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const isHunterPayload = (value: Record<string, unknown>) => (
  Array.isArray(value.emails)
  || Boolean(text(value.organization))
  || Boolean(text(value.domain))
);

const hunterData = (response: unknown) => {
  const root = nestedRecord(response);
  const firstData = nestedRecord(root.data);
  const secondData = nestedRecord(firstData.data);
  if (isHunterPayload(secondData)) return secondData;
  if (isHunterPayload(firstData)) return firstData;
  return root;
};

const hunterCandidatesFrom = ({
  response,
  sourceQuery,
}: {
  response: unknown;
  sourceQuery: string;
}) => {
  const data = hunterData(response);
  const organization = text(data.organization);
  const domain = text(data.domain);
  const emails = nestedArray(data.emails);
  return emails.map((entry) => {
    const item = nestedRecord(entry);
    const firstName = text(item.first_name);
    const lastName = text(item.last_name);
    const name = [firstName, lastName].filter(Boolean).join(' ').trim();
    return {
      first_name: firstName,
      last_name: lastName,
      name,
      title: text(item.position) || text(item.position_raw),
      email: text(item.value),
      phone: text(item.phone_number) || text(item.phone),
      seniority: text(item.seniority),
      department: text(item.department),
      linkedin: text(item.linkedin) || text(item.linkedin_url),
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0,
      source_domain: domain,
      source_organization: organization,
      source: 'hunter' as const,
      source_query: sourceQuery,
    };
  }).filter((candidate) => candidate.name || candidate.email || candidate.title);
};

type DecisionMakerSourceResult = {
  candidates: DecisionMakerCandidate[];
  providerPayloads: unknown[];
};

const callHunterDomainSearch = async (
  mcp: Client,
  args: Record<string, unknown>,
) => {
  const response = await executeComposioTool(mcp, 'HUNTER_DOMAIN_SEARCH', args);
  return {
    candidates: hunterCandidatesFrom({
      response,
      sourceQuery: text(args.domain) || text(args.company),
    }),
    providerPayloads: [response],
  };
};

const guardedCompanySearch = async ({
  mcp,
  brandRoot,
  args,
}: {
  mcp: Client;
  brandRoot: string;
  args: Record<string, unknown>;
}) => {
  const source = await callHunterDomainSearch(mcp, args);
  const accepted = source.candidates.filter((candidate) => companySearchMatchesBrand({
    brandRoot,
    organization: candidate.source_organization,
    domain: candidate.source_domain,
  }));
  return {
    candidates: uniqueCandidates(accepted),
    providerPayloads: source.providerPayloads,
  };
};

const sourceDecisionMakerCandidates = async ({
  mcp,
  record,
}: {
  mcp: Client;
  record: Record<string, unknown>;
}): Promise<DecisionMakerSourceResult> => {
  const seniority = ['senior', 'executive'];
  const domain = bareDomainFrom(record);
  if (domain) {
    const source = await callHunterDomainSearch(mcp, { domain, seniority, limit: 10 });
    return {
      candidates: uniqueCandidates(source.candidates.filter((candidate) => sourceDomainMatchesRecordDomain({
        sourceDomain: candidate.source_domain,
        recordDomain: domain,
      }))),
      providerPayloads: source.providerPayloads,
    };
  }

  const brandRoot = deriveDecisionMakerBrandRoot(record.business_name);
  if (!brandRoot) return { candidates: [], providerPayloads: [] };

  const seniorCompanyCandidates = await guardedCompanySearch({
    mcp,
    brandRoot,
    args: { company: brandRoot, seniority, limit: 10 },
  });
  if (seniorCompanyCandidates.candidates.length > 0) return seniorCompanyCandidates;

  return guardedCompanySearch({
    mcp,
    brandRoot,
    args: { company: brandRoot, limit: 10 },
  });
};

const hunterVerificationData = (payload: unknown): Record<string, unknown> => {
  const root = nestedRecord(payload);
  const firstData = nestedRecord(root.data);
  return Object.keys(firstData).length > 0 ? firstData : root;
};

const clampConfidence = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed));
};

/**
 * Verifies an address with Hunter. A missing credential, failed request, or
 * malformed provider response remains unverified so channel policy fails closed.
 */
export const verifyHunterEmail = async ({
  email,
  apiKey = getEnv('HUNTER_API_KEY'),
  fetchImpl = globalThis.fetch,
}: {
  email: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<HunterEmailVerification | null> => {
  const normalizedEmail = text(email);
  const normalizedApiKey = text(apiKey);
  if (!normalizedEmail || !normalizedApiKey || typeof fetchImpl !== 'function') return null;

  const url = new URL('https://api.hunter.io/v2/email-verifier');
  url.searchParams.set('email', normalizedEmail);
  url.searchParams.set('api_key', normalizedApiKey);
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const data = hunterVerificationData(await response.json());
    const status = text(data.status).toLowerCase();
    if (!status) return null;
    return {
      status,
      confidence: clampConfidence(data.score),
      smtp_check: data.smtp_check === true,
      disposable: data.disposable === true,
    };
  } catch {
    return null;
  }
};

/** True only when the exact email string is present in the producing provider payload. */
export const hasLiteralEmailSupport = ({
  email,
  providerPayloads,
}: {
  email: string;
  providerPayloads: unknown[];
}) => {
  const candidateEmail = text(email);
  if (!candidateEmail) return true;
  return providerPayloads.some((payload) => {
    try {
      return JSON.stringify(payload).includes(candidateEmail);
    } catch {
      return false;
    }
  });
};

/**
 * The final persistence boundary for decision-maker contacts. This is where
 * literal provider support is enforced, before confidence can reach contacts.
 */
export const persistSupportedDecisionMakerCandidates = async ({
  db,
  recordId,
  candidates,
  providerPayloads,
  sourcedAt = new Date().toISOString(),
  emailVerifier = (email) => verifyHunterEmail({ email }),
}: {
  db: NonNullable<DecisionMakerActionInput['db']>;
  recordId: string;
  candidates: DecisionMakerCandidate[];
  providerPayloads: unknown[];
  sourcedAt?: string;
  emailVerifier?: EmailVerifier;
}): Promise<DecisionMakerCandidate[]> => {
  const supported = candidates.filter((candidate) => hasLiteralEmailSupport({
    email: candidate.email,
    providerPayloads,
  }));
  const verified = await Promise.all(supported.map(async (candidate) => {
    const verification = candidate.email ? await emailVerifier(candidate.email) : null;
    return { candidate, verification };
  }));

  verified.forEach(({ candidate, verification }) => {
    upsertContact({
      db,
      contact: {
        record_id: recordId,
        full_name: candidate.name,
        first_name: candidate.first_name,
        last_name: candidate.last_name,
        title: candidate.title,
        seniority: candidate.seniority,
        email: candidate.email,
        phone: candidate.phone,
        linkedin_url: candidate.linkedin,
        source: 'hunter',
        source_query: candidate.source_query,
        sourced_at: sourcedAt,
        confidence: candidate.confidence,
        email_verification_status: verification?.status || '',
        email_verification_confidence: verification?.confidence || 0,
        email_verified_at: verification ? sourcedAt : '',
      },
    });
  });
  syncPrimaryContactProjection({ db, recordId });
  return verified.map(({ candidate }) => candidate);
};

const primaryContactOutputs = ({
  primaryContact,
  candidates,
}: {
  primaryContact: Record<string, unknown>;
  candidates: DecisionMakerCandidate[];
}) => {
  const fullName = text(primaryContact.full_name)
    || text(primaryContact.name)
    || [text(primaryContact.first_name), text(primaryContact.last_name)].filter(Boolean).join(' ');
  const confidence = Number(primaryContact.confidence);
  return {
    decision_maker_name: fullName,
    decision_maker_title: text(primaryContact.title),
    decision_maker_email: text(primaryContact.email).toLowerCase(),
    decision_maker_linkedin: text(primaryContact.linkedin_url),
    decision_maker_confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(100, Math.round(confidence)))
      : 0,
    decision_maker_candidates: JSON.stringify(candidates),
  };
};

export const executeDecisionMakersAction = async ({
  db,
  mcp,
  record,
  emailVerifier,
}: DecisionMakerActionInput): Promise<DecisionMakerActionResult> => {
  const hunterMcp = mcp || await getMcpClient();

  const source = await sourceDecisionMakerCandidates({ mcp: hunterMcp, record });
  if (source.candidates.length === 0) return { outputs: emptyDecisionMakerOutputs() };
  if (!db) throw new Error('The decision_makers enrichment action requires a database handle.');

  const recordId = getRecordRowId(record);
  const candidates = await persistSupportedDecisionMakerCandidates({
    db,
    recordId,
    candidates: source.candidates,
    providerPayloads: source.providerPayloads,
    emailVerifier,
  });
  if (candidates.length === 0) return { outputs: emptyDecisionMakerOutputs() };

  const primaryContact = listContactsByRecord({ db, recordId })
    .find((contact) => Number(contact.is_primary) === 1);
  if (!primaryContact) return { outputs: emptyDecisionMakerOutputs(candidates) };

  return { outputs: primaryContactOutputs({ primaryContact, candidates }) };
};
