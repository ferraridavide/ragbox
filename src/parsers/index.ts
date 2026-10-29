import path from 'node:path';
import type { Parser } from './types.js';
import { audioParser } from './audio.js';
import { codeParser } from './code.js';
import { genericCodeParser } from './code-generic.js';
import { csvParser } from './csv.js';
import { docxParser } from './docx.js';
import { htmlParser } from './html.js';
import { imageParser } from './image.js';
import { hujsonParser } from './hujson.js';
import { ipynbParser } from './ipynb.js';
import { jsonParser } from './json.js';
import { markdownParser } from './markdown.js';
import { pdfParser } from './pdf.js';
import { pptxParser } from './pptx.js';
import { protoParser } from './proto.js';
import { shellParser } from './shell.js';
import { sqlParser } from './sql.js';
import { textParser } from './text.js';
import { xlsxParser } from './xlsx.js';
import { xmlParser } from './xml.js';
import { yamlParser } from './yaml.js';

export type { MediaKind, MediaSegment, Parser, ParsedDocument, ParserInput } from './types.js';

// Bump when parser output changes so existing files get re-indexed.
export const PARSER_VERSION = 1;

export const parsers: Parser[] = [
  markdownParser,
  textParser,
  pdfParser,
  docxParser,
  xlsxParser,
  pptxParser,
  ipynbParser,
  jsonParser,
  hujsonParser,
  csvParser,
  xmlParser,
  yamlParser,
  codeParser,
  genericCodeParser,
  protoParser,
  sqlParser,
  shellParser,
  htmlParser,
  imageParser,
  audioParser,
];

const byExtension = new Map<string, Parser>();
const byFilename = new Map<string, Parser>();
for (const parser of parsers) {
  for (const ext of parser.extensions) byExtension.set(ext, parser);
  for (const name of parser.filenames ?? []) byFilename.set(name, parser);
}

/** Key used to enable/disable a format: the extension, or the file name for extension-less files. */
export function formatKey(filePath: string): string {
  const name = path.basename(filePath);
  if (byFilename.has(name)) return name;
  return path.extname(name).toLowerCase();
}

/** Returns the parser for a path, honouring the disabled list, or undefined if unsupported. */
export function parserFor(filePath: string, disabled: string[] = []): Parser | undefined {
  const key = formatKey(filePath);
  if (disabled.includes(key)) return undefined;
  return byFilename.get(key) ?? byExtension.get(key);
}

export function supportedFormats() {
  return parsers.map((p) => ({ id: p.id, label: p.label, extensions: [...p.extensions, ...(p.filenames ?? [])] }));
}
