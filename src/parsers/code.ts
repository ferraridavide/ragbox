import type { Parser } from './types.js';
import { decodeText, matchAll, stem } from './shared/text.js';

// Source code with per-language regexes for docstring, functions, classes and
// imports. Language profiles ported from knowledge-rag (MIT).

interface LanguageProfile {
  language: string;
  docstring: RegExp;
  functions: RegExp;
  classes: RegExp;
  imports: RegExp;
}

const C_DOC = /^\s*\/\*\*([\s\S]*?)\*\//;
const C_INCLUDE = /^#include\s+[<"][\w./]+[>"]?/gm;
const JS: LanguageProfile = {
  language: 'javascript',
  docstring: C_DOC,
  functions: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/gm,
  classes: /^(?:export\s+)?(?:default\s+)?class\s+(\w+)/gm,
  imports: /^(?:import\s+.+|(?:const|let|var)\s+.*?=\s*require\s*\(.*)/gm,
};
const TS: LanguageProfile = {
  language: 'typescript',
  docstring: C_DOC,
  functions: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/gm,
  classes: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|enum|type)\s+(\w+)/gm,
  imports: /^import\s+.+/gm,
};
const C: LanguageProfile = {
  language: 'c',
  docstring: C_DOC,
  functions: /^(?:[\w*]+\s+)+\**(\w+)\s*\([^;]*$/gm,
  classes: /^(?:typedef\s+)?(?:struct|union|enum)\s+(\w+)/gm,
  imports: C_INCLUDE,
};
const CPP: LanguageProfile = {
  language: 'cpp',
  docstring: C_DOC,
  functions: /^(?:[\w*:&<>]+\s+)+\**(\w+)\s*\([^;]*$/gm,
  classes: /^(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(\w+)/gm,
  imports: C_INCLUDE,
};
const MQL: LanguageProfile = {
  language: 'mql4',
  docstring: C_DOC,
  functions: /^(?:[\w*]+\s+)+(\w+)\s*\(/gm,
  classes: /^class\s+(\w+)/gm,
  imports: /^#(?:include|property)\s+.+/gm,
};

const PROFILES: Record<string, LanguageProfile> = {
  '.py': {
    language: 'python',
    docstring: /^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/,
    functions: /^\s*(?:async\s+)?def\s+(\w+)\s*\(/gm,
    classes: /^\s*class\s+(\w+)\s*[:(]/gm,
    imports: /^(?:from\s+[\w.]+\s+)?import\s+[\w.,\s*]+/gm,
  },
  '.c': C,
  '.h': { ...C, functions: /^(?:[\w*]+\s+)+\**(\w+)\s*\(/gm },
  '.cpp': CPP,
  '.cc': CPP,
  '.hpp': CPP,
  '.js': JS,
  '.jsx': JS,
  '.mjs': JS,
  '.cjs': JS,
  '.ts': TS,
  '.tsx': TS,
  '.mts': TS,
  '.cts': TS,
  '.java': {
    language: 'java',
    docstring: C_DOC,
    functions: /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)*[\w<>\[\],\s]+\s+(\w+)\s*\([^;]*$/gm,
    classes: /^\s*(?:(?:public|private|protected|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record)\s+(\w+)/gm,
    imports: /^(?:import|package)\s+.+/gm,
  },
  '.cs': {
    language: 'csharp',
    docstring: /^\s*\/\/\/([\s\S]*?)\n(?!\s*\/\/\/)/,
    functions: /^\s*(?:(?:public|private|protected|internal|static|async|virtual|override|abstract|sealed)\s+)+[\w<>\[\],?\s]+\s+(\w+)\s*\(/gm,
    classes: /^\s*(?:(?:public|private|protected|internal|static|abstract|sealed|partial)\s+)*(?:class|interface|enum|struct|record)\s+(\w+)/gm,
    imports: /^(?:using|namespace)\s+.+/gm,
  },
  '.mq4': MQL,
  '.mqh': MQL,
};

export const codeParser: Parser = {
  id: 'code',
  label: 'Source code (Python, C/C++, JS/TS, Java, C#, MQL4)',
  extensions: Object.keys(PROFILES),
  async parse({ buffer, name, ext }) {
    const text = decodeText(buffer);
    const profile = PROFILES[ext];
    const docstring = text.match(profile.docstring)?.[1]?.trim();
    return {
      text,
      title: stem(name),
      structure: 'plain',
      metadata: {
        language: profile.language,
        docstring: docstring ? docstring.slice(0, 500) : undefined,
        functions: matchAll(text, profile.functions),
        classes: matchAll(text, profile.classes),
        imports: matchAll(text, profile.imports, 10).map((s) => s.trim()),
      },
    };
  },
};
