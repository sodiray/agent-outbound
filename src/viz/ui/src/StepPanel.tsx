import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchPipelineStepRecords } from './api.js';
import { COUNT_ITEMS, countFor, formatCount, formatUsd, kindLabel, type CountItem } from './pipelinePresentation.js';
import {
  displayDate,
  identityValue,
  labelFor,
  RecordDetailContent,
  rowId,
  textValue,
  useRecordDetail,
} from './RecordDetailView.js';
import type { PipelineNode, PipelineStepRecordsResponse, PipelineStepState, RecordRow } from './types.js';

const PAGE_SIZE = 50;
const ALWAYS_SHOWN_STATES: PipelineStepState[] = ['waiting', 'passed', 'dropped'];

export type RecordSelection = (rowIdValue: string, options?: { replace?: boolean }) => void;

const FieldList = ({ fields, empty = 'none' }: { fields: string[]; empty?: string }) => (
  fields.length === 0
    ? <span className="muted">{empty}</span>
    : (
      <span className="pipeline-field-list">
        {fields.map((field) => <code key={field}>{field}</code>)}
      </span>
    )
);

const StepDefinition = ({ node }: { node: PipelineNode }) => (
  <section className="detail-section">
    <div className="section-title">Definition</div>
    <dl className="pipeline-definition">
      <dt>Kind</dt>
      <dd><code>{node.kind}</code></dd>
      {node.tool_or_model ? (
        <>
          <dt>Tool / model</dt>
          <dd>{node.tool_or_model}</dd>
        </>
      ) : null}
      {node.sources && node.sources.length > 0 ? (
        <>
          <dt>Strategies</dt>
          <dd>
            <ul className="pipeline-definition__list">
              {node.sources.map((source) => (
                <li key={`${source.id}:${source.kind}`}>
                  <code>{source.id || source.kind}</code> {source.kind ? <span className="muted">{source.kind}</span> : null}
                  {source.tool_or_model ? <span className="muted"> · {source.tool_or_model}</span> : null}
                </li>
              ))}
            </ul>
          </dd>
        </>
      ) : null}
      {node.source_counts && node.source_counts.length > 0 ? (
        <>
          <dt>Sourced by kind</dt>
          <dd>
            <ul className="pipeline-definition__list">
              {node.source_counts.map((entry) => <li key={entry.source}><code>{entry.source}</code> {formatCount(entry.count)}</li>)}
            </ul>
          </dd>
        </>
      ) : null}
      {node.kind === 'source' ? null : (
        <>
          <dt>Inputs</dt>
          <dd><FieldList fields={node.inputs} /></dd>
        </>
      )}
      <dt>Outputs</dt>
      <dd><FieldList fields={node.outputs} /></dd>
      {node.kind === 'source' ? null : (
        <>
          <dt>Depends on</dt>
          <dd>
            <FieldList fields={node.depends_on} empty={node.group ? 'start of turn' : 'source'} />
            {node.inferred_depends_on.length > 0 ? (
              <span className="pipeline-definition__inferred">
                inferred <FieldList fields={node.inferred_depends_on} />
              </span>
            ) : null}
          </dd>
        </>
      )}
      {node.when ? (
        <>
          <dt>When</dt>
          <dd><code className="pipeline-definition__when">{node.when.summary}</code></dd>
        </>
      ) : null}
      {node.group ? (
        <>
          <dt>Runs</dt>
          <dd>{node.group.label} in <code>{node.group.id}</code>, after <code>{node.group.parent_id}</code></dd>
        </>
      ) : null}
    </dl>
  </section>
);

const StepCounts = ({ node }: { node: PipelineNode }) => {
  const items = COUNT_ITEMS.filter((item) => item.state === 'passed' || node.kind !== 'source');
  return (
    <section className="detail-section">
      <div className="section-title">{node.kind === 'source' ? 'Sourced' : 'Records at this step'}</div>
      <div className="pipeline-count-grid">
        {items.map((item) => (
          <div key={item.state} className={`pipeline-count-grid__item is-${item.tone}`} title={item.description}>
            <strong>{formatCount(countFor(node.counts, item.state))}</strong>
            <span>{node.kind === 'source' ? 'records' : item.label}</span>
          </div>
        ))}
        <div className="pipeline-count-grid__item" title={node.unpriced_calls > 0 ? `${node.unpriced_calls} calls without a recorded price` : undefined}>
          <strong>{node.spend_usd === null ? '—' : formatUsd(node.spend_usd)}</strong>
          <span>spend{node.spend_calls > 0 ? ` · ${formatCount(node.spend_calls)} calls` : ''}</span>
        </div>
      </div>
    </section>
  );
};

const recordTitle = (record: RecordRow) => {
  const personName = [record.first_name, record.last_name].filter((part) => part !== null && part !== undefined && String(part).trim() !== '').join(' ');
  return textValue(identityValue(record, ['business_name', 'name']) || personName || identityValue(record, ['company', 'title', '_row_id']));
};

const StepRecordRow = ({ record, onOpen }: { record: RecordRow; onOpen: () => void }) => (
  <li>
    <button type="button" className="pipeline-record" onClick={onOpen}>
      <span className="pipeline-record__name">{recordTitle(record)}</span>
      <span className="pipeline-record__meta">
        {record.__step_reason ? <span title={String(record.__step_reason)}>{String(record.__step_reason)}</span> : null}
        {record.__step_at ? <time>{displayDate(record.__step_at)}</time> : null}
      </span>
    </button>
  </li>
);

const StepRecords = ({
  node,
  state,
  onStateChange,
  onSelectRecord,
}: {
  node: PipelineNode;
  state: PipelineStepState;
  onStateChange: (state: PipelineStepState) => void;
  onSelectRecord: RecordSelection;
}) => {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<PipelineStepRecordsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const stateCount = countFor(node.counts, state);
  const tabs = COUNT_ITEMS.filter((item: CountItem) => (
    node.kind === 'source'
      ? item.state === 'passed'
      : ALWAYS_SHOWN_STATES.includes(item.state) || countFor(node.counts, item.state) > 0
  ));

  useEffect(() => setOffset(0), [state]);

  useEffect(() => {
    const request = { cancelled: false };
    setLoading(true);
    setError('');
    fetchPipelineStepRecords({ stepId: node.id, state, limit: PAGE_SIZE, offset })
      .then((nextPage) => {
        if (!request.cancelled) setPage(nextPage);
      })
      .catch((nextError: Error) => {
        if (!request.cancelled) setError(nextError.message);
      })
      .finally(() => {
        if (!request.cancelled) setLoading(false);
      });
    return () => {
      request.cancelled = true;
    };
    // The count changes when records move, so the list refreshes with it.
  }, [node.id, offset, state, stateCount]);

  const total = page?.total ?? stateCount;
  const records = page && page.state === state ? page.records : [];
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + PAGE_SIZE, total);

  return (
    <section className="detail-section">
      <div className="section-title">Records</div>
      <nav className="pipeline-tabs" role="tablist" aria-label="Records by state">
        {tabs.map((item) => (
          <button
            key={item.state}
            type="button"
            role="tab"
            aria-selected={state === item.state}
            className={state === item.state ? 'is-active' : ''}
            onClick={() => onStateChange(item.state)}
          >
            {labelFor(item.label)} <strong>{formatCount(countFor(node.counts, item.state))}</strong>
          </button>
        ))}
      </nav>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {loading && records.length === 0 ? <div className="drawer-loading">Loading records…</div> : null}
      {!loading && !error && records.length === 0 ? <p className="muted">No {labelFor(state).toLowerCase()} records at this step.</p> : null}
      {records.length > 0 ? (
        <ul className="pipeline-records">
          {records.map((record) => (
            <StepRecordRow key={rowId(record)} record={record} onOpen={() => onSelectRecord(rowId(record))} />
          ))}
        </ul>
      ) : null}
      {total > PAGE_SIZE ? (
        <div className="pipeline-pager">
          <button type="button" className="text-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            ← Previous
          </button>
          <span>{formatCount(first)}–{formatCount(last)} of {formatCount(total)}</span>
          <button type="button" className="text-button" disabled={last >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
            Next →
          </button>
        </div>
      ) : (
        <p className="pipeline-pager muted">{formatCount(total)} {total === 1 ? 'record' : 'records'}</p>
      )}
    </section>
  );
};

// A top-level review step is decided on the Review page; its panel links there
// with the stage tab already active.
const ReviewLeadsLink = ({ node }: { node: PipelineNode }) => {
  const awaiting = node.counts.awaiting_review;
  return (
    <section className="pipeline-review-link">
      <span className="pipeline-review-link__count">
        <strong>{formatCount(awaiting)}</strong> awaiting a decision
      </span>
      <Link
        className={`pipeline-review-link__button ${awaiting > 0 ? 'has-awaiting' : ''}`.trim()}
        to={`/review?stage=${encodeURIComponent(node.id)}`}
      >
        Review Leads · {formatCount(awaiting)}
      </Link>
    </section>
  );
};

const PanelRecordDetail = ({
  recordId,
  backLabel,
  onBack,
  initialTab,
}: {
  recordId: string;
  backLabel: string;
  onBack: () => void;
  initialTab?: 'score' | 'pipeline' | 'assets';
}) => {
  const { detail, loading, error } = useRecordDetail(recordId);
  return (
    <>
      <div className="pipeline-panel__bar">
        <button type="button" className="text-button" onClick={onBack}>← {backLabel}</button>
      </div>
      {loading ? <div className="drawer-loading">Loading detail...</div> : null}
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {detail ? <RecordDetailContent detail={detail} initialTab={initialTab} /> : null}
    </>
  );
};

const StepPanelHeader = ({ node }: { node: PipelineNode }) => (
  <header className="pipeline-panel__header">
    <p className="eyebrow">{kindLabel(node)}</p>
    <h2>{node.label}</h2>
    <code>{node.id}</code>
    {node.description ? <p>{node.description}</p> : null}
  </header>
);

const defaultState = (node: PipelineNode): PipelineStepState => (
  COUNT_ITEMS.find((item) => countFor(node.counts, item.state) > 0)?.state || 'waiting'
);

export const StepPanel = ({
  node,
  recordId,
  onSelectRecord,
}: {
  node: PipelineNode;
  recordId: string;
  onSelectRecord: RecordSelection;
}) => {
  // The panel is keyed by step, so this picks the opening tab once per step.
  const [state, setState] = useState<PipelineStepState>(() => (node.kind === 'source' ? 'passed' : defaultState(node)));

  if (node.review) {
    return (
      <div className="pipeline-panel">
        <StepPanelHeader node={node} />
        <ReviewLeadsLink node={node} />
        <StepCounts node={node} />
        <StepDefinition node={node} />
      </div>
    );
  }

  if (recordId) {
    return (
      <PanelRecordDetail
        recordId={recordId}
        backLabel={`${node.label} · ${labelFor(COUNT_ITEMS.find((item) => item.state === state)?.label || state).toLowerCase()} records`}
        onBack={() => onSelectRecord('')}
        initialTab="pipeline"
      />
    );
  }

  return (
    <div className="pipeline-panel">
      <StepPanelHeader node={node} />
      <StepCounts node={node} />
      <StepDefinition node={node} />
      <StepRecords
        node={node}
        state={node.kind === 'source' ? 'passed' : state}
        onStateChange={setState}
        onSelectRecord={onSelectRecord}
      />
    </div>
  );
};
