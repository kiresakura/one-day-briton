// 主持人控制台畫面（play/js/ui/host.js）新加的純函式：控制台預設開不開、日落鐘與時刻的寫法、投影畫面的網址、指令錯誤的說明、
// 批次動作的確認框與結果文字、日落鐘按鈕的停用原因、要顯示哪幾場的鐘、統一開始全場鐘時各桌怎麼變、投影端狀態。
// host.js 載入時會碰到頁面（document、window、localStorage、計時器），這裡先放最小的替身再載入；只測不碰畫面的函式。
import test from 'node:test';
import assert from 'node:assert/strict';
import { clockAdjustWrite, clockStartWrite } from '../../play/js/game.js';
import { confirmCode } from '../../play/js/rules.js';
import { StoreError } from '../../play/js/store.js';

const element = () => ({ addEventListener() {}, dataset: {} });
globalThis.document ??= { addEventListener() {}, getElementById: element, querySelector: element, querySelectorAll: () => [], documentElement: element() };
globalThis.window ??= { addEventListener() {}, innerWidth: 1440, innerHeight: 900 };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const realInterval = globalThis.setInterval;
globalThis.setInterval = () => 0; // 畫面的每秒更新：測試不用跑，也不要讓測試結束不了
const host = await import('../../play/js/ui/host.js');
globalThis.setInterval = realInterval;

const {
  CONSOLE_MIN_HEIGHT,
  CONSOLE_MIN_WIDTH,
  SCREEN_LAG_MS,
  advanceLine,
  advanceResult,
  byText,
  clockGuards,
  clockMatches,
  clockStartChanges,
  clockText,
  commandError,
  consoleWide,
  deltaText,
  screenRows,
  screenUrl,
  startResult,
  wallTime,
} = host;

const MINUTE = 60_000;
const settings = { sunsetMinutes: 75, maxRounds: 12 };

test('控制台預設開：寬 1360、高 860 以上（兩個都要到）', () => {
  assert.equal(CONSOLE_MIN_WIDTH, 1360);
  assert.equal(CONSOLE_MIN_HEIGHT, 860);
  assert.equal(consoleWide(1440, 900), true);
  assert.equal(consoleWide(1360, 860), true);
  assert.equal(consoleWide(1359, 900), false);
  assert.equal(consoleWide(1440, 859), false);
  assert.equal(consoleWide(1366, 768), false);
  assert.equal(consoleWide(1280, 800), false);
  assert.equal(consoleWide(1024, 768), false);
});

test('日落鐘的字：剩餘無條件進位（還沒到不顯示 0:00），已進行捨去，分鐘可以超過 60，負的當 0', () => {
  assert.equal(clockText(0), '0:00');
  assert.equal(clockText(1), '0:01');
  assert.equal(clockText(59_001), '1:00');
  assert.equal(clockText(75 * MINUTE), '75:00');
  assert.equal(clockText(105 * MINUTE + 5_000), '105:05');
  assert.equal(clockText(-3_000), '0:00');
  assert.equal(clockText(59_999, { up: true }), '0:59');
  assert.equal(clockText(41 * MINUTE + 8_400, { up: true }), '41:08');
});

test('時刻：伺服器時間扣掉時間差，寫成這台的 18:44（可以帶秒）', () => {
  const local = new Date(2026, 9, 19, 18, 44, 5).getTime();
  assert.equal(wallTime(local), '18:44');
  assert.equal(wallTime(local + 2_000, 2_000), '18:44');
  assert.equal(wallTime(local, 0, { seconds: true }), '18:44:05');
  assert.equal(wallTime(new Date(2026, 9, 19, 9, 5).getTime()), '09:05');
});

test('加減了多少：整分鐘寫「＋5 分」，夾過的寫到秒', () => {
  assert.equal(deltaText(5 * MINUTE), '＋5 分');
  assert.equal(deltaText(-MINUTE), '－1 分');
  assert.equal(deltaText(-(2 * MINUTE + 58_000)), '－2 分 58 秒');
  assert.equal(deltaText(13_000), '＋13 秒');
});

test('誰改的：自己是「這台」，別台寫確認碼', () => {
  assert.equal(byText('me', 'me'), '這台');
  assert.equal(byText('other-uid', 'me'), `別台（${confirmCode('other-uid')}）`);
  assert.equal(byText(undefined, 'me'), '');
});

test('投影畫面的網址：保留 env，新視窗 slot=screen，小預覽 preview=1、slot=preview', () => {
  assert.equal(screenUrl('?env=emu&slot=host2&seed=3', 'QX7M4K'), '?view=screen&room=QX7M4K&slot=screen&env=emu');
  assert.equal(screenUrl('?env=emu', 'QX7M4K', { preview: true }), '?view=screen&room=QX7M4K&preview=1&slot=preview&env=emu');
  assert.equal(screenUrl('', 'QX7M4K'), '?view=screen&room=QX7M4K&slot=screen');
  assert.equal(screenUrl('?env=prod', 'ABCDEF', { preview: true }), '?view=screen&room=ABCDEF&preview=1&slot=preview&env=prod');
});

test('指令的錯誤：規則還沒更新、別台剛改過（照最新的那一筆寫）、其他照 message、不是 StoreError 的寫通用的一句（不帶代碼）', () => {
  const outdated = new StoreError('rules-outdated', '切換投影場景要等規則更新');
  assert.equal(commandError(outdated, { clock: true }), '日落鐘控制要等規則更新，各桌照舊各自計時');
  assert.match(commandError(outdated), /^切換投影場景要等規則更新/);
  const conflict = new StoreError('conflict', '別台主持端剛改過，請看最新的狀態再操作');
  conflict.latest = { seq: 4 };
  assert.equal(commandError(conflict, { describe: (latest) => `現在是第 ${latest.seq} 則` }), '別台剛改過，現在是第 4 則；看清楚再按一次');
  assert.equal(commandError(conflict), '別台剛改過；看清楚再按一次');
  assert.equal(commandError(new StoreError('too-soon', '音效一秒只能放一次，請等一下再按')), '音效一秒只能放一次，請等一下再按');
  assert.equal(commandError(new StoreError('clock-passed', '已經日落了，不能再暫停或加減'), { clock: true }), '已經日落了，不能再暫停或加減');
  const raw = Object.assign(new Error('Client is offline.'), { code: 'unavailable' });
  assert.equal(commandError(raw), '沒有寫進去，請再按一次');
  assert.equal(commandError(new Error('boom')), '沒有寫進去，請再按一次');
  assert.equal(commandError(null), '沒有寫進去，請再按一次');
});

test('能推的全推：確認框逐桌寫起訖、會不會發牌、算分的原因與原本的提醒', () => {
  const base = { key: '3', table: 3, match: 1, round: 3, ending: null, deal: false, note: null };
  assert.equal(advanceLine({ ...base, phase: 'night', to: { round: 4, phase: 'sunrise' }, deal: true }), '第 3 桌：黑夜 → 第 4 回合日出（會發牌）');
  assert.equal(advanceLine({ ...base, table: 5, phase: 'sunrise', to: { round: 3, phase: 'day' } }), '第 5 桌：日出 → 白晝');
  assert.equal(
    advanceLine({ ...base, phase: 'night', to: { round: 4, phase: 'sunrise' }, deal: true, note: '沒挑棄牌的 1 人會被隨機棄到上限' }),
    '第 3 桌：黑夜 → 第 4 回合日出（會發牌）；沒挑棄牌的 1 人會被隨機棄到上限',
  );
  assert.equal(advanceLine({ ...base, phase: 'night', to: { round: 3, phase: 'end' }, ending: 'sunset' }), '第 3 桌：黑夜 → 算分（日落鐘到了，算分後不能回頭）');
  assert.equal(advanceLine({ ...base, key: '2-2', table: 2, match: 2, phase: 'dusk', to: { round: 3, phase: 'night' } }), '第 2 桌：第 2 場・黃昏 → 黑夜');
});

test('能推的全推：逐桌的結果（推進、發牌、算分、要算分沒推、局面變了、錯誤、推進了但發牌失敗、計畫要算分卻推進了）', () => {
  const item = { key: '3', table: 3, match: 1, round: 3, phase: 'night', to: { round: 4, phase: 'sunrise' }, deal: true };
  const result = { key: '3', table: 3, advanced: true, ended: false, held: false, dealt: true, reason: null, error: null };
  assert.deepEqual(advanceResult(result, item), { ok: true, text: '第 3 桌：第 4 回合日出（已發牌）' });
  assert.deepEqual(advanceResult({ ...result, ended: true, dealt: false, reason: 'maxRounds' }, item), { ok: true, text: '第 3 桌：已算分（到了回合上限）' });
  assert.equal(advanceResult({ ...result, advanced: false, dealt: false, held: true, reason: 'sunset' }, item).ok, false);
  assert.match(advanceResult({ ...result, advanced: false, dealt: false, held: true }, item).text, /這一回合要算分，沒推/);
  assert.deepEqual(advanceResult({ ...result, advanced: false, dealt: false }, item), { ok: false, text: '第 3 桌：局面已經變了，沒有動' });
  assert.deepEqual(advanceResult({ ...result, advanced: false, dealt: false, error: new StoreError('paused', '全場暫停中，沒有推') }, item), { ok: false, text: '第 3 桌：全場暫停中，沒有推' });
  assert.match(advanceResult({ ...result, dealt: false, error: new StoreError('rejected', '發牌沒有寫進去') }, item).text, /推進了，但發牌沒成功.*補發/);
  assert.deepEqual(advanceResult({ ...result, dealt: false }, { ...item, phase: 'sunrise', round: 4, to: { round: 4, phase: 'day' }, deal: false }), { ok: true, text: '第 3 桌：白晝' });
  // 計畫要算分（主持端提早收場），確認之前別台取消了：store 照「不算分」推到下一回合日出並發牌，照實寫、給 warn。
  const ending = { ...item, to: { round: 3, phase: 'end' }, ending: 'host', deal: false };
  assert.deepEqual(advanceResult(result, ending), { ok: true, warn: true, text: '第 3 桌：這一回合不算分了，推到第 4 回合日出（已發牌）' });
  assert.deepEqual(advanceResult({ ...result, ended: true, dealt: false, reason: 'host' }, ending), { ok: true, text: '第 3 桌：已算分（主持端提早收場）' });
});

test('全部開始：逐桌的結果（開了幾人、別台先開了、錯誤）', () => {
  const result = { key: '1', table: 1, started: true, error: null };
  assert.deepEqual(startResult(result, { count: 5 }), { ok: true, text: '第 1 桌：已開局（5 人）' });
  assert.deepEqual(startResult({ ...result, started: false }), { ok: true, text: '第 1 桌：別台先開了' });
  assert.deepEqual(startResult({ ...result, started: false, error: new StoreError('paused', '全場暫停中，沒有開局') }), { ok: false, text: '第 1 桌：全場暫停中，沒有開局' });
});

test('日落鐘的按鈕：日落後都不能按、累計到上限的那一邊不能按；全場暫停中照鐘是哪一種寫原因，沒被停住的可以手動暫停', () => {
  const now = 1_000_000;
  const clock = { ...clockStartWrite(75, now - 10 * MINUTE), by: 'a' };
  assert.deepEqual(clockGuards(clock, now), { toggle: null, minus: null, plus: null, hold: null });
  // 全場暫停中：被這次暫停停住的、手動暫停的、快日落的不能按暫停／繼續（各寫各的原因）；在走、沒被停住的可以手動暫停。
  const pause = { on: true, seq: 1, at: now - 5_000, clocks: { 1: true } };
  const held = { ...clock, pausedAt: pause.at, seq: 2 };
  assert.deepEqual(clockGuards(held, now, { pause, match: 1 }), { toggle: '被這次全場暫停停住（恢復時一起繼續）', minus: null, plus: null, hold: 'held' });
  assert.equal(clockGuards({ ...held, pausedAt: now - 60_000 }, now, { pause, match: 1 }).toggle, '手動暫停的（恢復全場後要自己按繼續）');
  assert.equal(clockGuards(held, now, { pause, match: 2 }).toggle, '手動暫停的（恢復全場後要自己按繼續）');
  const soon = { ...clock, remain: clock.remain - 65 * MINUTE + 8_000 }; // 剩 8 秒
  assert.deepEqual(clockGuards(soon, now, { pause, match: 1 }), { toggle: '快日落・照常日落、不停', minus: null, plus: null, hold: 'near' });
  assert.deepEqual(clockGuards(clock, now, { pause, match: 1 }), { toggle: null, minus: null, plus: null, hold: 'free' });
  assert.equal(clockGuards(soon, now, { pause: { ...pause, on: false }, match: 1 }).toggle, null);
  const plus30 = { ...clock, remain: clock.remain + 30 * MINUTE, adjust: 30 * MINUTE };
  assert.equal(clockGuards(plus30, now).minus, null);
  assert.match(clockGuards(plus30, now).plus, /累計已經加了 30 分/);
  const minus30 = { ...clock, remain: clock.remain - 30 * MINUTE, adjust: -30 * MINUTE };
  assert.match(clockGuards(minus30, now).minus, /累計已經減了 30 分/);
  const passed = clockGuards(clock, now + 66 * MINUTE);
  assert.ok(passed.toggle && passed.minus && passed.plus);
  // 暫停中被減到剛好 0 也算日落：都不能按（繼續也不行）。
  const paused = { ...clock, pausedAt: now, seq: 2 };
  const near = { ...paused, remain: now - paused.anchor + 5 * MINUTE, adjust: -20 * MINUTE };
  const zero = clockAdjustWrite(near, -10 * MINUTE, now); // 剩 5 分，減 10 分夾成減到 0
  assert.equal(zero.remain - (zero.pausedAt - zero.anchor), 0);
  assert.match(clockGuards(zero, now).plus, /已經日落/);
  assert.match(clockGuards(zero, now).toggle, /已經日落/);
  assert.equal(clockGuards(null, now), null);
});

test('要顯示哪幾場的鐘：都在第 1 場 [1]、有桌開了第 2 場而第 1 場還有桌在打 [1, 2]、第 1 場都打完 [2]', () => {
  const room = (tables, games, clock) => ({ meta: { tableCount: 3 }, tables, games, clock });
  const playing = { round: 2, phase: 'day' };
  const ended = { round: 5, phase: 'end' };
  assert.deepEqual(clockMatches(room({ 1: { round: 1, phase: 'sunrise' }, 2: { round: 1, phase: 'sunrise' }, 3: { round: 1, phase: 'sunrise' } }, {})), [1]);
  assert.deepEqual(clockMatches(room({ 1: playing, 2: playing, 3: { round: 1, phase: 'sunrise' } }, { 1: {}, 2: {} })), [1]);
  assert.deepEqual(clockMatches(room({ 1: ended, '1-2': { round: 1, phase: 'sunrise' }, 2: playing, 3: { round: 1, phase: 'sunrise' } }, { 1: {}, 2: {} })), [1, 2]);
  // 沒開局的桌（第 3 桌）不算「第 1 場還在打」。
  assert.deepEqual(clockMatches(room({ 1: ended, '1-2': playing, 2: ended, '2-2': playing, 3: { round: 1, phase: 'sunrise' } }, { 1: {}, 2: {}, '1-2': {}, '2-2': {} })), [2]);
  assert.deepEqual(clockMatches(room({ 1: ended, 2: ended, 3: ended }, { 1: {}, 2: {}, 3: {} })), [1]);
  assert.deepEqual(clockMatches(null), [1]);
});

test('統一開始全場鐘：已開局的桌原本還剩幾分、改照全場鐘是幾分；原本因日落是最後一回合的標出來', () => {
  const now = 10_000_000;
  const seats = { a: { order: 0 }, b: { order: 1 } };
  const room = {
    meta: { tableCount: 4 },
    tables: { 1: { round: 3, phase: 'day' }, 2: { round: 6, phase: 'night' }, 3: { round: 1, phase: 'sunrise' }, 4: { round: 4, phase: 'end' } },
    games: { 1: { seats, startedAt: now - 12 * MINUTE }, 2: { seats, startedAt: now - 80 * MINUTE }, 4: { seats, startedAt: now - 90 * MINUTE } },
  };
  const changes = clockStartChanges(room, 1, 75, settings, now);
  assert.deepEqual(
    changes.map(({ table, problem }) => [table, problem]),
    [
      [1, false],
      [2, true],
    ],
  );
  assert.equal(changes[0].text, '第 1 桌：原本還剩 63 分，改照全場鐘是 75 分');
  assert.match(changes[1].text, /^第 2 桌：原本已經日落，改照全場鐘是 75 分（這一回合本來結束就算分/);
  // 第 2 場：只看 "n-2" 的局。
  const second = { ...room, tables: { ...room.tables, '1-2': { round: 2, phase: 'dusk' } }, games: { ...room.games, '1-2': { seats, startedAt: now - 5 * MINUTE } } };
  assert.deepEqual(
    clockStartChanges(second, 2, 75, settings, now).map((change) => change.text),
    ['第 1 桌：原本還剩 70 分，改照全場鐘是 75 分'],
  );
});

test('投影端狀態：確認碼、這台、聲音、場景跟上沒、跟不上超過 10 秒標灰；照最後回報排', () => {
  const now = 5_000_000;
  const scene = { id: 'overview', seq: 7, at: now - 20_000 };
  const screens = {
    old: { audio: true, scene: 6, at: now - 60_000 },
    me: { audio: false, scene: 7, at: now - 1_000 },
    junk: 'x',
  };
  const rows = screenRows(screens, scene, now, 'me');
  assert.deepEqual(
    rows.map(({ uid, self, audio, synced, lagging }) => ({ uid, self, audio, synced, lagging })),
    [
      { uid: 'me', self: true, audio: false, synced: true, lagging: false },
      { uid: 'old', self: false, audio: true, synced: false, lagging: true },
    ],
  );
  assert.equal(rows[1].code, confirmCode('old'));
  // 場景剛換（還沒過 10 秒）：沒跟上但不標灰。
  assert.equal(screenRows(screens, { ...scene, at: now - SCREEN_LAG_MS + 1 }, now, 'me')[1].lagging, false);
  // 還沒有切過場景：都算跟上。
  assert.equal(screenRows(screens, null, now, 'me')[1].synced, true);
  assert.deepEqual(screenRows(null, scene, now, 'me'), []);
});
