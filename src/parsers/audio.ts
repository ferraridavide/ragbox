import type { MediaSegment, Parser } from './types.js';
import { stem } from './shared/text.js';

// WAV files are split into overlapping windows that are embedded directly by a
// multimodal model. Only encodings that Ollama decodes natively are accepted:
// integer PCM (8/16/24/32-bit) and 32-bit float. The samples are copied, not
// resampled, so each window keeps the original format.

// About 25 audio tokens per second: a window fits easily in an 8k context
// (Ollama rejects audio longer than 600 s outright).
const WINDOW_SECONDS = 30;
const OVERLAP_SECONDS = 5;
const MIN_SECONDS = 0.5;

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const FORMAT_NAMES: Record<number, string> = { 0x0002: 'ADPCM', 0x0006: 'A-law', 0x0007: 'μ-law', 0x0011: 'IMA ADPCM', 0x0055: 'MP3' };

interface WavFormat {
  /** The raw `fmt ` chunk, copied into every window. */
  fmtChunk: Buffer;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

export const audioParser: Parser = {
  id: 'audio',
  label: 'Audio (multimodal model)',
  extensions: ['.wav', '.wave'],
  async parse({ buffer, name }) {
    const { format, data } = readWav(buffer);
    const frames = Math.floor(data.length / format.blockAlign);
    const duration = frames / format.sampleRate;
    const metadata = {
      durationSeconds: Math.round(duration * 10) / 10,
      sampleRate: format.sampleRate,
      channels: format.channels,
      bitsPerSample: format.bitsPerSample,
    };
    if (duration < MIN_SECONDS) {
      return { text: '', structure: 'plain', metadata, skip: `Audio too short to index (${duration.toFixed(2)} s)` };
    }

    const media: MediaSegment[] = [];
    for (const start of windowStarts(duration)) {
      const end = Math.min(start + WINDOW_SECONDS, duration);
      const from = Math.round(start * format.sampleRate) * format.blockAlign;
      const to = Math.min(Math.round(end * format.sampleRate) * format.blockAlign, frames * format.blockAlign);
      const section = `${timestamp(start)}–${timestamp(end)}`;
      media.push({
        kind: 'audio',
        data: writeWav(format, data.subarray(from, to)),
        content: `Audio: ${name}, ${section} of ${timestamp(duration)}`,
        section,
      });
    }
    return { text: '', title: stem(name), structure: 'plain', metadata, media };
  },
};

/** Window start times; the last window is aligned to the end so it is full length. */
export function windowStarts(duration: number): number[] {
  const starts = [0];
  const step = WINDOW_SECONDS - OVERLAP_SECONDS;
  while (starts.at(-1)! + WINDOW_SECONDS < duration) {
    const next = starts.at(-1)! + step;
    starts.push(next + WINDOW_SECONDS >= duration ? Math.max(duration - WINDOW_SECONDS, 0) : next);
  }
  return starts;
}

function readWav(b: Buffer): { format: WavFormat; data: Buffer } {
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error(b.toString('latin1', 0, 4) === 'RF64' ? 'RF64 WAV files are not supported' : 'Not a WAV file');
  }
  let format: WavFormat | undefined;
  for (let i = 12; i + 8 <= b.length; ) {
    const id = b.toString('latin1', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    const body = i + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + size > b.length) throw new Error('Corrupt WAV header');
      format = parseFormat(b.subarray(i, body + size));
    } else if (id === 'data') {
      if (!format) throw new Error('Corrupt WAV file: data before format chunk');
      // Streaming writers leave the size at 0 or 0xFFFFFFFF: take the rest of the file.
      const end = size === 0 || body + size > b.length ? b.length : body + size;
      return { format, data: b.subarray(body, end) };
    }
    i = body + size + (size & 1);
  }
  throw new Error('Corrupt WAV file: no audio data');
}

function parseFormat(chunk: Buffer): WavFormat {
  let tag = chunk.readUInt16LE(8);
  const bitsPerSample = chunk.readUInt16LE(22);
  // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
  if (tag === WAVE_FORMAT_EXTENSIBLE && chunk.length >= 8 + 26) tag = chunk.readUInt16LE(8 + 24);
  const supported =
    (tag === WAVE_FORMAT_PCM && [8, 16, 24, 32].includes(bitsPerSample)) ||
    (tag === WAVE_FORMAT_IEEE_FLOAT && bitsPerSample === 32);
  if (!supported) {
    const name = tag === WAVE_FORMAT_IEEE_FLOAT ? `${bitsPerSample}-bit float` : tag === WAVE_FORMAT_PCM ? `${bitsPerSample}-bit PCM` : FORMAT_NAMES[tag] ?? `format 0x${tag.toString(16)}`;
    throw new Error(`Unsupported WAV encoding (${name}): only 8/16/24/32-bit PCM and 32-bit float are supported`);
  }
  const format = {
    fmtChunk: chunk,
    channels: chunk.readUInt16LE(10),
    sampleRate: chunk.readUInt32LE(12),
    blockAlign: chunk.readUInt16LE(20),
    bitsPerSample,
  };
  if (!format.channels || !format.sampleRate || !format.blockAlign) throw new Error('Corrupt WAV header');
  return format;
}

function writeWav(format: WavFormat, samples: Buffer): Buffer {
  const fmt = format.fmtChunk;
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + fmt.length + (fmt.length & 1) + 8 + samples.length, 4);
  header.write('WAVE', 8, 'latin1');
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'latin1');
  dataHeader.writeUInt32LE(samples.length, 4);
  return Buffer.concat([header, fmt, Buffer.alloc(fmt.length & 1), dataHeader, samples]);
}

function timestamp(seconds: number): string {
  const s = Math.floor(seconds);
  const hms = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0'));
  return s >= 3600 ? hms.join(':') : hms.slice(1).join(':');
}
