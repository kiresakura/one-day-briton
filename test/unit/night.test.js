// 黑夜的純函式：豪賭（骰子、爆、收手、秘寶、醫藥費）、分贓、睡覺、選擇的檢查與計算、主持端每一步要做什麼，以及日出前的手牌上限（M8）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DISCARD_REASONS,
  NIGHT_GRACE_MS,
  NIGHT_MAX_REVEAL_SECONDS,
  NIGHT_REASONS,
  applyHandLimits,
  choiceProblem,
  countChoices,
  discardProblem,
  gamble,
  nightSettings,
  nightSettleAt,
  nightStage,
  nightStep,
  openNight,
  overLimit,
  resolveNight,
  seededRandom,
  settleSunrise,
  submittedChoices,
} from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';

const cardDir = new URL('../../play/data/', import.meta.url);
const { data } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
const { settings } = data;
const OPENED_AT = 100_000; // 黑夜開始的伺服器時間（毫秒）

// 資料檔沒有黑夜的設定，遊戲讀到的是預設值。
assert.deepEqual(nightSettings(settings), { revealSeconds: 3, bust: [1, 2, 3], pounds: [5, 20, 30], influence: [0, 1, 1], medicalFee: 2, splitPounds: 6, splitSin: 1 });
assert.equal(settings.handLimit, 7);

// 照順序擲出指定點數的骰子；多擲一次就報錯（證明爆了之後不再擲）。
function dice(...rolls) {
  const queue = [...rolls];
  return () => {
    if (queue.length === 0) throw new Error('rolled more dice than expected');
    return queue.shift() - 1; // randomBelow(6) 取餘數，0–5 對到 1–6 點
  };
}

// 第 1 桌第 1 回合黑夜，已開始、選擇中。uids 照座位排（預設 a、b、c），英鎊 10、影響力 3。
function nightState({ seats = {}, night = {}, uids = ['a', 'b', 'c'], ...rest } = {}) {
  const allSeats = {};
  uids.forEach((uid, order) => {
    allSeats[uid] = { order, role: `r${order + 1}`, pounds: 10, influence: 3, handCount: 2, ...seats[uid] };
  });
  return {
    table: 1,
    round: 1,
    phase: 'night',
    fog: 0,
    hands: Object.fromEntries(uids.map((uid) => [uid, [`${uid}1`, `${uid}2`]])),
    deck: ['d1', 'd2'],
    discard: [],
    ...rest,
    seats: allSeats,
    night: { round: 1, openedAt: OPENED_AT, submitted: 0, ...night },
  };
}

// 一個選擇：預設是第 1 桌第 1 回合、伺服器在黑夜開始 1 秒後收到。
const pick = (choice, tiers = null, extra = {}) => ({ table: '1', round: 1, choice, ...(tiers === null ? {} : { tiers }), seq: 1, at: OPENED_AT + 1000, ...extra });
const reveal = (state, picks, random = seededRandom(1)) => resolveNight(state, picks, data, random);
const field = (state, key) => Object.fromEntries(Object.entries(state.seats).map(([uid, seat]) => [uid, seat[key]]));

test('gamble: each tier busts on its bust point or below (1, 2, 3), cashes out at the chosen tier, and the treasure keeps the +1 influence', () => {
  assert.deepEqual(gamble(1, settings, dice(1)), { rolls: [1], bust: true, pounds: 0, influence: 0 }, 'tier 1 busts on 1');
  assert.deepEqual(gamble(1, settings, dice(2)), { rolls: [2], bust: false, pounds: 5, influence: 0 }, 'tier 1 passes on 2 and cashes out');
  assert.deepEqual(gamble(2, settings, dice(6, 2)), { rolls: [6, 2], bust: true, pounds: 0, influence: 0 }, 'tier 2 busts on 2, the 5 is lost');
  assert.deepEqual(gamble(2, settings, dice(2, 3)), { rolls: [2, 3], bust: false, pounds: 20, influence: 1 }, 'tier 2 passes on 3 and cashes out');
  assert.deepEqual(gamble(3, settings, dice(4, 5, 3)), { rolls: [4, 5, 3], bust: true, pounds: 0, influence: 0 }, 'tier 3 busts on 3');
  assert.deepEqual(gamble(3, settings, dice(2, 3, 4)), { rolls: [2, 3, 4], bust: false, pounds: 30, influence: 1 }, 'the treasure: 30 pounds, the +1 influence kept');
  assert.deepEqual(gamble(3, settings, dice(1)), { rolls: [1], bust: true, pounds: 0, influence: 0 }, 'no more dice after a bust');
  // 數值照設定：0＝那一層不會爆、6＝一定爆。
  const custom = { ...settings, gambleBust: [0, 6, 3], gamblePounds: [1, 2, 3], gambleInfluence: [4, 5, 6] };
  assert.deepEqual(gamble(1, custom, dice(1)), { rolls: [1], bust: false, pounds: 1, influence: 4 });
  assert.deepEqual(gamble(2, custom, dice(1, 6)), { rolls: [1, 6], bust: true, pounds: 0, influence: 0 });
});

test('the reveal adds the winnings to the seats; a bust pays the medical fee, never below 0', () => {
  const state = nightState({ seats: { b: { pounds: 1 }, c: { pounds: 0, influence: 0 } } });
  const { state: after, result, log } = reveal(state, { a: pick('gamble', 2), b: pick('gamble', 1), c: pick('gamble', 3) }, dice(6, 6, 1, 1));
  assert.deepEqual(result.players, {
    a: { choice: 'gamble', tiers: 2, rolls: [6, 6], bust: false, pounds: 20, influence: 1, sin: 0 },
    b: { choice: 'gamble', tiers: 1, rolls: [1], bust: true, pounds: -1, influence: 0, sin: 0 },
    c: { choice: 'gamble', tiers: 3, rolls: [1], bust: true, pounds: 0, influence: 0, sin: 0 },
  });
  assert.ok(Object.is(result.players.c.pounds, 0), 'a fee of nothing is 0, not -0');
  assert.deepEqual(field(after, 'pounds'), { a: 30, b: 0, c: 0 });
  assert.deepEqual(field(after, 'influence'), { a: 4, b: 3, c: 0 });
  assert.deepEqual(field(after, 'sin'), { a: undefined, b: undefined, c: undefined });
  assert.deepEqual(log, result, 'the public log is the result');
  assert.deepEqual(after.night, { ...state.night, result });
  assert.deepEqual([after.fog, after.fogPending, after.hands, after.deck], [state.fog, state.fogPending, state.hands, state.deck], 'the night leaves the fog and the cards alone');
});

test('split: 1, 2, 4 and 7 people share 6 pounds rounded down, and everyone who splits takes 1 sin, even for a share of 0', () => {
  const uids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const splitBy = (count) => {
    const state = nightState({ uids, seats: { a: { sin: 2 } } });
    const picks = Object.fromEntries(uids.slice(0, count).map((uid) => [uid, pick('split')]));
    return reveal(state, picks);
  };
  for (const [count, share] of [
    [1, 6],
    [2, 3],
    [4, 1],
    [7, 0],
  ]) {
    const { state, result } = splitBy(count);
    for (const uid of uids.slice(0, count)) {
      assert.deepEqual(result.players[uid], { choice: 'split', pounds: share, influence: 0, sin: 1 }, `${count} people: ${uid}`);
      assert.equal(state.seats[uid].pounds, 10 + share);
      assert.equal(state.seats[uid].sin, uid === 'a' ? 3 : 1, 'sin adds to the sin from the day');
    }
    for (const uid of uids.slice(count)) assert.deepEqual(result.players[uid], { choice: 'sleep', pounds: 0, influence: 0, sin: 0 });
  }
  const zeroSin = reveal(nightState(), { a: pick('split') }, seededRandom(1));
  assert.equal(zeroSin.state.seats.a.sin, 1);
  const noSin = resolveNight(nightState(), { a: pick('split') }, { ...data, settings: { ...settings, splitSin: 0, splitPounds: 9 } });
  assert.deepEqual([noSin.result.players.a, noSin.state.seats.a.sin], [{ choice: 'split', pounds: 9, influence: 0, sin: 0 }, undefined]);
});

test('sleep does nothing; every choice at once settles each player on their own', () => {
  const state = nightState();
  const { state: after, result } = reveal(state, { a: pick('sleep'), b: pick('split'), c: pick('gamble', 1) }, dice(4));
  assert.deepEqual(result.players, {
    a: { choice: 'sleep', pounds: 0, influence: 0, sin: 0 },
    b: { choice: 'split', pounds: 6, influence: 0, sin: 1 },
    c: { choice: 'gamble', tiers: 1, rolls: [4], bust: false, pounds: 5, influence: 0, sin: 0 },
  });
  assert.deepEqual(after.seats.a, state.seats.a);
  const nobody = reveal(state, {});
  assert.deepEqual(Object.values(nobody.result.players), Array(3).fill({ choice: 'sleep', pounds: 0, influence: 0, sin: 0 }));
  assert.deepEqual(nobody.state.seats, state.seats);
});

test('an early reveal counts whoever has not sent as sleeping; only picks for this table and round, after the night opened and before the deadline, count', () => {
  const early = nightState({ night: { revealAt: OPENED_AT + 1500 } });
  const picks = {
    a: pick('split'),
    b: pick('split', null, { at: OPENED_AT + 1600 }), // 截止之後
    c: pick('gamble', 1, { at: OPENED_AT - 1 }), // 黑夜開始之前
  };
  const { result } = reveal(early, picks);
  assert.deepEqual(result.players.a, { choice: 'split', pounds: 6, influence: 0, sin: 1 }, 'a alone takes all 6');
  assert.deepEqual([result.players.b.choice, result.players.c.choice], ['sleep', 'sleep']);
  const counted = countChoices(nightState(), {
    a: pick('gamble', 2),
    b: pick('split', null, { table: '2' }),
    c: pick('split', null, { round: 2 }),
    x: pick('split'),
  });
  assert.deepEqual(counted, { a: { choice: 'gamble', tiers: 2 } }, 'other tables, rounds and people without a seat do not count');
  assert.equal(submittedChoices(nightState(), { a: pick('sleep'), b: pick('gamble', 4), c: pick('split', 1) }), 1, 'bad tiers do not count');
});

test('every reason a pick is turned down', () => {
  const problem = (state, value, uid = 'a') => choiceProblem(state, uid, value);
  const state = nightState();
  const cases = [
    [{ ...state, phase: 'dusk' }, pick('sleep'), 'not-night'],
    [{ ...state, night: null }, pick('sleep'), 'not-open'],
    [{ ...state, night: { round: 0, openedAt: 1, submitted: 0 } }, pick('sleep'), 'not-open'],
    [nightState({ night: { result: { players: {} } } }), pick('sleep'), 'revealed'],
    [state, pick('sleep'), 'not-seated', 'x'],
    [state, null, 'bad-choice'],
    [state, pick('sleep', null, { table: '2' }), 'wrong-table'],
    [state, pick('sleep', null, { round: 2 }), 'wrong-round'],
    [nightState({ night: { revealAt: OPENED_AT + 500 } }), pick('sleep'), 'too-late'],
    [state, pick('dance'), 'bad-choice'],
    [state, pick('gamble'), 'bad-tiers'],
    [state, pick('gamble', 0), 'bad-tiers'],
    [state, pick('gamble', 4), 'bad-tiers'],
    [state, pick('gamble', 1.5), 'bad-tiers'],
    [state, pick('split', 1), 'tiers-not-gamble'],
    [state, pick('sleep', 2), 'tiers-not-gamble'],
  ];
  for (const [given, value, reason, uid] of cases) assert.equal(problem(given, value, uid), reason, `${reason} ${JSON.stringify(value)}`);
  for (const [, , reason] of cases) assert.equal(typeof NIGHT_REASONS[reason], 'string', reason);
  assert.equal(problem(state, pick('gamble', 3)), null);
  assert.equal(problem(nightState({ night: { revealAt: OPENED_AT + 5000 } }), pick('split')), null, 'during the countdown a pick can still change');
  assert.equal(problem(state, { ...pick('sleep'), table: 1 }), null, 'the table may be a number on screen');
});

test('where the night is: none, choosing, closing, revealed; opening needs a seat', () => {
  assert.equal(nightStage(null, 1), 'none');
  assert.equal(nightStage({ round: 1 }, 2), 'none', 'last round’s night');
  assert.equal(nightStage({ round: 2, openedAt: 1, submitted: 0 }, 2), 'choosing');
  assert.equal(nightStage({ round: 2, revealAt: 5 }, 2), 'closing');
  assert.equal(nightStage({ round: 2, revealAt: 5, result: { players: {} } }, 2), 'revealed');
  assert.equal(nightSettleAt({ revealAt: 5000 }), 5000 + NIGHT_GRACE_MS);
  assert.deepEqual(openNight(nightState({ round: 3 })), { night: { round: 3, submitted: 0 } });
  assert.throws(() => openNight({ ...nightState(), seats: {} }), RangeError);
  assert.throws(() => resolveNight(nightState({ night: { result: { players: {} } } }), {}, data), RangeError, 'revealed once');
});

test('each host step: open, count, start the countdown, wait, reveal; nothing to do otherwise', () => {
  const step = (state, picks = {}, now = OPENED_AT + 2000) => nightStep(state, picks, data, { now, random: dice(6, 6) });
  assert.deepEqual(step({ ...nightState(), night: null }), { kind: 'opened', night: { round: 1, submitted: 0 } });
  assert.deepEqual(step({ ...nightState(), night: { round: 0 } }).kind, 'opened', 'last round’s night does not count');
  assert.deepEqual(step({ ...nightState(), phase: 'dusk', night: null }), { kind: 'none' }, 'only at night');
  assert.deepEqual(step({ ...nightState(), seats: {} }), { kind: 'none' }, 'a table without seats');

  const choosing = nightState();
  assert.deepEqual(step(choosing), { kind: 'waiting' });
  assert.deepEqual(step(choosing, { a: pick('sleep') }), { kind: 'counted', submitted: 1, revealAt: null });
  assert.deepEqual(step(nightState({ night: { submitted: 1 } }), { a: pick('split') }), { kind: 'waiting' }, 'a changed pick is not a new one');
  const everyone = { a: pick('gamble', 2), b: pick('split'), c: pick('sleep') };
  assert.deepEqual(step(nightState({ night: { submitted: 2 } }), everyone, OPENED_AT + 50_000), { kind: 'counted', submitted: 3, revealAt: OPENED_AT + 53_000 });
  assert.deepEqual(step(nightState({ night: { submitted: 3 } }), everyone).revealAt, OPENED_AT + 5000, 'the count was written, the deadline was not');

  const closing = nightState({ night: { submitted: 3, revealAt: OPENED_AT + 5000 } });
  assert.deepEqual(step(closing, everyone, OPENED_AT + 5000), { kind: 'waiting' }, 'the deadline itself');
  assert.deepEqual(step(closing, everyone, OPENED_AT + 5000 + NIGHT_GRACE_MS - 1), { kind: 'waiting' }, 'inside the grace');
  const revealed = step(closing, everyone, OPENED_AT + 5000 + NIGHT_GRACE_MS);
  assert.equal(revealed.kind, 'revealed');
  assert.deepEqual(revealed.result.players.a, { choice: 'gamble', tiers: 2, rolls: [6, 6], bust: false, pounds: 20, influence: 1, sin: 0 });
  assert.deepEqual(step(revealed.state, everyone, OPENED_AT + 9000), { kind: 'none' }, 'revealed once');
  assert.deepEqual(step({ ...choosing, phase: 'sunrise' }, everyone), { kind: 'waiting' }, 'no counting outside the night');
  const early = nightState({ night: { submitted: 1, revealAt: OPENED_AT + 1500 } });
  assert.deepEqual(step(early, { a: pick('sleep') }, OPENED_AT + 2000), { kind: 'waiting' }, 'after an early close nothing new is counted');
});

test('the countdown is never longer than 60 seconds; 0 seconds closes at once', () => {
  const everyone = { a: pick('sleep'), b: pick('sleep'), c: pick('sleep') };
  const count = (seconds) => nightStep(nightState(), everyone, { ...data, settings: { ...settings, nightRevealSeconds: seconds } }, { now: OPENED_AT });
  assert.equal(count(90).revealAt, OPENED_AT + NIGHT_MAX_REVEAL_SECONDS * 1000);
  assert.equal(count(0).revealAt, OPENED_AT);
  assert.equal(count(3).revealAt, OPENED_AT + 3000);
});

// ---- 手牌上限 ----

const HAND = ['a01', 'a02', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07', 'a08']; // 9 張，上限 7：要棄 2 張
const limitPick = (cards, extra = {}) => ({ table: '1', round: 1, cards, seq: 1, at: OPENED_AT + 1000, ...extra });

test('hand limit: how many to discard, and when a pick is used', () => {
  const where = { table: 1, round: 1 };
  assert.equal(overLimit(HAND, settings), 2);
  assert.equal(overLimit(HAND.slice(0, 7), settings), 0);
  assert.equal(overLimit(undefined, settings), 0);
  const problem = (cards, extra, hand = HAND) => discardProblem(hand, cards === undefined ? undefined : limitPick(cards, extra), where, settings);
  assert.equal(problem(['a01', 'a08']), null, 'exactly two cards in the hand');
  assert.equal(problem(['a02', 'a02']), null, 'two copies picked, two copies in the hand');
  assert.equal(problem(['a03', 'a03']), 'not-in-hand', 'one copy cannot be discarded twice');
  assert.equal(problem(['a01']), 'wrong-count');
  assert.equal(problem(['a01', 'a03', 'a04']), 'wrong-count');
  assert.equal(problem(['a01', 'zz9']), 'not-in-hand', 'not their card');
  assert.equal(problem(undefined), 'no-pick');
  assert.equal(problem(['a01', 'a08'], { round: 2 }), 'wrong-round', 'a pick from another night');
  assert.equal(problem(['a01', 'a08'], { table: '2' }), 'wrong-table');
  assert.equal(problem(['a01', 'a08'], { cards: { 0: 'a01', 1: 3 } }), 'bad-pick');
  assert.equal(problem(['a01', 'a08'], {}, HAND.slice(0, 7)), 'not-over', 'not over the limit: nothing to discard');
  assert.equal(problem(['a08', 'a01'], { cards: { 1: 'a01', 0: 'a08' } }), null, 'an array read back as an object');
  for (const reason of ['not-over', 'no-pick', 'bad-pick', 'wrong-table', 'wrong-round', 'wrong-count', 'not-in-hand']) assert.equal(typeof DISCARD_REASONS[reason], 'string');
});

test('hand limit at sunrise: a valid pick is discarded as picked; no pick or a bad pick is discarded at random down to the limit', () => {
  const state = {
    ...nightState({ uids: ['a', 'b', 'c', 'd'], phase: 'sunrise', round: 2 }),
    hands: { a: [...HAND], b: [...HAND], c: [...HAND], d: HAND.slice(0, 7) },
    discard: ['old'],
  };
  for (const uid of ['a', 'b', 'c', 'd']) state.seats[uid].handCount = state.hands[uid].length;
  const picks = { a: limitPick(['a02', 'a08']), c: limitPick(['a01']), d: limitPick(['a01']) };
  const { state: after, discards } = applyHandLimits(state, picks, data, { round: 1, random: seededRandom(5) });
  assert.deepEqual(after.hands.a, ['a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07'], 'a: the picked ones');
  assert.deepEqual(discards.a, { cards: ['a02', 'a08'], picked: true });
  for (const uid of ['b', 'c']) {
    assert.equal(after.hands[uid].length, 7, `${uid}: down to the limit`);
    assert.equal(discards[uid].picked, false, `${uid}: no pick, or a pick with the wrong count`);
    assert.deepEqual([...after.hands[uid], ...discards[uid].cards].sort(), [...HAND].sort(), `${uid}: discarded from the own hand`);
  }
  assert.deepEqual(after.hands.d, HAND.slice(0, 7), 'd: at the limit, the pick is ignored');
  assert.equal(discards.d, undefined);
  assert.deepEqual(after.discard, ['old', ...discards.a.cards, ...discards.b.cards, ...discards.c.cards], 'into the discard pile in seat order');
  assert.deepEqual(field(after, 'handCount'), { a: 7, b: 7, c: 7, d: 7 });
  // 照挑的棄不用亂數；沒有人超過時什麼都不動。
  assert.deepEqual(applyHandLimits({ ...state, hands: { ...state.hands, b: HAND.slice(0, 7), c: HAND.slice(0, 7) } }, picks, data, { round: 1, random: dice() }).discards, {
    a: { cards: ['a02', 'a08'], picked: true },
  });
  const calm = { ...state, hands: { a: HAND.slice(0, 3), b: [], c: [], d: [] } };
  assert.equal(applyHandLimits(calm, picks, data, { round: 1, random: dice() }).state, calm);
});

test('the sunrise write discards first, then pays and draws, then flips the deck event', () => {
  // 牌庫是空的：棄的牌進棄牌堆後，日出抽牌才會把它們洗回來抽到（先抽再棄的話什麼都抽不到）。
  // 一般事件全體英鎊 −20：先領薪再翻事件是 10＋5−20→0（夾 0），反過來會是 5。
  const events = [{ id: 'ev', name: '事件', year: null, kind: 'deck', effects: [{ op: 'pounds', target: 'all', amount: -20 }], text: '事件' }];
  const cardData = { ...data, events };
  const state = {
    ...nightState({ uids: ['a', 'b', 'c'], phase: 'sunrise', round: 2 }),
    hands: { a: [...HAND], b: HAND.slice(0, 8), c: ['c1'] },
    deck: [],
    discard: [],
    fogMax: 0,
    fogFired: [],
    fogPending: [],
    eventDeck: ['ev'],
  };
  const { state: after, events: log, discards } = settleSunrise(state, { a: limitPick(['a01', 'a07']) }, cardData, seededRandom(9));
  assert.deepEqual(discards.a, { cards: ['a01', 'a07'], picked: true });
  assert.equal(discards.b.cards.length, 1);
  const thrown = [...discards.a.cards, ...discards.b.cards];
  assert.equal(after.hands.a.length, 9, 'a: 9 − 2 + 2');
  assert.deepEqual(after.hands.a.slice(7).every((card) => thrown.includes(card)), true, 'a drew back cards discarded in the same write');
  assert.deepEqual([after.hands.b.length, after.hands.c.length], [8, 1], 'b: 8 − 1 + the last one; c: the piles are empty');
  assert.deepEqual([after.deck, after.discard], [[], []]);
  assert.deepEqual(field(after, 'pounds'), { a: 0, b: 0, c: 0 }, 'the event comes after the pay');
  assert.deepEqual(log, [{ round: 2, phase: 'sunrise', event: 'ev', kind: 'deck' }]);
  // 第 1 回合（開局那筆）不經過這裡；round 1 的日出算的是第 0 回合的黑夜，沒有挑的棄牌照樣亂數棄到上限。
  assert.equal(settleSunrise({ ...state, round: 1 }, { a: limitPick(['a01', 'a07']) }, cardData, seededRandom(9)).discards.a.picked, false);
});

test('a night and a hand limit saved to the database and read back (nulls dropped) give the same results', () => {
  // 資料庫不存 null 與空的陣列、物件：每一步之間把局面存成 JSON、拿掉這些再讀回來。
  const stored = (value) =>
    JSON.parse(JSON.stringify(value), (key, item) => {
      if (item === null) return undefined;
      if (Array.isArray(item) && item.length === 0) return undefined;
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) return undefined;
      return item;
    }) ?? {};
  const everyone = { a: pick('gamble', 3), b: pick('split'), c: pick('gamble', 1) };
  const run = (save) => {
    let state = { ...nightState({ seats: { b: { sin: 0 } } }), night: null, fogPending: [] };
    const opened = nightStep(save(state), {}, data, { now: OPENED_AT, random: seededRandom(3) });
    state = { ...state, night: { ...opened.night, openedAt: OPENED_AT } };
    const counted = nightStep(save(state), save(everyone), data, { now: OPENED_AT + 1000, random: seededRandom(3) });
    state = { ...state, night: { ...state.night, submitted: counted.submitted, revealAt: counted.revealAt } };
    const revealed = nightStep(save(state), save(everyone), data, { now: counted.revealAt + NIGHT_GRACE_MS, random: seededRandom(3) });
    const hands = { a: [...HAND], b: HAND.slice(0, 8), c: [] };
    const limited = applyHandLimits(save({ ...revealed.state, round: 2, hands }), save({ a: limitPick(['a02', 'a02']) }), data, { round: 1, random: seededRandom(4) });
    return { opened, counted, revealed: { ...revealed, state: stored(revealed.state) }, limited: { ...limited, state: stored(limited.state) } };
  };
  const direct = run((state) => state);
  const saved = run(stored);
  assert.deepEqual(saved, direct);
  assert.deepEqual([direct.counted.submitted, direct.revealed.result.players.b], [3, { choice: 'split', pounds: 6, influence: 0, sin: 1 }]);
  assert.deepEqual([direct.limited.discards.a.picked, direct.limited.discards.b.picked, direct.limited.discards.c], [true, false, undefined]);
});
