// 事件的純函式：迷霧事件（大於門檻才觸發、由小到大、只觸發一次、連鎖、舊局面殘留的 fogPending、對象與夾 0）、
// 日出一般事件（牌堆、翻牌、翻完重洗、張數）、白晝出牌與響應與黃昏揭曉都接上迷霧事件（M7）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DUSK_GRACE_MS,
  SUNRISE_EVENTS_DEFAULT,
  acceptPlay,
  dayStatus,
  drawEvents,
  duskStep,
  eventLogList,
  fogEventFor,
  nextEventIndex,
  processRequest,
  resolvePlay,
  responseSettleAt,
  seededRandom,
  settleFog,
  settlePending,
  settleSunriseEvents,
  shuffle,
  skippedEventEffects,
  startGame,
  sunriseEventsOf,
  withFogEvents,
} from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';

const cardDir = new URL('../../play/data/', import.meta.url);
const { data } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));

// 測試用的牌與事件：每張只做一兩件事，結果好算。設定沿用資料檔（迷霧門檻 30／60／90），出牌當下就結算（響應秒數 0）。
const card = (id, fields = {}) => ({
  id,
  name: id,
  kind: 'play',
  category: null,
  role: null,
  copies: 1,
  cost: { pounds: 0, influence: 0 },
  gear: null,
  effects: [],
  text: id,
  ...fields,
});
const fogCard = (id, amount) => card(id, { effects: [{ op: 'fog', amount }] });
const deckEvent = (id, effects, fields = {}) => ({ id, name: id, year: null, kind: 'deck', effects, text: id, ...fields });
const fogEvent = (id, threshold, effects, fields = {}) => ({ id, name: id, year: null, kind: 'fog', threshold, effects, text: id, ...fields });

const F30 = fogEvent('f30', 30, [{ op: 'pounds', target: 'all', amount: -1 }]);
const F60 = fogEvent('f60', 60, [{ op: 'influence', target: 'role', role: 'r2', amount: 2 }]);
// 90：@指定 這一版不結算、r6 沒人坐打空、全體 −20 夾在 0。
const F90 = fogEvent('f90', 90, [
  { op: 'pounds', target: 'chosen', amount: -5 },
  { op: 'influence', target: 'role', role: 'r6', amount: 1 },
  { op: 'pounds', target: 'all', amount: -20 },
]);
const testData = {
  settings: { ...data.settings, responseSeconds: 0, sunriseEvents: 1 },
  roles: data.roles,
  actions: [card('plain'), fogCard('fog1', 1), fogCard('fog30', 30), fogCard('fog31', 31), fogCard('fogUp', 40), fogCard('fogDown', -40)],
  bills: [{ id: 'foggy', name: 'foggy', year: null, onPass: [{ op: 'fog', amount: 31 }], onFail: [], text: 'foggy' }],
  events: [
    deckEvent('d1', [{ op: 'pounds', target: 'all', amount: 2 }]),
    deckEvent('d2', [{ op: 'fog', amount: 31 }, { op: 'influence', target: 'role', role: 'r1', amount: 1 }]),
    deckEvent('d3', [{ op: 'draw', target: 'all', amount: 1 }, { op: 'discard', target: 'role', role: 'r2', amount: 2 }]),
    F30,
    F60,
    F90,
  ],
};
const withEvents = (events, settings = {}) => ({ ...testData, settings: { ...testData.settings, ...settings }, events });
const DECK_EVENTS = ['d1', 'd2', 'd3'];

// 一桌三人：a（座位 0、r1）、b（座位 1、r2）、c（座位 2、r3），英鎊 10、影響力 3；第 1 回合白晝、迷霧 0。
function tableState({ hands = {}, seats = {}, ...rest } = {}) {
  const allHands = { a: ['h1'], b: ['h2', 'h3'], c: ['h4'], ...hands };
  const allSeats = {};
  ['a', 'b', 'c'].forEach((uid, order) => {
    allSeats[uid] = { order, role: `r${order + 1}`, pounds: 10, influence: 3, handCount: allHands[uid].length, ...seats[uid] };
  });
  return { round: 1, phase: 'day', fog: 0, startOrder: 0, lastSeq: {}, deck: ['x1', 'x2', 'x3'], discard: [], ...rest, seats: allSeats, hands: allHands };
}

// 輪到的人出一張牌（先放進他手上），結算完接著處理迷霧事件（同主持端的一筆寫入）。
function play(state, cardId, cardData = testData) {
  const uid = dayStatus(state, state.round).current;
  const ready = { ...state, hands: { ...state.hands, [uid]: [...state.hands[uid], cardId] } };
  const request = { seq: (ready.lastSeq?.[uid] ?? 0) + 1, type: 'play', card: cardId };
  const result = withFogEvents(processRequest(ready, uid, request, cardData, seededRandom(1)), cardData, seededRandom(2));
  assert.equal(result.kind, 'played', result.reason);
  return result;
}

const pounds = (state) => Object.fromEntries(Object.entries(state.seats).map(([uid, seat]) => [uid, seat.pounds]));
const influence = (state) => Object.fromEntries(Object.entries(state.seats).map(([uid, seat]) => [uid, seat.influence]));
const fogOf = (state) => [state.fog, state.fogMax, state.fogFired, state.fogPending];
const fogEntry = (threshold, event = `f${threshold}`, fields = {}) => ({ round: 1, phase: 'day', event, kind: 'fog', threshold, ...fields });

test('fog events fire only above a threshold: exactly 30 does nothing, 31 fires the 30 event in the same settlement', () => {
  let result = play(tableState(), 'fog30');
  assert.deepEqual([result.state.fog, result.events, result.state.fogFired, result.state.fogPending], [30, [], [], []]);
  result = play(result.state, 'fog1');
  assert.deepEqual(result.events, [fogEntry(30)]);
  assert.deepEqual(fogOf(result.state), [31, 31, [30], []], 'fogPending is cleared once the event is settled');
  assert.deepEqual(pounds(result.state), { a: 9, b: 9, c: 9 }, 'f30: everyone pays 1');
});

test('crossing two thresholds at once fires them from small to large; going back below and up again fires nothing', () => {
  let result = play(tableState({ fog: 25 }), 'fogUp');
  assert.deepEqual(result.events, [fogEntry(30), fogEntry(60)]);
  assert.deepEqual(fogOf(result.state), [65, 65, [30, 60], []]);
  assert.deepEqual([pounds(result.state), influence(result.state)], [{ a: 9, b: 9, c: 9 }, { a: 3, b: 5, c: 3 }]);
  result = play(result.state, 'fogDown');
  assert.deepEqual([result.state.fog, result.events], [25, []]);
  result = play(result.state, 'fogUp');
  assert.deepEqual([result.events, fogOf(result.state)], [[], [65, 65, [30, 60], []]], 'each threshold fires once per game');
  assert.deepEqual(pounds(result.state), { a: 9, b: 9, c: 9 });
});

test('an event that pushes the fog over the next threshold fires that one next, until nothing new is crossed', () => {
  const chain = withEvents([
    fogEvent('f30', 30, [{ op: 'fog', amount: 31 }]),
    fogEvent('f60', 60, [{ op: 'fog', amount: 31 }, { op: 'pounds', target: 'all', amount: 1 }]),
    fogEvent('f90', 90, [{ op: 'fog', amount: 50 }, { op: 'pounds', target: 'all', amount: 1 }]),
  ]);
  const result = play(tableState(), 'fog31', chain);
  assert.deepEqual(result.events, [fogEntry(30), fogEntry(60), fogEntry(90)]);
  assert.deepEqual(fogOf(result.state), [100, 100, [30, 60, 90], []]);
  assert.deepEqual(pounds(result.state), { a: 12, b: 12, c: 12 });
});

test('fogPending left by an older version is settled at the next settlement', () => {
  const old = tableState({ fog: 35, fogMax: 35, fogFired: [30], fogPending: [30] });
  const result = play(old, 'plain');
  assert.deepEqual(result.events, [fogEntry(30)]);
  assert.deepEqual(fogOf(result.state), [35, 35, [30], []]);
  assert.deepEqual(pounds(result.state), { a: 9, b: 9, c: 9 });
  // 不是結算的寫入（退回、結束這一輪）不處理，等下一次結算。
  const passed = withFogEvents(processRequest(old, 'a', { seq: 1, type: 'pass' }, testData), testData);
  assert.deepEqual([passed.kind, passed.events, passed.state.fogPending], ['passed', undefined, [30]]);
  // 日出也是結算：一般事件 0 張時照樣處理殘留的。
  const dawn = settleSunriseEvents({ ...old, phase: 'sunrise', round: 2 }, withEvents(testData.events, { sunriseEvents: 0 }), seededRandom(1));
  assert.deepEqual(dawn.events, [{ ...fogEntry(30), round: 2, phase: 'sunrise' }]);
  assert.deepEqual(dawn.state.fogPending, []);
});

test('event targets: everyone, a role (nobody in it means nobody is hit), @指定 skipped; amounts stop at 0', () => {
  const result = play(tableState({ fog: 89, fogMax: 89, fogFired: [30, 60] }), 'fog31');
  assert.deepEqual(result.events, [fogEntry(90)]);
  assert.deepEqual([pounds(result.state), influence(result.state)], [{ a: 0, b: 0, c: 0 }, { a: 3, b: 3, c: 3 }]);
  assert.deepEqual(skippedEventEffects(F90), [F90.effects[0]], '@指定 is the one effect the screen says was skipped');
  assert.deepEqual([skippedEventEffects(F30), skippedEventEffects(null)], [[], []]);
});

test('a todo event and a threshold with no event are only logged (skipped), with no effect', () => {
  const todo = withEvents([fogEvent('f30', 30, [], { todo: true, todoText: '全場休戰' }), F90]);
  let result = play(tableState({ fog: 25 }), 'fogUp', todo);
  assert.deepEqual(result.events, [fogEntry(30, 'f30', { skipped: true }), { round: 1, phase: 'day', kind: 'fog', threshold: 60, skipped: true }]);
  assert.deepEqual([pounds(result.state), influence(result.state)], [{ a: 10, b: 10, c: 10 }, { a: 3, b: 3, c: 3 }]);
  assert.deepEqual(fogOf(result.state), [65, 65, [30, 60], []], 'both thresholds are used up');
  assert.deepEqual(skippedEventEffects(todo.events[0]), []);
  result = play(result.state, 'fogUp', todo);
  assert.deepEqual(result.events, [fogEntry(90)]);
  assert.equal(fogEventFor(todo, 60), null);
});

test('the event deck is shuffled at random, drawn from the top, and reshuffled from all deck events when it runs out', () => {
  const order = shuffle(DECK_EVENTS, seededRandom(5));
  let { drawn, eventDeck } = drawEvents(undefined, testData, 1, seededRandom(5));
  assert.deepEqual([drawn, eventDeck], [[order[0]], order.slice(1)], 'the first use shuffles every deck event into a pile');
  ({ drawn, eventDeck } = drawEvents(eventDeck, testData, 2, seededRandom(6)));
  assert.deepEqual([drawn, eventDeck], [order.slice(1), []]);
  const again = shuffle(DECK_EVENTS, seededRandom(7));
  ({ drawn, eventDeck } = drawEvents(['d2'], testData, 2, seededRandom(7)));
  assert.deepEqual([drawn, eventDeck], [['d2', again[0]], again.slice(1)], 'the last card first, then a fresh pile of all three');
  assert.deepEqual(drawEvents(['gone', 'f30', 'd3'], testData, 1, seededRandom(1)), { drawn: ['d3'], eventDeck: [] }, 'unknown ids and fog events are skipped');
  assert.deepEqual(drawEvents(['d1'], testData, 0, seededRandom(1)), { drawn: [], eventDeck: ['d1'] });
  assert.deepEqual(drawEvents([], withEvents([F30]), 1, seededRandom(1)), { drawn: [], eventDeck: [] }, 'no deck events: nothing to draw');
  const firsts = new Set(Array.from({ length: 20 }, (_, seed) => drawEvents([], data, 1, seededRandom(seed)).drawn[0]));
  assert.ok(firsts.size > 3, 'the real data is not drawn in file order');
});

test('sunrise flips sunriseEvents deck events (0, 1, 2) and settles the fog events each one causes right after it', () => {
  const dawn = (count, eventDeck = ['d2', 'd1', 'd3']) =>
    settleSunriseEvents(tableState({ round: 2, phase: 'sunrise', eventDeck }), withEvents(testData.events, { sunriseEvents: count }), seededRandom(3));
  const entry = (event) => ({ round: 2, phase: 'sunrise', event, kind: 'deck' });
  const none = dawn(0);
  assert.deepEqual([none.events, none.state.eventDeck, pounds(none.state)], [[], ['d2', 'd1', 'd3'], { a: 10, b: 10, c: 10 }]);
  const one = dawn(1);
  assert.deepEqual(one.events, [entry('d2'), { round: 2, phase: 'sunrise', event: 'f30', kind: 'fog', threshold: 30 }]);
  assert.deepEqual([one.state.eventDeck, one.state.fog, influence(one.state).a, pounds(one.state)], [['d1', 'd3'], 31, 4, { a: 9, b: 9, c: 9 }]);
  const two = dawn(2);
  assert.deepEqual(two.events.map((item) => item.event), ['d2', 'f30', 'd1'], 'the fog event comes right after the event that caused it');
  assert.deepEqual([two.state.eventDeck, pounds(two.state)], [['d3'], { a: 11, b: 11, c: 11 }]);
  // 沒有這個設定時用預設的張數。
  const { sunriseEvents, ...settings } = testData.settings;
  assert.equal(SUNRISE_EVENTS_DEFAULT, 1);
  const fallback = settleSunriseEvents(tableState({ round: 2, phase: 'sunrise', eventDeck: ['d1'] }), { ...testData, settings }, seededRandom(3));
  assert.deepEqual(fallback.events, [entry('d1')]);
});

test('deck events that draw or discard use the deck, the discard pile and random discards like day cards', () => {
  const result = settleSunriseEvents(tableState({ round: 2, phase: 'sunrise', eventDeck: ['d3'] }), testData, seededRandom(4));
  assert.deepEqual(result.state.deck, []);
  assert.deepEqual([result.state.hands.a, result.state.hands.c], [['h1', 'x1'], ['h4', 'x3']], 'everyone draws 1 in seat order');
  assert.equal(result.state.hands.b.length, 1, 'r2 had 3 cards and discards 2 at random');
  assert.deepEqual([...result.state.hands.b, ...result.state.discard].sort(), ['h2', 'h3', 'x2']);
  assert.deepEqual(Object.values(result.state.seats).map((seat) => seat.handCount), [2, 1, 2]);
});

test('the opening deals, pays the first sunrise and flips the first deck event in one go', () => {
  const real = { ...data, settings: { ...data.settings, sunriseEvents: 1 } };
  const before = { round: 1, phase: 'sunrise', fog: 0, fogFired: [], fogPending: [], eventDeck: [] };
  const opened = settleSunriseEvents({ ...startGame(real, ['u1', 'u2', 'u3'], { random: seededRandom(1) }), ...before }, real, seededRandom(1));
  const deckIds = real.events.filter((event) => event.kind === 'deck').map((event) => event.id);
  assert.equal(opened.events[0].kind, 'deck');
  assert.deepEqual([opened.events[0].round, opened.events[0].phase], [1, 'sunrise']);
  assert.equal(opened.state.eventDeck.length, deckIds.length - 1);
  assert.deepEqual([...opened.state.eventDeck, opened.events[0].event].sort(), [...deckIds].sort());
  assert.deepEqual(sunriseEventsOf(opened.events, 1), [opened.events[0]]);
});

test('responses and bills run the fog events too, in the same settlement', () => {
  const windowed = withEvents(testData.events, { responseSeconds: 5 });
  const opened = processRequest(tableState({ hands: { a: ['fog31'] } }), 'a', { seq: 1, type: 'play', card: 'fog31' }, windowed);
  assert.equal(opened.kind, 'opened');
  const state = { ...opened.state, pending: { id: 'p1', ...opened.pending, openedAt: 1000, seconds: 5 } };
  const resolved = withFogEvents(settlePending(state, {}, windowed, { now: responseSettleAt(state.pending), random: seededRandom(1) }), windowed);
  assert.deepEqual([resolved.kind, resolved.events, resolved.state.pending], ['resolved', [fogEntry(30)], null]);
  assert.deepEqual(pounds(resolved.state), { a: 9, b: 9, c: 9 });

  const dusk = { ...tableState({ phase: 'dusk', fog: 10 }), table: 2, dusk: { round: 1, bill: 'foggy', openedAt: 1000, submitted: 1, revealAt: 2000 }, bills: {} };
  const votes = { a: { table: '2', round: 1, side: 'yes', bid: 1, seq: 1, at: 1500 } };
  const revealed = withFogEvents(duskStep(dusk, votes, testData, { now: 2000 + DUSK_GRACE_MS, random: seededRandom(1) }), testData);
  assert.deepEqual([revealed.kind, revealed.result.passed, revealed.state.fog], ['revealed', true, 41]);
  assert.deepEqual(revealed.events, [{ ...fogEntry(30), phase: 'dusk' }]);
  assert.deepEqual([revealed.state.fogPending, pounds(revealed.state)], [[], { a: 9, b: 9, c: 9 }]);
  // 不是結算的結果原樣回傳。
  const waiting = { kind: 'waiting' };
  assert.equal(withFogEvents(waiting, testData), waiting);
});

test('event log helpers: Firebase arrays may come back as objects; the next index follows the largest', () => {
  const log = { 0: { round: 1, phase: 'sunrise', event: 'd1', kind: 'deck' }, 2: { round: 2, phase: 'sunrise', event: 'd2', kind: 'deck' } };
  assert.deepEqual(eventLogList(log).map((entry) => entry.event), ['d1', 'd2']);
  assert.deepEqual([nextEventIndex(log), nextEventIndex([log[0]]), nextEventIndex(undefined)], [3, 1, 0]);
  assert.deepEqual(sunriseEventsOf(log, 2), [log[2]]);
  assert.deepEqual(sunriseEventsOf([{ round: 2, phase: 'day', event: 'f30', kind: 'fog', threshold: 30 }], 2), []);
});

test('half-way states stored as JSON (nulls dropped) give the same results', () => {
  const stored = (value) => JSON.parse(JSON.stringify(value), (key, item) => (item === null ? undefined : item));
  const accepted = acceptPlay(tableState({ fog: 25, hands: { a: ['fogUp'] }, pending: null }), 'a', { seq: 1, type: 'play', card: 'fogUp' }, testData);
  const finish = (value) => {
    const resolved = resolvePlay(value.state, value.pending, testData, seededRandom(4));
    return stored(withFogEvents({ kind: 'played', ...resolved }, testData, seededRandom(5)));
  };
  assert.deepEqual(finish(stored(accepted)), finish(accepted));
  assert.deepEqual(finish(accepted).events.map((entry) => entry.threshold), [30, 60]);

  const dawn = tableState({ round: 2, phase: 'sunrise', fogMax: null, fogFired: [30], fogPending: [], eventDeck: ['d2', 'd3'] });
  const run = (value) => stored(settleSunriseEvents(value, withEvents(testData.events, { sunriseEvents: 2 }), seededRandom(6)));
  assert.deepEqual(run(stored(dawn)), run(dawn));
  assert.deepEqual(run(dawn).events.map((entry) => entry.event), ['d2', 'd3'], 'fog 30 already fired: nothing more');
});
