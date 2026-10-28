import type { Parser } from './types.js';
import { decodeText, stem } from './shared/text.js';

// XML: indexed as-is, with root element and namespace declarations as metadata.
export const xmlParser: Parser = {
  id: 'xml',
  label: 'XML',
  extensions: ['.xml', '.xsd', '.xsl', '.xslt', '.svg', '.plist', '.csproj', '.pom'],
  async parse({ buffer, name }) {
    const text = decodeText(buffer);
    const withoutProlog = text.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
    const rootElement = withoutProlog.match(/<([\w][\w\-.:]*)[\s>/]/)?.[1];
    const namespaces = [...text.matchAll(/xmlns(?::([\w-]+))?\s*=\s*["']([^"']+)["']/g)]
      .slice(0, 20)
      .map((m) => ({ prefix: m[1] ?? 'default', uri: m[2] }));
    return { text, title: stem(name), structure: 'plain', metadata: { rootElement, namespaces } };
  },
};
