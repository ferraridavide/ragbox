import type { Parser } from './types.js';
import { decodeText, matchAll, stem, unique } from './shared/text.js';

// SQL scripts: referenced tables and statement types as metadata.
export const sqlParser: Parser = {
  id: 'sql',
  label: 'SQL',
  extensions: ['.sql'],
  async parse({ buffer, name }) {
    const text = decodeText(buffer);
    const tables = matchAll(
      text,
      /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|FROM|JOIN|INTO|UPDATE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([\w"`[\]]+(?:\.[\w"`[\]]+)*)/gi,
    );
    const statements = unique(
      [...text.matchAll(/\b(CREATE|ALTER|DROP|SELECT|INSERT|UPDATE|DELETE|MERGE|GRANT)\b/gi)].map((m) => m[1].toUpperCase()),
    );
    return { text, title: stem(name), structure: 'plain', metadata: { tables, statements } };
  },
};
