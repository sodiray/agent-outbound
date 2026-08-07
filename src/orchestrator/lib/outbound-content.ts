type ExplicitTextResolution = {
  ok: true;
  text: string;
  source: string;
} | {
  ok: false;
  reason: string;
};

const internalSourceFields = new Set([
  'description',
  'id',
  'label',
  'notes',
  'name',
  'reason',
  'error',
  'error_message',
]);

const text = (value: unknown): string => String(value ?? '').trim();

const isInternalSourceField = (value: unknown): boolean =>
  internalSourceFields.has(text(value).toLowerCase());

const missingContentReason = ({
  channel,
  stepId,
  fields,
}: {
  channel: string;
  stepId: string;
  fields: string[];
}): string =>
  `Outbound ${channel} content missing for step "${stepId}": configure ${fields.join(' and ')} from an explicit prospect-facing source.`;

/**
 * Resolve text only from an authored config value or an explicitly mapped record field.
 * Internal step/config metadata is categorically not an eligible source.
 */
export const resolveExplicitProspectText = ({
  channel,
  stepId,
  config,
  record,
  keys,
}: {
  channel: string;
  stepId: string;
  config?: Record<string, unknown> | null;
  record?: Record<string, unknown> | null;
  keys: string[];
}): ExplicitTextResolution => {
  const stepConfig = config || {};
  const args = stepConfig.args && typeof stepConfig.args === 'object' && !Array.isArray(stepConfig.args)
    ? stepConfig.args as Record<string, unknown>
    : {};
  const argsMap = stepConfig.args_map && typeof stepConfig.args_map === 'object' && !Array.isArray(stepConfig.args_map)
    ? stepConfig.args_map as Record<string, unknown>
    : {};
  const mappedInternalKey = keys.find((key) => isInternalSourceField(argsMap[key]));
  if (mappedInternalKey) {
    return {
      ok: false,
      reason: `Outbound ${channel} content for step "${stepId}" maps ${mappedInternalKey} from prohibited internal field "${text(argsMap[mappedInternalKey])}".`,
    };
  }

  for (const key of keys) {
    const configured = text(stepConfig[key]);
    if (configured) return { ok: true, text: configured, source: `step.config.${key}` };
  }
  for (const key of keys) {
    const configured = text(args[key]);
    if (configured) return { ok: true, text: configured, source: `step.config.args.${key}` };
  }
  for (const key of keys) {
    const mappedField = text(argsMap[key]);
    const composed = text(record?.[mappedField]);
    if (mappedField && composed) {
      return { ok: true, text: composed, source: `step.config.args_map.${key}` };
    }
  }
  return {
    ok: false,
    reason: missingContentReason({ channel, stepId, fields: keys }),
  };
};

/** Shared final gate immediately before a provider can receive outbound content. */
export const assertOutboundContent = ({
  channel,
  stepId,
  required,
}: {
  channel: string;
  stepId: string;
  required: Record<string, unknown>;
}): { ok: true } | { ok: false; reason: string } => {
  const missing = Object.entries(required)
    .filter(([, value]) => !text(value))
    .map(([field]) => field);
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    reason: missingContentReason({ channel, stepId, fields: missing }),
  };
};
