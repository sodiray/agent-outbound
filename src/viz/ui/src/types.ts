export type RecordValue = string | number | boolean | null;
export type RecordRow = Record<string, RecordValue>;

export type ColumnMeta = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'status' | 'verdict';
  group: 'identity' | 'score' | 'status' | 'step' | 'enrich' | 'source' | 'lifecycle' | 'criterion';
  step_id?: string;
  default_visible?: boolean;
  locked?: boolean;
};

export type FilterMeta = {
  key: string;
  label: string;
  type: 'enum' | 'range' | 'boolean';
  options?: string[];
  min?: number | null;
  max?: number | null;
};

export type ScoreCriterion = {
  id: string;
  description: string;
  weight: number;
  verdict?: 'yes' | 'partial' | 'no' | null;
  sub_score?: number | null;
  points?: number | null;
  reasoning?: string;
};

export type StepStatus =
  | 'done'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'flagged'
  | 'ok'
  | 'dropped'
  | 'not_reached'
  | 'n/a'
  | string;

export type StepMeta = {
  id: string;
  kind: string;
  description: string;
  tool_server?: string | null;
  model?: string | null;
  outputs?: Record<string, { type?: string; description?: string }>;
  criteria?: { fit: ScoreCriterion[]; trigger: ScoreCriterion[] };
  priority_weight?: { fit?: number; trigger?: number };
};

export type MetaResponse = {
  list: { name: string; dir: string };
  counts: { total: number; qualified: number; disqualified: number };
  steps: StepMeta[];
  columns: ColumnMeta[];
  filters: FilterMeta[];
  mapsApiKey: string;
};

export type RecordsResponse = {
  total: number;
  records: RecordRow[];
};

export type OverrideKind = 'keep' | 'drop';

export type OverrideRecord = {
  id: string;
  kind: OverrideKind;
  step_id: string;
  scope: string;
  reason: string;
  created_at: string;
  created_by: string;
  cleared_at: string;
  active: boolean;
};

export type StepOverride = {
  kind: OverrideKind;
  scope: string;
  reason: string;
  created_at: string;
  created_by: string;
};

export type RecordDetailStep = {
  id: string;
  kind: string;
  description: string;
  status: StepStatus;
  tool: { server: string | null; tools: string[] };
  reasoning: string;
  override?: StepOverride | null;
  condition_summary?: string;
  outputs: Record<string, RecordValue>;
  events: Array<{ passed?: boolean; reason?: string; occurred_at?: string }>;
  cost: {
    model: string;
    provider: string;
    input_tokens: number;
    output_tokens: number;
    usd_cost: number | string | null;
    occurred_at: string;
  } | null;
};

export type LeadScore = {
  value: number;
  reasoning: string;
  criteria: ScoreCriterion[];
  minimum: number;
  updated_at: string;
  events: Array<{ axis: string; score: number; reasoning: string; computed_at: string }>;
};

export type ManualField = {
  field: string;
  value: string | null;
  reason: string;
  created_at: string;
};

export type Interaction = {
  interaction_id: string;
  kind: string;
  contact: string;
  summary: string;
  body: string;
  objections: string;
  follow_up_at: string;
  follow_up_done_at: string;
  follow_up_note: string;
  occurred_at: string;
  created_by: string;
};

export type RecordDetail = {
  record: RecordRow;
  lead_status: string;
  manual_fields: ManualField[];
  interactions: Interaction[];
  steps: RecordDetailStep[];
  score: LeadScore;
  timeline: Array<{ kind: string; label: string; detail: string; at: string; cleared?: boolean }>;
  overrides: OverrideRecord[];
};

export type SortDir = 'asc' | 'desc';

export type ActiveFilter =
  | { kind: 'enum'; key: string; value: string }
  | { kind: 'boolean'; key: string; value: string }
  | { kind: 'range'; key: string; min: string; max: string };
