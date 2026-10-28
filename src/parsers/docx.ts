import type { Parser } from './types.js';
import { stem } from './shared/text.js';
import { attr, childrenOf, findFirst, parseXml, tagOf, textOf, type XmlNode } from './shared/xml.js';
import { openZip, readZipText } from './shared/zip.js';

// Word documents: paragraphs and tables in document order, headings rendered as
// markdown (`#`), list items as `-`, tables as `a | b | c` rows.
export const docxParser: Parser = {
  id: 'docx',
  label: 'Word',
  extensions: ['.docx', '.docm', '.dotx'],
  async parse({ buffer, name }) {
    const zip = await openZip(buffer);
    const documentXml = await readZipText(zip, 'word/document.xml');
    if (!documentXml) throw new Error('Missing word/document.xml');
    const headingStyles = parseHeadingStyles(await readZipText(zip, 'word/styles.xml'));
    const body = findFirst(parseXml(documentXml), 'w:body');
    const parts: string[] = [];
    const stats = { paragraphs: 0, tables: 0 };
    if (body) renderBlocks(childrenOf(body), headingStyles, parts, stats);

    const core = await readZipText(zip, 'docProps/core.xml');
    const coreTitle = core?.match(/<dc:title>([^<]*)<\/dc:title>/)?.[1]?.trim();
    const firstHeading = parts.find((p) => p.startsWith('# '))?.slice(2);
    return {
      text: parts.join('\n\n'),
      title: coreTitle || firstHeading || stem(name),
      structure: 'markdown',
      metadata: stats,
    };
  },
};

/** Maps style ids to heading levels using the built-in (English) style names. */
function parseHeadingStyles(stylesXml: string | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!stylesXml) return map;
  for (const m of stylesXml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const styleName = m[2].match(/<w:name w:val="([^"]+)"/)?.[1]?.toLowerCase();
    const level = styleName === 'title' ? 1 : Number(styleName?.match(/^heading (\d)$/)?.[1]);
    if (level) map.set(m[1], level);
  }
  return map;
}

function renderBlocks(nodes: XmlNode[], headings: Map<string, number>, out: string[], stats: { paragraphs: number; tables: number }) {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === 'w:p') {
      const text = paragraphText(node).trim();
      if (!text) continue;
      stats.paragraphs++;
      const level = headingLevel(node, headings);
      if (level) out.push(`${'#'.repeat(Math.min(level, 6))} ${text.replace(/\s+/g, ' ')}`);
      else if (findFirst(childrenOf(node), 'w:numPr')) out.push(`- ${text}`);
      else out.push(text);
    } else if (tag === 'w:tbl') {
      stats.tables++;
      const rows = childrenOf(node)
        .filter((n) => tagOf(n) === 'w:tr')
        .map((tr) => childrenOf(tr)
          .filter((n) => tagOf(n) === 'w:tc')
          .map((tc) => {
            const cell: string[] = [];
            renderBlocks(childrenOf(tc), new Map(), cell, { paragraphs: 0, tables: 0 });
            return cell.join(' ').replace(/\s+/g, ' ').trim();
          })
          .join(' | '))
        .filter((r) => r.replace(/[|\s]/g, ''));
      if (rows.length) out.push(rows.join('\n'));
    } else if (tag === 'w:sdt' || tag === 'w:sdtContent' || tag === 'w:customXml') {
      renderBlocks(childrenOf(node), headings, out, stats);
    }
  }
}

function headingLevel(p: XmlNode, headings: Map<string, number>): number | undefined {
  const pPr = childrenOf(p).find((n) => tagOf(n) === 'w:pPr');
  if (!pPr) return undefined;
  const style = childrenOf(pPr).find((n) => tagOf(n) === 'w:pStyle');
  const styleId = style ? attr(style, 'w:val') : undefined;
  if (styleId && headings.has(styleId)) return headings.get(styleId);
  const outline = childrenOf(pPr).find((n) => tagOf(n) === 'w:outlineLvl');
  const lvl = outline ? Number(attr(outline, 'w:val')) : NaN;
  return Number.isInteger(lvl) && lvl < 9 ? lvl + 1 : undefined;
}

function paragraphText(node: XmlNode): string {
  let out = '';
  for (const child of childrenOf(node)) {
    const tag = tagOf(child);
    if (tag === 'w:t') out += childrenOf(child).map(textOf).join('');
    else if (tag === 'w:tab') out += '\t';
    else if (tag === 'w:br' || tag === 'w:cr') out += '\n';
    else if (tag === 'w:pPr' || tag === 'w:rPr' || tag === 'w:del' || tag === 'w:instrText') continue;
    else out += paragraphText(child);
  }
  return out;
}
