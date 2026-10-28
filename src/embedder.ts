import type { Settings } from './settings.js';

export class EmbeddingError extends Error {}

const TIMEOUT_MS = 120_000;

/** Embeds a batch of texts with the configured provider. Order of results matches input. */
export async function embed(texts: string[], s: Settings): Promise<number[][]> {
  if (texts.length === 0) return [];
  const base = s.embeddingUrl.replace(/\/+$/, '');
  if (s.embeddingProvider === 'ollama') {
    const body = await post(`${base}/api/embed`, { model: s.embeddingModel, input: texts, truncate: true }, s);
    const embeddings = (body as { embeddings?: number[][] }).embeddings;
    return validate(embeddings, texts.length);
  }
  // OpenAI-compatible API (OpenAI, LM Studio, vLLM, LiteLLM, llama.cpp server, ...).
  // The URL is expected to include the version prefix, e.g. https://api.openai.com/v1
  const body = await post(`${base}/embeddings`, { model: s.embeddingModel, input: texts }, s);
  const data = (body as { data?: { index: number; embedding: number[] }[] }).data;
  const sorted = data ? [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding) : undefined;
  return validate(sorted, texts.length);
}

async function post(url: string, payload: unknown, s: Settings): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (s.embeddingApiKey) headers.authorization = `Bearer ${s.embeddingApiKey}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
    throw new EmbeddingError(`Cannot reach embedding provider at ${url} (${err instanceof Error ? err.message : err}${cause})`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new EmbeddingError(`Embedding provider returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new EmbeddingError(`Embedding provider returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

function validate(embeddings: number[][] | undefined, expected: number): number[][] {
  if (!Array.isArray(embeddings) || embeddings.length !== expected) {
    throw new EmbeddingError(`Embedding provider returned ${embeddings?.length ?? 'no'} embeddings, expected ${expected}`);
  }
  const dims = embeddings[0]?.length;
  for (const e of embeddings) {
    if (!Array.isArray(e) || e.length !== dims || e.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
      throw new EmbeddingError('Embedding provider returned malformed vectors');
    }
  }
  return embeddings;
}

/** Embeds a probe string to discover the vector dimension and check connectivity. */
export async function probe(s: Settings): Promise<number> {
  const [v] = await embed(['ragbox dimension probe'], s);
  if (!v?.length) throw new EmbeddingError('Embedding provider returned an empty vector');
  return v.length;
}
