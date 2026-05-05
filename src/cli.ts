#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import {
  DEEPINFRA_RECOMMENDED_MODELS,
  aiUsageCommand,
  authConnectCommand,
  authListCommand,
  configAuthorCommand,
  configDiffCommand,
  configReadCommand,
  configUpdateCommand,
  configValidateCommand,
  crmSyncCommand,
  dashboardCommand,
  describeCommand,
  draftsApproveCommand,
  draftsEditCommand,
  draftsListCommand,
  draftsRejectCommand,
  draftsShowCommand,
  duplicatesBreakCommand,
  duplicatesConfirmCommand,
  duplicatesListCommand,
  enrichCommand,
  exportCommand,
  pipelineShowCommand,
  queryCommand,
  refreshToolsCommand,
  reconcileCommand,
  recordShowCommand,
  removeCommand,
  repliesShowCommand,
  routeShowCommand,
  runCommand,
  schemaCommand,
  followupSendCommand,
  recordRevertScoreCommand,
  recordRevertSequenceCommand,
  recordRevertStepCommand,
  snapshotCreateCommand,
  snapshotDeleteCommand,
  snapshotListCommand,
  snapshotRestoreCommand,
  usageCommand,
  visitsTodayCommand,
  viewsSaveCommand,
  templatesCreateCommand,
  templatesListCommand,
  templatesShowCommand,
  templatesUpdateCommand,
  initCommand,
  launchDraftCommand,
  launchSendCommand,
  listCreateCommand,
  listInfoCommand,
  listsCommand,
  logCommand,
  modelsAddCommand,
  modelsListCommand,
  modelsRefreshCommand,
  modelsRemoveCommand,
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
import { listDeepInfraModels } from './orchestrator/runtime/deepinfra.js';
import { startServeMode } from './serve.js';
import { getServePidPath, getServePortPath, resolveListDir } from './orchestrator/runtime/paths.js';
import { getEnv } from './orchestrator/runtime/env.js';
import { failureEnvelope, successEnvelope, toStructuredError } from './orchestrator/runtime/contract.js';

const args = process.argv.slice(2);
let responseCommand = '';
let responseList = '';
let globalIdemKey = '';

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

const setResponseContext = ({ command = '', list = '' }: { command?: string; list?: string }) => {
  if (command) responseCommand = String(command);
  if (list !== undefined) responseList = String(list || '');
};

const print = (value) => {
  const hasEnvelope = value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'ok');
  const payload = hasEnvelope
    ? value
    : (() => {
      const raw = value && typeof value === 'object' ? value : { value };
      const result = { ...(raw || {}) };
      const warnings = Array.isArray((result as any).warnings) ? (result as any).warnings : [];
      const signals = (result as any).signals && typeof (result as any).signals === 'object' ? (result as any).signals : null;
      const summary = typeof (result as any).summary === 'string' ? String((result as any).summary || '') : '';
      delete (result as any).warnings;
      delete (result as any).signals;
      return successEnvelope({
        command: responseCommand || 'unknown',
        list: responseList || '',
        result,
        warnings,
        signals,
        summary,
      });
    })();
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
};

const printHelp = () => {
  process.stdout.write(`agent-outbound commands

`);
  process.stdout.write(`  (global) --idem-key KEY       # idempotency key for mutating commands\n`);
  process.stdout.write(`  onboard                     # agent-consumable setup guide (paste into your AI agent)\n`);
  process.stdout.write(`  init [--composio-api-key KEY] [--anthropic-api-key KEY] [--deepinfra-api-key KEY] [--non-interactive]\n`);
  process.stdout.write(`  models [--provider anthropic|deepinfra] [--search TEXT]\n`);
  process.stdout.write(`  models add deepinfra/<model-id>\n`);
  process.stdout.write(`  models remove <provider/model-id>\n`);
  process.stdout.write(`  models refresh\n`);
  process.stdout.write(`  list create <list> [--description TEXT]\n`);
  process.stdout.write(`  list info <list>\n`);
  process.stdout.write(`  lists\n`);
  process.stdout.write(`  describe [--command NAME]\n`);
  process.stdout.write(`  query <list> --sql "SELECT ..."\n`);
  process.stdout.write(`  schema <list> [--table NAME] [--format json|markdown]\n`);
  process.stdout.write(`  export <list> --to FILE --select "col1,col2" [--where SQL] [--format csv|jsonl|parquet]\n`);
  process.stdout.write(`  views save <list> --name NAME --select "col1,col2" [--where SQL]\n`);
  process.stdout.write(`  record show <list> <row_id> [--include enrichment,scores,events,contacts,sequence,drafts,ai-usage]\n`);
  process.stdout.write(`  pipeline show <list> [--format json|summary]\n`);
  process.stdout.write(`  route show <list> --date YYYY-MM-DD [--include enrichment,contacts,prior-touches]\n`);
  process.stdout.write(`  replies show <list> [--record ROW_ID] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--classification VALUE]\n`);
  process.stdout.write(`  ai-usage <list> [--step STEP_ID] [--record ROW_ID] [--period 7d] [--group-by step|record|run|period] [--format json|summary]\n`);
  process.stdout.write(`  usage <list> [--toolkit TOOLKIT] [--tool TOOL] [--step STEP_ID] [--record ROW_ID] [--period 7d] [--group-by toolkit|tool|step|record|period]\n`);
  process.stdout.write(`    NOTE: Agent-Outbound tracks AI usage only. Third-party tool costs are provider-billed and not visible here.\n`);
  process.stdout.write(`  config read <list>\n`);
  process.stdout.write(`  config update <list> [--file FILE | --yaml TEXT]\n`);
  process.stdout.write(`  config validate <list> [--file FILE]\n`);
  process.stdout.write(`  config diff <list> [--file FILE | --from-snapshot SNAPSHOT_ID]\n`);
  process.stdout.write(`  config author <list> --request TEXT [--force]\n`);
  process.stdout.write(`  refresh-tools <list>\n`);
  process.stdout.write(`  source <list> [--limit N] [--more N] [--dry-run] [--sample N]\n`);
  process.stdout.write(`  remove <list> --row ROW_ID\n`);
  process.stdout.write(`  remove <list> --where SQL\n`);
  process.stdout.write(`  remove <list> --keep-top N [--sort-by COLUMN]\n`);
  process.stdout.write(`  enrich <list> [--step STEP_ID] [--where SQL] [--limit N] [--dry-run] [--sample N]\n`);
  process.stdout.write(`  score <list> [--dry-run] [--sample N]\n`);
  process.stdout.write(`  run <list> [--more N]\n`);
  process.stdout.write(`  launch draft <list> [--limit N] [--sequence NAME] [--dry-run] [--sample N]\n`);
  process.stdout.write(`  launch send <list> [--limit N] [--dry-run] [--sample N]\n`);
  process.stdout.write(`  followup send <list> [--limit N]\n`);
  process.stdout.write(`  sequence run <list> [--sequence NAME] [--dry-run] [--sample N]\n`);
  process.stdout.write(`  sequence run --all-lists [--sequence NAME] [--dry-run] [--sample N]\n`);
  process.stdout.write(`  sequence status <list>\n`);
  process.stdout.write(`  dashboard [--list LIST | --all-lists] [--alerts]\n`);
  process.stdout.write(`  visits today [<list> | --all-lists] [--date YYYY-MM-DD]\n`);
  process.stdout.write(`  route plan <list> [--date YYYY-MM-DD]\n`);
  process.stdout.write(`  route show <list> --date YYYY-MM-DD [--include enrichment,contacts,prior-touches]\n`);
  process.stdout.write(`  drafts list <list> [--status pending_approval|ready|rejected|sent] [--step N]\n`);
  process.stdout.write(`  drafts show <list> --id DRAFT_ID\n`);
  process.stdout.write(`  drafts approve <list> --id DRAFT_ID | --all --where SQL\n`);
  process.stdout.write(`  drafts reject <list> --id DRAFT_ID [--reason TEXT]\n`);
  process.stdout.write(`  drafts edit <list> --id DRAFT_ID [--subject TEXT] [--body TEXT]\n`);
  process.stdout.write(`  templates list <list>\n`);
  process.stdout.write(`  templates show <list> --id TEMPLATE_ID\n`);
  process.stdout.write(`  templates create <list> --id TEMPLATE_ID [--channel CHANNEL] [--subject TEXT] [--body TEXT] [--variables JSON]\n`);
  process.stdout.write(`  templates update <list> --id TEMPLATE_ID [--subject TEXT] [--body TEXT] [--variables JSON] [--note TEXT]\n`);
  process.stdout.write(`  log <list> --prospect NAME --action ACTION [--note TEXT] [--transition STATE]\n`);
  process.stdout.write(`  record revert <list> <row_id> --step STEP_ID\n`);
  process.stdout.write(`  record revert-score <list> <row_id>\n`);
  process.stdout.write(`  record revert-sequence <list> <row_id> --to-step N\n`);
  process.stdout.write(`  snapshot create <list> [--label TEXT]\n`);
  process.stdout.write(`  snapshot list <list>\n`);
  process.stdout.write(`  snapshot restore <list> --id SNAPSHOT_ID\n`);
  process.stdout.write(`  snapshot delete <list> --id SNAPSHOT_ID\n`);
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
      body: JSON.stringify({
        ...(payload || {}),
        ...(globalIdemKey ? { idem_key: globalIdemKey } : {}),
      }),
    });
    if (!resp.ok) {
      throw new Error(`Serve mode is active for "${listForDiscovery}" on port ${port}, but action "${action}" failed with HTTP ${resp.status}.`);
    }
    const data = await resp.json();
    if (!data?.ok) {
      const message = String(data?.error?.message || `Serve mode is active for "${listForDiscovery}" on port ${port}, but action "${action}" returned an error.`);
      const error: any = new Error(message);
      if (data?.error?.code) error.code = data.error.code;
      if (data?.error?.retryable != null) error.retryable = Boolean(data.error.retryable);
      if (data?.error?.hint) error.hint = String(data.error.hint);
      if (data?.error?.fields && typeof data.error.fields === 'object') error.fields = data.error.fields;
      throw error;
    }
    return data.result;
  } catch (error) {
    throw new Error(String(error?.message || error));
  }
};

const run = async () => {
  const argv = [...args];
  const format = consumeFlag(argv, '--format', 'json');
  globalIdemKey = consumeFlag(argv, '--idem-key', '');
  if (format && format !== 'json' && format !== 'summary' && format !== 'markdown') {
    throw new Error(`Unsupported --format "${format}". Supported: json, summary, markdown.`);
  }
  const command = String(argv.shift() || '').trim();
  setResponseContext({ command, list: '' });

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
    const deepinfraApiKeyFlag = consumeFlag(argv, '--deepinfra-api-key', '');
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
    const promptText = (label: string) => new Promise<string>((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
      });
      rl.question(`${label}: `, (answer) => {
        rl.close();
        resolve(String(answer || '').trim());
      });
    });
    const promptYesNo = async (label: string, defaultYes = true) => {
      const suffix = defaultYes ? '[Y/n]' : '[y/N]';
      const answer = String(await promptText(`${label} ${suffix}`)).trim().toLowerCase();
      if (!answer) return defaultYes;
      return answer === 'y' || answer === 'yes';
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

    // Step 2 — LLM providers
    say('');
    say('Step 2 of 2 — LLM Providers');
    say('----------------------------');

    const existingAnthropic = String(getEnv('ANTHROPIC_API_KEY') || '').trim();
    const existingDeepinfra = String(getEnv('DEEPINFRA_API_KEY') || '').trim();
    let anthropicApiKey = String(anthropicApiKeyFlag || existingAnthropic).trim();
    let deepinfraApiKey = String(deepinfraApiKeyFlag || existingDeepinfra).trim();

    if (interactive && !anthropicApiKeyFlag && !anthropicApiKey) {
      const useAnthropic = await promptYesNo('Configure Anthropic?', Boolean(existingAnthropic));
      if (useAnthropic) {
        while (!anthropicApiKey) {
          anthropicApiKey = await promptSecret('Anthropic API key');
          if (!anthropicApiKey) say('Key is required.');
        }
      }
    }
    if (interactive && !deepinfraApiKeyFlag && !deepinfraApiKey) {
      const useDeepinfra = await promptYesNo('Configure DeepInfra?', Boolean(existingDeepinfra));
      if (useDeepinfra) {
        while (!deepinfraApiKey) {
          deepinfraApiKey = await promptSecret('DeepInfra API key');
          if (!deepinfraApiKey) say('Key is required.');
        }
      }
    }

    if (!anthropicApiKey && existingAnthropic && !anthropicApiKeyFlag) {
      anthropicApiKey = existingAnthropic;
      say('Anthropic API key: (already set)');
    }
    if (!deepinfraApiKey && existingDeepinfra && !deepinfraApiKeyFlag) {
      deepinfraApiKey = existingDeepinfra;
      say('DeepInfra API key: (already set)');
    }

    if (!anthropicApiKey && !deepinfraApiKey) {
      throw new Error('At least one LLM provider key is required (Anthropic and/or DeepInfra).');
    }

    let anthropicCheck: any = { ok: false, model_count: 0, models: [] };
    if (anthropicApiKey) {
      sayInline('Validating Anthropic key... ');
      anthropicCheck = await validateAnthropicKey(anthropicApiKey);
      if (!anthropicCheck.ok) {
        say('failed.');
        say(`Error: ${anthropicCheck.error}`);
        if (anthropicApiKeyFlag || !deepinfraApiKey) {
          throw new Error('Anthropic key validation failed. Check the key and re-run `agent-outbound init`.');
        }
        say('Continuing with DeepInfra only.');
        anthropicApiKey = '';
      } else {
        say(`ok. (${anthropicCheck.model_count} models available)`);
      }
    }

    let deepinfraSelectedModels: string[] = [];
    if (deepinfraApiKey) {
      sayInline('Validating DeepInfra key... ');
      const deepinfraCheck = await listDeepInfraModels(deepinfraApiKey);
      if (!deepinfraCheck.ok) {
        say('failed.');
        say(`Error: ${deepinfraCheck.error}`);
        if (deepinfraApiKeyFlag || !anthropicApiKey) {
          throw new Error('DeepInfra key validation failed. Check the key and re-run `agent-outbound init`.');
        }
        say('Continuing with Anthropic only.');
        deepinfraApiKey = '';
      } else {
        say(`ok. (${deepinfraCheck.models.length} models available)`);

        const available = new Set(deepinfraCheck.models);
        const recommended = DEEPINFRA_RECOMMENDED_MODELS.filter((id) => available.has(id));
        const preselected = recommended;
        if (interactive) {
          say('');
          say('DeepInfra recommended models:');
          recommended.forEach((modelId, index) => {
            say(`  ${index + 1}. ${modelId}`);
          });
          const selectedIdxRaw = await promptText('Select recommended models (comma-separated numbers, blank for all recommended)');
          const selectedIndexes = selectedIdxRaw
            ? selectedIdxRaw.split(',').map((item) => Number(String(item || '').trim())).filter((n) => Number.isFinite(n) && n >= 1 && n <= recommended.length)
            : [];
          deepinfraSelectedModels = selectedIndexes.length > 0
            ? selectedIndexes.map((n) => recommended[n - 1]).filter(Boolean)
            : preselected;

          const extraRaw = await promptText('Additional DeepInfra model IDs (one per line, blank to skip)');
          const extras = extraRaw.split('\n').map((line) => String(line || '').trim()).filter(Boolean);
          for (const extra of extras) {
            if (!available.has(extra)) {
              throw new Error(`DeepInfra model not found during init: ${extra}`);
            }
            deepinfraSelectedModels.push(extra);
          }
        } else {
          deepinfraSelectedModels = preselected;
        }
        deepinfraSelectedModels = [...new Set(deepinfraSelectedModels)];
      }
    }

    // Persist and summarize
    const result = await initCommand({
      composioApiKey,
      anthropicApiKey,
      deepinfraApiKey,
      deepinfraModels: deepinfraSelectedModels,
      keepExistingDeepinfra: deepinfraSelectedModels.length === 0,
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
    setResponseContext({ command: 'lists', list: '' });
    const delegated = await callServeAction('lists', {}, '.');
    if (delegated) {
      print(delegated);
      return;
    }
    print(listsCommand());
    return;
  }

  if (command === 'models') {
    const provider = consumeFlag(argv, '--provider', '');
    const search = consumeFlag(argv, '--search', '');
    const sub = String(argv.shift() || '').trim();
    if (!sub || sub.startsWith('--')) {
      setResponseContext({ command: 'models', list: '' });
      print(modelsListCommand({ provider, search }));
      return;
    }
    if (sub === 'add') {
      const model = String(argv.shift() || '').trim();
      setResponseContext({ command: 'models add', list: '' });
      print(await modelsAddCommand({ model }));
      return;
    }
    if (sub === 'remove') {
      const model = String(argv.shift() || '').trim();
      setResponseContext({ command: 'models remove', list: '' });
      print(modelsRemoveCommand({ model }));
      return;
    }
    if (sub === 'refresh') {
      setResponseContext({ command: 'models refresh', list: '' });
      const ciLike = Boolean(
        process.env.CI
        || process.env.GITHUB_ACTIONS
        || process.env.BUILDKITE
        || process.env.GITLAB_CI
      );
      const interactive = Boolean(process.stdin.isTTY && !ciLike);
      if (interactive) {
        const deepinfraKey = String(getEnv('DEEPINFRA_API_KEY') || '').trim();
        if (deepinfraKey) {
          const listed = await listDeepInfraModels(deepinfraKey);
          if (listed.ok) {
            const available = new Set(listed.models || []);
            const current = new Set(modelsListCommand({ provider: 'deepinfra' }).models.map((row: any) => String(row?.model_id || '')));
            const recommended = DEEPINFRA_RECOMMENDED_MODELS.filter((id) => available.has(id));
            process.stderr.write('\nDeepInfra recommended models (current picks marked with *):\n');
            recommended.forEach((id, idx) => {
              const marker = current.has(id) ? '*' : ' ';
              process.stderr.write(`  ${idx + 1}. [${marker}] ${id}\n`);
            });
            const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
            const selectedRaw = await new Promise<string>((resolve) => {
              rl.question('Select recommended models (comma-separated numbers, blank keeps current): ', (answer) => resolve(String(answer || '').trim()));
            });
            const extraRaw = await new Promise<string>((resolve) => {
              rl.question('Additional DeepInfra model IDs (comma-separated, blank to skip): ', (answer) => resolve(String(answer || '').trim()));
            });
            rl.close();

            const selectedIndexes = selectedRaw
              ? selectedRaw.split(',').map((item) => Number(String(item || '').trim())).filter((n) => Number.isFinite(n) && n >= 1 && n <= recommended.length)
              : [];
            const selectedRecommended = selectedIndexes.length > 0
              ? selectedIndexes.map((n) => recommended[n - 1]).filter(Boolean)
              : Array.from(current).filter((id) => available.has(id));
            const extraModels = extraRaw
              ? extraRaw.split(',').map((item) => String(item || '').trim()).filter(Boolean)
              : [];
            const nextModels = [...new Set([...selectedRecommended, ...extraModels])];
            for (const modelId of nextModels) {
              if (!available.has(modelId)) {
                throw new Error(`DeepInfra model not found: ${modelId}`);
              }
            }
            print(await modelsRefreshCommand({ deepinfraModels: nextModels, keepExistingDeepinfra: false }));
            return;
          }
        }
      }
      print(await modelsRefreshCommand({ keepExistingDeepinfra: true }));
      return;
    }
    throw new Error(`Unknown models subcommand: ${sub}`);
  }

  if (command === 'describe') {
    const targetCommand = consumeFlag(argv, '--command', '');
    setResponseContext({ command: 'describe', list: '' });
    print(describeCommand({ command: targetCommand }));
    return;
  }

  if (command === 'query') {
    const list = String(argv.shift() || '');
    const sql = consumeFlag(argv, '--sql', '');
    const cursor = consumeFlag(argv, '--cursor', '');
    const limit = toNumber(consumeFlag(argv, '--limit', '500'), 500);
    const timeoutMs = toNumber(consumeFlag(argv, '--timeout-ms', '4000'), 4000);
    setResponseContext({ command: 'query', list });
    const delegated = await callServeAction('query', { list, sql, cursor, limit, timeoutMs }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(queryCommand({ list, sql, cursor, limit, timeoutMs }));
    return;
  }

  if (command === 'schema') {
    const list = String(argv.shift() || '');
    const table = consumeFlag(argv, '--table', '');
    setResponseContext({ command: 'schema', list });
    const delegated = await callServeAction('schema', { list, table, format }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(schemaCommand({ list, table, format }));
    return;
  }

  if (command === 'export') {
    const list = String(argv.shift() || '');
    const toFile = consumeFlag(argv, '--to', '');
    const select = consumeFlag(argv, '--select', '');
    const where = consumeFlag(argv, '--where', '');
    setResponseContext({ command: 'export', list });
    const delegated = await callServeAction('export', {
      list,
      toFile,
      select,
      where,
      format,
    }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(await exportCommand({ list, toFile, select, where, format }));
    return;
  }

  if (command === 'views') {
    const sub = String(argv.shift() || '').trim();
    if (sub !== 'save') throw new Error(`Unknown views subcommand: ${sub}`);
    const list = String(argv.shift() || '');
    const name = consumeFlag(argv, '--name', '');
    const select = consumeFlag(argv, '--select', '');
    const where = consumeFlag(argv, '--where', '');
    setResponseContext({ command: 'views save', list });
    const delegated = await callServeAction('views_save', { list, name, select, where }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(viewsSaveCommand({ list, name, select, where }));
    return;
  }

  if (command === 'record') {
    const sub = String(argv.shift() || '').trim();
    if (sub === 'show') {
      const list = String(argv.shift() || '');
      const rowId = String(argv.shift() || '');
      const include = consumeFlag(argv, '--include', '');
      setResponseContext({ command: 'record show', list });
      const delegated = await callServeAction('record_show', { list, rowId, include }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(recordShowCommand({ list, rowId, include }));
      return;
    }
    if (sub === 'revert') {
      const list = String(argv.shift() || '');
      const rowId = String(argv.shift() || '');
      const stepId = consumeFlag(argv, '--step', '');
      setResponseContext({ command: 'record revert', list });
      const delegated = await callServeAction('record_revert', { list, rowId, stepId }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(recordRevertStepCommand({ list, rowId, stepId }));
      return;
    }
    if (sub === 'revert-score') {
      const list = String(argv.shift() || '');
      const rowId = String(argv.shift() || '');
      setResponseContext({ command: 'record revert-score', list });
      const delegated = await callServeAction('record_revert_score', { list, rowId }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(recordRevertScoreCommand({ list, rowId }));
      return;
    }
    if (sub === 'revert-sequence') {
      const list = String(argv.shift() || '');
      const rowId = String(argv.shift() || '');
      const toStep = toNumber(consumeFlag(argv, '--to-step', '1'), 1);
      setResponseContext({ command: 'record revert-sequence', list });
      const delegated = await callServeAction('record_revert_sequence', { list, rowId, toStep }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(recordRevertSequenceCommand({ list, rowId, toStep }));
      return;
    }
    throw new Error(`Unknown record subcommand: ${sub}`);
  }

  if (command === 'pipeline') {
    const sub = String(argv.shift() || '').trim();
    if (sub !== 'show') throw new Error(`Unknown pipeline subcommand: ${sub}`);
    const list = String(argv.shift() || '');
    setResponseContext({ command: 'pipeline show', list });
    const delegated = await callServeAction('pipeline_show', { list }, list);
    const result = delegated || pipelineShowCommand({ list });
    if (format === 'summary') {
      print(successEnvelope({
        command: 'pipeline show',
        list,
        result,
        summary: String(result?.summary || ''),
      }));
      return;
    }
    print(result);
    return;
  }

  if (command === 'replies') {
    const sub = String(argv.shift() || '').trim();
    if (sub !== 'show') throw new Error(`Unknown replies subcommand: ${sub}`);
    const list = String(argv.shift() || '');
    const recordId = consumeFlag(argv, '--record', '');
    const since = consumeFlag(argv, '--since', '');
    const until = consumeFlag(argv, '--until', '');
    const classification = consumeFlag(argv, '--classification', '');
    const cursor = consumeFlag(argv, '--cursor', '');
    const limit = toNumber(consumeFlag(argv, '--limit', '100'), 100);
    setResponseContext({ command: 'replies show', list });
    const delegated = await callServeAction('replies_show', {
      list, recordId, since, until, classification, cursor, limit,
    }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(repliesShowCommand({
      list, recordId, since, until, classification, cursor, limit,
    }));
    return;
  }

  if (command === 'drafts') {
    const sub = String(argv.shift() || '').trim();
    if (sub === 'list') {
      const list = String(argv.shift() || '');
      const status = consumeFlag(argv, '--status', '');
      const step = toNumber(consumeFlag(argv, '--step', '0'), 0);
      const cursor = consumeFlag(argv, '--cursor', '');
      const limit = toNumber(consumeFlag(argv, '--limit', '100'), 100);
      setResponseContext({ command: 'drafts list', list });
      const delegated = await callServeAction('drafts_list', { list, status, step, cursor, limit }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(draftsListCommand({ list, status, step, cursor, limit }));
      return;
    }
    if (sub === 'show') {
      const list = String(argv.shift() || '');
      const draftId = consumeFlag(argv, '--id', '');
      setResponseContext({ command: 'drafts show', list });
      const delegated = await callServeAction('drafts_show', { list, draftId }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(draftsShowCommand({ list, draftId }));
      return;
    }
    if (sub === 'approve') {
      const list = String(argv.shift() || '');
      const draftId = consumeFlag(argv, '--id', '');
      const all = hasFlag(argv, '--all');
      const where = consumeFlag(argv, '--where', '');
      setResponseContext({ command: 'drafts approve', list });
      const delegated = await callServeAction('drafts_approve', {
        list, draftId, all, where,
      }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(draftsApproveCommand({ list, draftId, all, where }));
      return;
    }
    if (sub === 'reject') {
      const list = String(argv.shift() || '');
      const draftId = consumeFlag(argv, '--id', '');
      const reason = consumeFlag(argv, '--reason', '');
      setResponseContext({ command: 'drafts reject', list });
      const delegated = await callServeAction('drafts_reject', { list, draftId, reason }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(draftsRejectCommand({ list, draftId, reason }));
      return;
    }
    if (sub === 'edit') {
      const list = String(argv.shift() || '');
      const draftId = consumeFlag(argv, '--id', '');
      const subject = consumeFlag(argv, '--subject', '');
      const body = consumeFlag(argv, '--body', '');
      setResponseContext({ command: 'drafts edit', list });
      const delegated = await callServeAction('drafts_edit', {
        list, draftId, subject, body,
      }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(draftsEditCommand({ list, draftId, subject, body }));
      return;
    }
    throw new Error(`Unknown drafts subcommand: ${sub}`);
  }

  if (command === 'ai-usage') {
    const list = String(argv.shift() || '');
    const step = consumeFlag(argv, '--step', '');
    const record = consumeFlag(argv, '--record', '');
    const period = consumeFlag(argv, '--period', '');
    const groupBy = consumeFlag(argv, '--group-by', '');
    setResponseContext({ command: 'ai-usage', list });
    const delegated = await callServeAction('ai_usage', {
      list, step, record, period, groupBy,
    }, list);
    const result = delegated || aiUsageCommand({
      list, step, record, period, groupBy,
    });
    if (format === 'summary') {
      print(successEnvelope({
        command: 'ai-usage',
        list,
        result,
        summary: String(result?.summary || ''),
      }));
      return;
    }
    print(result);
    return;
  }

  if (command === 'usage') {
    const list = String(argv.shift() || '');
    const toolkit = consumeFlag(argv, '--toolkit', '');
    const tool = consumeFlag(argv, '--tool', '');
    const step = consumeFlag(argv, '--step', '');
    const record = consumeFlag(argv, '--record', '');
    const period = consumeFlag(argv, '--period', '');
    const groupBy = consumeFlag(argv, '--group-by', '');
    setResponseContext({ command: 'usage', list });
    const delegated = await callServeAction('usage', {
      list, toolkit, tool, step, record, period, groupBy,
    }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(usageCommand({
      list, toolkit, tool, step, record, period, groupBy,
    }));
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

    if (sub === 'validate') {
      const filePath = consumeFlag(argv, '--file', '');
      setResponseContext({ command: 'config validate', list });
      const delegated = await callServeAction('config_validate', { list, filePath }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(await configValidateCommand({ list, filePath }));
      return;
    }

    if (sub === 'diff') {
      const filePath = consumeFlag(argv, '--file', '');
      const snapshotId = consumeFlag(argv, '--from-snapshot', '');
      setResponseContext({ command: 'config diff', list });
      const delegated = await callServeAction('config_diff', { list, filePath, snapshotId }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(configDiffCommand({ list, filePath, snapshotId }));
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
    const dryRun = hasFlag(argv, '--dry-run');
    const sample = toNumber(consumeFlag(argv, '--sample', '0'), 0);
    if (more > 0) {
      const delegatedMore = await callServeAction('source_more', { list, more }, list);
      if (delegatedMore) {
        print(delegatedMore);
        return;
      }
      print(await sourceMoreCommand({ list, more }));
      return;
    }
    const delegated = await callServeAction('source', {
      list, limit, dryRun, sample,
    }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(await sourceCommand({ list, limit, dryRun, sample }));
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
    const dryRun = hasFlag(argv, '--dry-run');
    const sample = toNumber(consumeFlag(argv, '--sample', '0'), 0);
    const delegated = await callServeAction('enrich', {
      list, step, where, limit, dryRun, sample,
    }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(await enrichCommand({
      list, step, where, limit, dryRun, sample,
    }));
    return;
  }

  if (command === 'score') {
    const list = String(argv.shift() || '');
    const dryRun = hasFlag(argv, '--dry-run');
    const sample = toNumber(consumeFlag(argv, '--sample', '0'), 0);
    const delegated = await callServeAction('score', { list, dryRun, sample }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(await scoreCommand({ list, dryRun, sample }));
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
    const dryRun = hasFlag(argv, '--dry-run');
    const sample = toNumber(consumeFlag(argv, '--sample', '0'), 0);

    if (sub === 'draft') {
      const sequenceName = consumeFlag(argv, '--sequence', 'default');
      const delegated = await callServeAction('launch_draft', {
        list, limit, sequenceName, dryRun, sample,
      }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(await launchDraftCommand({
        list, limit, sequenceName, dryRun, sample,
      }));
      return;
    }
    if (sub === 'send') {
      const delegated = await callServeAction('launch_send', {
        list, limit, dryRun, sample,
      }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(await launchSendCommand({ list, limit, dryRun, sample }));
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
      const sample = toNumber(consumeFlag(argv, '--sample', '0'), 0);
      const delegated = !allLists
        ? await callServeAction('sequence_run', {
          list, allLists, sequenceName, dryRun, sample,
        }, list)
        : null;
      if (delegated) {
        print(delegated);
        return;
      }
      print(await sequenceRunCommand({
        list, allLists, sequenceName, dryRun, sample,
      }));
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
    if (sub === 'plan') {
      const list = String(argv.shift() || '');
      const date = consumeFlag(argv, '--date', '');
      setResponseContext({ command: 'route plan', list });
      const delegated = await callServeAction('route_plan', { list, date }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(await routePlanCommand({ list, date }));
      return;
    }
    if (sub === 'show') {
      const list = String(argv.shift() || '');
      const date = consumeFlag(argv, '--date', '');
      const include = consumeFlag(argv, '--include', '');
      const cursor = consumeFlag(argv, '--cursor', '');
      const limit = toNumber(consumeFlag(argv, '--limit', '100'), 100);
      setResponseContext({ command: 'route show', list });
      const delegated = await callServeAction('route_show', {
        list, date, include, cursor, limit,
      }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(routeShowCommand({
        list, date, include, cursor, limit,
      }));
      return;
    }
    throw new Error(`Unknown route subcommand: ${sub}`);
  }

  if (command === 'templates') {
    const sub = String(argv.shift() || '').trim();
    if (sub === 'list') {
      const list = String(argv.shift() || '');
      setResponseContext({ command: 'templates list', list });
      const delegated = await callServeAction('templates_list', { list }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(templatesListCommand({ list }));
      return;
    }
    if (sub === 'show') {
      const list = String(argv.shift() || '');
      const templateId = consumeFlag(argv, '--id', '');
      setResponseContext({ command: 'templates show', list });
      const delegated = await callServeAction('templates_show', { list, templateId }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(templatesShowCommand({ list, templateId }));
      return;
    }
    if (sub === 'create') {
      const list = String(argv.shift() || '');
      const templateId = consumeFlag(argv, '--id', '');
      const channelHint = consumeFlag(argv, '--channel', '');
      const subject = consumeFlag(argv, '--subject', '');
      const body = consumeFlag(argv, '--body', '');
      const variablesJson = consumeFlag(argv, '--variables', '{}');
      setResponseContext({ command: 'templates create', list });
      const delegated = await callServeAction('templates_create', {
        list, templateId, channelHint, subject, body, variablesJson,
      }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(templatesCreateCommand({
        list, templateId, channelHint, subject, body, variablesJson,
      }));
      return;
    }
    if (sub === 'update') {
      const list = String(argv.shift() || '');
      const templateId = consumeFlag(argv, '--id', '');
      const subject = consumeFlag(argv, '--subject', '');
      const body = consumeFlag(argv, '--body', '');
      const variablesJson = consumeFlag(argv, '--variables', '');
      const note = consumeFlag(argv, '--note', '');
      setResponseContext({ command: 'templates update', list });
      const delegated = await callServeAction('templates_update', {
        list, templateId, subject, body, variablesJson, note,
      }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(templatesUpdateCommand({
        list, templateId, subject, body, variablesJson, note,
      }));
      return;
    }
    throw new Error(`Unknown templates subcommand: ${sub}`);
  }

  if (command === 'snapshot') {
    const sub = String(argv.shift() || '').trim();
    if (sub === 'create') {
      const list = String(argv.shift() || '');
      const label = consumeFlag(argv, '--label', '');
      setResponseContext({ command: 'snapshot create', list });
      const delegated = await callServeAction('snapshot_create', { list, label }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(snapshotCreateCommand({ list, label }));
      return;
    }
    if (sub === 'list') {
      const list = String(argv.shift() || '');
      setResponseContext({ command: 'snapshot list', list });
      const delegated = await callServeAction('snapshot_list', { list }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(snapshotListCommand({ list }));
      return;
    }
    if (sub === 'restore') {
      const list = String(argv.shift() || '');
      const snapshotId = consumeFlag(argv, '--id', '');
      setResponseContext({ command: 'snapshot restore', list });
      const delegated = await callServeAction('snapshot_restore', { list, snapshotId }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(snapshotRestoreCommand({ list, snapshotId }));
      return;
    }
    if (sub === 'delete') {
      const list = String(argv.shift() || '');
      const snapshotId = consumeFlag(argv, '--id', '');
      setResponseContext({ command: 'snapshot delete', list });
      const delegated = await callServeAction('snapshot_delete', { list, snapshotId }, list);
      if (delegated) {
        print(delegated);
        return;
      }
      print(snapshotDeleteCommand({ list, snapshotId }));
      return;
    }
    throw new Error(`Unknown snapshot subcommand: ${sub}`);
  }

  if (command === 'log') {
    const list = String(argv.shift() || '');
    const prospect = consumeFlag(argv, '--prospect', '');
    const action = consumeFlag(argv, '--action', '');
    const note = consumeFlag(argv, '--note', '');
    const transition = consumeFlag(argv, '--transition', '');
    const followUpIn = consumeFlag(argv, '--follow-up-in', '');
    const delegated = await callServeAction('log', {
      list, prospect, action, note, transition, followUpIn,
    }, list);
    if (delegated) {
      print(delegated);
      return;
    }
    print(logCommand({
      list, prospect, action, note, transition, followUpIn,
    }));
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
  const structured = toStructuredError(error);
  const payload = failureEnvelope({
    command: responseCommand || 'unknown',
    list: responseList || '',
    error: structured,
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
});
