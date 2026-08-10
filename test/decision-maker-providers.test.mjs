import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { executeDecisionMakersAction } from '../dist/orchestrator/enrichment/actions/decision-makers.js';
import { recordCostEvent } from '../dist/orchestrator/lib/costs.js';
import { evaluateReachability } from '../dist/orchestrator/policy/timing-reachability.js';
import { ApolloDecisionMakerProvider } from '../dist/orchestrator/runtime/providers/decision-makers/apollo.js';
import { HunterDecisionMakerProvider } from '../dist/orchestrator/runtime/providers/decision-makers/hunter.js';
import {
  resolveDecisionMakerProvider,
} from '../dist/orchestrator/runtime/providers/decision-makers/index.js';
import { recordProviderToolCost } from '../dist/orchestrator/runtime/providers/usage.js';
import { openListDb } from '../dist/orchestrator/runtime/db.js';

const candidate = (overrides = {}) => ({
  provider_candidate_id: 'person_1',
  first_name: '',
  last_name: '',
  name: '',
  title: 'Owner',
  email: '',
  phone: '',
  seniority: 'owner',
  department: '',
  linkedin: '',
  confidence: 0,
  source_domain: 'example.test',
  source_organization: 'Example Test',
  source: 'test-provider',
  source_query: 'example.test',
  email_verification_status: '',
  email_verification_confidence: 0,
  ...overrides,
});

const createListDb = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-decision-provider-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: Decision Maker Provider Test
business:
  name: Test
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps: []
policy:
  version: test
`);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, domain, sequence_name, sequence_status,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'default', 'active', ?, ?, ?, ?)
  `).run('provider_record_1', 'Example Test', 'example.test', now, now, now, now);
  return { db, listDir };
};

test('decision-maker provider dispatch honors the configured provider and keeps the established default', () => {
  const calls = [];
  const factory = (id) => ({
    requires_mcp: false,
    create: () => {
      calls.push(id);
      return { id, search: async () => ({ candidates: [], provider_payloads: [] }), reveal: async () => ({}) };
    },
  });
  const factories = { hunter: factory('hunter'), apollo: factory('apollo') };

  assert.equal(resolveDecisionMakerProvider({ provider: 'apollo', factories }).id, 'apollo');
  assert.equal(resolveDecisionMakerProvider({ factories }).id, 'hunter');
  assert.deepEqual(calls, ['apollo', 'hunter']);
});

test('Apollo discovery maps people without unmasking a masked identity', async () => {
  const calls = [];
  const provider = new ApolloDecisionMakerProvider({
    registerSchemas: () => {},
    executeTool: async (slug, args) => {
      calls.push({ slug, args });
      return {
        output: {
          total_entries: 1,
          people: [{
            id: 'apollo_person_1',
            name: null,
            email: null,
            title: 'Director of Operations',
            seniority: 'director',
          }],
        },
      };
    },
  });

  const result = await provider.search({
    domain: 'example.test',
    seniorities: ['director'],
    limit: 5,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args['q_organization_domains_list[]'], ['example.test']);
  assert.deepEqual(calls[0].args['person_seniorities[]'], ['director']);
  assert.deepEqual(result.candidates, [candidate({
    provider_candidate_id: 'apollo_person_1',
    title: 'Director of Operations',
    seniority: 'director',
    source_organization: '',
    source: 'apollo',
  })]);
});

test('Apollo reveal maps the returned contact and its explicit verification status', async () => {
  const provider = new ApolloDecisionMakerProvider({
    registerSchemas: () => {},
    executeTool: async () => ({
      output: {
        person: {
          id: 'apollo_person_1',
          first_name: 'Avery',
          last_name: 'Nguyen',
          name: 'Avery Nguyen',
          email: 'avery@example.test',
          email_status: 'verified',
          title: 'Owner',
          seniority: 'owner',
        },
      },
    }),
  });

  const result = await provider.reveal({
    candidate: candidate({ provider_candidate_id: 'apollo_person_1', source: 'apollo' }),
    domain: 'example.test',
  });

  assert.equal(result.contact.name, 'Avery Nguyen');
  assert.equal(result.contact.email, 'avery@example.test');
  assert.equal(result.contact.email_verification_status, 'verified');
  assert.equal(result.contact.email_verification_confidence, 100);
});

test('reveal usage reaches the existing record cost ledger', async () => {
  const { db, listDir } = createListDb();
  const revealed = candidate({
    first_name: 'Avery',
    last_name: 'Nguyen',
    name: 'Avery Nguyen',
    email: 'avery@example.test',
    confidence: 88,
    email_verification_status: 'valid',
    email_verification_confidence: 92,
  });
  const provider = {
    id: 'test-provider',
    search: async () => ({ candidates: [], provider_payloads: [] }),
    reveal: async () => {
      recordProviderToolCost({ provider: 'test-provider', slug: 'reveal', usd_cost: 0.05 });
      return { contact: revealed, provider_payloads: [{ person: { email: revealed.email } }] };
    },
  };

  const result = await executeDecisionMakersAction({
    db,
    listDir,
    stepId: 'decision_maker_reveal',
    stepConfig: { action: 'decision_makers', mode: 'reveal' },
    record: {
      _row_id: 'provider_record_1',
      domain: 'example.test',
      decision_maker_candidates: JSON.stringify([candidate()]),
    },
    decisionMakerProvider: provider,
  });
  assert.equal(result.usage.usd_cost, 0.05);

  recordCostEvent({
    db,
    listDir,
    recordId: 'provider_record_1',
    stepId: 'pipeline_enrich:decision_maker_reveal',
    provider: result.provider,
    usage: result.usage,
  });
  const record = db.prepare('SELECT cost_ledger_json, enrichment_cost_usd FROM records WHERE _row_id = ?')
    .get('provider_record_1');
  assert.equal(Number(record.enrichment_cost_usd), 0.05);
  assert.equal(JSON.parse(record.cost_ledger_json).entries[0].amount_usd, 0.05);
  db.close();
});

test('masked discovery never invents an identity or makes email reachable', async () => {
  const masked = candidate({ provider_candidate_id: 'masked_1', title: 'Owner', seniority: 'owner' });
  const result = await executeDecisionMakersAction({
    listDir: '',
    stepId: 'decision_maker_discovery',
    stepConfig: { action: 'decision_makers', mode: 'discovery' },
    record: { domain: 'example.test' },
    decisionMakerProvider: {
      id: 'test-provider',
      search: async () => ({ candidates: [masked], provider_payloads: [{ people: [{ title: 'Owner' }] }] }),
      reveal: async () => ({ contact: masked, provider_payloads: [] }),
    },
  });

  assert.equal(result.outputs.decision_maker_exists, true);
  assert.equal(result.outputs.decision_maker_name, '');
  assert.equal(result.outputs.decision_maker_email, '');
  assert.equal(result.outputs.decision_maker_confidence, 0);
  const email = evaluateReachability({
    contact_email: result.outputs.decision_maker_email,
    email_verification_status: '',
  }).channels.find((channel) => channel.channel === 'email');
  assert.equal(email.ready, false);
});

// Live provider candidate shape (source_organization already present in the blob).
const liveRevealCandidateShape = (overrides = {}) => candidate({
  provider_candidate_id: 'person_host_1',
  first_name: 'Kaja',
  last_name: 'Perina',
  name: 'Kaja Perina',
  title: 'Editor in Chief',
  email: 'kaja@psychologytoday.com',
  phone: '',
  seniority: 'executive',
  department: 'editorial',
  linkedin: 'https://linkedin.com/in/kaja',
  confidence: 95,
  source_domain: 'psychologytoday.com',
  source_organization: 'Psychology Today',
  source: 'apollo',
  source_query: 'psychologytoday.com',
  email_verification_status: 'verified',
  email_verification_confidence: 100,
  ...overrides,
});

test('reveal promotes candidate source_organization to decision_maker_organization and leaves the rest of the family unchanged', async () => {
  const { db, listDir } = createListDb();
  const revealed = liveRevealCandidateShape();
  const provider = {
    id: 'test-provider',
    search: async () => ({ candidates: [], provider_payloads: [] }),
    reveal: async () => ({
      contact: revealed,
      provider_payloads: [{ person: { email: revealed.email, organization: { name: revealed.source_organization } } }],
    }),
  };

  const result = await executeDecisionMakersAction({
    db,
    listDir,
    stepId: 'decision_maker_reveal',
    stepConfig: {
      action: 'decision_makers',
      mode: 'reveal',
      // Mirror pipeline remapping used for decision_maker_reveal_* declared outputs.
      output_fields: {
        decision_maker_name: 'decision_maker_reveal_name',
        decision_maker_title: 'decision_maker_reveal_title',
        decision_maker_email: 'decision_maker_reveal_email',
        decision_maker_organization: 'decision_maker_reveal_organization',
        decision_maker_seniority: 'decision_maker_reveal_seniority',
        decision_maker_linkedin: 'decision_maker_reveal_linkedin',
      },
    },
    record: {
      _row_id: 'provider_record_1',
      domain: 'psychologytoday.com',
      business_name: 'Anchor Counseling LLC',
      decision_maker_candidates: JSON.stringify([liveRevealCandidateShape({
        email: '',
        email_verification_status: '',
        email_verification_confidence: 0,
      })]),
    },
    decisionMakerProvider: provider,
  });

  // Additive: organization is a first-class declared output (remapped like title).
  assert.equal(result.outputs.decision_maker_reveal_organization, 'Psychology Today');
  // CONTROL: existing family fields land exactly as before.
  assert.equal(result.outputs.decision_maker_reveal_name, 'Kaja Perina');
  assert.equal(result.outputs.decision_maker_reveal_title, 'Editor in Chief');
  assert.equal(result.outputs.decision_maker_reveal_email, 'kaja@psychologytoday.com');
  assert.equal(result.outputs.decision_maker_reveal_seniority, 'executive');
  assert.equal(result.outputs.decision_maker_reveal_linkedin, 'https://linkedin.com/in/kaja');
  db.close();
});

test('reveal leaves decision_maker_organization empty when the candidate has no source_organization (no domain fallback)', async () => {
  const { db, listDir } = createListDb();
  const revealed = liveRevealCandidateShape({
    first_name: 'Avery',
    last_name: 'Nguyen',
    name: 'Avery Nguyen',
    title: 'Owner',
    email: 'avery@example.test',
    source_domain: 'example.test',
    source_organization: '',
    source_query: 'example.test',
  });
  const provider = {
    id: 'test-provider',
    search: async () => ({ candidates: [], provider_payloads: [] }),
    reveal: async () => ({
      contact: revealed,
      provider_payloads: [{ person: { email: revealed.email } }],
    }),
  };

  const result = await executeDecisionMakersAction({
    db,
    listDir,
    stepId: 'decision_maker_reveal',
    stepConfig: { action: 'decision_makers', mode: 'reveal' },
    record: {
      _row_id: 'provider_record_1',
      domain: 'example.test',
      business_name: 'Example Test',
      decision_maker_candidates: JSON.stringify([candidate({
        source_organization: '',
        email: '',
      })]),
    },
    decisionMakerProvider: provider,
  });

  assert.equal(result.outputs.decision_maker_organization, '');
  // CONTROL: name/title/email still land.
  assert.equal(result.outputs.decision_maker_name, 'Avery Nguyen');
  assert.equal(result.outputs.decision_maker_title, 'Owner');
  assert.equal(result.outputs.decision_maker_email, 'avery@example.test');
  // Must not invent organization from domain.
  assert.notEqual(result.outputs.decision_maker_organization, 'example.test');
  db.close();
});

test('discovery surfaces source_organization on decision_maker_organization from the first candidate', async () => {
  const discovered = liveRevealCandidateShape({
    email: '',
    email_verification_status: '',
    email_verification_confidence: 0,
    confidence: 0,
  });
  const result = await executeDecisionMakersAction({
    listDir: '',
    stepId: 'decision_maker_discovery',
    stepConfig: { action: 'decision_makers', mode: 'discovery' },
    record: { domain: 'psychologytoday.com', business_name: 'Anchor Counseling LLC' },
    decisionMakerProvider: {
      id: 'test-provider',
      search: async () => ({
        candidates: [discovered],
        provider_payloads: [{ people: [{ title: discovered.title, organization: { name: 'Psychology Today' } }] }],
      }),
      reveal: async () => ({ contact: discovered, provider_payloads: [] }),
    },
  });

  assert.equal(result.outputs.decision_maker_organization, 'Psychology Today');
  // Discovery still does not invent a name/email; organization is the only identity-adjacent fact.
  assert.equal(result.outputs.decision_maker_name, '');
  assert.equal(result.outputs.decision_maker_email, '');
  assert.equal(result.outputs.decision_maker_title, 'Editor in Chief');
});

test('Hunter continues to satisfy the same provider interface', async () => {
  const mcp = {
    callTool: async () => ({
      structuredContent: {
        data: {
          results: [{
            response: {
              data: {
                data: {
                  organization: 'Example Test',
                  domain: 'example.test',
                  emails: [{
                    value: 'owner@example.test',
                    first_name: 'Avery',
                    last_name: 'Nguyen',
                    position: 'Owner',
                    seniority: 'executive',
                  }],
                },
              },
            },
          }],
        },
      },
    }),
  };
  const provider = new HunterDecisionMakerProvider({ mcp });
  const result = await provider.search({
    domain: 'example.test',
    seniorities: ['executive'],
    limit: 10,
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].email, 'owner@example.test');
  assert.equal(result.candidates[0].source, 'hunter');
});
