import JSZip from 'jszip';

export async function openZip(buffer: Buffer): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new Error(`Not a valid Office Open XML file: ${err instanceof Error ? err.message : err}`);
  }
}

export async function readZipText(zip: JSZip, name: string): Promise<string | undefined> {
  const file = zip.file(name);
  return file ? file.async('string') : undefined;
}

/** Parses a `.rels` file into a map of relationship id -> target. */
export function parseRels(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) map.set(id, target);
  }
  return map;
}

/** Resolves a relationship target relative to the part that references it. */
export function resolvePart(fromDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
