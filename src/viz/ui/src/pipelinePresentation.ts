import type { PipelineCounts, PipelineNode, PipelineStepState } from './types.js';

export type PipelineKindFamily = 'source' | 'enrich' | 'filter' | 'decide' | 'review' | 'action' | 'wait';

const FAMILY_BY_KIND: Record<string, PipelineKindFamily> = {
  source: 'source',
  filter: 'filter',
  assign: 'filter',
  decide: 'decide',
  score: 'decide',
  review: 'review',
  manual_task: 'review',
  action: 'action',
  wait: 'wait',
  await_event: 'wait',
};

export const kindFamily = (kind: string): PipelineKindFamily => FAMILY_BY_KIND[kind] || 'enrich';

export const KIND_FAMILY_LABELS: Record<PipelineKindFamily, string> = {
  source: 'Source',
  enrich: 'Enrich · tool',
  filter: 'Filter',
  decide: 'Decide',
  review: 'Review',
  action: 'Action',
  wait: 'Wait',
};

export const kindLabel = (node: PipelineNode) => (
  kindFamily(node.kind) === 'enrich' && node.kind !== 'enrich' ? node.kind.replaceAll('_', ' ') : KIND_FAMILY_LABELS[kindFamily(node.kind)]
);

export type CountItem = {
  state: PipelineStepState;
  label: string;
  tone: 'green' | 'yellow' | 'red' | 'muted' | 'blue';
  description: string;
};

// Display order for a node's counts; the step panel lists records by the same states.
export const COUNT_ITEMS: CountItem[] = [
  { state: 'waiting', label: 'waiting', tone: 'yellow', description: 'Waiting or in progress at this step' },
  { state: 'deferred', label: 'deferred', tone: 'blue', description: 'Tool attested that it did not execute; retry is pending' },
  { state: 'passed', label: 'passed', tone: 'green', description: 'Passed this step' },
  { state: 'dropped', label: 'dropped', tone: 'red', description: 'Dropped at this step' },
  { state: 'skipped_when', label: 'skipped', tone: 'muted', description: 'Skipped because the `when` predicate did not match' },
  { state: 'skipped_other', label: 'not run', tone: 'muted', description: 'Not run for another reason (budget ceiling, park closed, operator skip)' },
  { state: 'failed', label: 'not passed', tone: 'yellow', description: 'Ran without passing and was not dropped here' },
  { state: 'blocked_by_error', label: 'blocked', tone: 'red', description: 'Blocked because an upstream step errored' },
  { state: 'errored', label: 'errored', tone: 'red', description: 'Errored at this step' },
];

export const countFor = (counts: PipelineCounts, state: PipelineStepState) => Number(counts[state] || 0);

export const formatCount = (value: number) => new Intl.NumberFormat().format(value);

export const formatUsd = (value: number) => {
  if (value === 0) return '$0';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
};

export const localStepId = (node: PipelineNode) => (
  node.group && node.id.startsWith(`${node.group.id}.`) ? node.id.slice(node.group.id.length + 1) : node.id
);
