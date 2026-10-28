import { parse } from 'csv-parse/sync';
import type { Parser } from './types.js';
import { decodeText, stem } from './shared/text.js';
import { tableSections } from './shared/table.js';

// CSV/TSV: rows rendered as `a | b | c`, split into sections that repeat the
// header row. Malformed files fall back to indexing the raw text.
export const csvParser: Parser = {
  id: 'csv',
  label: 'CSV / TSV',
  extensions: ['.csv', '.tsv'],
  async parse({ buffer, name, ext }) {
    const raw = decodeText(buffer);
    const title = stem(name);
    let rows: string[][];
    try {
      rows = parse(raw, {
        delimiter: ext === '.tsv' ? '\t' : [',', ';'],
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: true,
        trim: true,
      }) as string[][];
    } catch (err) {
      return {
        text: raw,
        title,
        structure: 'plain',
        metadata: { validCsv: false, parseError: err instanceof Error ? err.message : String(err) },
      };
    }
    return {
      text: tableSections(title, rows).join('\n\n'),
      title,
      structure: 'markdown',
      metadata: { validCsv: true, rows: rows.length, columns: rows[0]?.length ?? 0 },
    };
  },
};
