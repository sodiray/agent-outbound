import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  clearReviewDecision,
  fetchMeta,
  fetchReviewQueue,
  submitReviewDecisions,
} from './api.js';
import type {
  MetaResponse,
  RecordRow,
  RecordValue,
  ReviewDecisionInput,
  ReviewDecisionResult,
  ReviewVerdict,
} from './types.js';

type PendingDecision = ReviewDecisionInput & {
  stage_id: string;
  record: RecordRow;
};

type DecisionHistoryItem = PendingDecision & {
  state: 'pending' | 'submitted';
};

type DecisionFailure = {
  stage_id: string;
  row_id: string;
  business_name: string;
  error: string;
};

type ReconciledDecision = {
  decision: PendingDecision;
  result: ReviewDecisionResult;
};

const DEFAULT_DROP_REASON = 'reviewed: not a fit';
const BATCH_SIZE = 500;

const rowId = (record: RecordRow) => String(record._row_id ?? '');
const decisionKey = ({ stage_id, row_id }: { stage_id: string; row_id: string }) => `${stage_id}:${row_id}`;
const labelFor = (key: string) => key
  .replace(/^_+/, '')
  .split(/[_\s-]+/)
  .filter(Boolean)
  .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
  .join(' ') || key;

const displayValue = (value: RecordValue | undefined) => {
  if (value === null || value === undefined || value === '') return 'n/a';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
};

const isWebsiteField = (field: string) => field.toLowerCase().includes('website');

const websiteHref = (value: string) => {
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
};

const chunkDecisions = (decisions: PendingDecision[]) => Array.from(
  { length: Math.ceil(decisions.length / BATCH_SIZE) },
  (_, index) => decisions.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
);

const isTypingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName);
};

export const ReviewRoute = () => {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [activeStageId, setActiveStageId] = useState('');
  const [queues, setQueues] = useState<Record<string, RecordRow[]>>({});
  const [loadingStageId, setLoadingStageId] = useState('');
  const [cursor, setCursor] = useState(0);
  const [pending, setPending] = useState<PendingDecision[]>([]);
  const [history, setHistory] = useState<DecisionHistoryItem[]>([]);
  const [failures, setFailures] = useState<DecisionFailure[]>([]);
  const [dropReason, setDropReason] = useState(DEFAULT_DROP_REASON);
  const [submitting, setSubmitting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    fetchMeta()
      .then((nextMeta) => {
        setMeta(nextMeta);
        setActiveStageId((current) => (
          nextMeta.review_stages.some((stage) => stage.id === current)
            ? current
            : (nextMeta.review_stages[0]?.id || '')
        ));
      })
      .catch((nextError: Error) => setError(nextError.message));
  }, []);

  useEffect(() => {
    if (!activeStageId) return undefined;
    const request = { cancelled: false };
    setLoadingStageId(activeStageId);
    setError('');
    fetchReviewQueue(activeStageId)
      .then((queue) => {
        if (request.cancelled) return;
        setQueues((current) => ({ ...current, [activeStageId]: queue.records }));
        setMeta((current) => current
          ? {
            ...current,
            review_stages: current.review_stages.map((stage) => (
              stage.id === activeStageId ? { ...stage, awaiting_count: queue.total } : stage
            )),
          }
          : current);
      })
      .catch((nextError: Error) => {
        if (!request.cancelled) setError(nextError.message);
      })
      .finally(() => {
        if (!request.cancelled) setLoadingStageId('');
      });
    return () => {
      request.cancelled = true;
    };
  }, [activeStageId]);

  const activeStage = meta?.review_stages.find((stage) => stage.id === activeStageId) || null;
  const activePending = pending.filter((decision) => decision.stage_id === activeStageId);
  const pendingIds = useMemo(
    () => new Set(activePending.map((decision) => decision.row_id)),
    [activePending],
  );
  const activeRecords = queues[activeStageId] || [];
  const visibleRecords = activeRecords.filter((record) => !pendingIds.has(rowId(record)));
  const selectedRecord = visibleRecords[cursor] || null;
  const activeFailures = failures.filter((failure) => failure.stage_id === activeStageId);

  useEffect(() => {
    setCursor((current) => Math.max(0, Math.min(current, visibleRecords.length - 1)));
  }, [visibleRecords.length]);

  useEffect(() => {
    if (!selectedRecord) return;
    cardRefs.current[rowId(selectedRecord)]?.scrollIntoView({ block: 'nearest' });
  }, [selectedRecord]);

  const selectVerdict = (verdict: ReviewVerdict, record: RecordRow | null = selectedRecord) => {
    if (!record || !activeStage) return;
    const decision: PendingDecision = {
      stage_id: activeStage.id,
      row_id: rowId(record),
      verdict,
      reason: verdict === 'drop' ? (dropReason.trim() || DEFAULT_DROP_REASON) : undefined,
      record,
    };
    setPending((current) => [...current, decision]);
    setHistory((current) => [...current, { ...decision, state: 'pending' }]);
    setFailures((current) => current.filter((failure) => decisionKey(failure) !== decisionKey(decision)));
    setMessage(`${verdict === 'pass' ? 'Passed' : 'Dropped'} ${displayValue(record.business_name)}. Pending submission.`);
  };

  const refreshStage = async (stageId: string) => {
    const [nextMeta, queue] = await Promise.all([fetchMeta(), fetchReviewQueue(stageId)]);
    setMeta(nextMeta);
    setQueues((current) => ({ ...current, [stageId]: queue.records }));
  };

  const undoLast = async () => {
    const last = history.at(-1);
    if (!last || submitting || undoing) {
      if (!last) setMessage('Nothing to undo.');
      return;
    }
    setFailures((current) => current.filter((failure) => decisionKey(failure) !== decisionKey(last)));
    if (last.state === 'pending') {
      setActiveStageId(last.stage_id);
      setPending((current) => current.filter((decision) => decisionKey(decision) !== decisionKey(last)));
      setHistory((current) => current.slice(0, -1));
      setMessage(`Undid pending ${last.verdict} for ${displayValue(last.record.business_name)}.`);
      return;
    }
    setUndoing(true);
    setError('');
    try {
      await clearReviewDecision(last.stage_id, last.row_id);
      setHistory((current) => current.slice(0, -1));
      await refreshStage(last.stage_id);
      setActiveStageId(last.stage_id);
      setMessage(`Undid submitted ${last.verdict} for ${displayValue(last.record.business_name)}.`);
    } catch (nextError) {
      setError(String((nextError as Error)?.message || nextError));
    } finally {
      setUndoing(false);
    }
  };

  const submitChunks = async (
    chunks: PendingDecision[][],
    reconciled: ReconciledDecision[] = [],
  ): Promise<ReconciledDecision[]> => {
    const [chunk, ...remaining] = chunks;
    if (!chunk) return reconciled;
    try {
      const response = await submitReviewDecisions(activeStageId, chunk.map(({ row_id, verdict, reason }) => ({
        row_id,
        verdict,
        reason,
      })));
      const next = response.results.map((result) => ({
        decision: chunk[result.index],
        result,
      })).filter((item) => item.decision);
      return submitChunks(remaining, [...reconciled, ...next]);
    } catch (nextError) {
      const failed = chunk.map((decision, index) => ({
        decision,
        result: {
          ok: false,
          index,
          row_id: decision.row_id,
          verdict: decision.verdict,
          error: String((nextError as Error)?.message || nextError),
        },
      }));
      return submitChunks(remaining, [...reconciled, ...failed]);
    }
  };

  const submitPending = async () => {
    if (activePending.length === 0 || submitting || undoing) return;
    setSubmitting(true);
    setError('');
    setMessage('');
    const reconciled = await submitChunks(chunkDecisions(activePending));
    const applied = reconciled.filter(({ result }) => result.ok);
    const failed = reconciled.filter(({ result }) => !result.ok);
    const appliedKeys = new Set(applied.map(({ decision }) => decisionKey(decision)));
    const failedKeys = new Set(failed.map(({ decision }) => decisionKey(decision)));
    const attemptedKeys = new Set(activePending.map((decision) => decisionKey(decision)));
    setPending((current) => current.filter((decision) => !attemptedKeys.has(decisionKey(decision))));
    setQueues((current) => ({
      ...current,
      [activeStageId]: (current[activeStageId] || []).filter((record) => (
        !appliedKeys.has(decisionKey({ stage_id: activeStageId, row_id: rowId(record) }))
      )),
    }));
    setHistory((current) => current
      .filter((item) => !failedKeys.has(decisionKey(item)))
      .map((item) => appliedKeys.has(decisionKey(item)) ? { ...item, state: 'submitted' } : item));
    setFailures((current) => [
      ...current.filter((failure) => failure.stage_id !== activeStageId),
      ...failed.map(({ decision, result }) => ({
        stage_id: decision.stage_id,
        row_id: decision.row_id,
        business_name: displayValue(decision.record.business_name),
        error: String(result.error || 'The decision was not applied.'),
      })),
    ]);
    setMeta((current) => current
      ? {
        ...current,
        review_stages: current.review_stages.map((stage) => (
          stage.id === activeStageId
            ? { ...stage, awaiting_count: Math.max(0, stage.awaiting_count - applied.length) }
            : stage
        )),
      }
      : current);
    setMessage(`${applied.length} decision${applied.length === 1 ? '' : 's'} submitted${failed.length > 0 ? `; ${failed.length} failed and returned to the queue` : ''}.`);
    setSubmitting(false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'j' || event.key === 'J' || event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((current) => Math.min(current + 1, Math.max(0, visibleRecords.length - 1)));
        return;
      }
      if (event.key === 'k' || event.key === 'K' || event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((current) => Math.max(0, current - 1));
        return;
      }
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        selectVerdict('pass');
        return;
      }
      if (event.key === 'x' || event.key === 'X') {
        event.preventDefault();
        selectVerdict('drop');
        return;
      }
      if (event.key === 'u' || event.key === 'U') {
        event.preventDefault();
        void undoLast();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!meta) {
    return <main className="review-shell"><div className="loading">{error || 'Loading review queue...'}</div></main>;
  }

  return (
    <main className="review-shell">
      <header className="topbar">
        <div className="topbar__id">
          <span className="topbar__name">{meta.list.name}</span>
          <span className="topbar__path">{meta.list.dir}</span>
        </div>
        <nav className="route-nav" aria-label="Primary">
          <Link to="/">Table</Link>
          <Link to="/map">Map</Link>
        </nav>
      </header>

      <section className="review-heading">
        <div>
          <p className="eyebrow">Manual gate</p>
          <h1>Review queue</h1>
          <p>Clear sourced leads before the pipeline spends money enriching them.</p>
        </div>
        <div className="review-shortcuts" aria-label="Keyboard shortcuts">
          <span><kbd>J</kbd>/<kbd>K</kbd> or <kbd>↑</kbd>/<kbd>↓</kbd> move</span>
          <span><kbd>Space</kbd>/<kbd>Enter</kbd> pass</span>
          <span><kbd>X</kbd> drop</span>
          <span><kbd>U</kbd> undo</span>
        </div>
      </section>

      {meta.review_stages.length === 0 ? (
        <section className="review-empty">
          <h2>No review stages configured</h2>
          <p>Add a review step to this list’s pipeline to create a human approval queue.</p>
        </section>
      ) : (
        <>
          <nav className="review-tabs" role="tablist" aria-label="Review stages">
            {meta.review_stages.map((stage) => (
              <button
                className={stage.id === activeStageId ? 'is-active' : ''}
                key={stage.id}
                type="button"
                role="tab"
                aria-selected={stage.id === activeStageId}
                onClick={() => {
                  setActiveStageId(stage.id);
                  setCursor(0);
                }}
              >
                <span>{stage.label}</span>
                <strong>{stage.awaiting_count}</strong>
                {pending.some((decision) => decision.stage_id === stage.id)
                  ? <small>{pending.filter((decision) => decision.stage_id === stage.id).length} pending</small>
                  : null}
              </button>
            ))}
          </nav>

          {activeStage ? (
            <section className="review-stage">
              <div className="review-stage__header">
                <div>
                  <h2>{activeStage.label}</h2>
                  {activeStage.description ? <p>{activeStage.description}</p> : null}
                </div>
                <span>{visibleRecords.length} undecided</span>
              </div>

              <div className="review-controls">
                <label>
                  <span>Default drop reason</span>
                  <input
                    value={dropReason}
                    onChange={(event) => setDropReason(event.target.value)}
                    placeholder={DEFAULT_DROP_REASON}
                  />
                </label>
                <div className="review-controls__actions">
                  <span>{activePending.length} pending</span>
                  <button
                    className="review-undo"
                    type="button"
                    onClick={() => void undoLast()}
                    disabled={history.length === 0 || submitting || undoing}
                  >
                    {undoing ? 'Undoing…' : 'Undo last'}
                  </button>
                  <button
                    className="review-submit"
                    type="button"
                    onClick={() => void submitPending()}
                    disabled={activePending.length === 0 || submitting || undoing}
                  >
                    {submitting ? 'Submitting…' : `Submit ${activePending.length || ''} decision${activePending.length === 1 ? '' : 's'}`}
                  </button>
                </div>
              </div>

              {error ? <div className="error-banner">{error}</div> : null}
              {message ? <div className="review-message" role="status">{message}</div> : null}
              {activeFailures.length > 0 ? (
                <div className="review-failures" role="alert">
                  <strong>{activeFailures.length} decision{activeFailures.length === 1 ? '' : 's'} failed</strong>
                  {activeFailures.map((failure) => (
                    <span key={decisionKey(failure)}>
                      {failure.business_name} ({failure.row_id}): {failure.error}
                    </span>
                  ))}
                </div>
              ) : null}

              {loadingStageId === activeStageId && !queues[activeStageId] ? (
                <div className="review-empty">Loading {activeStage.label}…</div>
              ) : visibleRecords.length === 0 ? (
                <div className="review-empty">
                  <h2>{activePending.length > 0 ? 'All visible leads decided' : 'Nothing awaiting review'}</h2>
                  <p>{activePending.length > 0 ? 'Submit the pending batch to record these decisions.' : 'This stage is clear.'}</p>
                </div>
              ) : (
                <div className="review-card-list">
                  {visibleRecords.map((record, index) => {
                    const id = rowId(record);
                    const selected = index === cursor;
                    return (
                      <article
                        className={`review-card ${selected ? 'is-selected' : ''}`}
                        key={id}
                        ref={(node) => { cardRefs.current[id] = node; }}
                        data-review-row={id}
                        onClick={() => setCursor(index)}
                      >
                        <div className="review-card__identity">
                          <span className="review-card__position">{index + 1}</span>
                          <div>
                            <h3>{displayValue(record.business_name)}</h3>
                            <span>{id}</span>
                          </div>
                          <div className="review-card__actions">
                            <button type="button" onClick={() => { setCursor(index); selectVerdict('pass', record); }}>Pass</button>
                            <button className="is-drop" type="button" onClick={() => { setCursor(index); selectVerdict('drop', record); }}>Drop</button>
                          </div>
                        </div>
                        <dl className="review-card__fields">
                          {activeStage.fields.map((field) => {
                            const value = displayValue(record[field]);
                            return (
                              <div key={field}>
                                <dt>{labelFor(field)}</dt>
                                <dd>
                                  {isWebsiteField(field) && value !== 'n/a'
                                    ? <a href={websiteHref(value)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{value}</a>
                                    : value}
                                </dd>
                              </div>
                            );
                          })}
                        </dl>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}
        </>
      )}
    </main>
  );
};
