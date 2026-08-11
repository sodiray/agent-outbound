import { useEffect, useRef, useState } from 'react';
import { APIProvider, Map as GoogleMap, Marker } from '@vis.gl/react-google-maps';
import {
  clearReviewDecision,
  fetchAllReviewQueue,
  fetchMeta,
  fetchRecordDetail,
  fetchReviewQueue,
  submitReviewDecisions,
} from './api.js';
import { DetailDrawer } from './DetailDrawer.js';
import { RouteNav } from './RouteNav.js';
import type {
  MetaResponse,
  RecordDetail,
  RecordRow,
  RecordValue,
} from './types.js';

const ALL_STAGES_VIEW = 'all';
const stageView = (stageId: string) => `stage:${stageId}`;
const stageIdForView = (view: string) => view.startsWith('stage:') ? view.slice('stage:'.length) : '';

type ReviewActionVerdict = 'approve' | 'reject';

type DecisionHistoryItem = {
  sequence: number;
  stage_id: string;
  row_id: string;
  view: string;
  queue_key: string;
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
const reviewStageIdForRecord = (record: RecordRow) => String(record._review_stage_id ?? '');
const queueRecordKey = (record: RecordRow) => `${reviewStageIdForRecord(record)}:${rowId(record)}`;
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

const recordName = (record: RecordRow) => (
  displayValue(record.business_name) || displayValue(record.name) || 'Unnamed record'
);

const isWebsiteField = (field: string) => field.toLowerCase().includes('website');

const websiteHref = (value: string) => {
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
};

const isTypingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    || Boolean(target.closest('.close-button, .scrim, .review-undo, .review-detail-undo'));
};

const coordinateValue = (value: RecordValue | undefined) => {
  if (!hasDisplayValue(value)) return null;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) ? coordinate : null;
};

const recordCoordinates = (record: RecordRow) => {
  const lat = coordinateValue(record.latitude);
  const lng = coordinateValue(record.longitude);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
};

const rawDisplayValue = (value: RecordValue | undefined) => {
  if (!hasDisplayValue(value)) return '';
  const text = String(value).trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed === null) return '';
    if (Array.isArray(parsed) && parsed.length === 0) return '';
    if (!Array.isArray(parsed) && typeof parsed === 'object' && Object.keys(parsed).length === 0) return '';
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
};

const DetailFieldTable = ({
  record,
  fields,
}: {
  record: RecordRow;
  fields: string[];
}) => {
  const visibleFields = fields.filter((field) => (
    field !== '_row_id'
    && field !== 'business_name'
    && field !== 'name'
    && hasDisplayValue(record[field])
  ));
  if (visibleFields.length === 0) return null;
  return (
    <table className="review-detail-fields">
      <tbody>
        {visibleFields.map((field) => {
          const value = displayValue(record[field]);
          return (
            <tr key={field}>
              <th scope="row">{labelFor(field)}</th>
              <td>
                {isWebsiteField(field)
                  ? <a href={websiteHref(value)} target="_blank" rel="noreferrer">{value}</a>
                  : value}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

const ReviewDetail = ({
  rowIdValue,
  mapsApiKey,
  deciding,
  undoLabel,
  canUndo,
  onApprove,
  onReject,
  onUndo,
}: {
  rowIdValue: string;
  mapsApiKey: string;
  deciding: boolean;
  undoLabel: string;
  canUndo: boolean;
  onApprove: () => void;
  onReject: () => void;
  onUndo: () => void;
}) => {
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const request = { cancelled: false };
    setLoading(true);
    setError('');
    setDetail(null);
    fetchRecordDetail(rowIdValue)
      .then((nextDetail) => {
        if (!request.cancelled) setDetail(nextDetail);
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
  }, [rowIdValue]);

  const record = detail?.record || null;
  const coordinates = record ? recordCoordinates(record) : null;
  const address = record
    ? displayValue(record.address) || displayValue(record.formattedAddress)
    : '';
  const sourcedFields = detail?.field_classification.sourced || [];
  const enrichedFields = detail?.field_classification.enriched || [];
  const rawFields = detail?.field_classification.raw || [];
  const hasSourcedFields = Boolean(record && sourcedFields.some((field) => (
    field !== 'business_name' && field !== 'name' && hasDisplayValue(record[field])
  )));
  const hasEnrichedFields = Boolean(record && enrichedFields.some((field) => (
    field !== 'business_name' && field !== 'name' && hasDisplayValue(record[field])
  )));
  const rawValues = record
    ? rawFields.map((field) => ({ field, value: rawDisplayValue(record[field]) })).filter((item) => item.value)
    : [];

  return (
    <>
      {loading ? <div className="drawer-loading">Loading detail...</div> : null}
      {error ? <div className="error-banner">{error}</div> : null}
      {detail && record ? (
        <>
          <header className="detail-header review-detail-header">
            <div>
              <p className="eyebrow">Awaiting review</p>
              <h2>{recordName(record)}</h2>
              {address ? <p>{address}</p> : null}
            </div>
            <div className="review-detail-action-stack">
              <div className="review-detail-actions">
                <button type="button" onClick={onApprove} disabled={deciding}>
                  {deciding ? 'Saving…' : 'Approve'}
                </button>
                <button className="is-reject" type="button" onClick={onReject} disabled={deciding}>
                  Reject
                </button>
              </div>
              <button
                className="review-detail-undo"
                type="button"
                onClick={onUndo}
                disabled={!canUndo}
              >
                {undoLabel}
              </button>
            </div>
          </header>
          {mapsApiKey && coordinates ? (
            <section className="detail-section">
              <div className="section-title">Location</div>
              <div className="review-detail-map">
                <APIProvider apiKey={mapsApiKey}>
                  <GoogleMap
                    defaultCenter={coordinates}
                    defaultZoom={10}
                    disableDefaultUI
                    gestureHandling="cooperative"
                  >
                    <Marker position={coordinates} />
                  </GoogleMap>
                </APIProvider>
              </div>
            </section>
          ) : null}
          {hasSourcedFields ? (
            <section className="detail-section">
              <div className="section-title">What we know</div>
              <DetailFieldTable record={record} fields={sourcedFields} />
            </section>
          ) : null}
          {hasEnrichedFields ? (
            <section className="detail-section">
              <div className="section-title">Enriched</div>
              <DetailFieldTable record={record} fields={enrichedFields} />
            </section>
          ) : null}
          {rawValues.length > 0 ? (
            <section className="detail-section">
              <div className="section-title">Raw data</div>
              <div className="review-detail-raw">
                {rawValues.map((item) => (
                  <div key={item.field}>
                    <strong>{labelFor(item.field)}</strong>
                    <pre>{item.value}</pre>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </>
  );
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
  if (records.some((candidate) => queueRecordKey(candidate) === queueRecordKey(record))) return records;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...records, record].sort((left, right) => (
    (rank.get(queueRecordKey(left)) ?? Number.MAX_SAFE_INTEGER)
    - (rank.get(queueRecordKey(right)) ?? Number.MAX_SAFE_INTEGER)
  ));
};

const actionLabel = (verdict: ReviewActionVerdict) => verdict === 'approve' ? 'Approve' : 'Reject';
const actionPastTense = (verdict: ReviewActionVerdict) => verdict === 'approve' ? 'Approved' : 'Rejected';
const actionInProgress = (verdict: ReviewActionVerdict) => verdict === 'approve' ? 'Approving' : 'Rejecting';

export const ReviewRoute = () => {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [activeView, setActiveView] = useState('');
  const [allStage, setAllStage] = useState<MetaResponse['review_stages'][number] | null>(null);
  const [sort, setSort] = useState('');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [queues, setQueues] = useState<Record<string, RecordRow[]>>({});
  const [loadingStageId, setLoadingStageId] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<DecisionHistoryItem[]>([]);
  const [failures, setFailures] = useState<DecisionFailure[]>([]);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [panelRecord, setPanelRecord] = useState<RecordRow | null>(null);
  const rowRefs = useRef<Record<string, HTMLElement | null>>({});
  const queueOrder = useRef<Record<string, string[]>>({});
  const loadedQueues = useRef(new Set<string>());
  const inFlightDecisions = useRef(new Set<string>());
  const undoingRef = useRef(false);
  const actionSequence = useRef(0);
  const latestActionSequence = useRef(0);

  useEffect(() => {
    fetchMeta()
      .then((nextMeta) => {
        setMeta(nextMeta);
        setActiveView((current) => (
          current === ALL_STAGES_VIEW || nextMeta.review_stages.some((stage) => stageView(stage.id) === current)
            ? current
            : (nextMeta.review_stages[0] ? stageView(nextMeta.review_stages[0].id) : '')
        ));
      })
      .catch((nextError: Error) => setError(nextError.message));
  }, []);

  useEffect(() => {
    const queueKey = `${activeView}:${sort}:${dir}`;
    if (!activeView || loadedQueues.current.has(queueKey)) return undefined;
    const request = { cancelled: false };
    setLoadingStageId(activeView);
    setError('');
    const stageId = stageIdForView(activeView);
    const fetchQueue = activeView === ALL_STAGES_VIEW
      ? fetchAllReviewQueue({ sort, dir })
      : fetchReviewQueue(stageId, { sort, dir });
    fetchQueue
      .then((queue) => {
        if (request.cancelled) return;
        loadedQueues.current.add(queueKey);
        queueOrder.current[queueKey] = queue.records.map(queueRecordKey);
        setQueues((current) => ({ ...current, [queueKey]: queue.records }));
        if (activeView === ALL_STAGES_VIEW) setAllStage(queue.stage);
        setMeta((current) => current
          ? {
            ...current,
            review_stages: current.review_stages.map((stage) => (
              stage.id === stageId ? { ...stage, ...queue.stage } : stage
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
  }, [activeView, dir, sort]);

  const activeStageId = stageIdForView(activeView);
  const isAllStages = activeView === ALL_STAGES_VIEW;
  const activeQueueKey = `${activeView}:${sort}:${dir}`;
  const activeStage = isAllStages
    ? allStage || {
      id: 'all',
      label: 'All stages',
      description: 'Records awaiting a decision at any configured review stage.',
      fields: [...new Set(meta?.review_stages.flatMap((stage) => stage.fields) || [])],
      awaiting_count: 0,
      sequence_counts: [],
    }
    : meta?.review_stages.find((stage) => stage.id === activeStageId) || null;
  const activeRecords = queues[activeQueueKey] || [];
  const selectedRecord = activeRecords[cursor] || null;
  const activeFailures = isAllStages ? failures : failures.filter((failure) => failure.stage_id === activeStageId);
  const visibleFields = (activeStage?.fields || [])
    .filter((field) => field !== '_row_id' && field !== 'business_name' && field !== 'name');
  const sortFields = ['_row_id', 'business_name', 'name', 'sequence_name', 'routed_by', ...(activeStage?.fields || [])]
    .filter((field, index, fields) => fields.indexOf(field) === index)
    .filter((field) => meta?.columns.some((column) => column.key === field));
  const lastDecision = history.at(-1);
  const panelUndoLabel = !lastDecision
    ? 'Nothing to undo'
    : lastDecision.state === 'saving'
      ? `${actionInProgress(lastDecision.verdict)} ${recordName(lastDecision.record)}…`
      : `Undo: ${actionPastTense(lastDecision.verdict)} ${recordName(lastDecision.record)}`;
  const panelDecision = panelRecord
    ? history.find((item) => (
      item.stage_id === (isAllStages ? reviewStageIdForRecord(panelRecord) : activeStageId)
      && item.row_id === rowId(panelRecord)
      && item.state === 'saving'
    ))
    : null;
  const drawerFailure = (
    panelRecord
      ? activeFailures.find((failure) => failure.row_id === rowId(panelRecord))
      : null
  ) || activeFailures.at(-1);

  useEffect(() => {
    setCursor((current) => Math.max(0, Math.min(current, activeRecords.length - 1)));
  }, [activeRecords.length]);

  useEffect(() => {
    if (!selectedRecord) return;
    rowRefs.current[queueRecordKey(selectedRecord)]?.scrollIntoView({ block: 'nearest' });
  }, [selectedRecord]);

  const adjustAwaitingCount = (stageId: string, delta: number, record: RecordRow) => {
    const sequenceName = displayValue(record.sequence_name) || 'default';
    setMeta((current) => current
      ? {
        ...current,
        review_stages: current.review_stages.map((stage) => (
          stage.id === stageId
            ? {
              ...stage,
              awaiting_count: Math.max(0, stage.awaiting_count + delta),
              sequence_counts: stage.sequence_counts.some((entry) => entry.sequence_name === sequenceName)
                ? stage.sequence_counts
                  .map((entry) => (
                    entry.sequence_name === sequenceName
                      ? { ...entry, count: Math.max(0, entry.count + delta) }
                      : entry
                  ))
                  .filter((entry) => entry.count > 0)
                : [...stage.sequence_counts, { sequence_name: sequenceName, count: Math.max(0, delta) }]
                  .filter((entry) => entry.count > 0),
            }
            : stage
        )),
      }
      : current);
  };

  const adjustAllAwaitingCount = (delta: number) => {
    setAllStage((current) => current
      ? { ...current, awaiting_count: Math.max(0, current.awaiting_count + delta) }
      : current);
  };

  const restoreRecord = (queueKey: string, record: RecordRow) => {
    setQueues((current) => ({
      ...current,
      [queueKey]: restoreRecordInOrder({
        records: current[queueKey] || [],
        record,
        order: queueOrder.current[queueKey] || [],
      }),
    }));
  };

  const removeRecord = (queueKey: string, stageId: string, recordId: string) => {
    setQueues((current) => ({
      ...current,
      [queueKey]: (current[queueKey] || []).filter((record) => (
        rowId(record) !== recordId || (reviewStageIdForRecord(record) && reviewStageIdForRecord(record) !== stageId)
      )),
    }));
  };

  const applyDecision = async (
    verdict: ReviewActionVerdict,
    record: RecordRow | null = panelRecord || selectedRecord,
  ) => {
    if (!record || !activeStage || undoingRef.current) return;
    const stageId = isAllStages ? reviewStageIdForRecord(record) : activeStage.id;
    if (!stageId) return;
    const recordId = rowId(record);
    const key = decisionKey({ stage_id: stageId, row_id: recordId });
    if (inFlightDecisions.current.has(key)) return;
    const recordKey = queueRecordKey(record);
    const changesAllAwaitingCount = isAllStages && !activeRecords.some((candidate) => (
      rowId(candidate) === recordId && queueRecordKey(candidate) !== recordKey
    ));
    const decisionIndex = activeRecords.findIndex((candidate) => queueRecordKey(candidate) === recordKey);
    const remainingRecords = activeRecords.filter((candidate) => queueRecordKey(candidate) !== recordKey);
    const nextIndex = Math.max(0, Math.min(
      decisionIndex < 0 ? cursor : decisionIndex,
      remainingRecords.length - 1,
    ));
    const nextRecord = remainingRecords[nextIndex] || null;
    const decisionCameFromPanel = rowId(panelRecord || {}) === recordId;

    const sequence = actionSequence.current + 1;
    actionSequence.current = sequence;
    latestActionSequence.current = sequence;
    const action: DecisionHistoryItem = {
      sequence,
      stage_id: stageId,
      row_id: recordId,
      view: activeView,
      queue_key: activeQueueKey,
      verdict,
      record,
      state: 'saving',
    };
    inFlightDecisions.current.add(key);
    removeRecord(activeQueueKey, stageId, recordId);
    adjustAwaitingCount(stageId, -1, record);
    if (changesAllAwaitingCount) adjustAllAwaitingCount(-1);
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
      loadedQueues.current.clear();
      loadedQueues.current.add(activeQueueKey);
      setQueues((current) => ({ [activeQueueKey]: current[activeQueueKey] || [] }));
      if (!isAllStages) setAllStage(null);
      if (decisionCameFromPanel) {
        setCursor(nextIndex);
        setPanelRecord(nextRecord);
      }
    } catch (nextError) {
      inFlightDecisions.current.delete(key);
      restoreRecord(activeQueueKey, record);
      adjustAwaitingCount(stageId, 1, record);
      if (changesAllAwaitingCount) adjustAllAwaitingCount(1);
      setCursor(Math.max(0, decisionIndex));
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
    const panelBeforeUndo = panelRecord;
    const viewBeforeUndo = activeView;
    const cursorBeforeUndo = cursor;
    const currentRecords = queues[last.queue_key] || [];
    const restoresAllAwaitingCount = last.view === ALL_STAGES_VIEW && !currentRecords.some((record) => (
      rowId(record) === last.row_id
    ));
    const restoredRecords = restoreRecordInOrder({
      records: currentRecords,
      record: last.record,
      order: queueOrder.current[last.queue_key] || [],
    });
    const restoredIndex = Math.max(0, restoredRecords.findIndex((record) => queueRecordKey(record) === queueRecordKey(last.record)));
    undoingRef.current = true;
    setUndoing(true);
    setError('');
    setFailures((current) => current.filter((failure) => decisionKey(failure) !== key));
    setHistory((current) => current.filter((item) => item.sequence !== last.sequence));
    restoreRecord(last.queue_key, last.record);
    adjustAwaitingCount(last.stage_id, 1, last.record);
    if (restoresAllAwaitingCount) adjustAllAwaitingCount(1);
    setActiveView(last.view);
    setCursor(restoredIndex);
    if (panelRecord) setPanelRecord(last.record);
    setMessage(`Undoing ${actionPastTense(last.verdict).toLowerCase()} decision for ${recordName(last.record)}…`);

    try {
      await clearReviewDecision(last.stage_id, last.row_id);
      setMessage(`Undid ${actionPastTense(last.verdict).toLowerCase()} decision for ${recordName(last.record)}.`);
    } catch (nextError) {
      removeRecord(last.queue_key, last.stage_id, last.row_id);
      adjustAwaitingCount(last.stage_id, -1, last.record);
      if (restoresAllAwaitingCount) adjustAllAwaitingCount(-1);
      setHistory((current) => [...current, last].sort((left, right) => left.sequence - right.sequence));
      setActiveView(viewBeforeUndo);
      setCursor(cursorBeforeUndo);
      setPanelRecord(panelBeforeUndo);
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
      loadedQueues.current.clear();
      loadedQueues.current.add(last.queue_key);
      setQueues((current) => ({ [last.queue_key]: current[last.queue_key] || [] }));
      if (last.view !== ALL_STAGES_VIEW) setAllStage(null);
      undoingRef.current = false;
      setUndoing(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'j' || event.key === 'J' || event.key === 'ArrowDown') {
        event.preventDefault();
        if (panelDecision) return;
        setCursor((current) => {
          const next = Math.min(current + 1, Math.max(0, activeRecords.length - 1));
          if (panelRecord) setPanelRecord(activeRecords[next] || null);
          return next;
        });
        return;
      }
      if (event.key === 'k' || event.key === 'K' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (panelDecision) return;
        setCursor((current) => {
          const next = Math.max(0, current - 1);
          if (panelRecord) setPanelRecord(activeRecords[next] || null);
          return next;
        });
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
        <RouteNav />
      </header>

      <section className="review-heading">
        <div>
          <p className="eyebrow">Manual gate</p>
          <h1>Review queue</h1>
          <p>Make decisions on records awaiting a configured review stage.</p>
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
            <button
              className={isAllStages ? 'is-active' : ''}
              type="button"
              role="tab"
              aria-selected={isAllStages}
              onClick={() => {
                setActiveView(ALL_STAGES_VIEW);
                setCursor(0);
                setPanelRecord(null);
              }}
            >
              <span>All stages</span>
              <strong>{allStage?.awaiting_count ?? '…'}</strong>
            </button>
            {meta.review_stages.map((stage) => (
              <button
                className={stageView(stage.id) === activeView ? 'is-active' : ''}
                key={stage.id}
                type="button"
                role="tab"
                aria-selected={stageView(stage.id) === activeView}
                onClick={() => {
                  setActiveView(stageView(stage.id));
                  setCursor(0);
                  setPanelRecord(null);
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
                  <div className="review-sequence-counts" aria-label="Awaiting review by sequence">
                    {activeStage.sequence_counts.map((entry) => (
                      <span key={entry.sequence_name}>
                        {entry.sequence_name}: <strong>{entry.count}</strong>
                      </span>
                    ))}
                  </div>
                </div>
                <div className="review-stage__actions">
                  <label className="review-sort">
                    <span>Sort by</span>
                    <select
                      value={sort}
                      onChange={(event) => {
                        setSort(event.target.value);
                        setCursor(0);
                        setPanelRecord(null);
                      }}
                    >
                      <option value="">Awaiting since</option>
                      {sortFields.map((field) => <option key={field} value={field}>{labelFor(field)}</option>)}
                    </select>
                  </label>
                  <label className="review-sort">
                    <span>Direction</span>
                    <select value={dir} onChange={(event) => { setDir(event.target.value as 'asc' | 'desc'); setCursor(0); setPanelRecord(null); }}>
                      <option value="asc">Ascending</option>
                      <option value="desc">Descending</option>
                    </select>
                  </label>
                  <span>{isAllStages ? `${activeStage.awaiting_count} unique records` : `${activeRecords.length} awaiting`}</span>
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

              {loadingStageId === activeView && !queues[activeQueueKey] ? (
                <div className="review-empty">Loading {activeStage.label}…</div>
              ) : activeRecords.length === 0 ? (
                <div className="review-empty">
                  <h2>Nothing awaiting review</h2>
                  <p>{isAllStages ? 'Every configured review stage is clear.' : 'This stage is clear.'}</p>
                </div>
              ) : (
                <div className="review-table-shell">
                  <table className="review-table">
                    <thead>
                      <tr>
                        <th className="review-table__position" scope="col">#</th>
                        <th scope="col">Record</th>
                        {isAllStages ? <th scope="col">Awaiting stage</th> : null}
                        {visibleFields.map((field) => <th scope="col" key={field}>{labelFor(field)}</th>)}
                        <th className="review-table__actions" scope="col">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeRecords.map((record, index) => {
                        const selected = index === cursor;
                        return (
                          <tr
                            className={selected ? 'is-selected' : ''}
                            key={queueRecordKey(record)}
                            ref={(node) => { rowRefs.current[queueRecordKey(record)] = node; }}
                            data-review-row={queueRecordKey(record)}
                            onClick={() => {
                              setCursor(index);
                              setPanelRecord(record);
                            }}
                          >
                            <td className="review-table__position">{index + 1}</td>
                            <td className="review-table__identity" title={recordName(record)}>{recordName(record)}</td>
                            {isAllStages ? <td>{displayValue(record._review_stage_label)}</td> : null}
                            {visibleFields.map((field) => {
                              const value = displayValue(record[field]);
                              return (
                                <td key={field} title={value}>
                                  {value && isWebsiteField(field)
                                    ? (
                                      <a
                                        href={websiteHref(value)}
                                        target="_blank"
                                        rel="noreferrer"
                                        onClick={(event) => event.stopPropagation()}
                                      >
                                        {value}
                                      </a>
                                    )
                                    : value}
                                </td>
                              );
                            })}
                            <td className="review-table__actions">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setCursor(index);
                                  void applyDecision('approve', record);
                                }}
                              >
                                Approve
                              </button>
                              <button
                                className="is-reject"
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setCursor(index);
                                  void applyDecision('reject', record);
                                }}
                              >
                                Reject
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}
        </>
      )}
      <DetailDrawer
        open={Boolean(panelRecord)}
        onClose={() => setPanelRecord(null)}
        ariaLabel="Review lead detail"
      >
        {drawerFailure ? (
          <div className="error-banner" role="alert">
            {drawerFailure.action} failed for {drawerFailure.business_name}: {drawerFailure.error} {drawerFailure.detail}
          </div>
        ) : null}
        {panelRecord ? (
          <ReviewDetail
            rowIdValue={rowId(panelRecord)}
            mapsApiKey={meta.mapsApiKey}
            deciding={Boolean(panelDecision)}
            undoLabel={panelUndoLabel}
            canUndo={Boolean(lastDecision && lastDecision.state === 'saved' && !undoing)}
            onApprove={() => void applyDecision('approve', panelRecord)}
            onReject={() => void applyDecision('reject', panelRecord)}
            onUndo={() => void undoLast()}
          />
        ) : null}
      </DetailDrawer>
    </main>
  );
};
