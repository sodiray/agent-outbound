import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createBatchLoader } from '../src/orchestrator/pipeline/batch-loader.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async (promise, ms, label) => Promise.race([
  promise,
  sleep(ms).then(() => {
    throw new Error(`timeout:${label}`);
  }),
]);

const row = (id) => ({ _row_id: id });

const ok = (id) => ({ passed: true, reason: `ok:${id}` });

const makeResultMap = (rows) => new Map(rows.map((item) => [item._row_id, ok(item._row_id)]));

const testCoalescing = async () => {
  const invocations = [];
  const loader = createBatchLoader({
    maxBatch: 10,
    windowMs: 30,
    executor: async (rows) => {
      invocations.push(rows.map((item) => item._row_id));
      return makeResultMap(rows);
    },
    fallback: async (record) => ok(record._row_id),
  });
  const results = await Promise.all([loader.load(row('a')), loader.load(row('b'))]);
  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0], ['a', 'b']);
  assert.deepEqual(results.map((item) => item.reason), ['ok:a', 'ok:b']);
  return { invocations: invocations.length, rows: invocations[0].length };
};

const testStaggeredCoalescing = async () => {
  const invocations = [];
  const active = { count: 0 };
  const loader = createBatchLoader({
    maxBatch: 10,
    windowMs: 80,
    quiescenceGraceMs: 40,
    inFlight: () => active.count,
    executor: async (rows) => {
      invocations.push(rows.map((item) => item._row_id));
      return makeResultMap(rows);
    },
    fallback: async (record) => ok(record._row_id),
  });
  const enqueue = async (id, delayMs) => {
    await sleep(delayMs);
    active.count += 1;
    return loader.load(row(id)).finally(() => {
      active.count -= 1;
    });
  };
  const results = await withTimeout(Promise.all([
    enqueue('a', 0),
    enqueue('b', 0),
    enqueue('c', 5),
    enqueue('d', 10),
    enqueue('e', 15),
  ]), 160, 'staggeredCoalescing');
  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0], ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(results.map((item) => item.reason), ['ok:a', 'ok:b', 'ok:c', 'ok:d', 'ok:e']);
  return { invocations: invocations.length, rows: invocations[0].length };
};

const testMaxBatch = async () => {
  const invocations = [];
  const startedAt = performance.now();
  const loader = createBatchLoader({
    maxBatch: 2,
    windowMs: 1000,
    executor: async (rows) => {
      invocations.push(rows.map((item) => item._row_id));
      return makeResultMap(rows);
    },
    fallback: async (record) => ok(record._row_id),
  });
  await withTimeout(Promise.all([loader.load(row('a')), loader.load(row('b'))]), 100, 'maxBatch');
  const elapsedMs = performance.now() - startedAt;
  assert.equal(invocations.length, 1);
  assert(elapsedMs < 100);
  return { invocations: invocations.length, elapsedMs: Math.round(elapsedMs) };
};

const testWindowNotDebounce = async () => {
  const invocations = [];
  const startedAt = performance.now();
  const loader = createBatchLoader({
    maxBatch: 10,
    windowMs: 60,
    executor: async (rows) => {
      invocations.push({ elapsedMs: performance.now() - startedAt, ids: rows.map((item) => item._row_id) });
      return makeResultMap(rows);
    },
    fallback: async (record) => ok(record._row_id),
  });
  const first = loader.load(row('a'));
  await sleep(20);
  const second = loader.load(row('b'));
  await sleep(20);
  const third = loader.load(row('c'));
  await withTimeout(Promise.all([first, second, third]), 140, 'window');
  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0].ids, ['a', 'b', 'c']);
  assert(invocations[0].elapsedMs < 95);
  return { invocations: invocations.length, elapsedMs: Math.round(invocations[0].elapsedMs) };
};

const testLoneWindowLiveness = async () => {
  const invocations = [];
  const startedAt = performance.now();
  const loader = createBatchLoader({
    maxBatch: 10,
    windowMs: 45,
    executor: async (rows) => {
      invocations.push(rows.map((item) => item._row_id));
      return makeResultMap(rows);
    },
    fallback: async (record) => ok(record._row_id),
  });
  await withTimeout(loader.load(row('solo')), 120, 'loneWindow');
  const elapsedMs = performance.now() - startedAt;
  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0], ['solo']);
  assert(elapsedMs < 120);
  return { invocations: invocations.length, elapsedMs: Math.round(elapsedMs) };
};

const testPartialFallback = async () => {
  const fallbackRows = [];
  const loader = createBatchLoader({
    maxBatch: 2,
    windowMs: 1000,
    executor: async (rows) => new Map([[rows[0]._row_id, ok(rows[0]._row_id)]]),
    fallback: async (record, cause) => {
      fallbackRows.push({ id: record._row_id, cause });
      return { passed: true, reason: `fallback:${record._row_id}` };
    },
  });
  const results = await Promise.all([loader.load(row('a')), loader.load(row('b'))]);
  assert.deepEqual(results.map((item) => item.reason), ['ok:a', 'fallback:b']);
  assert.deepEqual(fallbackRows, [{ id: 'b', cause: 'batch_omitted_row' }]);
  return { fallbackRows: fallbackRows.length };
};

const testPerRecordRejectIsolation = async () => {
  const loader = createBatchLoader({
    maxBatch: 2,
    windowMs: 1000,
    executor: async () => new Map([
      ['a', ok('a')],
      ['b', new Error('row b failed')],
    ]),
    fallback: async (record) => ok(record._row_id),
  });
  const results = await Promise.allSettled([loader.load(row('a')), loader.load(row('b'))]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(String(results[1].reason?.message || results[1].reason), /row b failed/);
  return { fulfilled: 1, rejected: 1 };
};

const testQuiescence = async () => {
  const invocations = [];
  const startedAt = performance.now();
  const loader = createBatchLoader({
    maxBatch: 10,
    windowMs: 1000,
    quiescenceGraceMs: 25,
    inFlight: () => 1,
    executor: async (rows) => {
      invocations.push(rows.map((item) => item._row_id));
      return makeResultMap(rows);
    },
    fallback: async (record) => ok(record._row_id),
  });
  await withTimeout(loader.load(row('a')), 90, 'quiescence');
  const elapsedMs = performance.now() - startedAt;
  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0], ['a']);
  assert(elapsedMs < 90);
  return { invocations: invocations.length, elapsedMs: Math.round(elapsedMs) };
};

const summary = {
  coalescing: await testCoalescing(),
  staggeredCoalescing: await testStaggeredCoalescing(),
  maxBatch: await testMaxBatch(),
  windowNotDebounce: await testWindowNotDebounce(),
  loneWindowLiveness: await testLoneWindowLiveness(),
  partialFallback: await testPartialFallback(),
  perRecordRejectIsolation: await testPerRecordRejectIsolation(),
  quiescence: await testQuiescence(),
};

console.log('phase1 validation ok', JSON.stringify(summary));
