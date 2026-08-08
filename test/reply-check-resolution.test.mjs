import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import { resolveReplyCheck } from '../dist/orchestrator/lib/reply-check.js';
import { runReplyPoll } from '../dist/orchestrator/runtime/polling.js';
import { openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

test('named sequence reply_check overrides default while missing reply_check inherits it', () => {
  const { config, errors } = normalizeConfig({
    pipeline: [{
      kind: 'assign',
      id: 'route_sequence',
      target: 'sequence_name',
      fallback: 'default',
      rules: [
        { sequence: 'named', conditions: [] },
        { sequence: 'inherited', conditions: [] },
      ],
    }],
    sequences: {
      default: {
        reply_check: {
          model: 'test/default',
          lookback_minutes: 15,
          tool: { list_tool: 'DEFAULT_INBOX' },
        },
        steps: [],
      },
      named: {
        reply_check: {
          model: 'test/named',
          lookback_minutes: 5,
          tool: { list_tool: 'NAMED_INBOX' },
        },
        steps: [],
      },
      inherited: { steps: [] },
    },
  });

  assert.deepEqual(errors, []);
  assert.equal(resolveReplyCheck({ config, sequenceName: 'named' }).model, 'test/named');
  assert.equal(resolveReplyCheck({ config, sequenceName: 'named' }).lookback_minutes, 5);
  assert.equal(resolveReplyCheck({ config, sequenceName: 'named' }).tool.list_tool, 'NAMED_INBOX');
  assert.equal(resolveReplyCheck({ config, sequenceName: 'inherited' }).model, 'test/default');
  assert.equal(resolveReplyCheck({ config, sequenceName: 'inherited' }).lookback_minutes, 15);
  assert.equal(resolveReplyCheck({ config, sequenceName: 'inherited' }).tool.list_tool, 'DEFAULT_INBOX');
});

test('reply polling uses a named sequence reply_check and default inheritance', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-reply-check-resolution-'));
  writeFileSync(join(listDir, 'operator.md'), 'test');
  const { config, errors } = normalizeConfig({
    pipeline: [{
      kind: 'assign',
      id: 'route_sequence',
      target: 'sequence_name',
      fallback: 'default',
      rules: [
        { sequence: 'named', conditions: [] },
        { sequence: 'inherited', conditions: [] },
      ],
    }],
    sequences: {
      default: { reply_check: { tool: { list_tool: 'DEFAULT_INBOX' } }, steps: [] },
      named: { reply_check: { tool: { list_tool: 'NAMED_INBOX' } }, steps: [] },
      inherited: { steps: [] },
    },
  });
  assert.deepEqual(errors, []);
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  upsertRecord({
    db,
    row: {
      _row_id: 'named_record',
      business_name: 'Named',
      sequence_name: 'named',
      sequence_status: 'active',
      account_sequence_state: 'active',
      email_thread_id: 'named_thread',
      created_at: now,
      updated_at: now,
    },
  });
  const calls = [];
  const mcp = {
    callTool: async ({ arguments: args }) => {
      const tool = args.tools[0].tool_slug;
      calls.push(tool);
      return {
        structuredContent: {
          data: {
            results: [{
              response: {
                data: {
                  messages: [
                    { id: `message_${tool}`, thread_id: tool === 'NAMED_INBOX' ? 'named_thread' : 'unmatched_thread', snippet: 'not interested' },
                  ],
                },
              },
            }],
          },
        },
      };
    },
  };

  try {
    const result = await runReplyPoll({ mcp, listDir, db, globalSuppressionDb: db, config });
    assert.equal(result.replied, 1);
    assert.ok(calls.includes('NAMED_INBOX'));
    assert.ok(calls.includes('DEFAULT_INBOX'));
  } finally {
    db.close();
  }
});
