type LedgerDb = {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => unknown;
  };
};

type FirstTouchPolicy = {
  first_touch?: {
    suppress_sibling_sequence_channels?: unknown;
  };
};

type SequenceConfig = {
  steps?: unknown;
};

type PipelineConfig = {
  policy?: FirstTouchPolicy;
  sequences?: Record<string, SequenceConfig>;
};

const supportedChannels = new Set(['email', 'linkedin']);

const text = (value: unknown) => String(value ?? '').trim();

export const siblingFirstTouchChannels = (policy: FirstTouchPolicy | undefined): string[] => {
  const values = policy?.first_touch?.suppress_sibling_sequence_channels;
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => text(value).toLowerCase())
    .filter((channel) => supportedChannels.has(channel)))];
};

const configuredFirstStepIds = (config: PipelineConfig): string[] => (
  Object.values(config.sequences || {})
    .map((sequence) => Array.isArray(sequence?.steps) ? sequence.steps[0] : null)
    .map((step) => text((step as Record<string, unknown> | null)?.id))
    .filter(Boolean)
);

export const evaluateSiblingFirstTouch = ({
  db,
  config,
  recordId,
  sequenceName,
  stepNumber,
  channel,
}: {
  db: LedgerDb;
  config: PipelineConfig | undefined;
  recordId: string;
  sequenceName: string;
  stepNumber: number;
  channel: string | null;
}): { blocked: boolean; reason: string } => {
  const channels = siblingFirstTouchChannels(config?.policy);
  const candidateChannel = text(channel).toLowerCase();
  if (Number(stepNumber) !== 1 || !channels.includes(candidateChannel)) {
    return { blocked: false, reason: '' };
  }

  const legacyFirstStepIds = configuredFirstStepIds(config || {});
  const channelPlaceholders = channels.map(() => '?').join(', ');
  const legacyStepClause = legacyFirstStepIds.length > 0
    ? `OR (COALESCE(sequence_name, '') = '' AND step_id IN (${legacyFirstStepIds.map(() => '?').join(', ')}))`
    : '';
  try {
    const prior = db.prepare(`
      SELECT channel, step_id
      FROM live_interaction_ledger
      WHERE record_id = ?
        AND delivery_mode = 'live'
        AND status = 'accepted'
        AND lower(channel) IN (${channelPlaceholders})
        AND (
          (COALESCE(sequence_name, '') != '' AND sequence_name != ? AND step_number = 1)
          ${legacyStepClause}
        )
      ORDER BY datetime(occurred_at) DESC, ledger_id DESC
      LIMIT 1
    `).get(recordId, ...channels, sequenceName, ...legacyFirstStepIds) as Record<string, unknown> | undefined;
    if (!prior) return { blocked: false, reason: '' };
    return {
      blocked: true,
      reason: `sibling_first_touch_delivered:${text(prior.channel)}:${text(prior.step_id)}`,
    };
  } catch {
    return { blocked: true, reason: 'sibling_first_touch_ledger_unreadable' };
  }
};
