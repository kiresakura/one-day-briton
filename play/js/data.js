// 卡牌資料檔（play/data/*.json）的格式定義與檢查。純函式：不碰檔案、不碰網路，
// 瀏覽器與 Node 的腳本、測試共用同一份。每一欄的意思見 docs/DATA-FORMAT.md。
import { PHASES, PHASE_LABELS } from './rules.js';

export const DATA_FILES = ['settings', 'roles', 'actions', 'bills', 'events', 'destinies', 'tutorial'];
export const DATA_LABELS = {
  settings: '設定',
  roles: '階層',
  actions: '行動牌',
  bills: '法案',
  events: '事件',
  destinies: '隱藏天命',
  tutorial: '教學提示',
};
// 匯入時可以沒有的資料：沒給、資料夾裡也還沒有時寫成空陣列。
export const OPTIONAL_FILES = ['tutorial'];

export const ROLE_COUNT = 6;
export const EFFECT_OPS = ['pounds', 'influence', 'fog', 'draw', 'discard', 'cancel', 'steal'];
// role＝某個階層的玩家（另寫 role 欄）；originalPlayer＝被回應的那張牌是誰出的。
export const EFFECT_TARGETS = ['self', 'all', 'others', 'chosen', 'role', 'originalPlayer'];
// 偷（steal）：只能用在行動牌，一般牌從 @指定、響應卡從 @出牌者 那裡拿走英鎊或影響力（企劃 10/15）。
export const STEAL_RESOURCES = ['pounds', 'influence'];
// 法案與事件沒有「出牌的人」，自己、其他人都沒有對象。
export const TABLE_TARGETS = ['all', 'chosen', 'role'];
// 一般牌輪到自己時出；響應卡在別人出牌後插話打出。
export const ACTION_KINDS = ['play', 'response'];
export const EVENT_KINDS = ['deck', 'fog'];
export const FOG_AMOUNT_MAX = 100;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// 設定檔的每一項：key 是 JSON 裡的位置（點號表示下一層），label 是試算表上的項目名稱。
// 有 default 的是選填項目：試算表沒有這一列時，匯入寫入 default 並提醒一聲；資料檔沒有這一項時，檢查不報錯，
// 遊戲讀檔時補上 default（withDefaultSettings）。之後新加的設定都做成選填。
// list 是數字的清單：有 size 的是固定項數、照順序各管一項（例如豪賭的第 1–3 層），不用由小到大；沒有 size 的要由小到大、不重複。
export const SETTINGS = [
  { key: 'startingHand', label: '起始手牌', min: 0 },
  { key: 'startingPounds', label: '起始英鎊', min: 0 },
  { key: 'startingInfluence', label: '起始影響力', min: 0 },
  { key: 'handLimit', label: '手牌上限', min: 1 },
  { key: 'drawPerSunrise', label: '日出抽牌', min: 0 },
  { key: 'maxPlaysPerTurn', label: '每輪最多出牌', min: 1 },
  { key: 'reminderSeconds.sunrise', label: '日出提醒秒數', min: 1 },
  { key: 'reminderSeconds.day', label: '白晝每人提醒秒數', min: 1 },
  { key: 'reminderSeconds.dusk', label: '黃昏提醒秒數', min: 1 },
  { key: 'reminderSeconds.night', label: '黑夜提醒秒數', min: 1 },
  { key: 'duskRevealSeconds', label: '黃昏揭曉倒數秒數', min: 0 },
  { key: 'fogThresholds', label: '迷霧門檻', min: 0, max: 100, list: true },
  { key: 'sunsetMinutes', label: '日落鐘分鐘數', min: 1 },
  { key: 'responseSeconds', label: '響應等待秒數', min: 1, default: 5 },
  // 每回合日出每桌翻幾張一般事件，0＝不翻（企劃 10/15 回「照建議」，暫定）。
  { key: 'sunriseEvents', label: '日出一般事件張數', min: 0, default: 1 },
  // 黑夜（企劃 10/15 第 8 題雛形，暫定）：全員送出後倒數幾秒揭曉；豪賭第 1–3 層各自擲到幾點以下（含）就爆、過關時累積變成多少英鎊與
  // 影響力；爆了另付的醫藥費；分贓平分的英鎊與每人記的罪孽。
  { key: 'nightRevealSeconds', label: '黑夜揭曉倒數秒數', min: 0, max: 60, default: 3 },
  { key: 'gambleBust', label: '豪賭爆掉點數', min: 0, max: 6, list: true, size: 3, default: [1, 2, 3] },
  { key: 'gamblePounds', label: '豪賭累積英鎊', min: 0, list: true, size: 3, default: [5, 20, 30] },
  { key: 'gambleInfluence', label: '豪賭累積影響力', min: 0, list: true, size: 3, default: [0, 1, 1] },
  { key: 'gambleMedicalFee', label: '豪賭醫藥費', min: 0, default: 2 },
  { key: 'splitPounds', label: '分贓英鎊', min: 0, default: 6 },
  { key: 'splitSin', label: '分贓罪孽', min: 0, default: 1 },
];

// 補上資料檔沒寫的選填設定（用 default），回傳新的物件；遊戲讀到的設定永遠是齊的。settings 不是物件時原樣回傳，交給檢查報錯。
export function withDefaultSettings(settings) {
  if (!isPlainObject(settings)) return settings;
  const result = structuredClone(settings);
  for (const setting of SETTINGS) {
    if ('default' in setting && getPath(result, setting.key) === undefined) {
      const keys = setting.key.split('.');
      const last = keys.pop();
      let target = result;
      for (const key of keys) target = isPlainObject(target[key]) ? target[key] : (target[key] = {});
      target[last] = structuredClone(setting.default);
    }
  }
  return result;
}

const FIELDS = {
  roles: ['id', 'name', 'salary', 'privileges', 'missions'],
  actions: ['id', 'name', 'kind', 'category', 'respondsTo', 'role', 'copies', 'cost', 'gear', 'effects', 'text', 'todo', 'todoText'],
  bills: ['id', 'name', 'year', 'onPass', 'onFail', 'text', 'todo', 'todoText'],
  events: ['id', 'name', 'year', 'kind', 'threshold', 'effects', 'text', 'todo', 'todoText'],
  destinies: ['id', 'role', 'text', 'score'],
  tutorial: ['id', 'phase', 'text'],
};

const EFFECT_FIELDS = { actions: ['effects'], bills: ['onPass', 'onFail'], events: ['effects'] };

// 錯誤訊息裡附上試算表的欄名，填資料的人比較好對照。
const COMMON_LABELS = { id: '編號', name: '名稱', year: '年代', text: '牌面文字', todo: '效果', todoText: '效果' };
const FIELD_LABELS = {
  settings: { ...Object.fromEntries(SETTINGS.map(({ key, label }) => [key, label])), reminderSeconds: '提醒秒數' },
  roles: { ...COMMON_LABELS, salary: '薪水', privileges: '特權', missions: '使命' },
  actions: {
    ...COMMON_LABELS,
    kind: '類型',
    category: '分類',
    respondsTo: '可回應',
    role: '所屬階層',
    copies: '張數',
    cost: '成本',
    'cost.pounds': '英鎊成本',
    'cost.influence': '影響力成本',
    gear: '齒輪',
    effects: '效果',
  },
  bills: { ...COMMON_LABELS, onPass: '通過時效果', onFail: '不通過時效果' },
  events: { ...COMMON_LABELS, kind: '類型', threshold: '門檻', effects: '效果' },
  destinies: { ...COMMON_LABELS, role: '所屬階層', text: '天命文字', score: '計分', 'score.text': '計分條件', 'score.points': '分數' },
  tutorial: { ...COMMON_LABELS, phase: '階段', text: '提示文字' },
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(value) {
  if (value === undefined) return '（沒有這一欄）';
  if (typeof value === 'string') return `「${value}」`;
  return JSON.stringify(value);
}

// 錯誤訊息的結尾：「現在是 0」「現在是「五」」「現在沒有這一欄」。
function now(value) {
  if (value === undefined) return '現在沒有這一欄';
  return typeof value === 'string' ? `現在是${show(value)}` : `現在是 ${show(value)}`;
}

function getPath(object, path) {
  return path.split('.').reduce((value, key) => (isPlainObject(value) ? value[key] : undefined), object);
}

function rangeText(min, max) {
  return max === undefined ? `${min} 以上的整數` : `${min}–${max} 的整數`;
}

function inRange(value, min, max) {
  return Number.isInteger(value) && value >= min && (max === undefined || value <= max);
}

// 一筆資料的錯誤與警告都記在同一個地方，訊息帶著檔名、第幾筆、編號與欄位。
function reporter(result, file, index, record) {
  const id = isPlainObject(record) && typeof record.id === 'string' && record.id !== '' ? record.id : null;
  const add = (list) => (field, message) =>
    list.push({ file: `${file}.json`, index, id, field, label: FIELD_LABELS[file]?.[field] ?? null, message });
  return { error: add(result.errors), warn: add(result.warnings) };
}

function checkUnknownFields(record, allowed, warn, prefix = '') {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) warn(`${prefix}${key}`, '不認得的欄位，遊戲不會用到');
  }
}

function checkInteger(record, field, min, max, error) {
  const value = getPath(record, field);
  if (!inRange(value, min, max)) error(field, `要是 ${rangeText(min, max)}，${now(value)}`);
}

function checkText(record, field, error) {
  const value = getPath(record, field);
  if (typeof value !== 'string' || value.trim() === '') error(field, `必填，要是不空白的文字，${now(value)}`);
}

// 可空的欄位一樣要寫出來，沒有就填 null，遊戲讀到的每筆資料長相才會一致。
function checkNullableText(record, field, error) {
  const value = record[field];
  if (value === null) return;
  if (typeof value !== 'string' || value.trim() === '') error(field, `要是不空白的文字，沒有就填 null，${now(value)}`);
}

function checkRoleRef(record, roleIds, error) {
  const value = record.role;
  if (value === null) return;
  if (typeof value !== 'string' || value === '') {
    error('role', `要是階層編號，沒有就填 null，${now(value)}`);
  } else if (roleIds && !roleIds.has(value)) {
    error('role', `找不到階層編號${show(value)}`);
  }
}

function checkTextList(record, field, error) {
  const value = record[field];
  if (!Array.isArray(value)) return error(field, `要是文字的陣列，${now(value)}`);
  value.forEach((item, position) => {
    if (typeof item !== 'string' || item.trim() === '') error(field, `第 ${position + 1} 項要是不空白的文字，${now(item)}`);
  });
}

// targets：這種牌可用的對象；action：是不是行動牌（只有行動牌能偷）；response：是不是響應卡（只有響應卡能抵銷、能針對出牌者）；
// roleIds：階層編號。
function checkEffects(record, field, { targets, action = false, response = false, roleIds }, error, warn) {
  const effects = record[field];
  if (!Array.isArray(effects)) return error(field, `要是效果的陣列，沒有效果就填 []，${now(effects)}`);
  effects.forEach((effect, position) => {
    const where = `第 ${position + 1} 個效果`;
    if (!isPlainObject(effect)) return error(field, `${where}要是物件，${now(effect)}`);
    const { op, target, amount } = effect;
    if (!EFFECT_OPS.includes(op)) return error(field, `${where}的 op 不認得：${show(op)}，只能是 ${EFFECT_OPS.join('／')}`);
    let allowed = ['op', 'target', 'amount'];
    if (op === 'steal') {
      // 偷：對方實際少多少、自己就拿多少（企劃 10/15）。法案與事件沒有出牌的人，不能偷。
      allowed = [...allowed, 'resource'];
      if (!action) {
        error(field, `${where}：偷（steal）只能用在行動牌`);
      } else if (target === 'originalPlayer' && !response) {
        error(field, `${where}：@出牌者（originalPlayer）只能用在響應卡`);
      } else if (target !== (response ? 'originalPlayer' : 'chosen')) {
        error(field, `${where}：${response ? '響應卡的偷只能對 @出牌者（originalPlayer）' : '一般牌的偷只能對 @指定（chosen）'}，${now(target)}`);
      }
      if (!STEAL_RESOURCES.includes(effect.resource)) {
        error(field, `${where}：偷的 resource 只能是 ${STEAL_RESOURCES.join('／')}（英鎊／影響力），${now(effect.resource)}`);
      }
      if (!inRange(amount, 1)) error(field, `${where}：偷的 amount 要是 1 以上的整數，${now(amount)}`);
    } else if (op === 'cancel') {
      if (!response) error(field, `${where}：抵銷（cancel）只能用在響應卡`);
      if ('target' in effect || 'amount' in effect) error(field, `${where}：抵銷不寫 target 和 amount`);
    } else if (op === 'fog') {
      if ('target' in effect) error(field, `${where}：迷霧是全桌一個值，不寫 target`);
      if (!Number.isInteger(amount) || !inRange(Math.abs(amount), 1, FOG_AMOUNT_MAX)) {
        error(field, `${where}：迷霧的 amount 要是 -${FOG_AMOUNT_MAX}～${FOG_AMOUNT_MAX}、不是 0 的整數，${now(amount)}`);
      }
    } else {
      if (!EFFECT_TARGETS.includes(target)) {
        error(field, `${where}的 target 不認得：${show(target)}，只能是 ${EFFECT_TARGETS.join('／')}`);
      } else if (target === 'originalPlayer' && !response) {
        error(field, `${where}：@出牌者（originalPlayer）只能用在響應卡`);
      } else if (!targets.includes(target)) {
        error(field, `${where}：${field === 'effects' ? '事件' : '法案'}沒有出牌的人，target 只能是 ${targets.join('／')}，${now(target)}`);
      }
      if (target === 'role') {
        allowed = [...allowed, 'role'];
        if (typeof effect.role !== 'string' || effect.role === '') {
          error(field, `${where}：target 是 role 時要在 role 寫階層編號，${now(effect.role)}`);
        } else if (roleIds && !roleIds.has(effect.role)) {
          error(field, `${where}：找不到階層編號${show(effect.role)}`);
        }
      }
      if (op === 'draw' || op === 'discard') {
        if (!inRange(amount, 1)) error(field, `${where}：${op} 的 amount 要是 1 以上的整數，${now(amount)}`);
      } else if (!Number.isInteger(amount) || amount === 0) {
        error(field, `${where}：${op} 的 amount 要是不是 0 的整數（正數是拿、負數是付），${now(amount)}`);
      }
    }
    checkUnknownFields(effect, allowed, (key) => warn(field, `${where}有不認得的欄位 ${key}`));
  });
}

// todo＝效果還寫不成結構（原文放 todoText），只列警告；遊戲先不結算這張的效果。
function checkTodo(record, file, error, warn) {
  if ('todo' in record && typeof record.todo !== 'boolean') error('todo', `只能是 true 或 false，${now(record.todo)}`);
  if ('todoText' in record && typeof record.todoText !== 'string') error('todoText', `要是文字，${now(record.todoText)}`);
  if (record.todo === true) {
    warn('todo', `效果還沒換算成結構（todo）${typeof record.todoText === 'string' && record.todoText ? `：${show(record.todoText)}` : ''}`);
  } else if (EFFECT_FIELDS[file].every((field) => Array.isArray(record[field]) && record[field].length === 0)) {
    warn(EFFECT_FIELDS[file][0], '沒有任何效果；如果是故意的可以不管');
  }
}

function checkIds(file, list, result) {
  const seen = new Map();
  list.forEach((record, index) => {
    if (!isPlainObject(record)) return;
    const { error } = reporter(result, file, index, record);
    const { id } = record;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      error('id', `必填，只能用英文字母、數字、- 和 _，最多 32 個字，${now(id)}`);
    } else if (seen.has(id)) {
      error('id', `和第 ${seen.get(id) + 1} 筆重複`);
    } else {
      seen.set(id, index);
    }
  });
  return new Set(seen.keys());
}

function checkSettings(settings, result) {
  const { error, warn } = reporter(result, 'settings', null, null);
  if (!isPlainObject(settings)) return error(null, '最外層要是物件 { … }');
  for (const setting of SETTINGS) {
    const { key, min, max, list } = setting;
    // 選填項目可以沒寫（遊戲用 default）；有寫就要能用。
    if ('default' in setting && getPath(settings, key) === undefined) continue;
    if (!list) {
      checkInteger(settings, key, min, max, error);
      continue;
    }
    const value = getPath(settings, key);
    if (setting.size) {
      if (!Array.isArray(value) || value.length !== setting.size || !value.every((item) => inRange(item, min, max))) {
        error(key, `要是 ${setting.size} 個 ${rangeText(min, max)}，照順序寫，例如 ${setting.default.join('、')}，${now(value)}`);
      }
      continue;
    }
    if (!Array.isArray(value) || value.length === 0 || !value.every((item) => inRange(item, min, max))) {
      error(key, `要是 ${rangeText(min, max)}陣列，例如 [30, 60, 90]，${now(value)}`);
    } else if (!value.every((item, position) => position === 0 || item > value[position - 1])) {
      error(key, `要由小到大排、不可重複，${now(value)}`);
    }
  }
  const topLevel = [...new Set(SETTINGS.map(({ key }) => key.split('.')[0]))];
  checkUnknownFields(settings, topLevel, warn);
  if (isPlainObject(settings.reminderSeconds)) {
    const phases = SETTINGS.filter(({ key }) => key.startsWith('reminderSeconds.')).map(({ key }) => key.split('.')[1]);
    checkUnknownFields(settings.reminderSeconds, phases, warn, 'reminderSeconds.');
  }
}

function checkRole(record, context, error) {
  checkText(record, 'name', error);
  checkInteger(record, 'salary', 0, undefined, error);
  checkTextList(record, 'privileges', error);
  checkTextList(record, 'missions', error);
}

// respondsTo 只有響應卡才有：null＝任何牌都能回應；否則是分類的陣列，別人出的牌分類在裡面才能回應。
function checkKind(record, categories, error, warn) {
  const { kind, respondsTo } = record;
  if (!ACTION_KINDS.includes(kind)) {
    error('kind', `只能是 play（一般牌）或 response（響應卡），${now(kind)}`);
  } else if (kind === 'play') {
    if (respondsTo !== undefined && respondsTo !== null) error('respondsTo', `一般牌不填可回應，${now(respondsTo)}`);
  } else if (respondsTo === undefined) {
    error('respondsTo', '響應卡要寫可回應哪些分類，任何牌都能回應就填 null');
  } else if (respondsTo !== null && (!Array.isArray(respondsTo) || respondsTo.length === 0)) {
    error('respondsTo', `要是分類的陣列，任何牌都能回應就填 null，${now(respondsTo)}`);
  } else {
    (respondsTo ?? []).forEach((item, position) => {
      if (typeof item !== 'string' || item.trim() === '') {
        error('respondsTo', `第 ${position + 1} 項要是不空白的文字，${now(item)}`);
      } else if (categories && !categories.has(item)) {
        warn('respondsTo', `沒有任何行動牌的分類是${show(item)}，這一項回應不到任何牌`);
      }
    });
  }
}

function checkAction(record, { roleIds, categories }, error, warn) {
  checkText(record, 'name', error);
  checkKind(record, categories, error, warn);
  checkNullableText(record, 'category', error);
  checkRoleRef(record, roleIds, error);
  checkInteger(record, 'copies', 1, undefined, error);
  if (!isPlainObject(record.cost)) {
    error('cost', `要是 { "pounds": 數字, "influence": 數字 }，${now(record.cost)}`);
  } else {
    checkInteger(record, 'cost.pounds', 0, undefined, error);
    checkInteger(record, 'cost.influence', 0, undefined, error);
    checkUnknownFields(record.cost, ['pounds', 'influence'], warn, 'cost.');
  }
  checkNullableText(record, 'gear', error);
  checkEffects(record, 'effects', { targets: EFFECT_TARGETS, action: true, response: record.kind === 'response', roleIds }, error, warn);
  checkText(record, 'text', error);
}

function checkBill(record, { roleIds }, error, warn) {
  checkText(record, 'name', error);
  checkNullableText(record, 'year', error);
  checkEffects(record, 'onPass', { targets: TABLE_TARGETS, roleIds }, error, warn);
  checkEffects(record, 'onFail', { targets: TABLE_TARGETS, roleIds }, error, warn);
  checkText(record, 'text', error);
}

function checkEvent(record, { fogThresholds, roleIds }, error, warn) {
  checkText(record, 'name', error);
  checkNullableText(record, 'year', error);
  if (!EVENT_KINDS.includes(record.kind)) {
    error('kind', `只能是 deck（一般事件）或 fog（迷霧門檻事件），${now(record.kind)}`);
  } else if (record.kind === 'fog') {
    if (record.threshold === undefined || record.threshold === null) error('threshold', '迷霧事件一定要有門檻');
    else checkInteger(record, 'threshold', 0, 100, error);
    if (inRange(record.threshold, 0, 100) && fogThresholds && !fogThresholds.includes(record.threshold)) {
      warn('threshold', `設定的迷霧門檻（${fogThresholds.join('／')}）裡沒有 ${record.threshold}，這張不會被觸發`);
    }
  } else if (record.threshold !== undefined && record.threshold !== null) {
    error('threshold', `一般事件不填門檻，${now(record.threshold)}`);
  }
  checkEffects(record, 'effects', { targets: TABLE_TARGETS, roleIds }, error, warn);
  checkText(record, 'text', error);
}

function checkDestiny(record, { roleIds }, error, warn) {
  checkRoleRef(record, roleIds, error);
  checkText(record, 'text', error);
  if (!isPlainObject(record.score)) {
    error('score', `要是 { "text": 計分條件, "points": 分數或 null }，${now(record.score)}`);
    return;
  }
  checkText(record, 'score.text', error);
  if (record.score.points !== null && !inRange(record.score.points, 0)) {
    error('score.points', `要是 0 以上的整數，還沒定就填 null，${now(record.score.points)}`);
  }
  checkUnknownFields(record.score, ['text', 'points'], warn, 'score.');
}

// 教學提示：第一場第一回合各階段顯示的說明；同一階段有好幾筆時照編號順序顯示。
function checkTip(record, context, error) {
  if (!PHASES.includes(record.phase)) {
    error('phase', `只能是 ${PHASES.map((phase) => `${phase}（${PHASE_LABELS[phase]}）`).join('／')}，${now(record.phase)}`);
  }
  checkText(record, 'text', error);
}

const RECORD_CHECKS = {
  roles: checkRole,
  actions: checkAction,
  bills: checkBill,
  events: checkEvent,
  destinies: checkDestiny,
  tutorial: checkTip,
};

// data＝{ settings, roles, actions, bills, events, destinies, tutorial }，缺的檔不檢查（讀檔的人自己報）。
// 回傳 { errors, warnings }，每一筆是 { file, index, id, field, label, message }。
export function checkData(data) {
  const result = { errors: [], warnings: [] };
  if ('settings' in data) checkSettings(data.settings, result);

  const context = {};
  const settingsThresholds = getPath(data.settings, 'fogThresholds');
  if (Array.isArray(settingsThresholds)) context.fogThresholds = settingsThresholds;

  const lists = {};
  for (const file of DATA_FILES.slice(1)) {
    if (!(file in data)) continue;
    if (!Array.isArray(data[file])) {
      reporter(result, file, null, null).error(null, '最外層要是陣列 [ … ]');
      continue;
    }
    lists[file] = data[file];
  }
  if (lists.roles) context.roleIds = checkIds('roles', lists.roles, result);
  if (lists.actions) {
    const categories = lists.actions.map((record) => (isPlainObject(record) ? record.category : null));
    context.categories = new Set(categories.filter((value) => typeof value === 'string' && value.trim() !== ''));
  }

  for (const [file, list] of Object.entries(lists)) {
    if (file !== 'roles') checkIds(file, list, result);
    list.forEach((record, index) => {
      const { error, warn } = reporter(result, file, index, record);
      if (!isPlainObject(record)) return error(null, `每一筆要是物件 { … }，${now(record)}`);
      checkUnknownFields(record, FIELDS[file], warn);
      RECORD_CHECKS[file](record, context, error, warn);
      if (EFFECT_FIELDS[file]) checkTodo(record, file, error, warn);
    });
  }
  if (lists.roles && lists.roles.length !== ROLE_COUNT) {
    reporter(result, 'roles', null, null).warn(null, `規則是 ${ROLE_COUNT} 個階層，現在有 ${lists.roles.length} 個`);
  }
  return result;
}

// 一行一筆：等級｜檔名｜編號（或第幾筆）｜欄位（欄名）｜原因。source 是額外的出處，例如「events.csv 第 5 列」。
export function formatIssue(issue, level = '錯誤', source = null) {
  const record = issue.id ?? (issue.index === null ? null : `第 ${issue.index + 1} 筆`);
  const where = [record, source && `（${source}）`].filter(Boolean).join('');
  const field = issue.field && (issue.label ? `${issue.field}（${issue.label}）` : issue.field);
  return [level, issue.file, where, field, issue.message].filter(Boolean).join('｜');
}
