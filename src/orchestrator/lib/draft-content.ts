import { createHash } from 'node:crypto';
import { flattenPipelineSteps } from './subpipelines.js';
import { resolveStepTemplate } from './templates.js';

type DraftContent = {
  subject: string;
  body: string;
  contentHash: string;
  templateId: string;
  templateVersion: number | null;
};

type DraftContentResolution =
  | { ok: true; content: DraftContent }
  | { ok: false; reason: string };

const isBlank = (value: unknown): boolean => (
  value === undefined || value === null || String(value).trim() === ''
);

const firstContentValue = (...values: unknown[]): string => {
  const value = values.find((candidate) => !isBlank(candidate));
  return value === undefined ? '' : String(value);
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const resolveToolCallArguments = ({
  stepConfig,
  record,
}: {
  stepConfig: Record<string, unknown>;
  record: Record<string, unknown>;
}): Record<string, unknown> => {
  const args = asRecord(stepConfig.args);
  const argsMap = asRecord(stepConfig.args_map);
  return Object.entries(argsMap).reduce<Record<string, unknown>>(
    (resolved, [argName, fieldName]) => {
      const value = record[String(fieldName || '').trim()];
      return isBlank(value) ? resolved : { ...resolved, [argName]: value };
    },
    { ...args },
  );
};

const configuredSequenceStep = ({
  config,
  sequenceName,
  stepId,
}: {
  config: Record<string, unknown>;
  sequenceName: string;
  stepId: string;
}): Record<string, unknown> | null => {
  const sequences = asRecord(config.sequences);
  const sequence = asRecord(sequences[sequenceName]);
  const steps = Array.isArray(sequence.steps) ? sequence.steps : [];
  const step = steps.find((candidate) => (
    asRecord(candidate).id === stepId
  ));
  if (step) return asRecord(step);
  const pipelineStep = flattenPipelineSteps(config).find((candidate) => (
    String(candidate.id || '') === stepId
  ));
  return pipelineStep || null;
};

export const hashRenderedOutboundContent = ({
  subject,
  body,
}: {
  subject: unknown;
  body: unknown;
}): string => createHash('sha256')
  .update(JSON.stringify({ subject: String(subject || ''), body: String(body || '') }))
  .digest('hex');

export const renderCurrentEmailDraftContent = ({
  config,
  record,
  sequenceName,
  stepId,
  fallbackStep,
}: {
  config: Record<string, unknown>;
  record: Record<string, unknown>;
  sequenceName: string;
  stepId: string;
  fallbackStep?: Record<string, unknown> | null;
}): DraftContentResolution => {
  const step = configuredSequenceStep({ config, sequenceName, stepId }) || fallbackStep || null;
  if (!step) {
    return { ok: false, reason: `Configured sequence step "${stepId}" is unavailable.` };
  }
  if (String(step.kind || '').trim().toLowerCase() !== 'send_email') {
    return { ok: false, reason: `Configured step "${stepId}" is not an engine-managed email send.` };
  }
  const stepConfig = asRecord(step.config);
  if (String(stepConfig.action || '').trim().toLowerCase() !== 'tool_call') {
    return { ok: false, reason: `Configured step "${stepId}" cannot deterministically re-render email content.` };
  }
  const template = resolveStepTemplate({ config, step, record });
  const args = resolveToolCallArguments({ stepConfig, record });
  const subject = firstContentValue(args.subject, template?.subject);
  const body = firstContentValue(args.body, template?.body);
  if (isBlank(subject) || isBlank(body)) {
    return { ok: false, reason: `Configured step "${stepId}" rendered incomplete email content.` };
  }
  return {
    ok: true,
    content: {
      subject,
      body,
      contentHash: hashRenderedOutboundContent({ subject, body }),
      templateId: String(template?.template_id || ''),
      templateVersion: template ? Number(template.template_version || 0) || null : null,
    },
  };
};
