import type { MediaKind } from './parsers/index.js';
import type { Settings } from './settings.js';

/** Provider unreachable or misbehaving: indexing pauses until it recovers. */
export class EmbeddingError extends Error {}

/** The provider refused a file's image or audio: a problem with the file, not the provider. */
export class MediaRejectedError extends Error {}

const TIMEOUT_MS = 120_000;

/** Text, or text plus image/audio bytes (base64) for multimodal models. */
export type EmbeddingInput = string | { text?: string; image?: string; audio?: string };

export type Modality = 'text' | MediaKind;

/** Embeds a batch of inputs with the configured provider. Order of results matches input. */
export async function embed(inputs: EmbeddingInput[], s: Settings): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const base = s.embeddingUrl.replace(/\/+$/, '');
  const hasMedia = inputs.some((i) => typeof i !== 'string');
  if (s.embeddingProvider === 'ollama') {
    const body = await post(`${base}/api/embed`, { model: s.embeddingModel, input: inputs, truncate: true }, s, hasMedia);
    const embeddings = (body as { embeddings?: number[][] }).embeddings;
    return validate(embeddings, inputs.length);
  }
  if (hasMedia) throw new MediaRejectedError('Images and audio can only be embedded with the Ollama provider');
  // OpenAI-compatible API (OpenAI, LM Studio, vLLM, LiteLLM, llama.cpp server, ...).
  // The URL is expected to include the version prefix, e.g. https://api.openai.com/v1
  const body = await post(`${base}/embeddings`, { model: s.embeddingModel, input: inputs }, s, false);
  const data = (body as { data?: { index: number; embedding: number[] }[] }).data;
  const sorted = data ? [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding) : undefined;
  return validate(sorted, inputs.length);
}

async function post(url: string, payload: unknown, s: Settings, hasMedia = false): Promise<unknown> {
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
    // Ollama answers 400/413 when it can't decode the media or it exceeds the context;
    // auth, missing model and rate limiting are still provider problems.
    if (hasMedia && (res.status === 400 || res.status === 413 || res.status === 422)) {
      throw new MediaRejectedError(`Embedding provider rejected the file (HTTP ${res.status}): ${errorText(text)}`);
    }
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

function errorText(body: string): string {
  try {
    const error = (JSON.parse(body) as { error?: unknown }).error;
    if (typeof error === 'string') return error;
  } catch {
    // Not JSON.
  }
  return body.slice(0, 300);
}

/**
 * Embeds a probe string to discover the vector dimension and check
 * connectivity, and asks Ollama which input types the model accepts.
 */
export async function probe(s: Settings): Promise<{ dims: number; modalities: Modality[] }> {
  const [v] = await embed(['ragbox dimension probe'], s);
  if (!v?.length) throw new EmbeddingError('Embedding provider returned an empty vector');
  return { dims: v.length, modalities: await modalities(s) };
}

async function modalities(s: Settings): Promise<Modality[]> {
  const out: Modality[] = ['text'];
  if (s.embeddingProvider !== 'ollama') return out;
  try {
    const body = await post(`${s.embeddingUrl.replace(/\/+$/, '')}/api/show`, { model: s.embeddingModel }, s);
    const caps = (body as { capabilities?: unknown }).capabilities;
    if (Array.isArray(caps)) {
      if (caps.includes('vision')) out.push('image');
      if (caps.includes('audio')) out.push('audio');
    }
  } catch {
    // Older Ollama versions or proxies without /api/show: assume text only.
  }
  return out;
}
