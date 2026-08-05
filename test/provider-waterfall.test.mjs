/**
 * RES-CLASSIFICATION-NORMAL-PATH: provider waterfall for tool_call.
 *
 * - Primary tool success → no fallbacks invoked
 * - Primary retryable failure → try waterfall / fallback_tools in order
 * - Non-retryable primary failure → fail closed (no invented success)
 * - All tools fail → fail closed with waterfall exhausted error
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeToolCallAction,
  isRetryableToolError,
  resolveToolWaterfall,
  runProviderWaterfall,
} from '../dist/orchestrator/enrichment/actions/tool-call.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('resolveToolWaterfall: primary + waterfall, de-dupes, skips empty pins', () => {
  const chain = resolveToolWaterfall({
    tool: { server: 'hunter', tools: ['HUNTER_EMAIL_FINDER'] },
    waterfall: [
      { server: 'apollo', tools: ['APOLLO_PEOPLE_SEARCH'] },
      { server: 'hunter', tools: ['HUNTER_EMAIL_FINDER'] }, // de-dupe
      { server: 'dropcontact' }, // no tools — skip
      { server: 'dropcontact', tools: ['DROPCONTACT_ENRICH'] },
    ],
  });
  assert.deepEqual(
    chain.map((s) => `${s.server}:${s.tools[0]}`),
    [
      'hunter:HUNTER_EMAIL_FINDER',
      'apollo:APOLLO_PEOPLE_SEARCH',
      'dropcontact:DROPCONTACT_ENRICH',
    ],
  );
});

test('resolveToolWaterfall: fallback_tools alias when waterfall absent', () => {
  const chain = resolveToolWaterfall({
    tool: { server: 'a', tools: ['A1'] },
    fallback_tools: [{ server: 'b', tools: ['B1'] }],
  });
  assert.equal(chain.length, 2);
  assert.equal(chain[1].tools[0], 'B1');
});

test('isRetryableToolError: 429/5xx/timeout vs permanent', () => {
  assert.equal(isRetryableToolError(new Error('HTTP 429 rate limit')), true);
  assert.equal(isRetryableToolError(new Error('502 Bad Gateway')), true);
  assert.equal(isRetryableToolError(new Error('socket hang up / ECONNRESET')), true);
  assert.equal(isRetryableToolError(new Error('request timed out')), true);
  assert.equal(isRetryableToolError({ retryable: true, message: 'x' }), true);
  assert.equal(isRetryableToolError({ retryable: false, message: 'timeout' }), false);
  assert.equal(isRetryableToolError(new Error('invalid_argument: bad domain')), false);
  assert.equal(isRetryableToolError(new Error('TOOL_NOT_CONNECTED')), false);
});

// ---------------------------------------------------------------------------
// executeToolCallAction waterfall (mocked tool catalog + provider execute)
// ---------------------------------------------------------------------------

const makeCatalog = (specs) => {
  /** @type {Record<string, any>} */
  const catalog = {};
  for (const { server, tool, execute } of specs) {
    const key = `${server}:${tool}`;
    catalog[key] = {
      description: tool,
      parameters: { type: 'object', properties: {} },
      provider: server,
      // Custom execute is wired via a stub provider path — we intercept loadTools
      // by using local command-free monid-style? Simpler: patch via env catalog
      // and inject execute by monkey-patching module is hard. Use inline mock
      // by replacing execute on resolved tools through a custom approach:
      // We pass a fake mcp and use a catalog that loadTools can resolve only if
      // the provider is monid or command. For unit purity we test via injected
      // execute by wrapping tool catalog with a stub that won't work for live
      // loadTools without a provider.
      _execute: execute,
    };
  }
  return catalog;
};

// Direct unit of waterfall loop via a thin harness: re-implement isn't allowed,
// so we stub loadTools by temporarily installing a fake getProvider... instead
// use the public executeToolCallAction with a custom tool catalog AND a mock
// that won't resolve without provider. Better approach: export is tested pure;
// for execute, use dependency-free simulation by stubbing process + dynamic
// import of tools is hard.
//
// Practical approach used here: inject tools via monkey-patching the module's
// loadTools is not available. So we create a local-command free path:
// use server: 'fixture_wf' that doesn't exist → resolve fails → waterfall continues.
// Then for a successful final tool we need something that actually executes.
//
// Use AO_STEP_FIXTURE for success shape and separate pure tests for waterfall
// order — OR use real monid fixture if available.
//
// Instead: implement a small test double by calling resolveToolWaterfall +
// isRetryableToolError (covered) and an integration-style test that injects
// execute via dynamic mock of tools module. Node test can't easily mock ESM.
//
// Final approach: use tool catalog + monid is special. Look at how other tests
// mock tool_call...

test('executeToolCallAction: fixture mode short-circuits waterfall (no live call)', async () => {
  const prev = process.env.AO_STEP_FIXTURE;
  process.env.AO_STEP_FIXTURE = '1';
  try {
    const result = await executeToolCallAction({
      listDir: '/tmp',
      stepId: 'site_scrape',
      stepConfig: {
        tool: { server: 'firecrawl', tools: ['FIRECRAWL_SCRAPE'] },
        waterfall: [{ server: 'backup', tools: ['BACKUP_SCRAPE'] }],
        output_map: { site_text: 'data.markdown' },
        outputs: { site_text: { type: 'string', description: 'x' } },
      },
      record: { business_name: 'Peak HVAC' },
    });
    assert.equal(result.provider, 'fixture');
    assert.match(String(result.outputs.site_text), /Peak HVAC|Fixture site text/);
  } finally {
    if (prev === undefined) delete process.env.AO_STEP_FIXTURE;
    else process.env.AO_STEP_FIXTURE = prev;
  }
});

test('executeToolCallAction: no tools configured fails closed', async () => {
  delete process.env.AO_PIPELINE_FIXTURE;
  delete process.env.AO_STEP_FIXTURE;
  await assert.rejects(
    () => executeToolCallAction({
      listDir: '/tmp',
      stepId: 'empty_tools',
      stepConfig: { tool: {}, waterfall: [] },
      record: {},
    }),
    /no tool resolved|waterfall/,
  );
});

test('runProviderWaterfall: primary retryable → fallback succeeds (no invent on primary)', async () => {
  const calls = [];
  const chain = [
    { server: 'primary', tools: ['P1'] },
    { server: 'fallback', tools: ['F1'] },
  ];
  const out = await runProviderWaterfall({
    stepId: 'email_find',
    chain,
    tryTool: async (spec) => {
      calls.push(spec.tools[0]);
      if (spec.tools[0] === 'P1') {
        const err = new Error('HTTP 503 temporarily unavailable');
        throw err;
      }
      return {
        result: { email: 'owner@example.test' },
        usage: { usd_cost: 0.01, provider: 'fallback', tool_calls: ['F1'], tool_costs: [] },
        provider: 'fallback',
      };
    },
  });
  assert.deepEqual(calls, ['P1', 'F1']);
  assert.equal(out.result.email, 'owner@example.test');
  assert.equal(out.provider, 'fallback');
  assert.deepEqual(out.attempts, ['primary:P1', 'fallback:F1']);
});

test('runProviderWaterfall: non-retryable primary fails closed (no fallback success invent)', async () => {
  const calls = [];
  await assert.rejects(
    () => runProviderWaterfall({
      stepId: 'email_find',
      chain: [
        { server: 'primary', tools: ['P1'] },
        { server: 'fallback', tools: ['F1'] },
      ],
      tryTool: async (spec) => {
        calls.push(spec.tools[0]);
        if (spec.tools[0] === 'P1') throw new Error('invalid_argument: domain blocked');
        return { result: { email: 'should-not-run@x.test' }, provider: 'fallback' };
      },
    }),
    /waterfall exhausted|invalid_argument/,
  );
  assert.deepEqual(calls, ['P1'], 'fallback must not run on permanent error');
});

test('runProviderWaterfall: all fail → fail closed', async () => {
  await assert.rejects(
    () => runProviderWaterfall({
      stepId: 'email_find',
      chain: [
        { server: 'a', tools: ['A'] },
        { server: 'b', tools: ['B'] },
      ],
      tryTool: async () => {
        throw new Error('429 rate limit');
      },
    }),
    /waterfall exhausted.*a:A.*b:B/,
  );
});

test('executeToolCallAction: injected __tryTool waterfall maps outputs (no invented fields)', async () => {
  delete process.env.AO_PIPELINE_FIXTURE;
  delete process.env.AO_STEP_FIXTURE;
  const result = await executeToolCallAction({
    listDir: '/tmp',
    stepId: 'email_find',
    stepConfig: {
      tool: { server: 'hunter', tools: ['HUNTER_EMAIL_FINDER'] },
      waterfall: [{ server: 'apollo', tools: ['APOLLO_PEOPLE_SEARCH'] }],
      output_map: { contact_email: 'email' },
      __tryTool: async (spec) => {
        if (spec.tools[0] === 'HUNTER_EMAIL_FINDER') {
          throw new Error('502 Bad Gateway');
        }
        return {
          result: { email: 'real@fallback.test' },
          usage: { usd_cost: 0.02, provider: 'apollo', tool_calls: ['APOLLO_PEOPLE_SEARCH'], tool_costs: [] },
          provider: 'apollo',
        };
      },
    },
    record: { business_name: 'Peak' },
  });
  assert.equal(result.outputs.contact_email, 'real@fallback.test');
  assert.equal(result.provider, 'apollo');
  assert.deepEqual(result.waterfall_attempts, [
    'hunter:HUNTER_EMAIL_FINDER',
    'apollo:APOLLO_PEOPLE_SEARCH',
  ]);
  // Do not invent unrelated success fields.
  assert.equal(result.outputs.contact_name, undefined);
});

// Silence unused helper.
void makeCatalog;
