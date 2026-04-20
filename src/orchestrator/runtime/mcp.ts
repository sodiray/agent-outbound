import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getEnv } from './env.js';

const DEFAULT_MCP_URL = 'https://connect.composio.dev/mcp';
const CLIENT_NAME = 'agent-outbound';
const CLIENT_VERSION = '0.9.0';

type McpClient = Client;

let sharedClient: McpClient | null = null;
let sharedClientPromise: Promise<McpClient> | null = null;

// Composio threads a per-workflow session ID through meta-tool responses
// (`data.session.id`). Search passes it back as `session: { id }` (or
// `session: { generate_id: true }` on the first call); schemas + execute pass
// it as `session_id`. Track per client so a search → schemas → execute chain
// stays in the same session.
const sessionByClient = new WeakMap<McpClient, string>();
const NESTED_SESSION_TOOLS = new Set(['COMPOSIO_SEARCH_TOOLS']);

const getMcpUrl = () => String(getEnv('COMPOSIO_MCP_URL') || DEFAULT_MCP_URL).trim() || DEFAULT_MCP_URL;

const requireApiKey = (explicit?: string) => {
  const key = String(explicit || getEnv('COMPOSIO_API_KEY') || '').trim();
  if (!key) {
    throw new Error('COMPOSIO_API_KEY is missing. Run `agent-outbound init` or set it in ~/.agent-outbound/env.');
  }
  return key;
};

export const makeMcpClient = async (explicitApiKey?: string): Promise<McpClient> => {
  const apiKey = requireApiKey(explicitApiKey);
  const transport = new StreamableHTTPClientTransport(new URL(getMcpUrl()), {
    requestInit: {
      headers: {
        'x-consumer-api-key': apiKey,
      },
    },
  });
  const client = new Client(
    { name: CLIENT_NAME, version: CLIENT_VERSION },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
};

export const getMcpClient = async (): Promise<McpClient> => {
  if (sharedClient) return sharedClient;
  if (!sharedClientPromise) {
    sharedClientPromise = makeMcpClient()
      .then((client) => {
        sharedClient = client;
        return client;
      })
      .catch((error) => {
        sharedClientPromise = null;
        throw error;
      });
  }
  return sharedClientPromise;
};

export const closeMcpClient = async () => {
  const client = sharedClient;
  sharedClient = null;
  sharedClientPromise = null;
  if (!client) return;
  try {
    await client.close();
  } catch {
    // ignore
  }
};

// CLI one-shots shouldn't hang on a lingering SSE stream. Close the shared
// client on beforeExit so Node can finish cleanly.
process.once('beforeExit', () => {
  if (sharedClient) {
    void closeMcpClient();
  }
});

const extractText = (result: any): string => {
  const content = Array.isArray(result?.content) ? result.content : [];
  const parts = content
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => String(part.text));
  return parts.join('');
};

const tryParseJson = (text: string): unknown => {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const captureSessionId = (mcp: McpClient, parsed: any) => {
  const id = parsed?.data?.session?.id
    || parsed?.session?.id
    || parsed?.session_id
    || parsed?.sessionId;
  if (id && typeof id === 'string') sessionByClient.set(mcp, id);
};

const injectSession = (mcp: McpClient, name: string, args: Record<string, unknown>) => {
  const session = sessionByClient.get(mcp);
  if (NESTED_SESSION_TOOLS.has(name)) {
    if ('session' in args) return args;
    return { ...args, session: session ? { id: session } : { generate_id: true } };
  }
  if (!session || 'session_id' in args) return args;
  return { ...args, session_id: session };
};

export const callMetaTool = async (mcp: McpClient, name: string, args: Record<string, unknown> = {}) => {
  const result = await mcp.callTool({ name, arguments: injectSession(mcp, name, args) });
  const isError = Boolean((result as any)?.isError);
  const structured = (result as any)?.structuredContent;
  const text = extractText(result);
  const parsed = structured !== undefined ? structured : tryParseJson(text);

  // JSON-RPC-level error from the transport.
  if (isError) {
    const message = parsed && typeof parsed === 'object' && 'error' in (parsed as any)
      ? String((parsed as any).error)
      : text || `MCP tool "${name}" returned an error.`;
    throw new Error(`${name}: ${message}`);
  }

  // App-level error: Composio returns successful=false inside a JSON-RPC 200.
  // For MULTI_EXECUTE_TOOL, the envelope always reports the worst-case
  // successful flag across batched calls. We let the caller unwrap per-tool
  // results and surface a specific per-tool error instead of the generic
  // "N out of M tools failed".
  if (parsed && typeof parsed === 'object') {
    const successful = (parsed as any).successful;
    const errorField = (parsed as any).error;
    const hasBatchedResults = Array.isArray((parsed as any)?.data?.results);
    if ((successful === false || errorField) && !hasBatchedResults) {
      const message = errorField
        ? String(errorField)
        : `${name} returned successful=false`;
      throw new Error(`${name}: ${message}`);
    }
    captureSessionId(mcp, parsed);
  }

  return {
    parsed,
    text,
    raw: result,
  };
};

const asArray = (value: any): any[] => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.tools)) return value.tools;
  if (Array.isArray(value?.toolkit_connection_statuses)) return value.toolkit_connection_statuses;
  return [];
};

const extractToolkitSlug = (item: any): string => {
  const raw = item?.toolkit
    ?? item?.toolkit_slug
    ?? item?.toolkitSlug
    ?? item?.app
    ?? item?.app_slug
    ?? item?.appName
    ?? '';
  return String(raw || '').trim().toUpperCase();
};

// COMPOSIO_SEARCH_TOOLS returns toolkit_connection_statuses entries scoped to
// the tools matched by each query. To enumerate everything the operator has
// connected, we run a spread of domain-relevant use-cases and dedupe the
// toolkits that come back with has_active_connection=true.
const ENUMERATION_QUERIES = [
  { use_case: 'send and read email messages' },
  { use_case: 'find a business contact or email by name and company' },
  { use_case: 'scrape web pages or run a web search' },
  { use_case: 'search local businesses and places by location' },
  { use_case: 'verify an email address for deliverability' },
  { use_case: 'send physical mail or a postcard' },
  { use_case: 'send an SMS or text message' },
  { use_case: 'manage CRM records companies contacts deals' },
  { use_case: 'manage calendar events or booking links' },
  { use_case: 'send team chat or workspace messages' },
  { use_case: 'manage tasks projects and issues' },
  { use_case: 'manage files documents and spreadsheets' },
  { use_case: 'post and read social media content' },
  { use_case: 'manage code repositories and pull requests' },
  { use_case: 'enrich leads with contact and company data' },
  { use_case: 'search business listings reviews and ratings' },
  { use_case: 'cloud file storage and sharing' },
  { use_case: 'application monitoring and alerting' },
  { use_case: 'customer support and helpdesk tickets' },
  { use_case: 'make and receive phone calls' },
  { use_case: 'plan routes and calculate drive times between locations' },
  { use_case: 'look up public business records and registrations' },
];

const enumerateConnectedToolkits = async (mcp: McpClient): Promise<string[]> => {
  const seen = new Set<string>();
  const errors: string[] = [];

  const results = await Promise.allSettled(
    ENUMERATION_QUERIES.map(async (query) => {
      const { parsed } = await callMetaTool(mcp, 'COMPOSIO_SEARCH_TOOLS', {
        queries: [query],
      });
      const data = (parsed as any)?.data ?? parsed;
      const statuses = asArray(data?.toolkit_connection_statuses);
      for (const item of statuses) {
        if (item?.has_active_connection !== true) continue;
        const slug = extractToolkitSlug(item);
        if (slug) seen.add(slug);
      }
    }),
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      errors.push(String(result.reason?.message || result.reason));
    }
  }

  if (seen.size === 0 && errors.length > 0) {
    throw new Error(errors.join(' | '));
  }

  return [...seen].sort();
};

export const listConnectedToolkits = async (apiKey?: string): Promise<string[]> => {
  const shouldClose = Boolean(apiKey);
  const client = apiKey ? await makeMcpClient(apiKey) : await getMcpClient();
  try {
    return await enumerateConnectedToolkits(client);
  } finally {
    if (shouldClose) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
  }
};

export const assertToolSpecAvailable = async ({
  toolSpec,
  capability = 'This action',
}: {
  toolSpec: { toolkits?: string[]; tools?: string[] } | null | undefined;
  capability?: string;
}) => {
  const required = [...new Set((toolSpec?.toolkits || []).map((slug) => String(slug || '').trim().toUpperCase()).filter(Boolean))];
  if (required.length === 0) return;

  // Check the specific required toolkits directly via MANAGE_CONNECTIONS
  // rather than enumerating all connected toolkits (which relies on semantic
  // search and can miss less-common integrations).
  const mcp = await getMcpClient();
  const { parsed } = await callMetaTool(mcp, 'COMPOSIO_MANAGE_CONNECTIONS', {
    toolkits: required.map((slug) => slug.toLowerCase()),
    action: 'check',
  });
  const results = (parsed as any)?.data?.results || {};
  const missing: string[] = [];
  for (const slug of required) {
    const entry = results[slug] || results[slug.toLowerCase()];
    const accounts = Array.isArray(entry?.accounts) ? entry.accounts : [];
    const hasActive = accounts.some((a: any) => String(a?.status || '').toLowerCase() === 'active');
    if (!hasActive) missing.push(slug);
  }
  if (missing.length === 0) return;

  const first = missing[0];
  const dashboard = getToolkitDashboardUrl(first);
  throw new Error(
    `${capability} requires toolkit(s): ${missing.join(', ')} but they are not available in Composio. ` +
    `Reconnect at ${dashboard} or update your config.`,
  );
};

export type ValidateComposioKeyResult = {
  ok: boolean;
  toolkits: string[];
  error?: string;
};

const validationFailure = (error: string): ValidateComposioKeyResult => ({
  ok: false,
  toolkits: [],
  error,
});

export const validateComposioKey = async (apiKey: string): Promise<ValidateComposioKeyResult> => {
  const key = String(apiKey || '').trim();
  if (!key) return validationFailure('API key is empty.');

  let client: McpClient;
  try {
    client = await makeMcpClient(key);
  } catch (error) {
    return validationFailure(`Failed to connect to MCP: ${String((error as any)?.message || error)}`);
  }

  try {
    await client.listTools();
  } catch (error) {
    await client.close().catch(() => {});
    return validationFailure(`tools/list rejected: ${String((error as any)?.message || error)}`);
  }

  let toolkits: string[] = [];
  try {
    toolkits = await enumerateConnectedToolkits(client);
  } catch (error) {
    await client.close().catch(() => {});
    return validationFailure(`Connected-toolkit enumeration failed: ${String((error as any)?.message || error)}`);
  }

  await client.close().catch(() => {});
  return { ok: true, toolkits };
};

export const getToolkitDashboardUrl = (toolkit: string) => {
  const slug = String(toolkit || '').trim().toLowerCase();
  if (!slug) return 'https://platform.composio.dev/apps';
  return `https://platform.composio.dev/apps/${slug}`;
};
