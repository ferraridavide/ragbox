import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { apiRouter } from './api.js';
import { config } from './config.js';
import { closeDb, getDb, openDb } from './db.js';
import { indexer } from './indexer.js';
import { errorMessage, log } from './log.js';
import { mcpRouter } from './mcp.js';
import { fullScan, scheduleRescans, startWatcher, stopRescans, stopWatcher } from './scanner.js';
import { FILTER_KEYS, loadSettings, onSettingsChange, WATCHER_KEYS } from './settings.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

async function main() {
  if (!fs.existsSync(config.docsDir) || !fs.statSync(config.docsDir).isDirectory()) {
    throw new Error(`Documents folder ${config.docsDir} does not exist (mount it at ${config.docsDir} or set RAGBOX_DOCS_DIR)`);
  }
  await openDb();
  await loadSettings();
  // Jobs interrupted by a restart go back to the queue.
  await getDb().query("UPDATE files SET status = 'pending', due_at = now() WHERE status = 'processing'");

  onSettingsChange(async (_next, _prev, changed) => {
    await indexer.onSettingsChanged(changed);
    if (WATCHER_KEYS.some((k) => changed.has(k))) await startWatcher();
    if (changed.has('rescanIntervalMinutes')) scheduleRescans();
    if (FILTER_KEYS.some((k) => changed.has(k))) void fullScan();
  });

  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/mcp', mcpRouter());
  app.use('/api', apiRouter());
  app.use(express.static(publicDir));

  const server = app.listen(config.port, config.host, () => {
    log.info(`ragbox listening on http://${config.host}:${config.port} (UI at /, MCP at /mcp)`);
  });

  indexer.start();
  await startWatcher();
  void fullScan();
  scheduleRescans();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down`);
    stopRescans();
    server.close();
    await stopWatcher();
    await indexer.stop();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error(`Fatal: ${errorMessage(err)}`);
  process.exit(1);
});
