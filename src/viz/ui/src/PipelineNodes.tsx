import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  COUNT_ITEMS,
  countFor,
  formatCount,
  formatUsd,
  kindFamily,
  kindLabel,
  localStepId,
} from './pipelinePresentation.js';
import type { PipelineCounts, PipelineGroup, PipelineNode } from './types.js';

export type StepNodeData = {
  node: PipelineNode;
  active: boolean;
  selected: boolean;
};

export type GroupNodeData = {
  group: PipelineGroup;
};

export type StepFlowNode = Node<StepNodeData, 'step'>;
export type GroupFlowNode = Node<GroupNodeData, 'turnGroup'>;

export const CountChips = ({ counts }: { counts: PipelineCounts }) => {
  const visible = COUNT_ITEMS.filter((item) => countFor(counts, item.state) > 0);
  if (visible.length === 0) return <span className="pipeline-counts pipeline-counts--empty">no records yet</span>;
  return (
    <span className="pipeline-counts">
      {visible.map((item) => (
        <span key={item.state} className={`pipeline-count is-${item.tone}`} title={item.description}>
          <strong>{formatCount(countFor(counts, item.state))}</strong> {item.label}
        </span>
      ))}
    </span>
  );
};

const SourceSummary = ({ node }: { node: PipelineNode }) => {
  const strategies = node.sources || [];
  return (
    <>
      <span className="pipeline-node__sourced">
        <strong>{formatCount(node.counts.passed)}</strong> sourced
      </span>
      {strategies.length > 0 ? (
        <span className="pipeline-node__meta" title={strategies.map((strategy) => strategy.id || strategy.kind).join(', ')}>
          {strategies.length === 1 ? strategies[0].id || strategies[0].kind : `${strategies.length} strategies`}
        </span>
      ) : null}
    </>
  );
};

// Unlabelled steps show their id as the title; a configured label keeps the id beneath it.
const hasCustomLabel = (node: PipelineNode) => node.label !== localStepId(node);

export const StepNode = ({ data }: NodeProps<StepFlowNode>) => {
  const { node, active, selected } = data;
  const family = kindFamily(node.kind);
  const awaiting = node.review ? node.counts.awaiting_review : 0;
  const classes = [
    'pipeline-node',
    `pipeline-node--${family}`,
    active ? 'is-active' : '',
    selected ? 'is-selected' : '',
    awaiting > 0 ? 'has-awaiting' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      {family === 'source' ? null : <Handle type="target" position={Position.Top} isConnectable={false} />}
      <div className="pipeline-node__head">
        <span className="pipeline-node__kind">{kindLabel(node)}</span>
        {active ? <span className="pipeline-node__live">running</span> : null}
        {node.spend_usd !== null ? <span className="pipeline-node__spend" title={`${node.spend_calls} calls`}>{formatUsd(node.spend_usd)}</span> : null}
      </div>
      <strong className="pipeline-node__label" title={node.description || node.label}>{node.label}</strong>
      {hasCustomLabel(node) ? <code className="pipeline-node__id">{localStepId(node)}</code> : null}
      {node.tool_or_model ? <span className="pipeline-node__meta" title={node.tool_or_model}>{node.tool_or_model}</span> : null}
      {node.when ? <span className="pipeline-node__when" title={`when ${node.when.summary}`}>when {node.when.summary}</span> : null}
      {family === 'source' ? <SourceSummary node={node} /> : <CountChips counts={node.counts} />}
      {awaiting > 0 ? <span className="pipeline-node__review-badge">{formatCount(awaiting)} to review</span> : null}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
};

export const GroupNode = ({ data }: NodeProps<GroupFlowNode>) => (
  <div className="pipeline-group">
    <span className="pipeline-group__label">{data.group.label} · {data.group.id}</span>
  </div>
);

export const PIPELINE_NODE_TYPES = {
  step: StepNode,
  turnGroup: GroupNode,
};
