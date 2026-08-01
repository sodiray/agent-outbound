import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  completeManualTask,
  fetchManualTasks,
  fetchMeta,
  type ManualTask,
} from './api.js';
import { RouteNav } from './RouteNav.js';
import type { MetaResponse } from './types.js';

const labelFor = (key: string) => key
  .replace(/^_+/, '')
  .split(/[_\s.-]+/)
  .filter(Boolean)
  .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
  .join(' ') || key;

const displayDate = (value: string) => {
  if (!value) return 'n/a';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export const ManualRoute = () => {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [tasks, setTasks] = useState<ManualTask[]>([]);
  const [total, setTotal] = useState(0);
  const [typeFilter, setTypeFilter] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState('');

  const taskKey = (task: ManualTask) => `${task.record_id}::${task.step_id}`;

  const reload = useCallback(async (type = typeFilter) => {
    const page = await fetchManualTasks({ type, limit: 200, offset: 0 });
    setTasks(page.tasks);
    setTotal(page.total);
  }, [typeFilter]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError('');
        const metaRes = await fetchMeta();
        if (cancelled) return;
        setMeta(metaRes);
        await reload('');
      } catch (err) {
        if (!cancelled) setError(String((err as Error)?.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reload]);

  const onFilter = async (type: string) => {
    setTypeFilter(type);
    setError('');
    try {
      await reload(type);
    } catch (err) {
      setError(String((err as Error)?.message || err));
    }
  };

  const act = async (task: ManualTask, skip: boolean) => {
    const key = taskKey(task);
    setBusyKey(key);
    setError('');
    setFlash('');
    try {
      await completeManualTask({
        rowId: task.record_id,
        stepId: task.step_id,
        note: note[key] || '',
        skip,
      });
      setFlash(skip
        ? `Skipped ${task.business_name || task.record_id} · ${task.step_id}`
        : `Completed ${task.business_name || task.record_id} · ${task.step_id}`);
      await reload(typeFilter);
    } catch (err) {
      setError(String((err as Error)?.message || err));
    } finally {
      setBusyKey('');
    }
  };

  if (loading && !meta) {
    return <main className="operator-shell"><div className="loading">{error || 'Loading manual queue...'}</div></main>;
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
          <h1>Manual queue</h1>
          <p>
            Leads parked on manual steps (field visits, physical mail, LinkedIn). Complete or skip
            so the sequence can advance.
          </p>
        </div>
        <div className="operator-heading__stats">
          <span>Awaiting <strong>{total}</strong></span>
        </div>
      </section>

      {error ? <div className="operator-error" role="alert">{error}</div> : null}
      {flash ? <div className="operator-flash" role="status">{flash}</div> : null}

      <section className="operator-toolbar">
        <label>
          <span>Task type</span>
          <select
            value={typeFilter}
            onChange={(event) => { void onFilter(event.target.value); }}
            aria-label="Filter manual tasks by type"
          >
            <option value="">All</option>
            <option value="visit">Visit</option>
            <option value="mail">Mail</option>
            <option value="linkedin">LinkedIn</option>
            <option value="manual">Other</option>
          </select>
        </label>
        <Link className="text-button" to="/sequences">Open sequence board →</Link>
      </section>

      {tasks.length === 0 ? (
        <div className="empty-state" data-testid="manual-empty">
          No awaiting manual tasks{typeFilter ? ` for type “${typeFilter}”` : ''}.
        </div>
      ) : (
        <div className="manual-table-wrap">
          <table className="manual-table" data-testid="manual-queue">
            <thead>
              <tr>
                <th>Business</th>
                <th>Type</th>
                <th>Step</th>
                <th>Contact</th>
                <th>Address</th>
                <th>Parked</th>
                <th>Note</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const key = taskKey(task);
                const busy = busyKey === key;
                return (
                  <tr key={key} data-record-id={task.record_id} data-step-id={task.step_id}>
                    <td>
                      <strong>{task.business_name || 'Unnamed'}</strong>
                      <div className="muted manual-meta">
                        {task.sequence_name || task.pipeline_name || '—'}
                        {' · '}
                        <code>{task.record_id.length > 14 ? `${task.record_id.slice(0, 12)}…` : task.record_id}</code>
                      </div>
                    </td>
                    <td>
                      <span className="chip status-chip is-yellow">{labelFor(task.task_type)}</span>
                    </td>
                    <td>
                      <code>{task.step_id}</code>
                    </td>
                    <td>
                      <div>{task.contact_name || '—'}</div>
                      <div className="muted">{task.contact_email || ''}</div>
                    </td>
                    <td className="manual-address">{task.address || '—'}</td>
                    <td className="manual-parked">{displayDate(task.parked_at)}</td>
                    <td>
                      <input
                        type="text"
                        className="manual-note"
                        placeholder="Optional note"
                        value={note[key] || ''}
                        disabled={busy}
                        onChange={(event) => setNote((prev) => ({ ...prev, [key]: event.target.value }))}
                        aria-label={`Note for ${task.business_name || task.record_id}`}
                      />
                    </td>
                    <td className="manual-actions">
                      <button
                        type="button"
                        className="solid-button"
                        disabled={busy}
                        onClick={() => { void act(task, false); }}
                      >
                        {busy ? '…' : 'Complete'}
                      </button>
                      <button
                        type="button"
                        className="popover-trigger"
                        disabled={busy}
                        onClick={() => { void act(task, true); }}
                      >
                        Skip
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
};
