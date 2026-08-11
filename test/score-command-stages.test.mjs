import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { scoreCommand } from '../dist/commands/index.js';
import { openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

const listDir = () => mkdtempSync(join(tmpdir(), 'agent-outbound-score-command-'));

const outputs = (key) => `
      ${key}_score: { type: number }
      ${key}_breakdown: { type: json }
      ${key}_reasoning: { type: string }`;

test('score command runs configured score stages in pipeline order', async () => {
  const root = listDir();
  writeFileSync(join(root, 'outbound.yaml'), `
pipeline:
  - kind: score
    id: score_fit_initial
    key: fit
    inputs: [business_name]
    model: openrouter/anthropic/claude-haiku-4.5
    criteria: []
    outputs:${outputs('fit')}
  - kind: score
    id: score_fit_final
    key: fit
    inputs: [business_name]
    model: openrouter/anthropic/claude-haiku-4.5
    criteria: []
    outputs:${outputs('fit')}
`);
  const db = openListDb({ listDir: root, readonly: false });
  upsertRecord({ db, row: { _row_id: 'score-command-record', business_name: 'Acme HVAC' } });
  db.close();

  const result = await scoreCommand({ list: root });
  assert.deepEqual(result.score_stages, ['score_fit_initial', 'score_fit_final']);
  assert.equal(result.processed, 2);

  const check = openListDb({ listDir: root, readonly: true });
  const events = check.prepare(`
    SELECT step_id, reason
    FROM pipeline_events
    WHERE record_id = ? AND kind = 'score'
    ORDER BY occurred_at ASC, rowid ASC
  `).all('score-command-record');
  const record = check.prepare('SELECT fit_score FROM records WHERE _row_id = ?').get('score-command-record');
  check.close();
  assert.deepEqual(events, [
    { step_id: 'score_fit_initial', reason: 'criteria_not_configured' },
    { step_id: 'score_fit_final', reason: 'criteria_not_configured' },
  ]);
  assert.equal(record.fit_score, null);
});

test('score command reports canary-excluded records instead of silently narrowing the requested set', async () => {
  const root = listDir();
  mkdirSync(join(root, '.outbound'), { recursive: true });
  writeFileSync(join(root, 'outbound.yaml'), `
pipeline:
  - kind: score
    id: score_fit
    key: fit
    inputs: [business_name]
    model: openrouter/anthropic/claude-haiku-4.5
    criteria: []
    outputs:${outputs('fit')}
`);
  const db = openListDb({ listDir: root, readonly: false });
  upsertRecord({ db, row: { _row_id: 'score-canary-keep', business_name: 'Kept' } });
  upsertRecord({ db, row: { _row_id: 'score-canary-excluded', business_name: 'Excluded' } });
  db.close();
  writeFileSync(join(root, '.outbound', 'canary.json'), JSON.stringify({
    mode: 'canary',
    allowlist_record_ids: ['score-canary-keep'],
  }));

  const result = await scoreCommand({ list: root, force: true });

  assert.equal(result.records, 1);
  assert.deepEqual(result.selection, {
    requested: 2,
    selected: 1,
    excluded: [{
      selector: 'canary_allowlist',
      reason: 'record_id_not_allowlisted',
      count: 1,
    }],
  });
});
