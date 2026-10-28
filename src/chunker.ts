// Chunking strategies, ported from knowledge-rag (MIT, https://github.com/lyonzin/knowledge-rag).

export interface Chunk {
  index: number;
  content: string;
  section?: string;
}

export interface ChunkOptions {
  chunkSize: number;
  chunkOverlap: number;
}

const MIN_SECTION_SIZE = 100;

/** Fixed-size chunks with overlap, preferring paragraph > line > sentence > word boundaries. */
export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  const { chunkSize, chunkOverlap } = opts;
  const chunks: Chunk[] = [];
  const len = text.length;
  let start = 0;
  while (start < len) {
    let end = Math.min(start + chunkSize, len);
    if (end < len) {
      const zoneStart = start + Math.floor(chunkSize * 0.8);
      const zone = text.slice(zoneStart, end);
      for (const sep of ['\n\n', '\n', '. ', ' ']) {
        const at = zone.lastIndexOf(sep);
        if (at !== -1) {
          end = zoneStart + at + sep.length;
          break;
        }
      }
    }
    const content = text.slice(start, end).trim();
    if (content) chunks.push({ index: chunks.length, content });
    if (end >= len) break;
    const next = end - chunkOverlap;
    start = next > start ? next : end;
  }
  return chunks;
}

/**
 * Section-aware chunking for markdown-like text: splits at `##`/`###` headings
 * (ignoring fenced code), merges tiny sections, and sub-chunks large ones while
 * repeating the section heading for context.
 */
export function chunkMarkdown(text: string, opts: ChunkOptions): Chunk[] {
  const codeBlocks: string[] = [];
  let marker = '__RAGBOX_CODE_';
  while (text.includes(marker)) marker = '_' + marker;
  const masked = text.replace(/```[\s\S]*?```/g, (m) => {
    codeBlocks.push(m);
    return `${marker}${codeBlocks.length - 1}__`;
  });

  let sections = masked.split(/(?=^#{2,3}\s+)/m).filter((s) => s.trim());
  if (sections.length <= 1) return chunkText(text, opts);

  const placeholder = new RegExp(`${escapeRegExp(marker)}(\\d+)__`, 'g');
  sections = sections.map((s) => s.replace(placeholder, (_, i) => codeBlocks[Number(i)]));

  const merged: string[] = [];
  let buffer = '';
  for (const section of sections) {
    if (buffer) {
      buffer += '\n\n' + section;
      if (buffer.trim().length >= MIN_SECTION_SIZE) {
        merged.push(buffer);
        buffer = '';
      }
    } else if (section.trim().length < MIN_SECTION_SIZE) {
      buffer = section;
    } else {
      merged.push(section);
    }
  }
  if (buffer) {
    if (merged.length) merged[merged.length - 1] += '\n\n' + buffer;
    else merged.push(buffer);
  }

  const chunks: Chunk[] = [];
  for (const section of merged) {
    const trimmed = section.trim().replace(/\n{3,}/g, '\n\n');
    if (!trimmed) continue;
    const header = trimmed.match(/^(#{2,3}\s+.+)$/m)?.[1]?.trim();
    if (trimmed.length <= opts.chunkSize) {
      chunks.push({ index: chunks.length, content: trimmed, section: header });
      continue;
    }
    chunkText(trimmed, opts).forEach((sub, i) => {
      const content = i > 0 && header ? `${header}\n\n${sub.content}` : sub.content;
      chunks.push({ index: chunks.length, content, section: header });
    });
  }
  return chunks;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
