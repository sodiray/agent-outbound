import { getRecordRowId, nowIso } from '../../lib/record.js';
import { upsertContact } from '../../runtime/db.js';
import {
  resolveEmailVerificationProvider,
  type EmailVerificationProvider,
  type EmailVerificationResult,
} from '../../runtime/providers/email-verification/index.js';

type EmailVerificationActionInput = {
  db?: Parameters<typeof upsertContact>[0]['db'];
  stepId: string;
  stepConfig: Record<string, unknown>;
  record: Record<string, unknown>;
  emailVerificationProvider?: EmailVerificationProvider;
};

const text = (value: unknown) => String(value || '').trim();

const normalizedEmail = (value: unknown) => text(value).toLowerCase();

const normalizedStatus = (value: unknown) => text(value).toLowerCase();

const boundedConfidence = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
};

const unitCostUsd = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

const settledVerificationStatus = (value: unknown) => {
  const status = normalizedStatus(value);
  return Boolean(status) && !['pipeline_supplied', 'unchecked'].includes(status);
};

const persistedVerificationOutputs = (contact: Record<string, unknown>) => ({
  email_verification_status: text(contact.email_verification_status),
  email_verification_confidence: boundedConfidence(contact.email_verification_confidence),
  email_verification_reason: text(contact.email_verification_reason),
  email_verified_at: text(contact.email_verified_at),
});

const verificationUsage = ({ provider, usdCost }: { provider: string; usdCost: number }) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  usd_cost: usdCost,
  tool_calls: [`${provider}:email_verification`],
  tool_costs: [{ provider, slug: 'email_verification', usd_cost: usdCost }],
});

const validatedResult = (result: EmailVerificationResult) => {
  const status = normalizedStatus(result.status);
  if (!status || ['pipeline_supplied', 'unchecked'].includes(status)) {
    throw new Error('Email-verification provider returned no explicit verification status.');
  }
  return {
    status,
    confidence: boundedConfidence(result.confidence),
    reason: text(result.reason),
  };
};

export const executeEmailVerificationAction = async ({
  db,
  stepId,
  stepConfig,
  record,
  emailVerificationProvider,
}: EmailVerificationActionInput) => {
  if (!db) throw new Error('The email_verification enrichment action requires a database handle.');
  const field = text(stepConfig.field);
  const email = normalizedEmail(record[field]);
  if (!email) {
    return {
      outputs: {},
      artifacts: { skipped: true, reason: 'email_missing', field },
      usage: verificationUsage({ provider: text(stepConfig.provider), usdCost: 0 }),
      provider: text(stepConfig.provider),
    };
  }

  const recordId = getRecordRowId(record);
  const existing = db.prepare(`
    SELECT * FROM contacts
    WHERE row_id = ? AND lower(email) = ?
    LIMIT 1
  `).get(recordId, email) as Record<string, unknown> | undefined;
  if (existing && settledVerificationStatus(existing.email_verification_status)) {
    return {
      outputs: persistedVerificationOutputs(existing),
      artifacts: { skipped: true, reason: 'verification_settled', email },
      usage: verificationUsage({ provider: text(stepConfig.provider), usdCost: 0 }),
      provider: text(stepConfig.provider),
    };
  }

  const provider = emailVerificationProvider || resolveEmailVerificationProvider({
    provider: text(stepConfig.provider),
  });
  const providerResult = await provider.verify({ email });
  if (!providerResult) throw new Error(`Email-verification provider "${provider.id}" returned no result.`);
  const verification = validatedResult(providerResult);
  const verifiedAt = nowIso();
  upsertContact({
    db,
    contact: {
      ...(existing || {}),
      record_id: recordId,
      email,
      source: text(existing?.source) || 'pipeline',
      source_query: text(existing?.source_query) || `pipeline:${stepId}:${field}`,
      sourced_at: text(existing?.sourced_at) || verifiedAt,
      email_verification_status: verification.status,
      email_verification_confidence: verification.confidence,
      email_verification_reason: verification.reason,
      email_verified_at: verifiedAt,
    },
  });
  const contact = db.prepare(`
    SELECT * FROM contacts
    WHERE row_id = ? AND lower(email) = ?
    LIMIT 1
  `).get(recordId, email) as Record<string, unknown>;

  return {
    outputs: persistedVerificationOutputs(contact),
    artifacts: {
      email,
      status: verification.status,
      reason: verification.reason,
    },
    usage: verificationUsage({ provider: provider.id, usdCost: unitCostUsd(stepConfig.unit_cost_usd) }),
    provider: provider.id,
  };
};
