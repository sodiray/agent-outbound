export const AGENT_SCHEMA_VERSION = '2.0.0';

export const ERROR_CODES = [
  'BUDGET_EXCEEDED',
  'TOOL_NOT_CONNECTED',
  'DEPENDENT_STEP_EXISTS',
  'SQL_WRITE_BLOCKED',
  'SNAPSHOT_NOT_FOUND',
  'IDEMPOTENCY_KEY_CONFLICT',
  'UNSUPPORTED_MODEL',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'UNSUPPORTED_FORMAT',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = typeof ERROR_CODES[number];

const ERROR_CODE_SET = new Set<string>(ERROR_CODES);

export type StructuredError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  hint: string;
  fields: Record<string, any>;
};

export class AgentOutboundError extends Error {
  code: ErrorCode;
  retryable: boolean;
  hint: string;
  fields: Record<string, any>;
  status: number;

  constructor({
    code = 'INTERNAL_ERROR',
    message = 'Unknown error.',
    retryable = false,
    hint = '',
    fields = {},
    status = 500,
  }: {
    code?: ErrorCode;
    message?: string;
    retryable?: boolean;
    hint?: string;
    fields?: Record<string, any>;
    status?: number;
  }) {
    super(message);
    this.code = code;
    this.retryable = Boolean(retryable);
    this.hint = String(hint || '');
    this.fields = fields && typeof fields === 'object' ? fields : {};
    this.status = Number(status || 500);
  }
}

const emptyUsage = () => ({
  llm: {
    input_tokens: 0,
    output_tokens: 0,
    usd_cost: 0,
  },
  tools: {
    calls: 0,
  },
});

export const successEnvelope = ({
  command,
  list = '',
  result = {},
  warnings = [],
  usage = null,
  signals = null,
  summary = '',
  idemKey = '',
  alreadyDone = false,
}: {
  command: string;
  list?: string;
  result?: any;
  warnings?: any[];
  usage?: any;
  signals?: any;
  summary?: string;
  idemKey?: string;
  alreadyDone?: boolean;
}) => {
  const payload: Record<string, any> = {
    ok: true,
    command: String(command || ''),
    schema_version: AGENT_SCHEMA_VERSION,
    result: result ?? {},
    warnings: Array.isArray(warnings) ? warnings : [],
    usage: usage && typeof usage === 'object' ? usage : emptyUsage(),
  };
  if (list) payload.list = String(list);
  if (signals && typeof signals === 'object' && Object.keys(signals).length > 0) {
    payload.signals = signals;
  }
  if (summary) payload.summary = String(summary);
  if (idemKey) payload.idem_key = String(idemKey);
  if (alreadyDone) payload.already_done = true;
  return payload;
};

export const failureEnvelope = ({
  command,
  list = '',
  error,
  warnings = [],
  usage = null,
}: {
  command: string;
  list?: string;
  error: StructuredError;
  warnings?: any[];
  usage?: any;
}) => {
  const payload: Record<string, any> = {
    ok: false,
    command: String(command || ''),
    schema_version: AGENT_SCHEMA_VERSION,
    error,
    warnings: Array.isArray(warnings) ? warnings : [],
    usage: usage && typeof usage === 'object' ? usage : emptyUsage(),
  };
  if (list) payload.list = String(list);
  return payload;
};

export const toStructuredError = (input: any): StructuredError => {
  if (input instanceof AgentOutboundError) {
    return {
      code: input.code,
      message: String(input.message || 'Unknown error.'),
      retryable: Boolean(input.retryable),
      hint: String(input.hint || ''),
      fields: input.fields && typeof input.fields === 'object' ? input.fields : {},
    };
  }

  const candidateCode = String(input?.code || '').trim().toUpperCase();
  const code = ERROR_CODE_SET.has(candidateCode) ? (candidateCode as ErrorCode) : 'INTERNAL_ERROR';
  const message = String(input?.message || input || 'Unknown error.');
  const retryable = Boolean(input?.retryable);
  const hint = String(input?.hint || '');
  const fields = input?.fields && typeof input.fields === 'object' ? input.fields : {};

  return { code, message, retryable, hint, fields };
};

export const isBudgetExceededError = (input: any) => {
  if (!input) return false;
  if (input instanceof AgentOutboundError) return input.code === 'BUDGET_EXCEEDED';
  const code = String(input?.code || '').trim().toUpperCase();
  return code === 'BUDGET_EXCEEDED';
};
