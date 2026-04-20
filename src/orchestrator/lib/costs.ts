import { randomUUID } from 'node:crypto';
import { insertCostEvent, logCostEventFile } from '../runtime/db.js';

export const recordCostEvent = ({ db, listDir, recordId = '', stepId, model = '', usage = null, provider = 'anthropic' }) => {
  if (!usage) return;

  const event = {
    id: randomUUID(),
    record_id: recordId,
    step_id: String(stepId || 'unknown_step'),
    model: String(model || ''),
    input_tokens: Number(usage?.input_tokens || 0),
    output_tokens: Number(usage?.output_tokens || 0),
    cache_creation_tokens: Number(usage?.cache_creation_tokens || 0),
    cache_read_tokens: Number(usage?.cache_read_tokens || 0),
    tool_calls: Array.isArray(usage?.tool_calls) ? usage.tool_calls : [],
    usd_cost: Number(usage?.usd_cost || 0),
    provider,
    payload: usage,
    occurred_at: new Date().toISOString(),
  };

  insertCostEvent({ db, event });
  logCostEventFile({ listDir, payload: event });
};
