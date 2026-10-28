import type { Parser } from './types.js';
import { decodeText, matchAll, stem } from './shared/text.js';

// Languages without a dedicated profile: Go, Rust, Kotlin, CUE, Rego, Starlark
// (Tiltfile, Bazel) and a few others. Heuristic regexes cover the common
// function/type/import declaration styles. Ported from knowledge-rag (MIT).

const LANGUAGES: Record<string, string> = {
  '.go': 'go',
  '.rs': 'rust',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cue': 'cue',
  '.rego': 'rego',
  '.swift': 'swift',
  '.scala': 'scala',
  '.rb': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
  '.dart': 'dart',
  '.tf': 'terraform',
  '.bzl': 'starlark',
  '.star': 'starlark',
  Tiltfile: 'starlark',
  BUILD: 'starlark',
  'BUILD.bazel': 'starlark',
};

const FUNCTION_RE = /^\s*(?:[\w]+\s+)*(?:func(?:\s+\([^)]*\))?|fn|fun|def|function)\s+(\w+)/gm;
const TYPE_RE = /^\s*(?:\w+\s+)*(?:class|interface|object)\s+(\w+)|^\s*(?:\w+\s+)*(?:struct|enum|trait|protocol)\s+(\w+)|^type\s+(\w+)\s+(?:struct|interface)\b|^resource\s+"[\w-]+"\s+"([\w-]+)"/gm;
const IMPORT_RE = /^(?:import|package|use|require|load\(|module\s)/;

export const genericCodeParser: Parser = {
  id: 'code-generic',
  label: 'Source code (Go, Rust, Kotlin, CUE, Rego, Starlark, ...)',
  extensions: Object.keys(LANGUAGES).filter((k) => k.startsWith('.')),
  filenames: Object.keys(LANGUAGES).filter((k) => !k.startsWith('.')),
  async parse({ buffer, name, ext }) {
    const text = decodeText(buffer);
    const imports = text
      .split('\n', 200)
      .map((l) => l.trim())
      .filter((l) => IMPORT_RE.test(l))
      .slice(0, 20);
    return {
      text,
      title: stem(name),
      structure: 'plain',
      metadata: {
        language: LANGUAGES[ext] ?? LANGUAGES[name] ?? 'unknown',
        functions: matchAll(text, FUNCTION_RE),
        classes: matchAll(text, TYPE_RE),
        imports,
      },
    };
  },
};
