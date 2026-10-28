import type { Parser } from './types.js';
import { decodeText, lineCount, matchAll, stem } from './shared/text.js';

// Shell scripts and jq filters: function names as metadata.
export const shellParser: Parser = {
  id: 'shell',
  label: 'Shell, jq',
  extensions: ['.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.jq'],
  async parse({ buffer, name }) {
    const text = decodeText(buffer);
    const functions = matchAll(text, /^\s*(?:function\s+([\w-]+)|([\w-]+)\s*\(\)|def\s+(\w+)\s*[:(])/gm);
    return {
      text,
      title: stem(name),
      structure: 'plain',
      metadata: { shebang: text.match(/^#!(.*)/)?.[1]?.trim(), functions, lineCount: lineCount(text) },
    };
  },
};
