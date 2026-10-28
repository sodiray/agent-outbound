import { ensureRecordColumns, upsertRecord } from '../runtime/db.js';
import { recordCostEvent } from '../lib/costs.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { getRecordRowId } from '../lib/record.js';
import {
  isMemoizationFresh,
  memoizationCacheDetailsForResolvedInputs,
  memoizationConfigForStep,
  readStaleness,
  writeStaleness,
} from '../enrichment/runner.js';
import { decideOutputColumnsFor, optionsForDecideQuestion as optionsForQuestion } from './outputs.js';

type DecideStep = Record<string, unknown>;
type Row = Record<string, unknown>;
type DecideOutcome = {
  passed: boolean;
  reason: string;
  errored?: boolean;
  executed?: boolean;
  declaredOutputWrites?: Record<string, { provided: boolean; value: unknown }>;
};

const object = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const recordValues = (row: Row): Row => {
  const extra = typeof row.extra_json === 'string'
    ? (() => {
      try { return object(JSON.parse(row.extra_json)); } catch { return {}; }
    })()
    : object(row.extra_json);
  return { ...extra, ...row };
};

const stateValue = (record: Row, field: string): unknown => {
  if (record[field] !== undefined) return record[field];
  if (field === 'company') return record.business_name;
  if (field === 'title') return record.contact_title || record.contact_title_primary;
  return undefined;
};

const questionRequest = ({ question, listDir }: { question: Record<string, unknown>; listDir: string }) => {
  const type = String(question.type);
  if (type === 'yes_no') return { type: 'noul', instructions: question.instructions };
  if (type === 'score') return { type, instructions: question.instructions, criteria: question.levels };
  const options = optionsForQuestion({ question, listDir });
  const optionText = String(question.option_text || '').trim();
  const criteria = Object.fromEntries(Object.entries(options).map(([name, value]) => [
    name,
    optionText ? object(value)[optionText] : value,
  ]));
  return { type, instructions: question.instructions, criteria };
};

const requestFor = ({ step, row, listDir, model }: { step: DecideStep; row: Row; listDir: string; model: string }) => {
  const record = recordValues(row);
  const state = Object.fromEntries((Array.isArray(step.state) ? step.state : []).map((field) => [String(field), stateValue(record, String(field))]));
  if (String(step.context || '').trim()) state.context = String(step.context);
  const questions = Object.fromEntries(Object.entries(object(step.questions)).map(([id, raw]) => [
    id,
    questionRequest({ question: object(raw), listDir }),
  ]));
  return { model, state, questions };
};

const memoQuestionDefinitions = ({ step, listDir }: { step: DecideStep; listDir: string }) => Object.fromEntries(
  Object.entries(object(step.questions)).map(([id, raw]) => {
    const question = object(raw);
    return [id, {
      ...question,
      ...(question.options_file ? { resolved_options: optionsForQuestion({ question, listDir }) } : {}),
    }];
  }),
);

const outputFor = ({ step, response, listDir }: { step: DecideStep; response: Record<string, unknown>; listDir: string }) => {
  const answers = object(response.answers);
  const outputs: Record<string, unknown> = {};
  for (const [id, rawQuestion] of Object.entries(object(step.questions))) {
    const question = object(rawQuestion);
    const answer = object(answers[id]);
    const type = String(question.type);
    if (type === 'yes_no') {
      const value = Number(answer.noul);
      if (answer.type !== 'noul' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Jev response is missing a complete ${id} answer`);
      outputs[id] = value;
      continue;
    }
    const value = answer[type];
    const confidence = Number(answer.confidence);
    const probabilities = object(answer.probabilities);
    if (answer.type !== type || (type === 'score' && !Number.isFinite(Number(value))) || (type === 'choice' && !String(value || '').trim()) || !Number.isFinite(confidence) || Object.keys(probabilities).length === 0) {
      throw new Error(`Jev response is missing a complete ${id} answer`);
    }
    outputs[id] = type === 'score' ? Number(value) : String(value);
    outputs[`${id}_confidence`] = confidence;
    outputs[`${id}_probabilities`] = JSON.stringify(probabilities);
    if (type === 'choice' && question.options_file) {
      const selected = object(optionsForQuestion({ question, listDir })[String(value)]);
      Object.entries(selected).forEach(([key, extra]) => {
        if (key !== String(question.option_text || '').trim()) outputs[`${id}_${key}`] = typeof extra === 'string' ? extra : JSON.stringify(extra);
      });
    }
  }
  return outputs;
};

const declaredWrites = (outputs: Record<string, unknown>) => Object.fromEntries(Object.entries(outputs).map(([name, value]) => [name, { provided: true, value }]));

export const callJev = async ({
  decide,
  request,
}: {
  decide: Record<string, unknown>;
  request: Record<string, unknown>;
}) => {
  const model = String(decide.model || '').trim();
  const envName = String(decide.api_key_env || 'JEV_API_KEY').trim() || 'JEV_API_KEY';
  const apiKey = String(process.env[envName] || '').trim();
  if (!model || !apiKey) throw new Error(`Jev configuration is missing model or ${envName}`);
  const baseUrl = String(process.env.JEV_BASE_URL || 'https://api.typesafe.ai').replace(/\/$/, '');
  const timeoutMs = Number(process.env.JEV_TIMEOUT_MS || 10_000);
  const response = await fetch(`${baseUrl}/v1/systemone`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000),
  });
  const responseText = await response.text();
  let body: Record<string, unknown>;
  try { body = object(JSON.parse(responseText)); } catch { throw new Error('Jev returned malformed JSON'); }
  if (!response.ok) throw new Error(`Jev returned ${response.status}`);
  return { body, model };
};

export const executeDecideStepOnRecords = async ({
  db, listDir, config, step, stepId, rows, force = false,
}: {
  db: any; listDir: string; config: Record<string, unknown>; step: DecideStep; stepId: string; rows: Row[]; force?: boolean;
}) => {
  const decide = object(object(config.ai).decide);
  const model = String(decide.model || '').trim();
  const memoize = memoizationConfigForStep(step) || { ttl_days: 90 };
  const allOutputColumns = decideOutputColumnsFor({ step, listDir });
  const auditColumn = `${stepId}_decision_audit`;
  ensureRecordColumns({ db, columns: [...allOutputColumns, auditColumn] });
  const outcomes = await mapWithConcurrency(rows, async (row) => {
    const recordId = getRecordRowId(row);
    const request = requestFor({ step, row, listDir, model });
    const cache = memoizationCacheDetailsForResolvedInputs({
      memoization: memoize,
      inputs: request.state,
      stepDefinition: {
        model,
        context: step.context,
        questions: memoQuestionDefinitions({ step, listDir }),
      },
    });
    const cached = readStaleness({ db, recordId, stepId });
    if (isMemoizationFresh({ cached, hashes: cache, force })) {
      return [recordId, { passed: true, executed: false, reason: 'memoization_hit' }] as const;
    }
    try {
      const { body } = await callJev({ decide, request });
      const outputs = outputFor({ step, response: body, listDir });
      const audit = JSON.stringify({ request, response: body });
      upsertRecord({ db, row: { ...row, ...outputs, [auditColumn]: audit } });
      writeStaleness({ db, recordId, stepId, ...cache });
      const usage = object(body.usage);
      recordCostEvent({ db, listDir, recordId, stepId, model, provider: 'jev', usage: {
        input_tokens: Number(usage.input_tokens || 0), output_tokens: Number(usage.output_tokens || 0), provider: 'jev',
      } });
      return [recordId, { passed: true, reason: '', declaredOutputWrites: declaredWrites(outputs) }] as const;
    } catch (error) {
      return [recordId, {
        passed: false,
        errored: true,
        reason: String((error as Error)?.message || error),
      }] as const;
    }
  }, Number(step.concurrency || 10));
  return new Map<string, DecideOutcome>(outcomes);
};
