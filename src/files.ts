import path from 'node:path';
import picomatch from 'picomatch';
import { config } from './config.js';
import { getDb } from './db.js';
import { parserFor } from './parsers/index.js';
import { getSettings } from './settings.js';

export type FileStatus = 'pending' | 'processing' | 'indexed' | 'error' | 'skipped';

export interface FileRow {
  path: string;
  size: number;
  mtime_ms: number;
  hash: string | null;
  status: FileStatus;
  error: string | null;
  parser: string | null;
  metadata: Record<string, unknown> | null;
  chunk_count: number;
  attempts: number;
  gen: number;
  duration_ms: number | null;
  due_at: Date;
  indexed_at: Date | null;
  updated_at: Date;
}

/** Path relative to the documents root with forward slashes. */
export function toRelative(absPath: string): string {
  return path.relative(config.docsDir, absPath).split(path.sep).join('/');
}

export function toAbsolute(rel: string): string {
  return path.join(config.docsDir, ...rel.split('/'));
}

let matcherKey = '';
let matcher: (p: string) => boolean = () => false;

function excludeMatcher() {
  const patterns = getSettings().excludePatterns;
  const key = JSON.stringify(patterns);
  if (key !== matcherKey) {
    matcher = patterns.length ? picomatch(patterns, { dot: true }) : () => false;
    matcherKey = key;
  }
  return matcher;
}

export function isExcluded(rel: string): boolean {
  return excludeMatcher()(rel);
}

/** True if everything under directory `rel` is excluded (e.g. `** /node_modules/**`). */
export function isExcludedDir(rel: string): boolean {
  return rel !== '' && excludeMatcher()(`${rel}/\u0000`);
}

/** Whether a file at `rel` should be indexed given the current settings. */
export function isEligible(rel: string): boolean {
  if (!rel || rel.startsWith('..')) return false;
  if (isExcluded(rel)) return false;
  return parserFor(rel, getSettings().disabledExtensions) !== undefined;
}

/** Marks a file as pending, due after `delaySeconds`, creating the row if needed. */
export async function scheduleFile(rel: string, size: number, mtimeMs: number, delaySeconds: number) {
  await getDb().query(
    `INSERT INTO files (path, size, mtime_ms, status, due_at)
     VALUES ($1, $2, $3, 'pending', now() + make_interval(secs => $4))
     ON CONFLICT (path) DO UPDATE SET
       size = EXCLUDED.size,
       mtime_ms = EXCLUDED.mtime_ms,
       status = 'pending',
       due_at = EXCLUDED.due_at,
       gen = files.gen + 1,
       updated_at = now()`,
    [rel, size, mtimeMs, delaySeconds],
  );
}

export async function removeFile(rel: string): Promise<boolean> {
  const res = await getDb().query('DELETE FROM files WHERE path = $1', [rel]);
  return (res.affectedRows ?? 0) > 0;
}

export async function removeDirectory(rel: string): Promise<number> {
  const prefix = likePrefix(`${rel}/`);
  const res = await getDb().query('DELETE FROM files WHERE path LIKE $1', [prefix]);
  return res.affectedRows ?? 0;
}

/** Forces re-indexing (bypassing the unchanged-content check) of one file, a folder (`dir/`), or all files. */
export async function requeue(rel?: string): Promise<number> {
  const target = !rel ? '' : rel.endsWith('/') ? 'WHERE path LIKE $1' : 'WHERE path = $1';
  const param = rel?.endsWith('/') ? likePrefix(rel) : rel;
  const res = await getDb().query(
    `UPDATE files SET hash = NULL, status = 'pending', due_at = now(), gen = gen + 1, attempts = 0, updated_at = now() ${target}`,
    rel ? [param] : [],
  );
  return res.affectedRows ?? 0;
}

function likePrefix(prefix: string) {
  return prefix.replace(/[\\%_]/g, '\\$&') + '%';
}

export async function statusCounts(): Promise<Record<FileStatus, number>> {
  const res = await getDb().query<{ status: FileStatus; n: number }>('SELECT status, count(*)::int AS n FROM files GROUP BY status');
  const counts: Record<FileStatus, number> = { pending: 0, processing: 0, indexed: 0, error: 0, skipped: 0 };
  for (const row of res.rows) counts[row.status] = row.n;
  return counts;
}

export interface FileFilter {
  /** A file status, or `cooldown` / `queued` (pending files not yet due / due now). */
  status?: string;
  /** Case-insensitive substring of the path. */
  q?: string;
}

function filterClause(f: FileFilter, params: unknown[]): string[] {
  const where: string[] = [];
  if (f.status === 'cooldown') where.push(`status = 'pending' AND due_at > now()`);
  else if (f.status === 'queued') where.push(`status = 'pending' AND due_at <= now()`);
  else if (f.status) {
    params.push(f.status);
    where.push(`status = $${params.length}`);
  }
  if (f.q) {
    params.push(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`path ILIKE $${params.length}`);
  }
  return where;
}

const FILE_COLUMNS = 'path, size, mtime_ms, status, error, parser, metadata, chunk_count, attempts, duration_ms, due_at, indexed_at, updated_at';

export async function listFiles(opts: FileFilter & { limit: number; offset: number; sort?: string }) {
  const params: unknown[] = [];
  const where = filterClause(opts, params);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = opts.sort === 'path' ? 'path ASC' : 'updated_at DESC, path ASC';
  const db = getDb();
  const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM files ${clause}`, params);
  params.push(opts.limit, opts.offset);
  const rows = await db.query<FileRow>(
    `SELECT ${FILE_COLUMNS} FROM files ${clause} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { total: total.rows[0].n, files: rows.rows };
}

export interface FolderSummary {
  path: string;
  name: string;
  files: number;
  indexed: number;
  cooldown: number;
  queued: number;
  processing: number;
  error: number;
  skipped: number;
  chunks: number;
  size: number;
  updated_at: Date | null;
}

const TREE_FILE_LIMIT = 500;

/**
 * Immediate children of a folder (`''` for the root, otherwise `a/b/`):
 * sub-folders with aggregated status counts over everything they contain, and
 * the files directly inside it. Only files matching the filter are counted.
 */
export async function folderChildren(dir: string, filter: FileFilter) {
  const db = getDb();
  const params: unknown[] = [likePrefix(dir), dir.length + 1];
  const where = ['path LIKE $1', ...filterClause(filter, params)].join(' AND ');
  const rest = 'substr(path, $2)';
  const folders = await db.query<FolderSummary>(
    `SELECT split_part(${rest}, '/', 1) AS name,
            count(*)::int AS files,
            count(*) FILTER (WHERE status = 'indexed')::int AS indexed,
            count(*) FILTER (WHERE status = 'pending' AND due_at > now())::int AS cooldown,
            count(*) FILTER (WHERE status = 'pending' AND due_at <= now())::int AS queued,
            count(*) FILTER (WHERE status = 'processing')::int AS processing,
            count(*) FILTER (WHERE status = 'error')::int AS error,
            count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
            sum(chunk_count)::int AS chunks,
            sum(size)::float8 AS size,
            max(updated_at) AS updated_at
     FROM files WHERE ${where} AND position('/' in ${rest}) > 0
     GROUP BY 1 ORDER BY lower(split_part(${rest}, '/', 1))`,
    params,
  );
  const fileWhere = `${where} AND position('/' in ${rest}) = 0`;
  const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM files WHERE ${fileWhere}`, params);
  const files = await db.query<FileRow>(
    `SELECT ${FILE_COLUMNS} FROM files WHERE ${fileWhere} ORDER BY lower(path) LIMIT ${TREE_FILE_LIMIT}`,
    params,
  );
  return {
    folders: folders.rows.map((f) => ({ ...f, path: `${dir}${f.name}/` })),
    files: files.rows,
    totalFiles: total.rows[0].n,
  };
}
