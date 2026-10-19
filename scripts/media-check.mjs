// 檢查投影端的影音素材（play/media/）：npm run media:check。
// 照 screen-model.js 的 MEDIA 表（素材規格 SPEC 4.6 的大小上限）：表上的檔都在、每個不超過 limit、合計 40 MB 以內；
// play/media/credits.json 列到的檔都在，play/media/ 的每個檔（credits.json 自己除外）都有列，列了 bytes、sha256 的要跟檔案一樣；
// 不在 MEDIA 表上的檔（投影端不會用）不放。
// 有 ffprobe 時再查格式：開場影片 H.264＋AAC、60 秒內；背景影片 H.264、沒有音軌、10–20 秒；鐘聲、槌聲、開場音樂的長度。
// 底圖（WebP）的 1920×1080 直接讀檔頭，不靠 ffprobe。沒有 ffprobe 時印一行提示，影片與聲音只查大小與清單。
// 有錯誤就逐筆列出並以 1 結束。
// 用法：npm run media:check（預設檢查 play/media/），或 npm run media:check -- <資料夾>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA } from '../play/js/ui/screen-model.js';

export const TOTAL_LIMIT = 40_000_000;

// 格式規則（SPEC 4.6）：codec 是 ffprobe 的 codec_name；audio: null＝不能有音軌。秒數是 [最短, 最長]。
export const FORMAT = {
  'opening.mp4': { video: 'h264', audio: 'aac', seconds: [0, 60] },
  'loop-1.mp4': { video: 'h264', audio: null, seconds: [10, 20] },
  'loop-2.mp4': { video: 'h264', audio: null, seconds: [10, 20] },
  'loop-3.mp4': { video: 'h264', audio: null, seconds: [10, 20] },
  'bell.mp3': { audio: 'mp3', seconds: [0, 6] },
  'gavel.mp3': { audio: 'mp3', seconds: [0, 2] },
  'music-opening.mp3': { audio: 'mp3', seconds: [90, 180] },
  'bg-title.webp': { width: 1920, height: 1080 },
  'bg-rules.webp': { width: 1920, height: 1080 },
};

// WebP 檔頭的畫面大小（VP8X、VP8、VP8L 三種）；讀不出來回傳 null。
export function webpSize(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

// credits.json 的每筆 files（格式同 play/assets/credits.json）→ Map(檔名 → [{ bytes, sha256 }])。
function listedFiles(list) {
  const files = new Map();
  for (const entry of Array.isArray(list) ? list : []) {
    for (const file of Array.isArray(entry?.files) ? entry.files : []) {
      const path = typeof file === 'string' ? file : file?.path;
      if (typeof path !== 'string' || !path) continue;
      const name = path.split('/').pop();
      if (!files.has(name)) files.set(name, []);
      files.get(name).push(typeof file === 'string' ? {} : file);
    }
  }
  return files;
}

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', file], { encoding: 'utf8' });
  const json = JSON.parse(out);
  const streams = json.streams ?? [];
  return {
    video: streams.filter((s) => s.codec_type === 'video').map((s) => s.codec_name),
    audio: streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name),
    seconds: Number(json.format?.duration),
  };
}

export function hasFfprobe() {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// → { errors: [文字], notes: [文字], total, count }
export function checkMediaFolder(dir, { ffprobe = hasFfprobe() } = {}) {
  const errors = [];
  const notes = [];
  const present = readdirSync(dir).filter((name) => !name.startsWith('.') && statSync(join(dir, name)).isFile());
  const known = new Map(MEDIA.map((item) => [item.file, item]));
  let total = 0;
  for (const name of present) {
    const item = known.get(name);
    const { size } = statSync(join(dir, name));
    total += size;
    if (!item) errors.push(`${name}：不在 MEDIA 表上（投影端不會用），不要放進 play/media/`);
    else if (size > item.limit) errors.push(`${name}：${size} 位元組，超過上限 ${item.limit}`);
  }
  for (const item of MEDIA) if (!present.includes(item.file)) errors.push(`${item.file}（${item.use}）：檔案不在`);
  if (total > TOTAL_LIMIT) errors.push(`合計 ${total} 位元組，超過 ${TOTAL_LIMIT}`);

  let list = null;
  if (present.includes('credits.json')) {
    try {
      list = JSON.parse(readFileSync(join(dir, 'credits.json'), 'utf8'));
    } catch (error) {
      errors.push(`credits.json：讀不出來（${error.message}）`);
    }
  }
  if (list) {
    const listed = listedFiles(list);
    for (const [name, records] of listed) {
      if (!present.includes(name)) {
        errors.push(`credits.json 列了 ${name}，但檔案不在`);
        continue;
      }
      const buffer = readFileSync(join(dir, name));
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      for (const record of records) {
        if (record.bytes !== undefined && record.bytes !== buffer.length) errors.push(`${name}：credits.json 寫 ${record.bytes} 位元組，檔案是 ${buffer.length}`);
        if (record.sha256 !== undefined && record.sha256 !== sha256) errors.push(`${name}：credits.json 的 sha256 跟檔案不同`);
      }
    }
    for (const name of present) if (name !== 'credits.json' && !listed.has(name)) errors.push(`${name}：credits.json 沒有列`);
  }

  for (const [name, rule] of Object.entries(FORMAT)) {
    if (!present.includes(name)) continue;
    const file = join(dir, name);
    if (rule.width) {
      const size = webpSize(readFileSync(file));
      if (!size) errors.push(`${name}：讀不出 WebP 的畫面大小`);
      else if (size.width !== rule.width || size.height !== rule.height) errors.push(`${name}：${size.width}×${size.height}，要 ${rule.width}×${rule.height}`);
      continue;
    }
    if (!ffprobe) continue;
    let info;
    try {
      info = probe(file);
    } catch (error) {
      errors.push(`${name}：ffprobe 讀不出來（${String(error.message).split('\n')[0]}）`);
      continue;
    }
    if (rule.video && (info.video.length !== 1 || info.video[0] !== rule.video)) errors.push(`${name}：影像 ${info.video.join('、') || '沒有'}，要 ${rule.video}`);
    if (rule.audio === null && info.audio.length) errors.push(`${name}：有音軌（${info.audio.join('、')}），背景影片不能有聲音`);
    if (rule.audio && (info.audio.length !== 1 || info.audio[0] !== rule.audio)) errors.push(`${name}：聲音 ${info.audio.join('、') || '沒有'}，要 ${rule.audio}`);
    const [min, max] = rule.seconds;
    if (!Number.isFinite(info.seconds)) errors.push(`${name}：讀不出長度`);
    else if (info.seconds < min || info.seconds > max) errors.push(`${name}：${info.seconds.toFixed(2)} 秒，要 ${min ? `${min}–` : ''}${max} 秒${min ? '' : '以內'}`);
    else notes.push(`${name} ${info.seconds.toFixed(2)} 秒`);
  }
  if (!ffprobe) notes.push('找不到 ffprobe：影片與聲音的格式、長度沒有查（只查了大小與清單）；裝了 ffmpeg 再跑一次');
  return { errors, notes, total, count: present.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? fileURLToPath(new URL('../play/media/', import.meta.url)));
  const result = checkMediaFolder(dir);
  console.log(`檢查 ${relative(process.cwd(), dir) || '.'}：${result.count} 個檔，合計 ${(result.total / 1e6).toFixed(1)} MB（上限 ${TOTAL_LIMIT / 1e6} MB）`);
  for (const note of result.notes) console.log(`  ${note}`);
  for (const error of result.errors) console.log(`錯誤：${error}`);
  console.log(`錯誤 ${result.errors.length} 筆`);
  process.exitCode = result.errors.length ? 1 : 0;
}
