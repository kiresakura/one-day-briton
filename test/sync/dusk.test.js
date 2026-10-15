// 黃昏的同步與權限測試：票的讀寫權限、規則、開黃昏與法案牌堆、全員送出後倒數揭曉、提前揭曉、兩台主持端、斷線（npm run test:sync）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get, goOffline, goOnline, ref, serverTimestamp, set, update } from 'firebase/database';
import { DUSK_GRACE_MS, duskSettleAt, seatsInOrder, seededRandom } from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';
import {
  advanceTable,
  approveHost,
  connect,
  createRoom,
  disconnect,
  enterAsHost,
  joinRoom,
  processSunrise,
  requestVote,
  revealDusk,
  serverTime,
  settleDusk,
  startSettling,
  startTable,
  watchRoom,
  watchVote,
} from '../../play/js/store.js';

const TIMEOUT = { timeout: 30_000 };
const denied = /permission[_ ]denied/i;
const refused = { name: 'StoreError', code: 'permission-denied' }; // store.js 把規則的拒絕包成 StoreError
const cardDir = new URL('../../play/data/', import.meta.url);
const { data: fileData, errors } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
// 這裡測的是 M4–M6 的流程與數字，日出不翻一般事件（sunriseEvents 0）；事件在 event.test.js。
const data = { ...fileData, settings: { ...fileData.settings, sunriseEvents: 0 } };
assert.deepEqual(errors, []);
assert.equal(data.settings.duskRevealSeconds, 3);
// 測倒數的地方把揭曉倒數改成 1 秒（只改這份資料物件，不改資料檔）。
const quick = { ...data, settings: { ...data.settings, duskRevealSeconds: 1 } };
const billOf = (id) => data.bills.find((bill) => bill.id === id);

// 這裡用到的法案（資料檔第二版）：b01 通過：r2 英鎊 −4、r3 影響力 +2、迷霧 −3；不通過：r3 影響力 −1、迷霧 +3。
// b04 通過：r1 影響力 +2、r2 英鎊 +2；不通過：全體英鎊 −2。
assert.deepEqual(billOf('b01').onPass, [
  { op: 'pounds', target: 'role', role: 'r2', amount: -4 },
  { op: 'influence', target: 'role', role: 'r3', amount: 2 },
  { op: 'fog', amount: -3 },
]);
assert.deepEqual(billOf('b01').onFail, [
  { op: 'influence', target: 'role', role: 'r3', amount: -1 },
  { op: 'fog', amount: 3 },
]);
assert.deepEqual(billOf('b04').onFail, [{ op: 'pounds', target: 'all', amount: -2 }]);

let host;
let backup;
let p1;
let p2;
let p3;
let outsider;

before(async () => {
  [host, backup, p1, p2, p3, outsider] = await Promise.all(['host', 'backup', 'p1', 'p2', 'p3', 'outsider'].map((slot) => connect(slot)));
});

after(async () => {
  await Promise.all([host, backup, p1, p2, p3, outsider].filter(Boolean).map(disconnect));
});

// 訂閱並記住最新狀態；until() 等到條件成立，逾時就失敗。
function watch(session, code, subscribe = watchRoom) {
  let latest;
  const waiters = new Set();
  const stop = subscribe(session, code, (value) => {
    latest = value;
    for (const check of [...waiters]) check();
  });
  return {
    stop,
    get value() {
      return latest;
    },
    until(predicate, label, ms = 5000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (latest === undefined || !predicate(latest)) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(latest);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out waiting for: ${label}`));
        }, ms);
        waiters.add(check);
        check();
      });
    },
  };
}

const read = async (session, path) => (await get(ref(session.db, path))).val();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 等到伺服器時間（session 估計的）到了 at。
async function untilServerTime(session, at) {
  for (let left = at - serverTime(session); left > 0; left = at - serverTime(session)) await sleep(Math.min(left + 5, 250));
}

// 開一間新房，p1、p2、p3 在第 2 桌、outsider 在第 3 桌；第 2 桌開局並推進到第 1 回合白晝。first、second、third 照座位排，
// 階層改成 r1、r2、r3（開局是隨機的），法案牌堆放 billDeck。回傳 { code, watchers, first, second, third }。
async function dayRoom(t, billDeck = ['b01', 'b04']) {
  const code = await createRoom(host);
  await joinRoom(p1, code, 'P1', 2);
  await joinRoom(p2, code, 'P2', 2);
  await joinRoom(p3, code, 'P3', 2);
  await joinRoom(outsider, code, 'Outsider', 3);
  const names = ['host', 'p1', 'p2', 'p3', 'outsider'];
  const watchers = Object.fromEntries([host, p1, p2, p3, outsider].map((session, index) => [names[index], watch(session, code)]));
  t.after(() => Object.values(watchers).forEach((watcher) => watcher.stop()));
  await watchers.host.until((room) => Object.keys(room.players ?? {}).length === 4, 'host sees four players');
  assert.deepEqual(await startTable(host, code, 2, data, seededRandom(1)), { started: true });
  await advanceTable(host, code, 2, { round: 1, phase: 'sunrise' });
  const game = await read(host, `rooms/${code}/games/2`);
  const [first, second, third] = seatsInOrder(game.seats).map(([uid]) => [p1, p2, p3].find((session) => session.uid === uid));
  const writes = { [`rooms/${code}/games/2/version`]: game.version + 1, [`hostOnly/${code}/2/billDeck`]: billDeck };
  [first, second, third].forEach((session, index) => (writes[`rooms/${code}/games/2/seats/${session.uid}/role`] = `r${index + 1}`));
  await update(ref(host.db), writes);
  return { code, watchers, first, second, third };
}

// 推進到黃昏，主持端翻開法案。
async function duskRoom(t, billDeck, cardData = data) {
  const room = await dayRoom(t, billDeck);
  await advanceTable(host, room.code, 2, { round: 1, phase: 'day' });
  assert.equal((await settleDusk(host, room.code, 2, cardData)).outcome, 'opened');
  return room;
}

const vote = (session, code, side, bid = 0, round = 1) => requestVote(session, code, { table: 2, round, side, bid });

// 主持端讀出第 2 桌的全部狀態。
async function readTable(code) {
  const [table, game, votes, pile] = await Promise.all([
    read(host, `rooms/${code}/tables/2`),
    read(host, `rooms/${code}/games/2`),
    read(host, `votes/${code}`),
    read(host, `hostOnly/${code}/2`),
  ]);
  return { table, game, votes: votes ?? {}, pile: pile ?? {} };
}

const stats = (game, key) => Object.fromEntries(Object.entries(game.seats).map(([uid, seat]) => [uid, seat[key]]));

test('a dusk opens with the top bill of the pile; before the reveal a player reads only their own vote, the host reads them all', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await dayRoom(t);
  await advanceTable(host, code, 2, { round: 1, phase: 'day' });
  const sentAt = serverTime(host);
  assert.deepEqual(await settleDusk(host, code, 2, data), { outcome: 'opened', result: null });
  const opened = await readTable(code);
  const { dusk } = opened.game;
  assert.deepEqual({ ...dusk, openedAt: typeof dusk.openedAt }, { round: 1, bill: 'b01', openedAt: 'number', submitted: 0 });
  assert.ok(dusk.openedAt >= sentAt - 1000 && dusk.openedAt <= serverTime(host) + 1000, 'openedAt is the server time');
  assert.deepEqual(opened.pile.billDeck, ['b04'], 'the rest of the pile stays with the hosts');
  assert.deepEqual(await settleDusk(host, code, 2, data), { outcome: 'waiting', result: null }, 'opened once');
  assert.deepEqual(await settleDusk(host, code, 3, data), { outcome: 'none', result: null }, 'a table nobody sits at has no dusk');
  await assert.rejects(get(ref(p1.db, `hostOnly/${code}/2/billDeck`)), denied, 'players cannot see the pile');

  assert.equal(await vote(first, code, 'yes', 2), 1);
  assert.equal(await vote(second, code, 'no', 1), 1);
  const mine = watch(first, code, watchVote);
  t.after(() => mine.stop());
  const own = await mine.until((value) => value?.seq === 1, 'first watches the own vote');
  assert.deepEqual({ ...own, at: typeof own.at }, { table: '2', round: 1, side: 'yes', bid: 2, seq: 1, at: 'number' });
  for (const [session, path] of [
    [first, `votes/${code}/${second.uid}`],
    [first, `votes/${code}`],
    [third, `votes/${code}/${first.uid}`],
    [outsider, `votes/${code}/${first.uid}`],
    [outsider, `votes/${code}`],
  ]) {
    await assert.rejects(get(ref(session.db, path)), denied, path);
  }
  assert.equal((await read(second, `votes/${code}/${second.uid}`)).side, 'no');
  const all = await read(host, `votes/${code}`);
  assert.deepEqual(Object.keys(all).sort(), [first.uid, second.uid].sort(), 'the host reads the whole room');

  assert.deepEqual(await settleDusk(host, code, 2, data), { outcome: 'counted', result: null });
  const seen = await watchers.p3.until((room) => room.games[2].dusk.submitted === 2, 'third sees two votes sent');
  assert.doesNotMatch(JSON.stringify(seen), /"side"|"bid"|"yes"|"no"/, 'the public tree has only the number of votes before the reveal');
  assert.equal(seen.games[2].dusk.revealAt, undefined, 'not everyone has voted');
});

test('the rules turn down bad votes: over the influence, an abstain with a bid, a made-up time, an old seq, no seat, not at dusk, after the reveal', TIMEOUT, async (t) => {
  const { code, first, second, third } = await dayRoom(t);
  const mine = (session) => ref(session.db, `votes/${code}/${session.uid}`);
  const ballot = (fields = {}) => ({ table: '2', round: 1, side: 'yes', bid: 1, seq: 1, at: serverTimestamp(), ...fields });
  await assert.rejects(set(mine(first), ballot()), denied, 'not at dusk yet');
  await advanceTable(host, code, 2, { round: 1, phase: 'day' });
  await assert.rejects(set(mine(first), ballot()), denied, 'dusk, but no bill turned over yet');
  assert.equal((await settleDusk(host, code, 2, data)).outcome, 'opened');

  const badVotes = [
    [ballot({ bid: 4 }), 'more than the 3 influence'],
    [ballot({ side: 'abstain', bid: 1 }), 'an abstain with a bid'],
    [ballot({ at: Date.now() - 5000 }), 'a time earlier than the server time'],
    [ballot({ at: Date.now() + 5000 }), 'a time later than the server time'],
    [ballot({ side: 'maybe' }), 'not a side'],
    [ballot({ bid: 1.5 }), 'a fraction'],
    [ballot({ bid: -1 }), 'a negative bid'],
    [ballot({ bid: '1' }), 'a bid as text'],
    [ballot({ table: 2 }), 'the table is text'],
    [ballot({ table: '3' }), 'a table without a game'],
    [ballot({ round: 2 }), 'another round'],
    [ballot({ seq: 0 }), 'seq starts at 1'],
    [ballot({ extra: 1 }), 'no other fields'],
    [{ table: '2', round: 1, side: 'yes', bid: 1, seq: 1 }, 'no time'],
    [{ table: '2', round: 1, bid: 1, seq: 1, at: serverTimestamp() }, 'no side'],
  ];
  for (const [value, label] of badVotes) await assert.rejects(set(mine(first), value), denied, label);
  await assert.rejects(set(ref(first.db, `votes/${code}/${second.uid}`), ballot()), denied, 'only the player writes their own vote');
  await assert.rejects(set(mine(outsider), ballot()), denied, 'no seat at that table');
  await set(mine(first), ballot({ seq: 5, bid: 3 }));
  await assert.rejects(set(mine(first), ballot({ seq: 4 })), denied, 'seq going back');
  await assert.rejects(set(mine(first), ballot({ seq: 5 })), denied, 'the same seq again');
  await assert.rejects(set(mine(first), null), denied, 'a vote cannot be deleted');
  await set(mine(first), ballot({ seq: 6, side: 'abstain', bid: 0 }));
  assert.deepEqual(await vote(second, code, 'no', 3), 1, 'the store sends the next seq and the server time');

  // 截止之後、揭曉之後、黑夜都不能再投。
  assert.deepEqual(await revealDusk(host, code, 2), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/2/dusk`);
  await untilServerTime(host, revealAt + 50);
  await assert.rejects(vote(third, code, 'yes', 1), refused, 'after the deadline');
  await untilServerTime(host, duskSettleAt({ revealAt }) + 50);
  assert.equal((await settleDusk(host, code, 2, data)).outcome, 'revealed');
  await assert.rejects(set(mine(first), ballot({ seq: 7 })), denied, 'after the reveal');
  await advanceTable(host, code, 2, { round: 1, phase: 'dusk' });
  await assert.rejects(set(mine(first), ballot({ seq: 7 })), denied, 'at night');
  const result = await read(host, `rooms/${code}/games/2/dusk/result`);
  assert.deepEqual(result, { yes: 0, no: 3, passed: false, votes: { [first.uid]: { side: 'abstain', bid: 0 }, [second.uid]: { side: 'no', bid: 3 } } });
});

test('a vote changed field by field cannot keep an old time or an old bid: every write is checked as a whole', TIMEOUT, async (t) => {
  const { code, first } = await duskRoom(t, ['b01', 'b04']);
  const mine = ref(first.db, `votes/${code}/${first.uid}`);
  await vote(first, code, 'yes', 3);
  await untilServerTime(first, (await read(first, `votes/${code}/${first.uid}`)).at + 50); // 同一毫秒內的「舊」時間就是現在
  await assert.rejects(update(mine, { side: 'no', seq: 2 }), denied, 'the old time cannot be kept');
  await assert.rejects(update(mine, { bid: 4, seq: 2, at: serverTimestamp() }), denied, 'the bid is checked against the influence');
  await update(mine, { side: 'no', seq: 2, at: serverTimestamp() });
  assert.deepEqual(await read(first, `votes/${code}/${first.uid}`).then(({ side, bid, seq }) => [side, bid, seq]), ['no', 3, 2], 'a whole valid vote is fine');
  assert.deepEqual(await revealDusk(host, code, 2), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/2/dusk`);
  await untilServerTime(host, revealAt + 50);
  await assert.rejects(update(mine, { side: 'yes', seq: 3, at: serverTimestamp() }), denied, 'after the deadline, field by field too');
  await untilServerTime(host, duskSettleAt({ revealAt }) + 50);
  assert.deepEqual((await settleDusk(host, code, 2, data)).result.votes, { [first.uid]: { side: 'no', bid: 3 } });
  assert.equal(await read(host, `rooms/${code}/games/2/seats/${first.uid}/influence`), 0, 'first paid 3');

  // 下一回合：只改回合、沿用上一回合出價 3（影響力已經是 0）的票要被拒。
  for (const [round, phase] of [
    [1, 'dusk'],
    [1, 'night'],
    [2, 'sunrise'],
    [2, 'day'],
  ]) {
    await advanceTable(host, code, 2, { round, phase });
  }
  assert.equal((await settleDusk(host, code, 2, data)).outcome, 'opened');
  await untilServerTime(first, (await read(first, `votes/${code}/${first.uid}`)).at + 50);
  await assert.rejects(update(mine, { round: 2, seq: 3, at: serverTimestamp() }), denied, 'last round’s bid cannot be carried over');
  await assert.rejects(update(mine, { round: 2, seq: 3 }), denied, 'nor last round’s time');
  assert.equal(await vote(first, code, 'yes', 0, 2), 3, 'a fresh vote within the influence is fine');
});

test('the rules check every dusk field the hosts write', TIMEOUT, async (t) => {
  const { code, first, second, third } = await dayRoom(t);
  const game = `rooms/${code}/games/2`;
  let version = await read(host, `${game}/version`);
  const bumped = (session, writes) => update(ref(session.db), { ...writes, [`${game}/version`]: version + 1 });
  const accept = async (writes) => {
    await bumped(host, writes);
    version += 1;
  };
  const opened = { round: 1, bill: 'b01', openedAt: serverTimestamp(), submitted: 0 };
  await assert.rejects(bumped(host, { [`${game}/dusk`]: opened }), denied, 'only at dusk');
  await advanceTable(host, code, 2, { round: 1, phase: 'day' });
  await assert.rejects(bumped(first, { [`${game}/dusk`]: opened }), denied, 'players cannot open a dusk');
  const badDusks = [
    { ...opened, round: 2 },
    { ...opened, bill: 'not a bill' },
    { ...opened, openedAt: Date.now() - 1000 },
    { ...opened, submitted: 7 },
    { ...opened, submitted: 1.5 },
    { ...opened, revealAt: Date.now() - 1000 },
    { ...opened, extra: 1 },
    { round: 1, bill: 'b01', submitted: 0 },
  ];
  for (const value of badDusks) await assert.rejects(bumped(host, { [`${game}/dusk`]: value }), denied, JSON.stringify(value));
  await accept({ [`${game}/dusk`]: opened, [`hostOnly/${code}/2/billDeck`]: ['b04'] });
  await assert.rejects(bumped(host, { [`hostOnly/${code}/2/billDeck`]: ['b04', 'no good'] }), denied, 'the pile holds bill ids');
  await assert.rejects(bumped(host, { [`${game}/dusk`]: { ...opened, bill: 'b04' } }), denied, 'the bill cannot be swapped');
  await assert.rejects(bumped(host, { [`${game}/dusk/bill`]: 'b04' }), denied, 'the bill cannot be swapped, field by field either');
  await assert.rejects(bumped(host, { [`${game}/dusk/openedAt`]: serverTimestamp() }), denied, 'the dusk cannot be opened again');
  await assert.rejects(bumped(host, { [`${game}/dusk`]: null }), denied, 'the dusk cannot be removed');
  await accept({ [`${game}/dusk/submitted`]: 2 });

  // 截止時間：伺服器時間到 60 秒後之間；之後只能提早（改成現在），不能延後、不能拿掉。
  await assert.rejects(bumped(host, { [`${game}/dusk/revealAt`]: Date.now() - 5000 }), denied, 'a deadline in the past');
  await assert.rejects(bumped(host, { [`${game}/dusk/revealAt`]: Date.now() + 120_000 }), denied, 'a deadline too far away');
  await assert.rejects(bumped(host, { [`${game}/dusk/revealAt`]: Date.now() + 2000.5 }), denied, 'a fraction');
  const far = serverTime(host) + 30_000;
  await accept({ [`${game}/dusk/revealAt`]: far });
  await assert.rejects(bumped(host, { [`${game}/dusk/revealAt`]: far + 1000 }), denied, 'the deadline cannot move later');
  await assert.rejects(bumped(host, { [`${game}/dusk/revealAt`]: null }), denied, 'the deadline cannot be removed');
  const result = { yes: 2, no: 1, passed: true, votes: { [first.uid]: { side: 'yes', bid: 2 }, [second.uid]: { side: 'no', bid: 1 } } };
  const reveal = (fields = {}) => ({
    [`${game}/dusk/result`]: result,
    [`${game}/duskLog/1`]: { bill: 'b01', ...result },
    [`${game}/bills/b01`]: 'passed',
    ...fields,
  });
  await assert.rejects(bumped(host, reveal()), denied, 'no result before the deadline');
  await accept({ [`${game}/dusk/revealAt`]: serverTimestamp() });

  const badReveals = [
    { [`${game}/dusk/result`]: { ...result, passed: false } },
    { [`${game}/dusk/result`]: { ...result, yes: 1, passed: true } },
    { [`${game}/dusk/result`]: { ...result, yes: -1 } },
    { [`${game}/dusk/result`]: { ...result, extra: 1 } },
    { [`${game}/dusk/result`]: { ...result, votes: { [outsider.uid]: { side: 'yes', bid: 2 } } } },
    { [`${game}/dusk/result`]: { ...result, votes: { [third.uid]: { side: 'abstain', bid: 1 } } } },
    { [`${game}/dusk/result`]: { ...result, votes: { [third.uid]: { side: 'yes', bid: 1, at: 1 } } } },
    { [`${game}/duskLog/2`]: { bill: 'b01', ...result }, [`${game}/duskLog/1`]: null },
    { [`${game}/duskLog/1`]: { bill: 'b04', ...result } },
    { [`${game}/duskLog/1`]: { bill: 'b01', ...result, passed: false } },
    { [`${game}/bills/b01`]: 'maybe' },
    { [`${game}/bills/b01`]: 'failed' },
    { [`${game}/bills/b04`]: 'passed' },
    { [`${game}/seats/${first.uid}/aligned`]: -1 },
    { [`${game}/seats/${first.uid}/aligned`]: 1.5 },
  ];
  for (const fields of badReveals) await assert.rejects(bumped(host, reveal(fields)), denied, JSON.stringify(fields));
  await assert.rejects(bumped(host, { [`${game}/duskLog/1`]: { bill: 'b01', ...result } }), denied, 'the log comes with the result');
  await assert.rejects(bumped(host, { [`${game}/bills/b01`]: 'passed' }), denied, 'the bill result comes with the result');
  await accept(reveal({ [`${game}/seats/${first.uid}/aligned`]: 1 }));
  await assert.rejects(bumped(host, { [`${game}/dusk/result`]: { ...result, yes: 3 } }), denied, 'a result is written once');
  await assert.rejects(bumped(host, { [`${game}/dusk/result`]: null }), denied, 'a result cannot be removed');
  await assert.rejects(bumped(host, { [`${game}/duskLog/1`]: { bill: 'b01', ...result } }), denied, 'a log entry is written once');
  await assert.rejects(bumped(host, { [`${game}/bills`]: null }), denied, 'bill results cannot be removed');
  const stored = await read(host, game);
  assert.deepEqual([stored.bills, stored.duskLog[1].bill, stored.seats[first.uid].aligned], [{ b01: 'passed' }, 'b01', 1]);
});

test('everyone votes, the deadline is 1 second away, and the dusk reveals by itself on every screen', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await dayRoom(t);
  const errorsSeen = [];
  const stop = startSettling(host, code, quick, { onError: (error) => errorsSeen.push(error) });
  t.after(stop);
  const start = await readTable(code);
  await advanceTable(host, code, 2, { round: 1, phase: 'day' });
  const opened = await watchers.p1.until((room) => room.games[2].dusk?.bill, 'the bill is turned over by itself');
  assert.deepEqual([opened.games[2].dusk.bill, opened.games[2].dusk.submitted], ['b01', 0]);

  await vote(first, code, 'yes', 2);
  await watchers.p3.until((room) => room.games[2].dusk.submitted === 1, 'one vote sent');
  await vote(second, code, 'no', 1);
  await vote(first, code, 'yes', 3); // 改票：以最後一次為準
  await vote(third, code, 'abstain');
  const allIn = serverTime(host);
  const counting = await watchers.p2.until((room) => room.games[2].dusk.revealAt, 'everyone voted: the countdown starts');
  const { revealAt } = counting.games[2].dusk;
  assert.equal(counting.games[2].dusk.submitted, 3);
  assert.ok(revealAt >= allIn + 1000 - 300 && revealAt <= allIn + 1000 + 600, `the deadline is about 1 s after the last vote (${revealAt - allIn} ms)`);

  const views = await Promise.all(['host', 'p1', 'p2', 'p3'].map((name) => watchers[name].until((room) => room.games[2].dusk.result, `${name} sees the result`, 8000)));
  const shownAt = serverTime(host);
  assert.ok(shownAt >= duskSettleAt({ revealAt }) - 200 && shownAt < revealAt + 4000, `revealed ${shownAt - revealAt} ms after the deadline`);
  const expected = {
    yes: 3,
    no: 1,
    passed: true,
    votes: { [first.uid]: { side: 'yes', bid: 3 }, [second.uid]: { side: 'no', bid: 1 }, [third.uid]: { side: 'abstain', bid: 0 } },
  };
  for (const view of views) assert.deepEqual(view.games[2].dusk.result, expected);
  const final = await readTable(code);
  assert.deepEqual(final.game.duskLog[1], { bill: 'b01', ...expected });
  assert.deepEqual(Object.values(final.game.duskLog).filter(Boolean).length, 1);
  assert.deepEqual(final.game.bills, { b01: 'passed' });
  // first（r1）出價 3：3−3＝0；second（r2）出價 1：影響力 2、英鎊 −4；third（r3）棄權：影響力 +2。迷霧 0−3 仍是 0。
  assert.deepEqual(stats(final.game, 'influence'), { [first.uid]: 0, [second.uid]: 2, [third.uid]: 5 });
  assert.deepEqual(stats(final.game, 'pounds'), {
    [first.uid]: start.game.seats[first.uid].pounds,
    [second.uid]: start.game.seats[second.uid].pounds - 4,
    [third.uid]: start.game.seats[third.uid].pounds,
  });
  assert.deepEqual(stats(final.game, 'aligned'), { [first.uid]: 1, [second.uid]: undefined, [third.uid]: undefined });
  assert.equal(final.table.fog, 0);
  // 開黃昏、已送出人數（1 人；後面幾張票靠得近時可能併成一次，最後一次連同截止時間）、揭曉。
  const writes = final.game.version - start.game.version;
  assert.ok(writes >= 4 && writes <= 5, `${writes} writes`);
  await watchers.p1.until((room) => room.games[2].seats[first.uid].influence === 0, 'first sees the paid bid without reloading');
  await advanceTable(host, code, 2, { round: 1, phase: 'dusk' });
  await watchers.p1.until((room) => room.games[2].night?.round === 1, 'the night opens (M8)');
  await sleep(300);
  const night = await readTable(code);
  assert.equal(night.game.version, final.game.version + 1, 'at night only the night opens');
  assert.deepEqual(night.game.dusk, final.game.dusk, 'nothing more happens to the dusk at night');
  assert.deepEqual(errorsSeen, []);
});

test('a vote sent twice counts only the last one; a failed bill takes its onFail effects, fog included', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await duskRoom(t);
  await vote(first, code, 'yes', 2);
  await vote(second, code, 'yes', 1);
  assert.equal(await vote(first, code, 'no', 3), 2);
  assert.deepEqual(await revealDusk(host, code, 2), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/2/dusk`);
  await untilServerTime(host, duskSettleAt({ revealAt }) + 50);
  const { result } = await settleDusk(host, code, 2, data);
  assert.deepEqual(result, { yes: 1, no: 3, passed: false, votes: { [first.uid]: { side: 'no', bid: 3 }, [second.uid]: { side: 'yes', bid: 1 } } });
  const { table, game } = await readTable(code);
  // b01 不通過：third（r3）影響力 −1、迷霧 +3。
  assert.deepEqual(stats(game, 'influence'), { [first.uid]: 0, [second.uid]: 2, [third.uid]: 2 }, 'paid once, the last bid');
  assert.deepEqual([table.fog, game.fogMax, game.fogPending], [3, 3, undefined]);
  assert.deepEqual(stats(game, 'aligned'), { [first.uid]: 1, [second.uid]: undefined, [third.uid]: undefined });
  assert.deepEqual(game.bills, { b01: 'failed' });
  await watchers.p1.until((room) => room.tables[2].fog === 3, 'every screen sees the fog');
});

test('the host reveals early: the deadline is now, whoever has not voted counts as abstaining', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await duskRoom(t, ['b04']);
  const start = await readTable(code);
  await vote(first, code, 'no', 1);
  const askedAt = serverTime(host);
  assert.deepEqual(await revealDusk(host, code, 2), { closed: true });
  assert.deepEqual(await revealDusk(host, code, 2), { closed: false }, 'already closed');
  const { revealAt, submitted } = await read(host, `rooms/${code}/games/2/dusk`);
  assert.ok(revealAt >= askedAt - 1000 && revealAt <= serverTime(host) + 1000, 'the deadline is the server time');
  assert.equal(submitted, 0, 'the host here did not count yet');
  await assert.rejects(vote(second, code, 'yes', 3), refused, 'too late to vote');
  assert.deepEqual(await settleDusk(host, code, 2, data), { outcome: 'counted', result: null }, 'before the grace is over, only the count');
  assert.deepEqual(await settleDusk(host, code, 2, data), { outcome: 'waiting', result: null });
  await untilServerTime(host, duskSettleAt({ revealAt }) + 50);
  const { outcome, result } = await settleDusk(host, code, 2, data);
  assert.equal(outcome, 'revealed');
  assert.deepEqual(result, { yes: 0, no: 1, passed: false, votes: { [first.uid]: { side: 'no', bid: 1 } } });
  const final = await readTable(code);
  // b04 不通過：全體英鎊 −2；只有 first 付出價。
  assert.deepEqual(stats(final.game, 'influence'), { [first.uid]: 2, [second.uid]: 3, [third.uid]: 3 });
  for (const uid of [first.uid, second.uid, third.uid]) assert.equal(final.game.seats[uid].pounds, start.game.seats[uid].pounds - 2);
  assert.deepEqual(stats(final.game, 'aligned'), { [first.uid]: 1, [second.uid]: undefined, [third.uid]: undefined });
  assert.deepEqual(final.game.bills, { b04: 'failed' });
  await watchers.p2.until((room) => room.games[2].dusk.result?.no === 1, 'second sees the result');
});

test('two hosts revealing at once write only once, and two automatic hosts open and reveal once', TIMEOUT, async (t) => {
  const { code, first, second, third } = await dayRoom(t);
  const seenByBackup = watch(backup, code);
  t.after(() => seenByBackup.stop());
  await enterAsHost(backup, code);
  await approveHost(host, code, backup.uid);
  await advanceTable(host, code, 2, { round: 1, phase: 'day' });
  const start = await readTable(code);
  await seenByBackup.until((room) => room.hosts?.[backup.uid] === true && room.tables[2].phase === 'dusk', 'backup sees the table');
  const opened = await Promise.all([settleDusk(host, code, 2, quick), settleDusk(backup, code, 2, quick)]);
  assert.deepEqual(opened.map((result) => result.outcome).sort(), ['opened', 'waiting'], 'the other host finds the bill already turned over');
  assert.deepEqual((await readTable(code)).game.version, start.game.version + 1, 'opened once');
  await Promise.all([vote(first, code, 'yes', 1), vote(second, code, 'yes', 1), vote(third, code, 'no', 1)]);
  assert.equal((await settleDusk(host, code, 2, quick)).outcome, 'counted');
  const { revealAt } = await read(host, `rooms/${code}/games/2/dusk`);
  await seenByBackup.until((room) => room.games[2].dusk.revealAt === revealAt, 'backup sees the deadline');
  await untilServerTime(host, duskSettleAt({ revealAt }) + 50);
  const results = await Promise.all([settleDusk(host, code, 2, quick), settleDusk(backup, code, 2, quick)]);
  assert.deepEqual(results.map((result) => result.outcome).sort(), ['none', 'revealed']);
  let now = await readTable(code);
  assert.equal(now.game.version, start.game.version + 3, 'opened, counted and revealed once each');
  // 每人出價 1；b01 通過，third（r3）影響力 +2。
  assert.deepEqual(stats(now.game, 'influence'), { [first.uid]: 2, [second.uid]: 2, [third.uid]: 4 }, 'every bid paid once');

  // 下一回合：兩台都開著自動化，翻法案、揭曉都只做一次。
  const errorsSeen = [];
  const stops = [host, backup].map((session) => startSettling(session, code, quick, { onError: (error) => errorsSeen.push(error) }));
  t.after(() => stops.forEach((stop) => stop()));
  for (const [round, phase] of [
    [1, 'dusk'],
    [1, 'night'],
    [2, 'sunrise'],
    [2, 'day'],
  ]) {
    await advanceTable(host, code, 2, { round, phase });
  }
  const second2 = await seenByBackup.until((room) => room.games[2].dusk?.round === 2, 'the round 2 bill is turned over', 8000);
  assert.equal(second2.games[2].dusk.bill, 'b04');
  const before2 = await readTable(code);
  await Promise.all([vote(first, code, 'no', 1, 2), vote(second, code, 'no', 1, 2), vote(third, code, 'abstain', 0, 2)]);
  await seenByBackup.until((room) => room.games[2].dusk.result, 'round 2 is revealed', 8000);
  await sleep(300); // 讓晚到的另一台有機會（錯誤地）再寫一次
  now = await readTable(code);
  assert.ok(now.game.version <= before2.game.version + 4 && now.game.version >= before2.game.version + 2, `version ${now.game.version - before2.game.version}`);
  assert.deepEqual(stats(now.game, 'influence'), { [first.uid]: 1, [second.uid]: 1, [third.uid]: 4 }, 'paid once');
  assert.deepEqual(now.game.bills, { b01: 'passed', b04: 'failed' });
  assert.deepEqual(Object.keys(now.game.duskLog).filter((key) => now.game.duskLog[key]).length, 2);
  assert.deepEqual(errorsSeen, []);
});

test('a player who drops out while voting sends the vote when back online, and it counts', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await dayRoom(t);
  const errorsSeen = [];
  const stop = startSettling(host, code, quick, { onError: (error) => errorsSeen.push(error) });
  t.after(stop);
  await advanceTable(host, code, 2, { round: 1, phase: 'day' });
  await watchers.p3.until((room) => room.games[2].dusk?.bill, 'the bill is turned over');
  goOffline(third.db);
  t.after(() => goOnline(third.db));
  const sending = vote(third, code, 'yes', 2);
  await vote(first, code, 'no', 1);
  await vote(second, code, 'yes', 1);
  await watchers.host.until((room) => room.games[2].dusk.submitted === 2, 'two votes while third is offline');
  await sleep(500);
  assert.equal((await read(host, `rooms/${code}/games/2/dusk`)).revealAt, undefined, 'the countdown waits for everyone');
  goOnline(third.db);
  assert.equal(await sending, 1);
  const done = await watchers.p1.until((room) => room.games[2].dusk.result, 'revealed after third is back', 8000);
  assert.deepEqual(done.games[2].dusk.result.votes[third.uid], { side: 'yes', bid: 2 });
  assert.deepEqual([done.games[2].dusk.result.yes, done.games[2].dusk.result.no, done.games[2].dusk.result.passed], [3, 1, true]);
  assert.deepEqual(errorsSeen, []);
});

test('a vote changed while the host was offline still counts: the host asks the server again at the reveal', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await dayRoom(t);
  const errorsSeen = [];
  const stop = startSettling(host, code, data, { onError: (error) => errorsSeen.push(error) }); // 揭曉倒數 3 秒
  t.after(stop);
  await advanceTable(host, code, 2, { round: 1, phase: 'day' });
  await watchers.p1.until((room) => room.games[2].dusk?.bill, 'the bill is turned over');
  await vote(first, code, 'yes', 3);
  await vote(second, code, 'no', 1);
  await vote(third, code, 'abstain');
  const counting = await watchers.host.until((room) => room.games[2].dusk.revealAt, 'the countdown starts');
  const { revealAt } = counting.games[2].dusk;
  // 等主持端寫截止時間的那筆收到伺服器確認、自動化閒下來（問一次伺服器就知道），再斷線：它的快取停在 first 投贊成，
  // 計時器照樣在截止＋緩衝時叫醒它。
  await read(host, `hostOnly/${code}/2`);
  await sleep(100);
  goOffline(host.db);
  t.after(() => goOnline(host.db));
  assert.ok(serverTime(first) < revealAt - 500, 'still time to change the vote');
  await vote(first, code, 'no', 2);
  await untilServerTime(first, duskSettleAt({ revealAt }) + 700);
  goOnline(host.db);
  const done = await watchers.p2.until((room) => room.games[2].dusk.result, 'revealed after the host is back', 8000);
  assert.deepEqual(done.games[2].dusk.result.votes[first.uid], { side: 'no', bid: 2 }, 'the changed vote, read from the server');
  assert.deepEqual([done.games[2].dusk.result.yes, done.games[2].dusk.result.no, done.games[2].dusk.result.passed], [0, 3, false]);
  assert.deepEqual(errorsSeen, []);
});

test('later rounds draw the rest of the pile, keep every log, and adjourn once every bill has passed', TIMEOUT, async (t) => {
  // 只有兩張法案的資料：兩張都通過之後議會休會。
  const two = { ...quick, bills: [billOf('b01'), billOf('b04')] };
  const { code, first, second, third } = await dayRoom(t, []);
  const round = async (number, votes) => {
    assert.equal((await settleDusk(host, code, 2, two, seededRandom(number))).outcome, 'opened');
    const { bill } = await read(host, `rooms/${code}/games/2/dusk`);
    if (!bill) return null;
    await Promise.all(votes.map(([session, side, bid]) => vote(session, code, side, bid, number)));
    assert.equal((await settleDusk(host, code, 2, two)).outcome, 'counted');
    const { revealAt } = await read(host, `rooms/${code}/games/2/dusk`);
    await untilServerTime(host, duskSettleAt({ revealAt }) + 50);
    assert.equal((await settleDusk(host, code, 2, two)).outcome, 'revealed');
    return bill;
  };
  const next = async (number, phase) => advanceTable(host, code, 2, { round: number, phase });
  await next(1, 'day');
  const firstBill = await round(1, [
    [first, 'yes', 1],
    [second, 'yes', 1],
    [third, 'abstain', 0],
  ]);
  const pile = await read(host, `hostOnly/${code}/2`);
  assert.equal(pile.billDeck.length, 1, 'the first dusk shuffled both bills into a pile');
  // 黑夜→日出（發牌）→白晝→黃昏：發牌只動牌庫與棄牌堆，法案牌堆留著。
  const onward = async (number) => {
    await next(number - 1, 'dusk');
    await next(number - 1, 'night');
    assert.equal((await processSunrise(host, code, 2, two)).dealt, true);
    assert.deepEqual((await read(host, `hostOnly/${code}/2`))?.billDeck, number === 2 ? pile.billDeck : undefined, 'dealing keeps the bill pile');
    await next(number, 'sunrise');
    await next(number, 'day');
  };
  await onward(2);
  const secondBill = await round(2, [
    [first, 'yes', 1],
    [second, 'no', 0],
    [third, 'yes', 1],
  ]);
  assert.deepEqual([firstBill, secondBill].sort(), ['b01', 'b04']);
  await onward(3);
  assert.equal(await round(3, []), null, 'every bill has passed: parliament adjourns');
  const game = await read(host, `rooms/${code}/games/2`);
  assert.deepEqual({ ...game.dusk, openedAt: typeof game.dusk.openedAt }, { round: 3, openedAt: 'number', submitted: 0 });
  assert.deepEqual(game.bills, { b01: 'passed', b04: 'passed' });
  assert.deepEqual([game.duskLog[1].bill, game.duskLog[2].bill, game.duskLog[3]], [firstBill, secondBill, undefined]);
  await assert.rejects(vote(first, code, 'yes', 1, 3), refused, 'no voting while parliament adjourns');
  assert.deepEqual(await settleDusk(host, code, 2, two), { outcome: 'none', result: null });
  assert.deepEqual(await revealDusk(host, code, 2), { closed: false });
});
