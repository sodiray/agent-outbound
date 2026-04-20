import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openListDb } from '../runtime/db.js';
import { readConfig } from '../lib/config.js';
import { todayIsoDate } from '../lib/record.js';
import { resolveListDir } from '../runtime/paths.js';
import { listConnectedToolkits } from '../runtime/mcp.js';

const listDirsFromCwd = () => {
  const cwd = process.cwd();
  return readdirSync(cwd, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(cwd, entry.name))
    .filter((dir) => existsSync(join(dir, 'outbound.yaml')));
};

const summarizeList = ({ listDir }) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const replies = db.prepare(`
      SELECT id, business_name, email_reply_classification, email_last_reply_at
      FROM records
      WHERE email_last_reply_at != '' AND email_last_reply_at >= datetime('now', '-1 day')
      ORDER BY email_last_reply_at DESC
      LIMIT 20
    `).all();

    const route = db.prepare(`
      SELECT id, business_name, visit_route_position
      FROM records
      WHERE visit_scheduled_date = ?
      ORDER BY visit_route_position ASC
      LIMIT 50
    `).all(todayIsoDate());

    const calls = db.prepare(`
      SELECT id, business_name, next_action_date
      FROM records
      WHERE sequence_status = 'active' AND next_action_date <= ?
      ORDER BY next_action_date ASC
      LIMIT 50
    `).all(todayIsoDate());

    const followups = db.prepare(`
      SELECT id, business_name, email_last_draft_id
      FROM records
      WHERE sequence_status = 'active' AND email_last_draft_id != ''
      ORDER BY updated_at DESC
      LIMIT 50
    `).all();

    const bouncesOptouts = db.prepare(`
      SELECT id, business_name, sequence_status, suppressed_at
      FROM records
      WHERE sequence_status IN ('bounced', 'opted_out') AND suppressed_at != ''
      ORDER BY suppressed_at DESC
      LIMIT 20
    `).all();
    const duplicatesNeedsReview = db.prepare(`
      SELECT id, business_name, duplicate_of, duplicate_status, updated_at
      FROM records
      WHERE duplicate_status = 'needs_review'
      ORDER BY updated_at DESC
      LIMIT 50
    `).all();

    const pipeline = db.prepare(`
      SELECT sequence_status as status, COUNT(*) as count
      FROM records
      GROUP BY sequence_status
      ORDER BY count DESC
    `).all();

    return {
      list_dir: listDir,
      list_name: readConfig(listDir).config?.list?.name || listDir.split('/').pop(),
      replies,
      route,
      calls,
      followups,
      bounces_optouts: bouncesOptouts,
      duplicates_needs_review: duplicatesNeedsReview,
      pipeline,
    };
  } finally {
    db.close();
  }
};

export const runDashboard = async ({ list = '', allLists = false, alerts = false }) => {
  const lists = allLists
    ? listDirsFromCwd()
    : [resolveListDir(list || '.')].filter(Boolean);

  const sections = [];
  for (const listDir of lists) {
    if (!existsSync(join(listDir, 'outbound.yaml'))) continue;
    sections.push(summarizeList({ listDir }));
  }

  let alertData = null;
  if (alerts) {
    try {
      const toolkits = await listConnectedToolkits();
      alertData = {
        connected_toolkits: toolkits.length,
        toolkits,
        disconnected_warnings: [],
      };
    } catch (error) {
      alertData = {
        connected_toolkits: 0,
        toolkits: [],
        disconnected_warnings: [String(error?.message || error)],
      };
    }
  }

  return {
    generated_at: new Date().toISOString(),
    lists: sections,
    alerts: alertData,
  };
};
