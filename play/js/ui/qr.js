// QR Code 產生器：標題頁的加入網址用（不向外部要任何檔）。
// 授權與來源：本專案自己照 ISO/IEC 18004 公開規格寫的，沒有引用或改寫外部程式碼，授權同本專案其他程式碼。
// QR Code is a registered trademark of DENSO WAVE INCORPORATED.
// 只做：位元組模式（UTF-8）、錯誤更正等級 M、版本 1–10（M 等級最多 213 個位元組，網址夠用）；照規格的八種遮罩算扣分，挑最低的。
// qrMatrix 是純函式（Node 測試直接呼叫），qrSvg 才碰 DOM。

// 版本 1–10、等級 M 的區塊：[每塊的更正碼字數, [[塊數, 每塊資料碼字數], …]]（ISO/IEC 18004 表 9）。
const BLOCKS_M = [
  null,
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];
// 對齊圖案正中間的座標（版本 1 沒有）。
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const MAX_VERSION = 10;
const LEVEL_M = 0; // 格式資訊裡等級 M 的兩個位元是 00

// ---- GF(256)（本原多項式 x^8 + x^4 + x^3 + x^2 + 1）與 Reed–Solomon ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let power = 0; power < 255; power += 1) {
    EXP[power] = value;
    LOG[value] = power;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let power = 255; power < 512; power += 1) EXP[power] = EXP[power - 255];
}

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

// 生成多項式 (x − 2^0)(x − 2^1)…(x − 2^(n−1))（在 GF(256) 裡算）的係數（最高次在前，首項 1 不寫）。
function generator(count) {
  let poly = [1];
  for (let i = 0; i < count; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly.slice(1);
}

// 資料碼字除以生成多項式的餘數＝更正碼字。
function correction(data, count) {
  const gen = generator(count);
  const rest = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ rest.shift();
    rest.push(0);
    if (factor !== 0) for (let i = 0; i < count; i += 1) rest[i] ^= gfMul(gen[i], factor);
  }
  return rest;
}

// ---- 編碼 ----

function utf8(text) {
  return [...new TextEncoder().encode(String(text))];
}

function dataCapacity(version) {
  const [, groups] = BLOCKS_M[version];
  return groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

// 位元組模式：模式 0100、字數（版本 1–9 是 8 位元，10 起 16 位元）、資料、結尾 0000、補到整個位元組、補 0xEC 0x11。
function codewords(bytes, version) {
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  const capacity = dataCapacity(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  for (let pad = 0; out.length < dataCapacity(version); pad += 1) out.push(pad % 2 === 0 ? 0xec : 0x11);
  return out;
}

// 分塊、每塊算更正碼字，再照規格交錯排：先逐位取各塊的資料碼字，再逐位取各塊的更正碼字。
function interleave(data, version) {
  const [ecCount, groups] = BLOCKS_M[version];
  const blocks = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i += 1) {
      const part = data.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: part, ec: correction(part, ecCount) });
    }
  }
  const out = [];
  const longest = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < longest; i += 1) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  for (let i = 0; i < ecCount; i += 1) for (const block of blocks) out.push(block.ec[i]);
  return out;
}

// ---- 排版 ----

function emptyGrid(size) {
  return Array.from({ length: size }, () => new Array(size).fill(false));
}

// 功能圖案（三個角的定位圖案、分隔、定時、對齊、格式與版本資訊的位置、暗模組）。modules[row][col]；reserved 標出不能放資料的格子。
function functionPatterns(version) {
  const size = version * 4 + 17;
  const modules = emptyGrid(size);
  const reserved = emptyGrid(size);
  const set = (row, col, dark) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    modules[row][col] = dark;
    reserved[row][col] = true;
  };
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [row, col] of [
    [3, 3],
    [3, size - 4],
    [size - 4, 3],
  ]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        set(row + dy, col + dx, ring !== 2 && ring !== 4);
      }
    }
  }
  const centers = ALIGN[version];
  for (const row of centers) {
    for (const col of centers) {
      const nearFinder = (row === 6 && col === 6) || (row === 6 && col === centers[centers.length - 1]) || (row === centers[centers.length - 1] && col === 6);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(row + dy, col + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  // 格式資訊的位置先保留（之後依遮罩寫入），暗模組固定是暗的。
  for (let i = 0; i < 9; i += 1) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  set(size - 8, 8, true);
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(b, a, dark);
      set(a, b, dark);
    }
  }
  return { size, modules, reserved };
}

// BCH(18,6) 版本資訊（版本 7 以上）。
function versionBits(version) {
  let rest = version;
  for (let i = 0; i < 12; i += 1) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25);
  return (version << 12) | rest;
}

// BCH(15,5) 格式資訊（等級＋遮罩），再跟 101010000010010 做 XOR。
export function formatBits(mask, level = LEVEL_M) {
  const data = (level << 3) | mask;
  let rest = data;
  for (let i = 0; i < 10; i += 1) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
  return ((data << 10) | rest) ^ 0x5412;
}

function placeFormat(modules, size, mask) {
  const bits = formatBits(mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) modules[i][8] = bit(i);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i < 15; i += 1) modules[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i += 1) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i += 1) modules[size - 15 + i][8] = bit(i);
  modules[size - 8][8] = true;
}

// 資料位元由右下角起，兩欄一組上下來回填，跳過第 6 欄（定時圖案）與保留的格子。
function placeData(modules, reserved, size, bytes) {
  let index = 0;
  const total = bytes.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        if (reserved[row][col]) continue;
        modules[row][col] = index < total && ((bytes[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
        index += 1;
      }
    }
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(modules, reserved, size, mask) {
  const rule = MASKS[mask];
  for (let row = 0; row < size; row += 1) for (let col = 0; col < size; col += 1) if (!reserved[row][col] && rule(row, col)) modules[row][col] = !modules[row][col];
}

// 規格的四項扣分：連續同色、2×2 同色、像定位圖案的 1:1:3:1:1、暗模組比例。
function penalty(modules, size) {
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i += 1) {
    lines.push(modules[i]);
    lines.push(modules.map((row) => row[i]));
  }
  const finderA = [true, false, true, true, true, false, true, false, false, false, false];
  const finderB = [false, false, false, false, true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) run += 1;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    for (let i = -4; i < size; i += 1) {
      const at = (k) => (i + k >= 0 && i + k < size ? line[i + k] : false);
      if (finderA.every((dark, k) => at(k) === dark) || finderB.every((dark, k) => at(k) === dark)) score += 40;
    }
  }
  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (modules[row][col]) dark += 1;
      if (row + 1 < size && col + 1 < size) {
        const color = modules[row][col];
        if (modules[row][col + 1] === color && modules[row + 1][col] === color && modules[row + 1][col + 1] === color) score += 3;
      }
    }
  }
  const total = size * size;
  score += 10 * (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1);
  return score;
}

// 文字 → { version, size, mask, modules }（modules[row][col]：true 是暗模組，不含外面的空白邊）。太長（超過版本 10）丟 RangeError。
// mask 給 0–7 就用那個遮罩（測試用），不給就照扣分挑。
export function qrMatrix(text, { mask = null } = {}) {
  const bytes = utf8(text);
  let version = 1;
  while (version <= MAX_VERSION && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCapacity(version) * 8) version += 1;
  if (version > MAX_VERSION) throw new RangeError(`QR 碼放不下 ${bytes.length} 個位元組`);
  const stream = interleave(codewords(bytes, version), version);
  const base = functionPatterns(version);
  const build = (choice) => {
    const modules = base.modules.map((row) => [...row]);
    placeData(modules, base.reserved, base.size, stream);
    applyMask(modules, base.reserved, base.size, choice);
    placeFormat(modules, base.size, choice);
    return modules;
  };
  if (Number.isInteger(mask)) return { version, size: base.size, mask, modules: build(mask) };
  let best = null;
  for (let choice = 0; choice < 8; choice += 1) {
    const modules = build(choice);
    const score = penalty(modules, base.size);
    if (!best || score < best.score) best = { score, mask: choice, modules };
  }
  return { version, size: base.size, mask: best.mask, modules: best.modules };
}

// 畫成 SVG（四邊留 4 格空白；一列裡連續的暗模組合成一段，路徑比較短）。同一段文字的路徑只算一次（投影每秒重畫）。
const paths = new Map();

function qrPath(text) {
  if (paths.has(text)) return paths.get(text);
  const { size, modules } = qrMatrix(text);
  const quiet = 4;
  let path = '';
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!modules[row][col]) continue;
      let end = col;
      while (end + 1 < size && modules[row][end + 1]) end += 1;
      path += `M${col + quiet} ${row + quiet}h${end - col + 1}v1h-${end - col + 1}z`;
      col = end;
    }
  }
  const result = { size: size + quiet * 2, path };
  paths.set(text, result);
  return result;
}

export function qrSvg(text) {
  const { size, path } = qrPath(text);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  const background = document.createElementNS(ns, 'rect');
  background.setAttribute('width', String(size));
  background.setAttribute('height', String(size));
  background.setAttribute('fill', '#fff');
  const dark = document.createElementNS(ns, 'path');
  dark.setAttribute('d', path);
  dark.setAttribute('fill', '#000');
  svg.append(background, dark);
  return svg;
}
