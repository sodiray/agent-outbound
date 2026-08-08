import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runEnrichment } from '../dist/orchestrator/enrichment/runner.js';
import { runGeneration } from '../dist/orchestrator/generate/runner.js';
import { readConfig } from '../dist/orchestrator/lib/config.js';

const modelRoot = mkdtempSync(join(tmpdir(), 'ao-nested-command-models-'));
writeFileSync(join(modelRoot, 'models.json'), JSON.stringify({
  schema_version: '1.0.0',
  providers: { test: { provider: 'test', models: ['model'], updated_at: '' } },
}));
process.env.AO_GLOBAL_ROOT = modelRoot;

const makeList = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-nested-command-'));
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'outbound.yaml'), `
list: { name: nested-command }
ai: { default_model: test/model }
sequences: { default: { steps: [] } }
pipeline:
  - kind: assign
    id: route_pipeline
    target: pipeline_name
    fallback: nested
  - kind: pipeline
    id: nested
    manual: true
    steps:
      - kind: enrich
        id: lookup
        outputs: { nested_lookup: { type: string, description: Lookup result } }
      - kind: generate
        id: draft
        outputs: { nested_draft: { type: string, description: Draft result } }
`);
  return listDir;
};

test('nested enrich and generate steps are validated and visible to their direct runners', async () => {
  const listDir = makeList();
  assert.deepEqual(readConfig(listDir).errors, []);

  const enriched = await runEnrichment({ listDir });
  const generated = await runGeneration({ listDir });

  assert.equal(enriched.steps, 1);
  assert.equal(generated.steps, 1);
});
