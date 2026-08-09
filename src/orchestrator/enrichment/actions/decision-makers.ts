import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  listContactsByRecord,
  syncPrimaryContactProjection,
  upsertContact,
} from '../../runtime/db.js';
import { getRecordRowId } from '../../lib/record.js';
import { collectProviderToolUsage } from '../../runtime/providers/usage.js';
import {
  resolveDecisionMakerProvider,
  type DecisionMakerCandidate,
  type DecisionMakerProvider,
} from '../../runtime/providers/decision-makers/index.js';
import {
  emailVerificationProviderFailureError,
  type EmailVerificationOutcome,
} from '../../runtime/providers/email-verification/index.js';

type EmailVerifier = (email: string) => Promise<EmailVerificationOutcome>;

type DecisionMakerActionInput = {
  db?: Parameters<typeof upsertContact>[0]['db'];
  mcp?: Client | null;
  listDir: string;
  stepId: string;
  stepConfig: Record<string, unknown>;
  record: Record<string, unknown>;
  aiConfig?: Record<string, unknown>;
  emailVerifier?: EmailVerifier;
  decisionMakerProvider?: DecisionMakerProvider;
};

type DecisionMakerActionResult = {
  outputs: Record<string, unknown>;
  usage?: Record<string, unknown>;
  model?: string;
  provider?: string;
};

type DecisionMakerMode = 'discovery' | 'reveal' | 'resolve';

const PRODUCT_AND_LEGAL_TOKENS = new Set([
  'fiber', 'internet', 'broadband', 'networks', 'network', 'communications',
  'telecom', 'wireless', 'services', 'service', 'solutions', 'systems', 'group',
  'holdings', 'company', 'co', 'corp', 'corporation', 'incorporated', 'inc', 'llc',
  'ltd', 'lp', 'pllc', 'the',
]);

const text = (value: unknown) => String(value || '').trim();

const emptyDecisionMakerOutputs = (candidates: DecisionMakerCandidate[] = []) => ({
  decision_maker_exists: candidates.length > 0,
  decision_maker_name: '',
  decision_maker_title: candidates[0]?.title || '',
  decision_maker_seniority: candidates[0]?.seniority || '',
  decision_maker_email: '',
  decision_maker_linkedin: '',
  decision_maker_confidence: 0,
  decision_maker_candidates: candidates.length > 0 ? JSON.stringify(candidates) : '',
});

const mappedDecisionMakerOutputs = ({
  outputs,
  stepConfig,
}: {
  outputs: Record<string, unknown>;
  stepConfig: Record<string, unknown>;
}) => {
  const outputFields = stepConfig.output_fields && typeof stepConfig.output_fields === 'object'
    ? stepConfig.output_fields as Record<string, unknown>
    : {};
  return Object.fromEntries(Object.entries(outputs).map(([name, value]) => [
    text(outputFields[name]) || name,
    value,
  ]));
};

const normalizeToken = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const tokensFor = (value: string) => value
  .split(/[^a-zA-Z0-9]+/)
  .map(normalizeToken)
  .filter(Boolean);

const candidateKey = (candidate: DecisionMakerCandidate) => (
  candidate.provider_candidate_id
  || candidate.email
  || `${candidate.name.toLowerCase()}|${candidate.title.toLowerCase()}`
);

const uniqueCandidates = (candidates: DecisionMakerCandidate[]) => {
  const byKey = new Map<string, DecisionMakerCandidate>();
  candidates.forEach((candidate) => {
    const key = candidateKey(candidate);
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
  return (stripped.length > 0 ? stripped : originalTokens).join(' ').trim();
};

const companySearchMatchesBrand = ({
  brandRoot,
  organization,
  domain,
}: {
  brandRoot: string;
  organization: string;
  domain: string;
}) => {
  const tokens = tokensFor(brandRoot)
    .filter((token) => token.length >= 3 && !PRODUCT_AND_LEGAL_TOKENS.has(token));
  if (tokens.length === 0) return false;
  const normalizedBrandRoot = normalizeToken(brandRoot);
  const haystack = normalizeToken(`${organization} ${domain}`);
  if (normalizedBrandRoot.length >= 5 && haystack.includes(normalizedBrandRoot)) return true;
  return tokens.length > 1 && tokens.every((token) => haystack.includes(token));
};

const searchCandidates = async ({
  provider,
  record,
}: {
  provider: DecisionMakerProvider;
  record: Record<string, unknown>;
}) => {
  const seniorities = ['senior', 'executive'];
  const domain = bareDomainFrom(record);
  if (domain) {
    const source = await provider.search({ domain, seniorities, limit: 10 });
    return {
      candidates: uniqueCandidates(source.candidates.filter((candidate) => sourceDomainMatchesRecordDomain({
        sourceDomain: candidate.source_domain,
        recordDomain: domain,
      }))),
      providerPayloads: source.provider_payloads,
      domain,
    };
  }

  const organization = deriveDecisionMakerBrandRoot(record.business_name);
  if (!organization) return { candidates: [], providerPayloads: [], domain: '' };
  const acceptedCandidates = (source: Awaited<ReturnType<DecisionMakerProvider['search']>>) => (
    uniqueCandidates(source.candidates.filter((candidate) => companySearchMatchesBrand({
      brandRoot: organization,
      organization: candidate.source_organization,
      domain: candidate.source_domain,
    })))
  );
  const seniorSource = await provider.search({ domain: '', organization, seniorities, limit: 10 });
  const seniorCandidates = acceptedCandidates(seniorSource);
  if (seniorCandidates.length > 0) {
    return { candidates: seniorCandidates, providerPayloads: seniorSource.provider_payloads, domain: '' };
  }
  const source = await provider.search({ domain: '', organization, seniorities: [], limit: 10 });
  return {
    candidates: acceptedCandidates(source),
    providerPayloads: source.provider_payloads,
    domain: '',
  };
};

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

export const persistSupportedDecisionMakerCandidates = async ({
  db,
  recordId,
  candidates,
  providerPayloads,
  sourcedAt = new Date().toISOString(),
  emailVerifier,
}: {
  db: NonNullable<DecisionMakerActionInput['db']>;
  recordId: string;
  candidates: DecisionMakerCandidate[];
  providerPayloads: unknown[];
  sourcedAt?: string;
  emailVerifier?: EmailVerifier;
}): Promise<DecisionMakerCandidate[]> => {
  const supported = candidates.filter((candidate) => (
    (candidate.name || candidate.email || candidate.phone)
    && hasLiteralEmailSupport({ email: candidate.email, providerPayloads })
  ));
  const verified = await Promise.all(supported.map(async (candidate) => {
    const outcome = candidate.email_verification_status
      ? {
        kind: 'verdict' as const,
        verification: {
          status: candidate.email_verification_status,
          confidence: candidate.email_verification_confidence,
        },
      }
      : (candidate.email && emailVerifier
        ? await emailVerifier(candidate.email)
        : { kind: 'no_opinion' as const, reason: 'provider_has_no_opinion' });
    if (outcome.kind === 'failure') {
      throw emailVerificationProviderFailureError({ provider: candidate.source || 'email-verification', failure: outcome.failure });
    }
    const verification = outcome.kind === 'verdict' ? outcome.verification : null;
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
        source: candidate.source,
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
    decision_maker_exists: candidates.length > 0,
    decision_maker_name: fullName,
    decision_maker_title: text(primaryContact.title),
    decision_maker_seniority: text(primaryContact.seniority),
    decision_maker_email: text(primaryContact.email).toLowerCase(),
    decision_maker_linkedin: text(primaryContact.linkedin_url),
    decision_maker_confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(100, Math.round(confidence)))
      : 0,
    decision_maker_candidates: JSON.stringify(candidates),
  };
};

const decisionMakerModeFor = (stepConfig: Record<string, unknown>): DecisionMakerMode => {
  const mode = text(stepConfig.mode || stepConfig.decision_maker_mode).toLowerCase();
  if (!mode) return 'resolve';
  if (mode === 'discovery' || mode === 'reveal' || mode === 'resolve') return mode;
  throw new Error(`Unknown decision-maker mode "${mode}".`);
};

const candidatesFromRecord = (record: Record<string, unknown>, candidateField: string) => {
  try {
    const parsed = JSON.parse(text(record[candidateField]) || '[]');
    return Array.isArray(parsed) ? parsed as DecisionMakerCandidate[] : [];
  } catch {
    return [];
  }
};

const mergedUsage = (usages: Array<Record<string, unknown> | null>) => {
  const present = usages.filter((usage): usage is Record<string, unknown> => Boolean(usage));
  if (present.length === 0) return undefined;
  return present.reduce<Record<string, unknown>>((merged, usage) => ({
    ...merged,
    ...usage,
    usd_cost: Number(merged.usd_cost || 0) + Number(usage.usd_cost || 0),
    tool_calls: [
      ...(Array.isArray(merged.tool_calls) ? merged.tool_calls : []),
      ...(Array.isArray(usage.tool_calls) ? usage.tool_calls : []),
    ],
    tool_costs: [
      ...(Array.isArray(merged.tool_costs) ? merged.tool_costs : []),
      ...(Array.isArray(usage.tool_costs) ? usage.tool_costs : []),
    ],
  }), {});
};

const usageForProvider = (usage: Record<string, unknown> | undefined, provider: string) => (
  usage ? { ...usage, provider } : undefined
);

export const executeDecisionMakersAction = async ({
  db,
  mcp,
  record,
  stepConfig,
  emailVerifier,
  decisionMakerProvider,
}: DecisionMakerActionInput): Promise<DecisionMakerActionResult> => {
  const provider = decisionMakerProvider || resolveDecisionMakerProvider({
    provider: text(stepConfig.provider),
    context: { mcp },
  });
  const mode = decisionMakerModeFor(stepConfig);

  if (mode === 'discovery') {
    const discovery = await collectProviderToolUsage(() => searchCandidates({ provider, record }));
    return {
      outputs: mappedDecisionMakerOutputs({
        outputs: emptyDecisionMakerOutputs(discovery.result.candidates),
        stepConfig,
      }),
      usage: usageForProvider(discovery.usage || undefined, provider.id),
      provider: provider.id,
    };
  }

  const discovery = mode === 'resolve'
    ? await collectProviderToolUsage(() => searchCandidates({ provider, record }))
    : null;
  const candidates = discovery?.result.candidates || candidatesFromRecord(
    record,
    text(stepConfig.candidate_field) || 'decision_maker_candidates',
  );
  const domain = discovery?.result.domain || bareDomainFrom(record);
  if (candidates.length === 0) {
    return {
      outputs: mappedDecisionMakerOutputs({ outputs: emptyDecisionMakerOutputs(), stepConfig }),
      usage: usageForProvider(discovery?.usage || undefined, provider.id),
      provider: provider.id,
    };
  }
  if (!db) throw new Error('The decision_makers enrichment action requires a database handle.');

  const selected = mode === 'reveal' ? candidates.slice(0, 1) : candidates;
  const reveals = await Promise.all(selected.map(async (candidate) => (
    collectProviderToolUsage(() => provider.reveal({ candidate, domain }))
  )));
  const providerPayloads = [
    ...(discovery?.result.providerPayloads || []),
    ...reveals.flatMap((reveal) => reveal.result.provider_payloads),
  ];
  const persisted = await persistSupportedDecisionMakerCandidates({
    db,
    recordId: getRecordRowId(record),
    candidates: reveals.map((reveal) => reveal.result.contact),
    providerPayloads,
    emailVerifier,
  });
  const usage = mergedUsage([
    discovery?.usage || null,
    ...reveals.map((reveal) => reveal.usage),
  ]);
  const attributedUsage = usageForProvider(usage, provider.id);
  if (persisted.length === 0) {
    return {
      outputs: mappedDecisionMakerOutputs({ outputs: emptyDecisionMakerOutputs(candidates), stepConfig }),
      usage: attributedUsage,
      provider: provider.id,
    };
  }

  const primaryContact = listContactsByRecord({ db, recordId: getRecordRowId(record) })
    .find((contact) => Number(contact.is_primary) === 1);
  if (!primaryContact) {
    return {
      outputs: mappedDecisionMakerOutputs({ outputs: emptyDecisionMakerOutputs(persisted), stepConfig }),
      usage: attributedUsage,
      provider: provider.id,
    };
  }
  return {
    outputs: mappedDecisionMakerOutputs({
      outputs: primaryContactOutputs({ primaryContact, candidates: persisted }),
      stepConfig,
    }),
    usage: attributedUsage,
    provider: provider.id,
  };
};
