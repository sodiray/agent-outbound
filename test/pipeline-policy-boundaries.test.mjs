import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import { processInboundReplyText } from '../dist/orchestrator/runtime/inbound-reply-process.js';
import { openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { checkAnnualCampaignLimit, checkContactAllowance } from '../dist/orchestrator/policy/campaign-process.js';
import { evaluateOutboundReadiness } from '../dist/orchestrator/policy/readiness.js';
import { isPhoneAttemptCeilingReached } from '../dist/orchestrator/policy/phone-attempt.js';
import { shouldExecuteSequenceOutbound } from '../dist/orchestrator/policy/sequence-outbound.js';

const classifier = {
  model: 'test/reply-classifier',
  prompt: 'Classify the inbound reply. Reply: {{reply_text}}',
  output: {
    classifications: ['withdrawn', 'needs_review'],
    opt_out_classifications: ['withdrawn'],
  },
};

const createInboundDb = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-inbound-policy-'));
  const db = openListDb({ listDir, readonly: false });
  upsertRecord({
    db,
    row: {
      _row_id: 'inbound-policy-record',
      email_primary: 'person@example.com',
      sequence_status: 'active',
      account_sequence_state: 'active',
      lifecycle_stage: 'contacted',
    },
  });
  return db;
};

test('inbound reply classification uses the pipeline-declared classifier and opt-out meaning', async () => {
  const db = createInboundDb();
  const prompts = [];
  try {
    const result = await processInboundReplyText({
      db,
      recordId: 'inbound-policy-record',
      replyText: 'a phrase with no engine keyword',
      classifier,
      generate: async (input) => {
        prompts.push(input.prompt);
        return { object: { classification: 'withdrawn', reason: 'Pipeline-defined intent.' } };
      },
    });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('inbound-policy-record');
    assert.equal(result.sequence_status, 'opted_out');
    assert.equal(Number(record.suppressed), 1);
    assert.equal(record.suppressed_reason, 'opt_out');
    assert.match(prompts[0], /a phrase with no engine keyword/);
  } finally {
    db.close();
  }
});

test('inbound classification failure is recorded and leaves outbound paused', async () => {
  const db = createInboundDb();
  try {
    await assert.rejects(
      processInboundReplyText({
        db,
        recordId: 'inbound-policy-record',
        replyText: 'ambiguous reply',
        classifier,
        generate: async () => { throw new Error('classifier unavailable'); },
      }),
      /Inbound reply classification failed/,
    );
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('inbound-policy-record');
    const event = db.prepare('SELECT * FROM channel_events WHERE row_id = ? AND action = ?').get(
      'inbound-policy-record',
      'reply_classification_failed',
    );
    assert.equal(record.account_sequence_state, 'paused_inbound');
    assert.equal(Number(record.inbound_pending_human_review), 1);
    assert.match(record.inbound_classification_error, /classifier unavailable/);
    assert.ok(event);
    const outboundGate = shouldExecuteSequenceOutbound(record, '2026-08-08T00:00:00.000Z', {
      channel: 'email',
      stepKind: 'send_email',
    });
    assert.equal(outboundGate.execute, false);
    assert.match(outboundGate.reason, /paused_inbound/);
  } finally {
    db.close();
  }
});

test('inbound-capable pipelines require a declared reply classifier', () => {
  const missing = normalizeConfig({
    sequences: { default: { reply_check: { tool: { list_tool: 'INBOX' } }, steps: [] } },
  });
  assert.match(missing.errors.join('\n'), /classifier/i);
  const declared = normalizeConfig({
    sequences: { default: { reply_check: { tool: { list_tool: 'INBOX' }, classifier }, steps: [] } },
  });
  assert.deepEqual(declared.errors, []);
});

test('configured IMAP inboxes require a reply classifier', () => {
  const missing = normalizeConfig({ mailboxes: { file: 'mailboxes.yaml' } });
  assert.match(missing.errors.join('\n'), /reply_check\.classifier/i);
  const declared = normalizeConfig({
    mailboxes: { file: 'mailboxes.yaml' },
    sequences: { default: { reply_check: { tool: { list_tool: 'INBOX' }, classifier }, steps: [] } },
  });
  assert.deepEqual(declared.errors, []);
});

test('inbound reply handling honors classifier output over a keyword fallback', async () => {
  const db = createInboundDb();
  try {
    const result = await processInboundReplyText({
      db,
      recordId: 'inbound-policy-record',
      replyText: 'Please stop emailing me.',
      classifier,
      generate: async () => ({
        object: { classification: 'needs_review', reason: 'Needs a human decision.' },
      }),
    });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('inbound-policy-record');
    assert.equal(result.classification, 'needs_review');
    assert.equal(record.account_sequence_state, 'paused_inbound');
    assert.equal(Number(record.suppressed), 0);
  } finally {
    db.close();
  }
});

test('undeclared tier names inherit no contact cadence or limits', () => {
  const config = normalizeConfig({}).config.contact_policy;
  assert.deepEqual(config.per_contact_allowances, {});
  assert.deepEqual(config.campaign.max_age_business_days, {});
  assert.equal(checkContactAllowance({
    treatment_tier: 'priority_customer',
    automated_actions_used: 999,
    contactPolicy: config,
  }).allowed, true);
  assert.equal(checkAnnualCampaignLimit({
    campaigns_in_last_12_months: 999,
    contactPolicy: config,
  }).allowed, true);
});

test('tier names are opaque: D and custom tiers inherit no channel strategy', () => {
  const base = {
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    channels: { phone: { ready: true, confidence: 90 } },
    contentReady: true,
    withinBudget: true,
    hasNextAction: true,
    proposedAction: { channel: 'phone', kind: 'manual_task' },
  };
  for (const treatmentTier of ['platinum', 'gold', 'bronze', 'D']) {
    assert.equal(evaluateOutboundReadiness({ ...base, treatmentTier }).ready, true, treatmentTier);
    assert.equal(isPhoneAttemptCeilingReached({ treatment_tier: treatmentTier, call_attempt_count: 999 }), false, treatmentTier);
  }
});

test('declared opaque tier channel permissions and phone caps are enforced', () => {
  const contactPolicy = {
    tiers: { platinum: { permitted_channels: ['email'] } },
    phone: { max_attempts: { platinum: 1 } },
  };
  const readiness = evaluateOutboundReadiness({
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    treatmentTier: 'platinum',
    channels: { phone: { ready: true, confidence: 90 } },
    contentReady: true,
    withinBudget: true,
    hasNextAction: true,
    contactPolicy,
    proposedAction: { channel: 'phone', kind: 'manual_task' },
  });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.includes('tier_channel_not_permitted'));
  assert.equal(isPhoneAttemptCeilingReached(
    { treatment_tier: 'platinum', call_attempt_count: 1 },
    { maxAttemptsByTier: contactPolicy.phone.max_attempts },
  ), true);
});
