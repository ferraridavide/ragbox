import type { Parser } from './types.js';
import { decodeText, matchAll, stem } from './shared/text.js';

// Protocol Buffers definitions: services, messages and RPCs as metadata.
export const protoParser: Parser = {
  id: 'proto',
  label: 'Protocol Buffers',
  extensions: ['.proto'],
  async parse({ buffer, name }) {
    const text = decodeText(buffer);
    return {
      text,
      title: stem(name),
      structure: 'plain',
      metadata: {
        package: text.match(/^\s*package\s+([\w.]+)/m)?.[1],
        services: matchAll(text, /\bservice\s+(\w+)/g),
        messages: matchAll(text, /\bmessage\s+(\w+)/g),
        rpcs: matchAll(text, /\brpc\s+(\w+)/g),
      },
    };
  },
};
