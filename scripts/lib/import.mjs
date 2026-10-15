// 試算表匯出的 CSV → 卡牌資料檔的內容。每種資料一個工作表，欄名與 docs/data-templates/ 的樣板相同。
// 這裡只做轉換：數字看不懂、編號沒填這類問題原樣留著，交給 play/js/data.js 的檢查逐筆報出來。
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DATA_FILES, DATA_LABELS, ID_PATTERN, SETTINGS } from '../../play/js/data.js';
import { PHASE_LABELS } from '../../play/js/rules.js';
import { readTable } from './csv.mjs';

const RESOURCE_WORDS = { 英鎊: 'pounds', 影響力: 'influence', 迷霧: 'fog' };
const CARD_WORDS = { 抽: 'draw', 棄: 'discard' };
export const TARGET_WORDS = { 自己: 'self', 全體: 'all', 其他人: 'others', 指定: 'chosen', 出牌者: 'originalPlayer' };
const CANCEL_WORD = '抵銷';
const ACTION_KIND_WORDS = { 一般: 'play', 一般牌: 'play', 響應: 'response', 響應卡: 'response' };
const EVENT_KIND_WORDS = { 一般: 'deck', 迷霧: 'fog' };
const PHASE_WORDS = Object.fromEntries(Object.entries(PHASE_LABELS).map(([phase, label]) => [label, phase]));
const ANY_CARD_WORDS = ['任何', '任何牌'];
const NOTE_COLUMN = '備註';

const lookup = (words, key) => (Object.hasOwn(words, key) ? words[key] : undefined);

// 全形數字與符號換成半形（＋５＠；→ +5@;），各種減號都當成 -。
function normalize(text) {
  return String(text ?? '').normalize('NFKC').replace(/[−–—]/g, '-');
}

// @對象：對象字，或是階層編號（@r2＝該階層的玩家）。編號存不存在交給檢查。
function parseTarget(targetWord, defaultTarget) {
  if (targetWord === undefined) return { target: defaultTarget };
  const target = lookup(TARGET_WORDS, targetWord);
  if (target) return { target };
  return ID_PATTERN.test(targetWord) ? { target: 'role', role: targetWord } : null;
}

function parseEffect(part, defaultTarget) {
  const [body, targetWord, ...extra] = part.split('@');
  if (extra.length > 0) return null;
  // 抵銷＝被回應的那張牌效果不發生，沒有數量也沒有對象。
  if (body === CANCEL_WORD) return targetWord === undefined ? { op: 'cancel' } : null;
  const target = parseTarget(targetWord, defaultTarget);
  const resource = /^(英鎊|影響力|迷霧)([+-]\d+)$/.exec(body);
  if (resource) {
    const op = RESOURCE_WORDS[resource[1]];
    const amount = Number(resource[2]);
    // 迷霧是全桌一個值，寫了對象反而不知道要做什麼。
    if (op === 'fog') return targetWord === undefined ? { op, amount } : null;
    return target ? { op, ...target, amount } : null;
  }
  const cards = /^(抽|棄)牌?\+?(\d+)張?$/.exec(body);
  if (cards) return target ? { op: CARD_WORDS[cards[1]], ...target, amount: Number(cards[2]) } : null;
  return null;
}

// 「英鎊+5@自己；迷霧+3」→ effects: [{ op: 'pounds', target: 'self', amount: 5 }, { op: 'fog', amount: 3 }]。
// 效果之間用分號、逗號、頓號或換行隔開；沒寫 @對象 的用 defaultTarget。看不懂的片段放進 unknown。
export function parseEffects(text, defaultTarget) {
  const effects = [];
  const unknown = [];
  for (const piece of normalize(text).split(/[;,、\r\n]+/)) {
    const part = piece.replace(/\s+/g, '').replace(/。$/, '');
    if (!part) continue;
    const effect = parseEffect(part, defaultTarget);
    if (effect) effects.push(effect);
    else unknown.push(piece.trim());
  }
  return { effects, unknown };
}

// 數字欄：空白給 empty；看得懂的數字轉成數字；其他保留原文，檢查時會報「現在是「…」」。
function number(value, empty) {
  if (value === '') return empty;
  const plain = normalize(value).trim();
  return /^[+-]?\d+(\.\d+)?$/.test(plain) ? Number(plain) : value;
}

function numberList(value) {
  if (value === '') return null;
  return normalize(value).split(/[/,、\s]+/).filter(Boolean).map((item) => number(item, null));
}

const optional = (value) => (value === '' ? null : value);
const isListColumn = (name, prefix) => new RegExp(`^${prefix}\\d*$`).test(name);

// 特權1、特權2…這種編號欄依欄的順序收成一個陣列，空白的略過。
function listColumns(values, prefix) {
  return Object.entries(values)
    .filter(([name, value]) => isListColumn(name, prefix) && value !== '')
    .map(([, value]) => value);
}

// 可回應：空白或「任何」是任何牌都能回應（null）；否則是用頓號、逗號、分號或換行隔開的分類。
function respondsTo(value) {
  if (value === '' || ANY_CARD_WORDS.includes(value)) return null;
  return value.split(/[、，,；;\n]+/).map((item) => item.trim()).filter(Boolean);
}

// columns：一定要有的欄。effects：效果欄（欄位 → 欄名），沒寫對象時用 defaultTarget。
const SHEETS = {
  settings: { columns: ['項目', '值'], extra: ['說明'] },
  roles: {
    columns: ['編號', '名稱', '薪水'],
    lists: ['特權', '使命'],
    convert: (cell) => ({
      id: cell.編號,
      name: cell.名稱,
      salary: number(cell.薪水, null),
      privileges: listColumns(cell, '特權'),
      missions: listColumns(cell, '使命'),
    }),
  },
  actions: {
    columns: ['編號', '名稱', '類型', '分類', '可回應', '所屬階層', '張數', '英鎊成本', '影響力成本', '齒輪', '效果', '牌面文字'],
    effects: { effects: '效果' },
    defaultTarget: 'self',
    convert: (cell) => {
      const kind = lookup(ACTION_KIND_WORDS, cell.類型) ?? cell.類型;
      const answers = respondsTo(cell.可回應);
      // 可回應只有響應卡才寫出來；一般牌填了也照寫，讓檢查報錯。
      const record = { id: cell.編號, name: cell.名稱, kind, category: optional(cell.分類) };
      if (kind === 'response' || answers !== null) record.respondsTo = answers;
      return {
        ...record,
        role: optional(cell.所屬階層),
        copies: number(cell.張數, null),
        cost: { pounds: number(cell.英鎊成本, 0), influence: number(cell.影響力成本, 0) },
        gear: optional(cell.齒輪),
        effects: cell.效果,
        text: cell.牌面文字,
      };
    },
  },
  bills: {
    columns: ['編號', '名稱', '年代', '通過時效果', '不通過時效果', '牌面文字'],
    effects: { onPass: '通過時效果', onFail: '不通過時效果' },
    defaultTarget: 'all',
    convert: (cell) => ({
      id: cell.編號,
      name: cell.名稱,
      year: optional(cell.年代),
      onPass: cell.通過時效果,
      onFail: cell.不通過時效果,
      text: cell.牌面文字,
    }),
  },
  events: {
    columns: ['編號', '名稱', '年代', '類型', '門檻', '效果', '牌面文字'],
    effects: { effects: '效果' },
    defaultTarget: 'all',
    convert: (cell) => {
      const kind = lookup(EVENT_KIND_WORDS, cell.類型) ?? cell.類型;
      const threshold = number(cell.門檻, null);
      // 門檻只有迷霧事件才寫出來；一般事件填了門檻也照寫，讓檢查報錯。
      const record = { id: cell.編號, name: cell.名稱, year: optional(cell.年代), kind };
      if (kind === 'fog' || threshold !== null) record.threshold = threshold;
      return { ...record, effects: cell.效果, text: cell.牌面文字 };
    },
  },
  destinies: {
    columns: ['編號', '所屬階層', '天命文字', '計分條件', '分數'],
    convert: (cell) => ({
      id: cell.編號,
      role: optional(cell.所屬階層),
      text: cell.天命文字,
      score: { text: cell.計分條件, points: number(cell.分數, null) },
    }),
  },
  tutorial: {
    columns: ['編號', '階段', '提示文字'],
    convert: (cell) => ({ id: cell.編號, phase: lookup(PHASE_WORDS, cell.階段) ?? cell.階段, text: cell.提示文字 }),
  },
};

function setPath(object, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let target = object;
  for (const key of keys) target = target[key] ??= {};
  target[last] = value;
}

// 設定是「項目／值」兩欄，一列一項；寫出的順序固定照 SETTINGS。
function convertSettings(table, file) {
  const errors = [];
  const notes = [];
  const byLabel = new Map(SETTINGS.map((setting) => [setting.label, setting]));
  const found = new Map();
  for (const { row, values } of table.rows) {
    const setting = byLabel.get(normalize(values.項目).trim());
    if (!setting) {
      notes.push(`${file} 第 ${row} 列：不認得的設定項目「${values.項目}」，略過`);
    } else if (found.has(setting.key)) {
      errors.push(`${file} 第 ${row} 列：設定項目「${setting.label}」和第 ${found.get(setting.key).row} 列重複`);
    } else {
      found.set(setting.key, { row, value: setting.list ? numberList(values.值) : number(values.值, null) });
    }
  }
  const data = {};
  const fieldRows = {};
  for (const setting of SETTINGS) {
    const { key, label } = setting;
    if (found.has(key)) {
      setPath(data, key, found.get(key).value);
      fieldRows[key] = found.get(key).row;
    } else if ('default' in setting) {
      // 選填項目沒有這一列就用預設值；必填的沒填由檢查報出來。
      setPath(data, key, setting.default);
      notes.push(`${file}：沒有「${label}」這一列，用預設值 ${setting.default}`);
    }
  }
  return { data, fieldRows, errors, notes, unknownEffects: [] };
}

// 回傳 { data, rows, errors, notes, unknownEffects }。errors 是讀不下去的問題（缺欄位、引號沒關）；
// rows[i] 是第 i 筆資料在試算表上的列號；unknownEffects 列出看不懂、標成 todo 的效果片段。
export function convertSheet(kind, text, file = `${kind}.csv`) {
  const sheet = SHEETS[kind];
  let table;
  try {
    table = readTable(text);
  } catch (error) {
    return { errors: [`${file}：${error.message}`], notes: [], unknownEffects: [] };
  }
  const missing = sheet.columns.filter((name) => !table.header.includes(name));
  if (missing.length > 0) {
    return { errors: [`${file}：少了欄位「${missing.join('」「')}」（第一列的欄名要和樣板一樣）`], notes: [], unknownEffects: [] };
  }
  const known = (name) =>
    name === NOTE_COLUMN ||
    sheet.columns.includes(name) ||
    (sheet.extra ?? []).includes(name) ||
    (sheet.lists ?? []).some((prefix) => isListColumn(name, prefix));
  const ignored = table.header.filter((name) => !known(name));
  const notes = ignored.length > 0 ? [`${file}：這幾欄不會匯入「${ignored.join('」「')}」`] : [];

  if (kind === 'settings') {
    const settings = convertSettings(table, file);
    return { ...settings, notes: [...notes, ...settings.notes] };
  }

  const unknownEffects = [];
  const effectColumns = Object.entries(sheet.effects ?? {});
  const data = table.rows.map(({ row, values }) => {
    const record = sheet.convert(values);
    const pending = [];
    for (const [field, column] of effectColumns) {
      const source = record[field];
      const { effects, unknown } = parseEffects(source, sheet.defaultTarget);
      if (unknown.length === 0) {
        record[field] = effects;
        continue;
      }
      // 一欄裡只要有看不懂的，整欄先不結算：效果留空、原文放 todoText。
      record[field] = [];
      pending.push(effectColumns.length > 1 ? `${column}：${source}` : source);
      unknownEffects.push({ row, id: record.id, column, parts: unknown });
    }
    if (pending.length > 0) Object.assign(record, { todo: true, todoText: pending.join('\n') });
    return record;
  });
  return { data, rows: table.rows.map(({ row }) => row), errors: [], notes, unknownEffects };
}

// 檔名認得「events.csv」「事件.csv」，以及 Google 試算表下載時的「試算表名稱 - 事件.csv」。
export function sheetKind(fileName) {
  const name = basename(fileName).replace(/\.csv$/i, '').normalize('NFKC');
  const candidates = new Set([name, name.split(' - ').pop()].map((part) => part.trim().toLowerCase()));
  return DATA_FILES.find((kind) => candidates.has(kind) || candidates.has(DATA_LABELS[kind])) ?? null;
}

// 讀一個資料夾裡所有的 .csv。回傳 { data, sources, skipped, errors, notes, unknownEffects }；
// sources[kind] 記著來源檔名與列號，檢查的錯誤可以對回試算表的第幾列。
export async function importFolder(dir) {
  const result = { data: {}, sources: {}, skipped: [], errors: [], notes: [], unknownEffects: [] };
  const names = (await readdir(dir)).filter((name) => /\.csv$/i.test(name)).sort();
  for (const name of names) {
    const kind = sheetKind(name);
    if (!kind) {
      result.skipped.push(name);
      continue;
    }
    if (result.sources[kind]) {
      result.errors.push(`${result.sources[kind].file} 和 ${name} 都是${DATA_LABELS[kind]}，只能留一個`);
      continue;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(join(dir, name)));
    } catch {
      result.errors.push(`${name}：不是 UTF-8 編碼，請用「CSV UTF-8」重新匯出`);
      continue;
    }
    const sheet = convertSheet(kind, text, name);
    result.errors.push(...sheet.errors);
    result.notes.push(...sheet.notes);
    if (sheet.errors.length > 0) continue;
    result.data[kind] = sheet.data;
    result.sources[kind] = { file: name, rows: sheet.rows ?? [], fieldRows: sheet.fieldRows ?? {} };
    result.unknownEffects.push(...sheet.unknownEffects.map((item) => ({ file: name, ...item })));
  }
  return result;
}

// 檢查的錯誤對回試算表：「events.csv 第 5 列」。不是這次匯入的檔回傳 null。
export function sourceOf(imported, issue) {
  const source = imported.sources[issue.file.replace(/\.json$/, '')];
  if (!source) return null;
  const row = issue.index === null ? source.fieldRows[issue.field] : source.rows[issue.index];
  return row ? `${source.file} 第 ${row} 列` : source.file;
}
