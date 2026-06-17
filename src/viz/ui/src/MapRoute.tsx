import { useEffect, useRef, useState } from 'react';
import { APIProvider, Map, Marker, useMap } from '@vis.gl/react-google-maps';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchMeta, fetchRecordDetail, fetchRecords } from './api.js';
import { NEUTRAL_PIN, hasScore, isLocated, pinColor, pointOf, ratioColor, recordScore, rowKey } from './map/colors.js';
import { InfoTooltip } from './InfoTooltip.js';
import { Markdown } from './markdown.js';
import type { ActiveFilter, ColumnMeta, FilterMeta, MetaResponse, RecordDetail, RecordRow, RecordValue, SortDir, Territory } from './types.js';

type PanelMode = 'list' | 'detail' | 'filter' | 'sort';

type MapContentProps = {
  records: RecordRow[];
  territories: Territory[];
  visibleTerritoryIds: Set<string>;
  selectedTerritoryId: string | null;
  territoryFitSignal: number;
  selectedId: string | null;
  fitSignal: number;
  focusId: string | null;
  focusSignal: number;
  floor: number;
  onSelect: (id: string) => void;
};

const FOCUS_ZOOM = 15;

type MapPanelProps = {
  meta: MetaResponse;
  records: RecordRow[];
  selectedId: string | null;
  panelMode: PanelMode;
  collapsed: boolean;
  filters: ActiveFilter[];
  q: string;
  sort: string;
  dir: SortDir;
  onSelect: (id: string) => void;
  onBack: () => void;
  onToggleCollapse: () => void;
  onFit: () => void;
  onOpenFilter: () => void;
  onOpenSort: () => void;
  onApplyFilters: (nextFilters: ActiveFilter[], nextQ: string) => void;
  onApplySort: (nextSort: string, nextDir: SortDir) => void;
  onCloseForm: () => void;
};

type TerritoriesPanelProps = {
  territories: Territory[];
  visibleTerritoryIds: Set<string>;
  selectedTerritoryId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onToggleTerritory: (id: string) => void;
  onToggleAll: () => void;
  onSelectTerritory: (id: string) => void;
};

type LeadListProps = {
  records: RecordRow[];
  selectedId: string | null;
  floor: number;
  onSelect: (id: string) => void;
};

type LeadDetailProps = {
  rowId: string | null;
  onBack: () => void;
};

type FilterFormProps = {
  meta: MetaResponse;
  filters: ActiveFilter[];
  q: string;
  onApply: (nextFilters: ActiveFilter[], nextQ: string) => void;
  onCancel: () => void;
};

type SortFormProps = {
  meta: MetaResponse;
  sort: string;
  dir: SortDir;
  onApply: (nextSort: string, nextDir: SortDir) => void;
  onCancel: () => void;
};

type RangeDraft = Record<string, { min: string; max: string }>;

const DEFAULT_CENTER = { lat: 39.5, lng: -98.35 };
const QUALIFIED_FILTER: ActiveFilter = { kind: 'enum', key: 'disqualified', value: 'qualified' };
const TERRITORY_COLOR = '#f5d547';

const valueText = (value: RecordValue | undefined) => {
  if (value === null || value === undefined) return '';
  return String(value);
};

const leadName = (record: RecordRow) => valueText(record.business_name) || valueText(record.name);

const leadLocation = (record: RecordRow) =>
  [record.city, record.state].filter(Boolean).map((value) => String(value)).join(', ') || valueText(record.address);

const websiteHref = (website: string) => {
  if (!website) return '';
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
};

const labelFor = (key: string) =>
  key.replace(/__status$/, '').replace(/^_+/, '').split(/[_\s-]+/).filter(Boolean).map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ') || key;

const filterOptions = (filter: FilterMeta) => filter.type === 'boolean' ? ['yes', 'no'] : (filter.options || []);

const draftValuesFromFilters = (filters: ActiveFilter[]) =>
  filters.reduce<Record<string, string>>((values, filter) => {
    if (filter.kind === 'range') return values;
    return { ...values, [filter.key]: filter.value };
  }, {});

const draftRangesFromFilters = (filters: ActiveFilter[]) =>
  filters.reduce<RangeDraft>((ranges, filter) => {
    if (filter.kind !== 'range') return ranges;
    return { ...ranges, [filter.key]: { min: filter.min, max: filter.max } };
  }, {});

const sortableColumns = (meta: MetaResponse) => {
  const columns = meta.columns.filter((column) =>
    column.key !== 'disqualified'
    && column.key !== 'state'
    && (column.type === 'number' || column.type === 'text' || column.group === 'score' || column.group === 'identity')
  );
  const priorityColumn = meta.columns.find((column) => column.key === 'priority_rank');
  const fallbackPriority: ColumnMeta = { key: 'priority_rank', label: 'Score', type: 'number', group: 'score' };
  return columns.some((column) => column.key === 'priority_rank') ? columns : [priorityColumn || fallbackPriority, ...columns];
};

const fitToRecords = (map: google.maps.Map, records: RecordRow[]) => {
  const located = records.filter(isLocated);
  if (located.length === 0) {
    map.setCenter(DEFAULT_CENTER);
    map.setZoom(4);
    return;
  }
  if (located.length === 1) {
    map.setCenter(pointOf(located[0]));
    map.setZoom(13);
    return;
  }
  const bounds = new google.maps.LatLngBounds();
  located.forEach((record) => bounds.extend(pointOf(record)));
  map.fitBounds(bounds, { left: 380, top: 64, right: 64, bottom: 64 });
};

const fitToTerritory = (map: google.maps.Map, territory: Territory) => {
  if (territory.polygon.length === 0) return;
  const bounds = new google.maps.LatLngBounds();
  territory.polygon.forEach((point) => bounds.extend(point));
  map.fitBounds(bounds, { left: 380, top: 64, right: 380, bottom: 64 });
};

const ChevronIcon = ({ collapsed }: { collapsed: boolean }) => (
  <svg className="map-panel__chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>
    <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const FilterIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M2 3h12l-5 5v4l-2 1V8L2 3z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
  </svg>
);

const SortIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M5 3v10M2.5 5.5L5 3l2.5 2.5M11 13V3m-2.5 7.5L11 13l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const FitIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M8 2v3M8 11v3M2 8h3M11 8h3M5.8 5.8l-2-2M10.2 10.2l2 2M10.2 5.8l2-2M5.8 10.2l-2 2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

const MapLegend = ({ floor }: { floor: number }) => (
  <div className="map-legend" aria-hidden="true">
    <span className="map-legend__label">{floor > 0 ? floor : 'Low'}</span>
    <span className="map-legend__bar" />
    <span className="map-legend__label">{floor > 0 ? '100' : 'High'}</span>
    <span className="map-legend__sep" />
    <span className="map-legend__swatch" style={{ background: NEUTRAL_PIN }} />
    <span className="map-legend__label">No score</span>
  </div>
);

const TerritoryShapes = ({
  territories,
  visibleTerritoryIds,
  selectedTerritoryId,
  territoryFitSignal,
}: {
  territories: Territory[];
  visibleTerritoryIds: Set<string>;
  selectedTerritoryId: string | null;
  territoryFitSignal: number;
}) => {
  const map = useMap();
  const territoriesRef = useRef(territories);
  territoriesRef.current = territories;

  useEffect(() => {
    if (!map) return undefined;
    const polygons = territories
      .filter((territory) => visibleTerritoryIds.has(territory.id) && territory.polygon.length >= 3)
      .map((territory) => {
        const selected = territory.id === selectedTerritoryId;
        const color = territory.color || TERRITORY_COLOR;
        const polygon = new google.maps.Polygon({
          paths: territory.polygon,
          strokeColor: color,
          strokeOpacity: selected ? 0.95 : 0.72,
          strokeWeight: selected ? 3 : 2,
          fillColor: color,
          fillOpacity: selected ? 0.22 : 0.12,
          clickable: false,
        });
        polygon.setMap(map);
        return polygon;
      });
    return () => polygons.forEach((polygon) => polygon.setMap(null));
  }, [map, selectedTerritoryId, territories, visibleTerritoryIds]);

  useEffect(() => {
    if (!map || !selectedTerritoryId || territoryFitSignal === 0) return;
    const territory = territoriesRef.current.find((candidate) => candidate.id === selectedTerritoryId);
    if (!territory) return;
    fitToTerritory(map, territory);
  }, [map, selectedTerritoryId, territoryFitSignal]);

  return null;
};

const MapContent = ({
  records,
  territories,
  visibleTerritoryIds,
  selectedTerritoryId,
  territoryFitSignal,
  selectedId,
  fitSignal,
  focusId,
  focusSignal,
  floor,
  onSelect,
}: MapContentProps) => {
  const map = useMap();
  const recordsRef = useRef(records);
  const didInitialFit = useRef(false);
  // When deep-linked with ?focus=<id>, suppress the once-only "fit all" so the
  // initial view is centered on the focused lead, not the whole bounds.
  const hasPendingFocus = useRef(Boolean(focusId));
  recordsRef.current = records;

  useEffect(() => {
    if (!map || didInitialFit.current) return;
    if (hasPendingFocus.current) return;
    if (records.length === 0) return;
    fitToRecords(map, records);
    didInitialFit.current = true;
  }, [map, records]);

  useEffect(() => {
    if (!map || fitSignal === 0) return;
    fitToRecords(map, recordsRef.current);
  }, [map, fitSignal]);

  // Deep-link focus: center AND zoom onto the focused lead's pin once its record
  // is loaded. setCenter+setZoom on the live map instance forces a repaint —
  // Google tiles otherwise don't redraw until the next user interaction.
  useEffect(() => {
    if (!map || !focusId) return;
    const record = records.find((candidate) => rowKey(candidate) === focusId);
    if (!record || !isLocated(record)) return;
    map.setCenter(pointOf(record));
    map.setZoom(FOCUS_ZOOM);
    didInitialFit.current = true;
    hasPendingFocus.current = false;
  }, [map, focusId, focusSignal, records]);

  useEffect(() => {
    if (!map || !selectedId) return;
    const record = records.find((candidate) => rowKey(candidate) === selectedId);
    if (record && isLocated(record)) map.panTo(pointOf(record));
  }, [map, selectedId, records]);

  if (!map) return null;

  return (
    <>
      <TerritoryShapes territories={territories} visibleTerritoryIds={visibleTerritoryIds} selectedTerritoryId={selectedTerritoryId} territoryFitSignal={territoryFitSignal} />
      {records.filter(isLocated).map((record) => {
        const id = rowKey(record);
        const selected = Boolean(selectedId) && id === selectedId;
        return (
          <Marker
            key={id}
            position={pointOf(record)}
            zIndex={selected ? 1000 : undefined}
            onClick={() => onSelect(id)}
            icon={{
              path: google.maps.SymbolPath.CIRCLE,
              fillColor: pinColor(record, Boolean(selectedId) && !selected, floor),
              fillOpacity: 1,
              strokeColor: '#ffffff',
              strokeWeight: 2,
              scale: selected ? 9 : 7,
            }}
          />
        );
      })}
    </>
  );
};

const LeadList = ({ records, selectedId, floor, onSelect }: LeadListProps) => {
  if (records.length === 0) return <div className="lead-empty">No leads match.</div>;

  return (
    <div className="lead-list">
      {records.map((record) => {
        const id = rowKey(record);
        return (
          <button
            key={id}
            className={`lead-row${isLocated(record) ? '' : ' is-unlocated'}${id === selectedId ? ' is-active' : ''}`}
            onClick={() => onSelect(id)}
            type="button"
          >
            <span className="lead-row__score" style={{ background: pinColor(record, false, floor) }}>{hasScore(record) ? Math.round(recordScore(record) || 0) : '—'}</span>
            <span className="lead-row__name">{leadName(record)}</span>
            <span className="lead-row__loc">{leadLocation(record)}</span>
          </button>
        );
      })}
    </div>
  );
};

const LeadDetail = ({ rowId, onBack }: LeadDetailProps) => {
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [error, setError] = useState('');
  const [briefOpen, setBriefOpen] = useState(false);

  useEffect(() => {
    if (!rowId) return;
    setDetail(null);
    setError('');
    setBriefOpen(false);
    fetchRecordDetail(rowId)
      .then(setDetail)
      .catch((nextError: Error) => setError(nextError.message));
  }, [rowId]);

  if (!rowId) {
    return <div className="map-detail"><button className="map-detail__back" onClick={onBack} type="button">← Back</button><div className="map-empty">No lead selected</div></div>;
  }

  if (!detail) {
    return <div className="map-detail"><button className="map-detail__back" onClick={onBack} type="button">← Back</button><div className="map-empty">{error || 'Loading lead...'}</div></div>;
  }

  const record = detail.record;
  const website = valueText(record.website);
  const phone = valueText(record.phone);
  const email = valueText(record.email_primary) || valueText(record.contact_email);
  const address = [record.address, record.city, record.state].filter(Boolean).map((value) => String(value)).join(', ');

  return (
    <div className="map-detail">
      <div className="map-detail__actions">
        <button className="map-detail__back" onClick={onBack} type="button">← Back</button>
        <Link className="map-detail__table-link" to={`/?focus=${encodeURIComponent(rowId)}`}>View in Table</Link>
      </div>
      <div className="map-detail__head">
        <div className="map-detail__title">
          <h2>{leadName(record)}</h2>
          <span>{address}</span>
        </div>
        <div className="map-detail__score">
          <strong>{Math.round(detail.score.value)}</strong>
          <span>Score</span>
        </div>
      </div>
      {website || phone || email ? (
        <div className="map-detail__contact">
          {website ? <a href={websiteHref(website)} target="_blank" rel="noreferrer">{website}</a> : null}
          {phone ? <span>{phone}</span> : null}
          {email ? <span>{email}</span> : null}
        </div>
      ) : null}
      {detail.brief ? (
        <section className="map-detail__section">
          <div className="map-detail__section-head">
            <h3>SDR brief</h3>
            {detail.brief.content ? (
              <button type="button" className="text-button" onClick={() => setBriefOpen((value) => !value)}>
                {briefOpen ? 'Hide full brief' : 'Show full brief'}
              </button>
            ) : null}
          </div>
          {detail.brief.summary ? <p className="map-detail__brief-summary"><strong>{detail.brief.summary}</strong></p> : null}
          {briefOpen ? <Markdown text={detail.brief.content} className="map-detail__brief-body" /> : null}
        </section>
      ) : null}
      <section className="map-detail__section">
        <h3>Why this score</h3>
        {detail.score.reasoning ? <p>{detail.score.reasoning}</p> : null}
        <div className="map-detail__criteria">
          {detail.score.criteria.map((criterion) => {
            const grade = criterion.grade;
            const graded = grade !== null && grade !== undefined;
            const scoreLabel = graded ? `${grade}/10` : (criterion.verdict ?? '');
            return (
              <div className="map-detail__criterion" key={criterion.id}>
                <div className="map-detail__criterion-head">
                  <span className="label-with-info">
                    <strong>{labelFor(criterion.id)}</strong>
                    <InfoTooltip text={criterion.description} />
                  </span>
                  {scoreLabel ? <strong style={graded ? { color: ratioColor(Number(grade), 10) } : undefined}>{scoreLabel}</strong> : null}
                </div>
                {criterion.reasoning ? <p className="map-detail__criterion-reason">{criterion.reasoning}</p> : null}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};

const FilterForm = ({ meta, filters, q, onApply, onCancel }: FilterFormProps) => {
  const [draftQ, setDraftQ] = useState(q);
  const [draftValues, setDraftValues] = useState<Record<string, string>>(() => draftValuesFromFilters(filters));
  const [draftRanges, setDraftRanges] = useState<RangeDraft>(() => draftRangesFromFilters(filters));
  const visibleFilters = meta.filters.filter((filter) => filter.key !== 'disqualified');

  const applyDraft = () => {
    const nextFilters = visibleFilters.flatMap((filter): ActiveFilter[] => {
      if (filter.type === 'range') {
        const range = draftRanges[filter.key] || { min: '', max: '' };
        if (!range.min && !range.max) return [];
        return [{ kind: 'range', key: filter.key, min: range.min, max: range.max }];
      }
      const value = draftValues[filter.key] || '';
      if (!value) return [];
      return [{ kind: filter.type === 'boolean' ? 'boolean' : 'enum', key: filter.key, value }];
    });
    onApply(nextFilters, draftQ);
  };

  const clearDraft = () => {
    setDraftQ('');
    setDraftValues({});
    setDraftRanges({});
    onApply([], '');
  };

  return (
    <div className="map-form">
      <label>
        Search
        <input type="text" value={draftQ} onChange={(event) => setDraftQ(event.target.value)} placeholder="Name, address, website" />
      </label>
      {visibleFilters.map((filter) => (
        filter.type === 'range' ? (
          <label key={filter.key}>
            {filter.label || labelFor(filter.key)}
            <span className="map-form__range">
              <input
                type="number"
                value={(draftRanges[filter.key] || { min: '', max: '' }).min}
                onChange={(event) => setDraftRanges((ranges) => ({ ...ranges, [filter.key]: { ...(ranges[filter.key] || { min: '', max: '' }), min: event.target.value } }))}
                placeholder={filter.min === null || filter.min === undefined ? 'Min' : String(filter.min)}
              />
              <input
                type="number"
                value={(draftRanges[filter.key] || { min: '', max: '' }).max}
                onChange={(event) => setDraftRanges((ranges) => ({ ...ranges, [filter.key]: { ...(ranges[filter.key] || { min: '', max: '' }), max: event.target.value } }))}
                placeholder={filter.max === null || filter.max === undefined ? 'Max' : String(filter.max)}
              />
            </span>
          </label>
        ) : (
          <label key={filter.key}>
            {filter.label || labelFor(filter.key)}
            <select value={draftValues[filter.key] || ''} onChange={(event) => setDraftValues((values) => ({ ...values, [filter.key]: event.target.value }))}>
              <option value="">Any</option>
              {filterOptions(filter).map((option) => <option key={option} value={option}>{labelFor(option)}</option>)}
            </select>
          </label>
        )
      ))}
      <div className="map-form__actions">
        <button onClick={applyDraft} type="button">OK</button>
        <button className="is-secondary" onClick={clearDraft} type="button">Clear</button>
        <button className="is-secondary" onClick={onCancel} type="button">Cancel</button>
      </div>
    </div>
  );
};

const SortForm = ({ meta, sort, dir, onApply, onCancel }: SortFormProps) => {
  const options = sortableColumns(meta);
  const [draftSort, setDraftSort] = useState(options.some((column) => column.key === sort) ? sort : 'priority_rank');
  const [draftDir, setDraftDir] = useState<SortDir>(dir);

  return (
    <div className="map-form">
      <label>
        Sort by
        <select value={draftSort} onChange={(event) => setDraftSort(event.target.value)}>
          {options.map((column) => <option key={column.key} value={column.key}>{column.key === 'priority_rank' ? 'Score' : column.label || labelFor(column.key)}</option>)}
        </select>
      </label>
      <label>
        Direction
        <select value={draftDir} onChange={(event) => setDraftDir(event.target.value as SortDir)}>
          <option value="desc">High→Low</option>
          <option value="asc">Low→High</option>
        </select>
      </label>
      <div className="map-form__actions">
        <button onClick={() => onApply(draftSort, draftDir)} type="button">OK</button>
        <button className="is-secondary" onClick={onCancel} type="button">Cancel</button>
      </div>
    </div>
  );
};

const MapPanel = ({
  meta,
  records,
  selectedId,
  panelMode,
  collapsed,
  filters,
  q,
  sort,
  dir,
  onSelect,
  onBack,
  onToggleCollapse,
  onFit,
  onOpenFilter,
  onOpenSort,
  onApplyFilters,
  onApplySort,
  onCloseForm,
}: MapPanelProps) => (
  <aside className={`map-panel${collapsed ? ' is-collapsed' : ''}`}>
    <div className="map-panel__header">
      <button className="map-panel__icon" onClick={onToggleCollapse} type="button" aria-label="Collapse panel">
        <ChevronIcon collapsed={collapsed} />
      </button>
      <span className="map-panel__title">{meta.list.name}</span>
      <button className="map-panel__icon" onClick={onFit} type="button" aria-label="Fit to results">
        <FitIcon />
      </button>
      <button className="map-panel__icon" onClick={onOpenFilter} type="button" aria-label="Filter">
        <FilterIcon />
      </button>
      <button className="map-panel__icon" onClick={onOpenSort} type="button" aria-label="Sort">
        <SortIcon />
      </button>
    </div>
    {collapsed ? null : (
      <div className="map-panel__body">
        {panelMode === 'list' ? <LeadList records={records} selectedId={selectedId} floor={meta.scoreMinimum} onSelect={onSelect} /> : null}
        {panelMode === 'detail' ? <LeadDetail rowId={selectedId} onBack={onBack} /> : null}
        {panelMode === 'filter' ? <FilterForm meta={meta} filters={filters} q={q} onApply={onApplyFilters} onCancel={onCloseForm} /> : null}
        {panelMode === 'sort' ? <SortForm meta={meta} sort={sort} dir={dir} onApply={onApplySort} onCancel={onCloseForm} /> : null}
      </div>
    )}
  </aside>
);

const TerritoriesPanel = ({
  territories,
  visibleTerritoryIds,
  selectedTerritoryId,
  collapsed,
  onToggleCollapse,
  onToggleTerritory,
  onToggleAll,
  onSelectTerritory,
}: TerritoriesPanelProps) => {
  const allVisible = territories.every((territory) => visibleTerritoryIds.has(territory.id));
  const visibleCount = territories.filter((territory) => visibleTerritoryIds.has(territory.id)).length;

  return (
    <aside className={`territories-panel${collapsed ? ' is-collapsed' : ''}`}>
      <div className="territories-panel__header">
        <button className="territories-panel__title" onClick={onToggleCollapse} type="button">Territories</button>
        {collapsed ? null : (
          <button className="territories-panel__toggle-all" onClick={onToggleAll} type="button">
            {allVisible ? 'Hide all' : `Show all (${visibleCount}/${territories.length})`}
          </button>
        )}
      </div>
      {collapsed ? null : (
        <div className="territories-panel__body">
          {territories.map((territory) => {
            const visible = visibleTerritoryIds.has(territory.id);
            const selected = territory.id === selectedTerritoryId;
            return (
              <div className={`territory-row${selected ? ' is-active' : ''}`} key={territory.id}>
                <label className="territory-row__visible">
                  <input type="checkbox" checked={visible} onChange={() => onToggleTerritory(territory.id)} />
                  <span className="territory-row__swatch" style={{ background: territory.color || TERRITORY_COLOR }} />
                </label>
                <div className="territory-row__main">
                  <div className="territory-row__head">
                    <strong>{territory.name}</strong>
                    <span>{territory.lead_count}</span>
                  </div>
                  {territory.description ? <p>{territory.description}</p> : null}
                  <button className="territory-row__action" onClick={() => onSelectTerritory(territory.id)} type="button">Filter to this</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
};

export const MapRoute = () => {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>('list');
  const [collapsed, setCollapsed] = useState(false);
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('priority_rank');
  const [dir, setDir] = useState<SortDir>('desc');
  const [fitSignal, setFitSignal] = useState(0);
  const [territoryFitSignal, setTerritoryFitSignal] = useState(0);
  const [visibleTerritoryIds, setVisibleTerritoryIds] = useState<Set<string>>(() => new Set());
  const [selectedTerritoryId, setSelectedTerritoryId] = useState<string | null>(null);
  const [territoriesCollapsed, setTerritoriesCollapsed] = useState(false);
  const [error, setError] = useState('');
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get('focus');
  const focusHandled = useRef(false);

  useEffect(() => {
    fetchMeta()
      .then(setMeta)
      .catch((nextError: Error) => setError(nextError.message));
  }, []);

  useEffect(() => {
    if (!meta) return;
    fetchRecords({ sort, dir, q, filters: [QUALIFIED_FILTER, ...filters] })
      .then((response) => setRecords(response.records))
      .catch((nextError: Error) => setError(nextError.message));
  }, [meta, sort, dir, q, filters]);

  useEffect(() => {
    if (!meta) return;
    const territories = meta.territories || [];
    setVisibleTerritoryIds((current) => {
      const validIds = new Set(territories.map((territory) => territory.id));
      const retainedIds = [...current].filter((id) => validIds.has(id));
      const nextIds = current.size === 0 ? territories.map((territory) => territory.id) : retainedIds;
      return new Set(nextIds);
    });
  }, [meta]);

  // Deep-link: once records are loaded, open the focused lead's detail panel.
  // Run once per focus id so the user can later navigate away freely.
  useEffect(() => {
    if (!focusId || focusHandled.current || records.length === 0) return;
    if (!records.some((record) => rowKey(record) === focusId)) return;
    setSelectedId(focusId);
    setPanelMode('detail');
    focusHandled.current = true;
  }, [focusId, records]);

  const selectLead = (id: string) => {
    setSelectedId(id);
    setPanelMode('detail');
  };

  const backToList = () => {
    setPanelMode('list');
    setSelectedId(null);
  };

  const applyFilters = (nextFilters: ActiveFilter[], nextQ: string) => {
    setFilters(nextFilters);
    setQ(nextQ);
    setSelectedId(null);
    setPanelMode('list');
  };

  const selectTerritory = (id: string) => {
    setSelectedTerritoryId(id);
    setVisibleTerritoryIds((current) => new Set([...current, id]));
    setFilters((current) => [
      ...current.filter((filter) => filter.key !== 'territory'),
      { kind: 'enum', key: 'territory', value: id },
    ]);
    setSelectedId(null);
    setPanelMode('list');
    setTerritoryFitSignal((signal) => signal + 1);
  };

  const toggleTerritory = (id: string) => {
    setVisibleTerritoryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      next.add(id);
      return next;
    });
  };

  const toggleAllTerritories = () => {
    const territories = meta?.territories || [];
    setVisibleTerritoryIds((current) => current.size === territories.length ? new Set() : new Set(territories.map((territory) => territory.id)));
  };

  const applySort = (nextSort: string, nextDir: SortDir) => {
    setSort(nextSort);
    setDir(nextDir);
    setPanelMode('list');
  };

  if (!meta) {
    return <main className="map-shell"><div className="loading">{error || 'Loading map...'}</div></main>;
  }

  const territories = meta.territories || [];

  return (
    <main className="map-shell">
      <header className="topbar">
        <div className="topbar__id">
          <span className="topbar__name">{meta.list.name}</span>
          <span className="topbar__path">{meta.list.dir}</span>
        </div>
        <Link to="/">← Table</Link>
      </header>
      <div className="map-canvas">
        {meta.mapsApiKey ? (
          <APIProvider apiKey={meta.mapsApiKey}>
            <Map defaultZoom={4} defaultCenter={DEFAULT_CENTER} gestureHandling="greedy" style={{ width: '100%', height: '100%' }}>
              <MapContent
                records={records}
                territories={territories}
                visibleTerritoryIds={visibleTerritoryIds}
                selectedTerritoryId={selectedTerritoryId}
                territoryFitSignal={territoryFitSignal}
                selectedId={selectedId}
                fitSignal={fitSignal}
                focusId={focusId}
                focusSignal={records.length}
                floor={meta.scoreMinimum}
                onSelect={selectLead}
              />
            </Map>
          </APIProvider>
        ) : (
          <div className="map-empty">Google Maps API key not configured</div>
        )}
        {meta.mapsApiKey ? <MapLegend floor={meta.scoreMinimum} /> : null}
        <MapPanel
          meta={meta}
          records={records}
          selectedId={selectedId}
          panelMode={panelMode}
          collapsed={collapsed}
          filters={filters}
          q={q}
          sort={sort}
          dir={dir}
          onSelect={selectLead}
          onBack={backToList}
          onToggleCollapse={() => setCollapsed((value) => !value)}
          onFit={() => setFitSignal((signal) => signal + 1)}
          onOpenFilter={() => setPanelMode('filter')}
          onOpenSort={() => setPanelMode('sort')}
          onApplyFilters={applyFilters}
          onApplySort={applySort}
          onCloseForm={() => setPanelMode('list')}
        />
        {territories.length > 0 ? (
          <TerritoriesPanel
            territories={territories}
            visibleTerritoryIds={visibleTerritoryIds}
            selectedTerritoryId={selectedTerritoryId}
            collapsed={territoriesCollapsed}
            onToggleCollapse={() => setTerritoriesCollapsed((value) => !value)}
            onToggleTerritory={toggleTerritory}
            onToggleAll={toggleAllTerritories}
            onSelectTerritory={selectTerritory}
          />
        ) : null}
      </div>
    </main>
  );
};
