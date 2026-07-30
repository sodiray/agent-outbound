import { executeChannelStep } from '../channels/execute.js';
import {
  applyWorkingDaysFilter,
  type NonWorkingDayPolicy,
  type SequenceWorkingDay,
} from '../lib/working-days.js';
import { getRecordRowId } from '../lib/record.js';
import { resolveStepTemplate } from '../lib/templates.js';
import { upsertRecord } from '../runtime/db.js';

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
}: {
  anchorAt: string;
  after: string;
  workingDays: SequenceWorkingDay[];
  policy: NonWorkingDayPolicy;
}): { wakeAt: string; shifted: boolean; skipped: boolean } => {
  const anchor = new Date(String(anchorAt || ''));
  if (Number.isNaN(anchor.getTime())) throw new Error(`Invalid wait anchor "${anchorAt}".`);
  const unadjusted = new Date(anchor.getTime() + parseWaitDurationMs(after));
  const unadjustedIso = unadjusted.toISOString();
  const adjusted = applyWorkingDaysFilter({
    isoDate: unadjustedIso.slice(0, 10),
    workingDays,
    policy,
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

type PipelineActionDb = {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
  };
};

const LEGACY_SEQUENCE_STATE_FIELDS = [
  'sequence_name',
  'sequence_status',
  'sequence_step',
  'sequence_step_attempts',
  'next_action_date',
  'launched_at',
] as const;

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
  const actionDb = db as PipelineActionDb;
  const template = resolveStepTemplate({ config, step, record });
  const stepConfig = step.config && typeof step.config === 'object'
    ? step.config as Record<string, unknown>
    : {};
  const executableStep = template
    ? {
        ...step,
        description: template.rendered_description || String(step.description || ''),
        config: {
          ...stepConfig,
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
  const legacySequenceState = Object.fromEntries(
    LEGACY_SEQUENCE_STATE_FIELDS.map((field) => [field, record[field]]),
  );
  const result = await executeChannelStep({
    ...options,
    db: actionDb,
    record,
    step: executableStep,
  });
  const recordId = getRecordRowId(record);
  const persisted = actionDb.prepare('SELECT * FROM records WHERE _row_id = ? LIMIT 1').get(recordId);
  if (persisted) {
    upsertRecord({
      db: actionDb,
      row: {
        ...persisted,
        ...legacySequenceState,
      },
    });
  }
  return result;
};
