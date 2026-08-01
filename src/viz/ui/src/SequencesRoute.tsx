import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchMeta,
  fetchSequenceBoard,
  fetchSequences,
  type SequenceBoard,
  type SequenceSummary,
} from './api.js';
import { RouteNav } from './RouteNav.js';
import type { MetaResponse } from './types.js';

const labelFor = (key: string) => key
  .replace(/^_+/, '')
  .split(/[_\s.-]+/)
  .filter(Boolean)
  .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
  .join(' ') || key;

const KIND_CLASS: Record<string, string> = {
  send_email: 'is-blue',
  wait: 'is-muted',
  manual_task: 'is-yellow',
  assign: 'is-ghost',
  filter: 'is-ghost',
};

export const SequencesRoute = () => {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [sequences, setSequences] = useState<SequenceSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [board, setBoard] = useState<SequenceBoard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const loadBoard = useCallback(async (name: string) => {
    if (!name) {
      setBoard(null);
      return;
    }
    const next = await fetchSequenceBoard(name);
    setBoard(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError('');
        const [metaRes, seqRes] = await Promise.all([fetchMeta(), fetchSequences()]);
        if (cancelled) return;
        setMeta(metaRes);
        setSequences(seqRes);
        const preferred = seqRes.find((s) => s.name === 'local_field')?.name
          || seqRes.find((s) => !s.manual)?.name
          || seqRes[0]?.name
          || '';
        setSelected(preferred);
        if (preferred) {
          const nextBoard = await fetchSequenceBoard(preferred);
          if (!cancelled) setBoard(nextBoard);
        }
      } catch (err) {
        if (!cancelled) setError(String((err as Error)?.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onSelectSequence = async (name: string) => {
    setSelected(name);
    setError('');
    try {
      await loadBoard(name);
    } catch (err) {
      setError(String((err as Error)?.message || err));
      setBoard(null);
    }
  };

  if (loading && !meta) {
    return <main className="operator-shell"><div className="loading">{error || 'Loading sequences...'}</div></main>;
  }

  return (
    <main className="operator-shell">
      <header className="topbar">
        <div className="topbar__id">
          <span className="topbar__name">{meta?.list.name || 'list'}</span>
          <span className="topbar__path">{meta?.list.dir || ''}</span>
        </div>
        <RouteNav />
      </header>

      <section className="operator-heading">
        <div>
          <p className="eyebrow">Operator</p>
          <h1>Sequence board</h1>
          <p>
            Current-position buckets for each configured sequence. A lead appears only in the
            step it is waiting on — completed earlier steps are not re-listed.
          </p>
        </div>
        <div className="operator-heading__stats">
          {board ? (
            <>
              <span>Assigned <strong>{board.total_assigned}</strong></span>
              <span>Awaiting manual <strong>{board.awaiting_manual}</strong></span>
              <span>Completed <strong>{board.completed}</strong></span>
            </>
          ) : null}
        </div>
      </section>

      {error ? <div className="operator-error" role="alert">{error}</div> : null}

      <section className="operator-toolbar">
        <label>
          <span>Sequence</span>
          <select
            value={selected}
            onChange={(event) => { void onSelectSequence(event.target.value); }}
            aria-label="Select sequence"
          >
            {sequences.length === 0 ? <option value="">No sequences configured</option> : null}
            {sequences.map((seq) => (
              <option key={seq.name} value={seq.name}>
                {seq.name}{seq.manual ? ' (manual)' : ''} · {seq.step_count} steps
              </option>
            ))}
          </select>
        </label>
        <Link className="text-button" to="/manual">Open manual queue →</Link>
      </section>

      {!board || board.buckets.length === 0 ? (
        <div className="empty-state">
          {selected
            ? `No step buckets for “${selected}”. Assign leads to this sequence first.`
            : 'No sequence selected.'}
        </div>
      ) : (
        <div className="sequence-board" data-testid="sequence-board">
          {board.buckets.map((bucket) => (
            <article
              key={bucket.step_id}
              className="sequence-column"
              data-step-id={bucket.step_id}
              data-kind={bucket.kind}
            >
              <header className="sequence-column__head">
                <div>
                  <strong>{labelFor(bucket.step_id.replace(/^[^.]+\./, ''))}</strong>
                  <span className={`chip status-chip ${KIND_CLASS[bucket.kind] || 'is-ghost'}`}>
                    {labelFor(bucket.kind)}
                  </span>
                </div>
                <span className="sequence-column__count" aria-label={`${bucket.count} leads`}>
                  {bucket.count}
                </span>
              </header>
              {bucket.description ? (
                <p className="sequence-column__desc">{bucket.description}</p>
              ) : null}
              <ul className="sequence-column__list">
                {bucket.record_ids.length === 0 ? (
                  <li className="muted sequence-column__empty">Empty</li>
                ) : (
                  bucket.record_ids.map((id) => (
                    <li key={id}>
                      <button
                        type="button"
                        className="sequence-lead"
                        title={id}
                        onClick={() => {
                          window.location.href = `/?q=${encodeURIComponent(id)}`;
                        }}
                      >
                        <code>{id.length > 18 ? `${id.slice(0, 16)}…` : id}</code>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </article>
          ))}
        </div>
      )}
    </main>
  );
};
