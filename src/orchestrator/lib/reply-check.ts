type ConfigRecord = Record<string, unknown>;

const asRecord = (value: unknown): ConfigRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as ConfigRecord
    : {}
);

const text = (value: unknown) => String(value || '').trim();

const sequencesFor = (config: unknown) => asRecord(asRecord(config).sequences);

export const replyCheckSequenceForRecord = ({
  config,
  record,
}: {
  config: unknown;
  record: ConfigRecord;
}): string => {
  const sequences = sequencesFor(config);
  const sequenceName = text(record.sequence_name) || 'default';
  const sequence = asRecord(sequences[sequenceName]);
  return Object.prototype.hasOwnProperty.call(sequence, 'reply_check')
    ? sequenceName
    : 'default';
};

export const resolveReplyCheck = ({
  config,
  sequenceName,
}: {
  config: unknown;
  sequenceName: unknown;
}): ConfigRecord => {
  const sequences = sequencesFor(config);
  const name = text(sequenceName) || 'default';
  const sequence = asRecord(sequences[name]);
  if (Object.prototype.hasOwnProperty.call(sequence, 'reply_check')) {
    return asRecord(sequence.reply_check);
  }
  return asRecord(asRecord(sequences.default).reply_check);
};

export const replyCheckSequenceNames = ({ config }: { config: unknown }): string[] => {
  const sequences = sequencesFor(config);
  const names = Object.entries(sequences)
    .filter(([name, sequence]) => (
      text(name) !== 'default'
      && Object.prototype.hasOwnProperty.call(asRecord(sequence), 'reply_check')
    ))
    .map(([name]) => text(name))
    .filter(Boolean);
  return ['default', ...names];
};
