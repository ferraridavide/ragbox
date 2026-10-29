import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chunkMarkdown, chunkText, type Chunk } from './chunker.js';
import { chunksTableExists, getDb, getMeta, recreateChunksTable, setMeta, toVectorLiteral } from './db.js';
import { embed, EmbeddingError, probe, type EmbeddingInput, type Modality } from './embedder.js';
import { isEligible, removeFile, requeue, toAbsolute, type FileRow } from './files.js';
import { errorMessage, log } from './log.js';
import { PARSER_VERSION, parserFor, type MediaSegment } from './parsers/index.js';
import { CHUNKING_KEYS, EMBEDDING_KEYS, getSettings, type SettingKey, type Settings } from './settings.js';

const TICK_MS = 1000;
const PROVIDER_RETRY_MS = 15_000;
const EMBED_RETRY_SECONDS = 30;
const INSERT_BATCH = 100;
// Upper bound on the media bytes sent in one embedding request.
const MEDIA_BATCH_BYTES = 8 * 1024 * 1024;

export interface ProviderStatus {
  ok: boolean;
  dims?: number;
  /** Input types the model accepts; media files are skipped when theirs is missing. */
  modalities?: Modality[];
  error?: string;
  checkedAt?: string;
}

interface Job {
  path: string;
  gen: number;
  hash: string | null;
}

/**
 * Background worker that turns pending files into chunks + embeddings.
 *
 * Files are picked up once their `due_at` has passed; `due_at` is pushed back
 * on every change (the cool-down), and a file whose mtime is still within the
 * cool-down window is re-scheduled instead of processed.
 */
export class Indexer {
  private running = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private ticking = false;
  /** Bumped whenever the chunks table is reset; in-flight jobs from an older generation discard their results. */
  private indexGen = 0;
  private ready = false;
  private preparing?: Promise<void>;
  private nextProviderCheck = 0;

  paused = false;
  provider: ProviderStatus = { ok: false, error: 'Not checked yet' };
  embeddingDims?: number;

  start() {
    this.stopped = false;
    this.schedule(0);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await Promise.allSettled(this.running.values());
  }

  wake() {
    this.schedule(0);
  }

  get activeJobs(): string[] {
    return [...this.running.keys()];
  }

  get isReady() {
    return this.ready;
  }

  /** Called by the settings listener. */
  async onSettingsChanged(changed: Set<SettingKey>) {
    if (EMBEDDING_KEYS.some((k) => changed.has(k))) {
      log.info('Embedding settings changed: index will be rebuilt');
      this.ready = false;
      this.provider = { ok: false, error: 'Re-checking provider after settings change' };
      this.nextProviderCheck = 0;
    } else if (changed.has('embeddingUrl') || changed.has('embeddingApiKey')) {
      this.provider = { ok: false, error: 'Re-checking provider after settings change' };
      this.nextProviderCheck = 0;
    }
    if (CHUNKING_KEYS.some((k) => changed.has(k)) && this.ready) {
      log.info('Chunking settings changed: re-indexing all files');
      this.indexGen++;
      await this.saveChunkSignature();
      await requeue();
    }
    this.wake();
  }

  /** Probes the provider right away (used by the UI "Test" button). */
  async checkProvider(): Promise<ProviderStatus> {
    try {
      const { dims, modalities } = await probe(getSettings());
      this.provider = { ok: true, dims, modalities, checkedAt: new Date().toISOString() };
      if (this.embeddingDims && dims !== this.embeddingDims) {
        log.warn(`Embedding dimension changed from ${this.embeddingDims} to ${dims}: index will be rebuilt`);
        this.ready = false;
      }
    } catch (err) {
      this.provider = { ok: false, error: errorMessage(err), checkedAt: new Date().toISOString() };
    }
    this.nextProviderCheck = Date.now() + PROVIDER_RETRY_MS;
    this.wake();
    return this.provider;
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.step();
    } catch (err) {
      log.error(`Worker error: ${errorMessage(err)}`);
    } finally {
      this.ticking = false;
      this.schedule(TICK_MS);
    }
  }

  private async step() {
    if (!this.provider.ok) {
      if (Date.now() < this.nextProviderCheck) return;
      const previousError = this.provider.error;
      const status = await this.checkProvider();
      if (!status.ok) {
        if (status.error !== previousError) log.warn(`Embedding provider unavailable: ${status.error}`);
        return;
      }
      log.info(`Embedding provider OK (${getSettings().embeddingModel}, ${status.dims} dimensions)`);
    }
    if (!this.ready) {
      this.preparing ??= this.prepareIndex().finally(() => (this.preparing = undefined));
      await this.preparing;
      if (!this.ready) return;
    }
    if (this.paused) return;

    const free = getSettings().concurrency - this.running.size;
    if (free <= 0) return;
    const db = getDb();
    const claimed = await db.query<Job>(
      `UPDATE files SET status = 'processing', updated_at = now()
       WHERE path IN (
         SELECT path FROM files
         WHERE status = 'pending' AND due_at <= now() AND NOT (path = ANY($2::text[]))
         ORDER BY due_at, path LIMIT $1
       )
       RETURNING path, gen, hash`,
      [free, [...this.running.keys()]],
    );
    for (const job of claimed.rows) {
      const promise = this.process(job).finally(() => {
        this.running.delete(job.path);
        this.wake();
      });
      this.running.set(job.path, promise);
    }
  }

  /**
   * Makes sure the chunks table matches the current embedding model and
   * chunking settings, rebuilding/re-queueing when they changed.
   */
  private async prepareIndex() {
    const s = getSettings();
    const dims = this.provider.dims!;
    const embeddingSig = JSON.stringify({ provider: s.embeddingProvider, model: s.embeddingModel, documentPrefix: s.documentPrefix, dims });
    const storedSig = await getMeta('embedding_signature');
    if (!(await chunksTableExists()) || storedSig !== embeddingSig) {
      this.indexGen++;
      // Wait for in-flight jobs so they don't write into the new table with stale vectors.
      await Promise.allSettled(this.running.values());
      if (storedSig) log.info('Embedding model or prefix changed: rebuilding index');
      await recreateChunksTable(dims);
      await setMeta('embedding_signature', embeddingSig);
      await this.saveChunkSignature();
      await requeue();
    } else if ((await getMeta('chunk_signature')) !== this.chunkSignature(s)) {
      log.info('Chunking or parser version changed: re-indexing all files');
      this.indexGen++;
      await this.saveChunkSignature();
      await requeue();
    }
    this.embeddingDims = dims;
    this.ready = true;
  }

  private chunkSignature(s: Settings) {
    return JSON.stringify({ chunkSize: s.chunkSize, chunkOverlap: s.chunkOverlap, parserVersion: PARSER_VERSION });
  }

  private async saveChunkSignature() {
    await setMeta('chunk_signature', this.chunkSignature(getSettings()));
  }

  private async process(job: Job) {
    const started = Date.now();
    const s = getSettings();
    const db = getDb();
    const abs = toAbsolute(job.path);
    const gen = this.indexGen;

    try {
      if (!isEligible(job.path)) {
        await removeFile(job.path);
        return;
      }
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        await removeFile(job.path);
        log.info('Removed (file no longer exists)', job.path);
        return;
      }
      if (!stat.isFile()) {
        await removeFile(job.path);
        return;
      }

      // Cool-down: wait until the file has been quiet for `cooldownSeconds`.
      const quietFor = Date.now() - stat.mtimeMs;
      const cooldownMs = s.cooldownSeconds * 1000;
      if (quietFor >= 0 && quietFor < cooldownMs) {
        await db.query(
          `UPDATE files SET status = 'pending', due_at = now() + make_interval(secs => $2), size = $3, mtime_ms = $4
           WHERE path = $1 AND gen = $5`,
          [job.path, (cooldownMs - quietFor) / 1000, stat.size, stat.mtimeMs, job.gen],
        );
        return;
      }

      if (stat.size > s.maxFileSizeMb * 1024 * 1024) {
        await this.finish(job, { status: 'skipped', error: `File exceeds the ${s.maxFileSizeMb} MB size limit`, size: stat.size, mtimeMs: stat.mtimeMs });
        return;
      }

      const buffer = await fs.readFile(abs);
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (job.hash === hash) {
        // Touched but content unchanged: nothing to re-embed. (A hash is only
        // stored after a successful indexing, so this never hides an error.)
        await this.finish(job, { status: 'indexed', size: stat.size, mtimeMs: stat.mtimeMs, hash, keepChunks: true });
        return;
      }

      const parser = parserFor(job.path, s.disabledExtensions)!;
      const name = path.posix.basename(job.path);
      const parsed = await parser.parse({ buffer, path: job.path, name, ext: path.extname(name).toLowerCase() });
      const skip = (error: string) =>
        this.finish(job, { status: 'skipped', error, size: stat.size, mtimeMs: stat.mtimeMs, parser: parser.id, metadata: parsed.metadata });
      if (parsed.skip) return await skip(parsed.skip);
      const media = parsed.media;
      const unsupported = media?.find((m) => !this.provider.modalities?.includes(m.kind));
      if (unsupported) {
        return await skip(`The embedding model ${s.embeddingModel} does not accept ${unsupported.kind === 'image' ? 'images' : 'audio'}`);
      }
      const text = parsed.text.replace(/\u0000/g, '');
      if (!media && !text.trim()) return await skip('No extractable text');

      const title = parsed.title || name;
      let chunks: Chunk[];
      let inputs: EmbeddingInput[];
      if (media) {
        chunks = media.map((m, index) => ({ index, content: m.content, section: m.section }));
        inputs = media.map((m) => mediaInput(s, job.path, m));
      } else {
        chunks = parsed.structure === 'markdown' ? chunkMarkdown(text, s) : chunkText(text, s);
        inputs = chunks.map((c) => embeddingInput(s, job.path, title, c));
      }
      const vectors: number[][] = [];
      for (const batch of batches(inputs, s.embeddingBatchSize)) {
        if (gen !== this.indexGen) return; // Index was reset: requeue handled by the reset.
        vectors.push(...(await embed(batch, s)));
      }

      await db.transaction(async (tx) => {
        if (gen !== this.indexGen) return;
        const row = await tx.query<{ gen: number }>('SELECT gen FROM files WHERE path = $1', [job.path]);
        if (!row.rows.length) return; // Deleted meanwhile.
        await tx.query('DELETE FROM chunks WHERE path = $1', [job.path]);
        for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
          const params: unknown[] = [];
          const values: string[] = [];
          for (let j = i; j < Math.min(i + INSERT_BATCH, chunks.length); j++) {
            const c = chunks[j];
            params.push(job.path, c.index, c.content, JSON.stringify({ title, section: c.section }), toVectorLiteral(vectors[j]));
            const b = params.length - 4;
            values.push(`($${b}, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
          }
          await tx.query(`INSERT INTO chunks (path, idx, content, metadata, embedding) VALUES ${values.join(',')}`, params);
        }
        await tx.query(
          `UPDATE files SET
             status = CASE WHEN gen = $2 THEN 'indexed' ELSE 'pending' END,
             error = NULL, attempts = 0, hash = $3, size = $4, mtime_ms = $5, parser = $6, metadata = $7,
             chunk_count = $8, duration_ms = $9, indexed_at = now(), updated_at = now()
           WHERE path = $1`,
          [job.path, job.gen, hash, stat.size, stat.mtimeMs, parser.id, JSON.stringify({ title, ...parsed.metadata }), chunks.length, Date.now() - started],
        );
      });
      log.info(`Indexed ${chunks.length} chunk${chunks.length === 1 ? '' : 's'} in ${Date.now() - started} ms`, job.path);
    } catch (err) {
      if (err instanceof EmbeddingError) {
        // Provider problem, not a file problem: retry later without counting it against the file.
        if (this.provider.ok) log.warn(`Embedding failed, pausing until the provider recovers: ${err.message}`, job.path);
        this.provider = { ok: false, error: err.message, checkedAt: new Date().toISOString() };
        this.nextProviderCheck = Date.now() + PROVIDER_RETRY_MS;
        await db.query(
          `UPDATE files SET status = 'pending', due_at = now() + make_interval(secs => $2), updated_at = now() WHERE path = $1 AND status = 'processing'`,
          [job.path, EMBED_RETRY_SECONDS],
        );
        return;
      }
      const message = errorMessage(err);
      log.error(message, job.path);
      await db.transaction(async (tx) => {
        await tx.query('DELETE FROM chunks WHERE path = $1', [job.path]);
        await tx.query(
          `UPDATE files SET status = CASE WHEN gen = $2 THEN 'error' ELSE 'pending' END, error = $3, hash = NULL,
             chunk_count = 0, attempts = attempts + 1, duration_ms = $4, updated_at = now()
           WHERE path = $1`,
          [job.path, job.gen, message.slice(0, 2000), Date.now() - started],
        );
      });
    }
  }

  private async finish(job: Job, r: { status: 'indexed' | 'skipped'; size: number; mtimeMs: number; error?: string; hash?: string; parser?: string; metadata?: Record<string, unknown>; keepChunks?: boolean }) {
    const db = getDb();
    await db.transaction(async (tx) => {
      if (!r.keepChunks) await tx.query('DELETE FROM chunks WHERE path = $1', [job.path]);
      await tx.query(
        `UPDATE files SET status = CASE WHEN gen = $2 THEN $3 ELSE 'pending' END, error = $4, hash = $5, size = $6, mtime_ms = $7,
           parser = COALESCE($8, parser), metadata = COALESCE($9, metadata),
           chunk_count = CASE WHEN $10 THEN chunk_count ELSE 0 END, updated_at = now()
         WHERE path = $1`,
        [job.path, job.gen, r.status, r.error ?? null, r.hash ?? null, r.size, r.mtimeMs, r.parser ?? null, r.metadata ? JSON.stringify(r.metadata) : null, !!r.keepChunks],
      );
    });
    if (r.status === 'skipped') log.warn(`Skipped: ${r.error}`, job.path);
  }
}

/** Text sent to the embedding model for a chunk: file context + chunk content. */
function embeddingInput(s: Settings, filePath: string, title: string, chunk: Chunk): string {
  const header = [`File: ${filePath}`];
  if (title && title !== path.posix.basename(filePath)) header.push(`Title: ${title}`);
  if (chunk.section && !chunk.content.startsWith(chunk.section)) header.push(`Section: ${chunk.section.replace(/^#+\s*/, '')}`);
  return `${s.documentPrefix}${header.join('\n')}\n\n${chunk.content}`;
}

/** Image or audio sent to a multimodal model, with the file path as text context. */
function mediaInput(s: Settings, filePath: string, m: MediaSegment): EmbeddingInput {
  return { text: `${s.documentPrefix}File: ${filePath}`, [m.kind]: m.data.toString('base64') };
}

/** Splits inputs into requests of at most `size` items and, for media, about MEDIA_BATCH_BYTES. */
function* batches(inputs: EmbeddingInput[], size: number): Generator<EmbeddingInput[]> {
  let batch: EmbeddingInput[] = [];
  let bytes = 0;
  for (const input of inputs) {
    const inputBytes = typeof input === 'string' ? 0 : (input.image?.length ?? 0) + (input.audio?.length ?? 0);
    if (batch.length && (batch.length >= size || bytes + inputBytes > MEDIA_BATCH_BYTES)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(input);
    bytes += inputBytes;
  }
  if (batch.length) yield batch;
}

export const indexer = new Indexer();

export type { FileRow };
