import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { fetchMeta, fetchRecordDetail, fetchRecords } from './api.js';
import type {
  ActiveFilter,
  ColumnMeta,
  FilterMeta,
  MetaResponse,
  RecordDetail,
  RecordDetailStep,
  RecordRow,
  ScoreAxisName,
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

const displayDate = (value: unknown) => {
  const raw = String(value || '');
  if (!raw) return 'n/a';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString();
};

const latestEventTime = (events: RecordDetailStep['events']) => events.map((event) => event.occurred_at).filter(Boolean).sort().at(-1) || '';
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

const ScoreBar = ({ value }: { value: unknown }) => {
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

const VerdictChip = ({ verdict }: { verdict?: string | null }) => {
  const normalized = verdict || 'n/a';
  return <span className={`chip verdict-chip ${VERDICT_CLASS[normalized] ?? 'is-ghost'}`}>{normalized}</span>;
};

const BooleanValue = ({ value }: { value: unknown }) => <span className="boolean-value">{Number(value) ? 'yes' : 'no'}</span>;

const SCORE_BAR_KEYS = new Set(['fit_score', 'trigger_score', 'priority_rank']);
const isScoreBarColumn = (column: ColumnMeta) => column.group === 'score' && SCORE_BAR_KEYS.has(column.key);
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

const ValueCell = ({ column, record }: { column: ColumnMeta; record: RecordRow }) => {
  const value = record[column.key];
  if (isWebsiteColumn(column)) return <WebsiteCell value={value} />;
  if (column.type === 'verdict') return <VerdictChip verdict={(value as string) || null} />;
  if (column.type === 'status') return <StatusChip status={value || 'n/a'} />;
  if (column.type === 'boolean') return <BooleanValue value={value} />;
  if (column.type === 'number') return isScoreBarColumn(column) ? <ScoreBar value={value} /> : <NumberCell value={value} />;
  return <span className="cell-text">{textValue(value)}</span>;
};

const OutcomeBadge = ({ record }: { record: RecordRow }) => {
  if (isDropped(record)) {
    return <span className="outcome-badge is-dropped">Dropped · {labelFor(droppedAt(record) || 'gate')}</span>;
  }
  return <span className="outcome-badge is-scored">Scored</span>;
};

const OUTCOME_ICON: Record<string, { glyph: string; cls: string; title: string }> = {
  scored: { glyph: '✓', cls: 'outcome-scored', title: 'Scored — passed the funnel and was ranked' },
  dropped: { glyph: '⊘', cls: 'outcome-dropped', title: 'Dropped at a gate' },
  error: { glyph: '✕', cls: 'outcome-error', title: 'Error during processing' },
  processing: { glyph: '◌', cls: 'outcome-processing is-spinning', title: 'Processing' },
  not_scored: { glyph: '–', cls: 'outcome-not-scored', title: 'Not yet scored' },
};

const OutcomeIcon = ({ record }: { record: RecordRow }) => {
  const outcome = String(record.__outcome || (isDropped(record) ? 'dropped' : 'scored'));
  const spec = OUTCOME_ICON[outcome] ?? OUTCOME_ICON.not_scored;
  const title = outcome === 'dropped' ? `Dropped at ${labelFor(droppedAt(record) || 'a gate')}` : spec.title;
  return (
    <span className={`outcome-icon ${spec.cls}`} title={title} aria-label={title} role="img">
      {spec.glyph}
    </span>
  );
};

const FitFrozenCell = ({ record }: { record: RecordRow }) => {
  if (isDropped(record)) return <span className="fit-frozen is-empty">—</span>;
  const score = numberValue(record.fit_score);
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
  onApply,
}: {
  meta: MetaResponse;
  filters: ActiveFilter[];
  onApply: (filter: ActiveFilter) => void;
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
      <label>
        <span>Field</span>
        <select value={sort} onChange={(event) => onSort(event.target.value)}>
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
}: {
  meta: MetaResponse;
  records: RecordRow[];
  visibleColumns: ColumnMeta[];
  sort: string;
  dir: SortDir;
  onSort: (key: string) => void;
  onOpen: (id: string) => void;
}) => {
  const nameColumn = visibleColumns.find((column) => column.locked && (column.key === 'business_name' || column.key === 'name')) || null;
  const nameKey = nameColumn?.key || 'business_name';
  const nameLabel = nameColumn?.label || 'Business';
  // Frozen columns (outcome icon, fit, name) are rendered explicitly; everything
  // else — locked or not — is excluded from the horizontally scrolling set.
  const scrollColumns = visibleColumns.filter(
    (column) => !column.locked && column.key !== 'business_name' && column.key !== 'name',
  );
  return (
  <div className="table-shell">
    <table className="locked-table">
      <thead>
        <tr>
          <th className="col-outcome" aria-label="Outcome"><span className="col-outcome__dot" aria-hidden="true" /></th>
          <th className="col-fit">
            <button className="th-button" type="button" onClick={() => onSort('fit_score')}>
              Fit
              <span>{sort === 'fit_score' ? (dir === 'asc' ? 'Up' : 'Down') : ''}</span>
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
          <tr key={rowId(record)} className={isDropped(record) ? 'is-disqualified' : ''} onClick={() => onOpen(rowId(record))}>
            <td className="col-outcome"><OutcomeIcon record={record} /></td>
            <td className="col-fit"><FitFrozenCell record={record} /></td>
            <td className="col-name">
              <span className="cell-name">{textValue(identityValue(record, ['business_name', 'name']))}</span>
            </td>
            {scrollColumns.map((column) => (
              <td key={column.key}><ValueCell column={column} record={record} /></td>
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

const CriteriaBreakdown = ({ axis, detail }: { axis: ScoreAxisName; detail: RecordDetail }) => {
  const score = detail.score[axis];
  const points = score.criteria.map(criterionPoints);
  const hasScoredCriteria = score.criteria.some((criterion) => criterion.verdict !== null && criterion.verdict !== undefined);
  const sum = points.reduce((total, point) => total + point, 0);
  const scoreTotal = hasScoredCriteria ? sum : numberValue(score.score);

  return (
    <div className="score-card">
      <div className="score-card__top">
        <span>{labelFor(axis)}</span>
        <ScoreBar value={scoreTotal} />
      </div>
      {score.reasoning ? <p>{score.reasoning}</p> : <p className="muted">Axis has not been scored for this lead.</p>}
      <div className="criteria-list">
        {score.criteria.map((criterion) => {
          const notScored = criterion.verdict === null || criterion.verdict === undefined;
          return (
            <div key={criterion.id} className={`criterion ${notScored ? 'is-not-scored' : ''}`}>
              <div>
                <strong>{labelFor(criterion.id)}</strong>
                <small>{criterion.description}</small>
              </div>
              <VerdictChip verdict={criterion.verdict} />
              <strong>{notScored ? '0' : `+${criterionPoints(criterion)}`}</strong>
              <span>{Math.round(numberValue(criterion.weight) * 100)}%</span>
              <p>{notScored ? 'Not scored.' : criterion.reasoning || 'Scored without additional notes.'}</p>
            </div>
          );
        })}
      </div>
      <div className="score-math">{hasScoredCriteria ? `${points.join(' + ')} = ${sum}` : `Not scored · definition weights shown`}</div>
    </div>
  );
};

const ScoreSection = ({ detail }: { detail: RecordDetail }) => (
  <section className="detail-section">
    <div className="section-title">Score</div>
    {(['fit', 'trigger'] as const).map((axis) => <CriteriaBreakdown axis={axis} detail={detail} key={axis} />)}
    <div className="blend-line">{detail.score.priority.computation}</div>
  </section>
);

const OutputValue = ({ value }: { value: unknown }) => {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  if (typeof value === 'boolean' || value === 0 || value === 1) return <span>{Number(value) ? '✓' : '✗'}</span>;
  return <span>{String(value)}</span>;
};

const decisionText = (step: RecordDetailStep) => {
  if (step.reasoning) return step.reasoning;
  if (step.condition_summary) return `${labelFor(step.status)} · ${step.condition_summary}`;
  if (humanStatus(step.status) === 'skipped') return 'Skipped · condition not met';
  if (humanStatus(step.status) === 'not reached' || humanStatus(step.status) === 'n/a') return 'Not reached';
  if (humanStatus(step.status) === 'done') return `Completed · ${step.description}`;
  if (humanStatus(step.status) === 'passed' || humanStatus(step.status) === 'ok') return `Passed · ${step.description}`;
  if (humanStatus(step.status) === 'failed' || humanStatus(step.status) === 'dropped') return `Stopped · ${step.description}`;
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

const StepCard = ({ step, isTerminal }: { step: RecordDetailStep; isTerminal: boolean }) => {
  const notReached = humanStatus(step.status) === 'not reached';
  const chips = metadataChips(step);
  return (
  <article className={`step-card ${notReached ? 'is-not-reached' : ''}`}>
    <div className="step-card__head">
      <div>
        <strong>{labelFor(step.id)}</strong>
        {notReached ? null : <small>{step.description}</small>}
      </div>
      <div className="step-card__badges">
        <span className="chip">{labelFor(step.kind)}</span>
        <StatusChip status={step.status} label={step.kind === 'source' && humanStatus(step.status) === 'done' ? 'Sourced' : undefined} />
        {!notReached && stepTime(step) ? <span className="step-time">{displayDate(stepTime(step))}</span> : null}
      </div>
    </div>
    {notReached ? <p className="muted">Not reached</p> : null}
    {!notReached && hasMetadata(step) && chips.length > 0 ? (
    <div className="meta-row">
      {chips.map((chip) => <span key={chip}>{chip}</span>)}
    </div>
    ) : null}
    {!notReached ? <p>{decisionText(step)}</p> : null}
    {!notReached && Object.keys(step.outputs || {}).length > 0 ? (
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
}: {
  detail: RecordDetail;
  statusFilter: string;
}) => {
  const terminalStepId = droppedAt(detail.record);
  const terminalIndex = detail.steps.findIndex((step) => step.id === terminalStepId || humanStatus(step.status) === 'failed' || humanStatus(step.status) === 'dropped');
  const filteredSteps = detail.steps.filter((step) => statusFilter === 'all' || statusKey(step.status) === statusKey(statusFilter));
  const scored = !isDropped(detail.record);

  return (
    <div className="steps-timeline">
      {filteredSteps.map((step) => {
        const originalIndex = detail.steps.findIndex((candidate) => candidate.id === step.id);
        const notReached = humanStatus(step.status) === 'not reached' || (terminalIndex >= 0 && originalIndex > terminalIndex);
        const status = notReached ? 'not reached' : step.status;
        return (
          <div className="timeline-node" key={step.id}>
            <span className={`timeline-dot ${STATUS_CLASS[humanStatus(status)] ?? 'is-ghost'}`} />
            <StepCard step={notReached ? { ...step, status: 'not_reached' } : step} isTerminal={terminalIndex === originalIndex} />
          </div>
        );
      })}
      {scored && statusFilter === 'all' ? (
        <div className="timeline-node">
          <span className="timeline-dot is-green" />
          <article className="step-card scored-node">
            <div className="step-card__head">
              <div>
                <strong>Scored</strong>
                <small>Fit and trigger criteria produced the priority rank.</small>
              </div>
              <StatusChip status="ok" />
            </div>
            <p>{detail.score.priority.computation}</p>
          </article>
        </div>
      ) : null}
    </div>
  );
};

const DetailPanel = ({
  rowIdValue,
  onClose,
}: {
  rowIdValue: string | null;
  onClose: () => void;
}) => {
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    if (!rowIdValue) return;
    setLoading(true);
    setDetail(null);
    fetchRecordDetail(rowIdValue)
      .then(setDetail)
      .finally(() => setLoading(false));
  }, [rowIdValue]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const record = detail?.record;

  return (
    <div className={`drawer-root ${rowIdValue ? 'is-open' : ''}`} aria-hidden={!rowIdValue}>
      <button className="scrim" type="button" aria-label="Close detail panel" onClick={onClose} />
      <aside className="detail-panel" aria-label="Record detail">
        <button className="close-button" type="button" onClick={onClose}>Close</button>
        {loading ? <div className="drawer-loading">Loading detail...</div> : null}
        {detail && record ? (
          <>
            <header className="detail-header">
              <div>
                <OutcomeBadge record={record} />
                <h2>{textValue(identityValue(record, ['business_name', 'name']))}</h2>
                <p>{textValue(identityValue(record, ['address', 'formattedAddress']))}</p>
                <div className="contact-row">
                  {record.website ? <a href={String(record.website)} target="_blank" rel="noreferrer">{String(record.website)}</a> : null}
                  <span>{textValue(identityValue(record, ['phone', 'nationalPhoneNumber']))}</span>
                </div>
              </div>
              <div className="hero-score">
                <span>{Number(detail.score.priority.rank || 0).toFixed(1)}</span>
                <small>{detail.score.priority.computation}</small>
              </div>
            </header>
            <ScoreSection detail={detail} />
            <section className="detail-section">
              <div className="section-title">Steps</div>
              <div className="status-filters">
                {STATUS_FILTERS.map((status) => (
                  <button className={statusFilter === status ? 'is-active' : ''} type="button" key={status} onClick={() => setStatusFilter(status)}>
                    {labelFor(status)}
                  </button>
                ))}
              </div>
              <StepsTimeline detail={detail} statusFilter={statusFilter} />
            </section>
          </>
        ) : null}
      </aside>
    </div>
  );
};

export const App = () => {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('priority_rank');
  const [dir, setDir] = useState<SortDir>('desc');
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

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
      })
      .catch((nextError: Error) => setError(nextError.message));
  }, [sort, dir, q, filters]);

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

  const activePreset = sort === '_created_at' && dir === 'desc' ? 'newest' : sort === 'priority_rank' && dir === 'desc' ? 'score' : '';
  const onHeaderSort = (key: string) => {
    setSort(key);
    setDir(sort === key && dir === 'desc' ? 'asc' : 'desc');
  };

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
          <span>Scored <strong>{meta.counts.qualified}</strong></span>
          <span>Dropped <strong>{meta.counts.disqualified}</strong></span>
        </div>
      </header>
      <section className="toolbar">
        <div className="preset-row">
          <button className={activePreset === 'score' ? 'is-active' : ''} type="button" onClick={() => { setSort('priority_rank'); setDir('desc'); }}>
            Highest score
          </button>
          <button className={activePreset === 'newest' ? 'is-active' : ''} type="button" onClick={() => { setSort('_created_at'); setDir('desc'); }}>
            Newest
          </button>
          <button className={showingDropped ? 'is-active' : ''} type="button" onClick={toggleDropped}>
            {showingDropped ? 'Dropped shown' : 'Dropped hidden'}
          </button>
          <label className="search-box">
            <span>Search</span>
            <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Name, address, website" />
          </label>
          <FilterBuilder meta={meta} filters={filters} onApply={setFilter} />
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
        <div className="chips-row">
          {filters.map((filter) => (
            <button type="button" className="chip chip-button" key={filter.key} onClick={() => removeFilter(filter.key)}>
              {filterSummary(filter, meta)} ×
            </button>
          ))}
          {filters.length > 0 ? <button className="text-button" type="button" onClick={clearFilters}>Clear all</button> : null}
          <span>{total} matching</span>
        </div>
      </section>
      {error ? <div className="error-banner">{error}</div> : null}
      <TableView meta={meta} records={records} visibleColumns={visibleColumns} sort={sort} dir={dir} onSort={onHeaderSort} onOpen={setSelectedRowId} />
      <DetailPanel rowIdValue={selectedRowId} onClose={() => setSelectedRowId(null)} />
    </main>
  );
};
