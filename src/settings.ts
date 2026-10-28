import { z } from 'zod';
import { getDb } from './db.js';

// Runtime settings. Effective value = built-in default <- RAGBOX_<KEY> env var <- value saved from the UI.
export const settingsSchema = z.object({
  // Indexing
  cooldownSeconds: z.number().int().min(0).max(86_400),
  rescanIntervalMinutes: z.number().int().min(0).max(10_080),
  watcherBackend: z.enum(['auto', 'polling']),
  pollingIntervalMs: z.number().int().min(100).max(600_000),
  concurrency: z.number().int().min(1).max(16),
  maxFileSizeMb: z.number().min(0.1).max(2048),
  excludePatterns: z.array(z.string().min(1)),
  disabledExtensions: z.array(z.string().min(1)),
  // Chunking
  chunkSize: z.number().int().min(200).max(20_000),
  chunkOverlap: z.number().int().min(0).max(5_000),
  // Embeddings
  embeddingProvider: z.enum(['ollama', 'openai']),
  embeddingUrl: z.string().url(),
  embeddingModel: z.string().min(1),
  embeddingApiKey: z.string(),
  embeddingBatchSize: z.number().int().min(1).max(512),
  documentPrefix: z.string(),
  queryPrefix: z.string(),
  // Search
  defaultSearchLimit: z.number().int().min(1).max(50),
  hybridSearch: z.boolean(),
}).refine((s) => s.chunkOverlap < s.chunkSize, { message: 'chunkOverlap must be smaller than chunkSize', path: ['chunkOverlap'] });

export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  cooldownSeconds: 10,
  rescanIntervalMinutes: 60,
  watcherBackend: 'auto',
  pollingIntervalMs: 2000,
  concurrency: 2,
  maxFileSizeMb: 50,
  excludePatterns: [
    '**/.git/**',
    '**/node_modules/**',
    '**/.venv/**',
    '**/__pycache__/**',
    '**/.DS_Store',
    '**/~$*',
    '**/.~lock.*',
  ],
  disabledExtensions: ['.mq4', '.mqh'],
  chunkSize: 1000,
  chunkOverlap: 200,
  embeddingProvider: 'ollama',
  embeddingUrl: 'http://host.docker.internal:11434',
  embeddingModel: 'embeddinggemma',
  embeddingApiKey: '',
  embeddingBatchSize: 16,
  documentPrefix: '',
  queryPrefix: '',
  defaultSearchLimit: 8,
  hybridSearch: true,
};

// Settings that invalidate existing embeddings when changed.
export const EMBEDDING_KEYS: SettingKey[] = ['embeddingProvider', 'embeddingModel', 'documentPrefix'];
export const CHUNKING_KEYS: SettingKey[] = ['chunkSize', 'chunkOverlap'];
export const FILTER_KEYS: SettingKey[] = ['excludePatterns', 'disabledExtensions', 'maxFileSizeMb'];
export const WATCHER_KEYS: SettingKey[] = ['watcherBackend', 'pollingIntervalMs'];
export const SECRET_KEYS: SettingKey[] = ['embeddingApiKey'];

function envName(key: string) {
  return 'RAGBOX_' + key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

function fromEnv(): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    const raw = process.env[envName(key)];
    if (raw === undefined || raw === '') continue;
    if (typeof def === 'number') out[key] = Number(raw);
    else if (typeof def === 'boolean') out[key] = /^(1|true|yes|on)$/i.test(raw);
    else if (Array.isArray(def)) out[key] = raw.split(',').map((s) => s.trim()).filter(Boolean);
    else out[key] = raw;
  }
  return out as Partial<Settings>;
}

type Listener = (next: Settings, prev: Settings, changed: Set<SettingKey>) => void | Promise<void>;

let current: Settings = DEFAULT_SETTINGS;
let overrides: Partial<Settings> = {};
const listeners: Listener[] = [];

export function getSettings(): Settings {
  return current;
}

/** Keys explicitly saved from the UI (as opposed to defaults or env). */
export function getOverriddenKeys(): SettingKey[] {
  return Object.keys(overrides) as SettingKey[];
}

export function onSettingsChange(listener: Listener) {
  listeners.push(listener);
}

export async function loadSettings(): Promise<Settings> {
  const res = await getDb().query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
  overrides = {};
  for (const row of res.rows) {
    if (row.key in DEFAULT_SETTINGS) (overrides as Record<string, unknown>)[row.key] = row.value;
  }
  const merged = { ...DEFAULT_SETTINGS, ...fromEnv(), ...overrides };
  const parsed = settingsSchema.safeParse(merged);
  if (!parsed.success) {
    // Fall back to defaults+env if a stored value became invalid (e.g. schema change).
    console.warn('Stored settings invalid, ignoring overrides:', parsed.error.message);
    current = settingsSchema.parse({ ...DEFAULT_SETTINGS, ...fromEnv() });
  } else {
    current = parsed.data;
  }
  return current;
}

/**
 * Validates and persists a partial update. Keys set to null are reset to their
 * default/env value. Returns the new effective settings.
 */
export async function updateSettings(patch: Record<string, unknown>): Promise<{ settings: Settings; changed: SettingKey[] }> {
  const nextOverrides: Record<string, unknown> = { ...overrides };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting: ${key}`);
    if (value === null) delete nextOverrides[key];
    else nextOverrides[key] = value;
  }
  const next = settingsSchema.parse({ ...DEFAULT_SETTINGS, ...fromEnv(), ...nextOverrides });

  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM settings');
    for (const [key, value] of Object.entries(nextOverrides)) {
      await tx.query('INSERT INTO settings (key, value) VALUES ($1, $2)', [key, JSON.stringify(value)]);
    }
  });

  const prev = current;
  overrides = nextOverrides as Partial<Settings>;
  current = next;
  const changed = new Set<SettingKey>();
  for (const key of Object.keys(next) as SettingKey[]) {
    if (JSON.stringify(next[key]) !== JSON.stringify(prev[key])) changed.add(key);
  }
  if (changed.size > 0) {
    for (const listener of listeners) await listener(next, prev, changed);
  }
  return { settings: next, changed: [...changed] };
}

/** Settings safe to send to the browser (secrets masked). */
export function publicSettings(s: Settings = current) {
  const out: Record<string, unknown> = { ...s };
  for (const key of SECRET_KEYS) out[key] = s[key] ? '********' : '';
  return out;
}
