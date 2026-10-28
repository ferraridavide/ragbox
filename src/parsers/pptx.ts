import path from 'node:path';
import type JSZip from 'jszip';
import type { Parser } from './types.js';
import { stem } from './shared/text.js';
import { childrenOf, findAll, parseXml, tagOf, textOf, type XmlNode } from './shared/xml.js';
import { openZip, parseRels, readZipText, resolvePart } from './shared/zip.js';

// PowerPoint: one `## Slide N` section per slide with its text frames, tables
// and speaker notes, in presentation order.
export const pptxParser: Parser = {
  id: 'pptx',
  label: 'PowerPoint',
  extensions: ['.pptx', '.pptm', '.potx'],
  async parse({ buffer, name }) {
    const zip = await openZip(buffer);
    const slidePaths = await slideOrder(zip);
    const parts: string[] = [];
    let titleFromSlides: string | undefined;

    for (const [i, slidePath] of slidePaths.entries()) {
      const xml = await readZipText(zip, slidePath);
      if (!xml) continue;
      const lines = paragraphs(parseXml(xml));
      titleFromSlides ??= lines[0];

      const relsPath = `${path.posix.dirname(slidePath)}/_rels/${path.posix.basename(slidePath)}.rels`;
      const rels = parseRels(await readZipText(zip, relsPath));
      const notesTarget = [...rels.values()].find((t) => t.includes('notesSlide'));
      let notes: string[] = [];
      if (notesTarget) {
        const notesXml = await readZipText(zip, resolvePart(path.posix.dirname(slidePath), notesTarget));
        // Drop the slide-number placeholder that notes pages usually carry.
        if (notesXml) notes = paragraphs(parseXml(notesXml)).filter((l) => !/^\d+$/.test(l));
      }

      if (!lines.length && !notes.length) continue;
      let section = `## Slide ${i + 1}\n${lines.join('\n')}`;
      if (notes.length) section += `\n\nNotes:\n${notes.join('\n')}`;
      parts.push(section);
    }

    const core = await readZipText(zip, 'docProps/core.xml');
    const coreTitle = core?.match(/<dc:title>([^<]*)<\/dc:title>/)?.[1]?.trim();
    return {
      text: parts.join('\n\n'),
      title: coreTitle || titleFromSlides || stem(name),
      structure: 'markdown',
      metadata: { slides: slidePaths.length },
    };
  },
};

async function slideOrder(zip: JSZip): Promise<string[]> {
  const presentation = await readZipText(zip, 'ppt/presentation.xml');
  const rels = parseRels(await readZipText(zip, 'ppt/_rels/presentation.xml.rels'));
  const ordered: string[] = [];
  for (const m of presentation?.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g) ?? []) {
    const target = rels.get(m[1]);
    if (target) ordered.push(resolvePart('ppt', target));
  }
  if (ordered.length) return ordered;
  // Fallback: numeric order of slide parts.
  return Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
}

function paragraphs(nodes: XmlNode[]): string[] {
  return findAll(nodes, 'a:p')
    .map((p) => runText(p).trim())
    .filter(Boolean);
}

function runText(node: XmlNode): string {
  let out = '';
  for (const child of childrenOf(node)) {
    const tag = tagOf(child);
    if (tag === 'a:t') out += childrenOf(child).map(textOf).join('');
    else if (tag === 'a:br') out += '\n';
    else if (tag === 'a:tab') out += '\t';
    else out += runText(child);
  }
  return out;
}
