import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const runnerPath = join(process.cwd(), 'src/orchestrator/generate/runner.ts');

test('generate retains enrichment dependency freshness wiring', () => {
  const source = readFileSync(runnerPath, 'utf8');
  assert.ok(source.includes('dependencyFieldsForStep(stepConfig)'));
  assert.ok(source.includes('isEnrichFresh({ cached, stepConfig, depValues, force })'));
  assert.ok(source.includes('writeStaleness({'));
});
