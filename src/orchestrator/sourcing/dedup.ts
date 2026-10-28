import { createHash } from 'node:crypto';
import { z } from 'zod';
import { generateObjectWithTools } from '../runtime/llm.js';
import { cosineSimilarity, embed, float32FromBlob } from '../runtime/embeddings.js';
import { callJev } from '../decide/runner.js';

const DuplicateConfirmationSchema = z.object({
  same: z.boolean(),
  confidence: z.coerce.number().min(0).max(1),
  reasoning: z.string().default(''),
});

const stableHash = (value: any) => createHash('sha256').update(JSON.stringify(value || {})).digest('hex');

const fieldValue = (row: any, fieldName: string) => {
  const raw = row?.[fieldName];
  if (raw === null || raw === undefined) return '';
  return String(raw).trim();
};

export type DedupPayloadField = string | { field: string; label?: string };

const recordPathValue = (row: any, path: string) => path.split('.').reduce((value, part) => {
  if (value === null || value === undefined) return undefined;
  const object = typeof value === 'string'
    ? (() => {
      try { return JSON.parse(value); } catch { return undefined; }
    })()
    : value;
  return object && typeof object === 'object' ? object[part] : undefined;
}, row);

const configuredPayloadField = (value: DedupPayloadField) => {
  const field = typeof value === 'string' ? value : value?.field;
  const label = typeof value === 'string' ? value : value?.label || value?.field;
  return { field: String(field || '').trim(), label: String(label || '').trim() };
};

export const buildDedupPayload = ({ row, fields, maxCharsPerField = 500 }: {
  row: any;
  fields?: DedupPayloadField[];
  maxCharsPerField?: number;
}) => (fields || [])
  .map(configuredPayloadField)
  .map(({ field, label }) => {
    const raw = recordPathValue(row, field);
    const value = raw === null || raw === undefined ? '' : String(raw).trim();
    return value && field && label ? `${label}: ${value.slice(0, maxCharsPerField)}` : '';
  })
  .filter(Boolean)
  .join('\n');

const hasDecideConfig = (aiConfig: any) => Boolean(String(aiConfig?.decide?.model || '').trim());

export type DedupRunState = {
  calls: number;
  maxCalls: number;
  ceilingReached: boolean;
};

export const createDedupRunState = ({ maxCalls = 100 }: { maxCalls?: number } = {}) => ({
  calls: 0,
  maxCalls: Math.max(0, Number(maxCalls) || 0),
  ceilingReached: false,
});

export const getIdentityFields = (config: any) => {
  const sourceIdentity = Array.isArray(config?.source?.identity) ? config.source.identity : [];
  const fields = [...sourceIdentity]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (fields.length > 0) return Array.from(new Set(fields));
  return ['business_name', 'address'];
};

export const buildIdentityString = ({ row, identityFields }: { row: any; identityFields: string[] }) => {
  return identityFields
    .map((field) => fieldValue(row, field))
    .filter(Boolean)
    .join(', ')
    .trim();
};

export const buildIdentityHash = ({ row, identityFields }: { row: any; identityFields: string[] }) => {
  return stableHash({
    identity_fields: identityFields,
    values: identityFields.map((field) => fieldValue(row, field)),
  });
};

const resolveCanonicalRowId = ({ db, startRowId }: { db: any; startRowId: string }) => {
  let current = String(startRowId || '').trim();
  if (!current) return '';
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const row = db.prepare('SELECT _row_id, duplicate_of FROM records WHERE _row_id = ? LIMIT 1').get(current);
    if (!row) break;
    const next = String(row.duplicate_of || '').trim();
    if (!next || next === current) return String(row._row_id || current);
    current = next;
  }
  return current;
};

export const confirmDuplicate = async ({
  incoming,
  candidate,
  fields,
  maxCharsPerField,
  context,
  aiConfig,
  generateObject = generateObjectWithTools,
}: {
  incoming: any;
  candidate: any;
  identityFields?: string[];
  fields: DedupPayloadField[];
  maxCharsPerField?: number;
  context?: string;
  aiConfig?: any;
  generateObject?: typeof generateObjectWithTools;
}) => {
  const state = {
    record_a: buildDedupPayload({ row: incoming, fields: fields || [], maxCharsPerField }),
    record_b: buildDedupPayload({ row: candidate, fields: fields || [], maxCharsPerField }),
    ...(String(context || '').trim() ? { context: String(context).trim() } : {}),
  };
  const question = 'Do records A and B refer to the same real-world entity (the same person or the same business)?';
  if (hasDecideConfig(aiConfig)) {
    const model = String(aiConfig?.decide?.model || '').trim();
    const { body } = await callJev({
      decide: aiConfig.decide,
      request: {
        model,
        state,
        questions: {
          same_entity: { type: 'noul', instructions: question },
        },
      },
    });
    const answer = body.answers && typeof body.answers === 'object'
      ? (body.answers as Record<string, any>).same_entity
      : null;
    const confidence = Number(answer?.noul);
    if (answer?.type !== 'noul' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('Jev response is missing a complete same_entity answer');
    }
    const usage = body.usage && typeof body.usage === 'object' ? body.usage : {};
    return {
      same: confidence >= 0.5,
      confidence: confidence >= 0.5 ? confidence : 1 - confidence,
      same_probability: confidence,
      reasoning: '',
      usage: { ...usage, provider: 'jev' },
      model,
      provider: 'jev',
    };
  }
  const prompt = [
    question,
    'Return same/confidence/reasoning. Confidence is a 0-1 decimal.',
    '',
    'State:',
    JSON.stringify(state, null, 2),
  ].join('\n');

  const result = await generateObject({
    task: 'dedup-confirm',
    role: 'evaluation',
    aiConfig: aiConfig || {},
    schema: DuplicateConfirmationSchema,
    prompt,
    toolSpec: {},
    maxSteps: 2,
  });

  return {
    ...DuplicateConfirmationSchema.parse(result.object),
    usage: result.usage,
    model: result.model,
    provider: result.provider,
  };
};

const vectorCandidates = ({
  db,
  embedding,
  threshold,
  sourceRowId,
}: {
  db: any;
  embedding: Float32Array;
  threshold: number;
  sourceRowId?: string;
}) => {
  const rows = db.prepare('SELECT row_id, embedding FROM record_embeddings').all();
  const selfRowId = String(sourceRowId || '').trim();

  const scored = rows.map((row: any) => {
    const rowId = String(row.row_id || '').trim();
    if (!rowId || (selfRowId && rowId === selfRowId)) return null;
    const other = float32FromBlob(row.embedding);
    const similarity = cosineSimilarity(embedding, other);
    return {
      similarity,
      row_id: rowId,
    };
  }).filter(Boolean);

  return scored
    .filter((item: any) => Number(item.similarity || 0) >= threshold)
    .sort((a: any, b: any) => Number(b.similarity || 0) - Number(a.similarity || 0));
};

export const upsertRecordEmbedding = ({ db, rowId, embedding, identityHash }: {
  db: any;
  rowId: string;
  embedding: Float32Array;
  identityHash: string;
}) => {
  db.prepare(`
    INSERT INTO record_embeddings (row_id, embedding, identity_hash, embedded_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(row_id) DO UPDATE SET
      embedding = excluded.embedding,
      identity_hash = excluded.identity_hash,
      embedded_at = excluded.embedded_at
  `).run(
    rowId,
    Buffer.from(embedding.buffer),
    identityHash,
    new Date().toISOString()
  );
};

export const aiDedupLink = async ({
  db,
  row,
  identityFields,
  threshold = 0.85,
  aiConfig = {},
  dedupKey = '',
  aiDedup,
  maxCandidates = 3,
  fields,
  maxCharsPerField,
  context,
  runState,
  onConfirmation,
  confirm = confirmDuplicate,
  embedIdentity = embed,
}: {
  db: any;
  row: any;
  identityFields: string[];
  threshold?: number;
  aiConfig?: any;
  dedupKey?: string;
  aiDedup?: 'on' | 'off';
  fields?: DedupPayloadField[];
  maxCharsPerField?: number;
  context?: string;
  maxCandidates?: number;
  runState?: DedupRunState;
  onConfirmation?: (confirmation: any) => void;
  confirm?: typeof confirmDuplicate;
  embedIdentity?: typeof embed;
}) => {
  const sourceRowId = String(row?._row_id || '').trim();
  const identityText = buildIdentityString({ row, identityFields });
  const identityHash = buildIdentityHash({ row, identityFields });
  const confirmations: any[] = [];
  const exactKey = String(dedupKey || '').trim();
  const exactKeyIsIdentity = Boolean(exactKey && identityFields.includes(exactKey) && fieldValue(row, exactKey));
  const opaqueIdentity = identityFields.length === 1 && /^[a-f0-9]{24}$/i.test(fieldValue(row, identityFields[0] || ''));
  const aiDedupDisabled = aiDedup === 'off'
    || !Array.isArray(fields)
    || fields.length === 0
    || (aiDedup !== 'on' && (exactKeyIsIdentity || opaqueIdentity));

  if (!identityText || aiDedupDisabled) {
    return {
      duplicate_of: '',
      duplicate_status: '',
      identity_hash: identityHash,
      embedding: new Float32Array(0),
      reasoning: '',
      confidence: 0,
      similarity: 0,
      model: '',
      provider: '',
      usage: null,
      confirmations,
    };
  }

  if (runState?.ceilingReached || (runState && runState.calls >= runState.maxCalls)) {
    if (runState) runState.ceilingReached = true;
    return {
      duplicate_of: '',
      duplicate_status: 'needs_review',
      identity_hash: identityHash,
      embedding: new Float32Array(0),
      reasoning: 'AI dedup run call ceiling reached.',
      confidence: 0,
      similarity: 0,
      model: '',
      provider: '',
      usage: null,
      confirmations,
    };
  }

  const embedding = await embedIdentity(identityText);
  const candidates = vectorCandidates({ db, embedding, threshold, sourceRowId })
    .slice(0, Math.max(0, Number(maxCandidates) || 0));

  for (const candidate of candidates) {
    if (runState && runState.calls >= runState.maxCalls) {
      runState.ceilingReached = true;
      return {
        duplicate_of: '',
        duplicate_status: 'needs_review',
        identity_hash: identityHash,
        embedding,
        reasoning: 'AI dedup run call ceiling reached.',
        confidence: 0,
        similarity: 0,
        model: '',
        provider: '',
        usage: null,
        confirmations,
      };
    }
    const candidateRow = db.prepare('SELECT * FROM records WHERE _row_id = ? LIMIT 1').get(candidate.row_id);
    if (!candidateRow) continue;
    if (runState) runState.calls += 1;
    const confirmed = await confirm({
      incoming: row,
      candidate: candidateRow,
      identityFields,
      fields,
      maxCharsPerField,
      context,
      aiConfig,
    });
    confirmations.push(confirmed);
    onConfirmation?.(confirmed);

    if (!confirmed.same) continue;

    const canonical = resolveCanonicalRowId({ db, startRowId: String(candidate.row_id || '') });
    if (canonical && sourceRowId && canonical === sourceRowId) continue;
    const confidence = Number(confirmed.confidence || 0);

    return {
      duplicate_of: confidence >= 0.7 ? canonical : '',
      duplicate_status: confidence >= 0.7 ? 'confirmed' : 'needs_review',
      identity_hash: identityHash,
      embedding,
      reasoning: String(confirmed.reasoning || ''),
      confidence,
      similarity: Number(candidate.similarity || 0),
      model: String(confirmed.model || ''),
      provider: String(confirmed.provider || ''),
      usage: confirmed.usage || null,
      confirmations,
    };
  }

  return {
    duplicate_of: '',
    duplicate_status: '',
    identity_hash: identityHash,
    embedding,
    reasoning: '',
    confidence: 0,
    similarity: 0,
    model: '',
    provider: '',
    usage: null,
    confirmations,
  };
};
