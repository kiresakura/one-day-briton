// 白晝的純函式：輪次、出牌的檢查與結算、齒輪連鎖、罪孽、迷霧（M5a）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CHAIN_DISCARD,
  CHAIN_DRAW,
  REJECT_REASONS,
  SIN_CATEGORIES,
  acceptPlay,
  buildDeck,
  chainLevel,
  currentTurn,
  dayStatus,
  discardRandom,
  needsTarget,
  pass,
  playProblem,
  processRequest,
  resolvePlay,
  seatsInOrder,
  seededRandom,
  startGame,
  turnOrder,
} from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';

const cardDir = new URL('../../play/data/', import.meta.url);
const { data } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));

// 測試用的牌：每張只做一件事，結果好算。設定沿用資料檔（每輪最多 4 張、迷霧門檻 30／60／90）。
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
const testData = {
  settings: data.settings,
  actions: [
    card('plain'),
    card('cost', { cost: { pounds: 3, influence: 1 }, effects: [{ op: 'pounds', target: 'self', amount: 5 }] }),
    card('gainAll', { effects: [{ op: 'influence', target: 'all', amount: 1 }] }),
    card('hitOthers', { effects: [{ op: 'pounds', target: 'others', amount: -4 }] }),
    card('hitChosen', { effects: [{ op: 'pounds', target: 'chosen', amount: -20 }] }),
    card('hitRole', { effects: [{ op: 'influence', target: 'role', role: 'r2', amount: -1 }] }),
    card('hitEmptyRole', { effects: [{ op: 'influence', target: 'role', role: 'r6', amount: -1 }] }),
    card('drawTwo', { effects: [{ op: 'draw', target: 'self', amount: 2 }] }),
    card('discardChosen', { effects: [{ op: 'discard', target: 'chosen', amount: 3 }] }),
    card('fogUp', { effects: [{ op: 'fog', amount: 40 }] }),
    card('fogDown', { effects: [{ op: 'fog', amount: -40 }] }),
    card('crime', { category: '犯罪' }),
    card('sabotage', { category: '破壞' }),
    card('trade', { category: '交易' }),
    // 齒輪 A：自己英鎊 +2、全體影響力 +1、自己影響力 -1、其他人英鎊 -1、自己抽 1、迷霧 +5；成本 1 英鎊。
    card('gearA', {
      gear: 'A',
      cost: { pounds: 1, influence: 0 },
      effects: [
        { op: 'pounds', target: 'self', amount: 2 },
        { op: 'influence', target: 'all', amount: 1 },
        { op: 'influence', target: 'self', amount: -1 },
        { op: 'pounds', target: 'others', amount: -1 },
        { op: 'draw', target: 'self', amount: 1 },
        { op: 'fog', amount: 5 },
      ],
    }),
    card('gearB', { gear: 'B' }),
    card('response', { kind: 'response', respondsTo: null, effects: [{ op: 'cancel' }] }),
    card('todo', { todo: true, todoText: '偷看一張手牌' }),
  ],
};

// 一桌三人：a（座位 0、r1）、b（座位 1、r2）、c（座位 2、r3），英鎊 10、影響力 3；第 1 回合白晝、迷霧 0。
function tableState({ hands = {}, seats = {}, ...rest } = {}) {
  const allHands = { a: [], b: [], c: [], ...hands };
  const allSeats = {};
  ['a', 'b', 'c'].forEach((uid, order) => {
    allSeats[uid] = { order, role: `r${order + 1}`, pounds: 10, influence: 3, handCount: allHands[uid].length, ...seats[uid] };
  });
  return { round: 1, phase: 'day', fog: 0, startOrder: 0, lastSeq: {}, deck: [], discard: [], ...rest, seats: allSeats, hands: allHands };
}

// uid 送出下一筆請求（序號接著他上一筆）。
function send(state, uid, request, random = seededRandom(1), cardData = testData) {
  return processRequest(state, uid, { seq: (state.lastSeq?.[uid] ?? 0) + 1, ...request }, cardData, random);
}
const play = (state, uid, cardId, extra = {}, random) => send(state, uid, { type: 'play', card: cardId, ...extra }, random);
const money = (state) => Object.fromEntries(Object.entries(state.seats).map(([uid, seat]) => [uid, [seat.pounds, seat.influence]]));
const sorted = (list) => [...list].sort();

test('the test settings are the ones in the data files', () => {
  assert.equal(testData.settings.maxPlaysPerTurn, 4);
  assert.deepEqual(testData.settings.fogThresholds, [30, 60, 90]);
  assert.deepEqual(SIN_CATEGORIES, ['犯罪', '破壞']);
  assert.deepEqual([CHAIN_DRAW, CHAIN_DISCARD], [2, 1]);
});

test('the day goes clockwise from the starting seat, and the start moves one seat every round', () => {
  const { seats } = tableState();
  assert.deepEqual(turnOrder(seats, 0, 1), ['a', 'b', 'c']);
  assert.deepEqual(turnOrder(seats, 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(turnOrder(seats, 0, 3), ['c', 'a', 'b']);
  assert.deepEqual(turnOrder(seats, 0, 4), ['a', 'b', 'c']);
  assert.deepEqual(turnOrder(seats, 2, 1), ['c', 'a', 'b'], 'the host picked seat 2 to start');
  assert.deepEqual(turnOrder(seats, 2, 2), ['a', 'b', 'c']);
  assert.deepEqual(turnOrder(seats, undefined, 1), ['a', 'b', 'c'], 'no starting seat set: seat 0');
  assert.deepEqual(turnOrder(seats, 5, 1), ['a', 'b', 'c'], 'nobody in that seat: seat 0');
  assert.deepEqual(turnOrder({}, 0, 1), []);
});

test('a turn left over from an earlier round counts as a day that has not started', () => {
  const fresh = { round: 2, index: 0, plays: 0, gear: null, level: 0 };
  assert.deepEqual(currentTurn(undefined, 2), fresh);
  assert.deepEqual(currentTurn({ round: 1, index: 3, plays: 0, level: 0 }, 2), fresh);
  assert.deepEqual(currentTurn({ round: 2, index: 1, plays: 2, gear: 'A', level: 2 }, 2), { round: 2, index: 1, plays: 2, gear: 'A', level: 2 });
  assert.deepEqual(currentTurn({ round: 2, index: 1, plays: 0, level: 0 }, 2), { round: 2, index: 1, plays: 0, gear: null, level: 0 }, 'gear left out by the database');
});

test('everyone plays or passes in turn until the day is done, then the next round starts one seat later', () => {
  let state = tableState();
  assert.deepEqual(dayStatus(state, 1), {
    order: ['a', 'b', 'c'],
    turn: { round: 1, index: 0, plays: 0, gear: null, level: 0 },
    current: 'a',
    remaining: 3,
    done: false,
  });
  for (const [uid, left, next] of [
    ['a', 2, 'b'],
    ['b', 1, 'c'],
    ['c', 0, null],
  ]) {
    const result = send(state, uid, { type: 'pass' });
    assert.equal(result.kind, 'passed');
    state = result.state;
    assert.equal(state.lastSeq[uid], 1);
    assert.deepEqual([dayStatus(state, 1).remaining, dayStatus(state, 1).current], [left, next]);
  }
  assert.equal(dayStatus(state, 1).done, true);
  assert.deepEqual(state.turn, { round: 1, index: 3, plays: 0, gear: null, level: 0 });
  assert.equal(send(state, 'a', { type: 'pass' }).reason, 'day-over');
  assert.equal(send(state, 'a', { type: 'play', card: 'plain' }).reason, 'day-over');

  const round2 = { ...state, round: 2 };
  assert.deepEqual([dayStatus(round2, 2).current, dayStatus(round2, 2).remaining], ['b', 3]);
  assert.equal(send(round2, 'a', { type: 'pass' }).reason, 'not-your-turn');
  assert.equal(send(round2, 'b', { type: 'pass' }).kind, 'passed');
});

test('the fourth card of a turn hands the turn to the next player', () => {
  let state = tableState({ hands: { a: ['plain', 'plain', 'plain', 'plain', 'plain'] } });
  for (let count = 1; count <= 4; count += 1) {
    assert.equal(dayStatus(state, 1).current, 'a');
    const result = play(state, 'a', 'plain');
    assert.equal(result.kind, 'played');
    state = result.state;
    if (count < 4) assert.deepEqual(state.turn, { round: 1, index: 0, plays: count, gear: null, level: 1 });
  }
  assert.deepEqual(state.turn, { round: 1, index: 1, plays: 0, gear: null, level: 0 });
  assert.equal(dayStatus(state, 1).current, 'b');
  assert.deepEqual(state.hands.a, ['plain']);
  assert.equal(state.seats.a.handCount, 1);
  assert.deepEqual(state.discard, ['plain', 'plain', 'plain', 'plain']);
  assert.equal(play(state, 'a', 'plain').reason, 'not-your-turn');
});

test('a request that breaks the rules is turned down with a reason and only moves the sequence number', () => {
  const state = tableState({
    hands: { a: ['cost', 'response', 'todo', 'hitChosen', 'plain'], b: ['plain'] },
    seats: { a: { pounds: 2 } },
  });
  const cases = [
    ['b', { type: 'play', card: 'plain' }, 'not-your-turn'],
    ['b', { type: 'pass' }, 'not-your-turn'],
    ['a', { type: 'play', card: 'drawTwo' }, 'not-in-hand'],
    ['a', { type: 'play' }, 'not-in-hand'],
    ['a', { type: 'play', card: 'cost' }, 'cannot-afford'],
    ['a', { type: 'play', card: 'response' }, 'response-card'],
    ['a', { type: 'play', card: 'todo' }, 'todo-card'],
    ['a', { type: 'play', card: 'hitChosen' }, 'need-target'],
    ['a', { type: 'play', card: 'hitChosen', target: 'a' }, 'bad-target'],
    ['a', { type: 'play', card: 'hitChosen', target: 'nobody' }, 'bad-target'],
    ['x', { type: 'play', card: 'plain' }, 'not-seated'],
    ['a', { type: 'dance' }, 'bad-request'],
  ];
  for (const [uid, request, reason] of cases) {
    const result = processRequest(state, uid, { seq: 7, ...request }, testData, seededRandom(1));
    assert.deepEqual([result.kind, result.reason], ['rejected', reason], JSON.stringify(request));
    assert.equal(typeof REJECT_REASONS[reason], 'string');
    assert.deepEqual(result.state, { ...state, lastSeq: { [uid]: 7 } }, reason);
  }
  assert.equal(play({ ...state, phase: 'dusk' }, 'a', 'plain').reason, 'not-day');
  assert.equal(send({ ...state, phase: 'sunrise' }, 'a', { type: 'pass' }).reason, 'not-day');
  assert.equal(play(tableState({ hands: { a: ['cost'] }, seats: { a: { influence: 0 } } }), 'a', 'cost').reason, 'cannot-afford', 'influence counts too');
  assert.equal(play(tableState({ hands: { a: ['cost'] }, seats: { a: { pounds: 3, influence: 1 } } }), 'a', 'cost').kind, 'played', 'exactly enough');
  assert.equal(play(tableState({ hands: { a: ['plain'] }, turn: { round: 1, index: 0, plays: 4, level: 1 } }), 'a', 'plain').reason, 'no-plays-left');
  assert.equal(play(tableState({ hands: { a: ['nothing'] } }), 'a', 'nothing').reason, 'unknown-card');
});

test('a request that was already handled is ignored', () => {
  const state = tableState({ hands: { a: ['plain'] }, lastSeq: { a: 3 } });
  for (const seq of [1, 3]) assert.deepEqual(processRequest(state, 'a', { seq, type: 'pass' }, testData), { kind: 'ignored' });
  assert.deepEqual(processRequest(state, 'a', { type: 'pass' }, testData), { kind: 'ignored' });
  assert.deepEqual(processRequest(state, 'a', null, testData), { kind: 'ignored' });
  assert.equal(processRequest(state, 'a', { seq: 4, type: 'pass' }, testData).kind, 'passed');
});

test('effects reach the player, everyone, the others, the chosen player or the holder of a role', () => {
  const base = tableState({ hands: { a: ['cost', 'gainAll', 'hitOthers', 'hitChosen', 'hitRole', 'hitEmptyRole'] } });
  const after = (cardId, extra) => money(play(base, 'a', cardId, extra).state);
  assert.deepEqual(after('cost'), { a: [12, 2], b: [10, 3], c: [10, 3] }, 'self, after paying 3 pounds and 1 influence');
  assert.deepEqual(after('gainAll'), { a: [10, 4], b: [10, 4], c: [10, 4] }, 'all, including the player');
  assert.deepEqual(after('hitOthers'), { a: [10, 3], b: [6, 3], c: [6, 3] }, 'others');
  assert.deepEqual(after('hitChosen', { target: 'c' }), { a: [10, 3], b: [10, 3], c: [0, 3] }, 'chosen, and 10 − 20 stops at 0');
  assert.deepEqual(after('hitRole'), { a: [10, 3], b: [10, 2], c: [10, 3] }, 'the holder of r2');
  assert.deepEqual(after('hitEmptyRole'), { a: [10, 3], b: [10, 3], c: [10, 3] }, 'nobody holds r6');
  const result = play(base, 'a', 'hitChosen', { target: 'c' });
  assert.deepEqual(result.log, { round: 1, by: 'a', card: 'hitChosen', level: 1, target: 'c' });
  assert.equal('target' in play(base, 'a', 'cost', { target: 'c' }).log, false, 'a target is only kept when the card needs one');
});

test('pounds and influence never go below 0', () => {
  const state = tableState({ hands: { a: ['hitOthers', 'hitRole'] }, seats: { b: { pounds: 1, influence: 0 }, c: { pounds: 4 } } });
  const first = play(state, 'a', 'hitOthers').state;
  assert.deepEqual([first.seats.b.pounds, first.seats.c.pounds], [0, 0]);
  assert.equal(play(first, 'a', 'hitRole').state.seats.b.influence, 0);
});

test('drawing takes from the deck and shuffles the discard pile back when it runs out', () => {
  const state = tableState({ hands: { a: ['drawTwo', 'drawTwo'] }, deck: ['x1'], discard: ['y1', 'y2'] });
  const result = play(state, 'a', 'drawTwo').state;
  assert.equal(result.hands.a.length, 3);
  assert.deepEqual(result.hands.a.slice(0, 2), ['drawTwo', 'x1']);
  assert.ok(['y1', 'y2'].includes(result.hands.a[2]));
  assert.equal(result.seats.a.handCount, 3);
  assert.deepEqual(result.discard, ['drawTwo'], 'the played card goes to the discard pile after its effects');
  assert.equal(result.deck.length, 1);
});

test('a random discard takes from the hand, and takes the whole hand when it is short', () => {
  const hand = ['h1', 'h2', 'h3', 'h4'];
  const some = discardRandom(hand, 2, seededRandom(3));
  assert.equal(some.discarded.length, 2);
  assert.deepEqual(sorted([...some.hand, ...some.discarded]), hand);
  assert.deepEqual(hand, ['h1', 'h2', 'h3', 'h4'], 'the input is not changed');
  assert.deepEqual(discardRandom(hand, 2, seededRandom(3)), some, 'the same seed picks the same cards');
  const seen = new Set();
  for (let seed = 0; seed < 40; seed += 1) seen.add(discardRandom(hand, 1, seededRandom(seed)).discarded[0]);
  assert.deepEqual(sorted(seen), hand, 'any card can be picked');
  assert.deepEqual(discardRandom(['h1'], 3, seededRandom(1)), { hand: [], discarded: ['h1'] });
  assert.deepEqual(discardRandom([], 1, seededRandom(1)), { hand: [], discarded: [] });

  const state = tableState({ hands: { a: ['discardChosen'], b: ['b1', 'b2'] } });
  const result = play(state, 'a', 'discardChosen', { target: 'b' }).state;
  assert.deepEqual(result.hands.b, []);
  assert.equal(result.seats.b.handCount, 0);
  assert.deepEqual(sorted(result.discard), ['b1', 'b2', 'discardChosen']);
});

test('chain levels count consecutive cards of the same gear within one turn', () => {
  const levels = (hand) => {
    let state = tableState({ hands: { a: hand, b: ['b1', 'b2'] }, deck: Array(20).fill('plain') });
    return hand.map((cardId) => {
      const result = play(state, 'a', cardId, { chainTarget: 'b' });
      assert.equal(result.kind, 'played', cardId);
      state = result.state;
      return result.log.level;
    });
  };
  assert.deepEqual(levels(['gearA', 'gearA', 'gearA', 'gearA']), [1, 2, 3, 4]);
  assert.deepEqual(levels(['gearA', 'gearB', 'gearA', 'gearA']), [1, 1, 1, 2], 'a different gear breaks the chain');
  assert.deepEqual(levels(['gearA', 'plain', 'gearA', 'plain']), [1, 1, 1, 1], 'a card without a gear breaks the chain');
  assert.deepEqual(levels(['plain', 'plain', 'gearB', 'gearB']), [1, 1, 1, 2], 'cards without a gear do not chain');

  // 換人就重算：a 出了一張 A 後結束這一輪，b 的第一張 A 是 1 級。
  let state = tableState({ hands: { a: ['gearA'], b: ['gearA'] }, deck: Array(5).fill('plain') });
  state = play(state, 'a', 'gearA').state;
  state = send(state, 'a', { type: 'pass' }).state;
  assert.equal(play(state, 'b', 'gearA').log.level, 1);
});

test('the screen can tell the chain level before the card is sent', () => {
  let state = tableState({ hands: { a: ['gearA', 'gearA', 'gearB'] }, deck: Array(5).fill('plain') });
  const gearA = testData.actions.find((action) => action.id === 'gearA');
  const gearB = testData.actions.find((action) => action.id === 'gearB');
  assert.equal(chainLevel(dayStatus(state, 1).turn, gearA), 1);
  state = play(state, 'a', 'gearA').state;
  assert.equal(chainLevel(dayStatus(state, 1).turn, gearA), 2);
  assert.equal(chainLevel(dayStatus(state, 1).turn, gearB), 1);
  assert.equal(play(state, 'a', 'gearA').log.level, 2);
});

// a 連出四張 gearA，看每一張各自帶來的變化（成本 1 英鎊照付；迷霧每張 +5、不加倍）。
test('chain levels 2, 3 and 4 add their bonuses', () => {
  let state = tableState({ hands: { a: ['gearA', 'gearA', 'gearA', 'gearA'], b: ['b1', 'b2'] }, deck: Array(20).fill('plain') });
  const step = (extra = {}) => {
    const before = state;
    const result = play(state, 'a', 'gearA', extra);
    assert.equal(result.kind, 'played', result.reason);
    state = result.state;
    const delta = {};
    for (const uid of ['a', 'b', 'c']) {
      delta[uid] = [
        state.seats[uid].pounds - before.seats[uid].pounds,
        state.seats[uid].influence - before.seats[uid].influence,
        state.hands[uid].length - before.hands[uid].length,
      ];
    }
    return { level: result.log.level, fog: state.fog, delta };
  };
  // 1 級：自己英鎊 −1＋2、影響力 +1−1、手牌 −1＋1；其他人英鎊 −1、影響力 +1。
  assert.deepEqual(step(), { level: 1, fog: 5, delta: { a: [1, 0, 0], b: [-1, 1, 0], c: [-1, 1, 0] } });
  // 2 級：給自己的正數加倍（英鎊 +4、@全體 裡自己那一份 +2），自己的 −1 和對別人的不變。
  assert.deepEqual(step(), { level: 2, fog: 10, delta: { a: [3, 1, 0], b: [-1, 1, 0], c: [-1, 1, 0] } });
  // 3 級：沒有指定棄牌的人就退回；指定 b：照常結算，另外自己抽 2 張、b 隨機棄 1 張。
  assert.equal(play(state, 'a', 'gearA').reason, 'need-chain-target');
  assert.equal(play(state, 'a', 'gearA', { chainTarget: 'a' }).reason, 'bad-chain-target');
  assert.equal(play(state, 'a', 'gearA', { chainTarget: 'nobody' }).reason, 'bad-chain-target');
  const discardBefore = state.discard.length;
  assert.deepEqual(step({ chainTarget: 'b' }), { level: 3, fog: 15, delta: { a: [1, 0, 2], b: [-1, 1, -1], c: [-1, 1, 0] } });
  assert.equal(state.discard.length, discardBefore + 2, 'the card of b and the played card');
  // 4 級：英鎊、影響力、抽牌的數量全部加倍，含對別人的扣減；成本與迷霧不變。出滿 4 張，換 b。
  assert.deepEqual(step(), { level: 4, fog: 20, delta: { a: [3, 0, 1], b: [-2, 2, 0], c: [-2, 2, 0] } });
  assert.equal(dayStatus(state, 1).current, 'b');
});

test('level 4 doubles discards too', () => {
  const doubleDiscard = card('doubleDiscard', { gear: 'D', effects: [{ op: 'discard', target: 'chosen', amount: 1 }] });
  const cards = { ...testData, actions: [...testData.actions, doubleDiscard] };
  let state = tableState({ hands: { a: Array(4).fill('doubleDiscard'), b: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'] }, deck: Array(5).fill('plain') });
  const counts = [];
  for (let count = 0; count < 4; count += 1) {
    const result = send(state, 'a', { type: 'play', card: 'doubleDiscard', target: 'b', chainTarget: 'c' }, seededRandom(count), cards);
    assert.equal(result.kind, 'played', result.reason);
    state = result.state;
    counts.push(state.hands.b.length);
  }
  assert.deepEqual(counts, [5, 4, 3, 1], 'levels 1–3 take one card each, level 4 takes two');
});

test('crime and sabotage cards add a sin to the player, other cards do not', () => {
  let state = tableState({ hands: { a: ['crime', 'trade', 'sabotage', 'plain'] } });
  const sins = [];
  for (const cardId of ['crime', 'trade', 'sabotage', 'plain']) {
    state = play(state, 'a', cardId).state;
    sins.push(state.seats.a.sin ?? 0);
  }
  assert.deepEqual(sins, [1, 1, 2, 2]);
  assert.equal(state.seats.b.sin, undefined);
});

test('fog uses the thresholds in the settings, queues new ones in order, and does not queue them twice', () => {
  let state = tableState({ hands: { a: ['fogUp', 'fogDown', 'fogUp', 'fogUp'] }, fog: 25 });
  const steps = [];
  for (const cardId of ['fogUp', 'fogDown', 'fogUp', 'fogUp']) {
    state = play(state, 'a', cardId).state;
    steps.push([state.fog, state.fogMax, state.fogFired, state.fogPending]);
  }
  assert.deepEqual(steps, [
    [65, 65, [30, 60], [30, 60]],
    [25, 65, [30, 60], [30, 60]],
    [65, 65, [30, 60], [30, 60]],
    [100, 100, [30, 60, 90], [30, 60, 90]],
  ]);
  const custom = { ...testData, settings: { ...testData.settings, fogThresholds: [10, 20] } };
  const result = send(tableState({ hands: { a: ['fogUp'] } }), 'a', { type: 'play', card: 'fogUp' }, seededRandom(1), custom);
  assert.deepEqual([result.state.fog, result.state.fogPending], [40, [10, 20]]);
});

test('accepting a card pays for it and takes it out of the hand; the half-way state is plain data', () => {
  const state = tableState({ hands: { a: ['cost', 'hitChosen'] }, seats: { a: { pounds: 5 } } });
  const accepted = acceptPlay(state, 'a', { seq: 1, type: 'play', card: 'hitChosen', target: 'b' }, testData);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.pending, { by: 'a', seq: 1, card: 'hitChosen', level: 1, target: 'b', chainTarget: null });
  assert.deepEqual(accepted.state.hands.a, ['cost']);
  assert.equal(accepted.state.seats.a.handCount, 1);
  assert.deepEqual(accepted.state.discard, [], 'the card waits in pending, not in the discard pile');
  assert.equal(accepted.state.lastSeq.a, 1);
  assert.equal(accepted.state.turn, undefined, 'the turn moves when the card is resolved');
  assert.deepEqual(money(accepted.state), money(state), 'this card costs nothing');

  const paid = acceptPlay(state, 'a', { seq: 1, type: 'play', card: 'cost' }, testData).state;
  assert.deepEqual([paid.seats.a.pounds, paid.seats.a.influence], [2, 2]);
  assert.deepEqual(acceptPlay(state, 'a', { seq: 1, type: 'play', card: 'todo' }, testData), { ok: false, reason: 'not-in-hand' });

  // 存進資料庫再讀出來（null 會不見）也能接著結算，結果一樣。
  const stored = JSON.parse(JSON.stringify(accepted), (key, value) => (value === null ? undefined : value));
  const direct = resolvePlay(accepted.state, accepted.pending, testData, seededRandom(4));
  assert.deepEqual(resolvePlay(stored.state, stored.pending, testData, seededRandom(4)), direct);
  assert.deepEqual(direct.state.discard, ['hitChosen']);
  assert.equal(direct.state.seats.b.pounds, 0);
  assert.deepEqual(direct.state.turn, { round: 1, index: 0, plays: 1, gear: null, level: 1 });
});

test('passing ends the turn even after some cards, and resets the chain', () => {
  let state = tableState({ hands: { a: ['gearA', 'gearA'] }, deck: Array(5).fill('plain') });
  state = play(state, 'a', 'gearA').state;
  const result = pass(state, 'a', { seq: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.turn, { round: 1, index: 1, plays: 0, gear: null, level: 0 });
  assert.equal(result.state.lastSeq.a, 2);
  assert.deepEqual(pass(result.state, 'a', { seq: 3 }), { ok: false, reason: 'not-your-turn' });
});

test('every play card in the card data can be played and keeps every card accounted for', () => {
  const uids = ['u1', 'u2', 'u3'];
  for (const action of data.actions) {
    const game = startGame(data, uids, { random: seededRandom(5) });
    const [first, second] = seatsInOrder(game.seats).map(([uid]) => uid);
    // 這張牌不在第一位手上就跟牌庫或別人交換一張，牌的總數不變；再給足資源。
    const deck = [...game.deck];
    const hands = Object.fromEntries(Object.entries(game.hands).map(([uid, hand]) => [uid, [...hand]]));
    if (!hands[first].includes(action.id)) {
      const pile = [deck, ...uids.filter((uid) => uid !== first).map((uid) => hands[uid])].find((list) => list.includes(action.id));
      const at = pile.indexOf(action.id);
      [pile[at], hands[first][0]] = [hands[first][0], pile[at]];
    }
    const seats = { ...game.seats, [first]: { ...game.seats[first], pounds: 50, influence: 50 } };
    const state = { ...game, seats, hands, deck, round: 1, phase: 'day', fog: 0, lastSeq: {} };
    const result = processRequest(state, first, { seq: 1, type: 'play', card: action.id, target: second }, data, seededRandom(6));
    if (action.kind === 'response') {
      assert.equal(result.reason, 'response-card', action.id);
      continue;
    }
    assert.equal(result.kind, 'played', `${action.id}: ${result.reason}`);
    assert.equal(needsTarget(action), 'target' in result.log, action.id);
    const cards = [...Object.values(result.state.hands).flat(), ...result.state.deck, ...result.state.discard];
    assert.deepEqual(sorted(cards), sorted(buildDeck(data.actions)), action.id);
    for (const [uid, seat] of Object.entries(result.state.seats)) {
      assert.ok(seat.pounds >= 0 && seat.influence >= 0, action.id);
      assert.equal(seat.handCount, result.state.hands[uid].length, action.id);
    }
  }
});

test('a whole day of random legal plays keeps the table consistent', () => {
  const random = seededRandom(77);
  let state = { ...startGame(data, ['u1', 'u2', 'u3', 'u4'], { random }), round: 1, phase: 'day', fog: 0, lastSeq: {} };
  const byId = new Map(data.actions.map((action) => [action.id, action]));
  let plays = 0;
  while (!dayStatus(state, 1).done) {
    const { current, turn } = dayStatus(state, 1);
    const others = Object.keys(state.seats).filter((uid) => uid !== current);
    const seat = state.seats[current];
    const playable = state.hands[current].find((id) => {
      const action = byId.get(id);
      return action.kind === 'play' && !action.todo && action.cost.pounds <= seat.pounds && action.cost.influence <= seat.influence;
    });
    const request = playable ? { type: 'play', card: playable, target: others[0], chainTarget: others[1] } : { type: 'pass' };
    const result = send(state, current, request, random, data);
    assert.ok(['played', 'passed'].includes(result.kind), `${result.kind} ${result.reason}`);
    if (result.kind === 'played') {
      plays += 1;
      assert.equal(result.log.level, chainLevel(turn, byId.get(playable)));
    }
    state = result.state;
    const cards = [...Object.values(state.hands).flat(), ...state.deck, ...state.discard];
    assert.deepEqual(sorted(cards), sorted(buildDeck(data.actions)));
    for (const [uid, item] of Object.entries(state.seats)) {
      assert.ok(item.pounds >= 0 && item.influence >= 0);
      assert.equal(item.handCount, state.hands[uid].length);
    }
  }
  assert.ok(plays >= 4, `${plays} cards were played`);
});

test('the player screen checks a card with only its own hand, the same way the host does', () => {
  const state = tableState({ hands: { a: ['cost', 'response', 'todo', 'hitChosen', 'gearA', 'plain'], b: ['plain'] }, seats: { a: { pounds: 2 } } });
  const view = ({ hands, deck, discard, lastSeq, ...rest }) => ({ ...rest, hands: { a: hands.a } });
  for (const [cardId, extra, reason] of [
    ['plain', {}, null],
    ['cost', {}, 'cannot-afford'],
    ['response', {}, 'response-card'],
    ['todo', {}, 'todo-card'],
    ['hitChosen', {}, 'need-target'],
    ['hitChosen', { target: 'b' }, null],
    ['drawTwo', {}, 'not-in-hand'],
  ]) {
    assert.equal(playProblem(view(state), 'a', { card: cardId, ...extra }, testData), reason, cardId);
    const result = play(state, 'a', cardId, extra);
    assert.equal(result.kind === 'played' ? null : result.reason, reason, cardId);
  }
  assert.equal(playProblem(view(state), 'b', { card: 'plain' }, testData), 'not-your-turn');
  assert.equal(playProblem({ ...view(state), phase: 'dusk' }, 'a', { card: 'plain' }, testData), 'not-day');
});
