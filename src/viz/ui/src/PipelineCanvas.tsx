import { useEffect, useMemo } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
} from '@xyflow/react';
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';
import { PIPELINE_NODE_TYPES, type GroupFlowNode, type StepFlowNode } from './PipelineNodes.js';
import { kindFamily } from './pipelinePresentation.js';
import type { PipelineEdge, PipelineResponse } from './types.js';

const NODE_WIDTH = 228;
const NODE_HEIGHT = 112;
const GROUP_PADDING = 18;
const GROUP_LABEL_SPACE = 24;
const FIT_VIEW_OPTIONS = { padding: 0.08, maxZoom: 1.1 };
// A long pipeline fitted whole is too small to read. Below this zoom the
// opening view fits the width instead and starts at the source.
const READABLE_ZOOM = 0.72;
const VIEW_MARGIN = 32;

const MINIMAP_COLORS: Record<string, string> = {
  source: '#3ecf6f',
  enrich: '#93c5fd',
  filter: '#f5a524',
  decide: '#c4b5fd',
  review: '#f5d547',
  action: '#ff6666',
  wait: '#8b93a7',
};

const groupNodeId = (groupId: string) => `group:${groupId}`;

const drawnEdges = (graph: PipelineResponse, showImplied: boolean) => (
  graph.edges.filter((edge) => showImplied || !edge.implied)
);

// Layout depends only on which nodes, groups, and edges are drawn; count ticks
// keep the same key and reuse the positions.
const graphShapeKey = (graph: PipelineResponse, showImplied: boolean) => JSON.stringify([
  graph.nodes.map((node) => [node.id, node.group?.id || '']),
  drawnEdges(graph, showImplied).map((edge) => `${edge.from}>${edge.to}`),
]);

type PipelineLayout = {
  positions: Map<string, { x: number; y: number }>;
  groups: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  bounds: { x: number; y: number; width: number; height: number };
};

const layoutPipeline = (graph: PipelineResponse, showImplied: boolean): PipelineLayout => {
  const dag = new dagre.graphlib.Graph({ compound: true });
  dag.setGraph({ rankdir: 'TB', ranksep: 44, nodesep: 24, edgesep: 12, marginx: 24, marginy: 24 });
  dag.setDefaultEdgeLabel(() => ({}));
  graph.groups.forEach((group) => dag.setNode(groupNodeId(group.id), {}));
  graph.nodes.forEach((node) => {
    dag.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    if (node.group) dag.setParent(node.id, groupNodeId(node.group.id));
  });
  drawnEdges(graph, showImplied).forEach((edge) => dag.setEdge(edge.from, edge.to));
  dagre.layout(dag);

  const positions = new Map(graph.nodes.map((node) => {
    const point = dag.node(node.id);
    return [node.id, { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 }];
  }));
  const groups = graph.groups.map((group) => {
    const members = graph.nodes.filter((node) => node.group?.id === group.id).map((node) => positions.get(node.id)!);
    const left = Math.min(...members.map((point) => point.x)) - GROUP_PADDING;
    const top = Math.min(...members.map((point) => point.y)) - GROUP_PADDING - GROUP_LABEL_SPACE;
    const right = Math.max(...members.map((point) => point.x + NODE_WIDTH)) + GROUP_PADDING;
    const bottom = Math.max(...members.map((point) => point.y + NODE_HEIGHT)) + GROUP_PADDING;
    return { id: group.id, x: left, y: top, width: right - left, height: bottom - top };
  }).filter((group) => Number.isFinite(group.width) && Number.isFinite(group.height));
  const boxes = [
    ...[...positions.values()].map((point) => ({ x: point.x, y: point.y, width: NODE_WIDTH, height: NODE_HEIGHT })),
    ...groups,
  ];
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { positions, groups, bounds: { x: left, y: top, width: right - left, height: bottom - top } };
};

const edgeClassName = (edge: PipelineEdge, conditional: boolean) => [
  'pipeline-edge',
  `pipeline-edge--${edge.origin}`,
  edge.implied ? 'pipeline-edge--implied' : '',
  conditional ? 'pipeline-edge--conditional' : '',
].filter(Boolean).join(' ');

// Opens each new graph shape fitted to the pane, or, when that would be
// unreadably small, fitted to its width and anchored at the top.
const FitViewOnShapeChange = ({ shapeKey, bounds }: { shapeKey: string; bounds: PipelineLayout['bounds'] }) => {
  const { fitView, setViewport } = useReactFlow();
  const paneWidth = useStore((state) => state.width);
  const paneHeight = useStore((state) => state.height);
  const hasPane = paneWidth > 0 && paneHeight > 0;
  useEffect(() => {
    if (!hasPane) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const fitZoom = Math.min(
        (paneWidth - VIEW_MARGIN * 2) / bounds.width,
        (paneHeight - VIEW_MARGIN * 2) / bounds.height,
      );
      if (fitZoom >= READABLE_ZOOM) {
        void fitView(FIT_VIEW_OPTIONS);
        return;
      }
      const zoom = Math.max(fitZoom, Math.min(READABLE_ZOOM, (paneWidth - VIEW_MARGIN * 2) / bounds.width));
      void setViewport({
        x: (paneWidth - bounds.width * zoom) / 2 - bounds.x * zoom,
        y: VIEW_MARGIN - bounds.y * zoom,
        zoom,
      });
    });
    return () => window.cancelAnimationFrame(frame);
    // Pane size changes do not refit; only a new graph shape (or first mount) does.
  }, [hasPane, shapeKey]);
  return null;
};

export const PipelineCanvas = ({
  graph,
  selectedStepId,
  showImplied,
  onSelectStep,
}: {
  graph: PipelineResponse;
  selectedStepId: string;
  showImplied: boolean;
  onSelectStep: (stepId: string) => void;
}) => {
  const shapeKey = graphShapeKey(graph, showImplied);
  // Keyed on the shape alone, so count refreshes never move nodes.
  const layout = useMemo(() => layoutPipeline(graph, showImplied), [shapeKey]);

  const nodes = useMemo<Node[]>(() => {
    const groupNodes: GroupFlowNode[] = layout.groups.map((group) => ({
      id: groupNodeId(group.id),
      type: 'turnGroup',
      position: { x: group.x, y: group.y },
      data: { group: graph.groups.find((candidate) => candidate.id === group.id)! },
      style: { width: group.width, height: group.height },
      width: group.width,
      height: group.height,
      selectable: false,
      draggable: false,
      focusable: false,
      zIndex: -1,
    }));
    const stepNodes: StepFlowNode[] = graph.nodes.map((node) => ({
      id: node.id,
      type: 'step',
      position: layout.positions.get(node.id) || { x: 0, y: 0 },
      data: { node, active: graph.active_step === node.id, selected: node.id === selectedStepId },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      draggable: false,
      connectable: false,
    }));
    return [...groupNodes, ...stepNodes];
  }, [graph, layout, selectedStepId]);

  const edges = useMemo<Edge[]>(() => {
    const conditional = new Set(graph.nodes.filter((node) => node.when).map((node) => node.id));
    return drawnEdges(graph, showImplied).map((edge) => ({
      id: `${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      className: edgeClassName(edge, conditional.has(edge.to)),
      animated: graph.active_step === edge.to,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      focusable: false,
    }));
  }, [graph, showImplied]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={PIPELINE_NODE_TYPES}
      onNodeClick={(_event, node) => {
        if (node.type === 'step') onSelectStep(node.id);
      }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.15}
      maxZoom={1.6}
      panOnScroll
      colorMode="dark"
    >
      <FitViewOnShapeChange shapeKey={shapeKey} bounds={layout.bounds} />
      <Background gap={24} size={1} color="rgba(185, 193, 201, 0.08)" />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        maskColor="rgba(5, 6, 10, 0.72)"
        nodeColor={(node) => (
          node.type === 'step'
            ? MINIMAP_COLORS[kindFamily((node as StepFlowNode).data.node.kind)]
            : 'rgba(185, 193, 201, 0.06)'
        )}
      />
    </ReactFlow>
  );
};
