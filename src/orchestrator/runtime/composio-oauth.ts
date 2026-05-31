import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  ensureGlobalDirs,
  getComposioOAuthClientPath,
  getComposioOAuthTokensPath,
  getComposioOAuthVerifierPath,
} from './paths.js';

const COMPOSIO_MCP_URL = 'https://connect.composio.dev/mcp';
const CLIENT_NAME = 'agent-outbound';
const CLIENT_VERSION = '0.9.0';
const OAUTH_SCOPE = 'openid profile email offline_access';
const CALLBACK_PATH = '/callback';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const getOAuthPort = () => {
  const port = Number(process.env.COMPOSIO_OAUTH_PORT);
  return Number.isFinite(port) && port > 0 ? port : 8765;
};

const randomUrlSafe = () => randomBytes(32).toString('base64url');

const readJsonFile = <T>(path: string): T | undefined => {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

const writeSecretFile = (path: string, value: string) => {
  ensureGlobalDirs();
  writeFileSync(path, value);
  chmodSync(path, 0o600);
};

const writeSecretJsonFile = (path: string, value: unknown) => {
  writeSecretFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

const isValidOAuthTokens = (tokens: unknown): tokens is OAuthTokens => {
  return Boolean(
    tokens
    && typeof tokens === 'object'
    && typeof (tokens as any).access_token === 'string'
    && String((tokens as any).access_token || '').trim()
  );
};

const openBrowser = (url: URL) => {
  try {
    const href = url.toString();
    const child = process.platform === 'darwin'
      ? spawn('open', [href], { detached: true, stdio: 'ignore' })
      : process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', href], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [href], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // best effort only
  }
};

export class ComposioOAuthProvider implements OAuthClientProvider {
  private expectedState = '';

  get redirectUrl() {
    return `http://localhost:${getOAuthPort()}${CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: OAUTH_SCOPE,
    };
  }

  state() {
    this.expectedState = randomUrlSafe();
    return this.expectedState;
  }

  validateState(state: string) {
    return Boolean(this.expectedState && state && state === this.expectedState);
  }

  clientInformation() {
    return readJsonFile<OAuthClientInformationMixed>(getComposioOAuthClientPath());
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed) {
    writeSecretJsonFile(getComposioOAuthClientPath(), clientInformation);
  }

  tokens() {
    const tokens = readJsonFile<OAuthTokens>(getComposioOAuthTokensPath());
    return isValidOAuthTokens(tokens) ? tokens : undefined;
  }

  saveTokens(tokens: OAuthTokens) {
    if (!isValidOAuthTokens(tokens)) {
      process.stderr.write('Warning: ignoring invalid Composio OAuth token save.\n');
      return;
    }

    const existing = this.tokens();
    const existingRefreshToken = typeof existing?.refresh_token === 'string' && existing.refresh_token.trim()
      ? existing.refresh_token
      : '';
    const incomingRefreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim()
      ? tokens.refresh_token
      : '';
    const merged = existingRefreshToken && !incomingRefreshToken
      ? { ...tokens, refresh_token: existingRefreshToken }
      : tokens;
    writeSecretJsonFile(getComposioOAuthTokensPath(), merged);
  }

  redirectToAuthorization(authorizationUrl: URL) {
    process.stderr.write(`Open this URL to authorize:\n${authorizationUrl.toString()}\n`);
    openBrowser(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string) {
    writeSecretFile(getComposioOAuthVerifierPath(), `${codeVerifier}\n`);
  }

  codeVerifier() {
    if (!existsSync(getComposioOAuthVerifierPath())) {
      throw new Error('OAuth code verifier is missing. Run `agent-outbound auth login` again.');
    }
    return readFileSync(getComposioOAuthVerifierPath(), 'utf8').trim();
  }
}

const createMcpClient = async (provider: ComposioOAuthProvider) => {
  const transport = new StreamableHTTPClientTransport(new URL(COMPOSIO_MCP_URL), {
    authProvider: provider,
  });
  const client = new Client(
    { name: CLIENT_NAME, version: CLIENT_VERSION },
    { capabilities: {} }
  );
  return { client, transport };
};

const closeServer = async (server: Server | null) => {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const startCallbackServer = async (provider: ComposioOAuthProvider) => {
  let settled = false;
  let timeout: NodeJS.Timeout | null = null;
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${getOAuthPort()}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const code = String(url.searchParams.get('code') || '').trim();
      const state = String(url.searchParams.get('state') || '').trim();
      if (!code || !provider.validateState(state)) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Invalid OAuth callback.');
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body>Authorization complete - you can close this tab.</body></html>');
      if (!settled) {
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolveCode(code);
      }
    } catch (error) {
      rejectCode(error);
    }
  });

  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (error: unknown) => void = () => {};
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = (error: unknown) => {
      if (!settled) {
        settled = true;
        if (timeout) clearTimeout(timeout);
        reject(error);
      }
    };
    server.once('error', (error) => {
      rejectCode(error);
    });
    timeout = setTimeout(() => {
      rejectCode(new Error('Timed out waiting for Composio OAuth callback.'));
    }, CALLBACK_TIMEOUT_MS);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
    server.listen(getOAuthPort(), '127.0.0.1');
  });

  return {
    server,
    waitForCode,
  };
};

export const loginComposio = async (): Promise<{ ok: boolean; toolkits?: string[]; error?: string }> => {
  const provider = new ComposioOAuthProvider();
  let server: Server | null = null;
  let client: Client | null = null;
  let verifiedClient: Client | null = null;

  try {
    const { enumerateConnectedToolkits } = await import('./mcp.js');
    const callback = await startCallbackServer(provider);
    server = callback.server;

    const created = await createMcpClient(provider);
    client = created.client;
    try {
      await client.connect(created.transport);
      const toolkits = await enumerateConnectedToolkits(client);
      return { ok: true, toolkits };
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
    }

    const code = await callback.waitForCode;
    await created.transport.finishAuth(code);
    await client.close().catch(() => {});
    client = null;

    const verified = await createMcpClient(provider);
    verifiedClient = verified.client;
    await verifiedClient.connect(verified.transport);
    const toolkits = await enumerateConnectedToolkits(verifiedClient);
    return { ok: true, toolkits };
  } catch (error) {
    return { ok: false, error: String((error as any)?.message || error) };
  } finally {
    if (client) await client.close().catch(() => {});
    if (verifiedClient) await verifiedClient.close().catch(() => {});
    await closeServer(server).catch(() => {});
  }
};

export const hasComposioOAuthTokens = async () => Boolean(await new ComposioOAuthProvider().tokens());
