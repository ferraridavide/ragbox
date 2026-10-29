export interface ParserInput {
  /** Raw file contents. */
  buffer: Buffer;
  /** Path relative to the documents root, using forward slashes. */
  path: string;
  /** Base name of the file, e.g. `report.pdf`. */
  name: string;
  /** Lower-cased extension including the dot, e.g. `.pdf` (empty for `Dockerfile`). */
  ext: string;
}

export interface ParsedDocument {
  text: string;
  title?: string;
  /**
   * `markdown` text is chunked at `##`/`###` headings; `plain` text uses
   * fixed-size chunks with overlap.
   */
  structure: 'markdown' | 'plain';
  metadata: Record<string, unknown>;
  /**
   * Images and audio are embedded directly by a multimodal model instead of
   * being chunked as text; each segment becomes one chunk.
   */
  media?: MediaSegment[];
  /** Set when the file is valid but not worth indexing (e.g. a tiny icon). */
  skip?: string;
}

export type MediaKind = 'image' | 'audio';

export interface MediaSegment {
  kind: MediaKind;
  /** Bytes in a format the embedding provider decodes natively (PNG/JPEG/GIF/WebP, WAV). */
  data: Buffer;
  /** Text stored with the chunk and returned by search. */
  content: string;
  section?: string;
}

export interface Parser {
  /** Stable identifier shown in the UI and stored with each file. */
  id: string;
  /** Human readable name of the format(s). */
  label: string;
  /** Lower-cased extensions handled by this parser, including the dot. */
  extensions: string[];
  /** Exact file names handled by this parser (for extension-less files). */
  filenames?: string[];
  parse(input: ParserInput): Promise<ParsedDocument>;
}
