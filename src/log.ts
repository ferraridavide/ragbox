export type LogLevel = 'info' | 'warn' | 'error';

export interface ActivityEntry {
  id: number;
  ts: string;
  level: LogLevel;
  message: string;
  path?: string;
}

const MAX_ENTRIES = 500;
const entries: ActivityEntry[] = [];
let nextId = 1;

function push(level: LogLevel, message: string, path?: string) {
  const entry: ActivityEntry = { id: nextId++, ts: new Date().toISOString(), level, message, path };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  const line = `${entry.ts} ${level.toUpperCase().padEnd(5)} ${path ? `[${path}] ` : ''}${message}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  info: (message: string, path?: string) => push('info', message, path),
  warn: (message: string, path?: string) => push('warn', message, path),
  error: (message: string, path?: string) => push('error', message, path),
};

/** Recent activity, newest first, optionally only entries newer than `afterId`. */
export function recentActivity(afterId = 0, limit = 200): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    if (entries[i].id <= afterId) break;
    out.push(entries[i]);
  }
  return out;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
