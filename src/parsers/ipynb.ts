import type { Parser } from './types.js';
import { decodeText, stem } from './shared/text.js';

// Jupyter notebooks: markdown and code cell sources only; outputs (often large
// base64 images) are skipped.
export const ipynbParser: Parser = {
  id: 'ipynb',
  label: 'Jupyter Notebook',
  extensions: ['.ipynb'],
  async parse({ buffer, name }) {
    const raw = decodeText(buffer);
    const title = stem(name);
    let nb: unknown;
    try {
      nb = JSON.parse(raw);
    } catch {
      return { text: raw, title, structure: 'plain', metadata: { validJson: false } };
    }
    if (!nb || typeof nb !== 'object' || Array.isArray(nb)) {
      return { text: raw, title, structure: 'plain', metadata: { validJson: false } };
    }
    const notebook = nb as { cells?: unknown; metadata?: Record<string, any>; nbformat?: number };
    const kernel = notebook.metadata?.kernelspec ?? {};
    const language = String(notebook.metadata?.language_info?.name ?? kernel.language ?? 'python');
    const cells = Array.isArray(notebook.cells) ? notebook.cells : [];

    const parts: string[] = [];
    let codeCells = 0;
    let markdownCells = 0;
    for (const cell of cells) {
      if (!cell || typeof cell !== 'object') continue;
      const { cell_type: type, source: rawSource } = cell as { cell_type?: string; source?: unknown };
      const source = Array.isArray(rawSource)
        ? rawSource.filter((s) => typeof s === 'string').join('')
        : typeof rawSource === 'string' ? rawSource : '';
      if (!source.trim()) continue;
      if (type === 'markdown') {
        parts.push(source);
        markdownCells++;
      } else if (type === 'code') {
        parts.push('```' + language + '\n' + source + '\n```');
        codeCells++;
      }
    }
    const firstHeading = parts.join('\n').match(/^#\s+(.+)$/m)?.[1]?.trim();
    return {
      text: parts.join('\n\n'),
      title: firstHeading ?? title,
      structure: 'markdown',
      metadata: {
        validJson: true,
        nbformat: notebook.nbformat,
        kernel: kernel.display_name ?? kernel.name,
        language,
        cells: cells.length,
        codeCells,
        markdownCells,
      },
    };
  },
};
