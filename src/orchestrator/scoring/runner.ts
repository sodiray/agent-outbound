import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { ensureRecordColumns, insertScoreEvent, openListDb, upsertRecord } from '../runtime/db.js';
import { readConfig } from '../lib/config.js';
import { emitActivity } from '../runtime/activity.js';
import { recordCostEvent } from '../lib/costs.js';
import { getRecordRowId } from '../lib/record.js';
import { generateObjectWithTools } from '../runtime/llm.js';
import { mapWithConcurrency } from '../lib/concurrency.js';

const ScoreResultSchema = z.object({
  score: z.coerce.number().min(0).max(100),
  reasoning: z.string().default(''),
});

const parseExtra = (value) => {
  try {
    if (!value) return {};
    if (typeof value === 'object') return value;
    return JSON.parse(String(value));
  } catch {
    return {};
  }
};

const stableHash = (value) => createHash('sha256').update(JSON.stringify(value || {})).digest('hex');

const numericOr = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const normalizeWeights = (fitWeight, triggerWeight) => {
  const fit = Math.max(0, numericOr(fitWeight, 0.6));
  const trigger = Math.max(0, numericOr(triggerWeight, 0.4));
  const total = fit + trigger;
  if (total <= 0) return { fit: 0.6, trigger: 0.4 };
  return { fit: fit / total, trigger: trigger / total };
};

const computePriority = ({ fitScore, triggerScore, weights }) =>
  Math.round((numericOr(fitScore) * weights.fit) + (numericOr(triggerScore) * weights.trigger));

const scoringSnapshot = (record) => {
  const { extra_json, ...rest } = record || {};
  const extra = parseExtra(extra_json);
  const ignored = new Set([
    'fit_score',
    'trigger_score',
    'priority_rank',
    'trigger_score_peak',
    'fit_reasoning',
    'trigger_reasoning',
    'fit_updated_at',
    'trigger_updated_at',
    'fit_score_updated_at',
    'trigger_score_updated_at',
    '_updated_at',
    'updated_at',
  ]);
  const out = {};
  for (const [key, value] of Object.entries({ ...rest, ...extra })) {
    if (ignored.has(key)) continue;
    out[key] = value;
  }
  return out;
};

const shouldRescore = ({ db, record, type, description, includeDate }) => {
  const recordId = getRecordRowId(record);
  const snapshot = scoringSnapshot(record);
  const depHash = stableHash({
    description: String(description || ''),
    snapshot,
    day: includeDate ? new Date().toISOString().slice(0, 10) : '',
  });
  const key = `score:${type}`;
  const stale = db.prepare('SELECT dep_hash FROM staleness WHERE record_id = ? AND step_id = ?').get(recordId, key);

  if (!stale || stale.dep_hash !== depHash) {
    db.prepare(`
      INSERT INTO staleness (id, record_id, step_id, dep_hash, cache_ttl, cache_ttl_seconds, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id, step_id) DO UPDATE SET
        dep_hash = excluded.dep_hash,
        cache_ttl = excluded.cache_ttl,
        cache_ttl_seconds = excluded.cache_ttl_seconds,
        updated_at = excluded.updated_at
    `).run(randomUUID(), recordId, key, depHash, '', 0, new Date().toISOString());
    return true;
  }
  return false;
};

const scoreAxis = async ({ db, listDir, record, axis, description, model }) => {
  const recordId = getRecordRowId(record);
  const systemPrompt = [
    `You are scoring outbound leads for axis: ${axis}.`,
    'Read the full record and apply the operator description.',
    'Return an integer score from 0 to 100 and concise reasoning (2-4 sentences).',
    '',
    'Scoring description:',
    String(description || '').trim() || '(empty description)',
  ].join('\n');
  const userPrompt = [
    'Record JSON:',
    JSON.stringify({ ...record, ...parseExtra(record.extra_json) }, null, 2),
  ].join('\n');

  const result = await generateObjectWithTools({
    task: `score-${axis}`,
    model: model || 'haiku',
    schema: ScoreResultSchema,
    prompt: userPrompt,
    systemPrompt,
    userPrompt,
    toolSpec: {},
    maxSteps: 2,
  });

  const parsed = ScoreResultSchema.parse(result.object);
  recordCostEvent({
    db,
    listDir,
    recordId,
    stepId: `score:${axis}`,
    model: model || 'haiku',
    usage: result.usage,
  });

  return {
    score: Math.max(0, Math.min(100, Math.round(Number(parsed.score || 0)))),
    reasoning: String(parsed.reasoning || ''),
  };
};

const applyOverride = ({ score, reasoning, override, overrideReason, axis }) => {
  const value = Number(override);
  if (!Number.isFinite(value)) return { score, reasoning };
  const reason = String(overrideReason || '').trim();
  const note = reason
    ? `Operator override applied (${axis}): ${reason}`
    : `Operator override applied (${axis}).`;
  return {
    score: Math.max(0, Math.min(100, Math.round(value))),
    reasoning: [String(reasoning || '').trim(), note].filter(Boolean).join('\n\n'),
  };
};

export const runScoring = async ({ listDir }) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);

  const scoreConfig = config?.score || {};
  const fitDescription = String(scoreConfig?.fit?.description || '').trim();
  const triggerDescription = String(scoreConfig?.trigger?.description || '').trim();
  const fitModel = String(scoreConfig?.fit?.model || 'haiku');
  const triggerModel = String(scoreConfig?.trigger?.model || 'haiku');
  const weights = normalizeWeights(
    scoreConfig?.priority?.weight?.fit,
    scoreConfig?.priority?.weight?.trigger
  );

  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({
    db,
    columns: [
      { name: 'fit_reasoning', type: 'TEXT' },
      { name: 'trigger_reasoning', type: 'TEXT' },
      { name: 'fit_updated_at', type: 'TEXT' },
      { name: 'trigger_updated_at', type: 'TEXT' },
    ],
  });
  const records = db.prepare('SELECT * FROM records').all();

  const summary = {
    records: records.length,
    scored: 0,
    skipped_unchanged: 0,
    failed: 0,
    errors: [],
  };

  emitActivity({ event: 'phase_start', phase: 'scoring', rows: records.length });

  try {
    await mapWithConcurrency<any, void>(records as any[], async (record) => {
      const recordId = getRecordRowId(record);
      try {
        const rescoreFit = shouldRescore({
          db,
          record,
          type: 'fit',
          description: fitDescription,
          includeDate: false,
        });
        const rescoreTrigger = shouldRescore({
          db,
          record,
          type: 'trigger',
          description: triggerDescription,
          includeDate: true,
        });

        if (!rescoreFit && !rescoreTrigger) {
          summary.skipped_unchanged += 1;
          return;
        }

        const fitRaw = rescoreFit
          ? await scoreAxis({ db, listDir, record, axis: 'fit', description: fitDescription, model: fitModel })
          : { score: numericOr(record.fit_score, 0), reasoning: String(record.fit_reasoning || '') };
        const triggerRaw = rescoreTrigger
          ? await scoreAxis({ db, listDir, record, axis: 'trigger', description: triggerDescription, model: triggerModel })
          : { score: numericOr(record.trigger_score, 0), reasoning: String(record.trigger_reasoning || '') };

        const fit = applyOverride({
          score: fitRaw.score,
          reasoning: fitRaw.reasoning,
          override: record.fit_score_override,
          overrideReason: record.fit_score_override_reason,
          axis: 'fit',
        });
        const trigger = applyOverride({
          score: triggerRaw.score,
          reasoning: triggerRaw.reasoning,
          override: record.trigger_score_override,
          overrideReason: record.trigger_score_override_reason,
          axis: 'trigger',
        });

        const triggerPeak = Math.max(
          numericOr(record.trigger_score_peak, 0),
          numericOr(trigger.score, 0)
        );

        const updatedAt = new Date().toISOString();
        const updated = {
          ...record,
          fit_score: numericOr(fit.score, 0),
          fit_reasoning: fit.reasoning,
          trigger_score: numericOr(trigger.score, 0),
          trigger_reasoning: trigger.reasoning,
          trigger_score_peak: triggerPeak,
          fit_updated_at: updatedAt,
          trigger_updated_at: updatedAt,
          fit_score_updated_at: updatedAt,
          trigger_score_updated_at: updatedAt,
          priority_rank: computePriority({
            fitScore: fit.score,
            triggerScore: trigger.score,
            weights,
          }),
        };

        upsertRecord({ db, row: updated });
        insertScoreEvent({
          db,
          event: {
            event_id: randomUUID(),
            row_id: recordId,
            axis: 'fit',
            score: Number(updated.fit_score || 0),
            reasoning: String(updated.fit_reasoning || ''),
            computed_at: updatedAt,
          },
        });
        insertScoreEvent({
          db,
          event: {
            event_id: randomUUID(),
            row_id: recordId,
            axis: 'trigger',
            score: Number(updated.trigger_score || 0),
            reasoning: String(updated.trigger_reasoning || ''),
            computed_at: updatedAt,
          },
        });
        summary.scored += 1;
        emitActivity({ event: 'row_complete', phase: 'scoring', row: record.business_name || recordId });
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({ record_id: recordId, error: String(error?.message || error) });
        emitActivity({ event: 'error', phase: 'scoring', row: record.business_name || recordId, detail: String(error?.message || error) });
      }
    }, 3);

    emitActivity({ event: 'phase_complete', phase: 'scoring', processed: summary.scored, skipped: summary.skipped_unchanged, failed: summary.failed });
    return summary;
  } finally {
    db.close();
  }
};
