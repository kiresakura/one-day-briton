// 響應卡的純函式：響應窗口、檢查與退回、先到先算、結算順序、抵銷、罪孽（M5b）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  REJECT_REASONS,
  RESPONSE_GRACE_MS,
  acceptResponse,
  buildDeck,
  dayStatus,
  processRequest,
  resolvePlay,
  responseDeadline,
  responseProblem,
  responseSettleAt,
  seededRandom,
  settlePending,
  startGame,
} from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';

const cardDir = new URL('../../play/data/', import.meta.url);
const { data } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));

// 測試用的牌：每張只做一件事，結果好算。設定沿用資料檔（響應 5 秒、每輪最多 4 張）。
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
const response = (id, respondsTo, fields = {}) => card(id, { kind: 'response', respondsTo, ...fields });
const testData = {
  settings: data.settings,
  actions: [
    card('plain'),
    card('gain', { category: '交易', effects: [{ op: 'pounds', target: 'self', amount: 5 }] }),
    card('crime', {
      category: '犯罪',
      effects: [
        { op: 'pounds', target: 'chosen', amount: -3 },
        { op: 'pounds', target: 'self', amount: 3 },
      ],
    }),
    // 齒輪 A：成本 1 英鎊；自己英鎊 +2、其他人英鎊 −1。
    card('gearA', {
      category: '生產',
      gear: 'A',
      cost: { pounds: 1, influence: 0 },
      effects: [
        { op: 'pounds', target: 'self', amount: 2 },
        { op: 'pounds', target: 'others', amount: -1 },
      ],
    }),
    // 響應卡
    response('tax', ['交易', '生產'], {
      category: '查緝',
      effects: [
        { op: 'pounds', target: 'originalPlayer', amount: -4 },
        { op: 'influence', target: 'self', amount: 1 },
      ],
    }),
    response('any', null, { category: '神祕', effects: [{ op: 'draw', target: 'self', amount: 1 }] }),
    response('steal', ['交易'], {
      category: '犯罪',
      effects: [
        { op: 'pounds', target: 'originalPlayer', amount: -2 },
        { op: 'pounds', target: 'self', amount: 2 },
      ],
    }),
    response('riot', null, { category: '破壞' }),
    response('veto', null, { category: '政治', cost: { pounds: 0, influence: 1 }, effects: [{ op: 'cancel' }] }),
    response('vetoPlus', null, {
      effects: [
        { op: 'cancel' },
        { op: 'pounds', target: 'self', amount: 2 },
        { op: 'influence', target: 'originalPlayer', amount: -1 },
      ],
    }),
    response('pricey', null, { cost: { pounds: 50, influence: 0 } }),
    response('aimed', null, { effects: [{ op: 'pounds', target: 'chosen', amount: -1 }] }),
    response('broken', null, { todo: true, todoText: '偷看一張手牌' }),
  ],
};
const SECONDS = testData.settings.responseSeconds;
const OPENED_AT = 100_000; // 窗口打開的伺服器時間（毫秒）

// 一桌三人：a（座位 0）、b（座位 1）、c（座位 2），英鎊 10、影響力 3；第 1 回合白晝、a 先出。
function tableState({ hands = {}, seats = {}, ...rest } = {}) {
  const allHands = { a: [], b: [], c: [], ...hands };
  const allSeats = {};
  ['a', 'b', 'c'].forEach((uid, order) => {
    allSeats[uid] = { order, role: `r${order + 1}`, pounds: 10, influence: 3, handCount: allHands[uid].length, ...seats[uid] };
  });
  return { round: 1, phase: 'day', fog: 0, startOrder: 0, lastSeq: {}, deck: [], discard: [], pending: null, ...rest, seats: allSeats, hands: allHands };
}

const nextSeq = (state, uid) => (state.lastSeq?.[uid] ?? 0) + 1;
const play = (state, uid, cardId, extra = {}, cardData = testData) =>
  processRequest(state, uid, { seq: nextSeq(state, uid), type: 'play', card: cardId, ...extra }, cardData, seededRandom(1));

// uid 出一張牌、開響應窗口；主持端寫入時補上 id、伺服器時間 openedAt 與秒數。
let ids = 0;
function open(state, uid, cardId, extra = {}) {
  const result = play(state, uid, cardId, extra);
  assert.equal(result.kind, 'opened', result.reason);
  ids += 1;
  return { ...result.state, pending: { id: `p${ids}`, ...result.pending, openedAt: OPENED_AT, seconds: SECONDS } };
}

// uid 打出響應卡的請求；at 是伺服器收到的時間，預設是窗口打開後 1 秒。
const answer = (state, uid, cardId, at = OPENED_AT + 1000, pending = state.pending.id) => ({
  seq: nextSeq(state, uid),
  type: 'respond',
  card: cardId,
  pending,
  at,
});
const settle = (state, requests = {}, now = OPENED_AT + 1000) => settlePending(state, requests, testData, { now, random: seededRandom(1) });
// 沒人響應，時間到照常結算。
function timeOut(state) {
  const result = settle(state, {}, responseSettleAt(state.pending));
  assert.equal(result.kind, 'resolved');
  return result.state;
}
const money = (state) => Object.fromEntries(Object.entries(state.seats).map(([uid, seat]) => [uid, [seat.pounds, seat.influence]]));
const sorted = (list) => [...list].sort();

test('the window lasts responseSeconds from the server time it opened, plus a grace before nobody counts as responding', () => {
  assert.equal(SECONDS, 5, 'the data files say 5 seconds');
  assert.equal(RESPONSE_GRACE_MS, 1000);
  assert.equal(responseDeadline({ openedAt: 100, seconds: 5 }), 5100);
  assert.equal(responseSettleAt({ openedAt: 100, seconds: 5 }), 6100);
  assert.equal(responseSettleAt({ openedAt: 100, seconds: 0 }), 1100);
});

test('a play opens a window: the cost is paid and the card leaves the hand, the turn and the discard pile wait', () => {
  const state = tableState({ hands: { a: ['gearA', 'plain'] } });
  const result = play(state, 'a', 'gearA');
  assert.equal(result.kind, 'opened');
  assert.deepEqual(result.pending, { by: 'a', seq: 1, card: 'gearA', level: 1, target: null, chainTarget: null });
  assert.deepEqual(result.state.hands.a, ['plain']);
  assert.deepEqual([result.state.seats.a.pounds, result.state.seats.a.handCount], [9, 1]);
  assert.deepEqual(money(result.state).b, [10, 3], 'no effect yet');
  assert.equal(result.state.turn, undefined);
  assert.deepEqual(result.state.discard, []);
  assert.equal(result.state.lastSeq.a, 1);
  assert.equal(result.state.pending, null, 'the store adds pending with its id and the server time');

  // responseSeconds 是 0：不開窗口，出牌當下就結算（M5a 的做法）。
  const noWindow = { ...testData, settings: { ...testData.settings, responseSeconds: 0 } };
  const direct = play(state, 'a', 'gearA', {}, noWindow);
  assert.equal(direct.kind, 'played');
  assert.deepEqual(money(direct.state), { a: [11, 3], b: [9, 3], c: [9, 3] });
  assert.deepEqual(direct.state.turn, { round: 1, index: 0, plays: 1, gear: 'A', level: 1 });
});

test('while a card waits for responses, every request waits; without one, a response is turned down', () => {
  const state = open(tableState({ hands: { a: ['gain', 'plain'], b: ['tax'] } }), 'a', 'gain');
  for (const [uid, request] of [
    ['a', { type: 'play', card: 'plain' }],
    ['a', { type: 'pass' }],
    ['b', { type: 'pass' }],
    ['b', answer(state, 'b', 'tax')],
  ]) {
    assert.deepEqual(processRequest(state, uid, { ...request, seq: nextSeq(state, uid) }, testData), { kind: 'deferred' }, JSON.stringify(request));
  }
  const settled = timeOut(state);
  const late = processRequest(settled, 'b', answer(state, 'b', 'tax'), testData);
  assert.deepEqual([late.kind, late.reason], ['rejected', 'no-pending']);
  assert.deepEqual(late.state, { ...settled, lastSeq: { ...settled.lastSeq, b: 1 } }, 'only the sequence number moves');
  assert.equal(processRequest(settled, 'a', { seq: 2, type: 'play', card: 'plain' }, testData).kind, 'opened', 'the next card goes on');
});

test('every reason a response is turned down, the same on the player screen and on the host', () => {
  const hands = { a: ['crime', 'gain', 'plain', 'any'], b: ['tax', 'plain', 'broken', 'aimed', 'pricey', 'veto', 'mystery', 'any', 'riot'] };
  const base = tableState({ hands, seats: { b: { influence: 0 } } });
  const onGain = open(base, 'a', 'gain');
  const onCrime = open(base, 'a', 'crime', { target: 'c' });
  const onPlain = open(base, 'a', 'plain');
  const deadline = responseDeadline(onGain.pending);
  const cases = [
    [base, 'b', 'tax', {}, 'no-pending'],
    [onGain, 'b', 'tax', { pending: 'p0' }, 'wrong-pending'],
    [onGain, 'b', 'tax', { at: deadline + 1 }, 'too-late'],
    [onGain, 'x', 'tax', {}, 'not-seated'],
    [onGain, 'a', 'any', {}, 'own-card'],
    [onGain, 'b', 'steal', {}, 'not-in-hand'],
    [onGain, 'b', 'mystery', {}, 'unknown-card'],
    [onGain, 'b', 'plain', {}, 'not-response-card'],
    [onGain, 'b', 'broken', {}, 'todo-card'],
    [onCrime, 'b', 'tax', {}, 'wrong-category'],
    [onPlain, 'b', 'tax', {}, 'wrong-category'],
    [onGain, 'b', 'aimed', {}, 'response-needs-target'],
    [onGain, 'b', 'pricey', {}, 'cannot-afford'],
    [onGain, 'b', 'veto', {}, 'cannot-afford'],
  ];
  for (const [state, uid, cardId, fields, reason] of cases) {
    const request = { seq: 1, type: 'respond', card: cardId, pending: state.pending?.id ?? 'p0', at: OPENED_AT + 1000, ...fields };
    assert.deepEqual(acceptResponse(state, uid, request, testData), { ok: false, reason }, `${cardId} ${reason}`);
    assert.equal(typeof REJECT_REASONS[reason], 'string', reason);
    // 玩家畫面只有自己的手牌，查的結果一樣。
    const view = { seats: state.seats, pending: state.pending, hands: { [uid]: state.hands[uid] ?? [] } };
    assert.equal(responseProblem(view, uid, request, testData), reason, `screen: ${cardId} ${reason}`);
  }
  assert.equal(acceptResponse(onGain, 'b', answer(onGain, 'b', 'tax', deadline), testData).ok, true, 'exactly at the deadline still counts');
  assert.equal(acceptResponse(onGain, 'b', answer(onGain, 'b', 'riot'), testData).ok, true, 'a free card with nothing to pay');

  // 主持端退回：只寫他的序號與原因，pending 不動，窗口照樣開著。
  const result = settle(onGain, { b: answer(onGain, 'b', 'veto') });
  assert.deepEqual(result, {
    kind: 'rejected',
    state: { ...onGain, lastSeq: { ...onGain.lastSeq, b: 1 } },
    notices: [{ uid: 'b', seq: 1, reason: 'cannot-afford' }],
  });
  assert.equal(settle(result.state, { b: answer(onGain, 'b', 'veto') }).kind, 'waiting', 'a handled request is not seen again');
});

test('a response card with respondsTo null answers any play card, even one without a category', () => {
  for (const original of ['gain', 'crime', 'plain', 'gearA']) {
    const state = open(tableState({ hands: { a: [original], b: ['any'] }, deck: ['d1'] }), 'a', original, { target: 'c' });
    const result = settle(state, { b: answer(state, 'b', 'any') });
    assert.equal(result.kind, 'resolved', original);
    assert.deepEqual(result.state.hands.b, ['d1'], `${original}: the responder drew one`);
  }
});

test('a response resolves after the card it answers: the original player gets +5 and then -4, never stopping at 0 first', () => {
  // a 只有 2 英鎊。先結算原牌：2＋5＝7、再 −4＝3；要是先結算響應卡，2−4 會停在 0、再＋5＝5。
  const state = open(tableState({ hands: { a: ['gain'], c: ['tax'] }, seats: { a: { pounds: 2 } } }), 'a', 'gain');
  const result = settle(state, { c: answer(state, 'c', 'tax') });
  assert.equal(result.kind, 'resolved');
  assert.deepEqual(money(result.state), { a: [3, 3], b: [10, 3], c: [10, 4] }, '@出牌者 is a, @自己 is c, b is untouched');
  assert.deepEqual(result.response, { by: 'c', seq: 1, card: 'tax', at: OPENED_AT + 1000 });
  assert.deepEqual(result.log, { round: 1, by: 'a', card: 'gain', level: 1, response: { by: 'c', card: 'tax' } });
  assert.equal(result.state.pending, null);
  assert.deepEqual(result.notices, []);
});

test('the responder pays and loses the card, which goes to the discard pile after the one it answers', () => {
  const state = open(tableState({ hands: { a: ['gain'], b: ['steal', 'veto'] }, discard: ['old'] }), 'a', 'gain');
  const result = settle(state, { b: answer(state, 'b', 'steal') });
  assert.deepEqual(result.state.discard, ['old', 'gain', 'steal']);
  assert.deepEqual(result.state.hands.b, ['veto']);
  assert.equal(result.state.seats.b.handCount, 1);
  assert.equal(result.state.lastSeq.b, 1);
  assert.deepEqual(money(result.state), { a: [13, 3], b: [12, 3], c: [10, 3] }, 'a: 10 + 5 − 2; b: 10 + 2');

  const paid = open(tableState({ hands: { a: ['gain'], b: ['veto'] } }), 'a', 'gain');
  assert.deepEqual(money(settle(paid, { b: answer(paid, 'b', 'veto') }).state).b, [10, 2], 'the response costs 1 influence');
});

test('responses are not plays: they leave the turn, the play count and the chain alone, and skip the chain bonus', () => {
  // a 連出四張齒輪 A，第 2 張被 c 以 tax 響應、第 4 張也是。
  let state = tableState({ hands: { a: Array(4).fill('gearA'), b: ['b1', 'b2'], c: ['tax', 'tax'] }, deck: Array(5).fill('plain') });
  const levels = [];
  const respondTo = new Set([2, 4]);
  const before = [];
  for (let count = 1; count <= 4; count += 1) {
    state = open(state, 'a', 'gearA', count === 3 ? { chainTarget: 'b' } : {});
    levels.push(state.pending.level);
    before.push(money(state));
    const result = respondTo.has(count) ? settle(state, { c: answer(state, 'c', 'tax') }) : settle(state, {}, responseSettleAt(state.pending));
    assert.equal(result.kind, 'resolved');
    state = result.state;
    if (count < 4) assert.deepEqual(state.turn, { round: 1, index: 0, plays: count, gear: 'A', level: count }, `after card ${count}`);
  }
  assert.deepEqual(levels, [1, 2, 3, 4], 'the chain went on through the responses');
  assert.equal(dayStatus(state, 1).current, 'b', 'four cards by a, the responses did not count');
  // 第 4 張（4 級）：原牌全部加倍（a +4、其他人 −2）；tax 不加倍：a −4、c 影響力 +1。
  assert.deepEqual(money(state).a[0] - before[3].a[0], 4 - 4);
  assert.deepEqual(money(state).c, [before[3].c[0] - 2, before[3].c[1] + 1]);
  assert.deepEqual(state.seats.c.handCount, 0);
});

test('a canceled card: no effects and no chain bonus, but the cost stays paid, it counts as a play, the chain breaks and it is discarded', () => {
  let state = tableState({ hands: { a: Array(4).fill('gearA'), b: ['b1', 'b2'], c: ['veto'] }, deck: Array(5).fill('plain') });
  state = timeOut(open(state, 'a', 'gearA'));
  state = timeOut(open(state, 'a', 'gearA'));
  state = open(state, 'a', 'gearA', { chainTarget: 'b' });
  assert.equal(state.pending.level, 3);
  const before = state;
  const result = settle(state, { c: answer(state, 'c', 'veto') });
  assert.equal(result.kind, 'resolved');
  const after = result.state;
  assert.equal(after.seats.a.pounds, before.seats.a.pounds, 'the cost was paid when the card was accepted, and +2 never happens');
  assert.deepEqual([after.seats.b.pounds, after.hands.b], [before.seats.b.pounds, ['b1', 'b2']], 'no −1, and no level-3 discard');
  assert.deepEqual(after.hands.a, before.hands.a, 'no level-3 draw');
  assert.equal(after.seats.c.influence, before.seats.c.influence - 1, 'the responder paid for the veto');
  assert.deepEqual(after.discard.slice(-2), ['gearA', 'veto']);
  assert.deepEqual(after.turn, { round: 1, index: 0, plays: 3, gear: null, level: 0 }, 'it counts as the third card and breaks the chain');
  assert.deepEqual(result.log, { round: 1, by: 'a', card: 'gearA', level: 3, chainTarget: 'b', response: { by: 'c', card: 'veto' }, canceled: true });
  const fourth = open(after, 'a', 'gearA');
  assert.equal(fourth.pending.level, 1, 'the next card starts again at level 1');
  assert.equal(dayStatus(timeOut(fourth), 1).current, 'b', 'and it is the fourth of the turn');
});

test('a canceled crime still adds its sin, and the rest of a cancel card still happens', () => {
  const state = open(tableState({ hands: { a: ['crime'], b: ['vetoPlus'] } }), 'a', 'crime', { target: 'c' });
  const result = settle(state, { b: answer(state, 'b', 'vetoPlus') });
  assert.equal(result.state.seats.a.sin, 1);
  assert.deepEqual(money(result.state), { a: [10, 2], b: [12, 3], c: [10, 3] }, 'no −3 / +3; b +2, a −1 influence');
  assert.deepEqual(result.log, { round: 1, by: 'a', card: 'crime', level: 1, target: 'c', response: { by: 'b', card: 'vetoPlus' }, canceled: true });
});

test('crime and sabotage response cards add a sin to the responder', () => {
  const sins = {};
  for (const answerCard of ['steal', 'riot', 'tax', 'any']) {
    const state = open(tableState({ hands: { a: ['gain'], b: [answerCard] }, deck: ['d1'] }), 'a', 'gain');
    const result = settle(state, { b: answer(state, 'b', answerCard) });
    sins[answerCard] = [result.state.seats.a.sin ?? 0, result.state.seats.b.sin ?? 0];
  }
  assert.deepEqual(sins, { steal: [0, 1], riot: [0, 1], tax: [0, 0], any: [0, 0] });
});

test('with several responses the earliest by server time wins, ties go by uid, and the rest are turned down', () => {
  const state = open(tableState({ hands: { a: ['gain'], b: ['tax'], c: ['steal', 'pricey'] } }), 'a', 'gain');
  const early = answer(state, 'c', 'steal', OPENED_AT + 1200);
  const late = answer(state, 'b', 'tax', OPENED_AT + 1500);
  for (const requests of [
    { b: late, c: early },
    { c: early, b: late },
  ]) {
    const result = settle(state, requests);
    assert.equal(result.kind, 'resolved');
    assert.deepEqual(result.log.response, { by: 'c', card: 'steal' });
    assert.deepEqual(result.notices, [{ uid: 'b', seq: 1, reason: 'beaten' }]);
    assert.deepEqual([result.state.lastSeq.b, result.state.hands.b], [1, ['tax']], 'b keeps the card and pays nothing');
    assert.deepEqual(result.state.hands.c, ['pricey']);
  }
  const tie = settle(state, { c: answer(state, 'c', 'steal', OPENED_AT + 1300), b: answer(state, 'b', 'tax', OPENED_AT + 1300) });
  assert.equal(tie.log.response.by, 'b', 'same time: the smaller uid');
  // 最早的那筆不合法：退回原因照實寫，由合法的裡最早的那筆結算。
  const result = settle(state, { c: answer(state, 'c', 'pricey', OPENED_AT + 1100), b: late });
  assert.equal(result.log.response.by, 'b');
  assert.deepEqual(result.notices, [{ uid: 'c', seq: 1, reason: 'cannot-afford' }]);
  // 第三人的請求晚到、窗口也過了：照樣退回。
  const both = settle(state, { b: late, c: answer(state, 'c', 'steal', responseDeadline(state.pending) + 1) });
  assert.equal(both.log.response.by, 'b');
  assert.deepEqual(both.notices, [{ uid: 'c', seq: 1, reason: 'too-late' }]);
});

test('a response after the deadline is turned down, and nobody responding settles the card once the grace is over', () => {
  const state = open(tableState({ hands: { a: ['gain'], b: ['tax'] } }), 'a', 'gain');
  const deadline = responseDeadline(state.pending);
  const settleAt = responseSettleAt(state.pending);
  const late = settle(state, { b: answer(state, 'b', 'tax', deadline + 1) }, deadline + 500);
  assert.deepEqual([late.kind, late.notices], ['rejected', [{ uid: 'b', seq: 1, reason: 'too-late' }]]);
  assert.deepEqual([late.state.pending, late.state.hands.b, late.state.seats.b], [state.pending, ['tax'], state.seats.b], 'the window is still there');

  assert.deepEqual(settle(state, {}, OPENED_AT), { kind: 'waiting' });
  assert.deepEqual(settle(state, {}, settleAt - 1), { kind: 'waiting' }, 'past the deadline but inside the grace');
  const result = settle(state, {}, settleAt);
  const direct = resolvePlay(state, state.pending, testData, seededRandom(1));
  assert.deepEqual(result, { kind: 'resolved', state: { ...direct.state, pending: null }, log: direct.log, response: null, notices: [] });
  assert.deepEqual(money(result.state).a, [15, 3]);
  // 一筆在截止前送到、主持端在緩衝之後才看到：照樣算。
  assert.equal(settle(state, { b: answer(state, 'b', 'tax', deadline) }, settleAt + 5000).log.response.by, 'b');
});

test('the half-way state survives the database (nulls dropped), with or without a response', () => {
  const state = open(tableState({ hands: { a: ['gearA', 'gearA', 'gearA'], b: ['b1'], c: ['tax'] }, deck: Array(5).fill('plain') }), 'a', 'gearA');
  const stored = JSON.parse(JSON.stringify(state), (key, value) => (value === null ? undefined : value));
  assert.equal('target' in stored.pending, false);
  for (const [requests, now] of [
    [{ c: answer(state, 'c', 'tax') }, OPENED_AT + 1000],
    [{}, responseSettleAt(state.pending)],
  ]) {
    assert.deepEqual(settle(stored, requests, now), settle(state, requests, now));
  }
});

test('a whole day of random plays and responses on the card data keeps every card accounted for', () => {
  const random = seededRandom(91);
  let state = { ...startGame(data, ['u1', 'u2', 'u3', 'u4'], { random }), round: 1, phase: 'day', fog: 0, lastSeq: {}, pending: null };
  const byId = new Map(data.actions.map((action) => [action.id, action]));
  const counts = { plays: 0, responses: 0, canceled: 0 };
  const allCards = sorted(buildDeck(data.actions));
  while (!dayStatus(state, 1).done) {
    const { current } = dayStatus(state, 1);
    const others = Object.keys(state.seats).filter((uid) => uid !== current);
    const seat = state.seats[current];
    const playable = state.hands[current].find((id) => {
      const action = byId.get(id);
      return action.kind === 'play' && !action.todo && action.cost.pounds <= seat.pounds && action.cost.influence <= seat.influence;
    });
    if (!playable) {
      state = processRequest(state, current, { seq: nextSeq(state, current), type: 'pass' }, data).state;
      continue;
    }
    const opened = processRequest(state, current, { seq: nextSeq(state, current), type: 'play', card: playable, target: others[0], chainTarget: others[1] }, data, random);
    assert.equal(opened.kind, 'opened', opened.reason);
    counts.plays += 1;
    state = { ...opened.state, pending: { id: `w${counts.plays}`, ...opened.pending, openedAt: 0, seconds: 5 } };
    // 每個人都拿第一張打得出去的響應卡送出，時間隨機；主持端取最早的。
    const requests = {};
    for (const uid of others) {
      const cardId = state.hands[uid].find((id) => responseProblem(state, uid, { card: id, pending: state.pending.id, at: 0 }, data) === null);
      if (cardId) requests[uid] = { seq: nextSeq(state, uid), type: 'respond', card: cardId, pending: state.pending.id, at: random() % 5000 };
    }
    const result = settlePending(state, requests, data, { now: responseSettleAt(state.pending), random });
    assert.equal(result.kind, 'resolved');
    assert.equal(result.notices.length, Math.max(0, Object.keys(requests).length - 1));
    if (result.response) counts.responses += 1;
    if (result.log.canceled) counts.canceled += 1;
    state = result.state;
    assert.deepEqual(sorted([...Object.values(state.hands).flat(), ...state.deck, ...state.discard]), allCards);
    for (const [uid, item] of Object.entries(state.seats)) {
      assert.ok(item.pounds >= 0 && item.influence >= 0);
      assert.equal(item.handCount, state.hands[uid].length);
    }
  }
  assert.ok(counts.plays >= 4 && counts.responses >= 1, JSON.stringify(counts));
});
