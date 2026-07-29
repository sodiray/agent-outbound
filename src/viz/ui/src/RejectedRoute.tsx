import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchMeta,
  fetchRejectedRecords,
  fetchRejectedSources,
  restoreRejectedRecord,
} from './api.js';
import type {
  MetaResponse,
  RecordValue,
  RejectedRecord,
  RejectedRecordsResponse,
  RejectedSourcesResponse,
} from './types.js';

const PAGE_SIZE = 50;

const rowId = (record: RejectedRecord) => String(record._row_id || '');

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

const recordName = (record: RejectedRecord) => displayValue(record.business_name) || 'Unnamed lead';

const websiteHref = (value: string) => {
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
};

const formatDate = (value: string) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const restoreInOrder = ({
  records,
  record,
  order,
}: {
  records: RejectedRecord[];
  record: RejectedRecord;
  order: string[];
}) => {
  if (records.some((candidate) => rowId(candidate) === rowId(record))) return records;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...records, record].sort((left, right) => (
    (rank.get(rowId(left)) ?? Number.MAX_SAFE_INTEGER)
    - (rank.get(rowId(right)) ?? Number.MAX_SAFE_INTEGER)
  ));
};

const mechanismMessage = (mechanism: string, record: RejectedRecord) => {
  if (mechanism === 'review_override_cleared') {
    return `Cleared the rejection from ${record.review_stage_label || record.review_stage_id}.`;
  }
  if (mechanism === 'manual_drop_override_cleared') return 'Cleared the manual rejection.';
  return `Added a keep override for ${record.rejection_source_label}.`;
};

export const RejectedRoute = () => {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [summary, setSummary] = useState<RejectedSourcesResponse | null>(null);
  const [queue, setQueue] = useState<RejectedRecordsResponse | null>(null);
  const [source, setSource] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [restoringId, setRestoringId] = useState('');
  const pageOrder = useRef<string[]>([]);
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    Promise.all([fetchMeta(), fetchRejectedSources()])
      .then(([nextMeta, nextSummary]) => {
        setMeta(nextMeta);
        setSummary(nextSummary);
      })
      .catch((nextError: Error) => setError(nextError.message));
  }, []);

  useEffect(() => {
    const request = { cancelled: false };
    setLoading(true);
    setQueue(null);
    setError('');
    fetchRejectedRecords({ source, limit: PAGE_SIZE, offset })
      .then((nextQueue) => {
        if (request.cancelled) return;
        pageOrder.current = nextQueue.records.map(rowId);
        setQueue(nextQueue);
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
  }, [source, offset]);

  const adjustSummary = (record: RejectedRecord, delta: number) => {
    setSummary((current) => current
      ? {
        total: Math.max(0, current.total + delta),
        sources: current.sources.map((item) => (
          item.id === record.rejection_source
            ? { ...item, count: Math.max(0, item.count + delta) }
            : item
        )),
      }
      : current);
  };

  const restore = async (record: RejectedRecord) => {
    const id = rowId(record);
    if (!id || inFlight.current.size > 0 || !queue) return;
    const wasLastVisible = queue.records.length === 1;
    inFlight.current.add(id);
    setRestoringId(id);
    setQueue((current) => current
      ? {
        ...current,
        total: Math.max(0, current.total - 1),
        records: current.records.filter((candidate) => rowId(candidate) !== id),
      }
      : current);
    adjustSummary(record, -1);
    setFailures((current) => Object.fromEntries(
      Object.entries(current).filter(([row]) => row !== id),
    ));
    setError('');
    setMessage(`Restoring ${recordName(record)}…`);

    try {
      const result = await restoreRejectedRecord(id);
      if (!result.restored) {
        throw new Error('The restore action was recorded, but another active rejection still applies.');
      }
      inFlight.current.delete(id);
      setRestoringId('');
      setMessage(`${recordName(record)} restored. ${mechanismMessage(result.mechanism, record)}`);
      if (wasLastVisible && offset > 0) setOffset(Math.max(0, offset - PAGE_SIZE));
    } catch (nextError) {
      inFlight.current.delete(id);
      setRestoringId('');
      setQueue((current) => current
        ? {
          ...current,
          total: current.total + 1,
          records: restoreInOrder({
            records: current.records,
            record,
            order: pageOrder.current,
          }),
        }
        : current);
      adjustSummary(record, 1);
      setFailures((current) => ({
        ...current,
        [id]: `${String((nextError as Error)?.message || nextError)} The row was returned to its original place.`,
      }));
      setMessage('');
    }
  };

  if (!meta || !summary) {
    return <main className="rejected-shell"><div className="loading">{error || 'Loading rejected records...'}</div></main>;
  }

  const total = queue?.total || 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="rejected-shell">
      <header className="topbar">
        <div className="topbar__id">
          <span className="topbar__name">{meta.list.name}</span>
          <span className="topbar__path">{meta.list.dir}</span>
        </div>
        <nav className="route-nav" aria-label="Primary">
          <Link to="/">Table</Link>
          <Link to="/map">Map</Link>
          <Link to="/review">Review</Link>
        </nav>
      </header>

      <section className="rejected-heading">
        <div>
          <p className="eyebrow">Recovery</p>
          <h1>Rejected</h1>
          <p>Inspect filtered leads, see why they were rejected, and restore the exceptions.</p>
        </div>
        <strong>{summary.total} rejected</strong>
      </section>

      <section className="rejected-toolbar">
        <label>
          <span>Rejection source</span>
          <select
            value={source}
            disabled={Boolean(restoringId)}
            onChange={(event) => {
              setSource(event.target.value);
              setOffset(0);
              setFailures({});
              setMessage('');
            }}
          >
            <option value="">All sources ({summary.total})</option>
            {summary.sources.map((item) => (
              <option key={item.id} value={item.id}>{item.label} ({item.count})</option>
            ))}
          </select>
        </label>
        <div className="rejected-pagination">
          <span>Page {page} of {pageCount} · {total} matching</span>
          <button type="button" disabled={offset === 0 || loading || Boolean(restoringId)} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
          <button type="button" disabled={offset + PAGE_SIZE >= total || loading || Boolean(restoringId)} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
        </div>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}
      {message ? <div className="review-message" role="status">{message}</div> : null}
      {Object.keys(failures).length > 0 ? (
        <div className="review-failures" role="alert">
          <strong>{Object.keys(failures).length} restore request{Object.keys(failures).length === 1 ? '' : 's'} failed</strong>
          {Object.entries(failures).map(([id, failure]) => <span key={id}>{failure}</span>)}
        </div>
      ) : null}

      {loading && !queue ? (
        <div className="rejected-empty">Loading rejected records…</div>
      ) : queue && queue.records.length > 0 ? (
        <div className="rejected-row-list">
          {queue.records.map((record) => {
            const id = rowId(record);
            const identity = [
              ['address', record.address],
              ['website', record.website],
              ['phone', record.phone],
            ].filter(([, value]) => hasDisplayValue(value));
            const rejectedAt = formatDate(record.rejected_at);
            return (
              <article className="rejected-row" key={id}>
                <div className="rejected-row__identity">
                  <h2 title={recordName(record)}>{recordName(record)}</h2>
                  {identity.map(([field, rawValue]) => {
                    const value = displayValue(rawValue);
                    return (
                      <span key={String(field)}>
                        {field === 'website'
                          ? <a href={websiteHref(value)} target="_blank" rel="noreferrer">{value}</a>
                          : value}
                      </span>
                    );
                  })}
                </div>
                <div className="rejected-row__source">
                  <strong>{record.rejection_source_label}</strong>
                  {record.review_stage_id ? <span>Review stage: {record.review_stage_label || record.review_stage_id}</span> : null}
                </div>
                <p title={record.rejection_reason || 'No rejection reason recorded'}>
                  {record.rejection_reason || 'No rejection reason recorded'}
                </p>
                {rejectedAt ? <time dateTime={record.rejected_at}>{rejectedAt}</time> : <span />}
                <button type="button" disabled={loading || Boolean(restoringId)} onClick={() => void restore(record)}>
                  {restoringId === id ? 'Restoring…' : 'Restore'}
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="rejected-empty">
          <h2>No rejected records</h2>
          <p>{source ? 'This rejection source is clear.' : 'There are no rejected records to restore.'}</p>
        </div>
      )}
    </main>
  );
};
