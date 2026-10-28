import { XMLParser } from 'fast-xml-parser';

// Minimal helpers over fast-xml-parser's `preserveOrder` output, which keeps
// document order (needed for paragraphs/runs in Office XML).

export type XmlNode = Record<string, unknown> & { ':@'?: Record<string, string> };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: true,
});

export function parseXml(xml: string): XmlNode[] {
  return parser.parse(xml) as XmlNode[];
}

/** Tag name of a node (`#text` for text nodes). */
export function tagOf(node: XmlNode): string {
  return Object.keys(node).find((k) => k !== ':@') ?? '';
}

export function childrenOf(node: XmlNode): XmlNode[] {
  const value = node[tagOf(node)];
  return Array.isArray(value) ? (value as XmlNode[]) : [];
}

export function attr(node: XmlNode, name: string): string | undefined {
  return node[':@']?.[name];
}

export function textOf(node: XmlNode): string {
  const tag = tagOf(node);
  return tag === '#text' ? String(node['#text'] ?? '') : '';
}

/** Depth-first search for all nodes with the given tag. */
export function findAll(nodes: XmlNode[], tag: string, out: XmlNode[] = []): XmlNode[] {
  for (const node of nodes) {
    if (tagOf(node) === tag) out.push(node);
    else findAll(childrenOf(node), tag, out);
  }
  return out;
}

export function findFirst(nodes: XmlNode[], tag: string): XmlNode | undefined {
  for (const node of nodes) {
    if (tagOf(node) === tag) return node;
    const found = findFirst(childrenOf(node), tag);
    if (found) return found;
  }
  return undefined;
}
