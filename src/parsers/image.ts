import { PNG } from 'pngjs';
import type { Parser } from './types.js';
import { stem } from './shared/text.js';

// Images are passed to the embedding model as-is, so only formats that Ollama
// decodes natively are accepted (PNG, JPEG, GIF, WebP). The format is detected
// from the file contents, not the extension.
//
// Known limits of the native decoders: EXIF orientation is ignored, and GIF and
// WebP transparency is dropped. PNG transparency is composited onto white here,
// otherwise dark content on a transparent background embeds as a black image.

const MIN_SIDE = 64;

type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export const imageParser: Parser = {
  id: 'image',
  label: 'Images (multimodal model)',
  extensions: ['.png', '.jpg', '.jpeg', '.jpe', '.jfif', '.gif', '.webp'],
  async parse({ buffer, name }) {
    const format = detectFormat(buffer);
    if (!format) throw new Error('Not a PNG, JPEG, GIF or WebP image (other image formats are not supported)');
    const size = dimensions(buffer, format);
    if (!size) throw new Error(`Corrupt or unsupported ${format.toUpperCase()} image`);
    const { width, height } = size;
    const metadata = { format, width, height };
    if (Math.max(width, height) < MIN_SIDE) {
      return { text: '', structure: 'plain', metadata, skip: `Image too small to index (${width}×${height})` };
    }
    const data = format === 'png' && pngHasAlpha(buffer) ? flattenPng(buffer) : buffer;
    return {
      text: '',
      title: stem(name),
      structure: 'plain',
      metadata,
      media: [{ kind: 'image', data, content: `Image: ${name} (${format.toUpperCase()}, ${width}×${height})` }],
    };
  },
};

function detectFormat(b: Buffer): ImageFormat | undefined {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return undefined;
}

function dimensions(b: Buffer, format: ImageFormat): { width: number; height: number } | undefined {
  try {
    switch (format) {
      case 'png':
        return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
      case 'gif':
        return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
      case 'webp':
        return webpDimensions(b);
      case 'jpeg':
        return jpegDimensions(b);
    }
  } catch {
    return undefined; // Truncated header.
  }
}

function webpDimensions(b: Buffer) {
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return undefined;
}

function jpegDimensions(b: Buffer) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++; // Fill byte.
      continue;
    }
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return undefined;
}

/** True for PNG color types with an alpha channel, or a tRNS (transparency) chunk. */
function pngHasAlpha(b: Buffer): boolean {
  const colorType = b[25];
  if (colorType === 4 || colorType === 6) return true;
  for (let i = 8; i + 8 <= b.length; ) {
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    i += 12 + len;
  }
  return false;
}

/** Re-encodes a PNG as opaque RGB, compositing transparent pixels onto white. */
function flattenPng(b: Buffer): Buffer {
  const png = PNG.sync.read(b);
  const px = png.data;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 255) continue;
    for (let c = 0; c < 3; c++) px[i + c] = Math.round((px[i + c] * a + 255 * (255 - a)) / 255);
    px[i + 3] = 255;
  }
  return PNG.sync.write(png, { colorType: 2 });
}
