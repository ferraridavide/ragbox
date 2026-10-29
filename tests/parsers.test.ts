import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { chunkMarkdown, chunkText } from '../src/chunker.js';
import { parserFor } from '../src/parsers/index.js';
import { stripHujson } from '../src/parsers/hujson.js';
import { windowStarts } from '../src/parsers/audio.js';

async function parse(name: string, content: string | Buffer) {
  const parser = parserFor(name);
  assert.ok(parser, `no parser for ${name}`);
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  return parser.parse({ buffer: Buffer.isBuffer(content) ? content : Buffer.from(content), path: name, name, ext });
}

test('docx: headings via styles, lists and tables', async () => {
  const zip = new JSZip();
  zip.file('word/styles.xml', '<w:styles xmlns:w="w"><w:style w:type="paragraph" w:styleId="Titolo1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Titolo2"><w:name w:val="heading 2"/></w:style></w:styles>');
  const p = (text: string, style?: string, list = false) =>
    `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${list ? '<w:numPr><w:ilvl w:val="0"/></w:numPr>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const cell = (t: string) => `<w:tc>${p(t)}</w:tc>`;
  zip.file('word/document.xml', `<w:document xmlns:w="w"><w:body>${p('Manuale', 'Titolo1')}${p('Installazione', 'Titolo2')}${p('Scarica &amp; installa')}${p('Primo passo', undefined, true)}<w:tbl><w:tr>${cell('Nome')}${cell('Valore')}</w:tr><w:tr>${cell('A')}${cell('1')}</w:tr></w:tbl></w:body></w:document>`);
  const doc = await parse('manual.docx', await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal(doc.text, '# Manuale\n\n## Installazione\n\nScarica & installa\n\n- Primo passo\n\nNome | Valore\nA | 1');
  assert.equal(doc.title, 'Manuale');
});

test('hujson: strips comments and trailing commas but not inside strings', () => {
  assert.deepEqual(JSON.parse(stripHujson('{"a": "// x, ]", /* c */ "b": [1, 2,], // t\n}')), { a: '// x, ]', b: [1, 2] });
});

test('ipynb: keeps sources, drops outputs', async () => {
  const nb = { metadata: { language_info: { name: 'python' } }, cells: [
    { cell_type: 'markdown', source: ['# Title\n', 'intro'] },
    { cell_type: 'code', source: 'print(1)', outputs: [{ data: { 'image/png': 'AAAA' } }] },
  ] };
  const doc = await parse('n.ipynb', JSON.stringify(nb));
  assert.equal(doc.text, '# Title\nintro\n\n```python\nprint(1)\n```');
});

test('code: extracts python symbols', async () => {
  const doc = await parse('m.py', '"""Doc."""\nimport os\nclass A:\n    def m(self): pass\ndef f(): pass\n');
  assert.deepEqual(doc.metadata.functions, ['m', 'f']);
  assert.deepEqual(doc.metadata.classes, ['A']);
  assert.equal(doc.metadata.docstring, 'Doc.');
});

test('extension-less files and disabled formats', () => {
  assert.equal(parserFor('x/Dockerfile')?.id, 'text');
  assert.equal(parserFor('x/Tiltfile')?.id, 'code-generic');
  assert.equal(parserFor('a.mq4', ['.mq4']), undefined);
  assert.equal(parserFor('a.exe'), undefined);
});

test('binary content is rejected', async () => {
  await assert.rejects(parse('a.txt', Buffer.from([0x61, 0x00, 0x62])), /binary/);
});

test('chunkText respects size and makes progress', () => {
  const text = 'word '.repeat(1000);
  const chunks = chunkText(text, { chunkSize: 300, chunkOverlap: 50 });
  assert.ok(chunks.length > 10);
  assert.ok(chunks.every((c) => c.content.length <= 300));
});

test('chunkMarkdown splits on headings, ignores # inside code', () => {
  const md = `## One\n${'a '.repeat(80)}\n\n\`\`\`\n## not a heading\n\`\`\`\n\n## Two\n${'b '.repeat(80)}`;
  const chunks = chunkMarkdown(md, { chunkSize: 1000, chunkOverlap: 100 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].section, '## One');
  assert.ok(chunks[0].content.includes('## not a heading'));
  assert.equal(chunks[1].section, '## Two');
});

function png(width: number, height: number, rgba: [number, number, number, number]) {
  const img = new PNG({ width, height });
  for (let i = 0; i < img.data.length; i += 4) img.data.set(rgba, i);
  return PNG.sync.write(img, { colorType: rgba[3] === 255 ? 2 : 6 });
}

/** Minimal 16-bit PCM WAV; `extensible` writes a WAVE_FORMAT_EXTENSIBLE header. */
function wav(seconds: number, { rate = 16000, channels = 1, tag = 1, bits = 16, extensible = false } = {}) {
  const fmt = Buffer.alloc(extensible ? 48 : 24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(fmt.length - 8, 4);
  fmt.writeUInt16LE(extensible ? 0xfffe : tag, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE((rate * channels * bits) / 8, 16);
  fmt.writeUInt16LE((channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  if (extensible) {
    fmt.writeUInt16LE(22, 24);
    fmt.writeUInt16LE(tag, 32);
  }
  const data = Buffer.alloc(Math.round(seconds * rate) * (channels * bits) / 8);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + fmt.length + 8 + data.length, 4);
  head.write('WAVE', 8, 'latin1');
  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0, 'latin1');
  dataHead.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, fmt, dataHead, data]);
}

test('image: detects format from content and reads dimensions', async () => {
  const doc = await parse('photo.jpg', png(320, 200, [10, 20, 30, 255])); // PNG with a .jpg name
  assert.deepEqual(doc.metadata, { format: 'png', width: 320, height: 200 });
  assert.equal(doc.media?.length, 1);
  assert.equal(doc.media![0].kind, 'image');

  // JPEG: APP0 segment, then SOF2 (progressive) with height 480, width 640.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, ...Array(9).fill(0)]);
  const jpeg = await parse('a.jpeg', Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]));
  assert.deepEqual(jpeg.metadata, { format: 'jpeg', width: 640, height: 480 });
});

test('image: flattens transparent PNG onto white, passes opaque PNG through', async () => {
  const opaque = png(100, 100, [0, 0, 0, 255]);
  assert.equal((await parse('o.png', opaque)).media![0].data, opaque);
  const flat = PNG.sync.read((await parse('t.png', png(100, 100, [0, 0, 0, 0]))).media![0].data);
  assert.deepEqual([...flat.data.subarray(0, 4)], [255, 255, 255, 255]);
});

test('image: skips tiny images, rejects unsupported formats', async () => {
  assert.match((await parse('icon.png', png(32, 32, [0, 0, 0, 255]))).skip ?? '', /too small/);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(16)]);
  await assert.rejects(parse('photo.png', heic), /Not a PNG, JPEG, GIF or WebP/);
});

test('audio: overlapping windows, last one aligned to the end', () => {
  assert.deepEqual(windowStarts(10), [0]);
  assert.deepEqual(windowStarts(32), [0, 2]);
  assert.deepEqual(windowStarts(80), [0, 25, 50]);
});

test('audio: splits WAV into valid WAV windows', async () => {
  const doc = await parse('talk.wav', wav(65, { extensible: true, channels: 2 }));
  assert.equal(doc.metadata.durationSeconds, 65);
  assert.deepEqual(doc.media?.map((m) => m.section), ['00:00–00:30', '00:25–00:55', '00:35–01:05']);
  const w = doc.media![0].data;
  assert.equal(w.toString('latin1', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(4), w.length - 8);
  assert.equal(w.readUInt32LE(w.length - 30 * 16000 * 4 - 4), 30 * 16000 * 4); // data chunk size
});

test('audio: rejects encodings the model cannot decode', async () => {
  await assert.rejects(parse('a.wav', wav(1, { tag: 7, bits: 8 })), /μ-law/);
  await assert.rejects(parse('a.wav', wav(1, { tag: 3, bits: 64 })), /64-bit float/);
  assert.match((await parse('a.wav', wav(0.1))).skip ?? '', /too short/);
});
