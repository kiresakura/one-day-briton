// 玩家畫面跟主持人控制台有關的判斷（js/ui/player-model.js 的純函式）：全場暫停層要不要蓋、什麼時候蓋、層上放哪則廣播；「最後一回合」
// 跟主持端推進（advancePlan）同一個結論；日落時重畫的時刻；新廣播要不要震。資料用範例資料。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { withDefaultSettings } from '../../play/js/data.js';
import { advancePlan, clockAdjustWrite, clockPauseWrite, clockResumeWrite, clockStartWrite, clockSunsetAt } from '../../play/js/game.js';
import { loadDataFolder } from '../../scripts/lib/datafiles.mjs';

// player-model.js 連帶載入 home.js、dom.js，dom.js 載入時在 document、window 上掛監聽；Node 裡沒有這兩個，給最小的替身。
globalThis.document ??= { addEventListener() {} };
globalThis.window ??= { addEventListener() {} };
const { buzzStep, lastRoundOf, pauseView, sunsetWakeOf } = await import('../../play/js/ui/player-model.js');

const sampleDir = fileURLToPath(new URL('../fixtures/data-example/', import.meta.url));
const { data: sample } = await loadDataFolder(sampleDir);
const settings = withDefaultSettings(sample.settings);
const MINUTE = 60_000;
const T0 = 1_700_000_000_000;
const seats = { a: { seat: 1, order: 1 }, b: { seat: 2, order: 2 }, c: { seat: 3, order: 3 } };

// ---- 暫停層 ----

const pause = (fields = {}) => ({ on: true, seq: 1, at: T0, by: 'host', ...fields });
const cast = (fields = {}) => ({ text: '請先停下來聽說明', seq: 2, at: T0 - MINUTE, by: 'host', ...fields });
const shown = { text: '請先停下來聽說明', seq: 2 };
const day = { round: 2, phase: 'day', fog: 0 };
const dayGame = (fields = {}) => ({ seats, startedAt: T0 - 30 * MINUTE, ...fields });
// 響應窗口：openedAt 開、seconds 秒後截止。
const windowAt = (openedAt, seconds = 8) => ({ id: 'w1', by: 'b', seq: 1, card: 'a01', level: 1, openedAt, seconds });
const none = { cover: false, until: null, cast: null };

test('pauseView：全場暫停就蓋上，層上放目前那一則廣播；從沒送過、已經收回、格式不對時照樣蓋，只是不放廣播', () => {
  const now = T0 + 1000;
  assert.deepEqual(pauseView({ pause: pause(), broadcast: cast() }, dayGame(), day, settings, now), { cover: true, until: null, cast: shown });
  // 這台按過「知道了」也一樣放（pauseView 不看收起到第幾則）。從沒送過廣播：
  assert.deepEqual(pauseView({ pause: pause() }, dayGame(), day, settings, now), { cover: true, until: null, cast: null });
  // 收回＝同一則加 hidden: true
  assert.deepEqual(pauseView({ pause: pause(), broadcast: cast({ hidden: true, seq: 3 }) }, dayGame(), day, settings, now), { cover: true, until: null, cast: null });
  // 讀到規則擋得掉的格式
  for (const broadcast of [cast({ text: '' }), cast({ text: 12 }), cast({ seq: '2' }), cast({ seq: undefined }), '請回座位', null, []]) {
    assert.deepEqual(pauseView({ pause: pause(), broadcast }, dayGame(), day, settings, now), { cover: true, until: null, cast: null }, JSON.stringify(broadcast));
  }
  // 暫停的 at 讀不懂：當作暫停前沒有開著的倒數，直接蓋。
  assert.deepEqual(pauseView({ pause: pause({ at: 'now' }) }, dayGame({ pending: windowAt(T0 - 3000) }), day, settings, now), { cover: true, until: null, cast: null });
  // 還沒開局、沒入座（沒有局面）的人也蓋。
  assert.deepEqual(pauseView({ pause: pause() }, undefined, day, settings, now), { cover: true, until: null, cast: null });
});

test('pauseView：沒有暫停、已經恢復、舊房間沒有 display、暫停的資料不對都不蓋', () => {
  const now = T0 + 1000;
  for (const display of [undefined, null, {}, [], 'paused', { broadcast: cast() }]) {
    assert.deepEqual(pauseView(display, dayGame(), day, settings, now), none, JSON.stringify(display));
  }
  assert.deepEqual(pauseView({ pause: pause({ on: false, seq: 2 }), broadcast: cast() }, dayGame(), day, settings, now), none, 'resumed');
  for (const value of [pause({ on: 'true' }), pause({ on: 1 }), { seq: 1 }, true, 'on', null]) {
    assert.deepEqual(pauseView({ pause: value, broadcast: cast() }, dayGame(), day, settings, now), none, JSON.stringify(value));
  }
});

test('pauseView：暫停前就開著的響應窗口先跑完（until 是截止時間），到點才蓋；暫停之後才開的窗口不算', () => {
  const opened = T0 - 3000;
  const deadline = opened + 8000;
  const game = dayGame({ pending: windowAt(opened) });
  assert.deepEqual(pauseView({ pause: pause(), broadcast: cast() }, game, day, settings, T0 + 1), { cover: false, until: deadline, cast: null });
  assert.deepEqual(pauseView({ pause: pause() }, game, day, settings, deadline - 1), { cover: false, until: deadline, cast: null });
  assert.deepEqual(pauseView({ pause: pause() }, game, day, settings, deadline), { cover: true, until: null, cast: null });
  assert.deepEqual(pauseView({ pause: pause(), broadcast: cast() }, game, day, settings, deadline + 1), { cover: true, until: null, cast: shown });
  // 暫停之後才開的窗口（只可能來自還開著舊網頁的人）：直接蓋。
  assert.deepEqual(pauseView({ pause: pause() }, dayGame({ pending: windowAt(T0 + 500) }), day, settings, T0 + 1000), { cover: true, until: null, cast: null });
  // 黑夜揭曉倒數在暫停前就開始了：倒數完才蓋。
  const night = { round: 2, phase: 'night', fog: 0 };
  const revealAt = T0 + 2000; // 範例資料揭曉 3 秒：T0 − 1 秒開始
  const nightGame = dayGame({ night: { round: 2, openedAt: T0 - 9000, submitted: 3, revealAt } });
  assert.deepEqual(pauseView({ pause: pause() }, nightGame, night, settings, T0 + 1), { cover: false, until: revealAt, cast: null });
  assert.deepEqual(pauseView({ pause: pause() }, nightGame, night, settings, revealAt), { cover: true, until: null, cast: null });
});

test('pauseView：卡牌資料還沒讀到（沒有 settings）時照樣蓋，暫停前開著的響應窗口照樣先跑完', () => {
  assert.deepEqual(pauseView({ pause: pause() }, dayGame(), day, undefined, T0 + 1000), { cover: true, until: null, cast: null });
  assert.deepEqual(pauseView({ pause: pause(), broadcast: cast() }, dayGame(), day, null, T0 + 1000), { cover: true, until: null, cast: shown });
  const game = dayGame({ pending: windowAt(T0 - 3000) });
  assert.deepEqual(pauseView({ pause: pause() }, game, day, undefined, T0 + 1000), { cover: false, until: T0 + 5000, cast: null });
  assert.deepEqual(pauseView({ pause: pause() }, game, day, undefined, T0 + 5000), { cover: true, until: null, cast: null });
});

// ---- 最後一回合：跟主持端推進（advancePlan，帶那一場的全場鐘）同一個結論 ----

// 第 1 桌黑夜已揭曉（主持端按「下一階段」時看要不要算分）。startedAt2 有值＝主持端開了第 2 場（第 1 場已算分）。
const revealed = (round) => ({ round, openedAt: T0, submitted: 3, revealAt: T0, result: { players: {} } });
function nightRoom({ clock1, clock2, round = 3, startedAt2, endAfterRound } = {}) {
  const room = { meta: { tableCount: 1 }, tables: { 1: { round, phase: 'night', fog: 0 } }, games: { 1: { seats, startedAt: T0, night: revealed(round) } } };
  if (endAfterRound !== undefined) room.games[1].endAfterRound = endAfterRound;
  if (startedAt2 !== undefined) {
    room.tables[1] = { round, phase: 'end', fog: 0 };
    room.games[1].final = { round, scores: {} };
    room.tables['1-2'] = { round, phase: 'night', fog: 0 };
    room.games['1-2'] = { seats, startedAt: startedAt2, night: revealed(round) };
  }
  if (clock1 || clock2) room.clock = { ...(clock1 && { 1: clock1 }), ...(clock2 && { 2: clock2 }) };
  return room;
}

// 主持端「能推的全推」（勾了連要算分的桌一起推）對這一局的結論：要算分是 true。
function hostEnding(room, key, now) {
  const row = advancePlan(room, settings, now, { includeEnding: true }).advance.find((item) => item.key === key);
  assert.ok(row, `advancePlan advances ${key}`);
  return row.ending !== null;
}

function sameAsHost(name, room, key, now, expect) {
  assert.equal(hostEnding(room, key, now), expect, `${name}: host`);
  assert.equal(lastRoundOf(room, key, settings, now), expect, `${name}: player`);
}

const clock = clockStartWrite(10, T0);
const sunset = clockSunsetAt(clock); // T0 + 10 分（沒有鐘時照開局算是 T0 + 75 分）
const paused = clockPauseWrite(clock, sunset - 2 * MINUTE);
const resumeAt = sunset + 30 * MINUTE;
const resumed = clockResumeWrite(paused, resumeAt); // 新的日落：resumeAt + 2 分

test('lastRoundOf：全場鐘走著、暫停中、繼續後，跟主持端推進同一個結論', () => {
  sameAsHost('running, 1 ms before sunset', nightRoom({ clock1: clock }), '1', sunset - 1, false);
  sameAsHost('running, at sunset', nightRoom({ clock1: clock }), '1', sunset, true);
  sameAsHost('paused with 2 min left, long after the old sunset', nightRoom({ clock1: paused }), '1', sunset + 29 * MINUTE, false);
  sameAsHost('resumed, 1 ms before the new sunset', nightRoom({ clock1: resumed }), '1', resumeAt + 2 * MINUTE - 1, false);
  sameAsHost('resumed, at the new sunset', nightRoom({ clock1: resumed }), '1', resumeAt + 2 * MINUTE, true);
  // 鐘讀回來是陣列
  const array = nightRoom({ clock1: clock });
  array.clock = [null, clock];
  sameAsHost('clock read back as an array', array, '1', sunset, true);
});

test('lastRoundOf：加減全場鐘（含減到已經日落、暫停中減到 0），跟主持端推進同一個結論', () => {
  const now = resumeAt + 30_000;
  const minus = clockAdjustWrite(resumed, -MINUTE, now); // 日落改成 resumeAt + 1 分
  sameAsHost('-1 min, 1 ms before', nightRoom({ clock1: minus }), '1', resumeAt + MINUTE - 1, false);
  sameAsHost('-1 min, at the new sunset', nightRoom({ clock1: minus }), '1', resumeAt + MINUTE, true);
  // 只剩 90 秒時減 10 分：夾到剩 0，當下就日落
  sameAsHost('-10 min clamped to sunset now', nightRoom({ clock1: clockAdjustWrite(resumed, -10 * MINUTE, now) }), '1', now, true);
  const plus = clockAdjustWrite(clock, 5 * MINUTE, sunset - MINUTE);
  sameAsHost('+5 min, at the old sunset', nightRoom({ clock1: plus }), '1', sunset, false);
  sameAsHost('+5 min, at the new sunset', nightRoom({ clock1: plus }), '1', sunset + 5 * MINUTE, true);
  sameAsHost('paused, then -10 min to 0', nightRoom({ clock1: clockAdjustWrite(paused, -10 * MINUTE, sunset + MINUTE) }), '1', sunset + 5 * MINUTE, true);
});

test('lastRoundOf：第 2 場看第 2 場的鐘（第 1 場的鐘早就日落了也不算）', () => {
  const start2 = sunset + 60 * MINUTE;
  const clock2 = clockStartWrite(10, start2);
  sameAsHost('match 2, clock 2 running', nightRoom({ clock1: clock, clock2, startedAt2: start2 }), '1-2', start2 + MINUTE, false);
  sameAsHost('match 2, at clock 2 sunset', nightRoom({ clock1: clock, clock2, startedAt2: start2 }), '1-2', clockSunsetAt(clock2), true);
  // 第 2 場還沒開鐘 2：照第 2 場從開局算起（範例資料 75 分）
  sameAsHost('match 2, no clock 2 yet', nightRoom({ clock1: clock, startedAt2: start2 }), '1-2', start2 + MINUTE, false);
  sameAsHost('match 2, no clock 2, 75 min after its start', nightRoom({ clock1: clock, startedAt2: start2 }), '1-2', start2 + 75 * MINUTE, true);
});

test('lastRoundOf：沒有全場鐘的房間照這一桌從開局算起，回合上限與主持人勾的「這回合結束後算分」照舊；卡牌資料沒讀到是 false', () => {
  sameAsHost('no clock, 1 ms before 75 min', nightRoom(), '1', T0 + 75 * MINUTE - 1, false);
  sameAsHost('no clock, at 75 min', nightRoom(), '1', T0 + 75 * MINUTE, true);
  sameAsHost('no clock, max rounds', nightRoom({ round: settings.maxRounds }), '1', T0 + MINUTE, true);
  sameAsHost('no clock, host ends after this round', nightRoom({ endAfterRound: 3 }), '1', T0 + MINUTE, true);
  sameAsHost('broken clock object falls back to the start', nightRoom({ clock1: { minutes: '10', anchor: T0 } }), '1', T0 + 75 * MINUTE, true);
  for (const missing of [undefined, null]) {
    assert.equal(lastRoundOf(nightRoom({ clock1: clock }), '1', missing, sunset), false);
    assert.equal(lastRoundOf(nightRoom({ endAfterRound: 3 }), '1', missing, T0), false);
  }
  // 還沒開局、已經算分：不是最後一回合
  const idle = nightRoom({ clock1: clock });
  delete idle.games;
  assert.equal(lastRoundOf(idle, '1', settings, sunset), false);
  assert.equal(lastRoundOf(nightRoom({ clock1: clock, startedAt2: sunset }), '1', settings, sunset), false);
});

test('sunsetWakeOf：日落時重畫的時刻照那一場的鐘；暫停中、終局、卡牌資料沒讀到不排', () => {
  assert.equal(sunsetWakeOf(nightRoom({ clock1: clock }), '1', settings, T0), sunset);
  assert.equal(sunsetWakeOf(nightRoom({ clock1: paused }), '1', settings, sunset), null);
  assert.equal(sunsetWakeOf(nightRoom({ clock1: resumed }), '1', settings, resumeAt), resumeAt + 2 * MINUTE);
  const start2 = sunset + 60 * MINUTE;
  const clock2 = clockStartWrite(10, start2);
  assert.equal(sunsetWakeOf(nightRoom({ clock1: clock, clock2, startedAt2: start2 }), '1-2', settings, start2), clockSunsetAt(clock2));
  assert.equal(sunsetWakeOf(nightRoom({ clock1: clock, startedAt2: start2 }), '1-2', settings, start2), start2 + 75 * MINUTE);
  assert.equal(sunsetWakeOf(nightRoom(), '1', settings, T0), T0 + 75 * MINUTE);
  assert.equal(sunsetWakeOf(nightRoom({ clock1: clock, startedAt2: start2 }), '1', settings, start2), null, 'match 1 ended');
  assert.equal(sunsetWakeOf(nightRoom({ clock1: clock }), '1', undefined, T0), null);
  const idle = nightRoom();
  delete idle.games;
  assert.equal(sunsetWakeOf(idle, '1', settings, T0), null, 'not started, no clock');
});

// ---- 新廣播時短震一次 ----

test('buzzStep：剛進房（含重新整理）看到的那一則不震；同一間房 seq 變大才震；收回不震；換房重新記', () => {
  const CODE = 'K7Q2MX';
  const start = { code: null, seq: 0 };
  const first = buzzStep(start, CODE, { text: '歡迎', seq: 3 });
  assert.deepEqual(first, { seen: { code: CODE, seq: 3 }, buzz: false });
  assert.deepEqual(buzzStep(first.seen, CODE, { text: '歡迎', seq: 3 }), { seen: { code: CODE, seq: 3 }, buzz: false });
  const next = buzzStep(first.seen, CODE, { text: '請回座位', seq: 4 });
  assert.deepEqual(next, { seen: { code: CODE, seq: 4 }, buzz: true });
  // 收回（broadcastOf 是 null）
  assert.deepEqual(buzzStep(next.seen, CODE, null), { seen: { code: CODE, seq: 4 }, buzz: false });
  assert.deepEqual(buzzStep(next.seen, CODE, { text: '五分鐘後日落', seq: 5 }), { seen: { code: CODE, seq: 5 }, buzz: true });
  assert.equal(buzzStep(next.seen, CODE, { text: '舊的', seq: 2 }).buzz, false);
  // 換到別間房：先記下那間房目前那一則，不震
  assert.deepEqual(buzzStep(next.seen, 'AB3CDE', { text: '別間房', seq: 9 }), { seen: { code: 'AB3CDE', seq: 9 }, buzz: false });
  // 進房時還沒有廣播：之後的第一則就震
  const empty = buzzStep(start, CODE, null);
  assert.deepEqual(empty, { seen: { code: CODE, seq: 0 }, buzz: false });
  assert.deepEqual(buzzStep(empty.seen, CODE, { text: '開始了', seq: 1 }), { seen: { code: CODE, seq: 1 }, buzz: true });
});
