// 檢查 play/fonts/ 的 woff2 字型有沒有涵蓋畫面上會用到的每一個字（npm run fonts:check）。
// 只用 Node 內建模組：直接讀字型檔，解析 WOFF2 表頭與表格目錄，用 node:zlib 解開 brotli，
// 找出 cmap 表、讀格式 4 與 12 的子表，得到字型實際涵蓋的碼位，再跟 charset.mjs 算出的字表比對。
// 字型原檔本來就沒有的字（記在 fallback-chars.json，由系統字型顯示）只印成提示，不算缺字。
// 有缺字就逐字列出碼位與出現在哪些檔，並以 1 結束；全部涵蓋以 0 結束。
//
// 用法：npm run fonts:check
//       npm run fonts:check -- --extra-text=龘   多要求幾個字（加進中文字表），用來確認檢查本身會抓到缺字
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { ROOT, cjkCharSources, latinCharSources, sortChars } from './charset.mjs';

const FONTS_DIR = join(ROOT, 'play/fonts');
const FALLBACK_FILE = join(ROOT, 'scripts/fonts/fallback-chars.json');

// 每個字型檔要涵蓋哪一份字表（跟 build-fonts.py 的設定對應）。
export const FONTS = [
  { file: 'NotoSerifTC-Bold.woff2', charset: 'cjk' },
  { file: 'NotoSerifTC-Black.woff2', charset: 'cjk' },
  { file: 'Cinzel-Bold.woff2', charset: 'latin' },
  { file: 'CormorantGaramond-SemiBold.woff2', charset: 'latin' },
];

// WOFF2 表格目錄裡「已知表格」的編號（規格 Table 1，0–62；63 代表後面接 4 位元組的表格名稱）。
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ',
  'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS',
  'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc',
  'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
  'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

// 解析 WOFF2：回傳 { flavor, tables: [{ tag, origLength, storedLength, transformed, offset }], data }。
// data 是解開後的表格資料；各表格在 data 裡依目錄順序緊接著存放，不補齊。
export function readWoff2(buf) {
  if (buf.length < 48 || buf.readUInt32BE(0) !== 0x774f4632) throw new Error('不是 WOFF2 檔（開頭不是 wOF2）');
  const flavor = buf.readUInt32BE(4);
  const length = buf.readUInt32BE(8);
  const numTables = buf.readUInt16BE(12);
  const totalCompressedSize = buf.readUInt32BE(20);
  if (length !== buf.length) throw new Error(`表頭記的檔案長度 ${length} 跟實際的 ${buf.length} 不同`);
  if (flavor === 0x74746366) throw new Error('不支援字型集合（ttcf）');
  let p = 48;
  const readBase128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      if (p >= buf.length) throw new Error('表格目錄被截斷');
      const byte = buf[p];
      p += 1;
      if (i === 0 && byte === 0x80) throw new Error('UIntBase128 有前導零');
      if (value > 0x1ffffff) throw new Error('UIntBase128 超過 32 位元');
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('UIntBase128 超過 5 個位元組');
  };
  const tables = [];
  for (let n = 0; n < numTables; n += 1) {
    const flags = buf[p];
    p += 1;
    const index = flags & 0x3f;
    let tag;
    if (index === 63) {
      tag = buf.toString('latin1', p, p + 4);
      p += 4;
    } else {
      tag = KNOWN_TAGS[index];
    }
    const version = flags >> 6;
    const origLength = readBase128();
    // glyf／loca 的版本 0 是有轉換、3 是沒轉換；其他表格反過來，0 是沒轉換。有轉換才會多一個 transformLength。
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0;
    const storedLength = transformed ? readBase128() : origLength;
    tables.push({ tag, version, origLength, storedLength, transformed });
  }
  if (p + totalCompressedSize > buf.length) throw new Error('壓縮資料比檔案還長');
  const data = brotliDecompressSync(buf.subarray(p, p + totalCompressedSize));
  let offset = 0;
  for (const table of tables) {
    table.offset = offset;
    offset += table.storedLength;
  }
  if (offset !== data.length) throw new Error(`解壓後 ${data.length} 位元組，跟表格長度總和 ${offset} 不同`);
  return { flavor, tables, data };
}

// 讀 cmap 表的格式 4 與 12 子表（Unicode 編碼），回傳對應到非 0 字形的碼位集合。
export function cmapCodePoints(cmap) {
  const view = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const u16 = (at) => view.getUint16(at);
  const u32 = (at) => view.getUint32(at);
  const points = new Set();
  const formats = [];
  const seen = new Set();
  const numTables = u16(2);
  for (let i = 0; i < numTables; i += 1) {
    const platform = u16(4 + i * 8);
    const encoding = u16(6 + i * 8);
    const offset = u32(8 + i * 8);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || seen.has(offset)) continue;
    seen.add(offset);
    const format = u16(offset);
    formats.push(`${platform}/${encoding}:${format}`);
    if (format === 4) {
      const segX2 = u16(offset + 6);
      const ends = offset + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s += 1) {
        const end = u16(ends + s * 2);
        const start = u16(starts + s * 2);
        const delta = u16(deltas + s * 2);
        const rangeOffset = u16(ranges + s * 2);
        for (let c = start; c <= end; c += 1) {
          if (c === 0xffff) continue;
          let gid;
          if (rangeOffset === 0) {
            gid = (c + delta) & 0xffff;
          } else {
            gid = u16(ranges + s * 2 + rangeOffset + (c - start) * 2);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          if (gid !== 0) points.add(c);
        }
      }
    } else if (format === 12) {
      const groups = u32(offset + 12);
      for (let g = 0; g < groups; g += 1) {
        const at = offset + 16 + g * 12;
        const start = u32(at);
        const end = u32(at + 4);
        const startGid = u32(at + 8);
        for (let c = start; c <= end; c += 1) if (startGid + (c - start) !== 0) points.add(c);
      }
    }
  }
  return { points, formats };
}

export function woff2CodePoints(buf) {
  const { tables, data } = readWoff2(buf);
  const cmap = tables.find((t) => t.tag === 'cmap');
  if (!cmap) throw new Error('找不到 cmap 表');
  if (cmap.transformed) throw new Error('cmap 表不該經過轉換');
  return cmapCodePoints(data.subarray(cmap.offset, cmap.offset + cmap.origLength));
}

const code = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
const show = (ch) => (/[\p{Z}\p{M}\p{Cf}]/u.test(ch) ? code(ch) : `「${ch}」${code(ch)}`);

async function loadFallback() {
  try {
    return JSON.parse(await readFile(FALLBACK_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function parseArgs(args) {
  let extraText = '';
  for (const arg of args) {
    if (arg.startsWith('--extra-text=')) extraText += arg.slice('--extra-text='.length);
    else return null;
  }
  return { extraText };
}

async function main(args) {
  const options = parseArgs(args);
  if (!options) {
    console.error('用法：node scripts/fonts/check.mjs [--extra-text=要多檢查的字]');
    return 2;
  }
  const required = {
    cjk: await cjkCharSources({ extraText: options.extraText }),
    latin: latinCharSources(),
  };
  const fallback = await loadFallback();
  let failed = false;

  const present = (await readdir(FONTS_DIR).catch(() => [])).filter((f) => f.endsWith('.woff2'));
  for (const file of present) {
    if (!FONTS.some((font) => font.file === file)) {
      console.log(`錯誤：play/fonts/${file} 不在檢查清單裡（check.mjs 的 FONTS）`);
      failed = true;
    }
  }

  for (const { file, charset } of FONTS) {
    const sources = required[charset];
    let points;
    try {
      ({ points } = woff2CodePoints(await readFile(join(FONTS_DIR, file))));
    } catch (error) {
      console.log(`${file}：讀不了（${error.code === 'ENOENT' ? '找不到這個檔' : error.message}），請先跑建置`);
      failed = true;
      continue;
    }
    const fallbackChars = new Set((fallback[file] ?? []).map((entry) => entry.char));
    const uncovered = sortChars([...sources.keys()].filter((ch) => !points.has(ch.codePointAt(0))));
    const viaSystem = uncovered.filter((ch) => fallbackChars.has(ch));
    const missing = uncovered.filter((ch) => !fallbackChars.has(ch));
    console.log(
      `${file}：需要 ${sources.size} 字，字型涵蓋 ${sources.size - uncovered.length} 字，` +
        `原檔沒有、交給系統字型 ${viaSystem.length} 字，缺 ${missing.length} 字`,
    );
    if (viaSystem.length) console.log(`  提示：原檔沒有的字 ${viaSystem.map(show).join(' ')}`);
    for (const ch of missing) console.log(`  缺 ${show(ch)}，出現在：${sources.get(ch).join('、')}`);
    if (missing.length) failed = true;
  }

  if (failed) console.log('有缺字或字型讀不了：請跑 .tools/fontenv/bin/python scripts/fonts/build-fonts.py 重新產生字型，再跑一次這個檢查');
  else console.log('字型檢查通過');
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
