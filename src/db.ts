import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { config } from './config.js';

export type Db = PGlite;

let db: PGlite | undefined;

export function getDb(): PGlite {
  if (!db) throw new Error('Database not initialised');
  return db;
}

export async function openDb(): Promise<PGlite> {
  const dir = path.join(config.dataDir, 'pgdata');
  fs.mkdirSync(dir, { recursive: true });
  db = new PGlite(dir, { extensions: { vector } });
  await db.waitReady;
  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS settings (
      key   text PRIMARY KEY,
      value jsonb NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   text PRIMARY KEY,
      value text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      path        text PRIMARY KEY,
      size        bigint NOT NULL DEFAULT 0,
      mtime_ms    double precision NOT NULL DEFAULT 0,
      hash        text,
      status      text NOT NULL DEFAULT 'pending',
      error       text,
      parser      text,
      metadata    jsonb,
      chunk_count integer NOT NULL DEFAULT 0,
      attempts    integer NOT NULL DEFAULT 0,
      -- Bumped every time the file is (re)scheduled; lets an in-flight job
      -- detect that the file changed while it was being processed.
      gen         integer NOT NULL DEFAULT 0,
      duration_ms integer,
      due_at      timestamptz NOT NULL DEFAULT now(),
      indexed_at  timestamptz,
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS files_status_due_idx ON files (status, due_at);
  `);
  return db;
}

export async function closeDb() {
  if (db) await db.close();
  db = undefined;
}

export async function getMeta(key: string): Promise<string | undefined> {
  const res = await getDb().query<{ value: string }>('SELECT value FROM meta WHERE key = $1', [key]);
  return res.rows[0]?.value;
}

export async function setMeta(key: string, value: string) {
  await getDb().query(
    'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value],
  );
}

export async function chunksTableExists(): Promise<boolean> {
  const res = await getDb().query<{ exists: boolean }>("SELECT to_regclass('public.chunks') IS NOT NULL AS exists");
  return res.rows[0].exists;
}

/** (Re)creates the chunks table for the given embedding dimension, dropping existing data. */
export async function recreateChunksTable(dims: number) {
  if (!Number.isInteger(dims) || dims <= 0 || dims > 16000) throw new Error(`Invalid embedding dimension: ${dims}`);
  // HNSW indexes on the vector type support up to 2000 dimensions.
  const hnsw = dims <= 2000
    ? 'CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);'
    : '';
  await getDb().exec(`
    DROP TABLE IF EXISTS chunks;
    CREATE TABLE chunks (
      id        bigserial PRIMARY KEY,
      path      text NOT NULL REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
      idx       integer NOT NULL,
      content   text NOT NULL,
      metadata  jsonb,
      embedding vector(${dims}) NOT NULL,
      tsv       tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
    );
    CREATE INDEX chunks_path_idx ON chunks (path);
    CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);
    ${hnsw}
  `);
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}
