import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchMeta, fetchProgress, fetchRecords } from './api.js';
import type { ProgressRun } from './api.js';
import { DetailDrawer } from './DetailDrawer.js';
import {
  droppedAt,
  identityValue,
  isDropped,
  labelFor,
  numberValue,
  RecordDetailContent,
  rowId,
  ScoreBar,
  StatusChip,
  textValue,
  useRecordDetail,
  VerdictChip,
} from './RecordDetailView.js';
import { RouteNav } from './RouteNav.js';
import type {
  ActiveFilter,
  ColumnMeta,
  FilterMeta,
  MetaResponse,
  RecordRow,
  SortDir,
} from './types.js';

const GROUP_LABELS: Record<string, string> = {
  identity: 'Identity',
  score: 'Score',
  status: 'Step status',
  step: 'Step status',
  enrich: 'Enrich',
  source: 'Source',
  lifecycle: 'Source',
  criterion: 'Score criteria',
};


const sortableColumns = (meta: MetaResponse | null) => (meta?.columns || []).filter((column) => column.key !== 'disqualified');
const activeFilterKey = (filter: ActiveFilter) => filter.key;
const POPOVER_GAP = 8;
const POPOVER_MARGIN = 12;
const POLL_INTERVAL_MS = 2000;
const PROGRESS_POLL_INTERVAL_MS = 1500;
const DETAIL_REFRESH_MS = 1500;


const useDismissablePopover = (open: boolean, onClose: () => void) => {
  const controlRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const insideControl = controlRef.current?.contains(target);
      const insidePanel = panelRef.current?.contains(target);
      if (insideControl || insidePanel) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose, open]);

  return { controlRef, panelRef };
};

const FloatingPopover = ({
  anchorRef,
  panelRef,
  className,
  children,
}: {
  anchorRef: RefObject<HTMLElement>;
  panelRef: RefObject<HTMLDivElement>;
  className: string;
  children: ReactNode;
}) => {
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const maxLeft = Math.max(POPOVER_MARGIN, window.innerWidth - panelRect.width - POPOVER_MARGIN);
    const maxTop = Math.max(POPOVER_MARGIN, window.innerHeight - panelRect.height - POPOVER_MARGIN);
    const left = Math.min(Math.max(anchorRect.right - panelRect.width, POPOVER_MARGIN), maxLeft);
    const top = Math.min(Math.max(anchorRect.bottom + POPOVER_GAP, POPOVER_MARGIN), maxTop);
    setStyle({ left, position: 'fixed', top, visibility: 'visible' });
  }, [anchorRef, panelRef]);

  useLayoutEffect(() => {
    updatePosition();
  }, [children, updatePosition]);

  useEffect(() => {
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition]);

  return createPortal(
    <div className={className} ref={panelRef} style={style}>
      {children}
    </div>,
    document.body,
  );
};


const BooleanValue = ({ value }: { value: unknown }) => <span className="boolean-value">{Number(value) ? 'yes' : 'no'}</span>;

const FROZEN_SCORE_KEY = 'priority_rank';
const SCORE_BAR_KEYS = new Set([FROZEN_SCORE_KEY]);
const isScoreBarColumn = (column: ColumnMeta) => column.group === 'score' && SCORE_BAR_KEYS.has(column.key);

// A score column is "unscored" (vs. a real 0) when scoring never ran for it —
// detected via the matching *_updated_at timestamp being empty.
const SCORE_UPDATED_KEY: Record<string, string> = {
  [FROZEN_SCORE_KEY]: 'score_updated_at',
};
const isUnscored = (record: RecordRow, key: string) => {
  const updatedKey = SCORE_UPDATED_KEY[key];
  if (!updatedKey) return false;
  return !String(record[updatedKey] ?? '').trim();
};

// Lifecycle rank for the "state" sort: kept (scored) → in progress → unscored → dropped.
// In-progress is live client state, so this can only be computed on the client.
const stateRank = (record: RecordRow, inProgressRowIds: Set<string>) => {
  if (isDropped(record)) return 3;
  if (inProgressRowIds.has(rowId(record))) return 1;
  if (!isUnscored(record, FROZEN_SCORE_KEY)) return 0;
  return 2;
};
const isWebsiteColumn = (column: ColumnMeta) => column.key === 'website' || column.key === 'websiteUri';

const hostnameOf = (raw: string) => {
  const trimmed = raw.trim();
  try {
    return new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`).hostname.replace(/^www\./, '');
  } catch {
    return trimmed.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }
};

const WebsiteCell = ({ value }: { value: unknown }) => {
  const raw = String(value ?? '').trim();
  if (!raw) return <span className="muted">—</span>;
  const href = raw.startsWith('http') ? raw : `https://${raw}`;
  return (
    <a className="cell-link" href={href} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
      {hostnameOf(raw)}
    </a>
  );
};

const NumberCell = ({ value }: { value: unknown }) => {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  return <span className="num-cell">{String(value)}</span>;
};

const isAddressColumn = (column: ColumnMeta) => column.key === 'address' || column.key === 'formattedAddress';

// A record is reachable on the map when it has coordinates AND is not dropped
// (the map view only plots non-dropped leads). Dropped or unlocated leads render
// their address as plain text — no dead link.
const isMappable = (record: RecordRow) => {
  if (isDropped(record)) return false;
  const lat = Number(record.latitude);
  const lng = Number(record.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)
    && record.latitude !== null && record.latitude !== '' && record.longitude !== null && record.longitude !== '';
};

const AddressCell = ({ value, record }: { value: unknown; record: RecordRow }) => {
  const text = textValue(value);
  if (text === 'n/a' || !isMappable(record)) return <span className="cell-text">{text}</span>;
  return (
    <Link
      className="cell-link"
      to={`/map?focus=${encodeURIComponent(rowId(record))}`}
      title="Show on map"
      onClick={(event) => event.stopPropagation()}
    >
      {text}
    </Link>
  );
};

const ValueCell = ({ column, record }: { column: ColumnMeta; record: RecordRow }) => {
  const value = record[column.key];
  if (isAddressColumn(column)) return <AddressCell value={value} record={record} />;
  if (isWebsiteColumn(column)) return <WebsiteCell value={value} />;
  if (column.type === 'verdict') return <VerdictChip verdict={(value as string) || null} />;
  if (column.type === 'status') return <StatusChip status={value || 'n/a'} />;
  if (column.type === 'boolean') return <BooleanValue value={value} />;
  if (column.type === 'number') return isScoreBarColumn(column) ? <ScoreBar value={value} unscored={isUnscored(record, column.key)} /> : <NumberCell value={value} />;
  return <span className="cell-text">{textValue(value)}</span>;
};


const OUTCOME_ICON: Record<string, { glyph: string; cls: string; title: string }> = {
  scored: { glyph: '✓', cls: 'outcome-scored', title: 'Scored — passed the funnel and was ranked' },
  dropped: { glyph: '⊘', cls: 'outcome-dropped', title: 'Dropped at a gate' },
  error: { glyph: '✕', cls: 'outcome-error', title: 'Error during processing' },
  processing: { glyph: '◌', cls: 'outcome-processing is-spinning', title: 'Processing' },
  not_scored: { glyph: '–', cls: 'outcome-not-scored', title: 'Not yet scored' },
};

const OutcomeIcon = ({ record }: { record: RecordRow }) => {
  // Source of truth is the server-derived __outcome (lead-status taxonomy); the
  // fallback only fires if it's missing and must NOT default a non-dropped record
  // to 'scored' — that's the bug that made the glyph disagree with the pills.
  const outcome = String(record.__outcome || (isDropped(record) ? 'dropped' : 'not_scored'));
  const spec = OUTCOME_ICON[outcome] ?? OUTCOME_ICON.not_scored;
  const title = outcome === 'dropped' ? `Dropped at ${labelFor(droppedAt(record) || 'a gate')}` : spec.title;
  return (
    <span className={`outcome-icon ${spec.cls}`} title={title} aria-label={title} role="img">
      {spec.glyph}
    </span>
  );
};

const ScoreFrozenCell = ({ record }: { record: RecordRow }) => {
  if (isDropped(record)) return <span className="fit-frozen is-empty">—</span>;
  if (isUnscored(record, FROZEN_SCORE_KEY)) return <span className="fit-frozen is-unscored" title="Not yet scored">––</span>;
  const score = numberValue(record[FROZEN_SCORE_KEY]);
  return <span className="fit-frozen">{Number.isInteger(score) ? score : score.toFixed(0)}</span>;
};

const ColumnPicker = ({
  meta,
  visible,
  onToggle,
}: {
  meta: MetaResponse;
  visible: Set<string>;
  onToggle: (key: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const { controlRef, panelRef } = useDismissablePopover(open, () => setOpen(false));
  const toggleable = meta.columns.filter((column) => !column.locked);
  return (
    <div className={`column-picker popover-control ${open ? 'is-open' : ''}`} ref={controlRef}>
      <button className="popover-trigger" type="button" aria-expanded={open} aria-label="Choose columns" onClick={() => setOpen((current) => !current)}>Columns</button>
      {open ? (
      <FloatingPopover anchorRef={controlRef} className="column-picker__menu popover-menu" panelRef={panelRef}>
        {toggleable.map((column) => (
          <label key={column.key}>
            <input type="checkbox" checked={visible.has(column.key)} onChange={() => onToggle(column.key)} />
            <span>{column.label}</span>
          </label>
        ))}
      </FloatingPopover>
      ) : null}
    </div>
  );
};

const filterSummary = (filter: ActiveFilter, meta: MetaResponse) => {
  const filterMeta = meta.filters.find((candidate) => candidate.key === filter.key);
  const label = filterMeta?.label || labelFor(filter.key);
  if (filter.kind === 'range') {
    if (filter.min && filter.max) return `${label} ${filter.min}-${filter.max}`;
    if (filter.min) return `${label} >= ${filter.min}`;
    return `${label} <= ${filter.max}`;
  }
  return `${label}: ${labelFor(filter.value)}`;
};

const filterOptions = (filter: FilterMeta) => {
  if (filter.type === 'boolean') return ['yes', 'no'];
  return filter.options || [];
};

const FilterBuilder = ({
  meta,
  filters,
  showingDropped,
  showInProgress,
  inProgressCount,
  onApply,
  onToggleDropped,
  onToggleInProgress,
}: {
  meta: MetaResponse;
  filters: ActiveFilter[];
  showingDropped: boolean;
  showInProgress: boolean;
  inProgressCount: number;
  onApply: (filter: ActiveFilter) => void;
  onToggleDropped: () => void;
  onToggleInProgress: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState('');
  const [enumValue, setEnumValue] = useState('');
  const [minValue, setMinValue] = useState('');
  const [maxValue, setMaxValue] = useState('');
  const { controlRef, panelRef } = useDismissablePopover(open, () => setOpen(false));
  const selected = meta.filters.find((filter) => filter.key === selectedKey);
  const groupedFilters = useMemo(() => {
    const columnsByKey = new Map(meta.columns.map((column) => [column.key, column]));
    return meta.filters.reduce<Record<string, FilterMeta[]>>((groups, filter) => {
      const group = GROUP_LABELS[columnsByKey.get(filter.key)?.group || (filter.key.includes('__status') ? 'step' : 'source')] || 'Source';
      return { ...groups, [group]: [...(groups[group] || []), filter] };
    }, {});
  }, [meta.columns, meta.filters]);

  const chooseFilter = (filter: FilterMeta) => {
    const active = filters.find((candidate) => candidate.key === filter.key);
    setSelectedKey(filter.key);
    setEnumValue(active?.kind === 'enum' ? active.value : '');
    setMinValue(active?.kind === 'range' ? active.min : '');
    setMaxValue(active?.kind === 'range' ? active.max : '');
  };

  const applySelected = () => {
    if (!selected) return;
    if (selected.type === 'range') {
      if (!minValue && !maxValue) return;
      onApply({ kind: 'range', key: selected.key, min: minValue, max: maxValue });
      setOpen(false);
      return;
    }
    if (!enumValue) return;
    onApply({ kind: 'enum', key: selected.key, value: enumValue });
    setOpen(false);
  };

  return (
    <div className={`filter-builder popover-control ${open ? 'is-open' : ''}`} ref={controlRef}>
      <button className="popover-trigger" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>+ Add filter</button>
      {open ? (
      <FloatingPopover anchorRef={controlRef} className="filter-builder__menu popover-menu" panelRef={panelRef}>
        <div className="filter-builder__fields">
          <div className="filter-group">
            <span>Defaults</span>
            <button className={showingDropped ? 'is-active' : ''} type="button" onClick={onToggleDropped}>
              {showingDropped ? 'Hide dropped' : 'Show dropped'}
            </button>
            <button className={showInProgress ? 'is-active' : ''} type="button" onClick={onToggleInProgress}>
              {showInProgress ? `Showing in progress (${inProgressCount})` : `Only in progress (${inProgressCount})`}
            </button>
          </div>
          {Object.entries(groupedFilters).map(([group, groupFilters]) => (
            <div key={group} className="filter-group">
              <span>{group}</span>
              {groupFilters.map((filter) => (
                <button className={selectedKey === filter.key ? 'is-active' : ''} key={filter.key} type="button" onClick={() => chooseFilter(filter)}>
                  {filter.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="filter-builder__control">
          {selected ? (
            <>
              <strong>{selected.label}</strong>
              {selected.type === 'range' ? (
                <span className="range-inputs">
                  <input type="number" placeholder={selected.min === null || selected.min === undefined ? 'min' : String(selected.min)} value={minValue} onChange={(event) => setMinValue(event.target.value)} />
                  <input type="number" placeholder={selected.max === null || selected.max === undefined ? 'max' : String(selected.max)} value={maxValue} onChange={(event) => setMaxValue(event.target.value)} />
                </span>
              ) : (
                <select value={enumValue} onChange={(event) => setEnumValue(event.target.value)}>
                  <option value="">Choose value</option>
                  {filterOptions(selected).map((option) => (
                    <option key={option} value={option}>{labelFor(option)}</option>
                  ))}
                </select>
              )}
              <button className="solid-button" type="button" onClick={applySelected}>Apply</button>
            </>
          ) : (
            <span className="muted">Choose a field to configure it.</span>
          )}
        </div>
      </FloatingPopover>
      ) : null}
    </div>
  );
};

const SortControl = ({
  meta,
  sort,
  dir,
  onSort,
  onDir,
}: {
  meta: MetaResponse;
  sort: string;
  dir: SortDir;
  onSort: (sort: string) => void;
  onDir: (dir: SortDir) => void;
}) => {
  const [open, setOpen] = useState(false);
  const { controlRef, panelRef } = useDismissablePopover(open, () => setOpen(false));

  return (
  <div className={`sort-control popover-control ${open ? 'is-open' : ''}`} ref={controlRef}>
    <button className="popover-trigger" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>Sort</button>
    {open ? (
    <FloatingPopover anchorRef={controlRef} className="sort-control__menu popover-menu" panelRef={panelRef}>
      <div className="sort-presets">
        <span>Presets</span>
        <button className={sort === 'state' ? 'is-active' : ''} type="button" onClick={() => { onSort('state'); onDir('desc'); }}>
          State
        </button>
        <button className={sort === 'priority_rank' && dir === 'desc' ? 'is-active' : ''} type="button" onClick={() => { onSort('priority_rank'); onDir('desc'); }}>
          Highest score
        </button>
        <button className={sort === '_created_at' && dir === 'desc' ? 'is-active' : ''} type="button" onClick={() => { onSort('_created_at'); onDir('desc'); }}>
          Newest
        </button>
      </div>
      <label>
        <span>Field</span>
        <select value={sort} onChange={(event) => onSort(event.target.value)}>
          <option value="state">State (lifecycle)</option>
          {sortableColumns(meta).map((column) => (
            <option value={column.key} key={column.key}>{column.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Direction</span>
        <select value={dir} onChange={(event) => onDir(event.target.value as SortDir)}>
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>
      </label>
    </FloatingPopover>
    ) : null}
  </div>
  );
};

const TableView = ({
  meta,
  records,
  visibleColumns,
  sort,
  dir,
  onSort,
  onOpen,
  activeStep,
  inProgressRowIds,
}: {
  meta: MetaResponse;
  records: RecordRow[];
  visibleColumns: ColumnMeta[];
  sort: string;
  dir: SortDir;
  onSort: (key: string) => void;
  onOpen: (id: string) => void;
  activeStep: string;
  inProgressRowIds: Set<string>;
}) => {
  const nameColumn = visibleColumns.find((column) => column.locked && (column.key === 'business_name' || column.key === 'name')) || null;
  const nameKey = nameColumn?.key || 'business_name';
  const nameLabel = nameColumn?.label || 'Business';
  // Frozen columns (outcome icon, score, name) are rendered explicitly; everything
  // else — locked or not — is excluded from the horizontally scrolling set.
  const scrollColumns = visibleColumns.filter(
    (column) => !column.locked && column.key !== FROZEN_SCORE_KEY && column.key !== 'business_name' && column.key !== 'name',
  );
  return (
  <div className="table-shell">
    <table className="locked-table">
      <thead>
        <tr>
          <th className="col-outcome" aria-label="Outcome"><span className="col-outcome__dot" aria-hidden="true" /></th>
          <th className="col-fit">
            <button className="th-button" type="button" onClick={() => onSort(FROZEN_SCORE_KEY)}>
              Score
              <span>{sort === FROZEN_SCORE_KEY ? (dir === 'asc' ? 'Up' : 'Down') : ''}</span>
            </button>
          </th>
          <th className="col-name">
            <button className="th-button" type="button" onClick={() => onSort(nameKey)}>
              {nameLabel}
              <span>{sort === nameKey ? (dir === 'asc' ? 'Up' : 'Down') : ''}</span>
            </button>
          </th>
          {scrollColumns.map((column) => (
            <th key={column.key}>
              <button className="th-button" type="button" onClick={() => onSort(column.key)}>
                {column.label}
                <span>{sort === column.key ? (dir === 'asc' ? 'Up' : 'Down') : ''}</span>
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {records.map((record) => (
          <tr key={rowId(record)} data-row-id={rowId(record)} className={isDropped(record) ? 'is-disqualified' : ''} onClick={() => onOpen(rowId(record))}>
            <td className="col-outcome">
              {inProgressRowIds.has(rowId(record)) ? <span className="ao-spinner" aria-label="Processing" role="img" /> : <OutcomeIcon record={record} />}
            </td>
            <td className="col-fit"><ScoreFrozenCell record={record} /></td>
            <td className="col-name">
              <span className="cell-name">{textValue(identityValue(record, ['business_name', 'name']))}</span>
            </td>
            {scrollColumns.map((column) => (
              <td key={column.key}>
                {inProgressRowIds.has(rowId(record)) && column.step_id && column.step_id === activeStep ? <span className="ao-skeleton" aria-hidden="true" /> : <ValueCell column={column} record={record} />}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    {records.length === 0 ? <div className="empty-state">No records match the current filters.</div> : null}
    <div className="table-note">{records.length} shown from {meta.counts.total} total records</div>
  </div>
  );
};


const DetailPanel = ({
  rowIdValue,
  onClose,
  activeStep,
  recordInProgress,
}: {
  rowIdValue: string | null;
  onClose: () => void;
  activeStep: string;
  recordInProgress: boolean;
}) => {
  const { detail, loading } = useRecordDetail(rowIdValue, { refreshMs: DETAIL_REFRESH_MS });
  const [statusFilter, setStatusFilter] = useState('all');

  return (
    <DetailDrawer open={Boolean(rowIdValue)} onClose={onClose}>
      {loading ? <div className="drawer-loading">Loading detail...</div> : null}
      {detail ? (
        <RecordDetailContent
          detail={detail}
          activeStep={activeStep}
          recordInProgress={recordInProgress}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
        />
      ) : null}
    </DetailDrawer>
  );
};

const PROGRESS_PHASE_LABELS: Record<string, string> = {
  pipeline: 'Filtering',
  scoring: 'Scoring',
  sourcing: 'Sourcing',
};

export const App = () => {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('state');
  const [dir, setDir] = useState<SortDir>('desc');
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get('focus');
  const focusScrolled = useRef(false);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isDocumentHidden, setIsDocumentHidden] = useState(() => document.visibilityState === 'hidden');
  const [progress, setProgress] = useState<ProgressRun | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [showInProgress, setShowInProgress] = useState(false);

  const markUpdated = useCallback(() => {
    const updatedAt = Date.now();
    setLastUpdatedAt(updatedAt);
    setNow(updatedAt);
  }, []);

  useEffect(() => {
    fetchMeta()
      .then((nextMeta) => {
        setMeta(nextMeta);
        setVisibleKeys(new Set(nextMeta.columns.filter((column) => column.default_visible).map((column) => column.key)));
      })
      .catch((nextError: Error) => setError(nextError.message));
  }, []);

  useEffect(() => {
    fetchRecords({ sort, dir, q, filters })
      .then((response) => {
        setRecords(response.records);
        setTotal(response.total);
        markUpdated();
      })
      .catch((nextError: Error) => setError(nextError.message));
  }, [sort, dir, q, filters, markUpdated]);

  // Deep-link from the map's "View in Table": ?focus=<rowId> opens that lead's
  // detail panel. The panel fetches its record by id independently, so it works
  // even when the row falls outside the table's 500-row window.
  useEffect(() => {
    if (!focusId) return;
    setSelectedRowId(focusId);
    focusScrolled.current = false;
  }, [focusId]);

  // Best-effort scroll the focused row into view once it has rendered. If the row
  // isn't in the loaded set (beyond the limit), the panel still opens; we just skip.
  useEffect(() => {
    if (!focusId || focusScrolled.current) return;
    const row = document.querySelector(`[data-row-id="${CSS.escape(focusId)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    focusScrolled.current = true;
  }, [focusId, records]);

  const pollLiveData = useCallback(() => {
    Promise.all([fetchRecords({ sort, dir, q, filters }), fetchMeta()])
      .then(([response, nextMeta]) => {
        setRecords(response.records);
        setTotal(response.total);
        setMeta(nextMeta);
        markUpdated();
      })
      .catch(() => undefined);
  }, [sort, dir, q, filters, markUpdated]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const nextIsDocumentHidden = document.visibilityState === 'hidden';
      setIsDocumentHidden(nextIsDocumentHidden);
      if (!nextIsDocumentHidden) pollLiveData();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [pollLiveData]);

  useEffect(() => {
    if (isDocumentHidden) return undefined;
    const intervalId = window.setInterval(pollLiveData, POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [isDocumentHidden, pollLiveData]);

  useEffect(() => {
    const source = new EventSource('/api/stream');
    source.addEventListener('open', () => setSseConnected(true));
    source.addEventListener('tick', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as {
          progress: ProgressRun | null;
          counts: MetaResponse['counts'] | null;
        };
        setProgress(parsed.progress ?? null);
        const counts = parsed.counts;
        if (counts) {
          setMeta((current) => (current ? { ...current, counts } : current));
        }
      } catch {
        return undefined;
      }
    });
    source.addEventListener('error', () => setSseConnected(false));
    return () => {
      source.close();
      setSseConnected(false);
    };
  }, []);

  useEffect(() => {
    if (isDocumentHidden) return undefined;
    if (sseConnected) return undefined;
    fetchProgress()
      .then((response) => setProgress(response.run))
      .catch(() => undefined);
    const intervalId = window.setInterval(() => {
      fetchProgress()
        .then((response) => setProgress(response.run))
        .catch(() => undefined);
    }, PROGRESS_POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [isDocumentHidden, sseConnected]);

  useEffect(() => {
    if (isDocumentHidden) return undefined;
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [isDocumentHidden]);

  const setFilter = useCallback((next: ActiveFilter | null) => {
    setFilters((current) => {
      if (!next) return current;
      return [...current.filter((filter) => activeFilterKey(filter) !== activeFilterKey(next)), next];
    });
  }, []);

  const removeFilter = useCallback((key: string) => {
    setFilters((current) => current.filter((filter) => filter.key !== key));
  }, []);

  const clearFilters = useCallback(() => setFilters([]), []);
  const disqualifiedFilter = filters.find((filter) => filter.key === 'disqualified');
  const showingDropped = !(disqualifiedFilter?.kind === 'enum' && disqualifiedFilter.value === 'qualified');

  const toggleDropped = () => {
    if (showingDropped) {
      setFilter({ kind: 'enum', key: 'disqualified', value: 'qualified' });
      return;
    }
    removeFilter('disqualified');
  };

  const visibleColumns = useMemo(
    () => (meta?.columns || []).filter((column) => visibleKeys.has(column.key)),
    [meta?.columns, visibleKeys],
  );

  const onHeaderSort = (key: string) => {
    setSort(key);
    setDir(sort === key && dir === 'desc' ? 'asc' : 'desc');
  };
  const secondsSinceLastUpdate = lastUpdatedAt ? Math.max(0, Math.floor((now - lastUpdatedAt) / 1000)) : 0;
  const runActive = Boolean(progress && progress.status === 'running' && (progress.age_ms === null || progress.age_ms < 8000));
  const activeStep = runActive && progress && progress.phase === 'pipeline' ? progress.active_step : '';
  const pipelineStepIds = useMemo(
    () => (meta?.steps || []).filter((step) => step.kind === 'filter' || step.kind === 'enrich').map((step) => step.id),
    [meta?.steps],
  );
  const activeIndex = activeStep ? pipelineStepIds.indexOf(activeStep) : -1;
  const inProgressRowIds = useMemo(
    () => new Set((activeIndex >= 0 ? records : []).filter((record) => !isDropped(record) && pipelineStepIds.indexOf(String(record.__furthest_step || '')) < activeIndex).map((record) => rowId(record))),
    [records, activeIndex, pipelineStepIds],
  );
  const inProgressCount = inProgressRowIds.size;
  const displayedRecords = useMemo(() => {
    const base = showInProgress ? records.filter((record) => inProgressRowIds.has(rowId(record))) : records;
    if (sort !== 'state') return base;
    // Server can't order by lifecycle state, so sort it here. dir flips the order
    // (default desc = kept first); ties break by score, highest first.
    const flip = dir === 'asc' ? -1 : 1;
    return [...base].sort((a, b) => {
      const rankDelta = stateRank(a, inProgressRowIds) - stateRank(b, inProgressRowIds);
      if (rankDelta !== 0) return rankDelta * flip;
      return numberValue(b[FROZEN_SCORE_KEY]) - numberValue(a[FROZEN_SCORE_KEY]);
    });
  }, [records, showInProgress, inProgressRowIds, sort, dir]);
  const runPhaseLabel = progress ? (PROGRESS_PHASE_LABELS[progress.phase] ?? labelFor(progress.phase)) : '';
  const liveStatusLabel = isDocumentHidden ? 'Paused' : runActive ? `${runPhaseLabel} running` : `Idle · updated ${secondsSinceLastUpdate}s ago`;
  const runDetailText = !progress ? 'No active run'
    : progress.phase === 'pipeline' && progress.step_total > 0
      ? `Step ${progress.step_index + 1}/${progress.step_total}: ${labelFor(progress.active_step)} · ${progress.done_count}/${progress.target_count} records`
    : progress.phase === 'sourcing' && progress.step_total > 0
      ? `Tile ${progress.step_index}/${progress.step_total} · ${progress.done_count} found`
    : progress.status === 'running'
      ? (progress.message || 'Working…')
    : 'No active run';

  if (!meta) {
    return <main className="app-shell"><div className="loading">{error || 'Loading outbound records...'}</div></main>;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar__id">
          <span className="topbar__name">{meta.list.name}</span>
          <span className="topbar__path">{meta.list.dir}</span>
        </div>
        <div className="stats">
          <span>Total <strong>{meta.counts.total}</strong></span>
          <span title="Scored and in play (lead status: qualified)">Qualified <strong>{meta.counts.by_status?.qualified ?? meta.counts.qualified}</strong></span>
          <span title="Sourced/enriched but not yet scored">Unscored <strong>{meta.counts.by_status?.unscored ?? Math.max(0, meta.counts.total - meta.counts.qualified - meta.counts.disqualified)}</strong></span>
          <span title={meta.counts.by_status ? `Gate ${meta.counts.by_status.dropped_gate} · Low score ${meta.counts.by_status.dropped_low_score} · Manual ${meta.counts.by_status.dropped_manual}` : 'Dropped at a gate, by low score, or manually'}>Dropped <strong>{meta.counts.disqualified}</strong></span>
          <span className="live-pill" tabIndex={0}>
            <span className={`live-dot ${runActive ? 'is-active' : ''}`} aria-hidden="true" />
            {liveStatusLabel}
            <span className="live-pill__card" role="status">
              <strong>{runActive ? `${runPhaseLabel} running` : (progress && progress.status === 'done' ? `${runPhaseLabel} complete` : (progress && progress.status === 'incomplete' ? `${runPhaseLabel} incomplete` : 'Idle'))}</strong>
              <span>{runDetailText}</span>
            </span>
          </span>
        </div>
        <RouteNav />
      </header>
      <section className="toolbar">
        <div className="preset-row">
          <label className="search-box">
            <span>Search</span>
            <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Name, address, website" />
          </label>
          <span className="match-count">{showInProgress ? `${inProgressCount} in progress` : `${total} matching`}</span>
          <div className="toolbar-actions">
            <FilterBuilder meta={meta} filters={filters} showingDropped={showingDropped} showInProgress={showInProgress} inProgressCount={inProgressCount} onApply={setFilter} onToggleDropped={toggleDropped} onToggleInProgress={() => setShowInProgress((value) => !value)} />
            <SortControl meta={meta} sort={sort} dir={dir} onSort={setSort} onDir={setDir} />
            <ColumnPicker
              meta={meta}
              visible={visibleKeys}
              onToggle={(key) => setVisibleKeys((current) => {
                const next = new Set(current);
                if (next.has(key)) {
                  next.delete(key);
                  return next;
                }
                next.add(key);
                return next;
              })}
            />
          </div>
        </div>
        <div className="chips-row">
          {filters.map((filter) => (
            <button type="button" className="chip chip-button" key={filter.key} onClick={() => removeFilter(filter.key)}>
              {filterSummary(filter, meta)} ×
            </button>
          ))}
          {filters.length > 0 ? <button className="text-button" type="button" onClick={clearFilters}>Clear all</button> : null}
        </div>
      </section>
      {error ? <div className="error-banner">{error}</div> : null}
      <TableView meta={meta} records={displayedRecords} visibleColumns={visibleColumns} sort={sort} dir={dir} onSort={onHeaderSort} onOpen={setSelectedRowId} activeStep={activeStep} inProgressRowIds={inProgressRowIds} />
      <DetailPanel rowIdValue={selectedRowId} onClose={() => setSelectedRowId(null)} activeStep={activeStep} recordInProgress={selectedRowId ? inProgressRowIds.has(selectedRowId) : false} />
    </main>
  );
};
