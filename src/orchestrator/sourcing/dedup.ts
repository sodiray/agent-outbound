import { createHash } from 'node:crypto';
import { z } from 'zod';
import { generateObjectWithTools } from '../runtime/llm.js';
import { cosineSimilarity, embed, float32FromBlob } from '../runtime/embeddings.js';

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

const confirmDuplicate = async ({ incoming, candidate, aiConfig }: { incoming: any; candidate: any; aiConfig?: any }) => {
  const prompt = [
    'Determine whether these two business records represent the same business location.',
    'Return same/confidence/reasoning. Confidence is a 0-1 decimal.',
    '',
    'Record A (incoming):',
    JSON.stringify(incoming, null, 2),
    '',
    'Record B (candidate):',
    JSON.stringify(candidate, null, 2),
  ].join('\n');

  const result = await generateObjectWithTools({
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

export const aiDedupLink = async ({ db, row, identityFields, threshold = 0.85, aiConfig = {} }: {
  db: any;
  row: any;
  identityFields: string[];
  threshold?: number;
  aiConfig?: any;
}) => {
  const sourceRowId = String(row?._row_id || '').trim();
  const identityText = buildIdentityString({ row, identityFields });
  const identityHash = buildIdentityHash({ row, identityFields });

  if (!identityText) {
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
    };
  }

  const embedding = await embed(identityText);
  const candidates = vectorCandidates({ db, embedding, threshold, sourceRowId });

  for (const candidate of candidates) {
    const candidateRow = db.prepare('SELECT * FROM records WHERE _row_id = ? LIMIT 1').get(candidate.row_id);
    if (!candidateRow) continue;
    const confirmed = await confirmDuplicate({
      incoming: row,
      candidate: candidateRow,
      aiConfig,
    });

    if (!confirmed.same) continue;

    const status = Number(confirmed.confidence || 0) >= 0.7 ? 'confirmed' : 'needs_review';
    const canonical = resolveCanonicalRowId({ db, startRowId: String(candidate.row_id || '') });
    if (canonical && sourceRowId && canonical === sourceRowId) continue;

    return {
      duplicate_of: canonical,
      duplicate_status: status,
      identity_hash: identityHash,
      embedding,
      reasoning: String(confirmed.reasoning || ''),
      confidence: Number(confirmed.confidence || 0),
      similarity: Number(candidate.similarity || 0),
      usage: confirmed.usage || null,
      model: String(confirmed.model || ''),
      provider: String(confirmed.provider || ''),
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
    usage: null,
    model: '',
    provider: '',
  };
};
