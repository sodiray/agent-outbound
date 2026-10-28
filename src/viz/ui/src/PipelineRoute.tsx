import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchPipeline } from './api.js';
import { DetailDrawer } from './DetailDrawer.js';
import { PipelineCanvas } from './PipelineCanvas.js';
import { formatCount, formatUsd, KIND_FAMILY_LABELS, type PipelineKindFamily } from './pipelinePresentation.js';
import { RouteNav } from './RouteNav.js';
import { StepPanel, type RecordSelection } from './StepPanel.js';
import type { PipelineResponse } from './types.js';

// The graph endpoint aggregates every step, so live refresh follows the run
// heartbeat instead of every one-second stream tick.
const MIN_REFRESH_MS = 3000;
const IDLE_REFRESH_MS = 15000;
const LEGEND_FAMILIES: PipelineKindFamily[] = ['source', 'enrich', 'filter', 'decide', 'review', 'action', 'wait'];

type StreamTick = {
  progress?: { status?: string; active_step?: string; updated_at?: string } | null;
  counts?: unknown;
};

const isEditableTarget = (target: EventTarget | null) => (
  target instanceof HTMLElement
  && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
);

const usePipelineGraph = () => {
  const [graph, setGraph] = useState<PipelineResponse | null>(null);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const queued = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    try {
      setGraph(await fetchPipeline());
      setError('');
    } catch (nextError) {
      setError(String((nextError as Error)?.message || nextError));
    } finally {
      inFlight.current = false;
      if (queued.current) {
        queued.current = false;
        void refresh();
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const stream = new EventSource('/api/stream');
    const state = { signature: '', fetchedAt: Date.now() };
    stream.addEventListener('tick', (event) => {
      const tick = (() => {
        try {
          return JSON.parse((event as MessageEvent<string>).data) as StreamTick;
        } catch {
          return {} as StreamTick;
        }
      })();
      const signature = JSON.stringify([tick.progress?.status, tick.progress?.active_step, tick.progress?.updated_at, tick.counts]);
      const elapsed = Date.now() - state.fetchedAt;
      if ((signature !== state.signature && elapsed >= MIN_REFRESH_MS) || elapsed >= IDLE_REFRESH_MS) {
        state.signature = signature;
        state.fetchedAt = Date.now();
        void refresh();
      }
    });
    return () => stream.close();
  }, [refresh]);

  return { graph, error };
};

const PipelineLegend = ({
  graph,
  showImplied,
  onShowImpliedChange,
}: {
  graph: PipelineResponse | null;
  showImplied: boolean;
  onShowImpliedChange: (show: boolean) => void;
}) => {
  const impliedCount = graph?.edges.filter((edge) => edge.implied).length || 0;
  return (
    <div className="pipeline-toolbar">
      <div className="pipeline-legend" aria-label="Node kinds">
        {LEGEND_FAMILIES.map((family) => (
          <span key={family} className={`pipeline-legend__item pipeline-legend__item--${family}`}>{KIND_FAMILY_LABELS[family]}</span>
        ))}
        <span className="pipeline-legend__edge pipeline-legend__edge--explicit">declared</span>
        <span className="pipeline-legend__edge pipeline-legend__edge--inferred">inferred</span>
        <span className="pipeline-legend__edge pipeline-legend__edge--conditional">conditional</span>
      </div>
      <div className="pipeline-toolbar__meta">
        {graph?.active_step ? <span className="pipeline-toolbar__running">Running <code>{graph.active_step}</code></span> : null}
        {graph && (graph.unattributed_spend_usd > 0 || graph.unattributed_unpriced_calls > 0) ? (
          <span
            className="pipeline-toolbar__spend"
            title={graph.unattributed_spend.map((item) => [
              `${item.step_id}: ${item.spend_usd === null ? 'unpriced' : formatUsd(item.spend_usd)}`,
              item.unpriced_calls > 0 && item.spend_usd !== null ? ` + ${item.unpriced_calls} unpriced` : '',
            ].join('')).join('\n')}
          >
            {graph.unattributed_spend_usd > 0 ? `${formatUsd(graph.unattributed_spend_usd)} spend` : 'Spend'}
            {graph.unattributed_unpriced_calls > 0 ? ` (+ ${formatCount(graph.unattributed_unpriced_calls)} unpriced calls)` : ''}
            {' '}from steps no longer in the pipeline
          </span>
        ) : null}
        {impliedCount > 0 ? (
          <label className="pipeline-toolbar__toggle">
            <input type="checkbox" checked={showImplied} onChange={(event) => onShowImpliedChange(event.target.checked)} />
            Show {impliedCount} implied dependencies
          </label>
        ) : null}
      </div>
    </div>
  );
};

export const PipelineRoute = () => {
  const [search, setSearch] = useSearchParams();
  const { graph, error } = usePipelineGraph();
  const [showImplied, setShowImplied] = useState(false);
  const stepId = search.get('step') || '';
  const selected = graph?.nodes.find((node) => node.id === stepId) || null;
  // A review stage's records are reviewed on the Review page, so its panel
  // never opens a record.
  const recordId = selected?.review ? '' : search.get('record') || '';

  const navigate = useCallback((next: { step?: string; record?: string }, options: { replace?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (next.step) params.set('step', next.step);
    if (next.step && next.record) params.set('record', next.record);
    setSearch(params, { replace: options.replace });
  }, [setSearch]);

  const selectStep = useCallback((id: string) => navigate({ step: id }), [navigate]);
  const selectRecord: RecordSelection = useCallback((id, options) => navigate({ step: stepId, record: id }, options), [navigate, stepId]);
  const closePanel = useCallback(() => navigate({}), [navigate]);
  // Escape steps back from a record to its list before closing the panel, and
  // leaves a focused field instead of acting on the panel.
  const onEscape = useCallback((event: KeyboardEvent) => {
    if (isEditableTarget(event.target)) {
      (event.target as HTMLElement).blur();
      return;
    }
    if (recordId) navigate({ step: stepId });
    else closePanel();
  }, [closePanel, navigate, recordId, stepId]);

  return (
    <main className="pipeline-shell">
      <header className="topbar">
        <div className="topbar__id">
          <span className="topbar__name">Pipeline</span>
        </div>
        <RouteNav />
      </header>
      <PipelineLegend graph={graph} showImplied={showImplied} onShowImpliedChange={setShowImplied} />
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      <div className="pipeline-canvas">
        {graph ? (
          <PipelineCanvas graph={graph} selectedStepId={stepId} showImplied={showImplied} onSelectStep={selectStep} />
        ) : (
          <div className="loading">{error ? 'Pipeline unavailable.' : 'Loading pipeline…'}</div>
        )}
      </div>
      <DetailDrawer
        open={Boolean(selected)}
        onClose={closePanel}
        onEscape={onEscape}
        ariaLabel="Step panel"
        className="pipeline-drawer"
      >
        {selected ? (
          <StepPanel key={selected.id} node={selected} recordId={recordId} onSelectRecord={selectRecord} />
        ) : null}
      </DetailDrawer>
    </main>
  );
};
