import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { config } from './config.js';
import { getDb } from './db.js';
import { isEligible, isExcluded, isExcludedDir, removeDirectory, removeFile, scheduleFile, toRelative } from './files.js';
import { indexer } from './indexer.js';
import { errorMessage, log } from './log.js';
import { getSettings } from './settings.js';

export interface ScanStatus {
  running: boolean;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastDurationMs?: number;
  lastResult?: { seen: number; scheduled: number; removed: number };
  error?: string;
}

export interface WatcherStatus {
  running: boolean;
  backend: string;
  error?: string;
}

export const scanStatus: ScanStatus = { running: false };
export const watcherStatus: WatcherStatus = { running: false, backend: 'auto' };

let currentScan: Promise<void> | undefined;
let rescanRequested = false;

/**
 * Walks the documents folder and reconciles it with the database: new or
 * modified files (by size/mtime) are scheduled, rows for files that vanished
 * or became ineligible are deleted. Concurrent requests coalesce into one
 * follow-up scan.
 */
export function fullScan(): Promise<void> {
  if (currentScan) {
    rescanRequested = true;
    return currentScan;
  }
  currentScan = (async () => {
    do {
      rescanRequested = false;
      await runScan();
    } while (rescanRequested);
  })().finally(() => (currentScan = undefined));
  return currentScan;
}

async function runScan() {
  const started = Date.now();
  scanStatus.running = true;
  scanStatus.lastStartedAt = new Date(started).toISOString();
  scanStatus.error = undefined;
  const db = getDb();
  try {
    const known = new Map<string, { size: number; mtime: number }>();
    const rows = await db.query<{ path: string; size: number; mtime_ms: number }>('SELECT path, size, mtime_ms FROM files');
    for (const r of rows.rows) known.set(r.path, { size: Number(r.size), mtime: r.mtime_ms });

    const seen = new Set<string>();
    let scheduled = 0;

    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        log.warn(`Cannot read directory: ${errorMessage(err)}`, toRelative(dir) || '.');
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        const rel = toRelative(abs);
        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            const st = await fs.stat(abs);
            isDir = st.isDirectory();
            isFile = st.isFile();
          } catch {
            continue; // Broken link.
          }
        }
        if (isDir) {
          if (!isExcludedDir(rel) && !isExcluded(rel)) await walk(abs);
          continue;
        }
        if (!isFile || !isEligible(rel)) continue;
        let st;
        try {
          st = await fs.stat(abs);
        } catch {
          continue;
        }
        seen.add(rel);
        const prev = known.get(rel);
        if (!prev || prev.size !== st.size || prev.mtime !== st.mtimeMs) {
          await scheduleFile(rel, st.size, st.mtimeMs, 0);
          scheduled++;
        }
      }
    };
    await walk(config.docsDir);

    const gone = [...known.keys()].filter((p) => !seen.has(p));
    for (let i = 0; i < gone.length; i += 500) {
      await db.query('DELETE FROM files WHERE path = ANY($1::text[])', [gone.slice(i, i + 500)]);
    }
    scanStatus.lastResult = { seen: seen.size, scheduled, removed: gone.length };
    if (scheduled || gone.length) log.info(`Scan complete: ${seen.size} files, ${scheduled} scheduled, ${gone.length} removed`);
    indexer.wake();
  } catch (err) {
    scanStatus.error = errorMessage(err);
    log.error(`Scan failed: ${scanStatus.error}`);
  } finally {
    scanStatus.running = false;
    scanStatus.lastFinishedAt = new Date().toISOString();
    scanStatus.lastDurationMs = Date.now() - started;
  }
}

let watcher: FSWatcher | undefined;

export async function startWatcher() {
  await stopWatcher();
  const s = getSettings();
  const polling = s.watcherBackend === 'polling';
  watcherStatus.backend = polling ? `polling (${s.pollingIntervalMs} ms)` : 'native';
  watcherStatus.error = undefined;

  const w = chokidar.watch(config.docsDir, {
    ignoreInitial: true,
    ignorePermissionErrors: true,
    backend: polling ? 'polling' : 'auto',
    pollingInterval: s.pollingIntervalMs,
    pollingBinaryInterval: s.pollingIntervalMs,
    ignored: (p: string) => {
      const rel = toRelative(p);
      return rel !== '' && (isExcluded(rel) || isExcludedDir(rel));
    },
  });
  watcher = w;

  const onUpsert = async (abs: string) => {
    const rel = toRelative(abs);
    if (!isEligible(rel)) return;
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) return;
      await scheduleFile(rel, st.size, st.mtimeMs, getSettings().cooldownSeconds);
    } catch {
      // Vanished between event and stat; the unlink event will follow.
    }
  };

  w.on('add', (p) => void onUpsert(p).catch(reportError));
  w.on('change', (p) => void onUpsert(p).catch(reportError));
  w.on('unlink', (p) => {
    const rel = toRelative(p);
    void removeFile(rel).then((removed) => removed && log.info('Removed (file deleted)', rel)).catch(reportError);
  });
  w.on('unlinkDir', (p) => {
    const rel = toRelative(p);
    void removeDirectory(rel).then((n) => n && log.info(`Removed ${n} files (directory deleted)`, rel)).catch(reportError);
  });
  w.on('error', (err) => {
    watcherStatus.error = errorMessage(err);
    log.error(`Watcher error: ${watcherStatus.error}`);
  });
  await new Promise<void>((resolve) => w.once('ready', () => resolve()));
  watcherStatus.running = true;
  log.info(`Watching ${config.docsDir} (${watcherStatus.backend})`);
}

export async function stopWatcher() {
  if (!watcher) return;
  const w = watcher;
  watcher = undefined;
  watcherStatus.running = false;
  await w.close();
}

function reportError(err: unknown) {
  log.error(`Watcher event failed: ${errorMessage(err)}`);
}

let rescanTimer: NodeJS.Timeout | undefined;

/** (Re)arms the periodic safety-net rescan that catches events the watcher missed. */
export function scheduleRescans() {
  clearInterval(rescanTimer);
  const minutes = getSettings().rescanIntervalMinutes;
  if (minutes > 0) rescanTimer = setInterval(() => void fullScan(), minutes * 60_000);
}

export function stopRescans() {
  clearInterval(rescanTimer);
}
