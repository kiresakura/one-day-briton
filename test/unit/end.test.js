// 終局與計分的純函式（M9）：日落鐘、回合上限、提早收場（shouldEnd），天命的每一種判定（手牌先套手牌上限），資產、公共成就、罪孽、總分、名次，
// 主持端勾天命，以及開局發天命避開這一桌沒人坐的階層。資料用範例資料加上測試裡寫的天命，不依賴正式資料。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { withDefaultSettings } from '../../play/js/data.js';
import {
  END_REASONS,
  achievementsOf,
  assignSeats,
  buildDeck,
  destinyDone,
  draw,
  endGame,
  judgeScores,
  maxChains,
  pickDestiny,
  randomBelow,
  rankScores,
  scoreGame,
  scoreSettings,
  seededRandom,
  shouldEnd,
  shuffle,
  startGame,
  sunrise,
  sunsetClock,
} from '../../play/js/game.js';
import { loadDataFolder } from '../../scripts/lib/datafiles.mjs';

const sampleDir = fileURLToPath(new URL('../fixtures/data-example/', import.meta.url));
const { data: sample } = await loadDataFolder(sampleDir);
const settings = withDefaultSettings(sample.settings);
const MINUTE = 60_000;

// 企劃 10/15 給的 12 張天命的判定（文字是測試用的；判定照 data.js 的結構）。
const DESTINIES = [
  ['d01', 'r1', { kind: 'bills', passed: false, bills: ['b05'], atLeast: 1 }],
  ['d02', 'r1', { kind: 'compare', what: 'fog', op: '<', value: 60 }],
  ['d03', 'r2', { kind: 'most', what: 'pounds' }],
  ['d04', 'r2', { kind: 'bills', passed: false, bills: ['b01', 'b06'], atLeast: 2 }],
  ['d05', 'r3', { kind: 'bills', passed: true, bills: ['b06'], atLeast: 1 }],
  ['d06', 'r3', { kind: 'bills', passed: true, bills: ['b01', 'b06', 'b02', 'b03'], atLeast: 2 }],
  ['d07', 'r4', { kind: 'most', what: 'influence' }],
  ['d08', 'r4', { kind: 'moreThan', what: 'pounds', role: 'r5' }],
  ['d09', 'r5', { kind: 'compare', what: 'pounds', op: '>=', value: 40 }],
  ['d10', 'r5', { kind: 'compare', what: 'fog', op: '>=', value: 60 }],
  ['d11', 'r6', { kind: 'compare', what: 'fogMax', op: '>', value: 90 }],
  ['d12', 'r6', { kind: 'most', what: 'hand' }],
].map(([id, role, check]) => ({ id, role, text: `天命 ${id}`, score: { text: `條件 ${id}`, points: 10 }, check }));
const data = { ...sample, settings, destinies: DESTINIES };

// 資料庫不存 null 與空的陣列、物件：存成 JSON、拿掉這些再讀回來。
const stored = (value) =>
  JSON.parse(JSON.stringify(value), (key, item) => {
    if (item === null) return undefined;
    if (Array.isArray(item) && item.length === 0) return undefined;
    if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) return undefined;
    return item;
  }) ?? {};

test('the score settings come from the data file, with defaults for the optional ones', () => {
  assert.deepEqual(scoreSettings(settings), { sunsetMinutes: 75, maxRounds: 12, poundsRate: 5, influenceRate: 3, achievementPoints: 3, sinPerPenalty: 2 });
  assert.deepEqual(scoreSettings({ sunsetMinutes: 30 }), { sunsetMinutes: 30, maxRounds: 12, poundsRate: 5, influenceRate: 3, achievementPoints: 3, sinPerPenalty: 2 });
  const changed = { ...settings, maxRounds: 4, scoreRates: { pounds: 10, influence: 2 }, achievementPoints: 0, sinPerPenalty: 1 };
  assert.deepEqual(scoreSettings(changed), { sunsetMinutes: 75, maxRounds: 4, poundsRate: 10, influenceRate: 2, achievementPoints: 0, sinPerPenalty: 1 });
});

test('the sunset clock ends the game from exactly sunsetMinutes after the start, not a second before', () => {
  const start = 1_000_000;
  const at = (ms, round = 3) => shouldEnd({ round, startedAt: start }, settings, start + ms);
  assert.equal(at(75 * MINUTE), 'sunset');
  assert.equal(at(75 * MINUTE - 1000), null);
  assert.equal(at(75 * MINUTE + 1), 'sunset');
  assert.equal(at(75 * MINUTE, 1), 'sunset', 'any round, even the first');
  assert.deepEqual(sunsetClock(start, settings, start + 30 * MINUTE), { elapsed: 30 * MINUTE, remaining: 45 * MINUTE, passed: false });
  assert.deepEqual(sunsetClock(start, settings, start + 75 * MINUTE - 1000), { elapsed: 75 * MINUTE - 1000, remaining: 1000, passed: false });
  assert.deepEqual(sunsetClock(start, settings, start + 80 * MINUTE), { elapsed: 80 * MINUTE, remaining: 0, passed: true });
  assert.deepEqual(sunsetClock(start, settings, start - 5000), { elapsed: 0, remaining: 75 * MINUTE, passed: false }, 'a clock behind the start counts as 0');
  const short = { ...settings, sunsetMinutes: 2 };
  assert.equal(shouldEnd({ round: 1, startedAt: start }, short, start + 2 * MINUTE), 'sunset');
  assert.equal(shouldEnd({ round: 1, startedAt: start }, short, start + 2 * MINUTE - 1000), null);
  assert.equal(shouldEnd({ round: 1 }, settings, start), null, 'no start time: the clock does not end the game');
});

test('round 12 is the last round by default, and maxRounds moves it', () => {
  assert.equal(shouldEnd({ round: 12, startedAt: 0 }, settings, MINUTE), 'maxRounds');
  assert.equal(shouldEnd({ round: 11, startedAt: 0 }, settings, MINUTE), null);
  assert.equal(shouldEnd({ round: 13, startedAt: 0 }, settings, MINUTE), 'maxRounds', 'past the limit still ends');
  assert.equal(shouldEnd({ round: 12, startedAt: 0 }, { sunsetMinutes: 75 }, MINUTE), 'maxRounds', 'the default when the data file has no maxRounds');
  assert.equal(shouldEnd({ round: 3, startedAt: 0 }, { ...settings, maxRounds: 3 }, MINUTE), 'maxRounds');
  assert.equal(shouldEnd({ round: 2, startedAt: 0 }, { ...settings, maxRounds: 3 }, MINUTE), null);
});

test('the host can end after this round and cancel it; a mark from an earlier round does nothing', () => {
  const base = { round: 4, startedAt: 0 };
  assert.equal(shouldEnd({ ...base, endAfterRound: 4 }, settings, MINUTE), 'host');
  assert.equal(shouldEnd(base, settings, MINUTE), null, 'cancelled: the field is gone');
  assert.equal(shouldEnd({ ...base, endAfterRound: null }, settings, MINUTE), null);
  assert.equal(shouldEnd({ ...base, endAfterRound: 3 }, settings, MINUTE), null, 'pressed in an earlier round');
  // 同時成立時取第一個：日落鐘、回合上限、主持端。
  assert.equal(shouldEnd({ round: 12, startedAt: 0, endAfterRound: 12 }, settings, 75 * MINUTE), 'sunset');
  assert.equal(shouldEnd({ round: 12, startedAt: 0, endAfterRound: 12 }, settings, MINUTE), 'maxRounds');
  assert.deepEqual(END_REASONS, ['sunset', 'maxRounds', 'host']);
});

// 終局的局面：a（r1）、b（r4）、c（r5）。迷霧 45、本場最高 92；b01 通過、b05 與 b06 沒通過，其他沒被表決。
const SEATS = {
  a: { order: 0, role: 'r1', pounds: 30, influence: 5, handCount: 6 },
  b: { order: 1, role: 'r4', pounds: 30, influence: 2, handCount: 9 },
  c: { order: 2, role: 'r5', pounds: 12, influence: 5, handCount: 3 },
};
const END = { seats: SEATS, fog: 45, fogMax: 92, bills: { b01: 'passed', b05: 'failed', b06: 'failed' } };
const done = (check, uid = 'a', state = END) => destinyDone(check, uid, state, settings);
const bills = (passed, list, atLeast) => ({ kind: 'bills', passed, bills: list, atLeast });

test('bill checks: passed, not passed (bills never voted on count as not passed), all not passed, at least N passed', () => {
  assert.equal(done(bills(true, ['b01'], 1)), true, '法案通過 b01');
  assert.equal(done(bills(true, ['b06'], 1)), false, 'b06 failed');
  assert.equal(done(bills(true, ['b02'], 1)), false, 'b02 never voted on');
  assert.equal(done(bills(false, ['b05'], 1)), true, '法案沒通過 b05');
  assert.equal(done(bills(false, ['b02'], 1)), true, 'never voted on counts as not passed');
  assert.equal(done(bills(false, ['b01'], 1)), false, 'b01 passed');
  assert.equal(done(bills(false, ['b05', 'b06'], 2)), true, '法案都沒通過 b05、b06');
  assert.equal(done(bills(false, ['b02', 'b03'], 2)), true, 'none of them voted on');
  assert.equal(done(bills(false, ['b01', 'b06'], 2)), false, 'b01 passed');
  assert.equal(done(bills(true, ['b01', 'b06', 'b02', 'b03'], 2)), false, 'only b01 of the four passed');
  assert.equal(done(bills(true, ['b01', 'b06', 'b02', 'b03'], 2), 'a', { ...END, bills: { ...END.bills, b03: 'passed' } }), true, 'b01 and b03');
  assert.equal(done(bills(true, ['b01'], 1), 'a', { ...END, bills: { b01: 'failed' } }), false, 'the last result counts');
  assert.equal(done(bills(false, ['b05'], 1), 'a', { seats: SEATS }), true, 'no bill was ever voted on');
});

test('fog checks: the fog at the end and the highest fog of the game', () => {
  const below60 = { kind: 'compare', what: 'fog', op: '<', value: 60 };
  const atLeast60 = { kind: 'compare', what: 'fog', op: '>=', value: 60 };
  const over90 = { kind: 'compare', what: 'fogMax', op: '>', value: 90 };
  assert.equal(done(below60), true);
  assert.equal(done(below60, 'a', { ...END, fog: 60 }), false, '60 is not below 60');
  assert.equal(done(atLeast60, 'a', { ...END, fog: 60 }), true);
  assert.equal(done(atLeast60), false);
  assert.equal(done(over90), true, 'fogMax 92 although the fog is 45 now');
  assert.equal(done(over90, 'a', { ...END, fogMax: 90, fog: 10 }), false, 'exactly 90 is not over 90');
  assert.equal(done(over90, 'a', { ...END, fogMax: undefined, fog: 95 }), true, 'no fogMax yet: the fog now counts');
  assert.equal(done(below60, 'a', { seats: SEATS }), true, 'no fog recorded is 0');
  assert.equal(done({ kind: 'compare', what: 'fog', op: '<=', value: 45 }), true);
  assert.equal(done({ kind: 'compare', what: 'fog', op: '>', value: 45 }), false);
});

test('most checks: the whole table, ties count for everyone tied', () => {
  const most = (what) => ({ kind: 'most', what });
  assert.deepEqual(['a', 'b', 'c'].map((uid) => done(most('pounds'), uid)), [true, true, false], 'a and b tie on 30 pounds');
  assert.deepEqual(['a', 'b', 'c'].map((uid) => done(most('influence'), uid)), [true, false, true]);
  assert.deepEqual(['a', 'b', 'c'].map((uid) => done(most('hand'), uid)), [false, true, false]);
});

test('number checks on pounds, influence and hand size with each comparison', () => {
  const check = (what, op, value) => ({ kind: 'compare', what, op, value });
  assert.equal(done(check('pounds', '>=', 40)), false, '30 pounds');
  assert.equal(done(check('pounds', '>=', 40), 'a', { ...END, seats: { ...SEATS, a: { ...SEATS.a, pounds: 40 } } }), true, 'exactly 40');
  assert.equal(done(check('pounds', '>', 30)), false);
  assert.equal(done(check('pounds', '>', 29)), true);
  assert.equal(done(check('influence', '<', 3), 'b'), true);
  assert.equal(done(check('influence', '<', 2), 'b'), false);
  assert.equal(done(check('influence', '<=', 2), 'b'), true);
  assert.equal(done(check('hand', '>=', 6)), true, 'a holds 6');
  assert.equal(done(check('hand', '>=', 9), 'b'), false, 'b holds 9 but counts as the hand limit 7');
  assert.equal(done(check('hand', '>=', 9), 'c'), false);
});

test('more than the player of a role; nobody in that role counts as done', () => {
  const beatR5 = { kind: 'moreThan', what: 'pounds', role: 'r5' };
  assert.equal(done(beatR5, 'b'), true, '30 against 12');
  assert.equal(done(beatR5, 'b', { ...END, seats: { ...SEATS, b: { ...SEATS.b, pounds: 12 } } }), false, 'the same is not more');
  assert.equal(done(beatR5, 'b', { ...END, seats: { ...SEATS, c: { ...SEATS.c, pounds: 31 } } }), false);
  const { c, ...noR5 } = SEATS;
  assert.equal(done(beatR5, 'b', { ...END, seats: noR5 }), true, 'nobody sits r5');
  assert.equal(done({ kind: 'moreThan', what: 'influence', role: 'r1' }, 'b'), false, '2 against 5');
  // 自己就坐那個階層：不跟自己比，沒有別人坐就算達成。
  assert.equal(done(beatR5, 'c'), true, 'c sits r5 alone');
  assert.equal(done({ kind: 'moreThan', what: 'pounds', role: 'r1' }, 'a'), true, 'a sits r1 alone');
});

// ---- 手牌上限（企劃 10/16 定案）：天命判定裡的手牌先套 settings.handLimit（範例資料是 7）再比，不真的棄牌 ----

const holding = (...counts) => ({
  seats: Object.fromEntries(counts.map((handCount, index) => ['abcd'[index], { order: index, role: `r${index + 1}`, handCount }])),
});

// 套上限之前的判定：直接比座位的張數。沒有人超過上限時，結果要跟這個一樣。
function handBefore(check, uid, seats) {
  const count = (seat) => seat?.handCount ?? 0;
  const mine = count(seats[uid]);
  if (check.kind === 'most') return Object.values(seats).every((seat) => count(seat) <= mine);
  if (check.kind === 'moreThan') {
    return Object.entries(seats)
      .filter(([other, seat]) => other !== uid && seat.role === check.role)
      .every(([, seat]) => mine > count(seat));
  }
  return { '>': mine > check.value, '>=': mine >= check.value, '<': mine < check.value, '<=': mine <= check.value }[check.op];
}

test('the most hand counts every hand at the hand limit at most, so everyone at the limit is tied', () => {
  assert.equal(settings.handLimit, 7);
  const most = { kind: 'most', what: 'hand' };
  const results = (state, rules = settings) => ['a', 'b', 'c'].map((uid) => destinyDone(most, uid, state, rules));
  assert.deepEqual(results(holding(10, 8, 6)), [true, true, false], '10 and 8 both count as 7');
  assert.deepEqual(results(holding(6, 10, 7)), [false, true, true], 'exactly at the limit ties with one over it');
  assert.deepEqual(results(holding(6, 5, 3)), [true, false, false], 'nobody over the limit');
  assert.deepEqual(results(holding(10, 8, 6), { ...settings, handLimit: 5 }), [true, true, true], 'a limit of 5: all three count as 5');
});

test('with nobody over the hand limit every hand check gives what it gave before the limit applied', () => {
  const checks = [
    { kind: 'most', what: 'hand' },
    { kind: 'moreThan', what: 'hand', role: 'r3' },
    ...['>', '>=', '<', '<='].flatMap((op) => [0, 3, 6, 7, 8].map((value) => ({ kind: 'compare', what: 'hand', op, value }))),
  ];
  const differ = [];
  for (let a = 0; a <= 7; a += 1) {
    for (let b = 0; b <= 7; b += 1) {
      for (let c = 0; c <= 7; c += 1) {
        const state = holding(a, b, c);
        for (const check of checks) {
          for (const uid of ['a', 'b', 'c']) {
            if (destinyDone(check, uid, state, settings) !== handBefore(check, uid, state.seats)) differ.push(`${JSON.stringify(check)} for ${uid} with ${a}／${b}／${c} cards`);
          }
        }
      }
    }
  }
  assert.deepEqual(differ, []);
});

test('a hand number check counts at most the hand limit: 手牌 >= 8 never holds with a limit of 7', () => {
  const hand = (op, value) => ({ kind: 'compare', what: 'hand', op, value });
  for (const count of [7, 8, 9, 10]) assert.equal(destinyDone(hand('>=', 8), 'a', holding(count), settings), false, `${count} cards`);
  assert.equal(destinyDone(hand('>=', 7), 'a', holding(10), settings), true, '10 cards count as 7');
  assert.equal(destinyDone(hand('>=', 7), 'a', holding(6), settings), false);
  assert.equal(destinyDone(hand('<', 8), 'a', holding(12), settings), true, '12 cards count as 7 for < too');
  assert.equal(destinyDone(hand('>=', 6), 'a', holding(10), { ...settings, handLimit: 5 }), false, 'a limit of 5');
});

test('more hand than the player of a role: both hands count at most the hand limit', () => {
  const beatR5 = { kind: 'moreThan', what: 'hand', role: 'r5' };
  const against = (mine, theirs) => ({ seats: { a: { order: 0, role: 'r4', handCount: mine }, b: { order: 1, role: 'r5', handCount: theirs } } });
  assert.equal(destinyDone(beatR5, 'a', against(9, 8), settings), false, '9 against 8 is 7 against 7: the same is not more');
  assert.equal(destinyDone(beatR5, 'a', against(7, 5), settings), true, '7 against 5');
  assert.equal(destinyDone(beatR5, 'a', against(10, 6), settings), true, '10 against 6 is 7 against 6');
  assert.equal(destinyDone(beatR5, 'a', against(7, 9), settings), false, '7 against 9 is 7 against 7');
});

test('scoring judges the hand checks at the hand limit from the settings, and discards nothing', () => {
  const cards = [
    ['h1', 'r1', { kind: 'compare', what: 'hand', op: '>=', value: 7 }],
    ['h2', 'r4', { kind: 'most', what: 'hand' }],
    ['h3', 'r5', { kind: 'compare', what: 'hand', op: '>=', value: 6 }],
    ['h4', 'r2', { kind: 'moreThan', what: 'hand', role: 'r4' }],
  ].map(([id, role, check]) => ({ id, role, text: `天命 ${id}`, score: { text: `條件 ${id}`, points: 10 }, check }));
  const game = {
    seats: {
      a: { order: 0, role: 'r1', pounds: 0, influence: 0, handCount: 10 },
      b: { order: 1, role: 'r4', pounds: 0, influence: 0, handCount: 8 },
      c: { order: 2, role: 'r5', pounds: 0, influence: 0, handCount: 6 },
      d: { order: 3, role: 'r2', pounds: 0, influence: 0, handCount: 9 },
    },
    destinies: { a: 'h1', b: 'h2', c: 'h3', d: 'h4' },
  };
  const before = structuredClone(game);
  const scored = (rules) => {
    const scores = scoreGame(game, { ...data, destinies: cards, settings: rules });
    return ['a', 'b', 'c', 'd'].map((uid) => [scores[uid].destiny.done, scores[uid].total]);
  };
  // 上限 7：a 10 張算 7（>= 7）；b 8 張與 a、d 都算 7（同數都算最多）；c 6 張（>= 6）；d 9 張對 b 8 張是 7 對 7（一樣多不算）。
  assert.deepEqual(scored(settings), [[true, 10], [true, 10], [true, 10], [false, 0]]);
  // 上限 5：每個人都算 5 張。
  assert.deepEqual(scored({ ...settings, handLimit: 5 }), [[false, 0], [true, 10], [false, 0], [false, 0]]);
  assert.deepEqual(game, before, 'the seats keep their hand counts');
});

test('a destiny with a blank check waits for the host', () => {
  assert.equal(destinyDone(null, 'a', END), null);
  assert.equal(destinyDone(undefined, 'a', END), null);
  assert.throws(() => destinyDone({ kind: 'luck' }, 'a', END), RangeError);
});

// 一場的終局：a 天命 d02（迷霧 < 60）、b 天命 d08（多於 r5）、c 天命 d10（迷霧 >= 60）。
const GAME = {
  round: 5,
  seats: {
    a: { order: 0, role: 'r1', pounds: 24, influence: 8, handCount: 5, sin: 3, aligned: 2 },
    b: { order: 1, role: 'r4', pounds: 25, influence: 2, handCount: 7, aligned: 2 },
    c: { order: 2, role: 'r5', pounds: 9, influence: 0, handCount: 2, sin: 1, aligned: 0 },
  },
  destinies: { a: 'd02', b: 'd08', c: 'd10' },
  fog: 45,
  fogMax: 50,
  bills: { b01: 'failed' },
  log: {
    l1: { round: 1, by: 'c', card: 'a02', level: 1, at: 1 },
    l2: { round: 1, by: 'c', card: 'a02', level: 2, at: 2 },
    l3: { round: 2, by: 'a', card: 'a02', level: 3, at: 3, response: { by: 'b', card: 'a03' }, canceled: true },
    l4: { round: 2, by: 'b', card: 'a01', level: 1, at: 4 },
  },
};

test('scores: destiny, assets rounded down, achievements, sin rounded down, total and rank', () => {
  assert.deepEqual(scoreGame(GAME, data), {
    a: { destiny: { id: 'd02', text: '天命 d02', done: true, points: 10 }, assets: { pounds: 24, influence: 8, points: 6 }, achievements: ['parliament'], sin: 3, sinPenalty: 1, total: 18, rank: 2 },
    b: { destiny: { id: 'd08', text: '天命 d08', done: true, points: 10 }, assets: { pounds: 25, influence: 2, points: 5 }, achievements: ['parliament'], sin: 0, sinPenalty: 0, total: 18, rank: 1 },
    c: { destiny: { id: 'd10', text: '天命 d10', done: false, points: 10 }, assets: { pounds: 9, influence: 0, points: 1 }, achievements: ['gear'], sin: 1, sinPenalty: 0, total: 4, rank: 3 },
  });
  assert.deepEqual(Object.keys(scoreGame(GAME, data)), ['a', 'b', 'c'], 'in seat order');
  assert.deepEqual(endGame(GAME, data, 'sunset'), { round: 5, reason: 'sunset', scores: scoreGame(GAME, data) });
  assert.throws(() => endGame(GAME, data, 'bored'), RangeError);
});

test('assets and sin are rounded down; other rates and achievement points come from the settings', () => {
  const one = (seat, rules = settings) => scoreGame({ seats: { a: { order: 0, role: 'r1', ...seat } }, destinies: {} }, { ...data, settings: rules }).a;
  assert.deepEqual(one({ pounds: 4, influence: 2 }).assets, { pounds: 4, influence: 2, points: 0 });
  assert.deepEqual(one({ pounds: 5, influence: 3 }).assets, { pounds: 5, influence: 3, points: 2 });
  assert.deepEqual(one({ pounds: 29, influence: 11 }).assets, { pounds: 29, influence: 11, points: 8 });
  assert.deepEqual([1, 2, 3, 4, 5].map((sin) => one({ pounds: 0, influence: 0, sin }).sinPenalty), [0, 1, 1, 2, 2]);
  assert.equal(one({ pounds: 0, influence: 0, sin: 3 }).total, -1, 'the total can go below 0');
  const rules = { ...settings, scoreRates: { pounds: 4, influence: 2 }, sinPerPenalty: 3, achievementPoints: 5 };
  const scored = one({ pounds: 9, influence: 5, sin: 6, aligned: 1 }, rules);
  assert.deepEqual([scored.assets.points, scored.sinPenalty, scored.achievements, scored.total], [4, 2, ['parliament'], 4 - 2 + 5]);
  assert.deepEqual(one({ pounds: 3, influence: 1 }).destiny, { id: null, text: null, done: false, points: 0 }, 'no destiny dealt');
});

test('a destiny no longer in the card data scores 0 with a placeholder text, so the end can still be written', () => {
  const scores = scoreGame({ ...GAME, destinies: { ...GAME.destinies, a: 'gone' } }, data);
  assert.deepEqual(scores.a.destiny, { id: 'gone', text: '（卡牌資料裡找不到天命 gone）', done: false, points: 0 });
  assert.equal(scores.a.total, 6 + 3 - 1, 'assets, parliament and sin still count');
  assert.deepEqual(scores.b.destiny.id, 'd08', 'the others are scored as usual');
});

test('parliament goes to everyone with the most aligned votes, and to nobody when the most is 0', () => {
  const seat = (aligned) => ({ order: 0, role: 'r1', pounds: 0, influence: 0, handCount: 0, aligned });
  assert.deepEqual(achievementsOf({ a: seat(2), b: seat(2), c: seat(1) }, {}), { a: ['parliament'], b: ['parliament'], c: [] });
  assert.deepEqual(achievementsOf({ a: seat(0), b: seat(0) }, {}), { a: [], b: [] });
  assert.deepEqual(achievementsOf({ a: { order: 0 }, b: seat(1) }, null), { a: [], b: ['parliament'] }, 'no aligned field is 0');
});

test('the gear master needs a chain of 2 or more; a canceled card does not count; ties all get it', () => {
  const seats = { a: { order: 0 }, b: { order: 1 }, c: { order: 2 } };
  const play = (by, level, canceled = false) => ({ round: 1, by, card: 'x', level, at: 1, ...(canceled ? { canceled: true, response: { by: 'c', card: 'y' } } : {}) });
  assert.deepEqual(achievementsOf(seats, { 1: play('a', 1), 2: play('b', 1) }), { a: [], b: [], c: [] }, 'level 1 is not enough');
  assert.deepEqual(achievementsOf(seats, { 1: play('a', 2), 2: play('b', 1) }), { a: ['gear'], b: [], c: [] });
  assert.deepEqual(achievementsOf(seats, { 1: play('a', 2), 2: play('b', 2) }), { a: ['gear'], b: ['gear'], c: [] }, 'a tie');
  assert.deepEqual(achievementsOf(seats, { 1: play('a', 2), 2: play('b', 4, true) }), { a: ['gear'], b: [], c: [] }, 'the canceled level 4 does not count');
  assert.deepEqual(achievementsOf(seats, { 1: play('a', 3, true), 2: play('b', 1) }), { a: [], b: [], c: [] }, 'only a canceled chain');
  assert.deepEqual(maxChains({ 1: play('a', 2), 2: play('a', 3), 3: play('b', 4, true), 4: null }), { a: 3 });
  const both = achievementsOf({ a: { order: 0, aligned: 3 }, b: { order: 1, aligned: 1 } }, [play('a', 2)]);
  assert.deepEqual(both, { a: ['parliament', 'gear'], b: [] }, 'one player can take both (and the log may come back as an array)');
});

test('ranking: higher total first, then more pounds, then tied places', () => {
  const score = (total, pounds) => ({ total, assets: { pounds, influence: 0, points: 0 } });
  const ranked = rankScores({ a: score(10, 5), b: score(10, 5), c: score(10, 4), d: score(12, 0), e: score(3, 50) });
  assert.deepEqual(Object.fromEntries(Object.entries(ranked).map(([uid, { rank }]) => [uid, rank])), { a: 2, b: 2, c: 4, d: 1, e: 5 });
  assert.deepEqual(rankScores({ a: score(1, 1) }).a.rank, 1);
  assert.deepEqual(rankScores({}), {});
});

test('the host judges a destiny with a blank check: the total and every rank follow, and it can be taken back', () => {
  const blank = { id: 'd13', role: 'r6', text: '天命 d13', score: { text: '主持人判定', points: 10 }, check: null };
  const game = { ...GAME, destinies: { ...GAME.destinies, c: 'd13' } };
  const scores = scoreGame(game, { ...data, destinies: [...DESTINIES, blank] });
  assert.deepEqual([scores.c.destiny, scores.c.total, scores.c.rank], [{ id: 'd13', text: '天命 d13', done: null, points: 10 }, 4, 3], 'waiting: 0 points');
  const yes = judgeScores(scores, 'c', true);
  assert.deepEqual([yes.c.destiny.done, yes.c.total], [true, 14]);
  assert.deepEqual([yes.a.rank, yes.b.rank, yes.c.rank], [2, 1, 3]);
  const more = judgeScores({ ...yes, c: { ...yes.c, assets: { ...yes.c.assets, pounds: 99 }, total: 18 } }, 'c', true);
  assert.deepEqual([more.a.rank, more.b.rank, more.c.rank], [3, 2, 1], 'a tie on 18 broken by pounds');
  const no = judgeScores(yes, 'c', false);
  assert.deepEqual([no.c.destiny.done, no.c.total, no.c.rank], [false, 4, 3]);
  const back = judgeScores(no, 'c', null);
  assert.deepEqual(back, scores, 'back to waiting');
  assert.deepEqual(judgeScores(scores, 'a', false).a.total, 8, 'the host can also overrule a checked one');
  assert.throws(() => judgeScores(scores, 'zz', true), RangeError);
  assert.equal(scores.c.total, 4, 'the input is not changed');
});

test('a game state and a final saved to the database and read back (nulls dropped) give the same results', () => {
  const blank = { id: 'd13', role: 'r6', text: '天命 d13', score: { text: '主持人判定', points: 10 }, check: null };
  const withBlank = { ...data, destinies: [...DESTINIES, blank] };
  const game = { ...GAME, destinies: { a: 'd02', b: null, c: 'd13' }, seats: { ...GAME.seats, b: { ...GAME.seats.b, aligned: 0 } }, bills: {} };
  const fresh = endGame(game, withBlank, 'host');
  assert.deepEqual(endGame(stored(game), withBlank, 'host'), fresh);
  // final 存進資料庫：沒有天命的人 id、text 不見，待判定的 done 不見，沒有成就的 achievements 不見。
  const saved = stored(fresh);
  assert.deepEqual(saved.scores.b.destiny, { done: false, points: 0 });
  assert.deepEqual(saved.scores.c.destiny, { id: 'd13', text: '天命 d13', points: 10 });
  assert.equal(saved.scores.b.achievements, undefined);
  for (const done of [true, false, null]) {
    assert.deepEqual(stored(judgeScores(saved.scores, 'c', done)), stored(judgeScores(fresh.scores, 'c', done)), `judged ${done}`);
  }
  assert.deepEqual(stored(judgeScores(stored(judgeScores(saved.scores, 'c', true)), 'c', null)), stored(fresh.scores), 'judged, saved, taken back');
});

// ---- 發天命避開這一桌沒人坐的階層 ----

// 改之前（M8）的開局：同樣的座位、牌庫、手牌，天命不看這一桌坐了哪些階層。用來比對沒有判定的資料結果與亂數用量都沒變。
function legacyStartGame(cards, uids, random) {
  const legacyPick = (destinies, role, used) => {
    const free = destinies.filter((destiny) => !used.has(destiny.id));
    const own = free.filter((destiny) => destiny.role === role);
    const pool = own.length ? own : free.filter((destiny) => destiny.role === null);
    return pool.length ? pool[randomBelow(pool.length, random)].id : null;
  };
  let deck = shuffle(buildDeck(cards.actions), random);
  let discard = [];
  const used = new Set();
  const state = { seats: {}, hands: {}, destinies: {}, deck, discard };
  for (const { uid, order, role } of assignSeats(uids, cards.roles, random)) {
    const destiny = legacyPick(cards.destinies, role, used);
    if (destiny) used.add(destiny);
    const result = draw({ deck, discard }, cards.settings.startingHand, random);
    ({ deck, discard } = result);
    state.destinies[uid] = destiny;
    state.hands[uid] = result.drawn;
    state.seats[uid] = { order, role, pounds: cards.settings.startingPounds, influence: cards.settings.startingInfluence, handCount: result.drawn.length };
  }
  Object.assign(state, { deck, discard });
  return sunrise(state, cards, random);
}

function counted(seed) {
  const random = seededRandom(seed);
  const counter = { calls: 0 };
  counter.random = () => {
    counter.calls += 1;
    return random();
  };
  return counter;
}

const UIDS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];

test('when nobody sits r5, r4 always gets d07; with r5 seated it can get either', () => {
  let withoutR5 = 0;
  const withR5 = new Set();
  for (let seed = 1; seed <= 300; seed += 1) {
    const state = startGame(data, UIDS.slice(0, 3), { random: seededRandom(seed) });
    const byRole = new Map(Object.entries(state.seats).map(([uid, seat]) => [seat.role, uid]));
    if (!byRole.has('r4')) continue;
    const dealt = state.destinies[byRole.get('r4')];
    if (byRole.has('r5')) {
      withR5.add(dealt);
    } else {
      withoutR5 += 1;
      assert.equal(dealt, 'd07', `seed ${seed}`);
    }
  }
  assert.ok(withoutR5 >= 30, `enough tables without r5 (${withoutR5})`);
  assert.deepEqual([...withR5].sort(), ['d07', 'd08']);
  const sixes = new Set();
  for (let seed = 1; seed <= 40; seed += 1) {
    const state = startGame(data, UIDS, { random: seededRandom(seed) });
    sixes.add(state.destinies[Object.keys(state.seats).find((uid) => state.seats[uid].role === 'r4')]);
  }
  assert.deepEqual([...sixes].sort(), ['d07', 'd08'], 'a full table keeps both');
});

test('picking a destiny: skip one that names a missing role, fall back to the usual pick when nothing else is left', () => {
  const seated = new Set(['r1', 'r4']);
  for (let seed = 1; seed <= 30; seed += 1) {
    assert.equal(pickDestiny(DESTINIES, 'r4', new Set(), seededRandom(seed), seated), 'd07');
  }
  assert.equal(pickDestiny(DESTINIES, 'r4', new Set(['d07']), seededRandom(1), seated), 'd08', 'd07 already dealt: the usual pick');
  const onlyD08 = DESTINIES.filter((destiny) => destiny.id !== 'd07');
  for (let seed = 1; seed <= 30; seed += 1) {
    const state = startGame({ ...data, destinies: onlyD08 }, UIDS.slice(0, 2), { random: seededRandom(seed) });
    for (const [uid, seat] of Object.entries(state.seats)) {
      if (seat.role === 'r4') assert.equal(state.destinies[uid], 'd08', `seed ${seed}: nothing else for r4`);
    }
  }
  // 沒有自己階層的天命時，從不屬於任何階層的挑，一樣先避開。
  const roleless = [
    { id: 'x1', role: null, text: 't', score: { text: 's', points: 1 }, check: { kind: 'moreThan', what: 'pounds', role: 'r5' } },
    { id: 'x2', role: null, text: 't', score: { text: 's', points: 1 }, check: null },
  ];
  for (let seed = 1; seed <= 20; seed += 1) assert.equal(pickDestiny(roleless, 'r2', new Set(), seededRandom(seed), seated), 'x2');
});

test('without checks the same seed deals exactly what it dealt before, with the same number of random calls', () => {
  const plain = { ...data, destinies: DESTINIES.map(({ check, ...destiny }) => destiny) };
  const nulls = { ...data, destinies: DESTINIES.map((destiny) => ({ ...destiny, check: null })) };
  for (let seed = 1; seed <= 60; seed += 1) {
    for (const count of [1, 3, 5, 6]) {
      const uids = UIDS.slice(0, count);
      const before = counted(seed);
      const expected = legacyStartGame(plain, uids, before.random);
      for (const cards of [plain, nulls]) {
        const now = counted(seed);
        assert.deepEqual(startGame(cards, uids, { random: now.random }), expected, `seed ${seed}, ${count} players`);
        assert.equal(now.calls, before.calls, `seed ${seed}, ${count} players: random calls`);
      }
    }
  }
  // 有判定、但這一桌六個階層都有人坐（沒有要避開的）時也一樣。
  for (let seed = 1; seed <= 30; seed += 1) {
    const before = counted(seed);
    const expected = legacyStartGame(data, UIDS, before.random);
    const now = counted(seed);
    assert.deepEqual(startGame(data, UIDS, { random: now.random }), expected);
    assert.equal(now.calls, before.calls);
  }
});
