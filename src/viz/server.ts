import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import {
  applyReviewDecisionsForViz,
  buildMeta,
  clearReviewDecisionForViz,
  getCounts,
  getProgress,
  getRecordDetail,
  getRejectedRecordsForViz,
  getRejectedSourcesForViz,
  getReviewQueueForViz,
  getTerritories,
  getTerritoryNotesForViz,
  insertTerritoryNoteForViz,
  queryRecords,
  restoreRejectedRecordForViz,
} from './data.js';
import { readConfig } from '../orchestrator/lib/config.js';
import { flattenPipelineSteps, stepSubpipelineName } from '../orchestrator/lib/subpipelines.js';
import { openListDb } from '../orchestrator/runtime/db.js';
import { completeManualTask, listAwaitingManualTasks } from '../orchestrator/pipeline/manual.js';
import { getSequenceBoard, listConfiguredSequences } from '../orchestrator/pipeline/sequences-board.js';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));
const uiDistDir = resolve(moduleDir, 'ui/dist');
const uiIndexPath = resolve(uiDistDir, 'index.html');

const apiErrorResponse = (c: Context, error: unknown) => {
  const message = String(error instanceof Error ? error.message : error);
  if (error instanceof AgentOutboundError && error.code === 'NOT_FOUND') {
    return c.json({ error: message }, 404);
  }
  if (error instanceof AgentOutboundError && error.code === 'INVALID_ARGUMENT') {
    return c.json({ error: message }, 400);
  }
  return c.json({ error: message }, 500);
};

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

  app.get('/api/territories', (c) => {
    try {
      return c.json(getTerritories(listDir));
    } catch (error) {
      return c.json({ error: String(error?.message || error) }, 500);
    }
  });

  app.get('/api/territories/:id/notes', (c) => {
    try {
      return c.json(getTerritoryNotesForViz(listDir, c.req.param('id')));
    } catch (error) {
      return c.json({ error: String(error?.message || error) }, 500);
    }
  });

  app.post('/api/territories/:id/notes', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      return c.json(insertTerritoryNoteForViz(
        listDir,
        c.req.param('id'),
        String(body?.body || ''),
        String(body?.by || ''),
      ));
    } catch (error) {
      return c.json({ error: String(error?.message || error) }, 500);
    }
  });

  app.get('/api/review/:stageId', (c) => {
    try {
      return c.json(getReviewQueueForViz(
        listDir,
        c.req.param('stageId'),
        Number(c.req.query('limit') || 100),
        Number(c.req.query('offset') || 0),
      ));
    } catch (error) {
      return apiErrorResponse(c, error);
    }
  });

  app.post('/api/review/:stageId/decisions', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      return c.json(applyReviewDecisionsForViz(
        listDir,
        c.req.param('stageId'),
        body?.decisions,
      ));
    } catch (error) {
      return apiErrorResponse(c, error);
    }
  });

  app.delete('/api/review/decisions/:rowId', (c) => {
    try {
      return c.json(clearReviewDecisionForViz(
        listDir,
        c.req.param('rowId'),
        String(c.req.query('stage') || ''),
      ));
    } catch (error) {
      return apiErrorResponse(c, error);
    }
  });

  app.get('/api/rejected/sources', (c) => {
    try {
      return c.json(getRejectedSourcesForViz(listDir));
    } catch (error) {
      return apiErrorResponse(c, error);
    }
  });

  app.get('/api/rejected', (c) => {
    try {
      return c.json(getRejectedRecordsForViz(
        listDir,
        String(c.req.query('source') || ''),
        Number(c.req.query('limit') || 100),
        Number(c.req.query('offset') || 0),
      ));
    } catch (error) {
      return apiErrorResponse(c, error);
    }
  });

  app.post('/api/rejected/:rowId/restore', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      return c.json(restoreRejectedRecordForViz(
        listDir,
        c.req.param('rowId'),
        String(body?.reason || ''),
      ));
    } catch (error) {
      return apiErrorResponse(c, error);
    }
  });

  app.get('/api/sequences', (c) => {
    try {
      const { config } = readConfig(listDir);
      const names = listConfiguredSequences({ config });
      const allSteps = flattenPipelineSteps(config);
      const sequences = names.map((name: string) => {
        const steps = allSteps.filter((step: any) => stepSubpipelineName(step) === name);
        const pipelineNode = ((config?.pipeline || []) as any[]).find((node: any) => (
          String(node?.kind) === 'pipeline' && String(node?.id || '') === name
        )) as { manual?: boolean; description?: string } | undefined;
        return {
          name,
          step_count: steps.length,
          manual: Boolean(pipelineNode?.manual),
          description: String(pipelineNode?.description || ''),
        };
      });
      return c.json({ ok: true, sequences });
    } catch (error: any) {
      return c.json({ ok: false, error: String(error?.message || error) }, 500);
    }
  });

  app.get('/api/sequences/:name/board', (c) => {
    try {
      const name = String(c.req.param('name') || '');
      const { config } = readConfig(listDir);
      const db = openListDb({ listDir, readonly: true });
      try {
        return c.json({ ok: true, board: getSequenceBoard({ db, config, sequence: name }) });
      } finally {
        db.close();
      }
    } catch (error: any) {
      return c.json({ ok: false, error: String(error?.message || error) }, 500);
    }
  });

  app.get('/api/manual', (c) => {
    try {
      const taskType = String(c.req.query('type') || '');
      const limit = Number(c.req.query('limit') || 100);
      const offset = Number(c.req.query('offset') || 0);
      const db = openListDb({ listDir, readonly: true });
      try {
        return c.json({ ok: true, ...listAwaitingManualTasks({ db, taskType, limit, offset }) });
      } finally {
        db.close();
      }
    } catch (error: any) {
      return c.json({ ok: false, error: String(error?.message || error) }, 500);
    }
  });

  app.post('/api/manual/:rowId/complete', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const rowId = String(c.req.param('rowId') || '');
      const stepId = String(body?.step_id || body?.step || '');
      const note = String(body?.note || '');
      const skip = Boolean(body?.skip);
      const { config } = readConfig(listDir);
      const db = openListDb({ listDir, readonly: false });
      try {
        const result = await completeManualTask({
          db,
          config,
          listDir,
          recordId: rowId,
          stepId,
          note,
          skip,
        });
        return c.json({
          ok: true,
          ...result,
        });
      } finally {
        db.close();
      }
    } catch (error: any) {
      return c.json({ ok: false, error: String(error?.message || error) }, 400);
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
    const missingUiHtml = '<!doctype html><html><head><meta charset="utf-8"><title>Agent Outbound Viz</title></head><body><h1>UI bundle is missing from dist/viz/ui/dist</h1><p>Build src/viz/ui, then run the root build to copy the bundle into dist.</p><pre>npm --prefix src/viz/ui run build &amp;&amp; npm run build</pre><p>The JSON API is available under /api.</p></body></html>';
    app.get('/', (c) => c.html(missingUiHtml));
    app.get('*', (c) => c.html(missingUiHtml));
  }

  const finalPort = await findFreePort(port);
  serve({ fetch: app.fetch, port: finalPort });
  const url = `http://localhost:${finalPort}`;
  process.stdout.write(`view server: ${url}\n`);
  if (open) openBrowser(url);
};
