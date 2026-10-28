import type { Parser } from './types.js';
import { decodeText, stem } from './shared/text.js';

/** Structural metadata shared by the JSON and HuJSON parsers. */
export function describeJson(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) return { structure: 'array', length: data.length };
  if (data && typeof data === 'object') return { structure: 'object', keys: Object.keys(data).slice(0, 20) };
  return { structure: typeof data };
}

// JSON: pretty-printed so minified files chunk at sensible boundaries.
export const jsonParser: Parser = {
  id: 'json',
  label: 'JSON',
  extensions: ['.json', '.jsonc', '.geojson', '.webmanifest'],
  async parse({ buffer, name }) {
    const raw = decodeText(buffer);
    try {
      const data = JSON.parse(raw);
      return {
        text: JSON.stringify(data, null, 2),
        title: stem(name),
        structure: 'plain',
        metadata: { validJson: true, ...describeJson(data) },
      };
    } catch {
      return { text: raw, title: stem(name), structure: 'plain', metadata: { validJson: false } };
    }
  },
};
