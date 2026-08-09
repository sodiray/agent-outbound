import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import { completeManualTask } from '../dist/orchestrator/pipeline/manual.js';
import { assignTreatmentAndMail } from '../dist/orchestrator/policy/treatment.js';
import { buildContactPlan } from '../dist/orchestrator/policy/contact-campaign.js';
import { ensureRecordColumns, openListDb } from '../dist/orchestrator/runtime/db.js';

const strategyFor = (product) => ({
  bands: {
    fit: [0, 50, 65, 80, 100],
    fit_evidence_confidence: [0, 40, 60, 80, 100],
  },
  matrix: Array.from({ length: 4 }, () => ['qualified', 'qualified', 'qualified', 'qualified']),
  unscored_tier: 'research',
  tiers: {
    qualified: { route: 'outbound', mail_programs: [product] },
    research: { route: 'enrichment', holding: true },
  },
  mail_programs: {
    [product]: {
      priority: 10,
      cost_cents: 175,
      template_id: `${product}_template`,
      provider: 'mail_fixture',
      format: 'parcel',
      content_field: 'mail_copy',
      minimums: {
        fit_score: 78,
        fit_evidence_confidence: 80,
        identity_confidence: 80,
        classification_confidence: 85,
      },
      requirements: { mail_address_ready: true, unsuppressed: true },
    },
  },
});

const eligibleInput = (product) => ({
  fitScore: 79,
  fitEvidenceConfidence: 100,
  identityConfidence: 100,
  classificationConfidence: 92,
  mailAddressReady: true,
  suppressed: false,
  treatmentStrategy: strategyFor(product),
});

const pipelineConfig = (product) => ({
  pipeline: [{
    kind: 'manual_task',
    id: 'deliver_product',
    config: { channel: 'mail', task_type: product },
  }],
  score: { treatment: strategyFor(product) },
  channels: { mail: {} },
});

const createMailFixture = ({ product, mailTreatment = product, record = {} }) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-mail-products-'));
  writeFileSync(join(listDir, 'outbound.yaml'), 'list: { name: mail-products }\npipeline: []\nscore: { criteria: [] }\n');
  writeFileSync(join(listDir, 'operator.md'), 'mail products');
  writeFileSync(join(listDir, 'mcp.json'), '{}');
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const campaign = buildContactPlan({
    account_id: 'mail-product-record',
    campaign_id: `campaign-${product}`,
    contacts: [{ contact_id: 'contact-1', outbound_disposition: 'eligible_target', outreach_rank: 1 }],
    treatment_tier: 'qualified',
    mail_treatment: mailTreatment,
  });
  const row = {
    _row_id: 'mail-product-record',
    business_name: 'Product Recipient',
    contact_name: 'Product Recipient',
    address: '1 Main St',
    city: 'Boise',
    state: 'ID',
    zip: '83702',
    active_contact_id: 'contact-1',
    contact_id: 'contact-1',
    mail_treatment: mailTreatment,
    mail_address_ready: 1,
    account_contact_plan_json: JSON.stringify(campaign),
    account_sequence_state: 'active',
    sequence_status: 'active',
    next_action_json: JSON.stringify({ action_type: 'prepare_outbound' }),
    mail_copy: 'A declared product has declared content.',
    created_at: now,
    updated_at: now,
    ...record,
  };
  ensureRecordColumns({ db, columns: Object.keys(row) });
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO records (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...columns.map((column) => row[column]));
  db.prepare(`
    INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
    VALUES ('mail-product-park', 'mail-product-record', 'deliver_product', 'manual_task', 0, 'awaiting_manual', ?)
  `).run(now);
  return { db, listDir };
};

const acceptingProvider = (requests) => ({
  name: 'mail_fixture',
  submit: async (request) => {
    requests.push(request);
    return {
      ok: true,
      piece_id: `piece-${request.treatment}`,
      status: 'submitted',
      reason: 'accepted',
      cost_cents: request.expected_cost_cents,
      provider: 'mail_fixture',
    };
  },
  getStatus: async () => ({ piece_id: '', status: 'unknown', reason: '', provider: 'mail_fixture' }),
});

test('pipeline-declared mail products validate by shape and their declared minimums select eligibility', () => {
  const product = 'sponsor_kit';
  const valid = normalizeConfig({ score: { treatment: strategyFor(product) } });
  assert.deepEqual(valid.errors, []);
  const malformed = normalizeConfig({
    score: { treatment: { ...strategyFor(product), mail_programs: { [product]: { unknown_attribute: true } } } },
  });
  assert.ok(malformed.errors.length > 0);

  const eligible = assignTreatmentAndMail(eligibleInput(product));
  assert.equal(eligible.mail_treatment, product);
  assert.equal(eligible.mail_program_eligible, true);
  const belowMinimum = assignTreatmentAndMail({ ...eligibleInput(product), fitScore: 77 });
  assert.equal(belowMinimum.mail_treatment, 'none');
  assert.equal(belowMinimum.mail_program_eligible, false);
});

test('two pipelines with different mail product vocabularies complete their declared products', async () => {
  const products = ['sponsor_kit', 'sample_box'];
  const results = await Promise.all(products.map(async (product) => {
    const requests = [];
    const fixture = createMailFixture({ product });
    const result = await completeManualTask({
      db: fixture.db,
      listDir: fixture.listDir,
      config: pipelineConfig(product),
      recordId: 'mail-product-record',
      stepId: 'deliver_product',
      mailProvider: acceptingProvider(requests),
    });
    fixture.db.close();
    return { result, request: requests[0] };
  }));

  assert.ok(results.every(({ request }) => request), JSON.stringify(results));
  assert.deepEqual(results.map(({ request }) => request.treatment), products);
  assert.deepEqual(results.map(({ request }) => request.expected_cost_cents), [175, 175]);
  assert.ok(results.every(({ result }) => result.mail_provider_status === 'submitted'));
});

test('declared mail products retain permission, address, suppression, and DNC gates', async () => {
  const product = 'sponsor_kit';
  const noPermission = createMailFixture({ product, mailTreatment: 'none' });
  await assert.rejects(
    () => completeManualTask({
      db: noPermission.db,
      config: pipelineConfig(product),
      recordId: 'mail-product-record',
      stepId: 'deliver_product',
    }),
    /no mail permission/i,
  );
  noPermission.db.close();

  const noAddress = createMailFixture({ product, record: { mail_address_ready: 0 } });
  await assert.rejects(
    () => completeManualTask({
      db: noAddress.db,
      config: pipelineConfig(product),
      recordId: 'mail-product-record',
      stepId: 'deliver_product',
    }),
    /mail_address_not_ready/i,
  );
  noAddress.db.close();

  const suppressed = createMailFixture({ product, record: { mail_suppressed: 1 } });
  await assert.rejects(
    () => completeManualTask({
      db: suppressed.db,
      config: pipelineConfig(product),
      recordId: 'mail-product-record',
      stepId: 'deliver_product',
      mailProvider: acceptingProvider([]),
    }),
    /mail_suppressed/i,
  );
  suppressed.db.close();

  const dnc = createMailFixture({ product, record: { suppressed: 1, suppressed_reason: 'crm_dnc' } });
  await assert.rejects(
    () => completeManualTask({
      db: dnc.db,
      config: pipelineConfig(product),
      recordId: 'mail-product-record',
      stepId: 'deliver_product',
      mailProvider: acceptingProvider([]),
    }),
    /record_suppressed/i,
  );
  dnc.db.close();
});
