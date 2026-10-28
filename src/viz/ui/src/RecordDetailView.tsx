import { useEffect, useState } from 'react';
import { fetchRecordDetail } from './api.js';
import { InfoTooltip } from './InfoTooltip.js';
import { Markdown } from './markdown.js';
import type {
  Interaction,
  LeadAsset,
  LeadBrief,
  ManualField,
  OverrideRecord,
  RecordDetail,
  RecordDetailStep,
  RecordRow,
  ScoreCriterion,
} from './types.js';

// Record detail and step timeline, shared by the table drawer (/) and the
// pipeline step panels (/pipeline). The Review page loads its drawer's detail
// with `useRecordDetail`.

export const STATUS_CLASS: Record<string, string> = {
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

const STATUS_FILTERS = ['all', 'done', 'passed', 'ok', 'skipped', 'flagged', 'dropped', 'failed', 'not_reached'];

export const identityValue = (record: RecordRow, keys: string[]) => keys.map((key) => record[key]).find((value) => value !== null && value !== '');
export const textValue = (value: unknown) => (value === null || value === undefined || value === '' ? 'n/a' : String(value));
export const numberValue = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
export const labelFor = (key: string) => key.replace(/__status$/, '').replace(/^_+/, '').split(/[_\s-]+/).filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ') || key;
export const humanStatus = (value: unknown) => textValue(value).toLowerCase().replaceAll('_', ' ');
export const statusKey = (value: unknown) => humanStatus(value).replaceAll(' ', '_');
export const rowId = (record: RecordRow) => String(record._row_id ?? record.id ?? '');
export const isDropped = (record: RecordRow) => record.__stage === 'dropped' || Boolean(record.__dropped_at || record.disqualified_at || record.disqualified_gate || record.disqualify_reason);
export const droppedAt = (record: RecordRow) => String(record.__dropped_at || record.disqualified_gate || record.disqualified_at || '');

export const displayDate = (value: unknown) => {
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

export const formatCost = (value: unknown) => {
  if (value === null || value === undefined || value === '') return 'n/a';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(4)}` : 'n/a';
};

const friendlyServer = (server: string | null) => {
  if (!server) return 'n/a';
  return SERVER_LABELS[server] ?? labelFor(server);
};

export const ScoreBar = ({ value, unscored = false }: { value: unknown; unscored?: boolean }) => {
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

export const StatusChip = ({ status, label }: { status: unknown; label?: string }) => {
  const normalized = humanStatus(status);
  return <span className={`chip status-chip ${STATUS_CLASS[normalized] ?? 'is-ghost'}`}>{label || normalized}</span>;
};

export const VerdictChip = ({ verdict, grade }: { verdict?: string | null; grade?: number | null }) => {
  const normalized = verdict || 'n/a';
  const label = grade === null || grade === undefined ? normalized : `${grade}/10`;
  return <span className={`chip verdict-chip ${VERDICT_CLASS[normalized] ?? 'is-ghost'}`}>{label}</span>;
};

export const OutcomeBadge = ({ record }: { record: RecordRow }) => {
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

export const LeadStatusBadge = ({ status }: { status: string }) => {
  const badge = LEAD_STATUS_BADGES[status];
  if (!badge) return null;
  return <span className={`outcome-badge ${badge.className}`}>{badge.label}</span>;
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

export const useRecordDetail = (rowIdValue: string | null, { refreshMs = 0 }: { refreshMs?: number } = {}) => {
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!rowIdValue) {
      setDetail(null);
      return undefined;
    }
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

  useEffect(() => {
    if (!rowIdValue || refreshMs <= 0) return undefined;
    const refreshDetail = () => {
      fetchRecordDetail(rowIdValue)
        .then(setDetail)
        .catch(() => undefined);
    };
    const intervalId = window.setInterval(refreshDetail, refreshMs);
    return () => window.clearInterval(intervalId);
  }, [refreshMs, rowIdValue]);

  return { detail, loading, error };
};

export const RecordDetailContent = ({
  detail,
  activeStep = '',
  recordInProgress = false,
  statusFilter: controlledStatusFilter,
  onStatusFilterChange,
  initialTab = 'score',
}: {
  detail: RecordDetail;
  activeStep?: string;
  recordInProgress?: boolean;
  statusFilter?: string;
  onStatusFilterChange?: (status: string) => void;
  initialTab?: 'score' | 'pipeline' | 'assets';
}) => {
  const [ownStatusFilter, setOwnStatusFilter] = useState('all');
  const [tab, setTab] = useState<'score' | 'pipeline' | 'assets'>(initialTab);
  const statusFilter = controlledStatusFilter ?? ownStatusFilter;
  const setStatusFilter = onStatusFilterChange ?? setOwnStatusFilter;
  const record = detail.record;
  const score = detail.score;
  const scoreValue = numberValue(score?.value);
  const scoreMinimum = numberValue(score?.minimum);
  const overrides = Array.isArray(detail.overrides) ? detail.overrides : [];

  return (
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
  );
};
