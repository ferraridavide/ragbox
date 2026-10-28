import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { chunkMarkdown, chunkText } from '../src/chunker.js';
import { parserFor } from '../src/parsers/index.js';
import { stripHujson } from '../src/parsers/hujson.js';

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
