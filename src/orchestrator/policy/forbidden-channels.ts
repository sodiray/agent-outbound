/**
 * Forbidden channel / work creation guards for outbound projects that ban
 * SMS, automated voice, door-to-door, and office visits.
 */

export const FORBIDDEN_CHANNEL_KINDS = [
  'send_sms',
  'sms',
  'automated_voice',
  'prerecorded_voice',
  'voice_broadcast',
  'visit',
  'field_visit',
  'door_to_door',
  'office_visit',
] as const;

export type ForbiddenChannelKind = (typeof FORBIDDEN_CHANNEL_KINDS)[number];

const FORBIDDEN_SET = new Set<string>(FORBIDDEN_CHANNEL_KINDS);

/** Task types / step ids that must never be created under TV policy. */
export const FORBIDDEN_TASK_TYPES = new Set([
  'visit',
  'field_visit',
  'door_to_door',
  'office_visit',
  'walk_in',
  'sms',
  'send_sms',
  'automated_voice',
  'prerecorded_voice',
]);

export function isForbiddenChannelKind(kind: string | null | undefined): boolean {
  const k = String(kind || '').trim().toLowerCase();
  if (!k) return false;
  if (FORBIDDEN_SET.has(k)) return true;
  if (k.includes('door_to_door') || k.includes('door-to-door')) return true;
  if (k === 'field_visit' || k.endsWith('.field_visit')) return true;
  return false;
}

export function isForbiddenTaskType(taskType: string | null | undefined): boolean {
  const t = String(taskType || '').trim().toLowerCase();
  if (!t) return false;
  if (FORBIDDEN_TASK_TYPES.has(t)) return true;
  if (t.includes('visit') && !t.includes('revisit_decision')) return true;
  if (t.includes('sms') || t.includes('voice')) return true;
  return false;
}

export type ConfigStepLike = {
  kind?: string;
  id?: string;
  config?: { task_type?: string; taskType?: string; channel?: string };
  steps?: ConfigStepLike[];
};

/**
 * Walk a pipeline/sequence config tree and collect forbidden step definitions.
 * Returns empty array when clean.
 */
export function findForbiddenSteps(steps: ConfigStepLike[] | undefined | null): Array<{
  id: string;
  kind: string;
  reason: string;
}> {
  const found: Array<{ id: string; kind: string; reason: string }> = [];
  const walk = (list: ConfigStepLike[] | undefined) => {
    if (!Array.isArray(list)) return;
    for (const step of list) {
      if (!step || typeof step !== 'object') continue;
      const kind = String(step.kind || '');
      const id = String(step.id || '');
      if (isForbiddenChannelKind(kind)) {
        found.push({ id, kind, reason: `step kind "${kind}" is forbidden` });
      }
      const taskType = step.config?.task_type || step.config?.taskType || '';
      if (isForbiddenTaskType(taskType)) {
        found.push({ id, kind, reason: `task_type "${taskType}" is forbidden` });
      }
      if (isForbiddenTaskType(id)) {
        found.push({ id, kind, reason: `step id "${id}" is a forbidden work type` });
      }
      if (Array.isArray(step.steps)) walk(step.steps);
    }
  };
  walk(steps || []);
  return found;
}

/**
 * Assert that proposed work may be created. Throws on forbidden channel/work.
 */
export function assertWorkAllowed(input: {
  kind?: string;
  taskType?: string;
  channel?: string;
  stepId?: string;
}): void {
  if (isForbiddenChannelKind(input.kind) || isForbiddenChannelKind(input.channel)) {
    throw new Error(
      `Forbidden channel/work: kind=${input.kind || ''} channel=${input.channel || ''} is not permitted`,
    );
  }
  if (isForbiddenTaskType(input.taskType) || isForbiddenTaskType(input.stepId)) {
    throw new Error(
      `Forbidden task: taskType=${input.taskType || ''} stepId=${input.stepId || ''} is not permitted`,
    );
  }
}
