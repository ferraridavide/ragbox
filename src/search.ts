import { chunksTableExists, getDb, toVectorLiteral } from './db.js';
import { embed } from './embedder.js';
import { indexer } from './indexer.js';
import { getSettings } from './settings.js';
import { STOPWORDS } from './stopwords.js';

export interface SearchOptions {
  query: string;
  limit?: number;
  /** Only search files whose relative path starts with this prefix. */
  pathPrefix?: string;
}

export interface SearchResult {
  path: string;
  chunk: number;
  title?: string;
  section?: string;
  content: string;
  /** Cosine similarity between query and chunk (null if matched by keywords only). */
  similarity: number | null;
  /** Fused rank score (higher is better). */
  score: number;
}

const RRF_K = 60;

/**
 * Hybrid search: nearest neighbours on the embedding plus full-text keyword
 * matching, merged with reciprocal rank fusion. Keyword matching is skipped
 * when `hybridSearch` is disabled.
 */
export async function search(opts: SearchOptions): Promise<SearchResult[]> {
  const s = getSettings();
  const query = opts.query.trim();
  if (!query) return [];
  if (!indexer.isReady || !(await chunksTableExists())) {
    throw new Error('The index is not ready yet (embedding provider unavailable or index being rebuilt)');
  }
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? s.defaultSearchLimit), 1), 50);
  const candidates = Math.max(limit * 4, 40);
  const [vector] = await embed([`${s.queryPrefix}${query}`], s);
  if (indexer.embeddingDims && vector.length !== indexer.embeddingDims) {
    throw new Error(`Query embedding has ${vector.length} dimensions, index expects ${indexer.embeddingDims}`);
  }

  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])]
    .filter((t) => !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)))
    .slice(0, 32);
  const tsquery = s.hybridSearch && terms.length ? terms.join(' | ') : null;
  const prefix = opts.pathPrefix ? opts.pathPrefix.replace(/^\.?\/+/, '').replace(/[\\%_]/g, '\\$&') + '%' : null;

  const db = getDb();
  return db.transaction(async (tx) => {
    // More candidates from the HNSW index improves recall, especially with a path filter.
    await tx.exec(`SET LOCAL hnsw.ef_search = ${Math.min(Math.max(candidates, 40), 1000)}`);
    const res = await tx.query<{
      path: string; idx: number; content: string; metadata: { title?: string; section?: string } | null;
      similarity: number | null; score: number;
    }>(
      `WITH vec AS (
         SELECT id, distance, row_number() OVER (ORDER BY distance) AS rank FROM (
           SELECT id, embedding <=> $1::vector AS distance FROM chunks
           WHERE ($3::text IS NULL OR path LIKE $3)
           ORDER BY embedding <=> $1::vector LIMIT $2
         ) v
       ),
       kw AS (
         SELECT id, row_number() OVER (ORDER BY rank DESC) AS rank FROM (
           SELECT id, ts_rank_cd(tsv, q) AS rank FROM chunks, to_tsquery('simple', $4) q
           WHERE $4::text IS NOT NULL AND tsv @@ q AND ($3::text IS NULL OR path LIKE $3)
           ORDER BY rank DESC LIMIT $2
         ) k
       )
       SELECT c.path, c.idx, c.content, c.metadata,
              1 - vec.distance AS similarity,
              COALESCE(1.0 / (${RRF_K} + vec.rank), 0) + COALESCE(1.0 / (${RRF_K} + kw.rank), 0) AS score
       FROM vec FULL OUTER JOIN kw ON vec.id = kw.id
       JOIN chunks c ON c.id = COALESCE(vec.id, kw.id)
       ORDER BY score DESC, similarity DESC NULLS LAST
       LIMIT $5`,
      [toVectorLiteral(vector), candidates, prefix, tsquery, limit],
    );
    return res.rows.map((r) => ({
      path: r.path,
      chunk: r.idx,
      title: r.metadata?.title,
      section: r.metadata?.section,
      content: r.content,
      similarity: r.similarity === null ? null : Number(r.similarity),
      score: Number(r.score),
    }));
  });
}
