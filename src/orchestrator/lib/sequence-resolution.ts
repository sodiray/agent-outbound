import { AgentOutboundError } from '../runtime/contract.js';
import { subpipelineDefinitions } from './subpipelines.js';

type ConfigRecord = Record<string, unknown>;

export type ConfiguredSequence = {
  name: string;
  kind: 'sequencer' | 'pipeline';
  definition: ConfigRecord;
};

const asRecord = (value: unknown): ConfigRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as ConfigRecord
    : {}
);

const text = (value: unknown) => String(value || '').trim();

const sequencerDefinitions = (config: unknown): ConfiguredSequence[] => {
  const sequences = asRecord(asRecord(config).sequences);
  return Object.entries(sequences)
    .map(([name, definition]) => ({ name: text(name), definition: asRecord(definition) }))
    .filter((entry) => Boolean(entry.name))
    .map((entry) => ({ ...entry, kind: 'sequencer' as const }));
};

const pipelineDefinitions = (config: unknown): ConfiguredSequence[] => (
  subpipelineDefinitions(config)
    .map((definition) => ({
      name: text(definition.id),
      definition,
      kind: 'pipeline' as const,
    }))
    .filter((entry) => Boolean(entry.name))
);

const candidatesForName = ({ config, name }: { config: unknown; name: string }) => (
  [...sequencerDefinitions(config), ...pipelineDefinitions(config)]
    .filter((entry) => entry.name === name)
);

export const listConfiguredSequences = ({ config }: { config: unknown }): string[] => (
  [...new Set([
    ...sequencerDefinitions(config).map((entry) => entry.name),
    ...pipelineDefinitions(config).map((entry) => entry.name),
  ])].sort()
);

const unavailableSequenceError = ({ name, available }: { name: string; available: string[] }) => (
  new AgentOutboundError({
    code: 'NOT_FOUND',
    message: `Unknown sequence "${name}". Available sequences: ${available.join(', ') || '(none)'}.`,
    retryable: false,
    fields: {
      requested_sequence: name,
      available_sequences: available,
    },
  })
);

const ambiguousSequenceError = ({ name, available }: { name: string; available: string[] }) => (
  new AgentOutboundError({
    code: 'INVALID_ARGUMENT',
    message: `Ambiguous sequence "${name}" is defined as both a sequencer and a pipeline. Rename one definition. Available sequences: ${available.join(', ') || '(none)'}.`,
    retryable: false,
    fields: {
      requested_sequence: name,
      available_sequences: available,
    },
  })
);

export const resolveConfiguredSequence = ({
  config,
  name,
}: {
  config: unknown;
  name: unknown;
}): ConfiguredSequence => {
  const requested = text(name);
  const available = listConfiguredSequences({ config });
  const candidates = candidatesForName({ config, name: requested });
  if (candidates.length === 0) throw unavailableSequenceError({ name: requested, available });
  if (candidates.length > 1) throw ambiguousSequenceError({ name: requested, available });
  return candidates[0];
};

export const resolveSequencerSequence = ({
  config,
  name,
}: {
  config: unknown;
  name: unknown;
}): ConfigRecord => {
  const resolved = resolveConfiguredSequence({ config, name });
  if (resolved.kind === 'sequencer') return resolved.definition;
  throw new AgentOutboundError({
    code: 'INVALID_ARGUMENT',
    message: `Sequence "${resolved.name}" is a pipeline and must be run through the configured sequence runner.`,
    retryable: false,
    fields: {
      requested_sequence: resolved.name,
      sequence_kind: resolved.kind,
      available_sequences: listConfiguredSequences({ config }),
    },
  });
};

export const pipelineNameForRecord = ({
  config,
  record,
}: {
  config: unknown;
  record: Record<string, unknown>;
}): string => {
  const pipelineName = text(record.pipeline_name);
  const sequenceName = text(record.sequence_name);
  const configuredPipelineNames = new Set(
    pipelineDefinitions(config).map((entry) => entry.name),
  );
  if (configuredPipelineNames.has(pipelineName)) return pipelineName;
  if ((!pipelineName || pipelineName === 'default') && configuredPipelineNames.has(sequenceName)) {
    return sequenceName;
  }
  return '';
};

export const recordUsesPipelineSequence = ({
  config,
  record,
}: {
  config: unknown;
  record: Record<string, unknown>;
}) => Boolean(pipelineNameForRecord({ config, record }));
