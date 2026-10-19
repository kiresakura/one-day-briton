// 主持人控制台的按鈕接線（play/js/ui/host.js）：判斷都在 host-model.js 的純函式（另有測試），這裡看處理函式與畫面有沒有照它做。
// 載入真的 host.js，把 store.js 換成記錄呼叫的替身、dom.js 換成只建節點的替身（不碰真的頁面），按真的按鈕、讀畫出來的字：
// 會幾乎直接日落的「－1」與「復原」先確認、日落後「復原」停用、全場暫停中走進最後 10 秒的鐘排到重畫、確認框開著時走進去就不送
// 手動暫停、確認框與結果條的提醒。替身只在這個測試檔的行程裡（node --test 每個檔各自一個行程）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const STORE = new URL('../../play/js/store.js', import.meta.url).href;
const DOM = new URL('../../play/js/ui/dom.js', import.meta.url).href;
const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

// ---- 只建節點的畫面：h() 建節點，patchChildren 只把新的子節點換上去 ----
class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
    this.children = [];
    this.listeners = {};
    this.text = '';
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.title = null;
    const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const save = (set) => (this.className = [...set].join(' '));
    this.classList = {
      add: (...names) => save(new Set([...classes(), ...names])),
      remove: (...names) => save(new Set([...classes()].filter((name) => !names.includes(name)))),
      toggle: (name, on) => {
        const set = classes();
        const want = on === undefined ? !set.has(name) : Boolean(on);
        if (want) set.add(name);
        else set.delete(name);
        save(set);
        return want;
      },
      contains: (name) => classes().has(name),
    };
    this.style = { setProperty() {}, removeProperty() {} };
  }
  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }
  get textContent() {
    return this.text + this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'title') this.title = String(value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  closest(selector) {
    const match = /^\[data-([a-z-]+)\]$/.exec(selector);
    return match && this.dataset[match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] !== undefined ? this : null;
  }
  contains() {
    return true;
  }
  focus() {}
  getBoundingClientRect() {
    return { top: 0, bottom: 56, left: 0, right: 1440, width: 1440, height: 56 };
  }
}
const byId = new Map();
const doc = {
  getElementById(id) {
    if (!byId.has(id)) byId.set(id, Object.assign(new El('div'), { id }));
    return byId.get(id);
  },
  createElement: (tag) => new El(tag),
  createElementNS: (ns, tag) => new El(tag),
  querySelector: () => new El('div'),
  querySelectorAll: () => [],
  addEventListener() {},
  body: new El('body'),
  documentElement: new El('html'),
  activeElement: null,
};
function h(tag, props = {}, ...children) {
  const node = new El(tag);
  const { class: className, text, data, attrs, hidden, disabled } = props ?? {};
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.text = String(text);
  for (const [key, value] of Object.entries(data ?? {})) if (value !== undefined && value !== null) node.dataset[key] = String(value);
  for (const [key, value] of Object.entries(attrs ?? {})) if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : String(value));
  if (hidden) node.hidden = true;
  if (disabled) node.disabled = true;
  const add = (list) => {
    for (const child of list) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) add(child);
      else node.children.push(child instanceof El ? child : String(child));
    }
  };
  add(children);
  return node;
}
const dom = {
  $: (id) => doc.getElementById(id),
  element: (tag, className, text) => Object.assign(new El(tag), className ? { className } : {}, text === undefined ? {} : { text: String(text) }),
  h,
  patchChildren: (parent, next) => (parent.children = next.filter(Boolean)),
};

// ---- store.js 的替身：控制台會用到的指令記下呼叫、回傳測試設定的值；serverTime 照 fake.now；其他照原本的 store.js ----
const fake = { now: NOW, calls: [], replies: {}, timers: [], dom };
globalThis.__hostWiring = fake;
const source = (code) => `data:text/javascript,${encodeURIComponent(code)}`;
const FAKE_STORE = source(`export * from ${JSON.stringify(`${STORE}?real`)};
const fake = globalThis.__hostWiring;
const call = (name) => async (...args) => {
  fake.calls.push({ name, args: args.slice(2) });
  const reply = fake.replies[name];
  return typeof reply === 'function' ? reply(...args) : reply;
};
export const serverTime = () => fake.now;
export const watchConnection = () => () => {};
export const watchSubmissions = () => () => {};
export const startSettling = () => () => {};
export const trackPresence = () => async () => {};
export const adjustClock = call('adjustClock');
export const pauseClock = call('pauseClock');
export const resumeClock = call('resumeClock');
export const setPause = call('setPause');`);
const FAKE_DOM = source(`export * from ${JSON.stringify(`${DOM}?real`)};
const { dom } = globalThis.__hostWiring;
export const $ = (id) => dom.$(id);
export const element = (...args) => dom.element(...args);
export const h = (...args) => dom.h(...args);
export const patchChildren = (...args) => dom.patchChildren(...args);
export const markTruncated = () => {};`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url === STORE) return { url: FAKE_STORE, shortCircuit: true };
    if (result.url === DOM) return { url: FAKE_DOM, shortCircuit: true };
    return result;
  },
});

globalThis.document = doc;
globalThis.window = { addEventListener() {}, innerWidth: 1440, innerHeight: 900, open() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { hostname: '127.0.0.1', search: '?env=emu' };
// 到點重畫（shared.js 的 rerenderAt）只記下毫秒數、不真的等；每秒的更新不跑。
const realInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
globalThis.setTimeout = (fn, ms) => {
  fake.timers.push(ms);
  return 0;
};
const host = await import('../../play/js/ui/host.js');
const { ctx, setRerender } = await import('../../play/js/ui/state.js');
const game = await import('../../play/js/game.js');
globalThis.setInterval = realInterval;
ctx.session = { uid: 'hostA' };
ctx.code = 'TESTAA';
setRerender(() => ctx.latestRoom && host.renderHost(ctx.latestRoom));

// ---- 找節點、按按鈕、讀字 ----
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let i = 0; i < 6; i += 1) await tick();
}
function* walk(node) {
  if (!(node instanceof El)) return;
  yield node;
  for (const child of node.children) yield* walk(child);
}
const findAll = (root, check) => [...walk(root)].filter(check);
const hasClass = (node, name) => node.className.split(/\s+/).includes(name);
const textOf = (node) => (node ? node.textContent : '');
const byAct = (act, extra = {}) =>
  [dom.$('host-console'), dom.$('host-layer')].flatMap((root) => findAll(root, (n) => n.dataset.act === act && Object.entries(extra).every(([key, value]) => n.dataset[key] === String(value))));
function click(node) {
  assert.ok(node, '找不到按鈕');
  for (const fn of dom.$('screen-host').listeners.click) fn({ target: node });
}
const dialog = () => findAll(dom.$('host-layer'), (n) => hasClass(n, 'confirm'))[0] ?? null;
const resultText = () => textOf(findAll(dom.$('host-console'), (n) => hasClass(n, 'cs-result-text'))[0]);
const clockBox = () => findAll(dom.$('host-console'), (n) => hasClass(n, 'cs-clock') && n.dataset.clock === '1')[0] ?? null;
const toggleButton = () => findAll(clockBox(), (n) => hasClass(n, 'cs-toggle'))[0] ?? null;
const sent = (name) => fake.calls.filter((call) => call.name === name).map((call) => call.args);

// 全場鐘：剩 left 毫秒（照現在的 fake.now）；paused 時在現在暫停。
function clockAt(left, { paused = false, adjust = 0, seq = 3 } = {}) {
  const anchor = fake.now - 20 * MINUTE;
  const record = { startedAt: fake.now - 50 * MINUTE, minutes: 75, anchor, remain: left + (fake.now - anchor), adjust, seq, by: 'hostA' };
  if (paused) record.pausedAt = fake.now;
  return record;
}
function roomWith(clock, pause = null) {
  return { meta: { hostUid: 'hostA', tableCount: 1 }, hosts: {}, presence: { hostA: true }, players: {}, tables: {}, games: {}, deals: {}, clock: { 1: clock }, display: pause ? { pause } : {} };
}
async function show(room) {
  ctx.latestRoom = room;
  host.renderHost(room);
  await settle();
}
async function start(at) {
  if (dialog()) click(byAct('cancel-confirm')[0]);
  fake.now = at;
  fake.calls = [];
  fake.timers = [];
  // 照 store.js 的 adjustClock：用「現在＋1.5 秒」夾，回傳實際加減的量與新的鐘。
  fake.replies.adjustClock = async (session, code, match, delta) => {
    const clock = ctx.latestRoom.clock[match];
    const next = game.clockAdjustWrite(clock, delta, fake.now + 1_500);
    return { delta: next.adjust - (clock.adjust ?? 0), clock: next };
  };
  await settle();
}

test('－1 會幾乎直接日落（剩 62 秒）先開確認框、不送；剩 71 秒直接送；暫停中剩 62 秒也直接送（還加得回來）', async () => {
  await start(NOW);
  await show(roomWith(clockAt(62_000, { seq: 5 })));
  click(byAct('clock-adjust', { match: 1, delta: -MINUTE })[0]);
  await settle();
  assert.equal(dialog()?.dataset.key, 'confirm-clock-zero');
  assert.match(textOf(dialog()), /現在剩 01:02，減 1 分之後只剩 00:02，幾乎馬上日落/);
  assert.deepEqual(sent('adjustClock'), []);

  await start(NOW + MINUTE);
  await show(roomWith(clockAt(71_000, { seq: 5 })));
  click(byAct('clock-adjust', { match: 1, delta: -MINUTE })[0]);
  await settle();
  assert.equal(dialog(), null);
  assert.deepEqual(sent('adjustClock'), [[1, -MINUTE, { expectSeq: 5 }]]);

  await start(NOW + 2 * MINUTE);
  await show(roomWith(clockAt(62_000, { paused: true, seq: 5 })));
  click(byAct('clock-adjust', { match: 1, delta: -MINUTE })[0]);
  await settle();
  assert.equal(dialog(), null);
  assert.deepEqual(sent('adjustClock'), [[1, -MINUTE, { expectSeq: 5 }]]);
});

test('復原：反方向那一下會幾乎直接日落時先確認、不送；日落後鈕停用寫原因，畫面舊了照樣按也不送', async () => {
  await start(NOW + 10 * MINUTE);
  const base = clockAt(100_000, { seq: 5 });
  await show(roomWith(base));
  click(byAct('clock-adjust', { match: 1, delta: MINUTE })[0]); // ＋1 → 剩 2:40
  await settle();
  assert.match(resultText(), /第 1 場日落鐘＋1 分/);
  const plus = game.clockAdjustWrite(base, MINUTE, fake.now + 1_500);
  fake.now += 2 * MINUTE; // 剩 40 秒
  fake.calls = [];
  await show(roomWith(plus));
  click(byAct('clock-undo')[0]);
  await settle();
  assert.equal(dialog()?.dataset.key, 'confirm-clock-zero');
  assert.match(textOf(dialog()), /現在剩 00:40，復原要減 1 分之後只剩 00:02，幾乎馬上日落/);
  assert.deepEqual(sent('adjustClock'), []);
  click(byAct('cancel-confirm')[0]);
  await settle();

  fake.now += 41_000; // 日落了
  await show(roomWith(plus));
  const undo = byAct('clock-undo')[0];
  assert.equal(undo.disabled, true);
  assert.equal(undo.title, '已經日落了，不能復原');
  undo.disabled = false; // 畫面還沒跟上、鈕還可以按的那一刻
  click(undo);
  await settle();
  assert.equal(dialog(), null);
  assert.deepEqual(sent('adjustClock'), []);
});

test('日落後「－1」「＋1」停用寫原因；畫面舊了照樣按也不送', async () => {
  await start(NOW + 15 * MINUTE);
  await show(roomWith(clockAt(-1_000, { seq: 5 })));
  for (const delta of [-MINUTE, MINUTE]) {
    const step = byAct('clock-adjust', { match: 1, delta })[0];
    assert.equal(step.disabled, true);
    assert.equal(step.title, '已經日落了，不能再暫停或加減');
    step.disabled = false; // 畫面還沒跟上、鈕還可以按的那一刻
    click(step);
    await settle();
  }
  assert.equal(dialog(), null);
  assert.deepEqual(sent('adjustClock'), []);
});

test('全場暫停中沒停住的鐘剩 15 秒：排到 5 秒後重畫；那時面板變快日落、⏸ 停用並寫原因', async () => {
  await start(NOW + 20 * MINUTE);
  const room = roomWith(clockAt(15_000, { seq: 4 }), { on: true, seq: 3, at: fake.now - 2_000, by: 'hostA' });
  await show(room);
  assert.ok(fake.timers.includes(5_050), `排到的重畫：${fake.timers.join(', ')}`);
  assert.equal(toggleButton().disabled, false);
  assert.match(textOf(clockBox()), /沒被全場暫停停住（可手動暫停）/);
  fake.now += 5_050; // 排到的那一刻
  await show(room);
  assert.equal(toggleButton().disabled, true);
  assert.equal(toggleButton().title, '快日落・照常日落、不停');
  assert.match(textOf(clockBox()), /快日落・照常日落、不停/);
});

test('「暫停日落鐘？」框：沒停住的鐘多寫恢復時不會自動繼續；框開著時走進最後 10 秒，按確認不送、框改寫原因', async () => {
  await start(NOW + 30 * MINUTE);
  const room = roomWith(clockAt(12_000, { seq: 4 }), { on: true, seq: 3, at: fake.now - 2_000, by: 'hostA' });
  await show(room);
  click(byAct('clock-pause', { match: 1 })[0]);
  await settle();
  assert.equal(dialog()?.dataset.key, 'confirm-clock-toggle');
  assert.match(textOf(dialog()), /全場恢復時不會自動繼續，要記得手動繼續/);
  const ok = byAct('confirm-console')[0];
  assert.equal(ok.disabled, false);
  fake.now += 3_000; // 剩 9 秒，中間沒有重畫：畫面上還是 3 秒前那一份
  click(ok);
  await settle();
  assert.deepEqual(sent('pauseClock'), []);
  assert.equal(dialog()?.dataset.key, 'confirm-clock-toggle');
  assert.equal(byAct('confirm-console')[0].disabled, true);
  assert.match(textOf(dialog()), /快日落・照常日落、不停/);
});

test('恢復全場：確認框點名手動暫停的鐘；恢復之後結果條提醒它還停著', async () => {
  await start(NOW + 40 * MINUTE);
  const pause = { on: true, seq: 3, at: fake.now - MINUTE, by: 'hostA' };
  await show(roomWith(clockAt(5 * MINUTE, { paused: true, seq: 6 }), pause)); // 停住的時刻不是暫停那一筆＝手動暫停的
  click(byAct('pause-off')[0]);
  await settle();
  assert.equal(dialog()?.dataset.key, 'confirm-resume');
  assert.match(textOf(dialog()), /第 1 場日落鐘是手動暫停的：恢復全場後還是停著/);
  fake.replies.setPause = async () => ({ changed: true, seq: 4, clocks: [], nearSunset: [] });
  click(byAct('confirm-console')[0]);
  await settle();
  assert.deepEqual(sent('setPause'), [[false, { expectSeq: 3 }]]);
  assert.match(resultText(), /第 1 場日落鐘還在暫停（手動暫停的），要繼續請在日落鐘面板按繼續/);
});
