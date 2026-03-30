#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Command registry. Each command has:
 * - description: short help text
 * - schema: argument definitions for --schema output
 * - run: async function that executes the command
 */
const commands = {};

const registerCommand = (name, { description, schema, run }) => {
  commands[name] = { description, schema, run };
};

const parseArgs = (argv) => {
  const positional = [];
  const named = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--schema' || arg === '--help' || arg === '-h') {
      named[arg.replace(/^-+/, '')] = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        named[key] = next;
        i += 1;
      } else {
        named[key] = true;
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, named };
};

const printJson = (data) => {
  console.log(JSON.stringify(data, null, 2));
};

// ─── Init ────────────────────────────────────────────────────────────────────

const COMMAND_FILE_NAME = 'outbound.md';

const getCommandFileContent = () => {
  const commandPath = join(__dirname, '..', 'command.md');
  if (existsSync(commandPath)) {
    return readFileSync(commandPath, 'utf-8');
  }
  throw new Error('command.md not found in package. This is a packaging error.');
};

registerCommand('init', {
  description: 'Set up outbound in the current directory. Installs the /outbound command for Claude Code.',
  schema: [],
  run: async () => {
    const cwd = process.cwd();
    console.log('Initializing outbound in', cwd);
    console.log();

    const claudeCommandsDir = join(cwd, '.claude', 'commands');
    const commandDest = join(claudeCommandsDir, COMMAND_FILE_NAME);
    mkdirSync(claudeCommandsDir, { recursive: true });
    writeFileSync(commandDest, getCommandFileContent());
    console.log('  Installed .claude/commands/outbound.md');

    console.log();
    console.log('Done! Open Claude Code in this directory and type:');
    console.log();
    console.log('  /outbound');
    console.log();
    console.log('To get started, try:');
    console.log('  "Create a list called my-first-list"');
  },
});

// ─── Serve (legacy MCP, kept for backward compatibility) ─────────────────────

registerCommand('serve', {
  description: 'Start the MCP server (backward compatibility). Prefer CLI commands instead.',
  schema: [],
  run: async () => {
    await import('./server.js');
  },
});

// ─── List commands ───────────────────────────────────────────────────────────

registerCommand('lists', {
  description: 'Overview of all outreach lists found in the current directory tree.',
  schema: [
    { name: 'path', type: 'string', required: false, description: 'Directory to scan. Defaults to cwd.' },
  ],
  run: async ({ named }) => {
    const { listsTool } = await import('./tools/lists.js');
    printJson(await listsTool.run({ path: named.path }));
  },
});

registerCommand('list info', {
  description: 'Detailed status of a specific list.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
  ],
  run: async ({ positional, named }) => {
    const { listInfoTool } = await import('./tools/list-info.js');
    printJson(await listInfoTool.run({ list: positional[0] || named.list }));
  },
});

registerCommand('list create', {
  description: 'Create a new outreach list.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path for the new list directory.' },
    { name: 'name', type: 'string', required: false, description: 'Display name for the list.' },
    { name: 'description', type: 'string', required: false, description: 'List description.' },
  ],
  run: async ({ positional, named }) => {
    const { listCreateTool } = await import('./tools/list-create.js');
    printJson(await listCreateTool.run({
      list: positional[0] || named.list,
      name: named.name,
      description: named.description,
    }));
  },
});

// ─── Config commands ─────────────────────────────────────────────────────────

registerCommand('config read', {
  description: 'Read a list\'s outbound config (outbound.yaml).',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
  ],
  run: async ({ positional, named }) => {
    const { configReadTool } = await import('./tools/config-read.js');
    printJson(await configReadTool.run({ list: positional[0] || named.list, config: 'outbound' }));
  },
});

registerCommand('config update', {
  description: 'Write raw YAML to a list\'s config. For natural-language changes, use "config author" instead.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
    { name: 'content', type: 'string', required: true, description: 'Full YAML content to write.' },
  ],
  run: async ({ positional, named }) => {
    const { configUpdateTool } = await import('./tools/config-update.js');
    printJson(await configUpdateTool.run({
      list: positional[0] || named.list,
      config: 'outbound',
      content: named.content,
    }));
  },
});

registerCommand('config author', {
  description: 'Author or modify config from a natural-language request. Discovers available tools and writes valid config.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
    { name: 'request', type: 'string', required: true, description: 'Natural-language config request.' },
  ],
  run: async ({ positional, named }) => {
    const { configAuthorTool } = await import('./tools/config-author.js');
    printJson(await configAuthorTool.run({
      list: positional[0] || named.list,
      request: positional[1] || named.request,
    }));
  },
});

// ─── Sourcing ────────────────────────────────────────────────────────────────

registerCommand('source', {
  description: 'Run sourcing for a list (search + filter). Streams progress to stdout.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
    { name: 'limit', type: 'number', required: false, description: 'Max new prospects to source.' },
    { name: 'search-index', type: 'number', required: false, description: 'Run only a specific search (zero-based).' },
  ],
  run: async ({ positional, named }) => {
    const { sourceTool } = await import('./tools/source.js');
    printJson(await sourceTool.run({
      list: positional[0] || named.list,
      limit: named.limit != null ? Number(named.limit) : undefined,
      search_index: named['search-index'] != null ? Number(named['search-index']) : undefined,
    }));
  },
});

// ─── Enrichment ──────────────────────────────────────────────────────────────

registerCommand('enrich', {
  description: 'Run enrichment steps for a list. Streams progress to stdout.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
    { name: 'source', type: 'string', required: false, description: 'Run only a specific source ID.' },
    { name: 'rows', type: 'string', required: false, description: 'Row range (e.g. "0-50").' },
    { name: 'concurrency', type: 'number', required: false, description: 'Override per-source concurrency.' },
  ],
  run: async ({ positional, named }) => {
    const { enrichTool } = await import('./tools/enrich.js');
    printJson(await enrichTool.run({
      list: positional[0] || named.list,
      source: named.source,
      rows: named.rows,
      concurrency: named.concurrency != null ? Number(named.concurrency) : undefined,
    }));
  },
});

registerCommand('enrich-status', {
  description: 'Show enrichment progress per source.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
  ],
  run: async ({ positional, named }) => {
    const { enrichStatusTool } = await import('./tools/enrich-status.js');
    printJson(await enrichStatusTool.run({ list: positional[0] || named.list }));
  },
});

// ─── CSV ─────────────────────────────────────────────────────────────────────

registerCommand('csv read', {
  description: 'Read rows from a list\'s CSV with optional filters and column selection.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
    { name: 'columns', type: 'string', required: false, description: 'Comma-separated column names to include.' },
    { name: 'filter', type: 'string', required: false, description: 'Filter as key=value (e.g. "source_filter_result=passed").' },
    { name: 'range', type: 'string', required: false, description: 'Row range (e.g. "0-10").' },
    { name: 'limit', type: 'number', required: false, description: 'Max rows to return.' },
  ],
  run: async ({ positional, named }) => {
    const { csvReadTool } = await import('./tools/csv-read.js');
    const filter = named.filter
      ? Object.fromEntries(named.filter.split(',').map((kv) => kv.split('=')))
      : undefined;
    const columns = named.columns
      ? named.columns.split(',').map((c) => c.trim())
      : undefined;
    printJson(await csvReadTool.run({
      list: positional[0] || named.list,
      columns,
      filter,
      range: named.range,
      limit: named.limit != null ? Number(named.limit) : undefined,
    }));
  },
});

registerCommand('csv stats', {
  description: 'Column inventory with fill rates and row count.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
  ],
  run: async ({ positional, named }) => {
    const { csvStatsTool } = await import('./tools/csv-stats.js');
    printJson(await csvStatsTool.run({ list: positional[0] || named.list }));
  },
});

// ─── Launch ──────────────────────────────────────────────────────────────────

registerCommand('launch draft', {
  description: 'Create step 1 drafts for selected rows.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
    { name: 'filter', type: 'string', required: false, description: 'Filter rows (key=value).' },
    { name: 'rows', type: 'string', required: false, description: 'Row range (e.g. "0-10").' },
  ],
  run: async ({ positional, named }) => {
    const { launchDraftTool } = await import('./tools/launch-draft.js');
    printJson(await launchDraftTool.run({
      list: positional[0] || named.list,
      filter: named.filter,
      rows: named.rows,
    }));
  },
});

registerCommand('launch send', {
  description: 'Send step 1 drafts and initialize sequence state.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
    { name: 'filter', type: 'string', required: false, description: 'Filter rows (key=value).' },
    { name: 'stagger', type: 'number', required: false, description: 'Seconds between sends.' },
  ],
  run: async ({ positional, named }) => {
    const { launchSendTool } = await import('./tools/launch-send.js');
    printJson(await launchSendTool.run({
      list: positional[0] || named.list,
      filter: named.filter,
      staggerSeconds: named.stagger != null ? Number(named.stagger) : undefined,
    }));
  },
});

registerCommand('launch status', {
  description: 'Draft/send/pending counts for step 1.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
  ],
  run: async ({ positional, named }) => {
    const { launchStatusTool } = await import('./tools/launch-status.js');
    printJson(await launchStatusTool.run({ list: positional[0] || named.list }));
  },
});

// ─── Sequence ────────────────────────────────────────────────────────────────

registerCommand('sequence run', {
  description: 'Advance sequences: check replies, evaluate conditions, create follow-up drafts.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
    { name: 'dry-run', type: 'boolean', required: false, description: 'Preview due actions without executing.' },
  ],
  run: async ({ positional, named }) => {
    const { sequenceRunTool } = await import('./tools/sequence-run.js');
    printJson(await sequenceRunTool.run({
      list: positional[0] || named.list,
      dry_run: named['dry-run'] === true || named['dry-run'] === 'true',
    }));
  },
});

registerCommand('sequence status', {
  description: 'Pipeline counts and due actions by type.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
  ],
  run: async ({ positional, named }) => {
    const { sequenceStatusTool } = await import('./tools/sequence-status.js');
    printJson(await sequenceStatusTool.run({ list: positional[0] || named.list }));
  },
});

registerCommand('followup send', {
  description: 'Send follow-up drafts and advance sequence state.',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
    { name: 'filter', type: 'string', required: false, description: 'Filter rows (key=value).' },
    { name: 'rows', type: 'string', required: false, description: 'Row range.' },
    { name: 'stagger', type: 'number', required: false, description: 'Seconds between sends.' },
  ],
  run: async ({ positional, named }) => {
    const { followupSendTool } = await import('./tools/followup-send.js');
    printJson(await followupSendTool.run({
      list: positional[0] || named.list,
      filter: named.filter,
      rowRange: named.rows,
      staggerSeconds: named.stagger != null ? Number(named.stagger) : undefined,
    }));
  },
});

// ─── Sync ────────────────────────────────────────────────────────────────────

registerCommand('sync', {
  description: 'Sync CSV data to configured destinations (Google Sheets, CSV, etc.).',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
  ],
  run: async ({ positional, named }) => {
    const { syncTool } = await import('./tools/sync.js');
    printJson(await syncTool.run({ list: positional[0] || named.list }));
  },
});

// ─── Log ─────────────────────────────────────────────────────────────────────

registerCommand('log', {
  description: 'Log a prospect outcome (call result, meeting, opt-out).',
  schema: [
    { name: 'list', type: 'string', required: true, description: 'Path to the list directory.' },
    { name: 'prospect', type: 'string', required: true, description: 'Prospect name or row ID.' },
    { name: 'action', type: 'string', required: true, description: 'Action type (engaged, opted_out, bounced, completed, step_advanced).' },
    { name: 'note', type: 'string', required: false, description: 'Outcome note.' },
  ],
  run: async ({ positional, named }) => {
    const { logTool } = await import('./tools/log.js');
    printJson(await logTool.run({
      list: positional[0] || named.list,
      prospect: named.prospect,
      action: named.action,
      note: named.note,
    }));
  },
});

// ─── Command resolution and execution ────────────────────────────────────────

const resolveCommand = (argv) => {
  // Try two-word command first (e.g., "config author", "list info")
  const twoWord = `${argv[0] || ''} ${argv[1] || ''}`.trim();
  if (commands[twoWord]) {
    return { command: commands[twoWord], name: twoWord, remaining: argv.slice(2) };
  }
  // Try one-word command
  const oneWord = argv[0] || '';
  if (commands[oneWord]) {
    return { command: commands[oneWord], name: oneWord, remaining: argv.slice(1) };
  }
  return null;
};

const printHelp = () => {
  console.log('agent-outbound — AI-powered outbound pipeline for Claude Code');
  console.log();
  console.log('Usage: agent-outbound <command> [options]');
  console.log();
  console.log('Commands:');

  const maxLen = Math.max(...Object.keys(commands).map((k) => k.length));
  for (const [name, cmd] of Object.entries(commands)) {
    console.log(`  ${name.padEnd(maxLen + 2)} ${cmd.description}`);
  }

  console.log();
  console.log('Options:');
  console.log('  --help, -h     Show this help message');
  console.log('  --schema       Show argument schema for a command');
  console.log();
  console.log('Examples:');
  console.log('  agent-outbound source my-list --limit 10');
  console.log('  agent-outbound enrich my-list');
  console.log('  agent-outbound config author my-list "add a filter that checks for emails"');
  console.log('  agent-outbound csv read my-list --columns business_name,email --filter source_filter_result=passed');
  console.log('  agent-outbound sync my-list');
};

const printCommandSchema = (name, cmd) => {
  console.log(`${name}: ${cmd.description}`);
  console.log();
  if (cmd.schema.length === 0) {
    console.log('  No arguments.');
    return;
  }
  console.log('Arguments:');
  for (const arg of cmd.schema) {
    const reqLabel = arg.required ? '(required)' : '(optional)';
    console.log(`  --${arg.name.padEnd(16)} ${arg.type.padEnd(8)} ${reqLabel}  ${arg.description}`);
  }
  console.log();
  console.log('Positional: first positional argument is used as --list if not provided as a flag.');
};

// ─── Main ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
  printHelp();
  process.exit(0);
}

const resolved = resolveCommand(argv);

if (!resolved) {
  console.error(`Unknown command: ${argv[0]}`);
  console.error('Run agent-outbound --help for available commands.');
  process.exit(1);
}

const { command: cmd, name: cmdName, remaining } = resolved;
const parsed = parseArgs(remaining);

if (parsed.named.schema) {
  printCommandSchema(cmdName, cmd);
  process.exit(0);
}

if (parsed.named.help || parsed.named.h) {
  printCommandSchema(cmdName, cmd);
  process.exit(0);
}

try {
  await cmd.run(parsed);
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
}
