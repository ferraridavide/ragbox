import path from 'node:path';

const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Decodes a buffer as UTF-8 (stripping the BOM). Throws if the content looks
 * binary, so a mis-named binary file is reported instead of indexed as garbage.
 */
export function decodeText(buffer: Buffer): string {
  const sample = buffer.subarray(0, 8192);
  if (sample.includes(0)) throw new Error('File appears to be binary (contains NUL bytes)');
  return decoder.decode(buffer).replace(/^﻿/, '');
}

export function stem(name: string): string {
  return path.basename(name, path.extname(name));
}

export function lineCount(text: string): number {
  return text ? text.split('\n').length : 0;
}

export function unique<T>(items: T[], limit = Infinity): T[] {
  return [...new Set(items)].slice(0, limit);
}

/** Returns the first capture group (or all non-empty groups) of every match. */
export function matchAll(text: string, re: RegExp, limit = 50): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    for (const g of m.slice(1)) if (g) out.push(g);
    if (out.length >= limit) break;
  }
  return unique(out, limit);
}
