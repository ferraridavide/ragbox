import type { Parser } from './types.js';
import { decodeText, lineCount, stem } from './shared/text.js';

export const textParser: Parser = {
  id: 'text',
  label: 'Plain text, Dockerfile, Makefile',
  extensions: ['.txt', '.text', '.log', '.rst'],
  filenames: ['Dockerfile', 'Makefile', 'Containerfile'],
  async parse({ buffer, name }) {
    const text = decodeText(buffer);
    return { text, title: stem(name), structure: 'plain', metadata: { lineCount: lineCount(text) } };
  },
};
