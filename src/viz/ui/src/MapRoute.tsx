import { useEffect, useRef, useState } from 'react';
import { APIProvider, Map, Marker, useMap } from '@vis.gl/react-google-maps';
import { Link } from 'react-router-dom';
import { fetchMeta, fetchRecordDetail, fetchRecords } from './api.js';
import { NEUTRAL_PIN, hasScore, isLocated, pinColor, pointOf, rowKey } from './map/colors.js';
import type { ActiveFilter, ColumnMeta, FilterMeta, MetaResponse, RecordDetail, RecordRow, RecordValue, SortDir } from './types.js';

type PanelMode = 'list' | 'detail' | 'filter' | 'sort';

type MapContentProps = {
  records: RecordRow[];
  selectedId: string | null;
  fitSignal: number;
  onSelect: (id: string) => void;
};

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

type LeadListProps = {
  records: RecordRow[];
  selectedId: string | null;
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

const MapLegend = () => (
  <div className="map-legend" aria-hidden="true">
    <span className="map-legend__label">Low</span>
    <span className="map-legend__bar" />
    <span className="map-legend__label">High</span>
    <span className="map-legend__sep" />
    <span className="map-legend__swatch" style={{ background: NEUTRAL_PIN }} />
    <span className="map-legend__label">No score</span>
  </div>
);

const MapContent = ({ records, selectedId, fitSignal, onSelect }: MapContentProps) => {
  const map = useMap();
  const recordsRef = useRef(records);
  const didInitialFit = useRef(false);
  recordsRef.current = records;

  useEffect(() => {
    if (!map || didInitialFit.current) return;
    if (records.length === 0) return;
    fitToRecords(map, records);
    didInitialFit.current = true;
  }, [map, records]);

  useEffect(() => {
    if (!map || fitSignal === 0) return;
    fitToRecords(map, recordsRef.current);
  }, [map, fitSignal]);

  useEffect(() => {
    if (!map || !selectedId) return;
    const record = records.find((candidate) => rowKey(candidate) === selectedId);
    if (record && isLocated(record)) map.panTo(pointOf(record));
  }, [map, selectedId, records]);

  if (!map) return null;

  return (
    <>
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
              fillColor: pinColor(record, Boolean(selectedId) && !selected),
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

const LeadList = ({ records, selectedId, onSelect }: LeadListProps) => {
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
            <span className="lead-row__score" style={{ background: pinColor(record) }}>{hasScore(record) ? Math.round(Number(record.priority_rank)) : '—'}</span>
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

  useEffect(() => {
    if (!rowId) return;
    setDetail(null);
    setError('');
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
      <button className="map-detail__back" onClick={onBack} type="button">← Back</button>
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
      <section className="map-detail__section">
        <h3>Why this score</h3>
        <p>{detail.score.reasoning}</p>
        <div className="map-detail__criteria">
          {detail.score.criteria.map((criterion) => (
            <div className="map-detail__criterion" key={criterion.id}>
              <span>{criterion.description}</span>
              <strong>{[criterion.verdict ?? '', criterion.points ?? ''].filter(Boolean).map((value) => String(value)).join(' · ')}</strong>
            </div>
          ))}
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
        {panelMode === 'list' ? <LeadList records={records} selectedId={selectedId} onSelect={onSelect} /> : null}
        {panelMode === 'detail' ? <LeadDetail rowId={selectedId} onBack={onBack} /> : null}
        {panelMode === 'filter' ? <FilterForm meta={meta} filters={filters} q={q} onApply={onApplyFilters} onCancel={onCloseForm} /> : null}
        {panelMode === 'sort' ? <SortForm meta={meta} sort={sort} dir={dir} onApply={onApplySort} onCancel={onCloseForm} /> : null}
      </div>
    )}
  </aside>
);

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
  const [error, setError] = useState('');

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

  const applySort = (nextSort: string, nextDir: SortDir) => {
    setSort(nextSort);
    setDir(nextDir);
    setPanelMode('list');
  };

  if (!meta) {
    return <main className="map-shell"><div className="loading">{error || 'Loading map...'}</div></main>;
  }

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
              <MapContent records={records} selectedId={selectedId} fitSignal={fitSignal} onSelect={selectLead} />
            </Map>
          </APIProvider>
        ) : (
          <div className="map-empty">Google Maps API key not configured</div>
        )}
        {meta.mapsApiKey ? <MapLegend /> : null}
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
      </div>
    </main>
  );
};
