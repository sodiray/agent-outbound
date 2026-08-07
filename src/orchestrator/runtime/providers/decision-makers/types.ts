import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export type DecisionMakerCandidate = {
  provider_candidate_id: string;
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
  source: string;
  source_query: string;
  email_verification_status: string;
  email_verification_confidence: number;
};

export type DecisionMakerSearchInput = {
  domain: string;
  organization?: string;
  seniorities: string[];
  limit: number;
};

export type DecisionMakerRevealInput = {
  candidate: DecisionMakerCandidate;
  domain: string;
};

export type DecisionMakerSearchResult = {
  candidates: DecisionMakerCandidate[];
  provider_payloads: unknown[];
};

export type DecisionMakerRevealResult = {
  contact: DecisionMakerCandidate;
  provider_payloads: unknown[];
};

export interface DecisionMakerProvider {
  id: string;
  search(input: DecisionMakerSearchInput): Promise<DecisionMakerSearchResult>;
  reveal(input: DecisionMakerRevealInput): Promise<DecisionMakerRevealResult>;
}

export type DecisionMakerProviderFactoryContext = {
  mcp?: Client | null;
};

export type DecisionMakerProviderFactory = {
  requires_mcp: boolean;
  create(context: DecisionMakerProviderFactoryContext): DecisionMakerProvider;
};
