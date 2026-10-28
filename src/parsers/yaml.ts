import { parseAllDocuments } from 'yaml';
import type { Parser } from './types.js';
import { decodeText, lineCount, stem } from './shared/text.js';

// YAML: indexed as-is; Kubernetes-style manifests get kind/apiVersion/name
// metadata from the first document.
export const yamlParser: Parser = {
  id: 'yaml',
  label: 'YAML',
  extensions: ['.yaml', '.yml'],
  async parse({ buffer, name }) {
    const text = decodeText(buffer);
    const metadata: Record<string, unknown> = { lineCount: lineCount(text) };
    try {
      const first = parseAllDocuments(text)
        .map((d) => ('toJS' in d ? d.toJS() : undefined))
        .find((d) => d != null);
      if (first && typeof first === 'object' && !Array.isArray(first) && ('kind' in first || 'apiVersion' in first)) {
        if (typeof first.kind === 'string') metadata.k8sKind = first.kind;
        if (typeof first.apiVersion === 'string') metadata.k8sApiVersion = first.apiVersion;
        if (typeof first.metadata?.name === 'string') metadata.k8sName = first.metadata.name;
      }
    } catch {
      // Invalid YAML is still indexed as text.
    }
    return { text, title: stem(name), structure: 'plain', metadata };
  },
};
