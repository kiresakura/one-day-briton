// 兩場制的純函式（M9）：局號（matchKey、parseKey、activeKey、matchOf）、第 2 場的座位與階層（rotateSeats）、照給的座位開局
// （startGame 的 seating）、兩場合計（combineScores）、待判定的天命、日落鐘各算各的、教學提示只在第 1 場第 1 回合，
// 以及第 1 場留下的票、黑夜選擇、挑的棄牌不算進第 2 場。卡牌資料用 play/data（牌庫夠發），天命換成測試裡寫的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  applyHandLimits,
  combineScores,
  discardProblem,
  judgeScores,
  pendingDestinies,
  rotateSeats,
  seededRandom,
  shouldEnd,
  showsTutorial,
  startGame,
  submittedChoices,
  submittedCount,
  sunsetClock,
} from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';
import { MATCH_COUNT, activeKey, matchKey, matchOf, parseKey } from '../../play/js/rules.js';

const cardDir = new URL('../../play/data/', import.meta.url);
const { data: cards, errors } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
assert.deepEqual(errors, []);
const { settings } = cards;
const MINUTE = 60_000;

// 每個階層兩張天命；d08 的判定提到 r5（「多於 r5」），r5 沒人坐時 r4 只會拿到 d07（同開局的規則）。
const DESTINIES = [
  ['d01', 'r1', { kind: 'compare', what: 'pounds', op: '>=', value: 0 }],
  ['d02', 'r1', { kind: 'compare', what: 'fog', op: '<', value: 60 }],
  ['d03', 'r2', { kind: 'most', what: 'pounds' }],
  ['d04', 'r2', { kind: 'compare', what: 'pounds', op: '>=', value: 0 }],
  ['d05', 'r3', { kind: 'compare', what: 'pounds', op: '>=', value: 0 }],
  ['d06', 'r3', { kind: 'most', what: 'influence' }],
  ['d07', 'r4', { kind: 'most', what: 'influence' }],
  ['d08', 'r4', { kind: 'moreThan', what: 'pounds', role: 'r5' }],
  ['d09', 'r5', { kind: 'compare', what: 'pounds', op: '>=', value: 40 }],
  ['d10', 'r5', { kind: 'compare', what: 'fog', op: '>=', value: 60 }],
  ['d11', 'r6', { kind: 'compare', what: 'fogMax', op: '>', value: 90 }],
  ['d12', 'r6', { kind: 'most', what: 'hand' }],
].map(([id, role, check]) => ({ id, role, text: `天命 ${id}`, score: { text: `條件 ${id}`, points: 10 }, check }));
const data = { ...cards, destinies: DESTINIES };
const ROLES = data.roles.map((role) => role.id);

// 第 1 場的座位：uid → { order, role }（其他欄位照開局的樣子）。
const seat = (order, role) => ({ order, role, pounds: 9, influence: 2, handCount: 4, sin: 1, aligned: 1 });
const seatsOf = (list) => Object.fromEntries(list.map(([uid, order, role]) => [uid, seat(order, role)]));
const SIX = seatsOf([
  ['a', 0, 'r1'],
  ['b', 1, 'r2'],
  ['c', 2, 'r3'],
  ['d', 3, 'r4'],
  ['e', 4, 'r5'],
  ['f', 5, 'r6'],
]);

test('match keys: 1 is "1", table 1 match 2 is "1-2", and back; anything else is not a key', () => {
  assert.equal(MATCH_COUNT, 2);
  assert.equal(matchKey(1), '1');
  assert.equal(matchKey(1, 1), '1');
  assert.equal(matchKey(1, 2), '1-2');
  assert.equal(matchKey('6', 2), '6-2');
  for (const [table, match] of [[0, 1], [7, 1], [1.5, 1], ['1-2', 1], [1, 3], [1, 0], [null, 1]]) {
    assert.throws(() => matchKey(table, match), RangeError, `${table} ${match}`);
  }
  assert.deepEqual(parseKey(1), { table: 1, match: 1 });
  assert.deepEqual(parseKey('1'), { table: 1, match: 1 });
  assert.deepEqual(parseKey('1-2'), { table: 1, match: 2 });
  assert.deepEqual(parseKey('6-2'), { table: 6, match: 2 });
  for (const key of ['7', '7-2', '0', '1-3', '1-2-2', '01', '1-', '-2', ' 1', '1.0', '', 0, 7, 1.5, null, undefined, {}, ['1']]) {
    assert.equal(parseKey(key), null, JSON.stringify(key));
  }
  for (let table = 1; table <= 6; table += 1) {
    for (const match of [1, 2]) assert.deepEqual(parseKey(matchKey(table, match)), { table, match });
  }
});

test('the active key is the second match once tables/{n}-2 exists; tables may come back as an array or an object', () => {
  const asArray = { tables: [null, { round: 2, phase: 'end' }, { round: 1, phase: 'day' }] };
  assert.equal(activeKey(asArray, 1), '1');
  assert.equal(activeKey(asArray, '2'), '2');
  assert.equal(matchOf(asArray, 1), 1);
  const asObject = { tables: { 1: { round: 2, phase: 'end' }, '1-2': { round: 1, phase: 'sunrise' }, 2: { round: 1, phase: 'day' } } };
  assert.equal(activeKey(asObject, 1), '1-2');
  assert.equal(activeKey(asObject, '1'), '1-2');
  assert.equal(matchOf(asObject, 1), 2);
  assert.equal(activeKey(asObject, 2), '2', 'each table on its own');
  assert.equal(matchOf(asObject, 2), 1);
  assert.equal(activeKey(null, 3), '3', 'no room data yet');
  for (const table of [0, 7, '1-2', 1.5, null, undefined]) {
    assert.equal(activeKey(asObject, table), null, String(table));
    assert.equal(matchOf(asObject, table), null, String(table));
  }
});

const rolesBy = (seating) => Object.fromEntries(seating.map(({ uid, role }) => [uid, role]));

test('six seats: each role passes to the next seat, the last one to the first, and the seat numbers stay', () => {
  const seating = rotateSeats(SIX, Object.keys(SIX));
  assert.deepEqual(seating, [
    { uid: 'a', order: 0, role: 'r6', from: 'f' },
    { uid: 'b', order: 1, role: 'r1', from: 'a' },
    { uid: 'c', order: 2, role: 'r2', from: 'b' },
    { uid: 'd', order: 3, role: 'r3', from: 'c' },
    { uid: 'e', order: 4, role: 'r4', from: 'd' },
    { uid: 'f', order: 5, role: 'r5', from: 'e' },
  ]);
  for (const { uid, role, order } of seating) {
    assert.notEqual(role, SIX[uid].role, `${uid} got a new role`);
    assert.equal(order, SIX[uid].order);
  }
  assert.deepEqual(new Set(seating.map(({ role }) => role)), new Set(ROLES), 'every role once');
  assert.deepEqual(rotateSeats(SIX, new Set(['f', 'a', 'b', 'c', 'd', 'e'])), seating, 'a Set works, and the order of include does not matter');
});

test('seat numbers with gaps (0, 1, 3, 4) still pass round the ring in order', () => {
  const seats = seatsOf([
    ['p', 3, 'r4'],
    ['q', 0, 'r1'],
    ['r', 4, 'r6'],
    ['s', 1, 'r2'],
  ]);
  assert.deepEqual(rotateSeats(seats, Object.keys(seats)), [
    { uid: 'q', order: 0, role: 'r6', from: 'r' },
    { uid: 's', order: 1, role: 'r1', from: 'q' },
    { uid: 'p', order: 3, role: 'r2', from: 's' },
    { uid: 'r', order: 4, role: 'r4', from: 'p' },
  ]);
});

test('someone who left still passes their role on; the role meant for them has nobody in match 2', () => {
  const seating = rotateSeats(SIX, ['a', 'b', 'd', 'e', 'f']); // c 離開了
  assert.deepEqual(rolesBy(seating), { a: 'r6', b: 'r1', d: 'r3', e: 'r4', f: 'r5' });
  assert.equal(seating.find(({ uid }) => uid === 'd').from, 'c', "c's role r3 still goes to the next seat");
  assert.ok(!seating.some(({ uid }) => uid === 'c'), 'c is not seated');
  assert.ok(!seating.some(({ role }) => role === 'r2'), 'r2 (meant for c) has nobody');
  assert.deepEqual(rotateSeats(SIX, []), [], 'nobody chosen');
});

test('someone who joined after match 1 is not seated; a table of one keeps the same role', () => {
  assert.deepEqual(rolesBy(rotateSeats(SIX, ['a', 'b', 'late'])), { a: 'r6', b: 'r1' });
  const lone = seatsOf([['solo', 2, 'r3']]);
  assert.deepEqual(rotateSeats(lone, ['solo']), [{ uid: 'solo', order: 2, role: 'r3', from: 'solo' }]);
  assert.deepEqual(rotateSeats({}, ['a']), [], 'no seats in match 1');
});

test('startGame with a seating keeps the given seats and roles, deals destinies for the new roles, and redeals everything', () => {
  // 第 1 場 5 人，座位 4 的 u5 離開：r4 從座位 4 傳給座位 0 的 u1；本來要傳給 u5 的 r5（座位 3 的 u4 交出的）第 2 場沒有人坐。
  const first = seatsOf([
    ['u1', 0, 'r1'],
    ['u2', 1, 'r2'],
    ['u3', 2, 'r3'],
    ['u4', 3, 'r5'],
    ['u5', 4, 'r4'],
  ]);
  const seating = rotateSeats(first, ['u1', 'u2', 'u3', 'u4']);
  assert.deepEqual(rolesBy(seating), { u1: 'r4', u2: 'r1', u3: 'r2', u4: 'r3' });
  for (let seed = 1; seed <= 40; seed += 1) {
    const state = startGame(data, ['u4', 'u3', 'u2', 'u1'], { random: seededRandom(seed), seating });
    for (const { uid, order, role } of seating) {
      assert.deepEqual([state.seats[uid].order, state.seats[uid].role], [order, role], `seed ${seed} ${uid}`);
    }
    assert.equal(state.destinies.u1, 'd07', `seed ${seed}: r4 never gets d08 while nobody sits r5`);
    for (const uid of ['u2', 'u3', 'u4']) assert.equal(DESTINIES.find((card) => card.id === state.destinies[uid]).role, state.seats[uid].role);
    const salary = new Map(data.roles.map((role) => [role.id, role.salary]));
    for (const { uid, role } of seating) {
      assert.equal(state.seats[uid].pounds, settings.startingPounds + salary.get(role), 'starting pounds plus the first sunrise');
      assert.equal(state.seats[uid].influence, settings.startingInfluence);
      assert.equal(state.hands[uid].length, settings.startingHand + settings.drawPerSunrise);
      assert.equal(state.seats[uid].handCount, state.hands[uid].length);
      assert.equal(state.seats[uid].sin, undefined, 'match 1 sins stay in match 1');
    }
  }
  const once = startGame(data, ['u1', 'u2', 'u3', 'u4'], { random: seededRandom(7), seating });
  assert.deepEqual(startGame(data, ['u1', 'u2', 'u3', 'u4'], { random: seededRandom(7), seating }), once, 'same seed, same deal');
  // 沒給 seating（或給 null）：跟沒有這個選項時同一條路（與 962753e 的逐一對照在交付紀錄裡另做）。
  const plain = startGame(data, ['u1', 'u2', 'u3'], { random: seededRandom(3) });
  assert.deepEqual(startGame(data, ['u1', 'u2', 'u3'], { random: seededRandom(3), seating: null }), plain);
});

test('startGame rejects a seating that does not match the players or repeats a seat, a role or a person', () => {
  const seating = [
    { uid: 'u1', order: 0, role: 'r1' },
    { uid: 'u2', order: 1, role: 'r2' },
  ];
  const deal = (uids, given) => () => startGame(data, uids, { random: seededRandom(1), seating: given });
  assert.throws(deal(['u1', 'u3'], seating), RangeError, 'another person');
  assert.throws(deal(['u1'], seating), RangeError, 'one too many seats');
  assert.throws(deal(['u1', 'u2'], [seating[0], { ...seating[1], order: 0 }]), RangeError, 'same seat');
  assert.throws(deal(['u1', 'u2'], [seating[0], { ...seating[1], role: 'r1' }]), RangeError, 'same role');
  assert.throws(deal([], []), RangeError, 'nobody');
  assert.doesNotThrow(deal(['u2', 'u1', 'u1'], seating), 'duplicate uids in the list are the same person');
});

// 一場的分數（照 final.scores 讀回來的樣子）：total、rank、英鎊；pending 的天命沒有 done。
const score = (total, rank, pounds, done = true) => {
  const destiny = done === null ? { id: 'd01', text: '天命 d01', points: 10 } : { id: 'd01', text: '天命 d01', done, points: 10 };
  return { destiny, assets: { pounds, influence: 0, points: 0 }, sin: 0, sinPenalty: 0, total, rank };
};

test('two matches add up; a tie shares the rank (1, 1, 3) with no pounds tiebreak; the keys come in display order', () => {
  const final1 = { scores: { a: score(20, 1, 30), b: score(15, 2, 10), c: score(10, 3, 5), d: score(8, 4, 1) } };
  const final2 = { scores: { a: score(5, 3, 0), b: score(10, 1, 50), c: score(10, 1, 0), d: score(7, 4, 3) } };
  const combined = combineScores(final1, final2, SIX);
  assert.deepEqual(combined.a, { first: 20, second: 5, total: 25, rank: 1, absent: false, missingFirst: false, pending: false });
  assert.deepEqual(combined.b, { first: 15, second: 10, total: 25, rank: 1, absent: false, missingFirst: false, pending: false });
  assert.deepEqual(combined.c, { first: 10, second: 10, total: 20, rank: 3, absent: false, missingFirst: false, pending: false });
  assert.deepEqual([combined.d.total, combined.d.rank], [15, 4]);
  assert.deepEqual(Object.keys(combined), ['a', 'b', 'c', 'd', 'e', 'f'], 'by rank, then the match 1 seat number');
  assert.deepEqual([combined.e.rank, combined.e.absent, combined.e.missingFirst], [5, true, true], 'seated in match 1 without any score');
  // 同名次照第 1 場的座位號排：b 在座位 1、a 在座位 0。
  const swapped = combineScores(final1, final2, { ...SIX, a: seat(4, 'r1'), e: seat(0, 'r5') });
  assert.deepEqual(Object.keys(swapped).slice(0, 2), ['b', 'a']);
});

test('someone who sat out match 2 is listed with 0 and absent; a missing match 1 score counts 0', () => {
  const final1 = { scores: { a: score(20, 1, 30), b: score(15, 2, 10), c: score(12, 3, 5) } };
  const final2 = { scores: { a: score(1, 2, 0), b: score(9, 1, 0) } };
  const seats1 = seatsOf([
    ['a', 0, 'r1'],
    ['b', 1, 'r2'],
    ['c', 2, 'r3'],
  ]);
  const combined = combineScores(final1, final2, seats1);
  assert.deepEqual(combined.c, { first: 12, second: 0, total: 12, rank: 3, absent: true, missingFirst: false, pending: false });
  assert.deepEqual([combined.a.total, combined.a.rank, combined.b.total, combined.b.rank], [21, 2, 24, 1]);
  const lost = combineScores({ scores: { a: final1.scores.a, c: final1.scores.c } }, final2, seats1);
  assert.deepEqual(lost.b, { first: 0, second: 9, total: 9, rank: 3, absent: false, missingFirst: true, pending: false });
  const noSecond = combineScores(final1, null, seats1);
  assert.deepEqual(Object.values(noSecond).map((row) => [row.second, row.absent]), [[0, true], [0, true], [0, true]], 'no final for match 2 yet');
  assert.deepEqual(combineScores(null, null, {}), {});
});

test('a match 2 destiny waiting for the host counts 0 and is marked; judging it moves the total and the ranks', () => {
  const final1 = { scores: { a: score(10, 1, 0), b: score(10, 1, 0) } };
  const second = { a: score(5, 2, 0, null), b: score(8, 1, 0) };
  const seats1 = seatsOf([
    ['a', 0, 'r1'],
    ['b', 1, 'r2'],
  ]);
  const before = combineScores(final1, { scores: second }, seats1);
  assert.deepEqual([before.a.pending, before.a.total, before.a.rank, before.b.rank], [true, 15, 2, 1]);
  const judged = combineScores(final1, { scores: judgeScores(second, 'a', true) }, seats1);
  assert.deepEqual([judged.a.pending, judged.a.second, judged.a.total, judged.a.rank, judged.b.rank], [false, 15, 25, 1, 2]);
  assert.deepEqual(Object.keys(judged), ['a', 'b']);
});

test('pending destinies are the ones whose done is neither true nor false', () => {
  assert.deepEqual(pendingDestinies({ a: score(1, 1, 0, null), b: score(1, 1, 0, false), c: score(1, 1, 0, true), d: { ...score(1, 1, 0), destiny: { done: false, points: 0 } } }), ['a']);
  assert.deepEqual(pendingDestinies({ a: score(1, 1, 0, null), b: score(1, 1, 0, null) }), ['a', 'b']);
  assert.deepEqual(pendingDestinies(undefined), []);
});

test('the sunset clock of match 2 runs from its own start: exactly 75 minutes after it counts', () => {
  const start1 = 1_000_000;
  const start2 = start1 + 80 * MINUTE; // 第 2 場晚 80 分鐘才開
  assert.equal(settings.sunsetMinutes, 75);
  const now = start2 + 30 * MINUTE;
  assert.equal(shouldEnd({ round: 2, startedAt: start1 }, settings, now), 'sunset', 'match 1 has long run out');
  assert.equal(shouldEnd({ round: 2, startedAt: start2 }, settings, now), null, 'match 2 has 45 minutes left');
  assert.deepEqual(sunsetClock(start2, settings, now), { elapsed: 30 * MINUTE, remaining: 45 * MINUTE, passed: false });
  assert.equal(shouldEnd({ round: 2, startedAt: start2 }, settings, start2 + 75 * MINUTE - 1), null);
  assert.equal(shouldEnd({ round: 2, startedAt: start2 }, settings, start2 + 75 * MINUTE), 'sunset', 'exactly 75 minutes');
});

test('the tutorial tips show only in round 1 of match 1', () => {
  assert.equal(showsTutorial(1, 1), true);
  assert.equal(showsTutorial(2, 1), false);
  assert.equal(showsTutorial(1, 2), false);
  assert.equal(showsTutorial(2, 2), false);
  assert.equal(showsTutorial(matchOf({ tables: { 1: {}, '1-2': {} } }, 1), 1), false);
  assert.equal(showsTutorial(matchOf({ tables: [null, {}] }, 1), 1), true);
});

test('votes, night choices and picked discards left from match 1 ("1") do not count in match 2 ("1-2")', () => {
  const seats = seatsOf([
    ['a', 0, 'r1'],
    ['b', 1, 'r2'],
  ]);
  const at = 5_000;
  const dusk = { round: 1, bill: 'b01', openedAt: 1_000, submitted: 0 };
  const duskView = (table) => ({ table, round: 1, phase: 'dusk', seats, dusk });
  const votes = { a: { table: '1', round: 1, side: 'yes', bid: 1, seq: 4, at }, b: { table: '1-2', round: 1, side: 'no', bid: 0, seq: 1, at } };
  assert.equal(submittedCount(duskView('1-2'), votes), 1, 'only the vote for 1-2');
  assert.equal(submittedCount(duskView('1'), votes), 1, 'and only the vote for 1 in match 1');
  const night = { round: 1, openedAt: 1_000, submitted: 0 };
  const nightView = (table) => ({ table, round: 1, phase: 'night', seats, night });
  const picks = { a: { table: '1', round: 1, choice: 'sleep', seq: 3, at }, b: { table: '1', round: 1, choice: 'gamble', tiers: 2, seq: 2, at } };
  assert.equal(submittedChoices(nightView('1-2'), picks), 0);
  assert.equal(submittedChoices(nightView('1'), picks), 2);
  // 手牌上限：挑的棄牌是第 1 場第 1 回合的，第 2 場第 1 回合黑夜後的日出不照用（亂數棄）。
  const hand = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8'];
  const pick = { table: '1', round: 1, cards: ['x1'], seq: 1, at };
  assert.equal(discardProblem(hand, pick, { table: '1-2', round: 1 }, settings), 'wrong-table');
  assert.equal(discardProblem(hand, pick, { table: '1', round: 1 }, settings), null);
  const state = { table: '1-2', seats, hands: { a: hand, b: [] }, deck: [], discard: [] };
  const { discards } = applyHandLimits(state, { a: pick }, data, { round: 1, random: seededRandom(2) });
  assert.equal(discards.a.picked, false, 'match 1 pick not used');
  assert.equal(discards.a.cards.length, 1);
});
