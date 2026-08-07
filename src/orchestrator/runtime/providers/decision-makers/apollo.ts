import { getProvider } from '../registry.js';
import { monidSyntheticSlug } from '../monid.js';
import type { ProviderToolSchema, ToolProvider } from '../types.js';
import { asArray, asRecord, emptyCandidate, mergeCandidate, numeric, text } from './shared.js';
import type {
  DecisionMakerCandidate,
  DecisionMakerProvider,
  DecisionMakerRevealInput,
  DecisionMakerRevealResult,
  DecisionMakerSearchInput,
  DecisionMakerSearchResult,
} from './types.js';

const SEARCH_SLUG = monidSyntheticSlug('apollo', '/mixed_people/api_search');
const REVEAL_SLUG = monidSyntheticSlug('apollo', '/people/match');

const schemaFor = (slug: string, endpoint: string): ProviderToolSchema => ({
  slug,
  server: 'monid',
  provider: 'apollo',
  endpoint,
  name: endpoint,
  description: '',
  input_schema: { type: 'object', properties: {} },
  parameter_locations: {
    'q_organization_domains_list[]': 'query',
    'person_seniorities[]': 'query',
    person_titles: 'query',
    include_similar_titles: 'query',
    per_page: 'query',
    id: 'query',
    first_name: 'query',
    last_name: 'query',
    name: 'query',
    email: 'query',
    domain: 'query',
    organization_name: 'query',
    linkedin_url: 'query',
    reveal_personal_emails: 'query',
    reveal_phone_number: 'query',
  },
});

const outputFrom = (response: unknown): Record<string, unknown> => {
  const root = asRecord(response);
  const output = asRecord(root.output);
  if (Object.keys(output).length > 0) return output;
  const data = asRecord(root.data);
  const nestedOutput = asRecord(data.output);
  return Object.keys(nestedOutput).length > 0 ? nestedOutput : (Object.keys(data).length > 0 ? data : root);
};

const candidateFrom = ({
  person,
  domain,
}: {
  person: unknown;
  domain: string;
}): DecisionMakerCandidate => {
  const item = asRecord(person);
  const organization = asRecord(item.organization);
  const firstName = text(item.first_name);
  const lastName = text(item.last_name);
  const named = text(item.name) || [firstName, lastName].filter(Boolean).join(' ').trim();
  const emailVerificationStatus = text(item.email_status).toLowerCase();
  const emailVerificationConfidence = numeric(item.email_confidence)
    || (emailVerificationStatus === 'verified' ? 100 : 0);
  return {
    ...emptyCandidate('apollo'),
    provider_candidate_id: text(item.id),
    first_name: firstName,
    last_name: lastName,
    name: named,
    title: text(item.title),
    email: text(item.email),
    phone: text(item.phone_number) || text(item.phone),
    seniority: text(item.seniority) || text(item.person_seniority),
    department: text(item.department),
    linkedin: text(item.linkedin_url),
    confidence: numeric(item.confidence),
    source_domain: text(organization.primary_domain) || domain,
    source_organization: text(organization.name),
    source_query: domain,
    email_verification_status: emailVerificationStatus,
    email_verification_confidence: emailVerificationConfidence,
  };
};

const personFromReveal = (response: unknown): unknown => {
  const output = outputFrom(response);
  return output.person || output.people?.[0] || output;
};

export class ApolloDecisionMakerProvider implements DecisionMakerProvider {
  id = 'apollo';
  private toolProvider: ToolProvider;

  constructor(toolProvider: ToolProvider = getProvider('monid')) {
    this.toolProvider = toolProvider;
    this.toolProvider.registerSchemas?.([
      schemaFor(SEARCH_SLUG, '/mixed_people/api_search'),
      schemaFor(REVEAL_SLUG, '/people/match'),
    ]);
  }

  async search(input: DecisionMakerSearchInput): Promise<DecisionMakerSearchResult> {
    const domain = text(input.domain);
    if (!domain) return { candidates: [], provider_payloads: [] };
    const response = await this.toolProvider.executeTool(SEARCH_SLUG, {
      'q_organization_domains_list[]': [domain],
      'person_seniorities[]': input.seniorities,
      include_similar_titles: true,
      per_page: Math.max(1, Math.min(100, Math.floor(input.limit))),
    });
    const output = outputFrom(response);
    return {
      candidates: asArray(output.people)
        .map((person) => candidateFrom({ person, domain }))
        .filter((candidate) => candidate.provider_candidate_id || candidate.title),
      provider_payloads: [response],
    };
  }

  async reveal(input: DecisionMakerRevealInput): Promise<DecisionMakerRevealResult> {
    const candidate = input.candidate;
    const response = await this.toolProvider.executeTool(REVEAL_SLUG, {
      ...(candidate.provider_candidate_id ? { id: candidate.provider_candidate_id } : {}),
      ...(candidate.first_name ? { first_name: candidate.first_name } : {}),
      ...(candidate.last_name ? { last_name: candidate.last_name } : {}),
      ...(candidate.name ? { name: candidate.name } : {}),
      ...(candidate.email ? { email: candidate.email } : {}),
      ...(input.domain ? { domain: input.domain } : {}),
      ...(candidate.source_organization ? { organization_name: candidate.source_organization } : {}),
      ...(candidate.linkedin ? { linkedin_url: candidate.linkedin } : {}),
      reveal_personal_emails: false,
      reveal_phone_number: false,
    });
    const revealed = candidateFrom({ person: personFromReveal(response), domain: input.domain });
    return {
      contact: mergeCandidate(candidate, revealed),
      provider_payloads: [response],
    };
  }
}
