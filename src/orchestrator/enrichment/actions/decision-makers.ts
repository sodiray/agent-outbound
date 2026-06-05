import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { generateObjectWithTools } from '../../runtime/llm.js';
import { executeComposioTool } from '../../runtime/tools.js';
import { getMcpClient } from '../../runtime/mcp.js';

type DecisionMakerCandidate = {
  first_name: string;
  last_name: string;
  name: string;
  title: string;
  email: string;
  seniority: string;
  department: string;
  linkedin: string;
  confidence: number;
  source_domain: string;
  source_organization: string;
  source: string;
};

type DecisionMakerActionInput = {
  mcp?: Client | null;
  listDir: string;
  stepId: string;
  stepConfig: Record<string, unknown>;
  record: Record<string, unknown>;
  aiConfig?: Record<string, unknown>;
};

type DecisionMakerActionResult = {
  outputs: Record<string, unknown>;
  usage?: Record<string, unknown>;
  model?: string;
  provider?: string;
};

const SelectionSchema = z.object({
  selected_index: z.number().int().min(0).nullable().default(null),
  confidence: z.number().int().min(0).max(100).default(0),
  reason: z.string().default(''),
});

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
  const haystack = normalizeToken(`${organization} ${domain}`);
  return tokens.some((token) => haystack.includes(token));
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
  source,
}: {
  response: unknown;
  source: string;
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
      email: text(item.value).toLowerCase(),
      seniority: text(item.seniority),
      department: text(item.department),
      linkedin: text(item.linkedin),
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0,
      source_domain: domain,
      source_organization: organization,
      source,
    };
  }).filter((candidate) => candidate.name || candidate.email || candidate.title);
};

const callHunterDomainSearch = async (
  mcp: Client,
  args: Record<string, unknown>,
) => hunterCandidatesFrom({
  response: await executeComposioTool(mcp, 'HUNTER_DOMAIN_SEARCH', args),
  source: Object.prototype.hasOwnProperty.call(args, 'company') ? 'company' : 'domain',
});

const guardedCompanySearch = async ({
  mcp,
  brandRoot,
  args,
}: {
  mcp: Client;
  brandRoot: string;
  args: Record<string, unknown>;
}) => {
  const candidates = await callHunterDomainSearch(mcp, args);
  const accepted = candidates.filter((candidate) => companySearchMatchesBrand({
    brandRoot,
    organization: candidate.source_organization,
    domain: candidate.source_domain,
  }));
  return uniqueCandidates(accepted);
};

const sourceDecisionMakerCandidates = async ({
  mcp,
  record,
}: {
  mcp: Client;
  record: Record<string, unknown>;
}) => {
  const seniority = ['senior', 'executive'];
  const domain = bareDomainFrom(record);
  const domainCandidates = domain
    ? uniqueCandidates(await callHunterDomainSearch(mcp, { domain, seniority, limit: 10 }))
    : [];
  if (domainCandidates.length > 0) return domainCandidates;

  const brandRoot = deriveDecisionMakerBrandRoot(record.business_name);
  if (!brandRoot) return [];

  const seniorCompanyCandidates = await guardedCompanySearch({
    mcp,
    brandRoot,
    args: { company: brandRoot, seniority, limit: 10 },
  });
  if (seniorCompanyCandidates.length > 0) return seniorCompanyCandidates;

  return guardedCompanySearch({
    mcp,
    brandRoot,
    args: { company: brandRoot, limit: 10 },
  });
};

const chooseDecisionMaker = async ({
  candidates,
  stepConfig,
  aiConfig,
}: {
  candidates: DecisionMakerCandidate[];
  stepConfig: Record<string, unknown>;
  aiConfig: Record<string, unknown>;
}) => {
  const result = await generateObjectWithTools({
    task: 'decision-maker-select',
    model: text(stepConfig.model),
    role: 'research',
    aiConfig,
    schema: SelectionSchema,
    prompt: [
      'Select the single best decision-maker for B2B outreach from these Hunter candidates.',
      'Prefer owner, founder, CEO, president, general manager, VP, director, or clear commercial/operational authority.',
      'Avoid junior, support-only, or purely technical roles unless no better authority exists.',
      'Return the zero-based selected_index from the candidate array and a confidence from 0 to 100.',
      '',
      JSON.stringify(candidates.map((candidate, index) => ({ index, ...candidate })), null, 2),
    ].join('\n'),
  });
  return result;
};

export const executeDecisionMakersAction = async ({
  mcp,
  stepConfig,
  record,
  aiConfig = {},
}: DecisionMakerActionInput): Promise<DecisionMakerActionResult> => {
  const hunterMcp = mcp || await getMcpClient();

  const candidates = await sourceDecisionMakerCandidates({ mcp: hunterMcp, record });
  if (candidates.length === 0) return { outputs: emptyDecisionMakerOutputs() };

  const selectionResult = await chooseDecisionMaker({ candidates, stepConfig, aiConfig });
  const selection = SelectionSchema.parse(selectionResult.object);
  const selectedIndex = selection.selected_index;
  const fallbackIndex = 0;
  const finalIndex = selectedIndex === null || selectedIndex >= candidates.length ? fallbackIndex : selectedIndex;
  const selected = candidates[finalIndex];
  const confidence = selection.confidence || selected.confidence || 0;

  return {
    outputs: {
      decision_maker_name: selected.name,
      decision_maker_title: selected.title,
      decision_maker_email: selected.email,
      decision_maker_linkedin: selected.linkedin,
      decision_maker_confidence: Math.max(0, Math.min(100, Math.round(confidence))),
      decision_maker_candidates: JSON.stringify(candidates),
    },
    usage: selectionResult.usage,
    model: selectionResult.model,
    provider: selectionResult.provider,
  };
};
