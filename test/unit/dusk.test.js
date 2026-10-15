// 黃昏的純函式：翻法案與牌堆、票的檢查、計票、付出價、法案效果、議會之聲、主持端每一步要做什麼（M6）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DUSK_GRACE_MS,
  DUSK_MAX_REVEAL_SECONDS,
  VOTE_REASONS,
  countVotes,
  drawBill,
  duskSettleAt,
  duskStage,
  duskStep,
  openDusk,
  resolveDusk,
  seededRandom,
  skippedEffects,
  submittedCount,
  voteProblem,
} from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';

const cardDir = new URL('../../play/data/', import.meta.url);
const { data } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));

// 測試用的法案：每張只做一兩件事，結果好算。設定沿用資料檔（揭曉倒數 3 秒、迷霧門檻 30／60／90）。
const bill = (id, onPass = [], onFail = [], fields = {}) => ({ id, name: id, year: null, onPass, onFail, text: id, ...fields });
const testData = {
  settings: data.settings,
  roles: data.roles,
  actions: data.actions,
  bills: [
    bill('plain'),
    bill(
      'tax',
      [
        { op: 'pounds', target: 'role', role: 'r2', amount: -4 },
        { op: 'influence', target: 'role', role: 'r3', amount: 2 },
        { op: 'fog', amount: -3 },
      ],
      [
        { op: 'influence', target: 'role', role: 'r3', amount: -1 },
        { op: 'fog', amount: 3 },
      ],
    ),
    bill('boost', [{ op: 'influence', target: 'all', amount: 2 }], [{ op: 'influence', target: 'all', amount: -1 }]),
    bill('ghost', [{ op: 'influence', target: 'role', role: 'r6', amount: 3 }]),
    bill('foggy', [{ op: 'fog', amount: 40 }]),
    bill('cards', [
      { op: 'draw', target: 'all', amount: 1 },
      { op: 'discard', target: 'role', role: 'r1', amount: 1 },
    ]),
    bill('aimed', [
      { op: 'pounds', target: 'chosen', amount: -2 },
      { op: 'pounds', target: 'all', amount: 1 },
    ]),
    bill('broken', [], [{ op: 'pounds', target: 'all', amount: 5 }], { todo: true, todoText: '偷看一張手牌' }),
  ],
};
const OPENED_AT = 100_000; // 黃昏打開的伺服器時間（毫秒）
const SECONDS = testData.settings.duskRevealSeconds;

// 第 1 桌三人：a（座位 0、r1）、b（座位 1、r2）、c（座位 2、r3），英鎊 10、影響力 3；第 1 回合黃昏，法案已翻開、投票中。
function duskState({ seats = {}, dusk = {}, ...rest } = {}) {
  const allSeats = {};
  ['a', 'b', 'c'].forEach((uid, order) => {
    allSeats[uid] = { order, role: `r${order + 1}`, pounds: 10, influence: 3, handCount: 2, ...seats[uid] };
  });
  return {
    table: 1,
    round: 1,
    phase: 'dusk',
    fog: 0,
    hands: { a: ['h1', 'h2'], b: ['h3', 'h4'], c: ['h5', 'h6'] },
    deck: ['d1', 'd2', 'd3', 'd4'],
    discard: [],
    bills: {},
    billDeck: [],
    ...rest,
    seats: allSeats,
    dusk: { round: 1, bill: 'plain', openedAt: OPENED_AT, submitted: 0, ...dusk },
  };
}

// 一張票：預設是第 1 桌第 1 回合、伺服器在黃昏打開 1 秒後收到。
const vote = (side, bid = 0, extra = {}) => ({ table: '1', round: 1, side, bid, seq: 1, at: OPENED_AT + 1000, ...extra });
const reveal = (state, votes, cardData = testData) => resolveDusk(state, votes, cardData, seededRandom(1));
const influence = (state) => Object.fromEntries(Object.entries(state.seats).map(([uid, seat]) => [uid, seat.influence]));
const sorted = (list) => [...list].sort();

test('more yes than no passes; a tie, everyone abstaining and nobody voting all fail', () => {
  let { result } = reveal(duskState(), { a: vote('yes', 2), b: vote('no', 1), c: vote('abstain') });
  assert.deepEqual(result, {
    yes: 2,
    no: 1,
    passed: true,
    votes: { a: { side: 'yes', bid: 2 }, b: { side: 'no', bid: 1 }, c: { side: 'abstain', bid: 0 } },
  });
  ({ result } = reveal(duskState(), { a: vote('yes', 2), b: vote('no', 2) }));
  assert.deepEqual([result.yes, result.no, result.passed], [2, 2, false], 'a tie does not pass');
  ({ result } = reveal(duskState(), { a: vote('abstain'), b: vote('abstain'), c: vote('abstain') }));
  assert.deepEqual([result.yes, result.no, result.passed], [0, 0, false], 'everyone abstaining is 0 to 0');
  ({ result } = reveal(duskState(), {}));
  assert.deepEqual(result, { yes: 0, no: 0, passed: false, votes: {} }, 'nobody voting is 0 to 0 too');
  ({ result } = reveal(duskState(), { a: vote('yes', 0), b: vote('no', 0) }));
  assert.equal(result.passed, false, 'taking a side with 0 is still 0 to 0');
});

test('everyone who takes a side pays the bid, win or lose; abstaining pays nothing', () => {
  const { state } = reveal(duskState(), { a: vote('yes', 2), b: vote('no', 3), c: vote('abstain') });
  assert.equal(state.dusk.result.passed, false);
  assert.deepEqual(influence(state), { a: 1, b: 0, c: 3 });
  assert.deepEqual(
    Object.fromEntries(Object.entries(state.seats).map(([uid, seat]) => [uid, seat.pounds])),
    { a: 10, b: 10, c: 10 },
    'plain has no effect',
  );
});

test('a bid larger than the influence left is paid down to 0, and still counts in full', () => {
  // a 投票時有 3 影響力，揭曉前少到 1（例如黃昏時才結算的響應卡）。
  const { state, result } = reveal(duskState({ seats: { a: { influence: 1 } } }), { a: vote('yes', 3), b: vote('no', 2) });
  assert.deepEqual([result.yes, result.no, result.passed], [3, 2, true]);
  assert.deepEqual(influence(state), { a: 0, b: 1, c: 3 });
});

test('the bid is paid before the bill takes effect: the clamp at 0 shows the order', () => {
  // boost 通過：全體影響力 +2。a 只剩 1、出價 3：先付（夾到 0）再 +2＝2；若先套效果是 1＋2＝3、再付 3＝0。
  const state = duskState({ seats: { a: { influence: 1 } }, dusk: { bill: 'boost' } });
  const { state: after, result } = reveal(state, { a: vote('yes', 3) });
  assert.equal(result.passed, true);
  assert.deepEqual(influence(after), { a: 2, b: 5, c: 5 });
  // 不通過：全體 −1。b 出價 2（反對）：3−2＝1，再 −1＝0；a 沒送出、只受效果：3−1＝2。
  const failed = reveal(duskState({ dusk: { bill: 'boost' } }), { b: vote('no', 2) });
  assert.deepEqual(influence(failed.state), { a: 2, b: 0, c: 2 });
});

test('bill effects: a role (nobody in it means nobody is hit), everyone, and fog into fogPending', () => {
  let { state } = reveal(duskState({ dusk: { bill: 'tax' } }), { a: vote('yes', 1) });
  assert.equal(state.dusk.result.passed, true);
  assert.deepEqual([state.seats.b.pounds, state.seats.c.influence, state.seats.a.pounds], [6, 5, 10], 'r2 pays 4, r3 gets 2');
  assert.equal(state.fog, 0, 'fog −3 from 0 stays at 0');
  ({ state } = reveal(duskState({ fog: 28, dusk: { bill: 'tax' } }), { a: vote('no', 1) }));
  assert.equal(state.dusk.result.passed, false);
  assert.deepEqual([state.seats.c.influence, state.fog], [2, 31], 'onFail: r3 loses 1, fog +3');
  assert.deepEqual([state.fogPending, state.fogFired, state.fogMax], [[30], [30], 31], 'crossing 30 waits in fogPending for M7');
  ({ state } = reveal(duskState({ dusk: { bill: 'ghost' } }), { a: vote('yes', 1) }));
  assert.deepEqual(influence(state), { a: 2, b: 3, c: 3 }, 'nobody sits in r6: only the bid is paid');
  ({ state } = reveal(duskState({ fog: 5, dusk: { bill: 'foggy' } }), { c: vote('yes', 1) }));
  assert.deepEqual([state.fog, state.fogPending, state.fogFired, state.fogMax], [45, [30], [30], 45]);
});

test('bill effects that draw or discard change hands, the deck, the discard pile and the hand counts', () => {
  const { state } = reveal(duskState({ dusk: { bill: 'cards' } }), { a: vote('yes', 1) });
  assert.deepEqual([state.hands.a.length, state.hands.b, state.hands.c], [2, ['h3', 'h4', 'd2'], ['h5', 'h6', 'd3']], 'everyone draws 1; r1 then discards 1 at random');
  assert.deepEqual(state.deck, ['d4']);
  assert.equal(state.discard.length, 1);
  assert.deepEqual(sorted([...state.hands.a, ...state.discard]), ['d1', 'h1', 'h2']);
  assert.deepEqual([state.seats.a.handCount, state.seats.b.handCount, state.seats.c.handCount], [2, 3, 3]);
});

test('@chosen bill effects are skipped this version, and a todo bill settles none of its effects', () => {
  const aimed = testData.bills.find((record) => record.id === 'aimed');
  assert.deepEqual(skippedEffects(aimed, true), [aimed.onPass[0]]);
  assert.deepEqual(skippedEffects(aimed, false), []);
  let { state } = reveal(duskState({ dusk: { bill: 'aimed' } }), { a: vote('yes', 1) });
  assert.deepEqual(
    Object.values(state.seats).map((seat) => seat.pounds),
    [11, 11, 11],
    'only the @all part is settled',
  );
  const broken = testData.bills.find((record) => record.id === 'broken');
  assert.deepEqual(skippedEffects(broken, false), broken.onFail);
  ({ state } = reveal(duskState({ dusk: { bill: 'broken' } }), { a: vote('no', 1) }));
  assert.equal(state.dusk.result.passed, false);
  assert.deepEqual(
    Object.values(state.seats).map((seat) => [seat.pounds, seat.influence]),
    [
      [10, 2],
      [10, 3],
      [10, 3],
    ],
    'the bid is paid, the todo bill does nothing',
  );
  assert.equal(state.bills.broken, 'failed', 'the result is still recorded');
});

test('the voice of parliament: aligned +1 only for the side that matches the result; abstaining never counts', () => {
  let { state } = reveal(duskState({ seats: { a: { aligned: 2 } } }), { a: vote('yes', 2), b: vote('no', 1), c: vote('abstain') });
  assert.deepEqual([state.seats.a.aligned, state.seats.b.aligned, state.seats.c.aligned], [3, undefined, undefined]);
  ({ state } = reveal(duskState(), { a: vote('yes', 1), b: vote('no', 1), c: vote('no', 0) }));
  assert.equal(state.dusk.result.passed, false);
  assert.deepEqual([state.seats.a.aligned, state.seats.b.aligned, state.seats.c.aligned], [undefined, 1, 1], 'no with a 0 bid still took a side');
  ({ state } = reveal(duskState(), { a: vote('yes', 1), b: vote('no', 2), c: vote('abstain') }));
  assert.equal(state.dusk.result.passed, false);
  assert.deepEqual([state.seats.a.aligned, state.seats.b.aligned, state.seats.c.aligned], [undefined, 1, undefined], 'abstaining is not on the side of a failed bill either');
});

test('the reveal records the bill result, the public log and the result on the dusk', () => {
  const { state, result, log } = reveal(duskState({ bills: { tax: 'failed' }, dusk: { bill: 'tax', revealAt: OPENED_AT + 5000 } }), { a: vote('yes', 2) });
  assert.deepEqual(state.bills, { tax: 'passed' }, 'the last result of each bill');
  assert.deepEqual(log, { bill: 'tax', yes: 2, no: 0, passed: true, votes: { a: { side: 'yes', bid: 2 } } });
  assert.deepEqual(state.dusk, { round: 1, bill: 'tax', openedAt: OPENED_AT, submitted: 0, revealAt: OPENED_AT + 5000, result });
  assert.throws(() => reveal(state, {}), /沒有在等揭曉的法案/, 'a bill is revealed once');
});

test('drawing bills: the top of the pile; an empty pile reshuffles the bills that have not passed; all passed adjourns', () => {
  const three = { ...testData, bills: [bill('x'), bill('y'), bill('z')] };
  assert.deepEqual(drawBill({ billDeck: ['y', 'z'], bills: {} }, three), { bill: 'y', billDeck: ['z'] });
  assert.deepEqual(drawBill({ billDeck: ['gone', 'z'], bills: {} }, three), { bill: 'z', billDeck: [] }, 'ids no longer in the data are skipped');
  const first = drawBill({ billDeck: [], bills: {} }, three, seededRandom(5));
  assert.deepEqual(sorted([first.bill, ...first.billDeck]), ['x', 'y', 'z'], 'the first dusk shuffles every bill into a pile');
  const again = drawBill({ billDeck: [], bills: { x: 'passed', y: 'failed' } }, three, seededRandom(5));
  assert.deepEqual(sorted([again.bill, ...again.billDeck]), ['y', 'z'], 'failed and undecided bills go back, passed ones stay out');
  assert.deepEqual(drawBill({ billDeck: [], bills: { x: 'passed', y: 'passed', z: 'passed' } }, three), { bill: null, billDeck: [] });
  const order = Array.from({ length: 20 }, (_, index) => drawBill({ billDeck: [], bills: {} }, three, seededRandom(index)).bill);
  assert.deepEqual(sorted(new Set(order)), ['x', 'y', 'z'], 'the reshuffle is random');

  const table = { ...duskState({ billDeck: ['y', 'z'] }), dusk: null };
  assert.deepEqual(openDusk(table, three), { dusk: { round: 1, bill: 'y', submitted: 0 }, billDeck: ['z'] });
  const adjourned = openDusk({ ...table, billDeck: [], bills: { x: 'passed', y: 'passed', z: 'passed' } }, three);
  assert.deepEqual(adjourned, { dusk: { round: 1, bill: null, submitted: 0 }, billDeck: [] }, 'parliament adjourns');
  assert.throws(() => openDusk({ ...table, seats: {} }, three), /沒有人入座/);
});

test('where the dusk is: none, adjourned, voting, closing, revealed', () => {
  assert.equal(duskStage(null, 1), 'none');
  assert.equal(duskStage({ round: 1, bill: 'tax' }, 2), 'none', 'a dusk from an earlier round');
  assert.equal(duskStage({ round: 2, submitted: 0 }, 2), 'adjourned');
  assert.equal(duskStage({ round: 2, bill: 'tax' }, 2), 'voting');
  assert.equal(duskStage({ round: 2, bill: 'tax', revealAt: 5 }, 2), 'closing');
  assert.equal(duskStage({ round: 2, bill: 'tax', revealAt: 5, result: { yes: 0, no: 0, passed: false } }, 2), 'revealed');
  assert.equal(DUSK_GRACE_MS, 1000);
  assert.equal(duskSettleAt({ revealAt: 5000 }), 6000);
  assert.equal(SECONDS, 3, 'the data files say 3 seconds');
});

test('every reason a vote is turned down', () => {
  const state = duskState({ dusk: { revealAt: OPENED_AT + 5000 } });
  const cases = [
    [{ ...state, phase: 'night' }, 'a', vote('yes', 1), 'not-dusk'],
    [{ ...state, dusk: null }, 'a', vote('yes', 1), 'not-open'],
    [{ ...state, dusk: { ...state.dusk, round: 0 } }, 'a', vote('yes', 1), 'not-open'],
    [{ ...state, dusk: { round: 1, openedAt: OPENED_AT, submitted: 0 } }, 'a', vote('yes', 1), 'adjourned'],
    [{ ...state, dusk: { ...state.dusk, result: { yes: 0, no: 0, passed: false } } }, 'a', vote('yes', 1), 'revealed'],
    [state, 'nobody', vote('yes', 1), 'not-seated'],
    [state, 'a', null, 'bad-vote'],
    [state, 'a', vote('yes', 1, { table: '2' }), 'wrong-table'],
    [state, 'a', vote('yes', 1, { round: 2 }), 'wrong-round'],
    [state, 'a', vote('yes', 1, { at: OPENED_AT + 5001 }), 'too-late'],
    [state, 'a', vote('yes', 1, { at: undefined }), 'too-late'],
    [state, 'a', vote('maybe', 1), 'bad-side'],
    [state, 'a', vote('yes', -1), 'bad-bid'],
    [state, 'a', vote('yes', 1.5), 'bad-bid'],
    [state, 'a', vote('yes', '2'), 'bad-bid'],
    [state, 'a', vote('abstain', 1), 'abstain-bid'],
    [state, 'a', vote('no', 4), 'over-bid'],
  ];
  for (const [table, uid, ballot, reason] of cases) {
    assert.equal(voteProblem(table, uid, ballot), reason, reason);
    assert.ok(VOTE_REASONS[reason], `${reason} has a text`);
  }
  assert.equal(voteProblem(state, 'a', vote('no', 3, { at: OPENED_AT + 5000 })), null, 'up to the influence, right at the deadline');
  assert.equal(voteProblem(state, 'a', vote('abstain', 0, { table: 1 })), null, 'the table may be a number or a string');
  assert.equal(voteProblem(duskState(), 'a', vote('yes', 1, { at: undefined })), null, 'no deadline yet: any time counts');
});

test('counting: only seated players, this table and round, before the deadline; nobody else counts', () => {
  const state = duskState({ dusk: { revealAt: OPENED_AT + 5000 } });
  const votes = {
    a: vote('yes', 2),
    b: vote('no', 1, { at: OPENED_AT + 5001 }),
    c: vote('yes', 3, { round: 0 }),
    outsider: vote('yes', 3),
  };
  assert.deepEqual(countVotes(state, votes), { a: { side: 'yes', bid: 2 } });
  assert.equal(submittedCount(state, votes), 1);
  assert.deepEqual(countVotes(state, { a: vote('yes', 2, { table: '3' }), b: vote('abstain', 1) }), {}, 'another table; a bad abstain');
  // 揭曉時不查影響力：寫入時規則已經查過，之後少了只會夾 0。
  assert.deepEqual(countVotes(duskState({ seats: { a: { influence: 0 } } }), { a: vote('yes', 3) }), { a: { side: 'yes', bid: 3 } });
  // 同一回合的黑夜也照樣算（截止時間已定、票已經不能改）。
  assert.deepEqual(countVotes({ ...state, phase: 'night' }, { a: vote('no', 1) }), { a: { side: 'no', bid: 1 } });
});

test('counting only takes votes cast after the bill was turned over', () => {
  const state = duskState({ dusk: { revealAt: OPENED_AT + 5000 } });
  const votes = { a: vote('yes', 3, { at: OPENED_AT - 1 }), b: vote('no', 1, { at: OPENED_AT }), c: vote('yes', 1, { at: undefined }) };
  assert.deepEqual(countVotes(state, votes), { b: { side: 'no', bid: 1 } }, 'an old time (or none) is not a vote for this bill');
  assert.equal(VOTE_REASONS['too-early'].length > 0, true);
  assert.equal(voteProblem(state, 'a', vote('yes', 3, { at: OPENED_AT - 1 })), null, 'the screen check does not need it');
});

test('the countdown is never longer than 60 seconds, the most the rules accept', () => {
  const long = { ...testData, settings: { ...testData.settings, duskRevealSeconds: 90 } };
  const everyone = { a: vote('yes', 1), b: vote('no', 1), c: vote('abstain') };
  const now = OPENED_AT + 2000;
  assert.equal(DUSK_MAX_REVEAL_SECONDS, 60);
  assert.equal(duskStep(duskState(), everyone, long, { now }).revealAt, now + 60_000);
  assert.equal(duskStep(duskState(), everyone, testData, { now }).revealAt, now + SECONDS * 1000);
});

test('a bill missing from the card data is still revealed: votes counted, bids paid, no effects', () => {
  const { state, result, log } = reveal(duskState({ dusk: { bill: 'gone', revealAt: OPENED_AT + 5000 } }), { a: vote('yes', 2), b: vote('no', 1) });
  assert.deepEqual([result.yes, result.no, result.passed], [2, 1, true]);
  assert.deepEqual(influence(state), { a: 1, b: 2, c: 3 });
  assert.deepEqual([state.bills, log.bill, state.seats.a.aligned], [{ gone: 'passed' }, 'gone', 1]);
  assert.deepEqual(skippedEffects(null, true), []);
});

test('an early reveal counts whoever has not voted as abstaining', () => {
  const state = duskState({ dusk: { bill: 'boost', revealAt: OPENED_AT + 1500 } });
  const { state: after, result } = reveal(state, { a: vote('yes', 1), b: vote('no', 2, { at: OPENED_AT + 1600 }) });
  assert.deepEqual(result, { yes: 1, no: 0, passed: true, votes: { a: { side: 'yes', bid: 1 } } }, 'b voted after the deadline, c never voted');
  assert.deepEqual(influence(after), { a: 4, b: 5, c: 5 }, 'only a pays; everyone gets the +2');
  assert.deepEqual([after.seats.a.aligned, after.seats.b.aligned, after.seats.c.aligned], [1, undefined, undefined]);
});

test('each host step: open, count, start the countdown, wait, reveal; nothing to do otherwise', () => {
  const step = (state, votes = {}, now = OPENED_AT + 2000) => duskStep(state, votes, testData, { now, random: seededRandom(2) });
  const opening = step({ ...duskState({ billDeck: ['tax'] }), dusk: null });
  assert.deepEqual(opening, { kind: 'opened', dusk: { round: 1, bill: 'tax', submitted: 0 }, billDeck: [] });
  assert.deepEqual(step({ ...duskState(), dusk: { round: 0, bill: 'tax' } }).kind, 'opened', 'last round’s dusk does not count');
  assert.deepEqual(step({ ...duskState(), phase: 'day', dusk: null }), { kind: 'none' }, 'only at dusk');
  assert.deepEqual(step({ ...duskState(), seats: {} }), { kind: 'none' }, 'a table without seats');
  assert.deepEqual(step(duskState({ dusk: { bill: null } })), { kind: 'none' }, 'adjourned');

  const voting = duskState();
  assert.deepEqual(step(voting), { kind: 'waiting' });
  assert.deepEqual(step(voting, { a: vote('yes', 1) }), { kind: 'counted', submitted: 1, revealAt: null });
  assert.deepEqual(step(duskState({ dusk: { submitted: 1 } }), { a: vote('no', 1) }), { kind: 'waiting' }, 'a changed vote is not a new one');
  const everyone = { a: vote('yes', 1), b: vote('no', 1), c: vote('abstain') };
  assert.deepEqual(step(duskState({ dusk: { submitted: 2 } }), everyone, 50_000 + OPENED_AT), {
    kind: 'counted',
    submitted: 3,
    revealAt: 50_000 + OPENED_AT + SECONDS * 1000,
  });
  assert.deepEqual(step(duskState({ dusk: { submitted: 3 } }), everyone).revealAt, OPENED_AT + 2000 + SECONDS * 1000, 'the count was written, the deadline was not');

  const closing = duskState({ dusk: { submitted: 3, revealAt: OPENED_AT + 5000 } });
  assert.deepEqual(step(closing, everyone, OPENED_AT + 5000), { kind: 'waiting' }, 'the deadline itself');
  assert.deepEqual(step(closing, everyone, OPENED_AT + 5000 + DUSK_GRACE_MS - 1), { kind: 'waiting' }, 'inside the grace');
  const revealed = step(closing, everyone, OPENED_AT + 5000 + DUSK_GRACE_MS);
  assert.equal(revealed.kind, 'revealed');
  assert.deepEqual(revealed.result, { yes: 1, no: 1, passed: false, votes: { a: { side: 'yes', bid: 1 }, b: { side: 'no', bid: 1 }, c: { side: 'abstain', bid: 0 } } });
  assert.deepEqual(step(revealed.state, everyone, OPENED_AT + 9000), { kind: 'none' }, 'revealed once');
  assert.equal(step({ ...closing, phase: 'night' }, everyone, OPENED_AT + 7000).kind, 'revealed', 'the reveal still happens at night of the same round');
  assert.deepEqual(step({ ...voting, phase: 'night' }, everyone), { kind: 'waiting' }, 'no counting at night');
  const early = duskState({ dusk: { submitted: 1, revealAt: OPENED_AT + 1500 } });
  assert.deepEqual(step(early, { a: vote('yes', 1) }, OPENED_AT + 2000), { kind: 'waiting' }, 'after an early close nothing new is counted');
});

test('a dusk saved to the database and read back (nulls dropped) gives the same results', () => {
  // 資料庫不存 null 與空的陣列、物件：每一步之間把局面存成 JSON、拿掉這些再讀回來。
  const stored = (value) =>
    JSON.parse(JSON.stringify(value), (key, item) => {
      if (item === null) return undefined;
      if (Array.isArray(item) && item.length === 0) return undefined;
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) return undefined;
      return item;
    }) ?? {};
  const everyone = { a: vote('yes', 2), b: vote('no', 1), c: vote('abstain') };
  const run = (save) => {
    let state = { ...duskState({ fog: 28, billDeck: ['tax', 'boost'], bills: {} }), dusk: null };
    const opened = duskStep(save(state), {}, testData, { now: OPENED_AT, random: seededRandom(3) });
    state = { ...state, dusk: { ...opened.dusk, openedAt: OPENED_AT }, billDeck: opened.billDeck };
    const counted = duskStep(save(state), everyone, testData, { now: OPENED_AT + 1000, random: seededRandom(3) });
    state = { ...state, dusk: { ...state.dusk, submitted: counted.submitted, revealAt: counted.revealAt } };
    const revealed = duskStep(save(state), everyone, testData, { now: counted.revealAt + DUSK_GRACE_MS, random: seededRandom(3) });
    return { opened, counted, revealed: { ...revealed, state: stored(revealed.state) } };
  };
  const direct = run((state) => state);
  const saved = run(stored);
  assert.deepEqual(saved, direct);
  assert.deepEqual([direct.opened.dusk.bill, direct.counted.submitted, direct.revealed.result.passed], ['tax', 3, true]);
  assert.deepEqual(direct.revealed.state.fogPending, undefined, 'tax passing lowers the fog');
});
