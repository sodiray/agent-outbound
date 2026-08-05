export const SEQUENCE_WORKING_DAY_VALUES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type SequenceWorkingDay = typeof SEQUENCE_WORKING_DAY_VALUES[number];

export const NON_WORKING_DAY_POLICY_VALUES = ['shift_forward', 'skip'] as const;
export type NonWorkingDayPolicy = typeof NON_WORKING_DAY_POLICY_VALUES[number];

const WEEKDAY_BY_UTC_INDEX: SequenceWorkingDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const normalizeWorkingDayToken = (value: any) => {
  if (typeof value !== 'string') return value;
  return value.trim().toLowerCase();
};

export const toIsoDate = (value: any) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
};

/**
 * Calendar date (YYYY-MM-DD) in an IANA timezone for an instant.
 * Used for Boise (America/Boise) wall-clock scheduling across DST.
 */
export const toZonedIsoDate = (value: string | Date, timeZone = 'America/Boise'): string => {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  // en-CA yields YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
};

/** Weekday token in IANA timezone (DST-aware). */
export const getWeekdayInTimezone = (
  isoDateOrInstant: string | Date,
  timeZone = 'America/Boise',
): SequenceWorkingDay => {
  const d = typeof isoDateOrInstant === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(isoDateOrInstant)
    ? new Date(`${isoDateOrInstant}T12:00:00.000Z`)
    : isoDateOrInstant instanceof Date
      ? isoDateOrInstant
      : new Date(isoDateOrInstant);
  const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(d);
  const map: Record<string, SequenceWorkingDay> = {
    Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat',
  };
  return map[short] || getUtcWeekday(toIsoDate(d));
};

/**
 * Apply working-days filter using wall clock in `timeZone` (default America/Boise).
 * Falls back to UTC weekday when timeZone is empty.
 */
export const applyWorkingDaysFilterInTimezone = ({
  isoDate,
  workingDays,
  policy,
  timeZone = 'America/Boise',
}: {
  isoDate: string;
  workingDays: SequenceWorkingDay[];
  policy: NonWorkingDayPolicy;
  timeZone?: string;
}): { date: string; shifted: boolean } | { skip: true } => {
  const allowed = new Set(workingDays || []);
  if (allowed.size === 0) throw new Error('working_days must include at least one day.');

  const weekdayOf = (day: string) =>
    timeZone ? getWeekdayInTimezone(day, timeZone) : getUtcWeekday(day);

  if (allowed.has(weekdayOf(isoDate))) {
    return { date: isoDate, shifted: false };
  }
  if (policy === 'skip') return { skip: true };

  for (let offset = 1; offset <= 14; offset += 1) {
    const candidate = addIsoDays(isoDate, offset);
    if (allowed.has(weekdayOf(candidate))) {
      return { date: candidate, shifted: true };
    }
  }
  throw new Error('Failed to resolve next working day in timezone.');
};

/** True when next_action_date is due relative to "today" in timezone. */
export const isActionDueInTimezone = ({
  nextActionDate,
  now,
  timeZone = 'America/Boise',
}: {
  nextActionDate: string;
  now: string | Date;
  timeZone?: string;
}): boolean => {
  const due = toIsoDate(nextActionDate);
  if (!due) return true;
  const today = toZonedIsoDate(now, timeZone);
  return due <= today;
};

export const addIsoDays = (isoDate: string, days: number) => {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
};

const getUtcWeekday = (isoDate: string): SequenceWorkingDay => {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  return WEEKDAY_BY_UTC_INDEX[date.getUTCDay()];
};

export const resolveWorkingDayConfig = (sequence: any): {
  workingDays: SequenceWorkingDay[];
  policy: NonWorkingDayPolicy;
} => {
  const inputDays = Array.isArray(sequence?.working_days) ? sequence.working_days : SEQUENCE_WORKING_DAY_VALUES;
  const valid = new Set(SEQUENCE_WORKING_DAY_VALUES);
  const workingDays = Array.from(new Set(
    inputDays
      .map((day: any) => normalizeWorkingDayToken(day))
      .filter((day: any) => valid.has(day as SequenceWorkingDay))
  )) as SequenceWorkingDay[];

  return {
    workingDays: workingDays.length > 0 ? workingDays : [...SEQUENCE_WORKING_DAY_VALUES],
    policy: sequence?.non_working_day_policy === 'skip' ? 'skip' : 'shift_forward',
  };
};

export const applyWorkingDaysFilter = ({
  isoDate,
  workingDays,
  policy,
}: {
  isoDate: string;
  workingDays: SequenceWorkingDay[];
  policy: NonWorkingDayPolicy;
}): { date: string; shifted: boolean } | { skip: true } => {
  const allowed = new Set(workingDays || []);
  if (allowed.size === 0) {
    throw new Error('working_days must include at least one day.');
  }

  if (allowed.has(getUtcWeekday(isoDate))) {
    return { date: isoDate, shifted: false };
  }

  if (policy === 'skip') return { skip: true };

  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = addIsoDays(isoDate, offset);
    if (allowed.has(getUtcWeekday(candidate))) {
      return { date: candidate, shifted: true };
    }
  }

  throw new Error('Failed to resolve next working day from working_days configuration.');
};

export const computeStepSchedule = ({
  launchedAtDate,
  dayOffset,
  workingDays,
  policy,
}: {
  launchedAtDate: string;
  dayOffset: number;
  workingDays: SequenceWorkingDay[];
  policy: NonWorkingDayPolicy;
}) => {
  const rawDate = addIsoDays(launchedAtDate, Number(dayOffset || 0));
  return applyWorkingDaysFilter({ isoDate: rawDate, workingDays, policy });
};

export const computeNextScheduledAction = ({
  steps,
  completedStepNumber,
  launchedAtDate,
  workingDays,
  policy,
}: {
  steps: any[];
  completedStepNumber: number;
  launchedAtDate: string;
  workingDays: SequenceWorkingDay[];
  policy: NonWorkingDayPolicy;
}) => {
  const skippedStepNumbers: number[] = [];
  let sequenceStep = Number(completedStepNumber || 0);
  const list = Array.isArray(steps) ? steps : [];

  // Fail closed: empty steps means the caller did not provide the sequence
  // definition (e.g. nested pipeline previously passed `{ steps: [] }`).
  // Never invent sequence completion — that prematurely ends campaigns and
  // rotates contacts onto the wrong step.
  if (list.length === 0) {
    return {
      sequenceStep: Math.max(0, sequenceStep),
      nextActionDate: '',
      skippedStepNumbers,
      completed: false,
    };
  }

  for (let stepNumber = sequenceStep + 1; stepNumber <= list.length; stepNumber += 1) {
    const step = list[stepNumber - 1] || {};
    const dayOffset = Number(step?.day || 0);
    const scheduled = computeStepSchedule({
      launchedAtDate,
      dayOffset,
      workingDays,
      policy,
    });

    if ('skip' in scheduled) {
      skippedStepNumbers.push(stepNumber);
      sequenceStep = stepNumber;
      continue;
    }

    return {
      sequenceStep,
      nextActionDate: scheduled.date,
      skippedStepNumbers,
      completed: false,
    };
  }

  return {
    sequenceStep: Math.max(sequenceStep, list.length),
    nextActionDate: '',
    skippedStepNumbers,
    completed: true,
  };
};
