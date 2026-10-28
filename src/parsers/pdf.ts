import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import type { Parser } from './types.js';
import { stem } from './shared/text.js';

// Text-layer extraction only (no OCR): scanned PDFs without a text layer
// produce no text and are reported as empty.
export const pdfParser: Parser = {
  id: 'pdf',
  label: 'PDF',
  extensions: ['.pdf'],
  async parse({ buffer, name }) {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    try {
      const { totalPages, text } = await extractText(pdf, { mergePages: false });
      let info: Record<string, unknown> = {};
      try {
        info = ((await getMeta(pdf)).info ?? {}) as Record<string, unknown>;
      } catch {
        // Metadata is optional.
      }
      const pages = text
        .map((t, i) => ({ page: i + 1, text: t.trim() }))
        .filter((p) => p.text)
        .map((p) => `[Page ${p.page}]\n${p.text}`);
      const title = typeof info.Title === 'string' && info.Title.trim() ? info.Title.trim() : stem(name);
      return {
        text: pages.join('\n\n'),
        title,
        structure: 'plain',
        metadata: { pages: totalPages, author: typeof info.Author === 'string' ? info.Author : undefined },
      };
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
};
