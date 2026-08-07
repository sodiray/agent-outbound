import { executeChannelStep } from '../channels/execute.js';
import {
  applyWorkingDaysFilterInTimezone,
  type NonWorkingDayPolicy,
  type SequenceWorkingDay,
} from '../lib/working-days.js';
import { resolveStepTemplate } from '../lib/templates.js';

const isBlank = (value: unknown) => (
  value === undefined || value === null || String(value).trim() === ''
);

const WAIT_UNIT_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

export const parseWaitDurationMs = (value: unknown) => {
  const raw = String(value || '').trim().toLowerCase();
  const match = raw.match(/^((?:\d+(?:\.\d+)?|\.\d+))([dhw])$/);
  if (!match) {
    throw new Error(`Invalid wait duration "${raw}". Use a positive duration in d, h, or w (for example, 3d).`);
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid wait duration "${raw}". The duration must be greater than zero.`);
  }
  return amount * WAIT_UNIT_MS[match[2]];
};

export const computeWaitWakeAt = ({
  anchorAt,
  after,
  workingDays,
  policy,
  timeZone,
}: {
  anchorAt: string;
  after: string;
  workingDays: SequenceWorkingDay[];
  policy: NonWorkingDayPolicy;
  timeZone?: string;
}): { wakeAt: string; shifted: boolean; skipped: boolean } => {
  const anchor = new Date(String(anchorAt || ''));
  if (Number.isNaN(anchor.getTime())) throw new Error(`Invalid wait anchor "${anchorAt}".`);
  const unadjusted = new Date(anchor.getTime() + parseWaitDurationMs(after));
  const unadjustedIso = unadjusted.toISOString();
  const adjusted = applyWorkingDaysFilterInTimezone({
    isoDate: unadjustedIso.slice(0, 10),
    workingDays,
    policy,
    timeZone,
  });
  if ('skip' in adjusted) {
    return {
      wakeAt: anchor.toISOString(),
      shifted: false,
      skipped: true,
    };
  }
  return {
    wakeAt: `${adjusted.date}${unadjustedIso.slice(10)}`,
    shifted: adjusted.shifted,
    skipped: false,
  };
};

export const executePipelineSequenceAction = async ({
  db,
  record,
  config,
  step,
  ...options
}: {
  db: unknown;
  record: Record<string, unknown>;
  config?: unknown;
  step: Record<string, unknown>;
  [key: string]: unknown;
}) => {
  const template = resolveStepTemplate({ config, step, record });
  const stepConfig = step.config && typeof step.config === 'object'
    ? step.config as Record<string, unknown>
    : {};
  const existingArgs = stepConfig.args && typeof stepConfig.args === 'object'
    ? stepConfig.args as Record<string, unknown>
    : {};
  // Merge rendered template copy into args so deterministic tool_call sends
  // (SMTP etc.) use the operator's template — not a generic sink default body.
  // Explicit non-empty args.subject/body still win (operator override).
  const mergedArgs = template
    ? {
        ...existingArgs,
        ...(isBlank(existingArgs.subject) && template.subject
          ? { subject: template.subject }
          : {}),
        ...(isBlank(existingArgs.body) && template.body
          ? { body: template.body }
          : {}),
      }
    : existingArgs;
  const executableStep = template
    ? {
        ...step,
        description: template.rendered_description || String(step.description || ''),
        config: {
          ...stepConfig,
          args: mergedArgs,
          template_context: {
            template_id: template.template_id,
            template_version: template.template_version,
            subject: template.subject,
            body: template.body,
            variables: template.variables,
          },
        },
      }
    : step;
  return executeChannelStep({
    ...options,
    db,
    record,
    step: executableStep,
  });
};
