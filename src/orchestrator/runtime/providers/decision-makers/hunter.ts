import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getMcpClient } from '../../mcp.js';
import { executeComposioTool } from '../../tools.js';
import { asArray, asRecord, emptyCandidate, numeric, text } from './shared.js';
import { verifyHunterEmail } from '../email-verification/hunter.js';
import {
  emailVerificationProviderFailureError,
  type EmailVerificationResult,
} from '../email-verification/types.js';
import type {
  DecisionMakerCandidate,
  DecisionMakerProvider,
  DecisionMakerProviderFactoryContext,
  DecisionMakerRevealInput,
  DecisionMakerRevealResult,
  DecisionMakerSearchInput,
  DecisionMakerSearchResult,
} from './types.js';

export type HunterEmailVerification = EmailVerificationResult;
export { verifyHunterEmail } from '../email-verification/hunter.js';

const payloadFrom = (response: unknown) => {
  const root = asRecord(response);
  const firstData = asRecord(root.data);
  const secondData = asRecord(firstData.data);
  if (Array.isArray(secondData.emails) || text(secondData.organization) || text(secondData.domain)) return secondData;
  if (Array.isArray(firstData.emails) || text(firstData.organization) || text(firstData.domain)) return firstData;
  return root;
};

const candidatesFrom = ({
  response,
  sourceQuery,
}: {
  response: unknown;
  sourceQuery: string;
}) => {
  const payload = payloadFrom(response);
  const organization = text(payload.organization);
  const domain = text(payload.domain);
  return asArray(payload.emails).map((entry) => {
    const item = asRecord(entry);
    const firstName = text(item.first_name);
    const lastName = text(item.last_name);
    const name = [firstName, lastName].filter(Boolean).join(' ').trim();
    return {
      ...emptyCandidate('hunter'),
      provider_candidate_id: text(item.id) || text(item.value),
      first_name: firstName,
      last_name: lastName,
      name,
      title: text(item.position) || text(item.position_raw),
      email: text(item.value),
      phone: text(item.phone_number) || text(item.phone),
      seniority: text(item.seniority),
      department: text(item.department),
      linkedin: text(item.linkedin) || text(item.linkedin_url),
      confidence: numeric(item.confidence),
      source_domain: domain,
      source_organization: organization,
      source_query: sourceQuery,
    };
  }).filter((candidate) => candidate.name || candidate.email || candidate.title);
};

export class HunterDecisionMakerProvider implements DecisionMakerProvider {
  id = 'hunter';
  private mcp: Client | null;

  constructor(context: DecisionMakerProviderFactoryContext = {}) {
    this.mcp = context.mcp || null;
  }

  private async client() {
    return this.mcp || getMcpClient();
  }

  async search(input: DecisionMakerSearchInput): Promise<DecisionMakerSearchResult> {
    const sourceQuery = text(input.domain) || text(input.organization);
    if (!sourceQuery) return { candidates: [], provider_payloads: [] };
    const args = input.domain
      ? { domain: input.domain, seniority: input.seniorities, limit: input.limit }
      : { company: text(input.organization), seniority: input.seniorities, limit: input.limit };
    const response = await executeComposioTool(await this.client(), 'HUNTER_DOMAIN_SEARCH', args);
    return {
      candidates: candidatesFrom({ response, sourceQuery }),
      provider_payloads: [response],
    };
  }

  async reveal(input: DecisionMakerRevealInput): Promise<DecisionMakerRevealResult> {
    const outcome = input.candidate.email
      ? await verifyHunterEmail({ email: input.candidate.email })
      : { kind: 'no_opinion' as const, reason: 'email_missing' };
    if (outcome.kind === 'failure') {
      throw emailVerificationProviderFailureError({ provider: this.id, failure: outcome.failure });
    }
    const verification = outcome.kind === 'verdict' ? outcome.verification : null;
    return {
      contact: {
        ...input.candidate,
        email_verification_status: verification?.status || '',
        email_verification_confidence: verification?.confidence || 0,
      },
      provider_payloads: [],
    };
  }
}
