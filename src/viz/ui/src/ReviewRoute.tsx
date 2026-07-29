import { useEffect, useRef, useState } from 'react';
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
} from './types.js';

type ReviewActionVerdict = 'approve' | 'reject';

type DecisionHistoryItem = {
  sequence: number;
  stage_id: string;
  row_id: string;
  verdict: ReviewActionVerdict;
  record: RecordRow;
  state: 'saving' | 'saved';
};

type DecisionFailure = {
  stage_id: string;
  row_id: string;
  business_name: string;
  action: string;
  error: string;
  detail: string;
};

const DEFAULT_REJECT_REASON = 'reviewed: not a fit';

const rowId = (record: RecordRow) => String(record._row_id ?? '');
const decisionKey = ({ stage_id, row_id }: { stage_id: string; row_id: string }) => `${stage_id}:${row_id}`;
const labelFor = (key: string) => key
  .replace(/^_+/, '')
  .split(/[_\s-]+/)
  .filter(Boolean)
  .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
  .join(' ') || key;

const hasDisplayValue = (value: RecordValue | undefined) => (
  value !== null
  && value !== undefined
  && (typeof value !== 'string' || value.trim() !== '')
);

const displayValue = (value: RecordValue | undefined) => {
  if (!hasDisplayValue(value)) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
};

const recordName = (record: RecordRow) => displayValue(record.business_name) || 'Unnamed lead';

const isWebsiteField = (field: string) => field.toLowerCase().includes('website');

const websiteHref = (value: string) => {
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
};

const isTypingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName);
};

const restoreRecordInOrder = ({
  records,
  record,
  order,
}: {
  records: RecordRow[];
  record: RecordRow;
  order: string[];
}) => {
  if (records.some((candidate) => rowId(candidate) === rowId(record))) return records;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...records, record].sort((left, right) => (
    (rank.get(rowId(left)) ?? Number.MAX_SAFE_INTEGER)
    - (rank.get(rowId(right)) ?? Number.MAX_SAFE_INTEGER)
  ));
};

const actionLabel = (verdict: ReviewActionVerdict) => verdict === 'approve' ? 'Approve' : 'Reject';
const actionPastTense = (verdict: ReviewActionVerdict) => verdict === 'approve' ? 'Approved' : 'Rejected';
const actionInProgress = (verdict: ReviewActionVerdict) => verdict === 'approve' ? 'Approving' : 'Rejecting';

export const ReviewRoute = () => {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [activeStageId, setActiveStageId] = useState('');
  const [queues, setQueues] = useState<Record<string, RecordRow[]>>({});
  const [loadingStageId, setLoadingStageId] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<DecisionHistoryItem[]>([]);
  const [failures, setFailures] = useState<DecisionFailure[]>([]);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const rowRefs = useRef<Record<string, HTMLElement | null>>({});
  const queueOrder = useRef<Record<string, string[]>>({});
  const loadedStages = useRef(new Set<string>());
  const inFlightDecisions = useRef(new Set<string>());
  const undoingRef = useRef(false);
  const actionSequence = useRef(0);
  const latestActionSequence = useRef(0);

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
    if (!activeStageId || loadedStages.current.has(activeStageId)) return undefined;
    const request = { cancelled: false };
    setLoadingStageId(activeStageId);
    setError('');
    fetchReviewQueue(activeStageId)
      .then((queue) => {
        if (request.cancelled) return;
        loadedStages.current.add(activeStageId);
        queueOrder.current[activeStageId] = queue.records.map(rowId);
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
  const activeRecords = queues[activeStageId] || [];
  const selectedRecord = activeRecords[cursor] || null;
  const activeFailures = failures.filter((failure) => failure.stage_id === activeStageId);
  const visibleFields = (activeStage?.fields || [])
    .filter((field) => field !== '_row_id' && field !== 'business_name');
  const lastDecision = history.at(-1);

  useEffect(() => {
    setCursor((current) => Math.max(0, Math.min(current, activeRecords.length - 1)));
  }, [activeRecords.length]);

  useEffect(() => {
    if (!selectedRecord) return;
    rowRefs.current[rowId(selectedRecord)]?.scrollIntoView({ block: 'nearest' });
  }, [selectedRecord]);

  const adjustAwaitingCount = (stageId: string, delta: number) => {
    setMeta((current) => current
      ? {
        ...current,
        review_stages: current.review_stages.map((stage) => (
          stage.id === stageId
            ? { ...stage, awaiting_count: Math.max(0, stage.awaiting_count + delta) }
            : stage
        )),
      }
      : current);
  };

  const restoreRecord = (stageId: string, record: RecordRow) => {
    setQueues((current) => ({
      ...current,
      [stageId]: restoreRecordInOrder({
        records: current[stageId] || [],
        record,
        order: queueOrder.current[stageId] || [],
      }),
    }));
  };

  const removeRecord = (stageId: string, recordId: string) => {
    setQueues((current) => ({
      ...current,
      [stageId]: (current[stageId] || []).filter((record) => rowId(record) !== recordId),
    }));
  };

  const applyDecision = async (
    verdict: ReviewActionVerdict,
    record: RecordRow | null = selectedRecord,
  ) => {
    if (!record || !activeStage || undoingRef.current) return;
    const stageId = activeStage.id;
    const recordId = rowId(record);
    const key = decisionKey({ stage_id: stageId, row_id: recordId });
    if (inFlightDecisions.current.has(key)) return;

    const sequence = actionSequence.current + 1;
    actionSequence.current = sequence;
    latestActionSequence.current = sequence;
    const action: DecisionHistoryItem = {
      sequence,
      stage_id: stageId,
      row_id: recordId,
      verdict,
      record,
      state: 'saving',
    };
    inFlightDecisions.current.add(key);
    removeRecord(stageId, recordId);
    adjustAwaitingCount(stageId, -1);
    setHistory((current) => [...current, action]);
    setFailures((current) => current.filter((failure) => decisionKey(failure) !== key));
    setError('');
    setMessage(`${actionInProgress(verdict)} ${recordName(record)}…`);

    try {
      const response = await submitReviewDecisions(stageId, [{
        row_id: recordId,
        verdict,
        reason: verdict === 'reject' ? DEFAULT_REJECT_REASON : undefined,
      }]);
      const result = response.results[0];
      if (!result?.ok) throw new Error(String(result?.error || 'The decision was not applied.'));
      inFlightDecisions.current.delete(key);
      setHistory((current) => current.map((item) => (
        item.sequence === sequence ? { ...item, state: 'saved' } : item
      )));
      if (latestActionSequence.current === sequence) {
        setMessage(`${actionPastTense(verdict)} ${recordName(record)}.`);
      }
    } catch (nextError) {
      inFlightDecisions.current.delete(key);
      restoreRecord(stageId, record);
      adjustAwaitingCount(stageId, 1);
      setHistory((current) => current.filter((item) => item.sequence !== sequence));
      setFailures((current) => [
        ...current.filter((failure) => decisionKey(failure) !== key),
        {
          stage_id: stageId,
          row_id: recordId,
          business_name: recordName(record),
          action: actionLabel(verdict),
          error: String((nextError as Error)?.message || nextError),
          detail: 'The lead was restored to its original place.',
        },
      ]);
      if (latestActionSequence.current === sequence) setMessage('');
    }
  };

  const undoLast = async () => {
    const last = history.at(-1);
    if (!last) {
      setMessage('Nothing to undo.');
      return;
    }
    if (last.state === 'saving') {
      setMessage('Wait for the current decision to finish before undoing it.');
      return;
    }
    if (undoingRef.current) return;

    const key = decisionKey(last);
    undoingRef.current = true;
    setUndoing(true);
    setError('');
    setFailures((current) => current.filter((failure) => decisionKey(failure) !== key));
    setHistory((current) => current.filter((item) => item.sequence !== last.sequence));
    restoreRecord(last.stage_id, last.record);
    adjustAwaitingCount(last.stage_id, 1);
    setActiveStageId(last.stage_id);
    setMessage(`Undoing ${actionPastTense(last.verdict).toLowerCase()} decision for ${recordName(last.record)}…`);

    try {
      await clearReviewDecision(last.stage_id, last.row_id);
      setMessage(`Undid ${actionPastTense(last.verdict).toLowerCase()} decision for ${recordName(last.record)}.`);
    } catch (nextError) {
      removeRecord(last.stage_id, last.row_id);
      adjustAwaitingCount(last.stage_id, -1);
      setHistory((current) => [...current, last].sort((left, right) => left.sequence - right.sequence));
      setFailures((current) => [
        ...current.filter((failure) => decisionKey(failure) !== key),
        {
          stage_id: last.stage_id,
          row_id: last.row_id,
          business_name: displayValue(last.record.business_name),
          action: 'Undo',
          error: String((nextError as Error)?.message || nextError),
          detail: 'The decision remains in effect.',
        },
      ]);
      setMessage('');
    } finally {
      undoingRef.current = false;
      setUndoing(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'j' || event.key === 'J' || event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((current) => Math.min(current + 1, Math.max(0, activeRecords.length - 1)));
        return;
      }
      if (event.key === 'k' || event.key === 'K' || event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((current) => Math.max(0, current - 1));
        return;
      }
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        void applyDecision('approve');
        return;
      }
      if (event.key === 'x' || event.key === 'X') {
        event.preventDefault();
        void applyDecision('reject');
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
          <Link to="/rejected">Rejected</Link>
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
          <span><kbd>Space</kbd>/<kbd>Enter</kbd> approve</span>
          <span><kbd>X</kbd> reject</span>
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
                <div className="review-stage__actions">
                  <span>{activeRecords.length} awaiting</span>
                  <button
                    className="review-undo"
                    type="button"
                    onClick={() => void undoLast()}
                    disabled={!lastDecision || lastDecision.state === 'saving' || undoing}
                  >
                    {undoing ? 'Undoing…' : 'Undo last'}
                  </button>
                </div>
              </div>

              {error ? <div className="error-banner">{error}</div> : null}
              {message ? <div className="review-message" role="status">{message}</div> : null}
              {activeFailures.length > 0 ? (
                <div className="review-failures" role="alert">
                  <strong>{activeFailures.length} request{activeFailures.length === 1 ? '' : 's'} failed</strong>
                  {activeFailures.map((failure) => (
                    <span key={decisionKey(failure)}>
                      {failure.action} failed for {failure.business_name} ({failure.row_id}): {failure.error} {failure.detail}
                    </span>
                  ))}
                </div>
              ) : null}

              {loadingStageId === activeStageId && !queues[activeStageId] ? (
                <div className="review-empty">Loading {activeStage.label}…</div>
              ) : activeRecords.length === 0 ? (
                <div className="review-empty">
                  <h2>Nothing awaiting review</h2>
                  <p>This stage is clear.</p>
                </div>
              ) : (
                <div className="review-row-list">
                  {activeRecords.map((record, index) => {
                    const id = rowId(record);
                    const selected = index === cursor;
                    const rowFields = visibleFields.filter((field) => hasDisplayValue(record[field]));
                    return (
                      <article
                        className={`review-row ${selected ? 'is-selected' : ''} ${rowFields.length === 0 ? 'has-no-fields' : ''}`}
                        key={id}
                        ref={(node) => { rowRefs.current[id] = node; }}
                        data-review-row={id}
                        onClick={() => setCursor(index)}
                      >
                        <div className="review-row__identity">
                          <span className="review-row__position">{index + 1}</span>
                          <h3 title={recordName(record)}>{recordName(record)}</h3>
                        </div>
                        <dl className="review-row__fields">
                          {rowFields.map((field) => {
                            const value = displayValue(record[field]);
                            return (
                              <div key={field}>
                                <dt>{labelFor(field)}</dt>
                                <dd>
                                  {isWebsiteField(field)
                                    ? <a href={websiteHref(value)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{value}</a>
                                    : value}
                                </dd>
                              </div>
                            );
                          })}
                        </dl>
                        <div className="review-row__actions">
                          <button type="button" onClick={() => { setCursor(index); void applyDecision('approve', record); }}>Approve</button>
                          <button className="is-reject" type="button" onClick={() => { setCursor(index); void applyDecision('reject', record); }}>Reject</button>
                        </div>
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
