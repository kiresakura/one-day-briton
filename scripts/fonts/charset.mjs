// 自行託管字型要涵蓋哪些字元。建置（build-fonts.py）與檢查（check.mjs）都從這裡取字表，兩邊不會不一致。
//
// 用法（在專案根目錄執行）：
//   node scripts/fonts/charset.mjs cjk          印出 Noto Serif TC 要涵蓋的字元（UTF-8 純文字，最後一個換行不算）
//   node scripts/fonts/charset.mjs latin        印出 Cinzel 與 Cormorant Garamond 要涵蓋的字元
//   node scripts/fonts/charset.mjs cjk --json   改印碼位（整數）陣列；建置腳本讀的是這個
//   node scripts/fonts/charset.mjs stats        印出字數統計（JSON），包括只出現在 JS 註解裡的漢字
//
// 中文字表 = 下列檔案裡出現過的每一個字元（控制字元除外）＋ 常用全形標點 ＋ 全形數字 ＋ 可列印 ASCII：
//   play/index.html、play/js/ 底下所有 .js（含子資料夾）、play/data/*.json。
// 原始碼裡用跳脫寫法表示的字元也算：JS／JSON 的 ×、\u{1F3B2}、\x41，HTML 的 &#215;、&#xD7;、&times;。
// 拉丁字表是固定的：可列印 ASCII ＋ LATIN_EXTRA。
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// 常用的全形標點與符號：現在的文字沒用到，之後改文案也很可能用到，先做進字型。
export const CJK_PUNCTUATION =
  '，。、；：！？「」『』（）《》〈〉【】〔〕…—～·・／＋－％＃＆＊＝　' + '‧⋯“”‘’．※〜';
export const FULLWIDTH_DIGITS = '０１２３４５６７８９';
export const PRINTABLE_ASCII = String.fromCharCode(...Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i));
// 拉丁字型（標題、數字用）額外要的符號；字型原檔沒有的會記在 fallback-chars.json，由系統字型顯示。
export const LATIN_EXTRA = '§✶·–—‘’“”…×';

const SKIP = /[\p{Cc}\p{Cs}]/u;
const HAN = /\p{Script=Han}/u;

// 依碼位排序，不受語系設定影響。
export function sortChars(chars) {
  return [...chars].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
}

export function charsIn(text) {
  const set = new Set();
  for (const ch of text) if (!SKIP.test(ch)) set.add(ch);
  return set;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', times: '×', divide: '÷', middot: '·',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«',
  raquo: '»', sect: '§', para: '¶', copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', bull: '•',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', hearts: '♥', diams: '♦', clubs: '♣', spades: '♠',
};

// 把跳脫寫法換回字元，回傳換完的文字（原文裡的字元仍然另外算）。
function decodeEscapes(text) {
  return text
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (m, braced, u4, x2) => {
      const cp = parseInt(braced ?? u4 ?? x2, 16);
      if (braced !== undefined) return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      return String.fromCharCode(cp); // 連續兩個 🎲 會自然接成一個字
    })
    .replace(/&#(\d{1,7});|&#[xX]([0-9a-fA-F]{1,6});|&([a-zA-Z]+);/g, (m, dec, hex, name) => {
      if (name !== undefined) return NAMED_ENTITIES[name] ?? m;
      const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
}

function textChars(text) {
  const set = charsIn(text);
  for (const ch of charsIn(decodeEscapes(text))) set.add(ch);
  return set;
}

async function walk(dir, rel) {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(...(await walk(join(dir, entry.name), `${rel}/${entry.name}`)));
    else if (entry.isFile()) files.push(`${rel}/${entry.name}`);
  }
  return files;
}

// 要掃描的檔案（相對專案根目錄、用 / 分隔），順序固定。
export async function sourceFiles(root = ROOT) {
  const js = (await walk(join(root, 'play/js'), 'play/js')).filter((f) => f.endsWith('.js'));
  const data = (await readdir(join(root, 'play/data'), { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => `play/data/${e.name}`)
    .sort();
  return ['play/index.html', ...js, ...data];
}

async function readSources(root) {
  const files = await sourceFiles(root);
  return Promise.all(files.map(async (file) => ({ file, text: (await readFile(join(root, file), 'utf8')).replace(/^﻿/, '') })));
}

function fixedCjkGroups() {
  return [
    ['固定字表：常用全形標點', CJK_PUNCTUATION],
    ['固定字表：全形數字', FULLWIDTH_DIGITS],
    ['固定字表：可列印 ASCII', PRINTABLE_ASCII],
  ];
}

// 每個字元出現在哪些地方：Map(字元 → 出處陣列)。出處是檔案路徑，或「固定字表：…」、「--extra-text」。
export async function cjkCharSources({ root = ROOT, extraText = '', withoutJsComments = false } = {}) {
  const sources = new Map();
  const add = (chars, label) => {
    for (const ch of chars) {
      if (!sources.has(ch)) sources.set(ch, []);
      sources.get(ch).push(label);
    }
  };
  for (const { file, text } of await readSources(root)) {
    add(textChars(withoutJsComments && file.endsWith('.js') ? splitJsComments(text).code : text), file);
  }
  for (const [label, chars] of fixedCjkGroups()) add(charsIn(chars), label);
  if (extraText) add(textChars(extraText), '--extra-text');
  return sources;
}

export async function cjkChars(options = {}) {
  return sortChars((await cjkCharSources(options)).keys());
}

export function latinCharSources() {
  const sources = new Map();
  for (const ch of charsIn(PRINTABLE_ASCII)) sources.set(ch, ['固定字表：可列印 ASCII']);
  for (const ch of charsIn(LATIN_EXTRA)) sources.set(ch, [...(sources.get(ch) ?? []), '固定字表：拉丁額外符號']);
  return sources;
}

export function latinChars() {
  return sortChars(latinCharSources().keys());
}

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const WORD_CHAR = /[\p{ID_Continue}$‌‍]/u;

// 把 JS 原始碼拆成程式與註解兩部分，只用來統計「只出現在註解裡的字」。
// 註解在 code 裡換成空白（保留換行），所以 code 仍是可解析的 JS。
// / 是除號還是正規表示式，看前一個記號判斷（一般寫法都判斷得對）。
export function splitJsComments(src) {
  const code = [];
  const comments = [];
  let prev = '';
  let i = 0;
  const regexAllowed = () => {
    if (prev === '') return true;
    if (prev === 'literal') return false;
    if (WORD_CHAR.test(prev[0])) return REGEX_AFTER_WORD.has(prev);
    return !(prev === ')' || prev === ']' || prev === '}');
  };
  const skipQuoted = (j, quote) => {
    for (j += 1; j < src.length; j += 1) {
      if (src[j] === '\\') j += 1;
      else if (src[j] === quote) return j + 1;
      else if (src[j] === '\n') return j;
    }
    return j;
  };
  const skipRegex = (j) => {
    let inClass = false;
    for (j += 1; j < src.length; j += 1) {
      const c = src[j];
      if (c === '\\') j += 1;
      else if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { j += 1; break; }
      else if (c === '\n') break;
    }
    while (j < src.length && /[a-z]/i.test(src[j])) j += 1;
    return j;
  };
  const scanTemplate = () => {
    let start = i;
    for (i += 1; i < src.length; i += 1) {
      const c = src[i];
      if (c === '\\') i += 1;
      else if (c === '`') { i += 1; break; }
      else if (c === '$' && src[i + 1] === '{') {
        code.push(src.slice(start, i + 2));
        i += 2;
        prev = '(';
        scanCode(true);
        start = i; // 停在 } 上，這個 } 跟後面的模板文字一起放回 code
      }
    }
    code.push(src.slice(start, i));
    prev = 'literal';
  };
  const scanCode = (inTemplate) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const next = src[i + 1];
      if (c === '/' && next === '/') {
        const end = src.indexOf('\n', i);
        const stop = end === -1 ? src.length : end;
        comments.push(src.slice(i, stop));
        i = stop;
      } else if (c === '/' && next === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? src.length : end + 2;
        const text = src.slice(i, stop);
        comments.push(text);
        code.push(text.replace(/[^\n]/g, ' '));
        i = stop;
      } else if (c === '"' || c === "'") {
        const end = skipQuoted(i, c);
        code.push(src.slice(i, end));
        i = end;
        prev = 'literal';
      } else if (c === '`') {
        scanTemplate();
      } else if (c === '/' && regexAllowed()) {
        const end = skipRegex(i);
        code.push(src.slice(i, end));
        i = end;
        prev = 'literal';
      } else if (/\s/.test(c)) {
        code.push(c);
        i += 1;
      } else if (WORD_CHAR.test(c)) {
        let end = i + 1;
        while (end < src.length && WORD_CHAR.test(src[end])) end += 1;
        prev = src.slice(i, end);
        code.push(prev);
        i = end;
      } else {
        if (inTemplate && c === '{') depth += 1;
        if (inTemplate && c === '}') {
          if (depth === 0) return;
          depth -= 1;
        }
        code.push(c);
        prev = c;
        i += 1;
      }
    }
  };
  scanCode(false);
  return { code: code.join(''), comments: comments.join('\n') };
}

export async function stats({ root = ROOT } = {}) {
  const all = await cjkChars({ root });
  const noComments = new Set(await cjkChars({ root, withoutJsComments: true }));
  const han = all.filter((ch) => HAN.test(ch));
  const commentOnly = all.filter((ch) => !noComments.has(ch));
  return {
    files: await sourceFiles(root),
    cjk: {
      total: all.length,
      han: han.length,
      hanWithoutCommentOnly: han.filter((ch) => noComments.has(ch)).length,
      commentOnly: commentOnly.join(''),
      commentOnlyHan: commentOnly.filter((ch) => HAN.test(ch)).length,
    },
    latin: { total: latinChars().length },
  };
}

async function main(args) {
  const [mode, ...flags] = args;
  const json = flags.includes('--json');
  const unknown = flags.filter((f) => f !== '--json');
  if (unknown.length || !['cjk', 'latin', 'stats'].includes(mode)) {
    console.error('用法：node scripts/fonts/charset.mjs cjk|latin [--json]，或 node scripts/fonts/charset.mjs stats');
    return 2;
  }
  if (mode === 'stats') {
    process.stdout.write(`${JSON.stringify(await stats(), null, 2)}\n`);
    return 0;
  }
  const chars = mode === 'cjk' ? await cjkChars() : latinChars();
  process.stdout.write(json ? `${JSON.stringify(chars.map((ch) => ch.codePointAt(0)))}\n` : `${chars.join('')}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
