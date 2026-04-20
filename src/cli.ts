#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import {
  authConnectCommand,
  authListCommand,
  configAuthorCommand,
  configReadCommand,
  configUpdateCommand,
  crmSyncCommand,
  dashboardCommand,
  duplicatesBreakCommand,
  duplicatesConfirmCommand,
  duplicatesListCommand,
  enrichCommand,
  refreshToolsCommand,
  reconcileCommand,
  removeCommand,
  runCommand,
  followupSendCommand,
  visitsTodayCommand,
  initCommand,
  launchDraftCommand,
  launchSendCommand,
  listCreateCommand,
  listInfoCommand,
  listsCommand,
  logCommand,
  scoreCommand,
  sequenceRunCommand,
  sequenceStatusCommand,
  sourceCommand,
  sourceMoreCommand,
  suppressCommand,
  forgetCommand,
  routePlanCommand,
} from './commands/index.js';
import { onboardCommand } from './commands/onboard.js';
import { validateComposioKey } from './orchestrator/runtime/mcp.js';
import { validateAnthropicKey } from './orchestrator/runtime/anthropic.js';
import { startServeMode } from './serve.js';
import { getServePidPath, getServePortPath, resolveListDir } from './orchestrator/runtime/paths.js';
import { getEnv } from './orchestrator/runtime/env.js';

const args = process.argv.slice(2);

const consumeFlag = (arr, name, fallback = '') => {
  const idx = arr.indexOf(name);
  if (idx < 0) return fallback;
  const value = arr[idx + 1] ?? '';
  arr.splice(idx, 2);
  return value;
};

const hasFlag = (arr, name) => {
  const idx = arr.indexOf(name);
  if (idx < 0) return false;
  arr.splice(idx, 1);
  return true;
};

const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const print = (value) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const printHelp = () => {
  process.stdout.write(`agent-outbound commands

`);
  process.stdout.write(`  onboard                     # agent-consumable setup guide (paste into your AI agent)\n`);
  process.stdout.write(`  init [--composio-api-key KEY] [--anthropic-api-key KEY] [--non-interactive]\n`);
  process.stdout.write(`  list create <list> [--description TEXT]\n`);
  process.stdout.write(`  list info <list>\n`);
  process.stdout.write(`  lists\n`);
  process.stdout.write(`  config read <list>\n`);
  process.stdout.write(`  config update <list> [--file FILE | --yaml TEXT]\n`);
  process.stdout.write(`  config author <list> --request TEXT [--force]\n`);
  process.stdout.write(`  refresh-tools <list>\n`);
  process.stdout.write(`  source <list> [--limit N] [--more N]\n`);
  process.stdout.write(`  remove <list> --row ROW_ID\n`);
  process.stdout.write(`  remove <list> --where SQL\n`);
  process.stdout.write(`  remove <list> --keep-top N [--sort-by COLUMN]\n`);
  process.stdout.write(`  enrich <list> [--step STEP_ID] [--where SQL] [--limit N]\n`);
  process.stdout.write(`  score <list>\n`);
  process.stdout.write(`  run <list> [--more N]\n`);
  process.stdout.write(`  launch draft <list> [--limit N] [--sequence NAME]\n`);
  process.stdout.write(`  launch send <list> [--limit N]\n`);
  process.stdout.write(`  followup send <list> [--limit N]\n`);
  process.stdout.write(`  sequence run <list> [--sequence NAME] [--dry-run]\n`);
  process.stdout.write(`  sequence run --all-lists [--sequence NAME] [--dry-run]\n`);
  process.stdout.write(`  sequence status <list>\n`);
  process.stdout.write(`  dashboard [--list LIST | --all-lists] [--alerts]\n`);
  process.stdout.write(`  visits today [<list> | --all-lists] [--date YYYY-MM-DD]\n`);
  process.stdout.write(`  route plan <list> [--date YYYY-MM-DD]\n`);
  process.stdout.write(`  log <list> --prospect NAME --action ACTION [--note TEXT] [--transition STATE]\n`);
  process.stdout.write(`  suppress <list> --value VALUE [--type email|phone|domain] [--reason TEXT]\n`);
  process.stdout.write(`  forget <list> [--email EMAIL] [--phone PHONE]\n`);
  process.stdout.write(`  crm sync <list> [--limit N]\n`);
  process.stdout.write(`  duplicates list <list> [--status needs_review|confirmed] [--limit N]\n`);
  process.stdout.write(`  duplicates confirm <list> --row ROW_ID --canonical ROW_ID\n`);
  process.stdout.write(`  duplicates break <list> --row ROW_ID\n`);
  process.stdout.write(`  auth --list\n`);
  process.stdout.write(`  auth <toolkit>              # prints the Composio dashboard URL for this toolkit\n`);
  process.stdout.write(`  serve <list> [--port N]\n`);
  process.stdout.write(`  reconcile <list> [--stale-minutes N]\n`);
  process.stdout.write(`  watch <list> [--history]\n`);
  process.stdout.write(`  kill\n`);
};

const isProcessAlive = (pid: number) => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const getServePortForList = (list: string) => {
  if (!String(list || '').trim()) return null;
  let listDir = '';
  try {
    listDir = resolveListDir(list);
  } catch {
    return null;
  }

  const pidPath = getServePidPath(listDir);
  const portPath = getServePortPath(listDir);
  if (!existsSync(pidPath) || !existsSync(portPath)) return null;

  const pid = Number(String(readFileSync(pidPath, 'utf8') || '').trim());
  const port = Number(String(readFileSync(portPath, 'utf8') || '').trim());
  if (!isProcessAlive(pid) || !Number.isFinite(port) || port <= 0) return null;
  return port;
};

const callServeAction = async (action: string, payload: any, listForDiscovery = '') => {
  const port = getServePortForList(listForDiscovery);
  if (!port) return null;

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/v1/actions/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!resp.ok) {
      throw new Error(`Serve mode is active for "${listForDiscovery}" on port ${port}, but action "${action}" failed with HTTP ${resp.status}.`);
    }
    const data = await resp.json();
    if (!data?.ok) {
      throw new Error(`Serve mode is active for "${listForDiscovery}" on port ${port}, but action "${action}" returned an error.`);
    }
    return data.result;
  } catch (error) {
    throw new Error(String(error?.message || error));
  }
};

const run = async () => {
  const argv = [...args];
  const format = consumeFlag(argv, '--format', 'json');
  if (format && format !== 'json') {
    throw new Error(`Unsupported --format "${format}". Only "json" is supported.`);
  }
  const command = String(argv.shift() || '').trim();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'onboard') {
    await onboardCommand();
    return;
  }

  if (command === 'init') {
    const composioApiKeyFlag = consumeFlag(argv, '--composio-api-key', '');
    const anthropicApiKeyFlag = consumeFlag(argv, '--anthropic-api-key', '');
    const nonInteractive = hasFlag(argv, '--non-interactive');

    const ciLike = Boolean(
      process.env.CI
      || process.env.GITHUB_ACTIONS
      || process.env.BUILDKITE
      || process.env.GITLAB_CI
    );
    const interactive = Boolean(process.stdin.isTTY && !nonInteractive && !ciLike);

    const say = (text: string) => process.stderr.write(`${text}\n`);
    const sayInline = (text: string) => process.stderr.write(text);

    const promptSecret = (label: string) => new Promise<string>((resolve) => {
      let muted = true;
      const out = new Writable({
        write(_chunk, _encoding, callback) {
          if (!muted) process.stderr.write(String(_chunk));
          callback();
        },
      });
      const rl = readline.createInterface({
        input: process.stdin,
        output: out as any,
        terminal: true,
      });
      process.stderr.write(`${label}: `);
      rl.question('', (answer) => {
        rl.close();
        muted = false;
        process.stderr.write('\n');
        resolve(String(answer || '').trim());
      });
    });

    const requireInteractive = (what: string) => {
      if (!interactive) {
        throw new Error(`${what} is required. Pass via flag or run \`agent-outbound init\` in an interactive terminal.`);
      }
    };

    // Step 1 — Composio
    say('');
    say('Step 1 of 2 — Composio');
    say('----------------------');

    const existingComposio = String(getEnv('COMPOSIO_API_KEY') || '').trim();
    let composioApiKey = String(composioApiKeyFlag || existingComposio).trim();
    if (!composioApiKey) {
      requireInteractive('Composio API key');
      while (!composioApiKey) {
        composioApiKey = await promptSecret('Composio API key');
        if (!composioApiKey) say('Key is required.');
      }
    } else if (!composioApiKeyFlag && existingComposio) {
      say('Composio API key: (already set)');
    }

    sayInline('Validating Composio key... ');
    const composioCheck = await validateComposioKey(composioApiKey);
    if (!composioCheck.ok) {
      say('failed.');
      say(`Error: ${composioCheck.error}`);
      throw new Error('Composio key validation failed. Check the key and re-run `agent-outbound init`.');
    }
    say('ok.');

    const connectedToolkits = composioCheck.toolkits;
    if (connectedToolkits.length === 0) {
      say('');
      say('No connected toolkits found under this API key.');
      say('Go to https://platform.composio.dev/apps and connect the toolkits you need (Gmail, Hunter, Firecrawl, Google Maps, etc.).');
    } else {
      say('');
      say(`Toolkits currently connected (${connectedToolkits.length}):`);
      for (const slug of connectedToolkits) {
        say(`  - ${slug}`);
      }
    }

    // Step 2 — Anthropic
    say('');
    say('Step 2 of 2 — Anthropic');
    say('-----------------------');

    const existingAnthropic = String(getEnv('ANTHROPIC_API_KEY') || '').trim();
    let anthropicApiKey = String(anthropicApiKeyFlag || existingAnthropic).trim();
    if (!anthropicApiKey) {
      requireInteractive('Anthropic API key');
      while (!anthropicApiKey) {
        anthropicApiKey = await promptSecret('Anthropic API key');
        if (!anthropicApiKey) say('Key is required.');
      }
    } else if (!anthropicApiKeyFlag && existingAnthropic) {
      say('Anthropic API key: (already set)');
    }

    sayInline('Validating Anthropic key... ');
    const anthropicCheck = await validateAnthropicKey(anthropicApiKey);
    if (!anthropicCheck.ok) {
      say('failed.');
      say(`Error: ${anthropicCheck.error}`);
      throw new Error('Anthropic key validation failed. Check the key and re-run `agent-outbound init`.');
    }
    say(`ok. (${anthropicCheck.model_count} models available)`);

    // Persist and summarize
    const result = await initCommand({
      composioApiKey,
      anthropicApiKey,
    });

    say('');
    say('Setup complete.');
    say(`Env: ${result.env_path}`);
    say('');
    print(result);

    say('');
    say('Next:');
    say('  agent-outbound list create <name>       # start a new list');
    say('  agent-outbound source <list> --limit 20 # source your first records');
    say('  agent-outbound --help                   # all commands');
    return;
  }

  if (command === 'list') {
    const sub = String(argv.shift() || '').trim();
    if (sub === 'create') {
      const list = String(argv.shift() || '');
      const description = consumeFlag(argv, '--description', '');
      const delegated = await callServeAction('list_create', { list, description }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(await listCreateCommand({ list, description }));
      return;
    }
    if (sub === 'info') {
      const list = String(argv.shift() || '');
      const delegated = await callServeAction('list_info', { list }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(listInfoCommand({ list }));
      return;
    }
    throw new Error(`Unknown list subcommand: ${sub}`);
  }

  if (command === 'lists') {
    const delegated = await callServeAction('lists', {}, '.');
    if (delegated) {
      print(delegated);
      return;
    }
    print(listsCommand());
    return;
  }

  if (command === 'config') {
    const sub = String(argv.shift() || '').trim();
    const list = String(argv.shift() || '');

    if (sub === 'read') {
      const delegated = await callServeAction('config_read', { list }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(configReadCommand({ list }));
      return;
    }

    if (sub === 'update') {
      const filePath = consumeFlag(argv, '--file', '');
      const yamlTextArg = consumeFlag(argv, '--yaml', '');
      let yamlText = yamlTextArg;
      if (filePath) {
        const { readFileSync } = await import('node:fs');
        yamlText = readFileSync(filePath, 'utf8');
      }
      const delegated = await callServeAction('config_update', { list, yamlText }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(configUpdateCommand({ list, yamlText }));
      return;
    }

    if (sub === 'author') {
      const request = consumeFlag(argv, '--request', argv.join(' '));
      const force = hasFlag(argv, '--force');
      const delegated = await callServeAction('config_author', { list, request, force }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(await configAuthorCommand({ list, request, force }));
      return;
    }

    throw new Error(`Unknown config subcommand: ${sub}`);
  }

  if (command === 'refresh-tools') {
    const list = String(argv.shift() || '');
    const delegated = await callServeAction('refresh_tools', { list }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(await refreshToolsCommand({ list }));
    return;
  }

  if (command === 'source') {
    const list = String(argv.shift() || '');
    const limit = toNumber(consumeFlag(argv, '--limit', '0'), 0);
    const more = toNumber(consumeFlag(argv, '--more', '0'), 0);
    if (more > 0) {
      const delegatedMore = await callServeAction('source_more', { list, more }, list);
      if (delegatedMore) {
        print(delegatedMore);
        return;
      }
      print(await sourceMoreCommand({ list, more }));
      return;
    }
    const delegated = await callServeAction('source', { list, limit }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(await sourceCommand({ list, limit }));
    return;
  }

  if (command === 'remove') {
    const list = String(argv.shift() || '');
    const row = consumeFlag(argv, '--row', '');
    const where = consumeFlag(argv, '--where', '');
    const keepTop = toNumber(consumeFlag(argv, '--keep-top', '0'), 0);
    const sortBy = consumeFlag(argv, '--sort-by', 'updated_at');
    const delegated = await callServeAction('remove', {
      list, row, where, keepTop, sortBy,
    }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(removeCommand({
      list, row, where, keepTop, sortBy,
    }));
    return;
  }

  if (command === 'enrich') {
    const list = String(argv.shift() || '');
    const step = consumeFlag(argv, '--step', '');
    const where = consumeFlag(argv, '--where', '');
    const limit = toNumber(consumeFlag(argv, '--limit', '0'), 0);
    const delegated = await callServeAction('enrich', {
      list, step, where, limit,
    }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(await enrichCommand({
      list, step, where, limit,
    }));
    return;
  }

  if (command === 'score') {
    const list = String(argv.shift() || '');
    const delegated = await callServeAction('score', { list }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(await scoreCommand({ list }));
    return;
  }

  if (command === 'run') {
    const list = String(argv.shift() || '');
    const more = toNumber(consumeFlag(argv, '--more', '0'), 0);
    const delegated = await callServeAction('run', { list, more }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(await runCommand({ list, more }));
    return;
  }

  if (command === 'launch') {
    const sub = String(argv.shift() || '').trim();
    const list = String(argv.shift() || '');
    const limit = toNumber(consumeFlag(argv, '--limit', '50'), 50);

    if (sub === 'draft') {
      const sequenceName = consumeFlag(argv, '--sequence', 'default');
      const delegated = await callServeAction('launch_draft', { list, limit, sequenceName }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(await launchDraftCommand({ list, limit, sequenceName }));
      return;
    }
    if (sub === 'send') {
      const delegated = await callServeAction('launch_send', { list, limit }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(await launchSendCommand({ list, limit }));
      return;
    }
    throw new Error(`Unknown launch subcommand: ${sub}`);
  }

  if (command === 'followup') {
    const sub = String(argv.shift() || '').trim();
    const list = String(argv.shift() || '');
    const limit = toNumber(consumeFlag(argv, '--limit', '50'), 50);
    if (sub !== 'send') throw new Error(`Unknown followup subcommand: ${sub}`);
    const delegated = await callServeAction('followup_send', { list, limit }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(await followupSendCommand({ list, limit }));
    return;
  }

  if (command === 'sequence') {
    const sub = String(argv.shift() || '').trim();
    if (sub === 'run') {
      const allLists = hasFlag(argv, '--all-lists');
      const list = allLists ? '' : String(argv.shift() || '');
      const sequenceName = consumeFlag(argv, '--sequence', 'default');
      const dryRun = hasFlag(argv, '--dry-run');
      const delegated = !allLists
        ? await callServeAction('sequence_run', { list, allLists, sequenceName, dryRun }, list)
        : null;
      if (delegated) {
        print(delegated);
        return;
      }
      print(await sequenceRunCommand({ list, allLists, sequenceName, dryRun }));
      return;
    }
    if (sub === 'status') {
      const list = String(argv.shift() || '');
      const delegated = await callServeAction('sequence_status', { list }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(sequenceStatusCommand({ list }));
      return;
    }
    throw new Error(`Unknown sequence subcommand: ${sub}`);
  }

  if (command === 'dashboard') {
    const allLists = hasFlag(argv, '--all-lists');
    const alerts = hasFlag(argv, '--alerts');
    let list = '';
    if (!allLists) {
      list = consumeFlag(argv, '--list', '');
      if (!list) {
        const positional = String(argv.shift() || '').trim();
        list = positional && !positional.startsWith('-') ? positional : '.';
      }
    }
    const delegated = !allLists ? await callServeAction('dashboard', { list, allLists, alerts }, list) : null;
    if (delegated) {
      print(delegated);
      return;
    }
    print(await dashboardCommand({ list, allLists, alerts }));
    return;
  }

  if (command === 'duplicates') {
    const sub = String(argv.shift() || '').trim();
    if (sub === 'list') {
      const list = String(argv.shift() || '');
      const status = consumeFlag(argv, '--status', 'needs_review');
      const limit = toNumber(consumeFlag(argv, '--limit', '100'), 100);
      print(duplicatesListCommand({ list, status, limit }));
      return;
    }
    if (sub === 'confirm') {
      const list = String(argv.shift() || '');
      const rowId = consumeFlag(argv, '--row', '');
      const canonicalRowId = consumeFlag(argv, '--canonical', '');
      print(duplicatesConfirmCommand({ list, rowId, canonicalRowId }));
      return;
    }
    if (sub === 'break') {
      const list = String(argv.shift() || '');
      const rowId = consumeFlag(argv, '--row', '');
      print(duplicatesBreakCommand({ list, rowId }));
      return;
    }
    throw new Error(`Unknown duplicates subcommand: ${sub}`);
  }

  if (command === 'visits') {
    const sub = String(argv.shift() || '').trim();
    if (sub !== 'today') throw new Error(`Unknown visits subcommand: ${sub}`);
    const allLists = hasFlag(argv, '--all-lists');
    const date = consumeFlag(argv, '--date', '');
    const list = allLists ? '' : String(argv.shift() || '');
    const delegated = await callServeAction('visits_today', { list, allLists, date }, list || '.');
    if (delegated) {
      print(delegated);
      return;
    }
    print(visitsTodayCommand({ list, allLists, date }));
    return;
  }

  if (command === 'route') {
    const sub = String(argv.shift() || '').trim();
    if (sub !== 'plan') throw new Error(`Unknown route subcommand: ${sub}`);
    const list = String(argv.shift() || '');
    const date = consumeFlag(argv, '--date', '');
    const delegated = await callServeAction('route_plan', { list, date }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(await routePlanCommand({ list, date }));
    return;
  }

  if (command === 'log') {
    const list = String(argv.shift() || '');
    const prospect = consumeFlag(argv, '--prospect', '');
    const action = consumeFlag(argv, '--action', '');
    const note = consumeFlag(argv, '--note', '');
    const transition = consumeFlag(argv, '--transition', '');
    const delegated = await callServeAction('log', { list, prospect, action, note, transition }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(logCommand({ list, prospect, action, note, transition }));
    return;
  }

  if (command === 'suppress') {
    const list = String(argv.shift() || '');
    const value = consumeFlag(argv, '--value', '');
    const valueType = consumeFlag(argv, '--type', 'email');
    const reason = consumeFlag(argv, '--reason', 'manual_suppress');
    const delegated = await callServeAction('suppress', { list, value, valueType, reason }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(suppressCommand({ list, value, valueType, reason }));
    return;
  }

  if (command === 'forget') {
    const list = String(argv.shift() || '');
    const email = consumeFlag(argv, '--email', '');
    const phone = consumeFlag(argv, '--phone', '');
    const delegated = await callServeAction('forget', { list, email, phone }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(forgetCommand({ list, email, phone }));
    return;
  }

  if (command === 'crm') {
    const sub = String(argv.shift() || '').trim();
    const list = String(argv.shift() || '');
    const limit = toNumber(consumeFlag(argv, '--limit', '200'), 200);
    if (sub !== 'sync') throw new Error(`Unknown crm subcommand: ${sub}`);
    const delegated = await callServeAction('crm_sync', { list, limit }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(await crmSyncCommand({ list, limit }));
    return;
  }

  if (command === 'auth') {
    if (hasFlag(argv, '--list')) {
      print(await authListCommand());
      return;
    }
    const toolkit = String(argv.shift() || '').trim();
    if (!toolkit) throw new Error('Toolkit is required.');
    print(await authConnectCommand({ toolkit }));
    return;
  }

  if (command === 'serve') {
    const list = String(argv.shift() || '.');
    const port = toNumber(consumeFlag(argv, '--port', '49391'), 49391);
    startServeMode({ list, port });
    process.stdout.write(`serve mode started on port ${port}\n`);
    return;
  }

  if (command === 'reconcile') {
    const list = String(argv.shift() || '');
    const staleMinutes = toNumber(consumeFlag(argv, '--stale-minutes', '30'), 30);
    const delegated = await callServeAction('reconcile', { list, staleMinutes }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(reconcileCommand({ list, staleMinutes }));
    return;
  }

  if (command === 'watch') {
    const listPath = String(argv.shift() || '.');
    const showAllHistory = hasFlag(argv, '--history');
    const { runWatch } = await import('./watch.js');
    await runWatch({ listPath, showAllHistory });
    return;
  }

  if (command === 'kill') {
    const cwd = process.cwd();
    const dirs = readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(cwd, entry.name))
      .filter((dir) => existsSync(join(dir, 'outbound.yaml')));

    const pids = dirs
      .map((dir) => {
        const pidPath = getServePidPath(dir);
        if (!existsSync(pidPath)) return null;
        const pid = Number(String(readFileSync(pidPath, 'utf8') || '').trim());
        return Number.isFinite(pid) && pid > 0 ? { dir, pid } : null;
      })
      .filter(Boolean) as Array<{ dir: string; pid: number }>;

    if (pids.length === 0) {
      print({ status: 'ok', message: 'No running serve processes discovered in current working directory lists.' });
      return;
    }

    const result = [];
    for (const item of pids) {
      try {
        process.kill(item.pid, 'SIGTERM');
        result.push({ pid: item.pid, list: item.dir, status: 'killed' });
      } catch (error) {
        result.push({ pid: item.pid, list: item.dir, status: String(error?.code || 'error') });
      }
    }

    print({ status: 'ok', result });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
};

run().catch((error) => {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exit(1);
});
