import { parse as parseYaml } from 'yaml';
import type { Parser } from './types.js';
import { decodeText, stem } from './shared/text.js';

export const markdownParser: Parser = {
  id: 'markdown',
  label: 'Markdown',
  extensions: ['.md', '.markdown', '.mdx'],
  async parse({ buffer, name }) {
    let text = decodeText(buffer);
    const metadata: Record<string, unknown> = {};

    // YAML front matter is removed from the indexed text but kept as metadata.
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    let fmTitle: string | undefined;
    if (fm) {
      text = text.slice(fm[0].length);
      try {
        const data = parseYaml(fm[1]);
        if (data && typeof data === 'object') {
          metadata.frontmatter = data;
          if (typeof (data as Record<string, unknown>).title === 'string') fmTitle = (data as Record<string, string>).title;
        }
      } catch {
        // Malformed front matter: ignore.
      }
    }

    const headers = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({ level: m[1].length, title: m[2].trim() }));
    metadata.headers = headers.slice(0, 100);
    metadata.hasCodeBlocks = text.includes('```');
    const title = fmTitle ?? headers.find((h) => h.level === 1)?.title ?? stem(name);
    return { text, title, structure: 'markdown', metadata };
  },
};
