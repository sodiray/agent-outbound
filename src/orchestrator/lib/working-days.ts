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
