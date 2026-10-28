import type { Parser } from './types.js';
import { describeJson } from './json.js';
import { decodeText, stem } from './shared/text.js';

// HuJSON (JSON with comments and trailing commas, e.g. Tailscale ACLs). The
// original text, comments included, is indexed; strict JSON is only used for
// metadata.
export const hujsonParser: Parser = {
  id: 'hujson',
  label: 'HuJSON',
  extensions: ['.hujson', '.json5'],
  async parse({ buffer, name }) {
    const raw = decodeText(buffer);
    let metadata: Record<string, unknown>;
    try {
      metadata = { validJson: true, ...describeJson(JSON.parse(stripHujson(raw))) };
    } catch {
      metadata = { validJson: false };
    }
    return { text: raw, title: stem(name), structure: 'plain', metadata };
  },
};

/**
 * Converts HuJSON to strict JSON by dropping comments and trailing commas,
 * leaving string literals untouched. Ported from knowledge-rag (MIT).
 */
export function stripHujson(text: string): string {
  let out = '';
  const n = text.length;
  let i = 0;
  let inString = false;
  while (i < n) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) {
        // Unterminated block comment: keep it so JSON.parse fails.
        out += text.slice(i);
        i = n;
      } else {
        i = end + 2;
      }
    } else if (c === ',') {
      let j = i + 1;
      while (j < n) {
        if (' \t\r\n'.includes(text[j])) j++;
        else if (text.startsWith('//', j)) {
          const nl = text.indexOf('\n', j);
          j = nl === -1 ? n : nl + 1;
        } else if (text.startsWith('/*', j)) {
          const end = text.indexOf('*/', j + 2);
          j = end === -1 ? n : end + 2;
        } else break;
      }
      if (!(j < n && '}]'.includes(text[j]))) out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
