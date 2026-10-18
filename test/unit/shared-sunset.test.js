// 畫面共用的「這一回合是不是最後一回合」與「日落鐘到點重畫」（play/js/ui/shared.js 的 endReasonNow、wakeAtSunset 用的 endReasonIn、
// sunsetWakeAt）：帶局號、不帶局號（舊的呼叫方式，在房間資料裡找同一個物件）兩條路，結論要跟 store.js 推進時的判斷（game.js 的
// shouldEnd＋rules.js 的 clockOf）、「能推的全推」的計畫（advancePlan）一樣。shared.js 載入時會碰到頁面，這裡先放最小的替身再載入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePlan, shouldEnd } from '../../play/js/game.js';
import { clockOf } from '../../play/js/rules.js';

const element = () => ({ addEventListener() {}, dataset: {} });
globalThis.document ??= { addEventListener() {}, getElementById: element, querySelector: element, querySelectorAll: () => [], documentElement: element() };
globalThis.window ??= { addEventListener() {}, innerWidth: 1440, innerHeight: 900 };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const realInterval = globalThis.setInterval;
globalThis.setInterval = () => 0; // 畫面的每秒檢查：測試不用跑，也不要讓測試結束不了
const { endReasonIn, sunsetWakeAt } = await import('../../play/js/ui/shared.js');
globalThis.setInterval = realInterval;

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;
const settings = { sunsetMinutes: 75, maxRounds: 12 };

function baseRoom() {
  return { meta: { tableCount: 1 }, players: {}, tables: {}, games: {}, deals: {}, clock: {}, display: {} };
}
// 一桌在黑夜、已經揭曉（下一階段＝推到下一回合日出或算分）。startedAgo＝這一局開局多久了。
function nightRevealed(room, key, { round = 3, startedAgo = 10 * MINUTE, endAfterRound } = {}) {
  room.tables[key] = { round, phase: 'night', fog: 10 };
  room.games[key] = { seats: { a: { order: 0 }, b: { order: 1 } }, startedAt: NOW - startedAgo, dusk: { round }, night: { round, result: {} }, ...(endAfterRound ? { endAfterRound } : {}) };
  room.deals[key] = round;
}
// 全場鐘：剩 left 毫秒（照 NOW）；paused 時在 NOW 暫停。
function clock(left, { paused = false, adjust = 0 } = {}) {
  const anchor = NOW - 20 * MINUTE;
  const record = { startedAt: NOW - 50 * MINUTE, minutes: 75, anchor, remain: left + (NOW - anchor), adjust, seq: 3 };
  if (paused) record.pausedAt = NOW;
  return record;
}
function finishedFirst(room) {
  room.tables['1'] = { round: 5, phase: 'end' };
  room.games['1'] = { seats: {}, startedAt: NOW - 90 * MINUTE, final: { round: 5, reason: 'sunset', scores: {} } };
}

// 同一份房間資料：帶局號、不帶局號（同一個物件）、store 的判斷、能推的全推的計畫，四個都要等於 expect。
function agree(room, key, expect) {
  const game = room.games[key];
  const state = room.tables[key];
  const store = shouldEnd({ round: state.round, startedAt: game.startedAt, endAfterRound: game.endAfterRound }, settings, NOW, clockOf(room, key));
  const plan = advancePlan(room, settings, NOW, { includeEnding: true });
  const item = plan.advance.find((entry) => entry.key === key);
  assert.deepEqual(
    { keyed: endReasonIn(room, game, state, settings, NOW, key), same: endReasonIn(room, game, state, settings, NOW), store, plan: item ? item.ending : 'missing' },
    { keyed: expect, same: expect, store: expect, plan: expect },
  );
}

test('最後一回合：沒有全場鐘照各桌開局時間；有鐘照鐘（走著、暫停、減到 0、到點、剛好 0、加過）', () => {
  let room = baseRoom();
  nightRevealed(room, '1', { startedAgo: 80 * MINUTE });
  agree(room, '1', 'sunset');
  room = baseRoom();
  nightRevealed(room, '1', { startedAgo: 10 * MINUTE });
  agree(room, '1', null);
  room = baseRoom();
  nightRevealed(room, '1', { startedAgo: 80 * MINUTE });
  room.clock[1] = clock(40 * MINUTE);
  agree(room, '1', null);
  room.clock[1] = clock(40 * MINUTE, { paused: true });
  agree(room, '1', null);
  room.clock[1] = clock(0, { paused: true, adjust: -20 * MINUTE });
  agree(room, '1', 'sunset');
  room = baseRoom();
  nightRevealed(room, '1', { startedAgo: 10 * MINUTE });
  room.clock[1] = clock(-500);
  agree(room, '1', 'sunset');
  room.clock[1] = clock(0);
  agree(room, '1', 'sunset');
  room.clock[1] = clock(5 * MINUTE, { adjust: 10 * MINUTE });
  agree(room, '1', null);
});

test('最後一回合：第 2 場的桌照第 2 場的鐘（沒有就照這一局的開局時間）；主持端提早收場；沒有設定是 null', () => {
  let room = baseRoom();
  finishedFirst(room);
  nightRevealed(room, '1-2', { startedAgo: 10 * MINUTE });
  room.clock[1] = clock(-60 * MINUTE);
  agree(room, '1-2', null);
  room.clock[2] = clock(-1_000);
  agree(room, '1-2', 'sunset');
  room.clock[2] = clock(30 * MINUTE);
  room.games['1-2'].startedAt = NOW - 80 * MINUTE;
  agree(room, '1-2', null);
  room = baseRoom();
  nightRevealed(room, '1', { startedAgo: 10 * MINUTE, endAfterRound: 3 });
  room.clock[1] = clock(40 * MINUTE);
  agree(room, '1', 'host');
  assert.equal(endReasonIn(room, room.games['1'], room.tables['1'], null, NOW, '1'), null);
});

test('不帶局號：要是房間資料裡的同一個物件才找得到鐘；複製品退回各桌的開局時間（所以要帶局號）', () => {
  const room = baseRoom();
  finishedFirst(room);
  nightRevealed(room, '1-2', { startedAgo: 10 * MINUTE });
  room.clock[2] = clock(-1_000);
  const copy = structuredClone(room.games['1-2']);
  assert.equal(endReasonIn(room, room.games['1-2'], room.tables['1-2'], settings, NOW), 'sunset');
  assert.equal(endReasonIn(room, copy, room.tables['1-2'], settings, NOW), null);
  assert.equal(endReasonIn(room, copy, room.tables['1-2'], settings, NOW, '1-2'), 'sunset');
  assert.equal(endReasonIn(null, copy, room.tables['1-2'], settings, NOW), null);
});

test('到點重畫：有鐘照鐘的日落時刻、暫停中不排、沒有鐘照各桌；不帶局號一樣靠同一個物件找', () => {
  const room = baseRoom();
  finishedFirst(room);
  nightRevealed(room, '1-2', { startedAgo: 10 * MINUTE });
  const game = room.games['1-2'];
  assert.equal(sunsetWakeAt(room, game, settings, NOW, '1-2'), game.startedAt + 75 * MINUTE);
  room.clock[2] = clock(30 * MINUTE);
  const at = room.clock[2].anchor + room.clock[2].remain;
  assert.equal(at, NOW + 30 * MINUTE);
  assert.equal(sunsetWakeAt(room, game, settings, NOW, '1-2'), at);
  assert.equal(sunsetWakeAt(room, game, settings, NOW), at);
  assert.equal(sunsetWakeAt(room, structuredClone(game), settings, NOW), game.startedAt + 75 * MINUTE);
  room.clock[2] = clock(30 * MINUTE, { paused: true });
  assert.equal(sunsetWakeAt(room, game, settings, NOW, '1-2'), null);
  assert.equal(sunsetWakeAt(room, game, null, NOW, '1-2'), null);
  assert.equal(sunsetWakeAt(baseRoom(), { seats: {} }, settings, NOW, '1'), null);
});
