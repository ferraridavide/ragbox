/**
 * Renders tabular rows as markdown-ish sections of `rowsPerSection` rows, each
 * repeating the header row so every chunk carries the column names.
 */
export function tableSections(heading: string, rows: string[][], rowsPerSection = 40): string[] {
  const lines = rows.map((r) => r.join(' | ').trim()).filter((l) => l.replace(/[|\s]/g, ''));
  if (!lines.length) return [];
  const [header, ...body] = lines;
  if (!body.length) return [`## ${heading}\n${header}`];
  const sections: string[] = [];
  for (let i = 0; i < body.length; i += rowsPerSection) {
    const slice = body.slice(i, i + rowsPerSection);
    const range = `rows ${i + 2}-${i + 1 + slice.length}`;
    sections.push(`## ${heading} (${range})\n${header}\n${slice.join('\n')}`);
  }
  return sections;
}
