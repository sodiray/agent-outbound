import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchMeta, fetchProgress, fetchRecordDetail, fetchRecords } from './api.js';
import type { ProgressRun } from './api.js';
import { InfoTooltip } from './InfoTooltip.js';
import { Markdown } from './markdown.js';
import type {
  ActiveFilter,
  ColumnMeta,
  FilterMeta,
  Interaction,
  LeadAsset,
  LeadBrief,
  ManualField,
  MetaResponse,
  OverrideRecord,
  RecordDetail,
  RecordDetailStep,
  RecordRow,
  ScoreCriterion,
  SortDir,
} from './types.js';

const STATUS_CLASS: Record<string, string> = {
  done: 'is-green',
  sourced: 'is-green',
  passed: 'is-green',
  ok: 'is-green',
  skipped: 'is-muted',
  flagged: 'is-yellow',
  kept: 'is-blue',
  failed: 'is-red',
  dropped: 'is-red',
  not_reached: 'is-ghost',
  'not reached': 'is-ghost',
  'n/a': 'is-ghost',
};

const VERDICT_CLASS: Record<string, string> = {
  yes: 'is-green',
  partial: 'is-yellow',
  no: 'is-red',
  'n/a': 'is-ghost',
};

const SERVER_LABELS: Record<string, string> = {
  googlemaps: 'Google Maps',
  firecrawl: 'Firecrawl',
  browser: 'Chrome browser (Anchor)',
  enrich: 'Enrichment API · JSearch',
};

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

const STATUS_FILTERS = ['all', 'done', 'passed', 'ok', 'skipped', 'flagged', 'dropped', 'failed', 'not_reached'];

const identityValue = (record: RecordRow, keys: string[]) => keys.map((key) => record[key]).find((value) => value !== null && value !== '');
const textValue = (value: unknown) => (value === null || value === undefined || value === '' ? 'n/a' : String(value));
const numberValue = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const labelFor = (key: string) => key.replace(/__status$/, '').replace(/^_+/, '').split(/[_\s-]+/).filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ') || key;
const humanStatus = (value: unknown) => textValue(value).toLowerCase().replaceAll('_', ' ');
const statusKey = (value: unknown) => humanStatus(value).replaceAll(' ', '_');
const rowId = (record: RecordRow) => String(record._row_id ?? record.id ?? '');
const isDropped = (record: RecordRow) => record.__stage === 'dropped' || Boolean(record.__dropped_at || record.disqualified_at || record.disqualified_gate || record.disqualify_reason);
const droppedAt = (record: RecordRow) => String(record.__dropped_at || record.disqualified_gate || record.disqualified_at || '');
const sortableColumns = (meta: MetaResponse | null) => (meta?.columns || []).filter((column) => column.key !== 'disqualified');
const activeFilterKey = (filter: ActiveFilter) => filter.key;
const POPOVER_GAP = 8;
const POPOVER_MARGIN = 12;
const POLL_INTERVAL_MS = 2000;
const PROGRESS_POLL_INTERVAL_MS = 1500;

const displayDate = (value: unknown) => {
  const raw = String(value || '');
  if (!raw) return 'n/a';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString();
};

const latestEventTime = (events: RecordDetailStep['events']) => {
  const safeEvents = Array.isArray(events) ? events : [];
  return safeEvents.map((event) => event.occurred_at).filter(Boolean).sort().at(-1) || '';
};
const stepTime = (step: RecordDetailStep) => step.cost?.occurred_at || latestEventTime(step.events);

const formatCost = (value: unknown) => {
  if (value === null || value === undefined || value === '') return 'n/a';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(4)}` : 'n/a';
};

const friendlyServer = (server: string | null) => {
  if (!server) return 'n/a';
  return SERVER_LABELS[server] ?? labelFor(server);
};

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

const ScoreBar = ({ value, unscored = false }: { value: unknown; unscored?: boolean }) => {
  if (unscored) {
    return (
      <span className="score-cell is-unscored" title="Not yet scored">
        <span className="score-cell__value">––</span>
      </span>
    );
  }
  const score = Math.max(0, Math.min(100, numberValue(value)));
  return (
    <span className="score-cell">
      <span className="score-cell__value">{Number.isInteger(score) ? score : score.toFixed(1)}</span>
      <span className="score-bar" aria-hidden="true">
        <span style={{ width: `${score}%` }} />
      </span>
    </span>
  );
};

const StatusChip = ({ status, label }: { status: unknown; label?: string }) => {
  const normalized = humanStatus(status);
  return <span className={`chip status-chip ${STATUS_CLASS[normalized] ?? 'is-ghost'}`}>{label || normalized}</span>;
};

const VerdictChip = ({ verdict, grade }: { verdict?: string | null; grade?: number | null }) => {
  const normalized = verdict || 'n/a';
  const label = grade === null || grade === undefined ? normalized : `${grade}/10`;
  return <span className={`chip verdict-chip ${VERDICT_CLASS[normalized] ?? 'is-ghost'}`}>{label}</span>;
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

const OutcomeBadge = ({ record }: { record: RecordRow }) => {
  if (isDropped(record)) {
    return <span className="outcome-badge is-dropped">Dropped · {labelFor(droppedAt(record) || 'gate')}</span>;
  }
  return <span className="outcome-badge is-scored">Scored</span>;
};

const LEAD_STATUS_BADGES: Record<string, { label: string; className: string }> = {
  qualified: { label: 'Qualified', className: 'is-scored' },
  unscored: { label: 'Unscored', className: '' },
  dropped_low_score: { label: 'Dropped · low score', className: 'is-dropped' },
  dropped_gate: { label: 'Dropped · gate', className: 'is-dropped' },
  dropped_manual: { label: 'Dropped · manual', className: 'is-dropped' },
};

const LeadStatusBadge = ({ status }: { status: string }) => {
  const badge = LEAD_STATUS_BADGES[status];
  if (!badge) return null;
  return <span className={`outcome-badge ${badge.className}`}>{badge.label}</span>;
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

const criterionPoints = (criterion: ScoreCriterion) => (Number.isFinite(Number(criterion.points)) ? Number(criterion.points) : 0);

const CriteriaBreakdown = ({ detail }: { detail: RecordDetail }) => {
  const score = detail.score;
  const criteria = Array.isArray(score?.criteria) ? score.criteria : [];
  const points = criteria.map(criterionPoints);
  const hasScoredCriteria = criteria.some((criterion) => criterion.verdict !== null && criterion.verdict !== undefined);
  const sum = points.reduce((total, point) => total + point, 0);
  const scoreTotal = hasScoredCriteria ? sum : numberValue(score?.value);
  const reasoning = score?.reasoning || '';

  return (
    <div className="score-card">
      <div className="score-card__top">
        <span>Score</span>
        <ScoreBar value={scoreTotal} />
      </div>
      {reasoning ? <p>{reasoning}</p> : <p className="muted">This lead has not been scored yet.</p>}
      {criteria.length > 0 ? (
        <div className="criteria-list">
          {criteria.map((criterion) => {
            const notScored = criterion.verdict === null || criterion.verdict === undefined;
            return (
              <div key={criterion.id} className={`criterion ${notScored ? 'is-not-scored' : ''}`}>
                <div>
                  <span className="label-with-info">
                    <strong>{labelFor(criterion.id)}</strong>
                    <InfoTooltip text={criterion.description} />
                  </span>
                </div>
                <VerdictChip verdict={criterion.verdict} grade={criterion.grade ?? null} />
                <strong>{notScored ? '0' : `+${criterionPoints(criterion)}`}</strong>
                <span>{Math.round(numberValue(criterion.weight) * 100)}%</span>
                <p>{notScored ? 'Not scored.' : criterion.reasoning || 'Scored without additional notes.'}</p>
              </div>
            );
          })}
        </div>
      ) : null}
      {criteria.length > 0 ? (
        <div className="score-math">{hasScoredCriteria ? `${points.join(' + ')} = ${sum}` : 'Not scored · definition weights shown'}</div>
      ) : null}
    </div>
  );
};

const ScoreSection = ({ detail }: { detail: RecordDetail }) => {
  const droppedByFloor = String(detail.record.disqualified_gate || '') === 'score_minimum';
  const minimum = numberValue(detail.score?.minimum);
  return (
    <section className="detail-section">
      <div className="section-title">Score</div>
      <CriteriaBreakdown detail={detail} />
      {minimum > 0 ? <div className="blend-line">Minimum to qualify: {minimum}</div> : null}
      {droppedByFloor ? (
        <div className="override-note override-note--drop">
          <span className="override-note__label">Dropped · below minimum score</span>
          <p>{String(detail.record.disqualify_reason || '')}</p>
        </div>
      ) : null}
    </section>
  );
};

const OutputValue = ({ value }: { value: unknown }) => {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  if (typeof value === 'boolean' || value === 0 || value === 1) return <span>{Number(value) ? '✓' : '✗'}</span>;
  return <span>{String(value)}</span>;
};

// The BODY of a step box is the model's OUTPUT — its decision/reasoning — never a
// repeat of the configured intent (that already lives in the step head as the
// description). When a step produced no model reasoning (e.g. a gate that passed
// silently, or a deterministic field check), show a short outcome label only —
// do NOT pad it with step.description, which is what caused the duplicate render.
const decisionText = (step: RecordDetailStep) => {
  if (step.reasoning) return step.reasoning;
  const status = humanStatus(step.status);
  if (status === 'skipped') return 'Skipped · condition not met';
  if (status === 'not reached' || status === 'n/a') return 'Not reached';
  if (status === 'done') return 'Completed';
  if (status === 'passed' || status === 'ok') return 'Passed';
  if (status === 'failed' || status === 'dropped') return 'Stopped here';
  return labelFor(step.status);
};

const hasMetadata = (step: RecordDetailStep) => Boolean(step.cost || step.tool.server);
const metadataChips = (step: RecordDetailStep) => [
  step.tool.server ? friendlyServer(step.tool.server) : '',
  step.cost?.model || '',
  step.cost?.provider || '',
  step.cost ? `${step.cost.input_tokens || 0} in / ${step.cost.output_tokens || 0} out` : '',
  step.cost ? formatCost(step.cost.usd_cost) : '',
  step.cost?.occurred_at ? displayDate(step.cost.occurred_at) : '',
].filter((value) => value && value !== 'n/a');

const BriefSection = ({ brief }: { brief: LeadBrief | null }) => {
  const [expanded, setExpanded] = useState(false);
  if (!brief) return null;
  return (
    <section className="detail-section">
      <div className="section-title section-title--row">
        <span>SDR brief</span>
        {brief.content ? (
          <button type="button" className="text-button" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Hide full brief' : 'Show full brief'}
          </button>
        ) : null}
      </div>
      <article className="brief-card">
        {brief.summary ? <p className="brief-card__summary"><strong>{brief.summary}</strong></p> : null}
        {expanded ? <Markdown text={brief.content} className="brief-card__body" /> : null}
        <small>{brief.model}{brief.updated_at ? ` · ${displayDate(brief.updated_at)}` : ''}</small>
      </article>
    </section>
  );
};

// Generated assets for a lead (the automation plan, and any future per-lead
// assets). The brief is rendered separately above the tabs — it is never in this
// list. Each asset shows its summary and its markdown body.
const AssetCard = ({ asset }: { asset: LeadAsset }) => (
  <article className="brief-card">
    <div className="asset-card__head">
      <strong>{asset.label}</strong>
      {asset.status && asset.status !== 'ready' ? <span className="chip is-muted">{asset.status}</span> : null}
    </div>
    {asset.summary ? <p className="brief-card__summary">{asset.summary}</p> : null}
    {asset.is_reference
      ? <p><a href={asset.content} target="_blank" rel="noreferrer">{asset.content}</a></p>
      : asset.content ? <Markdown text={asset.content} className="brief-card__body" /> : null}
    {asset.model || asset.updated_at ? <small>{asset.model}{asset.updated_at ? ` · ${displayDate(asset.updated_at)}` : ''}</small> : null}
  </article>
);

const AssetsTab = ({ assets }: { assets: LeadAsset[] }) => {
  if (!assets || assets.length === 0) {
    return <p className="muted assets-empty">No assets generated for this lead yet.</p>;
  }
  return (
    <div className="assets-list">
      {assets.map((asset) => <AssetCard key={asset.asset_id} asset={asset} />)}
    </div>
  );
};

const followUpChip = (interaction: Interaction) => {
  if (!interaction.follow_up_at) return null;
  if (interaction.follow_up_done_at) return <span className="chip is-muted">follow-up done</span>;
  const due = interaction.follow_up_at.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <span className={`chip status-chip ${due < today ? 'is-red' : 'is-blue'}`}>
      {due < today ? `follow-up overdue · ${due}` : `follow-up ${due}`}
    </span>
  );
};

const InteractionsSection = ({ interactions }: { interactions: Interaction[] }) => {
  if (!interactions || interactions.length === 0) return null;
  return (
    <section className="detail-section">
      <div className="section-title">Interactions</div>
      <div className="override-list">
        {interactions.map((interaction) => (
          <article key={interaction.interaction_id} className="override-item override-item--keep">
            <div className="override-item__head">
              <span className="chip status-chip is-blue">{labelFor(interaction.kind)}{interaction.contact ? ` · ${interaction.contact}` : ''}</span>
              {followUpChip(interaction)}
              {interaction.occurred_at ? <span className="step-time">{displayDate(interaction.occurred_at)}</span> : null}
            </div>
            <p><strong>{interaction.summary}</strong></p>
            {interaction.body ? <p>{interaction.body}</p> : null}
            {interaction.objections ? <p>⚠️ Objections: {interaction.objections}</p> : null}
            {interaction.created_by ? <small>{interaction.created_by}</small> : null}
          </article>
        ))}
      </div>
    </section>
  );
};

const ManualFieldsSection = ({ fields }: { fields: ManualField[] }) => {
  if (!fields || fields.length === 0) return null;
  return (
    <section className="detail-section">
      <div className="section-title">Human-set fields</div>
      <div className="override-list">
        {fields.map((entry) => (
          <article key={entry.field} className="override-item override-item--keep">
            <div className="override-item__head">
              <span className="chip status-chip is-blue">{labelFor(entry.field)}</span>
              {entry.created_at ? <span className="step-time">{displayDate(entry.created_at)}</span> : null}
            </div>
            <p>{entry.value === null || entry.value === '' ? '(cleared)' : entry.value}{entry.reason ? ` — ${entry.reason}` : ''}</p>
          </article>
        ))}
      </div>
    </section>
  );
};

const OverridesSection = ({ overrides }: { overrides: OverrideRecord[] }) => {
  if (!overrides || overrides.length === 0) return null;
  return (
    <section className="detail-section">
      <div className="section-title">Human overrides</div>
      <div className="override-list">
        {overrides.map((override) => (
          <article key={override.id} className={`override-item ${override.kind === 'drop' ? 'override-item--drop' : 'override-item--keep'} ${override.active ? '' : 'is-cleared'}`}>
            <div className="override-item__head">
              <span className={`chip status-chip ${override.kind === 'drop' ? 'is-red' : 'is-blue'}`}>
                {override.kind === 'drop' ? 'Drop' : `Keep · ${override.step_id ? labelFor(override.step_id) : 'all gates'}`}
              </span>
              {override.active ? null : <span className="chip is-muted">cleared</span>}
              {override.created_at ? <span className="step-time">{displayDate(override.created_at)}</span> : null}
            </div>
            <p>{override.reason || 'No reason recorded.'}</p>
            {override.created_by ? <small>{override.created_by}</small> : null}
          </article>
        ))}
      </div>
    </section>
  );
};

const StepCard = ({ step, isTerminal, isInProgress }: { step: RecordDetailStep; isTerminal: boolean; isInProgress: boolean }) => {
  const notReached = humanStatus(step.status) === 'not reached';
  const chips = metadataChips(step);
  return (
  <article className={`step-card ${notReached ? 'is-not-reached' : ''}`}>
    <div className="step-card__head">
      <div>
        <span className="label-with-info">
          <strong>{labelFor(step.id)}</strong>
          {notReached ? null : <InfoTooltip text={step.description} />}
        </span>
      </div>
      <div className="step-card__badges">
        <span className="chip">{labelFor(step.kind)}</span>
        {isInProgress ? (
          <>
            <span className="ao-spinner" aria-label="In progress" role="img" />
            <small>In progress</small>
          </>
        ) : (
          <StatusChip status={step.status} label={step.kind === 'source' && humanStatus(step.status) === 'done' ? 'Sourced' : undefined} />
        )}
        {!notReached && stepTime(step) ? <span className="step-time">{displayDate(stepTime(step))}</span> : null}
      </div>
    </div>
    {notReached ? <p className="muted">Not reached</p> : null}
    {!notReached && hasMetadata(step) && chips.length > 0 ? (
    <div className="meta-row">
      {chips.map((chip) => <span key={chip}>{chip}</span>)}
    </div>
    ) : null}
    {!notReached && isInProgress ? <span className="ao-skeleton" aria-hidden="true" /> : null}
    {!notReached && !isInProgress ? <p>{decisionText(step)}</p> : null}
    {!notReached && step.override ? (
      <div className="override-note">
        <span className="override-note__label">
          Override · kept{step.override.scope === 'all_gates' ? ' (all gates)' : ''}
        </span>
        <p>{step.override.reason}</p>
        <small>{[step.override.created_by, displayDate(step.override.created_at)].filter(Boolean).join(' · ')}</small>
      </div>
    ) : null}
    {!notReached && !isInProgress && Object.keys(step.outputs || {}).length > 0 ? (
      <div className="outputs">
        {Object.entries(step.outputs).map(([key, value]) => (
          <div key={key}>
            <span>{labelFor(key)}</span>
            <OutputValue value={value} />
          </div>
        ))}
      </div>
    ) : null}
    {isTerminal ? <div className="terminal-cap">Pipeline ended here</div> : null}
  </article>
  );
};

const StepsTimeline = ({
  detail,
  statusFilter,
  activeStep,
  recordInProgress,
}: {
  detail: RecordDetail;
  statusFilter: string;
  activeStep: string;
  recordInProgress: boolean;
}) => {
  const terminalStepId = droppedAt(detail.record);
  const steps = Array.isArray(detail.steps) ? detail.steps : [];
  const score = detail.score;
  const scoreValue = numberValue(score?.value);
  const scoreReasoning = score?.reasoning || '';
  const terminalIndex = steps.findIndex((step) => step.id === terminalStepId || humanStatus(step.status) === 'failed' || humanStatus(step.status) === 'dropped');
  const filteredSteps = steps.filter((step) => statusFilter === 'all' || statusKey(step.status) === statusKey(statusFilter));
  const scored = !isDropped(detail.record);

  return (
    <div className="steps-timeline">
      {filteredSteps.map((step) => {
        const originalIndex = steps.findIndex((candidate) => candidate.id === step.id);
        const notReached = humanStatus(step.status) === 'not reached' || (terminalIndex >= 0 && originalIndex > terminalIndex);
        const status = notReached ? 'not reached' : step.status;
        const isInProgress = recordInProgress && step.id === activeStep && activeStep !== '';
        return (
          <div className="timeline-node" key={step.id}>
            <span className={`timeline-dot ${STATUS_CLASS[humanStatus(status)] ?? 'is-ghost'}`} />
            <StepCard step={notReached ? { ...step, status: 'not_reached' } : step} isTerminal={terminalIndex === originalIndex} isInProgress={isInProgress} />
          </div>
        );
      })}
      {scored && statusFilter === 'all' ? (
        <div className="timeline-node">
          <span className="timeline-dot is-green" />
          <article className="step-card scored-node">
            <div className="step-card__head">
              <div>
                <span className="label-with-info">
                  <strong>Scored</strong>
                  <InfoTooltip text="The lead score (0-100) from the configured criteria." />
                </span>
              </div>
              <StatusChip status="ok" />
            </div>
            <p>Score {scoreValue.toFixed(0)}{scoreReasoning ? ` · ${scoreReasoning}` : ''}</p>
          </article>
        </div>
      ) : null}
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
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [tab, setTab] = useState<'score' | 'pipeline' | 'assets'>('score');

  useEffect(() => {
    if (!rowIdValue) return;
    setLoading(true);
    setDetail(null);
    setTab('score');
    fetchRecordDetail(rowIdValue)
      .then(setDetail)
      .finally(() => setLoading(false));
  }, [rowIdValue]);

  useEffect(() => {
    if (!rowIdValue) return undefined;
    const refreshDetail = () => {
      fetchRecordDetail(rowIdValue)
        .then(setDetail)
        .catch(() => undefined);
    };
    const intervalId = window.setInterval(refreshDetail, 1500);
    return () => window.clearInterval(intervalId);
  }, [rowIdValue]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const record = detail?.record;
  const score = detail?.score;
  const scoreValue = numberValue(score?.value);
  const scoreMinimum = numberValue(score?.minimum);
  const overrides = Array.isArray(detail?.overrides) ? detail.overrides : [];

  return (
    <div className={`drawer-root ${rowIdValue ? 'is-open' : ''}`} aria-hidden={!rowIdValue}>
      <button className="scrim" type="button" aria-label="Close detail panel" onClick={onClose} />
      <aside className="detail-panel" aria-label="Record detail">
        <button className="close-button" type="button" onClick={onClose} aria-label="Close">×</button>
        {loading ? <div className="drawer-loading">Loading detail...</div> : null}
        {detail && record ? (
          <>
            <header className="detail-header">
              <div>
                {detail.lead_status ? <LeadStatusBadge status={detail.lead_status} /> : <OutcomeBadge record={record} />}
                <h2>{textValue(identityValue(record, ['business_name', 'name']))}</h2>
                <p>{textValue(identityValue(record, ['address', 'formattedAddress']))}</p>
                <div className="contact-row">
                  {record.website ? <a href={String(record.website)} target="_blank" rel="noreferrer">{String(record.website)}</a> : null}
                  <span>{textValue(identityValue(record, ['phone', 'nationalPhoneNumber']))}</span>
                </div>
              </div>
              <div className="hero-score">
                <span>{scoreValue.toFixed(0)}</span>
                <small>Score{scoreMinimum > 0 ? ` · min ${scoreMinimum}` : ''}</small>
              </div>
            </header>
            <BriefSection brief={detail.brief || null} />
            <nav className="detail-tabs" role="tablist">
              <button className={tab === 'score' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'score'} onClick={() => setTab('score')}>Score</button>
              <button className={tab === 'pipeline' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'pipeline'} onClick={() => setTab('pipeline')}>Pipeline</button>
              <button className={tab === 'assets' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'assets'} onClick={() => setTab('assets')}>
                Assets{Array.isArray(detail.assets) && detail.assets.length > 0 ? ` (${detail.assets.length})` : ''}
              </button>
            </nav>
            {tab === 'score' ? (
              <>
                <ScoreSection detail={detail} />
                <InteractionsSection interactions={Array.isArray(detail.interactions) ? detail.interactions : []} />
                <ManualFieldsSection fields={Array.isArray(detail.manual_fields) ? detail.manual_fields : []} />
                <OverridesSection overrides={overrides} />
              </>
            ) : null}
            {tab === 'pipeline' ? (
              <section className="detail-section">
                <div className="section-title">Steps</div>
                <div className="status-filters">
                  {STATUS_FILTERS.map((status) => (
                    <button className={statusFilter === status ? 'is-active' : ''} type="button" key={status} onClick={() => setStatusFilter(status)}>
                      {labelFor(status)}
                    </button>
                  ))}
                </div>
                <StepsTimeline detail={detail} statusFilter={statusFilter} activeStep={activeStep} recordInProgress={recordInProgress} />
              </section>
            ) : null}
            {tab === 'assets' ? (
              <section className="detail-section">
                <AssetsTab assets={Array.isArray(detail.assets) ? detail.assets : []} />
              </section>
            ) : null}
          </>
        ) : null}
      </aside>
    </div>
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
              <strong>{runActive ? `${runPhaseLabel} running` : (progress && progress.status === 'done' ? `${runPhaseLabel} complete` : 'Idle')}</strong>
              <span>{runDetailText}</span>
            </span>
          </span>
        </div>
        <nav className="route-nav" aria-label="Primary">
          <Link to="/map">Map</Link>
          <Link to="/review">Review</Link>
        </nav>
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
