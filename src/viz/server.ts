import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { buildMeta, getCounts, getProgress, getRecordDetail, queryRecords } from './data.js';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));
const uiDistDir = resolve(moduleDir, 'ui/dist');
const uiIndexPath = resolve(uiDistDir, 'index.html');

const isPortFree = (port: number) => new Promise<boolean>((resolvePort) => {
  const server = createServer();
  server.once('error', () => resolvePort(false));
  server.once('listening', () => {
    server.close(() => resolvePort(true));
  });
  server.listen(port, '127.0.0.1');
});

const findFreePort = async (requestedPort: number) => {
  const start = Number.isFinite(requestedPort) ? requestedPort : 7788;
  const candidates = Array.from({ length: 21 }, (_, index) => start + index);
  for (const port of candidates) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found from ${start} to ${start + 20}.`);
};

const openBrowser = (url: string) => {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
};

const parseRecordsQuery = (query: Record<string, string>) => {
  const mergedFilters = Object.entries(query).reduce((acc: any, [key, value]) => {
    if (!key.startsWith('filter.')) return acc;
    const raw = key.slice('filter.'.length);
    const rangeMatch = raw.match(/^(.+)\.(min|max)$/);
    if (rangeMatch) {
      acc[rangeMatch[1]] = { ...(acc[rangeMatch[1]] || {}), [rangeMatch[2]]: value };
      return acc;
    }
    acc[raw] = value;
    return acc;
  }, {});
  return {
    sort: query.sort,
    dir: query.dir,
    limit: query.limit,
    offset: query.offset,
    q: query.q,
    filters: mergedFilters,
  };
};

export const startViewServer = async ({ listDir, port, open }: { listDir: string; port: number; open: boolean }) => {
  const app = new Hono();
  const hasBuiltUi = existsSync(uiIndexPath);

  app.get('/api/meta', (c) => {
    try {
      return c.json(buildMeta(listDir));
    } catch (error) {
      return c.json({ error: String(error?.message || error) }, 500);
    }
  });

  app.get('/api/records', (c) => {
    try {
      return c.json(queryRecords(listDir, parseRecordsQuery(c.req.query())));
    } catch (error) {
      return c.json({ error: String(error?.message || error) }, 500);
    }
  });

  app.get('/api/records/:rowId', (c) => {
    try {
      return c.json(getRecordDetail(listDir, c.req.param('rowId')));
    } catch (error) {
      return c.json({ error: String(error?.message || error) }, 500);
    }
  });

  app.get('/api/progress', (c) => {
    try {
      return c.json(getProgress(listDir));
    } catch (error) {
      return c.json({ error: String(error?.message || error) }, 500);
    }
  });

  app.get('/api/stream', (c) => {
    return streamSSE(c, async (stream) => {
      const send = async () => {
        const payload = (() => {
          try {
            return { progress: getProgress(listDir).run, counts: getCounts(listDir) };
          } catch (error) {
            return { progress: null, counts: null, error: String((error as any)?.message || error) };
          }
        })();
        await stream.writeSSE({ event: 'tick', data: JSON.stringify(payload) });
      };
      await send();
      const aborted = { current: false };
      stream.onAbort(() => { aborted.current = true; });
      while (!aborted.current) {
        await stream.sleep(1000);
        if (aborted.current) break;
        await send();
      }
    });
  });

  if (hasBuiltUi) {
    const staticRoot = relative(process.cwd(), uiDistDir) || '.';
    app.use('/*', serveStatic({ root: staticRoot }));
    app.get('*', (c) => c.html(readFileSync(uiIndexPath, 'utf8')));
  } else {
    app.get('/', (c) => c.html('<!doctype html><html><head><meta charset="utf-8"><title>Agent Outbound Viz</title></head><body><h1>UI not built yet — run with --build</h1><p>The JSON API is available under /api.</p></body></html>'));
    app.get('*', (c) => c.html('<!doctype html><html><head><meta charset="utf-8"><title>Agent Outbound Viz</title></head><body><h1>UI not built yet — run with --build</h1><p>The JSON API is available under /api.</p></body></html>'));
  }

  const finalPort = await findFreePort(port);
  serve({ fetch: app.fetch, port: finalPort });
  const url = `http://localhost:${finalPort}`;
  process.stdout.write(`view server: ${url}\n`);
  if (open) openBrowser(url);
};
