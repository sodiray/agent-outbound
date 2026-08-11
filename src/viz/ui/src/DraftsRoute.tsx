import { useEffect, useRef, useState } from 'react';
import { APIProvider, Map as GoogleMap, Marker } from '@vis.gl/react-google-maps';
import {
  approveDraft,
  editDraft,
  fetchDraftDetail,
  fetchDrafts,
  fetchMeta,
  fetchRecordDetail,
  rejectDraft,
} from './api.js';
import { DetailDrawer } from './DetailDrawer.js';
import { RouteNav } from './RouteNav.js';
import {
  canRenderReviewDetailMap,
  reviewDetailHref,
  reviewDetailLinkText,
  type ResolvedReviewDetailSection,
  type ReviewDetailSection,
} from '../../review-detail.js';
import { reviewLabelFor } from '../../review-presentation.js';
import type {
  DraftRow,
  MetaResponse,
  RecordDetail,
  RecordRow,
  RecordValue,
} from './types.js';

const STATUS_TABS = [
  { id: 'pending_approval', label: 'Pending approval' },
  { id: 'ready', label: 'Ready' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'sent', label: 'Sent' },
] as const;

type DraftStatus = typeof STATUS_TABS[number]['id'];
type DraftActionVerdict = 'approve' | 'reject';

type ActionHistoryItem = {
  sequence: number;
  draft_id: string;
  status_filter: DraftStatus;
  verdict: DraftActionVerdict;
  draft: DraftRow;
  state: 'saving' | 'saved';
};

type ActionFailure = {
  draft_id: string;
  draft_label: string;
  action: string;
  error: string;
  detail: string;
};

const DEFAULT_REJECT_REASON = 'draft_rejected';
const labelFor = reviewLabelFor;

const draftId = (draft: DraftRow) => String(draft.draft_id || '');
const draftLabel = (draft: DraftRow) => (
  String(draft.business_name || '').trim()
  || String(draft.subject || '').trim()
  || draftId(draft)
);

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

const isTypingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    || Boolean(target.closest('.close-button, .scrim, .review-undo, .review-detail-undo, .draft-edit-form'));
};

const DetailValue = ({
  renderer,
  value,
  linkText,
}: {
  renderer: 'text' | 'link' | 'email' | 'phone';
  value: string;
  linkText?: string;
}) => {
  if (renderer === 'text') return value;
  return (
    <a
      href={reviewDetailHref({ renderer, value })}
      title={renderer === 'link' ? value : undefined}
      target={renderer === 'link' ? '_blank' : undefined}
      rel={renderer === 'link' ? 'noreferrer' : undefined}
    >
      {reviewDetailLinkText({ renderer, value, linkText })}
    </a>
  );
};

const DeclaredDetailSections = ({
  sections,
  mapsApiKey,
}: {
  sections: ResolvedReviewDetailSection[];
  mapsApiKey: string;
}) => (
  <>
    {sections.filter((section) => (
      section.kind !== 'map'
      || canRenderReviewDetailMap({ mapsApiKey, coordinates: section.coordinates })
    )).map((section, sectionIndex) => (
      <section className="detail-section" key={`${section.title}-${sectionIndex}`}>
        <div className="section-title">{section.title}</div>
        {section.kind === 'fields' ? (
          <table className="review-detail-fields">
            <tbody>
              {section.items.map((item) => (
                <tr key={item.field}>
                  <th scope="row">{item.label || labelFor(item.field)}</th>
                  <td>
                    <DetailValue renderer={item.renderer} value={item.value} linkText={item.link_text} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {section.kind === 'list' ? (
          <ul className="review-detail-list">
            {section.items.map((item, index) => (
              <li key={`${item}-${index}`}>
                <DetailValue renderer={section.renderer} value={item} linkText={section.link_text} />
              </li>
            ))}
          </ul>
        ) : null}
        {section.kind === 'table' ? (
          <table className="review-detail-fields review-detail-entity-table">
            <thead>
              <tr>
                {section.columns.map((column) => (
                  <th key={column.field} scope="col">{column.label || labelFor(column.field)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((value, columnIndex) => (
                    <td key={section.columns[columnIndex].field}>
                      {value === null
                        ? '—'
                        : (
                          <DetailValue
                            renderer={section.columns[columnIndex].renderer}
                            value={value}
                            linkText={section.columns[columnIndex].link_text}
                          />
                        )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {section.kind === 'map' ? (
          <div className="review-detail-map">
            <APIProvider apiKey={mapsApiKey}>
              <GoogleMap
                defaultCenter={section.coordinates}
                defaultZoom={10}
                disableDefaultUI
                gestureHandling="cooperative"
              >
                <Marker position={section.coordinates} />
              </GoogleMap>
            </APIProvider>
          </div>
        ) : null}
        {section.kind === 'embed' ? (
          <>
            <div className="review-detail-embed">
              <iframe
                src={section.url}
                title={`${section.title} preview`}
                loading="lazy"
                sandbox=""
                referrerPolicy="no-referrer"
                tabIndex={-1}
              />
              <a
                className="review-detail-embed__open"
                href={section.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${section.title} in a new tab`}
              >
                Open in new tab
              </a>
            </div>
            <p className="review-detail-embed__notice">
              Preview may be blocked by the site.{' '}
              <a href={section.url} target="_blank" rel="noopener noreferrer">Open website in a new tab.</a>
            </p>
          </>
        ) : null}
      </section>
    ))}
  </>
);

const FallbackRecordFields = ({
  record,
  fields,
  title,
}: {
  record: RecordRow;
  fields: string[];
  title: string;
}) => {
  const visible = fields.filter((field) => field !== '_row_id' && hasDisplayValue(record[field]));
  if (visible.length === 0) return null;
  return (
    <section className="detail-section">
      <div className="section-title">{title}</div>
      <table className="review-detail-fields">
        <tbody>
          {visible.map((field) => (
            <tr key={field}>
              <th scope="row">{labelFor(field)}</th>
              <td>{displayValue(record[field])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

const DraftDetailPanel = ({
  draft,
  mapsApiKey,
  deciding,
  canDecide,
  onApprove,
  onReject,
  onEdited,
}: {
  draft: DraftRow;
  mapsApiKey: string;
  deciding: boolean;
  canDecide: boolean;
  onApprove: () => void;
  onReject: () => void;
  onEdited: (next: DraftRow) => void;
}) => {
  const [detailSections, setDetailSections] = useState<ResolvedReviewDetailSection[] | null>(
    draft.detail_sections || null,
  );
  const [detailDeclaration, setDetailDeclaration] = useState<ReviewDetailSection[] | undefined>(
    draft.detail_declaration,
  );
  const [recordDetail, setRecordDetail] = useState<RecordDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState(String(draft.subject || ''));
  const [editBody, setEditBody] = useState(String(draft.body || ''));
  const [savingEdit, setSavingEdit] = useState(false);
  const [localDraft, setLocalDraft] = useState(draft);

  useEffect(() => {
    setLocalDraft(draft);
    setEditSubject(String(draft.subject || ''));
    setEditBody(String(draft.body || ''));
    setEditing(false);
    setDetailSections(draft.detail_sections || null);
    setDetailDeclaration(draft.detail_declaration);
  }, [draft]);

  useEffect(() => {
    const request = { cancelled: false };
    setLoading(true);
    setError('');
    setRecordDetail(null);
    const rowId = String(localDraft.row_id || '');
    Promise.all([
      fetchDraftDetail(draftId(localDraft)),
      rowId ? fetchRecordDetail(rowId).catch(() => null) : Promise.resolve(null),
    ])
      .then(([detail, nextRecordDetail]) => {
        if (request.cancelled) return;
        setLocalDraft(detail.draft);
        setDetailSections(detail.detail_sections || detail.draft.detail_sections || null);
        setDetailDeclaration(detail.detail_declaration || detail.draft.detail_declaration);
        setRecordDetail(nextRecordDetail);
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
  }, [localDraft.draft_id, localDraft.row_id]);

  const equivalence = localDraft.content_equivalence;
  const hasDeclaredDetail = detailDeclaration !== undefined;
  const record = recordDetail?.record || null;
  const pending = String(localDraft.status || '') === 'pending_approval';

  const saveEdit = async () => {
    setSavingEdit(true);
    setError('');
    try {
      await editDraft(draftId(localDraft), {
        subject: editSubject,
        body: editBody,
      });
      const refreshed = await fetchDraftDetail(draftId(localDraft));
      setLocalDraft(refreshed.draft);
      setDetailSections(refreshed.detail_sections || null);
      setDetailDeclaration(refreshed.detail_declaration);
      onEdited(refreshed.draft);
      setEditing(false);
    } catch (nextError) {
      setError(String((nextError as Error)?.message || nextError));
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <>
      {loading ? <div className="drawer-loading">Loading draft…</div> : null}
      {error ? <div className="error-banner">{error}</div> : null}
      <header className="detail-header review-detail-header">
        <div>
          <p className="eyebrow">
            {pending ? 'Awaiting draft approval' : labelFor(String(localDraft.status || 'draft'))}
          </p>
          <h2>{draftLabel(localDraft)}</h2>
          <p className="draft-detail-meta">
            {[
              localDraft.channel ? labelFor(String(localDraft.channel)) : '',
              localDraft.step_id ? String(localDraft.step_id) : '',
              localDraft.sequence_name ? String(localDraft.sequence_name) : '',
            ].filter(Boolean).join(' · ')}
          </p>
        </div>
        {canDecide && pending ? (
          <div className="review-detail-action-stack">
            <div className="review-detail-actions">
              <button className="is-reject" type="button" onClick={onReject} disabled={deciding || savingEdit}>
                Reject
              </button>
              <button type="button" onClick={onApprove} disabled={deciding || savingEdit}>
                {deciding ? 'Saving…' : 'Approve'}
              </button>
            </div>
          </div>
        ) : null}
      </header>

      {equivalence && equivalence.status === 'changed' ? (
        <div className="review-failures" role="alert">
          <strong>Rendered content has changed</strong>
          <span>
            {equivalence.reason || 'The draft no longer matches the current template render.'}
            {' '}
            Approving still freezes this draft text, but send will refuse if it diverges further.
          </span>
        </div>
      ) : null}
      {equivalence && equivalence.status === 'human_edited' ? (
        <div className="review-message" role="status">
          Hand-edited body is authoritative and is not re-derived from config.
        </div>
      ) : null}

      <section className="detail-section draft-message-section">
        <div className="section-title">Message</div>
        {editing ? (
          <div className="draft-edit-form">
            <label>
              <span>Subject</span>
              <input
                value={editSubject}
                onChange={(event) => setEditSubject(event.target.value)}
                disabled={savingEdit}
              />
            </label>
            <label>
              <span>Body</span>
              <textarea
                value={editBody}
                onChange={(event) => setEditBody(event.target.value)}
                rows={14}
                disabled={savingEdit}
              />
            </label>
            <div className="draft-edit-actions">
              <button type="button" onClick={() => setEditing(false)} disabled={savingEdit}>
                Cancel
              </button>
              <button type="button" onClick={() => void saveEdit()} disabled={savingEdit}>
                {savingEdit ? 'Saving…' : 'Save edit'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="draft-message">
              <div className="draft-message__subject">
                <span className="draft-message__label">Subject</span>
                <strong>{String(localDraft.subject || '—')}</strong>
              </div>
              <div className="draft-message__body">
                <span className="draft-message__label">Body</span>
                <pre>{String(localDraft.body || '—')}</pre>
              </div>
            </div>
            {pending ? (
              <button
                className="draft-edit-toggle"
                type="button"
                onClick={() => setEditing(true)}
                disabled={deciding}
              >
                Edit message
              </button>
            ) : null}
          </>
        )}
      </section>

      {hasDeclaredDetail && detailSections ? (
        <DeclaredDetailSections sections={detailSections} mapsApiKey={mapsApiKey} />
      ) : null}
      {!hasDeclaredDetail && record ? (
        <>
          <FallbackRecordFields
            record={record}
            fields={recordDetail?.field_classification.sourced || []}
            title="What we know"
          />
          <FallbackRecordFields
            record={record}
            fields={recordDetail?.field_classification.enriched || []}
            title="Enriched"
          />
        </>
      ) : null}
      {!hasDeclaredDetail && !record && localDraft.business_name ? (
        <section className="detail-section">
          <div className="section-title">Record</div>
          <table className="review-detail-fields">
            <tbody>
              <tr>
                <th scope="row">Business</th>
                <td>{String(localDraft.business_name)}</td>
              </tr>
              <tr>
                <th scope="row">Record</th>
                <td>{String(localDraft.row_id || '')}</td>
              </tr>
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
};

const restoreDraftInOrder = ({
  drafts,
  draft,
  order,
}: {
  drafts: DraftRow[];
  draft: DraftRow;
  order: string[];
}) => {
  if (drafts.some((candidate) => draftId(candidate) === draftId(draft))) return drafts;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...drafts, draft].sort((left, right) => (
    (rank.get(draftId(left)) ?? Number.MAX_SAFE_INTEGER)
    - (rank.get(draftId(right)) ?? Number.MAX_SAFE_INTEGER)
  ));
};

const actionLabel = (verdict: DraftActionVerdict) => (verdict === 'approve' ? 'Approve' : 'Reject');
const actionPastTense = (verdict: DraftActionVerdict) => (verdict === 'approve' ? 'Approved' : 'Rejected');
const actionInProgress = (verdict: DraftActionVerdict) => (verdict === 'approve' ? 'Approving' : 'Rejecting');

export const DraftsRoute = () => {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [statusFilter, setStatusFilter] = useState<DraftStatus>('pending_approval');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [queues, setQueues] = useState<Record<string, DraftRow[]>>({});
  const [loadingStatus, setLoadingStatus] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<ActionHistoryItem[]>([]);
  const [failures, setFailures] = useState<ActionFailure[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [panelDraft, setPanelDraft] = useState<DraftRow | null>(null);
  const rowRefs = useRef<Record<string, HTMLElement | null>>({});
  const queueOrder = useRef<Record<string, string[]>>({});
  const loadedQueues = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const actionSequence = useRef(0);
  const latestActionSequence = useRef(0);

  useEffect(() => {
    fetchMeta()
      .then(setMeta)
      .catch((nextError: Error) => setError(nextError.message));
  }, []);

  useEffect(() => {
    if (loadedQueues.current.has(statusFilter)) return undefined;
    const request = { cancelled: false };
    setLoadingStatus(statusFilter);
    setError('');
    fetchDrafts({ status: statusFilter, limit: 500, offset: 0 })
      .then((page) => {
        if (request.cancelled) return;
        loadedQueues.current.add(statusFilter);
        queueOrder.current[statusFilter] = page.drafts.map(draftId);
        setQueues((current) => ({ ...current, [statusFilter]: page.drafts }));
        setCounts(page.counts || {});
      })
      .catch((nextError: Error) => {
        if (!request.cancelled) setError(nextError.message);
      })
      .finally(() => {
        if (!request.cancelled) setLoadingStatus('');
      });
    return () => {
      request.cancelled = true;
    };
  }, [statusFilter]);

  const activeDrafts = queues[statusFilter] || [];
  const selectedDraft = activeDrafts[cursor] || null;
  const canDecide = statusFilter === 'pending_approval';
  const panelDecision = panelDraft
    ? history.find((item) => item.draft_id === draftId(panelDraft) && item.state === 'saving')
    : null;
  const drawerFailure = (
    panelDraft
      ? failures.find((failure) => failure.draft_id === draftId(panelDraft))
      : null
  ) || failures.at(-1);

  useEffect(() => {
    setCursor((current) => Math.max(0, Math.min(current, activeDrafts.length - 1)));
  }, [activeDrafts.length]);

  useEffect(() => {
    if (!selectedDraft) return;
    rowRefs.current[draftId(selectedDraft)]?.scrollIntoView({ block: 'nearest' });
  }, [selectedDraft]);

  const adjustCount = (status: string, delta: number) => {
    setCounts((current) => ({
      ...current,
      [status]: Math.max(0, Number(current[status] || 0) + delta),
    }));
  };

  const removeDraft = (status: string, id: string) => {
    setQueues((current) => ({
      ...current,
      [status]: (current[status] || []).filter((draft) => draftId(draft) !== id),
    }));
  };

  const restoreDraft = (status: string, draft: DraftRow) => {
    setQueues((current) => ({
      ...current,
      [status]: restoreDraftInOrder({
        drafts: current[status] || [],
        draft,
        order: queueOrder.current[status] || [],
      }),
    }));
  };

  const applyDecision = async (
    verdict: DraftActionVerdict,
    draft: DraftRow | null = panelDraft || selectedDraft,
  ) => {
    if (!draft || !canDecide) return;
    const id = draftId(draft);
    if (!id || inFlight.current.has(id)) return;

    const decisionIndex = activeDrafts.findIndex((candidate) => draftId(candidate) === id);
    const remaining = activeDrafts.filter((candidate) => draftId(candidate) !== id);
    const nextIndex = Math.max(0, Math.min(
      decisionIndex < 0 ? cursor : decisionIndex,
      remaining.length - 1,
    ));
    const nextDraft = remaining[nextIndex] || null;
    const fromPanel = draftId(panelDraft || { draft_id: '' } as DraftRow) === id;

    const sequence = actionSequence.current + 1;
    actionSequence.current = sequence;
    latestActionSequence.current = sequence;
    const action: ActionHistoryItem = {
      sequence,
      draft_id: id,
      status_filter: statusFilter,
      verdict,
      draft,
      state: 'saving',
    };
    inFlight.current.add(id);
    removeDraft(statusFilter, id);
    adjustCount(statusFilter, -1);
    if (verdict === 'approve') adjustCount('ready', 1);
    if (verdict === 'reject') adjustCount('rejected', 1);
    setHistory((current) => [...current, action]);
    setFailures((current) => current.filter((failure) => failure.draft_id !== id));
    setError('');
    setMessage(`${actionInProgress(verdict)} ${draftLabel(draft)}…`);

    try {
      if (verdict === 'approve') {
        await approveDraft(id);
      } else {
        await rejectDraft(id, DEFAULT_REJECT_REASON);
      }
      inFlight.current.delete(id);
      setHistory((current) => current.map((item) => (
        item.sequence === sequence ? { ...item, state: 'saved' } : item
      )));
      if (latestActionSequence.current === sequence) {
        setMessage(`${actionPastTense(verdict)} ${draftLabel(draft)}.`);
      }
      loadedQueues.current.clear();
      loadedQueues.current.add(statusFilter);
      setQueues((current) => ({ [statusFilter]: current[statusFilter] || [] }));
      if (fromPanel) {
        setCursor(nextIndex);
        setPanelDraft(nextDraft);
      }
    } catch (nextError) {
      inFlight.current.delete(id);
      restoreDraft(statusFilter, draft);
      adjustCount(statusFilter, 1);
      if (verdict === 'approve') adjustCount('ready', -1);
      if (verdict === 'reject') adjustCount('rejected', -1);
      setCursor(Math.max(0, decisionIndex));
      setHistory((current) => current.filter((item) => item.sequence !== sequence));
      setFailures((current) => [
        ...current.filter((failure) => failure.draft_id !== id),
        {
          draft_id: id,
          draft_label: draftLabel(draft),
          action: actionLabel(verdict),
          error: String((nextError as Error)?.message || nextError),
          detail: 'The draft was restored to its original place.',
        },
      ]);
      if (latestActionSequence.current === sequence) setMessage('');
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'j' || event.key === 'J' || event.key === 'ArrowDown') {
        event.preventDefault();
        if (panelDecision) return;
        setCursor((current) => {
          const next = Math.min(current + 1, Math.max(0, activeDrafts.length - 1));
          if (panelDraft) setPanelDraft(activeDrafts[next] || null);
          return next;
        });
        return;
      }
      if (event.key === 'k' || event.key === 'K' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (panelDecision) return;
        setCursor((current) => {
          const next = Math.max(0, current - 1);
          if (panelDraft) setPanelDraft(activeDrafts[next] || null);
          return next;
        });
        return;
      }
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (selectedDraft) setPanelDraft(selectedDraft);
        return;
      }
      if ((event.key === 'a' || event.key === 'A') && canDecide) {
        event.preventDefault();
        void applyDecision('approve');
        return;
      }
      if ((event.key === 'x' || event.key === 'X') && canDecide) {
        event.preventDefault();
        void applyDecision('reject');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!meta) {
    return <main className="review-shell"><div className="loading">{error || 'Loading drafts…'}</div></main>;
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
          <p className="eyebrow">Human gate</p>
          <h1>Draft approval</h1>
          <p>Approve or reject outbound messages before they leave the system.</p>
        </div>
        <div className="review-shortcuts" aria-label="Keyboard shortcuts">
          <span><kbd>J</kbd>/<kbd>K</kbd> or <kbd>↑</kbd>/<kbd>↓</kbd> move</span>
          <span><kbd>Space</kbd>/<kbd>Enter</kbd> open</span>
          {canDecide ? (
            <>
              <span><kbd>A</kbd> approve</span>
              <span><kbd>X</kbd> reject</span>
            </>
          ) : null}
        </div>
      </section>

      <nav className="review-tabs" role="tablist" aria-label="Draft status">
        {STATUS_TABS.map((tab) => (
          <button
            className={statusFilter === tab.id ? 'is-active' : ''}
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={statusFilter === tab.id}
            onClick={() => {
              setStatusFilter(tab.id);
              setCursor(0);
              setPanelDraft(null);
            }}
          >
            <span>{tab.label}</span>
            <strong>{counts[tab.id] ?? '…'}</strong>
          </button>
        ))}
      </nav>

      <section className="review-stage">
        <div className="review-stage__header">
          <div>
            <h2>{STATUS_TABS.find((tab) => tab.id === statusFilter)?.label || statusFilter}</h2>
            <p>
              {statusFilter === 'pending_approval'
                ? 'These messages are parked until a human approves the exact text.'
                : 'Historical drafts filtered by status.'}
            </p>
          </div>
          <div className="review-stage__actions">
            <span>{activeDrafts.length} shown</span>
          </div>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}
        {message ? <div className="review-message" role="status">{message}</div> : null}
        {failures.length > 0 ? (
          <div className="review-failures" role="alert">
            <strong>{failures.length} request{failures.length === 1 ? '' : 's'} failed</strong>
            {failures.map((failure) => (
              <span key={failure.draft_id}>
                {failure.action} failed for {failure.draft_label} ({failure.draft_id}): {failure.error} {failure.detail}
              </span>
            ))}
          </div>
        ) : null}

        {loadingStatus === statusFilter && !queues[statusFilter] ? (
          <div className="review-empty">Loading drafts…</div>
        ) : activeDrafts.length === 0 ? (
          <div className="review-empty">
            <h2>No drafts</h2>
            <p>
              {statusFilter === 'pending_approval'
                ? 'Nothing is waiting for approval.'
                : 'No drafts in this status.'}
            </p>
          </div>
        ) : (
          <div className="review-table-shell">
            <table className="review-table">
              <thead>
                <tr>
                  <th className="review-table__position" scope="col">#</th>
                  <th scope="col">Record</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Step</th>
                  <th scope="col">Content</th>
                  {canDecide ? <th className="review-table__actions" scope="col">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {activeDrafts.map((draft, index) => {
                  const selected = index === cursor;
                  const equivalence = draft.content_equivalence?.status || '';
                  return (
                    <tr
                      className={selected ? 'is-selected' : ''}
                      key={draftId(draft)}
                      ref={(node) => { rowRefs.current[draftId(draft)] = node; }}
                      onClick={() => {
                        setCursor(index);
                        setPanelDraft(draft);
                      }}
                    >
                      <td className="review-table__position">{index + 1}</td>
                      <td className="review-table__identity" title={draftLabel(draft)}>
                        {draftLabel(draft)}
                      </td>
                      <td title={String(draft.subject || '')}>{String(draft.subject || '—')}</td>
                      <td>{String(draft.channel || '—')}</td>
                      <td>{String(draft.step_id || '—')}</td>
                      <td>
                        {equivalence === 'changed'
                          ? 'Changed'
                          : equivalence === 'human_edited'
                            ? 'Edited'
                            : equivalence === 'matches'
                              ? 'Matches'
                              : String(draft.content_source || '—')}
                      </td>
                      {canDecide ? (
                        <td className="review-table__actions">
                          <button
                            className="is-reject"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setCursor(index);
                              void applyDecision('reject', draft);
                            }}
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setCursor(index);
                              void applyDecision('approve', draft);
                            }}
                          >
                            Approve
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <DetailDrawer
        open={Boolean(panelDraft)}
        onClose={() => setPanelDraft(null)}
        ariaLabel="Draft approval detail"
      >
        {drawerFailure ? (
          <div className="error-banner" role="alert">
            {drawerFailure.action} failed for {drawerFailure.draft_label}: {drawerFailure.error} {drawerFailure.detail}
          </div>
        ) : null}
        {panelDraft ? (
          <DraftDetailPanel
            draft={panelDraft}
            mapsApiKey={meta.mapsApiKey}
            deciding={Boolean(panelDecision)}
            canDecide={canDecide}
            onApprove={() => void applyDecision('approve', panelDraft)}
            onReject={() => void applyDecision('reject', panelDraft)}
            onEdited={(next) => {
              setPanelDraft(next);
              setQueues((current) => ({
                ...current,
                [statusFilter]: (current[statusFilter] || []).map((draft) => (
                  draftId(draft) === draftId(next) ? { ...draft, ...next } : draft
                )),
              }));
            }}
          />
        ) : null}
      </DetailDrawer>
    </main>
  );
};
