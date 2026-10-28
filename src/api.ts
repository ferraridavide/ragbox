import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { ZodError } from 'zod';
import { config } from './config.js';
import { chunksTableExists, getDb } from './db.js';
import { folderChildren, listFiles, requeue, statusCounts } from './files.js';
import { indexer } from './indexer.js';
import { errorMessage, log, recentActivity } from './log.js';
import { supportedFormats } from './parsers/index.js';
import { fullScan, scanStatus, watcherStatus } from './scanner.js';
import { search } from './search.js';
import { DEFAULT_SETTINGS, getOverriddenKeys, getSettings, publicSettings, SECRET_KEYS, updateSettings } from './settings.js';

const startedAt = new Date().toISOString();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export function apiRouter(): Router {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));

  r.get('/status', wrap(async (_req, res) => {
    const db = getDb();
    const counts = await statusCounts();
    const chunks = (await chunksTableExists())
      ? (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM chunks')).rows[0].n
      : 0;
    const due = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM files WHERE status = 'pending' AND due_at <= now()");
    const lastIndexed = await db.query<{ at: Date | null }>('SELECT max(indexed_at) AS at FROM files');
    const s = getSettings();
    res.json({
      docsDir: config.docsDir,
      startedAt,
      files: counts,
      totalFiles: Object.values(counts).reduce((a, b) => a + b, 0),
      chunks,
      dueNow: due.rows[0].n,
      pipeline: { queued: due.rows[0].n, cooldown: counts.pending - due.rows[0].n, lastIndexedAt: lastIndexed.rows[0].at },
      cooldownSeconds: s.cooldownSeconds,
      worker: { paused: indexer.paused, ready: indexer.isReady, active: indexer.activeJobs, concurrency: s.concurrency },
      provider: { ...indexer.provider, kind: s.embeddingProvider, model: s.embeddingModel, url: s.embeddingUrl },
      scan: scanStatus,
      watcher: watcherStatus,
      mcp: { path: '/mcp', authRequired: !!config.mcpToken },
    });
  }));

  r.get('/files', wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json(await listFiles({
      status: typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined,
      q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined,
      sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
      limit,
      offset,
    }));
  }));

  r.get('/tree', wrap(async (req, res) => {
    const raw = req.query.dir;
    const dirs = (Array.isArray(raw) ? raw : [raw ?? '']).map(String).slice(0, 300);
    const filter = {
      status: typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined,
      q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined,
    };
    const out: Record<string, Awaited<ReturnType<typeof folderChildren>>> = {};
    for (const dir of dirs) {
      if (dir !== '' && !dir.endsWith('/')) return res.status(400).json({ error: 'dir must be empty or end with /' });
      out[dir] = await folderChildren(dir, filter);
    }
    res.json({ dirs: out });
  }));

  r.get('/files/chunks', wrap(async (req, res) => {
    const path = String(req.query.path ?? '');
    if (!(await chunksTableExists())) return res.json({ chunks: [] });
    const rows = await getDb().query('SELECT idx, content, metadata FROM chunks WHERE path = $1 ORDER BY idx LIMIT 500', [path]);
    res.json({ chunks: rows.rows });
  }));

  r.post('/files/reindex', wrap(async (req, res) => {
    const path = req.body?.path;
    if (typeof path !== 'string' || !path) return res.status(400).json({ error: 'path is required' });
    // A path ending in "/" re-indexes everything in that folder.
    const n = await requeue(path);
    if (n) log.info(path.endsWith('/') ? `Re-index of ${n} files requested` : 'Re-index requested', path);
    indexer.wake();
    res.json({ queued: n });
  }));

  r.post('/reindex', wrap(async (_req, res) => {
    const n = await requeue();
    log.info(`Re-index of all ${n} files requested`);
    indexer.wake();
    res.json({ queued: n });
  }));

  r.post('/retry-errors', wrap(async (_req, res) => {
    const result = await getDb().query(
      "UPDATE files SET status = 'pending', due_at = now(), gen = gen + 1, updated_at = now() WHERE status = 'error'",
    );
    indexer.wake();
    res.json({ queued: result.affectedRows ?? 0 });
  }));

  r.post('/rescan', wrap(async (_req, res) => {
    void fullScan();
    res.json({ started: true });
  }));

  r.post('/pause', wrap(async (req, res) => {
    indexer.paused = !!req.body?.paused;
    log.info(indexer.paused ? 'Indexing paused' : 'Indexing resumed');
    indexer.wake();
    res.json({ paused: indexer.paused });
  }));

  r.get('/activity', wrap(async (req, res) => {
    res.json({ entries: recentActivity(Number(req.query.after) || 0, 300) });
  }));

  r.get('/settings', wrap(async (_req, res) => {
    res.json({ settings: publicSettings(), defaults: publicSettings(DEFAULT_SETTINGS), overridden: getOverriddenKeys() });
  }));

  r.put('/settings', wrap(async (req, res) => {
    const patch: Record<string, unknown> = { ...(req.body ?? {}) };
    // The UI receives masked secrets; sending the mask back means "unchanged".
    for (const key of SECRET_KEYS) if (patch[key] === '********') delete patch[key];
    const { changed } = await updateSettings(patch);
    if (changed.length) log.info(`Settings updated: ${changed.join(', ')}`);
    res.json({ settings: publicSettings(), defaults: publicSettings(DEFAULT_SETTINGS), overridden: getOverriddenKeys(), changed });
  }));

  r.post('/provider/check', wrap(async (_req, res) => {
    res.json(await indexer.checkProvider());
  }));

  r.get('/formats', wrap(async (_req, res) => {
    res.json({ formats: supportedFormats(), disabled: getSettings().disabledExtensions });
  }));

  r.get('/search', wrap(async (req, res) => {
    const results = await search({
      query: String(req.query.q ?? ''),
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      pathPrefix: typeof req.query.path_prefix === 'string' && req.query.path_prefix ? req.query.path_prefix : undefined,
    });
    res.json({ results });
  }));

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    res.status(400).json({ error: errorMessage(err) });
  });
  return r;
}
