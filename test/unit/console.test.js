// 主持人控制台的純函式：全場日落鐘（剩餘、已進行、到點、暫停、繼續、加減的上下限，寫入的欄位跟資料庫規則的式子一致）、shouldEnd 帶鐘、
// 批次動作的計畫（全部開始、全部開始第 2 場、能推的全推）、在等誰、挑棄牌、投影端的音效、玩家端的暫停層、排行與全場最高分、
// 廣播與場景的格式、clockOf、網頁版本號。資料用範例資料，不依賴正式資料。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { WEB_VERSION } from '../../play/js/config.js';
import { withDefaultSettings } from '../../play/js/data.js';
import {
  CLOCK_ADJUST_MAX_MS,
  CLOCK_STEP_MAX_MS,
  SFX_STALE_MS,
  advancePlan,
  clockAdjustWrite,
  clockElapsed,
  clockLength,
  clockPassed,
  clockPauseWrite,
  clockPaused,
  clockRemaining,
  clockResumeWrite,
  clockStartWrite,
  clockSunsetAt,
  combineScores,
  endReasonAt,
  missingDiscards,
  pauseHold,
  seededRandom,
  sfxToPlay,
  shouldEnd,
  standingsOf,
  startMatch2Plan,
  startPlan,
  submittedChoices,
  submittedCount,
  sunsetStatus,
  topScores,
  waitingFor,
} from '../../play/js/game.js';
import { BROADCAST_MAX_LENGTH, SCENE_IDS, clockOf, isValidBroadcast, isValidScene, normalizeBroadcast } from '../../play/js/rules.js';
import { loadDataFolder } from '../../scripts/lib/datafiles.mjs';

const sampleDir = fileURLToPath(new URL('../fixtures/data-example/', import.meta.url));
const { data: sample } = await loadDataFolder(sampleDir);
const settings = withDefaultSettings(sample.settings);
const data = { ...sample, settings };
const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

// 資料庫規則 clock/$m 的整筆條件（database.rules.json），照字面改寫成 JS：data 是寫入前的那一筆（沒有是 null），next 是寫入後的，
// now 是伺服器時間。欄位上的格式另外查（整數、minutes 10–180、adjust ±30 分）。用來確認 game.js 算出來的欄位一定過得了規則。
function ruleAccepts(data, next, now) {
  const has = (record, key) => record?.[key] !== undefined && record?.[key] !== null;
  const val = (record, key) => (has(record, key) ? record[key] : null);
  const fields = ['startedAt', 'minutes', 'anchor', 'remain', 'adjust', 'seq'];
  if (!fields.every((key) => has(next, key))) return false;
  if (![...fields, 'pausedAt'].every((key) => !has(next, key) || Number.isInteger(next[key]))) return false;
  if (next.minutes < 10 || next.minutes > 180 || next.adjust < -1_800_000 || next.adjust > 1_800_000) return false;
  if (!data) {
    return next.seq === 1 && next.startedAt === now && next.anchor === now && next.remain === next.minutes * 60000 && next.adjust === 0 && !has(next, 'pausedAt');
  }
  if (!(next.seq === data.seq + 1 && next.startedAt === data.startedAt && next.minutes === data.minutes)) return false;
  const pause = !has(data, 'pausedAt') && val(next, 'pausedAt') === now && next.anchor === data.anchor && next.remain === data.remain && next.adjust === data.adjust && data.remain - (now - data.anchor) > 0;
  const resume = has(data, 'pausedAt') && !has(next, 'pausedAt') && next.anchor === now && next.remain === data.remain - (data.pausedAt - data.anchor) && next.adjust === data.adjust;
  const before = has(data, 'pausedAt') ? data.remain - (data.pausedAt - data.anchor) : data.remain - (now - data.anchor);
  const after = has(next, 'pausedAt') ? next.remain - (next.pausedAt - next.anchor) : next.remain - (now - next.anchor);
  const delta = next.remain - data.remain;
  const adjust =
    next.anchor === data.anchor &&
    val(next, 'pausedAt') === val(data, 'pausedAt') &&
    delta !== 0 &&
    delta === next.adjust - data.adjust &&
    delta >= -600000 &&
    delta <= 600000 &&
    before > 0 &&
    after >= 0;
  return pause || resume || adjust;
}

const started = (minutes = 75, at = T0) => ({ ...clockStartWrite(minutes, at), by: 'host' });

test('a running clock counts down from minutes; exactly 0 is sunset, 1 ms before is not', () => {
  const clock = started(75);
  assert.equal(ruleAccepts(null, clock, T0), true, 'the start write passes the rule');
  assert.deepEqual([clockRemaining(clock, T0), clockElapsed(clock, T0), clockLength(clock)], [75 * MINUTE, 0, 75 * MINUTE]);
  assert.deepEqual([clockRemaining(clock, T0 + 30 * MINUTE), clockElapsed(clock, T0 + 30 * MINUTE)], [45 * MINUTE, 30 * MINUTE]);
  assert.equal(clockPassed(clock, T0 + 75 * MINUTE - 1), false);
  assert.equal(clockRemaining(clock, T0 + 75 * MINUTE - 1), 1);
  assert.equal(clockPassed(clock, T0 + 75 * MINUTE), true, 'exactly 0 counts, like sunsetClock');
  assert.deepEqual([clockRemaining(clock, T0 + 80 * MINUTE), clockElapsed(clock, T0 + 80 * MINUTE)], [0, 75 * MINUTE], 'after sunset: 0 left, never negative');
  assert.equal(clockSunsetAt(clock), T0 + 75 * MINUTE);
  assert.equal(clockPaused(clock), false);
  assert.throws(() => clockStartWrite(9, T0), RangeError);
  assert.throws(() => clockStartWrite(181, T0), RangeError);
  assert.throws(() => clockStartWrite(75.5, T0), RangeError);
  assert.deepEqual(clockStartWrite(10, 5), { startedAt: 5, minutes: 10, anchor: 5, remain: 10 * MINUTE, adjust: 0, seq: 1 });
});

test('pause stops the clock and the elapsed time; resume computes remain exactly like the rule, and the elapsed time never goes back', () => {
  const clock = started(75);
  const pausedAt = T0 + 10 * MINUTE + 123;
  const paused = { ...clockPauseWrite(clock, pausedAt), by: 'host' };
  assert.equal(ruleAccepts(clock, paused, pausedAt), true);
  assert.deepEqual(paused, { ...clock, pausedAt, seq: 2 });
  assert.equal(clockPaused(paused), true);
  assert.equal(clockPauseWrite(paused, pausedAt + 1), null, 'already paused');
  assert.equal(clockResumeWrite(clock, T0), null, 'not paused');
  // 暫停中：不管過多久，剩餘與已進行都不變，也不會到點。
  for (const later of [pausedAt, pausedAt + MINUTE, pausedAt + 10 * 60 * MINUTE]) {
    assert.equal(clockRemaining(paused, later), 65 * MINUTE - 123);
    assert.equal(clockElapsed(paused, later), 10 * MINUTE + 123);
    assert.equal(clockPassed(paused, later), false);
  }
  assert.equal(clockSunsetAt(paused), null, 'a paused clock has no sunset time');
  const resumedAt = pausedAt + 7 * MINUTE;
  const resumed = { ...clockResumeWrite(paused, resumedAt), by: 'host' };
  assert.equal(ruleAccepts(paused, resumed, resumedAt), true);
  assert.equal(resumed.remain, paused.remain - (paused.pausedAt - paused.anchor), 'remain is old remain − (pausedAt − old anchor)');
  assert.deepEqual([resumed.anchor, resumed.seq, 'pausedAt' in resumed], [resumedAt, 3, false]);
  assert.equal(clockElapsed(resumed, resumedAt), 10 * MINUTE + 123, 'resume does not jump');
  assert.equal(clockSunsetAt(resumed), T0 + 75 * MINUTE + 7 * MINUTE, 'the pause moved sunset by its length');
  assert.equal(ruleAccepts(paused, { ...resumed, remain: resumed.remain + 1 }, resumedAt), false, '1 ms off is rejected');
});

test('adjust moves only sunset: ±10 minutes a step, ±30 in total, never below 0; elapsed does not move', () => {
  let clock = started(75);
  const now = T0 + 20 * MINUTE;
  const plus = clockAdjustWrite(clock, 5 * MINUTE, now);
  assert.equal(ruleAccepts(clock, plus, now), true);
  assert.deepEqual([plus.remain - clock.remain, plus.adjust, plus.seq, plus.anchor], [5 * MINUTE, 5 * MINUTE, 2, clock.anchor]);
  assert.equal(clockElapsed(plus, now), clockElapsed(clock, now), 'elapsed stays the same');
  assert.equal(clockLength(plus), 80 * MINUTE);
  assert.equal(clockAdjustWrite(clock, 25 * MINUTE, now).adjust, CLOCK_STEP_MAX_MS, 'one step is at most 10 minutes');
  assert.equal(clockAdjustWrite(clock, -25 * MINUTE, now).adjust, -CLOCK_STEP_MAX_MS);
  // 累計 ±30 分。
  for (let step = 0; step < 3; step += 1) {
    const next = clockAdjustWrite(clock, 10 * MINUTE, now);
    assert.equal(ruleAccepts(clock, next, now), true);
    clock = next;
  }
  assert.equal(clock.adjust, CLOCK_ADJUST_MAX_MS);
  assert.equal(clockAdjustWrite(clock, MINUTE, now), null, 'the 30-minute cap is reached');
  assert.equal(clockAdjustWrite(clock, -MINUTE, now).adjust, CLOCK_ADJUST_MAX_MS - MINUTE, 'going back down still works');
  const capped = { ...started(75), adjust: 25 * MINUTE, remain: 100 * MINUTE };
  assert.equal(clockAdjustWrite(capped, 10 * MINUTE, now).adjust, CLOCK_ADJUST_MAX_MS, 'clamped to the 30-minute total');
  assert.equal(ruleAccepts(capped, { ...capped, remain: capped.remain + 6 * MINUTE, adjust: 31 * MINUTE, seq: capped.seq + 1 }, now), false, 'the rule caps the total too');
  // 減到剩 0 為止（照 now 算），調完剛好 0 的那一刻就是日落。
  const short = started(10);
  const late = T0 + 7 * MINUTE + 500;
  const down = clockAdjustWrite(short, -10 * MINUTE, late);
  assert.equal(clockRemaining(down, late), 0);
  assert.equal(down.adjust, -(3 * MINUTE - 500));
  assert.equal(ruleAccepts(short, down, late), true);
  assert.equal(clockPassed(down, late), true);
  assert.equal(clockAdjustWrite(down, MINUTE, late), null, 'after sunset nothing can be added');
  assert.equal(ruleAccepts(down, { ...down, remain: down.remain + MINUTE, adjust: down.adjust + MINUTE, seq: down.seq + 1 }, late), false, 'the rule refuses it too');
  assert.equal(ruleAccepts(short, { ...short, remain: short.remain - 10 * MINUTE, adjust: -10 * MINUTE, seq: 2 }, late), false, 'the rule refuses a negative remainder');
  assert.equal(clockAdjustWrite(short, 0, late), null, 'zero is nothing to write');
  assert.throws(() => clockAdjustWrite(short, Number.NaN, late), RangeError);
  // 暫停中也能調，日落時刻照樣沒有（暫停）；調到 0 就算到了。
  const paused = clockPauseWrite(short, T0 + MINUTE);
  const pausedDown = clockAdjustWrite(paused, -10 * MINUTE, T0 + 50 * MINUTE);
  assert.equal(ruleAccepts(paused, pausedDown, T0 + 50 * MINUTE), true);
  assert.deepEqual([clockRemaining(pausedDown, T0 + 99 * MINUTE), clockPassed(pausedDown, T0 + 99 * MINUTE), clockPaused(pausedDown)], [0, true, true]);
});

test('random sequences of pause, resume and adjust always pass the rule, and elapsed never goes back', () => {
  const random = seededRandom(20261019);
  const pick = (n) => random() % n;
  for (let run = 0; run < 40; run += 1) {
    let now = T0;
    let clock = started(10 + pick(60));
    let elapsed = clockElapsed(clock, now);
    for (let step = 0; step < 30 && !clockPassed(clock, now); step += 1) {
      now += pick(4 * MINUTE);
      const before = clockElapsed(clock, now);
      assert.ok(before >= elapsed, 'time only moves elapsed forward');
      let next = null;
      const kind = pick(3);
      if (kind === 0) next = clockPassed(clock, now) ? null : clockPauseWrite(clock, now);
      else if (kind === 1) next = clockResumeWrite(clock, now);
      else next = clockAdjustWrite(clock, (pick(41) - 20) * 30_000, now);
      if (!next) continue;
      assert.equal(ruleAccepts(clock, next, now), true, `run ${run} step ${step} kind ${kind}`);
      assert.equal(clockElapsed(next, now), before, 'a write never moves elapsed');
      clock = next;
      elapsed = before;
    }
  }
});

test('shouldEnd with a clock: sunset follows the clock, a paused clock never reaches sunset, no clock follows startedAt; the order stays', () => {
  const clock = started(75);
  const state = { round: 3, startedAt: T0 };
  assert.equal(shouldEnd(state, settings, T0 + 75 * MINUTE, clock), 'sunset');
  assert.equal(shouldEnd(state, settings, T0 + 75 * MINUTE - 1, clock), null);
  const paused = clockPauseWrite(clock, T0 + MINUTE);
  assert.equal(shouldEnd(state, settings, T0 + 300 * MINUTE, paused), null, 'paused: no sunset even long after the table clock');
  assert.equal(shouldEnd(state, settings, T0 + 300 * MINUTE), 'sunset', 'without the clock the table started 300 minutes ago');
  assert.equal(shouldEnd({ round: 3, startedAt: T0 + 70 * MINUTE }, settings, T0 + 76 * MINUTE, clock), 'sunset', 'a table that started late ends with everyone');
  const later = clockAdjustWrite(clock, 10 * MINUTE, T0);
  assert.equal(shouldEnd(state, settings, T0 + 80 * MINUTE, later), null, 'added time moves sunset for every table');
  assert.equal(shouldEnd(state, settings, T0 + 75 * MINUTE, null), 'sunset', 'null is no clock');
  assert.equal(shouldEnd(state, settings, T0 + 75 * MINUTE, { seq: 1 }), 'sunset', 'a broken clock counts as no clock');
  // 順序照舊：日落 → 回合上限 → 主持端。
  assert.equal(shouldEnd({ round: 12, startedAt: T0, endAfterRound: 12 }, settings, T0 + 80 * MINUTE, clock), 'sunset');
  assert.equal(shouldEnd({ round: 12, startedAt: T0, endAfterRound: 12 }, settings, T0, clock), 'maxRounds');
  assert.equal(shouldEnd({ round: 4, startedAt: T0, endAfterRound: 4 }, settings, T0, paused), 'host');
  // endReasonAt 與 sunsetStatus 用同一個判斷。
  const game = { seats: { a: { order: 0 } }, startedAt: T0, endAfterRound: 2 };
  assert.equal(endReasonAt(game, { round: 2, phase: 'day' }, settings, T0, clock), 'host');
  assert.equal(endReasonAt(game, { round: 1, phase: 'night' }, settings, T0 + 75 * MINUTE, clock), 'sunset');
  assert.equal(endReasonAt(game, { round: 2, phase: 'end' }, settings, T0, clock), null, 'the end phase has no last round');
  assert.equal(endReasonAt({ startedAt: T0 }, { round: 1, phase: 'day' }, settings, T0 + 99 * MINUTE), null, 'no seats: not started');
  assert.deepEqual(sunsetStatus(game, settings, T0 + 30 * MINUTE, clock), {
    global: true,
    paused: false,
    elapsed: 30 * MINUTE,
    remaining: 45 * MINUTE,
    passed: false,
    sunsetAt: T0 + 75 * MINUTE,
    length: 75 * MINUTE,
  });
  assert.deepEqual(sunsetStatus(game, settings, T0 + 30 * MINUTE), {
    global: false,
    paused: false,
    elapsed: 30 * MINUTE,
    remaining: 45 * MINUTE,
    passed: false,
    sunsetAt: T0 + 75 * MINUTE,
    length: 75 * MINUTE,
  });
  assert.equal(sunsetStatus(game, settings, T0 + 2 * MINUTE, paused).sunsetAt, null);
  assert.equal(sunsetStatus({}, settings, T0), null, 'not started and no clock');
  assert.equal(sunsetStatus({}, settings, T0, clock).global, true, 'the clock runs before a table starts');
});

test('clockOf finds the clock of the match a key belongs to, whether clock reads back as an array or an object', () => {
  const one = started(75);
  const two = started(60);
  const asArray = { clock: [undefined, one, two] };
  assert.equal(clockOf(asArray, '3'), one);
  assert.equal(clockOf(asArray, 3), one);
  assert.equal(clockOf(asArray, '3-2'), two);
  const asObject = { clock: { 2: two } };
  assert.equal(clockOf(asObject, '1'), null);
  assert.equal(clockOf(asObject, '6-2'), two);
  assert.equal(clockOf({}, '1'), null);
  assert.equal(clockOf(asArray, '7'), null, 'not a key');
  assert.equal(clockOf(null, '1'), null);
});

// ---- 批次動作的計畫 ----

const seats3 = (prefix = '') => ({
  [`${prefix}a`]: { order: 0, role: 'r1', pounds: 10, influence: 3, handCount: 6 },
  [`${prefix}b`]: { order: 1, role: 'r2', pounds: 10, influence: 3, handCount: 6 },
  [`${prefix}c`]: { order: 2, role: 'r3', pounds: 10, influence: 3, handCount: 6 },
});

function roomWith({ tables = {}, games = {}, deals = {}, players = {}, extra = {}, tableCount = 6 } = {}) {
  return { meta: { hostUid: 'host', createdAt: T0, tableCount }, tables, games, deals, players, ...extra };
}

const playersAt = (table, uids, base = 0) => Object.fromEntries(uids.map((uid, index) => [uid, { name: uid.toUpperCase(), table, joinedAt: T0 + base + index }]));

test('startPlan lists the tables to start, the skipped ones with the same reasons as the single start button, and whether the clock still has to start', () => {
  const room = roomWith({
    tables: { 1: { round: 1, phase: 'sunrise' }, 2: { round: 1, phase: 'sunrise' }, 3: { round: 1, phase: 'sunrise' }, 4: { round: 1, phase: 'sunrise' }, 5: { round: 1, phase: 'day' }, 6: { round: 3, phase: 'end' }, '6-2': { round: 1, phase: 'sunrise' } },
    games: { 5: { seats: seats3() }, 6: { seats: seats3('s') } },
    players: { ...playersAt(1, ['p1', 'p2', 'p3']), ...playersAt(3, ['q2', 'q1'], 10), ...playersAt(4, ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']) },
  });
  const plan = startPlan(room, data);
  assert.equal(plan.match, 1);
  assert.deepEqual(plan.start, [
    { key: '1', table: 1, uids: ['p1', 'p2', 'p3'], count: 3, warning: null },
    { key: '3', table: 3, uids: ['q2', 'q1'], count: 2, warning: '只有 2 人，建議至少 3 人' },
  ]);
  assert.deepEqual(plan.skip, [
    { key: '2', table: 2, count: 0, reason: '這一桌還沒有玩家' },
    { key: '4', table: 4, count: 7, reason: '一桌最多 6 人，現在有 7 人，請多的人改到別桌' },
  ]);
  assert.deepEqual(plan.started, ['5'], 'a table in its second match is not part of the first-match plan');
  assert.deepEqual(plan.clock, { match: 1, needed: true, minutes: 75 });
  assert.equal(startPlan({ ...room, clock: { 1: started(75) } }, data).clock.needed, false);
  assert.deepEqual(startPlan(roomWith({ tableCount: 2, tables: { 1: { round: 1, phase: 'sunrise' }, 2: { round: 1, phase: 'sunrise' } } }), data).skip.map(({ key }) => key), ['1', '2']);
});

test('startMatch2Plan takes this device’s picks or the default, and names who sits out and why', () => {
  const first = { a: { order: 0, role: 'r1' }, b: { order: 1, role: 'r2' }, c: { order: 2, role: 'r3' }, d: { order: 3, role: 'r4' } };
  const room = roomWith({
    tables: { 1: { round: 4, phase: 'end' }, '1-2': { round: 1, phase: 'sunrise' }, 2: { round: 4, phase: 'end' }, '2-2': { round: 2, phase: 'day' }, 3: { round: 1, phase: 'day' } },
    games: { 1: { seats: first }, 2: { seats: seats3() }, '2-2': { seats: seats3() } },
    players: { ...playersAt(1, ['b', 'a', 'newcomer']), ...playersAt(2, ['c']) },
  });
  const plan = startMatch2Plan(room, data);
  assert.equal(plan.match, 2);
  assert.deepEqual(plan.start, [
    {
      key: '1-2',
      table: 1,
      include: ['a', 'b'],
      count: 2,
      absent: [
        { uid: 'c', why: 'moved' },
        { uid: 'd', why: 'left' },
      ],
      warning: '只有 2 人，建議至少 3 人',
    },
  ]);
  assert.deepEqual(plan.started, ['2-2']);
  assert.deepEqual(plan.skip, []);
  assert.deepEqual(plan.clock, { match: 2, needed: true, minutes: 75 });
  const picked = startMatch2Plan(room, data, { '1-2': ['b', 'c', 'stranger'] });
  assert.deepEqual(picked.start[0].include, ['b', 'c'], 'picks are kept to the first-match seats, in seat order');
  assert.deepEqual(picked.start[0].absent, [
    { uid: 'a', why: 'unchecked' },
    { uid: 'd', why: 'left' },
  ]);
  assert.deepEqual(startMatch2Plan(room, data, new Map([['1-2', new Set(['a'])]])).start[0].include, ['a'], 'a Map of Sets works too');
  assert.deepEqual(startMatch2Plan(room, data, { '1-2': [] }).skip, [{ key: '1-2', table: 1, count: 0, reason: '第 2 場至少要勾 1 人參加' }]);
});

// 一桌的局面：stage 是要的那一步。
function gameAt(stage, round = 2) {
  const game = { seats: seats3(), startedAt: T0, version: 5 };
  if (stage === 'day-playing') game.turn = { round, index: 1, plays: 0, level: 0 };
  if (stage === 'day-done') game.turn = { round, index: 3, plays: 0, level: 0 };
  if (stage === 'day-pending') game.pending = { id: 'x', by: 'a', seq: 1, card: 'a01', level: 1, openedAt: T0, seconds: 5 };
  if (stage === 'dusk-voting') game.dusk = { round, bill: 'b01', openedAt: T0, submitted: 1 };
  if (stage === 'dusk-closing') game.dusk = { round, bill: 'b01', openedAt: T0, submitted: 3, revealAt: T0 + 3000 };
  if (stage === 'dusk-revealed') game.dusk = { round, bill: 'b01', openedAt: T0, submitted: 3, revealAt: T0, result: { yes: 1, no: 0, passed: true } };
  if (stage === 'dusk-adjourned') game.dusk = { round, openedAt: T0, submitted: 0 };
  if (stage === 'night-choosing') game.night = { round, openedAt: T0, submitted: 0 };
  if (stage === 'night-revealed') game.night = { round, openedAt: T0, submitted: 3, revealAt: T0, result: { players: {} } };
  return game;
}

test('advancePlan only takes tables whose next step is the next phase and that can go now; everything else is skipped with a reason', () => {
  const at = (phase, round = 2) => ({ round, phase, fog: 0, updatedAt: T0 });
  const room = roomWith({
    tables: { 1: at('sunrise'), 2: at('day'), 3: at('day'), 4: at('dusk'), 5: at('night'), 6: at('night') },
    games: { 1: gameAt('sunrise'), 2: gameAt('day-playing'), 3: gameAt('day-done'), 4: gameAt('dusk-voting'), 5: gameAt('night-revealed'), 6: { ...gameAt('night-revealed'), endAfterRound: 2 } },
    deals: { 1: 2 },
  });
  const plan = advancePlan(room, settings, T0 + MINUTE);
  assert.equal(plan.paused, false);
  assert.equal(plan.includeEnding, false);
  assert.deepEqual(
    plan.advance.map(({ key, round, phase, to, ending, deal, note }) => ({ key, round, phase, to, ending, deal, note })),
    [
      { key: '1', round: 2, phase: 'sunrise', to: { round: 2, phase: 'day' }, ending: null, deal: false, note: null },
      { key: '3', round: 2, phase: 'day', to: { round: 2, phase: 'dusk' }, ending: null, deal: false, note: null },
      { key: '5', round: 2, phase: 'night', to: { round: 3, phase: 'sunrise' }, ending: null, deal: true, note: null },
    ],
  );
  assert.deepEqual(
    plan.skip.map(({ key, reason, text }) => [key, reason, text]),
    [
      ['2', 'playing', '白晝還有 2 人沒出完'],
      ['4', 'voting', '黃昏還沒揭曉'],
      ['6', 'ending', '這一回合結束就算分（算分後不能回頭，要另外勾）'],
    ],
  );
  assert.equal(plan.skip.find(({ key }) => key === '6').ending, 'host');
  // 勾了「連要算分的桌一起推」。
  const all = advancePlan(room, settings, T0 + MINUTE, { includeEnding: true });
  assert.equal(all.includeEnding, true);
  assert.deepEqual(all.advance.find(({ key }) => key === '6'), {
    key: '6',
    table: 6,
    match: 1,
    round: 2,
    phase: 'night',
    to: { round: 2, phase: 'end' },
    ending: 'host',
    deal: false,
    note: null,
  });
  // 全場鐘到了：黑夜揭曉的桌都要算分。
  const sunset = advancePlan({ ...room, clock: { 1: started(10) } }, settings, T0 + 11 * MINUTE);
  assert.deepEqual(
    sunset.skip.filter(({ reason }) => reason === 'ending').map(({ key, ending }) => [key, ending]),
    [
      ['5', 'sunset'],
      ['6', 'sunset'],
    ],
  );
  // 全場暫停中：一桌都不推。
  const paused = advancePlan({ ...room, display: { pause: { on: true, seq: 1, at: T0, by: 'host' } } }, settings, T0 + MINUTE);
  assert.equal(paused.paused, true);
  assert.deepEqual(paused.advance, []);
  assert.deepEqual(new Set(paused.skip.map(({ reason }) => reason)), new Set(['paused']));
  assert.deepEqual(advancePlan({ ...room, display: { pause: { on: false, seq: 2, at: T0, by: 'host' } } }, settings, T0 + MINUTE).advance.length, 3, 'after resuming');
});

test('advancePlan skips the response window, the vote and the night before the reveal, the undealt sunrise, ended tables and the unstarted second match', () => {
  const at = (phase, round = 2) => ({ round, phase, fog: 0, updatedAt: T0 });
  const room = roomWith({
    tables: { 1: at('sunrise'), 2: at('day'), 3: at('dusk'), 4: at('night'), 5: at('end'), 6: at('end'), '6-2': at('sunrise', 1) },
    games: { 1: gameAt('sunrise'), 2: gameAt('day-pending'), 3: gameAt('dusk-closing'), 4: gameAt('night-choosing'), 5: { ...gameAt('night-revealed'), final: { round: 2 } }, 6: gameAt('night-revealed') },
    deals: { 1: 1 },
  });
  const plan = advancePlan(room, settings, T0);
  assert.deepEqual(plan.advance, []);
  assert.deepEqual(
    plan.skip.map(({ key, reason }) => [key, reason]),
    [
      ['1', 'not-dealt'],
      ['2', 'responding'],
      ['3', 'voting'],
      ['4', 'choosing'],
      ['5', 'ended'],
      ['6-2', 'not-started'],
    ],
  );
  assert.equal(plan.skip.at(-1).text, '第 2 場還沒開局');
  const more = roomWith({
    tables: { 1: at('dusk'), 2: at('dusk'), 3: at('dusk'), 4: at('night'), 5: at('sunrise', 1) },
    games: { 1: gameAt('dusk-adjourned'), 2: gameAt('dusk-revealed'), 3: gameAt('night'), 4: gameAt('night') },
    tableCount: 5,
  });
  const second = advancePlan(more, settings, T0);
  assert.deepEqual(
    second.advance.map(({ key, to }) => [key, to.phase]),
    [
      ['1', 'night'],
      ['2', 'night'],
    ],
    'an adjourned or revealed dusk can go on',
  );
  assert.deepEqual(
    second.skip.map(({ key, reason, text }) => [key, reason, text]),
    [
      ['3', 'not-open', '法案還沒翻開'],
      ['4', 'not-open', '黑夜還沒開始'],
      ['5', 'not-started', '還沒開局'],
    ],
  );
});

test('advancePlan notes the players over the hand limit who have not picked their discards (missingDiscards)', () => {
  const game = gameAt('night-revealed');
  game.seats.a.handCount = 9;
  game.seats.b.handCount = 8;
  const room = roomWith({ tables: { 1: { round: 2, phase: 'night' } }, games: { 1: game }, tableCount: 1 });
  const none = advancePlan(room, settings, T0, { discards: {} });
  assert.equal(none.advance[0].note, '沒挑棄牌的 2 人會被隨機棄到上限');
  assert.deepEqual(missingDiscards('1', game, room.tables[1], settings, {}), ['a', 'b']);
  const discards = { a: { table: '1', round: 2, cards: ['x', 'y'], seq: 1, at: T0 }, b: { table: '1', round: 1, cards: ['x'], seq: 1, at: T0 } };
  assert.deepEqual(missingDiscards('1', game, room.tables[1], settings, discards), ['b'], 'b picked for the wrong round');
  assert.equal(advancePlan(room, settings, T0, { discards }).advance[0].note, '沒挑棄牌的 1 人會被隨機棄到上限');
  const picked = { ...discards, b: { table: '1', round: 2, cards: ['z'], seq: 2, at: T0 } };
  assert.equal(advancePlan(room, settings, T0, { discards: picked }).advance[0].note, null);
  assert.equal(advancePlan(room, settings, T0).advance[0].note, null, 'without discards there is no note');
  assert.deepEqual(missingDiscards('1', game, { round: 2, phase: 'day' }, settings, {}), [], 'only at night');
  assert.deepEqual(missingDiscards('1', game, room.tables[1], settings, { a: { table: '1-2', round: 2, cards: ['x', 'y'] } }).includes('a'), true, 'a pick for the other match does not count');
});

// ---- 在等誰 ----

test('waitingFor names who has and has not sent, counted exactly like dusk.submitted and night.submitted', () => {
  const room = roomWith({ tables: { 2: { round: 2, phase: 'dusk' }, '3-2': { round: 1, phase: 'night' }, 3: { round: 4, phase: 'end' } }, games: { 2: gameAt('dusk-voting'), '3-2': { ...gameAt('night-choosing', 1) } } });
  const votes = {
    a: { table: '2', round: 2, side: 'yes', bid: 1, seq: 1, at: T0 + 10 },
    b: { table: '2', round: 1, side: 'no', bid: 0, seq: 3, at: T0 + 10 }, // 上一回合的票
    c: { table: '3', round: 2, side: 'yes', bid: 0, seq: 1, at: T0 + 10 }, // 別桌的票
  };
  const dusk = waitingFor(room, '2', { votes });
  assert.deepEqual(dusk, { kind: 'dusk', submitted: ['a'], missing: ['b', 'c'] });
  const view = { table: '2', round: 2, phase: 'dusk', seats: room.games[2].seats, dusk: room.games[2].dusk };
  assert.equal(dusk.submitted.length, submittedCount(view, votes), 'same count as dusk.submitted');
  const nights = {
    a: { table: '3', round: 1, choice: 'sleep', seq: 1, at: T0 + 10 }, // 第 1 場的選擇
    b: { table: '3-2', round: 1, choice: 'gamble', tiers: 2, seq: 2, at: T0 + 10 },
    c: { table: '3-2', round: 1, choice: 'split', seq: 1, at: T0 - 10 }, // 黑夜開始之前
  };
  const night = waitingFor(room, '3-2', { nights });
  assert.deepEqual(night, { kind: 'night', submitted: ['b'], missing: ['a', 'c'] });
  assert.equal(night.submitted.length, submittedChoices({ table: '3-2', round: 1, phase: 'night', seats: room.games['3-2'].seats, night: room.games['3-2'].night }, nights));
  assert.equal(waitingFor(room, '3'), null, 'an ended table waits for nobody');
  assert.equal(waitingFor(room, '4'), null);
  const revealed = roomWith({ tables: { 1: { round: 2, phase: 'dusk' } }, games: { 1: gameAt('dusk-revealed') } });
  assert.equal(waitingFor(revealed, '1', { votes }), null, 'after the reveal nobody is waited for');
  const closing = roomWith({ tables: { 1: { round: 2, phase: 'dusk' } }, games: { 1: gameAt('dusk-closing') } });
  assert.equal(waitingFor(closing, '1', { votes: {} }).missing.length, 3, 'still listed during the countdown');
});

// ---- 投影端與玩家端 ----

test('the screen plays a sound only once per seq and never when it is more than 5 seconds old', () => {
  const sfx = { id: 'bell', seq: 3, at: T0, by: 'host' };
  assert.equal(sfxToPlay(sfx, 2, T0 + 200), true);
  assert.equal(sfxToPlay(sfx, 2, T0 + SFX_STALE_MS), true, 'exactly 5 seconds still plays');
  assert.equal(sfxToPlay(sfx, 2, T0 + SFX_STALE_MS + 1), false, 'older than 5 seconds: not replayed after a reconnect');
  assert.equal(sfxToPlay(sfx, 3, T0 + 200), false, 'the same seq is not played twice');
  assert.equal(sfxToPlay(sfx, 4, T0 + 200), false);
  assert.equal(sfxToPlay(sfx, undefined, T0), true, 'nothing seen yet');
  assert.equal(sfxToPlay(null, 0, T0), false);
  assert.equal(sfxToPlay({ id: 'bell', seq: 1 }, 0, T0), false, 'no time, no sound');
});

test('the pause layer waits for a countdown that began before the pause, and only for that', () => {
  const pause = { on: true, seq: 1, at: T0 + 10_000, by: 'host' };
  const state = { round: 2, phase: 'day' };
  // 暫停前開的響應窗口：倒數結束才蓋。
  const windowGame = { pending: { id: 'p', by: 'a', seq: 1, card: 'a01', level: 1, openedAt: T0 + 8000, seconds: 5 } };
  assert.deepEqual(pauseHold(pause, windowGame, state, settings, T0 + 11_000), { covered: false, until: T0 + 13_000 });
  assert.deepEqual(pauseHold(pause, windowGame, state, settings, T0 + 13_000), { covered: true, until: null }, 'covered when the countdown ends');
  // 暫停之後才開的窗口（舊網頁）不掀開暫停層。
  const later = { pending: { ...windowGame.pending, openedAt: T0 + 10_500 } };
  assert.deepEqual(pauseHold(pause, later, state, settings, T0 + 11_000), { covered: true, until: null });
  // 揭曉倒數（黃昏 3 秒）：截止減 3 秒早於暫停＝暫停前開始的。
  const dusk = { dusk: { round: 2, bill: 'b01', openedAt: T0, submitted: 3, revealAt: T0 + 12_000 } };
  assert.deepEqual(pauseHold(pause, dusk, { round: 2, phase: 'dusk' }, settings, T0 + 10_200), { covered: false, until: T0 + 12_000 });
  const lateDusk = { dusk: { ...dusk.dusk, revealAt: T0 + 13_500 } };
  assert.deepEqual(pauseHold(pause, lateDusk, { round: 2, phase: 'dusk' }, settings, T0 + 10_600), { covered: true, until: null }, 'a countdown that began after the pause');
  assert.deepEqual(pauseHold(pause, dusk, { round: 2, phase: 'night' }, settings, T0 + 10_200), { covered: true, until: null }, 'the vote is closed once it is night');
  const revealed = { dusk: { ...dusk.dusk, result: { yes: 0, no: 0, passed: false } } };
  assert.deepEqual(pauseHold(pause, revealed, { round: 2, phase: 'dusk' }, settings, T0 + 10_200), { covered: true, until: null });
  const night = { night: { round: 2, openedAt: T0, submitted: 3, revealAt: T0 + 11_000 } };
  assert.deepEqual(pauseHold(pause, night, { round: 2, phase: 'night' }, settings, T0 + 10_100), { covered: false, until: T0 + 11_000 });
  // 兩個都在跑時等比較晚的那一個。
  const both = { ...windowGame, night: night.night };
  assert.deepEqual(pauseHold(pause, both, { round: 2, phase: 'night' }, settings, T0 + 10_100), { covered: false, until: T0 + 13_000 });
  // 沒有暫停。
  assert.deepEqual(pauseHold({ on: false, seq: 2, at: T0, by: 'host' }, windowGame, state, settings, T0), { covered: false, until: null });
  assert.deepEqual(pauseHold(null, windowGame, state, settings, T0), { covered: false, until: null });
  assert.deepEqual(pauseHold(pause, null, null, settings, T0 + 11_000), { covered: true, until: null }, 'no table: covered at once');
});

// ---- 排行與全場最高分 ----

const score = (total, rank, pounds = 0) => ({ total, rank, assets: { pounds, influence: 0, points: 0 }, destiny: { done: false, points: 0 }, sin: 0, sinPenalty: 0 });

test('standingsOf ranks each table by itself: the combined two matches, the first match only, or still playing', () => {
  const firstSeats = { a: { order: 0 }, b: { order: 1 }, c: { order: 2 } };
  const final1 = { round: 4, reason: 'host', scores: { a: score(10, 2), b: score(14, 1), c: score(10, 2) } };
  const final2 = { round: 4, reason: 'host', scores: { a: score(9, 1), b: score(2, 3), c: score(5, 2) } };
  const room = roomWith({
    tables: { 1: { round: 4, phase: 'end' }, '1-2': { round: 4, phase: 'end' }, 2: { round: 4, phase: 'end' }, 3: { round: 4, phase: 'end' }, '3-2': { round: 1, phase: 'day' }, 4: { round: 2, phase: 'day' }, 5: { round: 1, phase: 'sunrise' }, '2-2': { round: 1, phase: 'sunrise' } },
    games: { 1: { seats: firstSeats, final: final1 }, '1-2': { seats: firstSeats, final: final2 }, 2: { seats: firstSeats, final: final1 }, 3: { seats: firstSeats, final: final1 }, '3-2': { seats: firstSeats }, 4: { seats: firstSeats } },
    tableCount: 5,
  });
  const combined = standingsOf(room, 1);
  assert.deepEqual([combined.status, combined.basis, combined.match], ['ended', 'combined', 2]);
  assert.deepEqual(
    combined.rows,
    Object.entries(combineScores(final1, final2, firstSeats)).map(([uid, row]) => ({ uid, rank: row.rank, total: row.total, first: row.first, second: row.second })),
  );
  assert.deepEqual(
    combined.rows.map(({ uid, rank, total }) => [uid, rank, total]),
    [
      ['a', 1, 19],
      ['b', 2, 16],
      ['c', 3, 15],
    ],
  );
  const firstOnly = standingsOf(room, '2');
  assert.deepEqual([firstOnly.status, firstOnly.basis, firstOnly.match], ['ended', 'first', 2], 'the second match is open but not started');
  assert.deepEqual(firstOnly.rows, [
    { uid: 'b', rank: 1, total: 14 },
    { uid: 'a', rank: 2, total: 10 },
    { uid: 'c', rank: 2, total: 10 },
  ]);
  assert.deepEqual(standingsOf(room, 3), { table: 3, match: 2, status: 'playing', basis: null, rows: [] }, 'the second match is being played');
  assert.deepEqual(standingsOf(room, 4), { table: 4, match: 1, status: 'playing', basis: null, rows: [] });
  assert.deepEqual(standingsOf(room, 5), { table: 5, match: 1, status: 'idle', basis: null, rows: [] });
  assert.equal(standingsOf(room, 6), null);
  assert.equal(standingsOf(room, '1-2'), null, 'takes the table number, not a key');
});

test('topScores is the highest score in the room: the combined total once any table has played both matches, otherwise the first match', () => {
  const seats = { a: { order: 0 }, b: { order: 1 } };
  const firstOf = (a, b) => ({ round: 3, reason: 'host', scores: { a: score(a, a >= b ? 1 : 2), b: score(b, b >= a ? 1 : 2) } });
  const room = roomWith({
    tables: { 1: { round: 3, phase: 'end' }, 2: { round: 3, phase: 'end' }, 3: { round: 1, phase: 'day' } },
    games: { 1: { seats, final: firstOf(12, 30) }, 2: { seats, final: firstOf(30, 4) }, 3: { seats } },
    tableCount: 3,
  });
  assert.deepEqual(topScores(room), {
    basis: 'first',
    total: 30,
    winners: [
      { table: 1, uid: 'b' },
      { table: 2, uid: 'a' },
    ],
  });
  const both = {
    ...room,
    tables: { ...room.tables, '2-2': { round: 3, phase: 'end' } },
    games: { ...room.games, '2-2': { seats, final: firstOf(1, 8) } },
  };
  assert.deepEqual(topScores(both), { basis: 'combined', total: 31, winners: [{ table: 2, uid: 'a' }] }, 'only the tables that played both matches');
  assert.equal(topScores(roomWith({ tables: { 1: { round: 1, phase: 'day' } }, games: { 1: { seats } }, tableCount: 1 })), null, 'nobody has finished');
});

// ---- 指令格式與版本 ----

test('a broadcast is trimmed and 1–40 long, counted like nicknames (most emoji count 2)', () => {
  assert.equal(BROADCAST_MAX_LENGTH, 40);
  assert.equal(normalizeBroadcast('  休息十分鐘  '), '休息十分鐘');
  assert.equal(normalizeBroadcast(null), '');
  assert.equal(isValidBroadcast('a'.repeat(40)), true);
  assert.equal(isValidBroadcast('字'.repeat(40)), true);
  assert.equal(isValidBroadcast('a'.repeat(41)), false);
  assert.equal(isValidBroadcast(''), false);
  assert.equal(isValidBroadcast(' 前面有空白'), false, 'trim first');
  assert.equal(isValidBroadcast('😀'.repeat(20)), true, '20 emoji are 40');
  assert.equal(isValidBroadcast('😀'.repeat(21)), false);
  assert.equal(isValidBroadcast(normalizeBroadcast(`  ${'b'.repeat(40)}  `)), true);
  assert.equal(isValidBroadcast(42), false);
});

test('a scene is one of the five ids, with an optional page 0–20', () => {
  assert.deepEqual(SCENE_IDS, ['opening', 'rules', 'overview', 'standings', 'awards']);
  for (const id of SCENE_IDS) assert.equal(isValidScene(id), true, id);
  assert.equal(isValidScene('rules', 0), true);
  assert.equal(isValidScene('awards', 20), true);
  assert.equal(isValidScene('awards', 21), false);
  assert.equal(isValidScene('rules', -1), false);
  assert.equal(isValidScene('rules', 1.5), false);
  assert.equal(isValidScene('lobby'), false);
  assert.equal(isValidScene('rules', null), true, 'no page');
});

test('the web version is a positive whole number', () => {
  assert.ok(Number.isInteger(WEB_VERSION) && WEB_VERSION >= 2, String(WEB_VERSION));
});
