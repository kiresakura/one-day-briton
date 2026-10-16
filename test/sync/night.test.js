// 黑夜的同步與權限測試：選擇與挑棄牌的讀寫權限、規則、開黑夜、全員送出後倒數揭曉、提前揭曉、兩台主持端、揭曉後的數字，
// 以及下一回合日出照挑的棄牌（npm run test:sync）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get, goOffline, goOnline, ref, serverTimestamp, set, update } from 'firebase/database';
import { NIGHT_GRACE_MS, buildDeck, nightSettleAt, seatsInOrder, seededRandom } from '../../play/js/game.js';
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
  requestDiscard,
  requestNight,
  revealNight,
  serverTime,
  settleNight,
  startSettling,
  startTable,
  watchDiscard,
  watchNight,
  watchRoom,
} from '../../play/js/store.js';

const TIMEOUT = { timeout: 30_000 };
const denied = /permission[_ ]denied/i;
const refused = { name: 'StoreError', code: 'permission-denied' }; // store.js 把規則的拒絕包成 StoreError
const cardDir = new URL('../../play/data/', import.meta.url);
const { data: fileData, errors } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
// 這裡測的是黑夜與手牌上限的數字，日出不翻一般事件（sunriseEvents 0）；跟事件一起的情況在瀏覽器實測。
const data = { ...fileData, settings: { ...fileData.settings, sunriseEvents: 0 } };
assert.deepEqual(errors, []);
assert.deepEqual([data.settings.nightRevealSeconds, data.settings.gamblePounds, data.settings.splitPounds, data.settings.handLimit], [3, [5, 20, 30], 6, 7]);
// 測倒數的地方把揭曉倒數改成 1 秒（只改這份資料物件，不改資料檔）。
const quick = { ...data, settings: { ...data.settings, nightRevealSeconds: 1 } };

// 骰子：照順序擲出指定的點數（多擲就報錯），或每次都擲同一個點數。
function dice(...rolls) {
  const queue = [...rolls];
  return () => {
    if (queue.length === 0) throw new Error('rolled more dice than expected');
    return queue.shift() - 1;
  };
}
const always = (roll) => () => roll - 1;

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

// 開一間新房，p1、p2、p3 在第 2 桌、outsider 在第 3 桌；第 2 桌開局並推進到第 1 回合白晝。first、second、third 照座位排。
async function dayRoom(t) {
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
  return { code, watchers, first, second, third };
}

// 從這一回合的 from（日出或白晝）推進到黑夜（黃昏不開法案）。open 時主持端接著開黑夜。自動化要等推進完才開：
// 一路快速推進時，自動化在前一個階段算好的寫入會被規則擋下（階段已經變了）。
async function toNight(code, round = 1, { from = 'day', open = true, cardData = data } = {}) {
  const phases = ['sunrise', 'day', 'dusk'];
  for (const phase of phases.slice(phases.indexOf(from))) await advanceTable(host, code, 2, { round, phase });
  if (open) assert.equal((await settleNight(host, code, 2, cardData)).outcome, 'opened');
}

async function nightRoom(t, options) {
  const room = await dayRoom(t);
  await toNight(room.code, 1, options);
  return room;
}

const choose = (session, code, choice, tiers = null, round = 1) => requestNight(session, code, { table: 2, round, choice, tiers });

// 主持端讀出第 2 桌的全部狀態。
async function readTable(code) {
  const [table, game, nights, pile] = await Promise.all([
    read(host, `rooms/${code}/tables/2`),
    read(host, `rooms/${code}/games/2`),
    read(host, `nights/${code}`),
    read(host, `hostOnly/${code}/2`),
  ]);
  return { table, game, nights: nights ?? {}, pile: pile ?? {} };
}

const stats = (game, key) => Object.fromEntries(Object.entries(game.seats).map(([uid, seat]) => [uid, seat[key]]));
const sleeping = { choice: 'sleep', pounds: 0, influence: 0, sin: 0 };
const missedSleep = { choice: 'sleep', missed: true, pounds: 0, influence: 0, sin: 0 }; // 沒送出、照睡覺算

test('a night opens at night; before the reveal a player reads only their own pick and discards, the host reads them all', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await dayRoom(t);
  assert.deepEqual(await settleNight(host, code, 2, data), { outcome: 'none', result: null }, 'not at night');
  await toNight(code, 1, { open: false });
  const sentAt = serverTime(host);
  assert.deepEqual(await settleNight(host, code, 2, data), { outcome: 'opened', result: null });
  const { night } = (await readTable(code)).game;
  assert.deepEqual({ ...night, openedAt: typeof night.openedAt }, { round: 1, openedAt: 'number', submitted: 0 });
  assert.ok(night.openedAt >= sentAt - 1000 && night.openedAt <= serverTime(host) + 1000, 'openedAt is the server time');
  assert.deepEqual(await settleNight(host, code, 2, data), { outcome: 'waiting', result: null }, 'opened once');
  assert.deepEqual(await settleNight(host, code, 3, data), { outcome: 'none', result: null }, 'a table nobody sits at has no night');
  await assert.rejects(settleNight(p1, code, 2, data), refused, 'players cannot run the night');

  assert.equal(await choose(first, code, 'gamble', 2), 1);
  assert.equal(await choose(second, code, 'split'), 1);
  const mine = watch(first, code, watchNight);
  t.after(() => mine.stop());
  const own = await mine.until((value) => value?.seq === 1, 'first watches the own pick');
  assert.deepEqual({ ...own, at: typeof own.at }, { table: '2', round: 1, choice: 'gamble', tiers: 2, seq: 1, at: 'number' });
  assert.equal(await requestDiscard(third, code, { table: 2, round: 1, cards: ['a01'] }), 1);
  const picked = watch(third, code, watchDiscard);
  t.after(() => picked.stop());
  assert.deepEqual((await picked.until((value) => value?.seq === 1, 'third watches the own discards')).cards, ['a01']);
  for (const [session, path] of [
    [first, `nights/${code}/${second.uid}`],
    [first, `nights/${code}`],
    [third, `nights/${code}/${first.uid}`],
    [outsider, `nights/${code}/${first.uid}`],
    [outsider, `nights/${code}`],
    [first, `discards/${code}/${third.uid}`],
    [first, `discards/${code}`],
    [outsider, `discards/${code}`],
  ]) {
    await assert.rejects(get(ref(session.db, path)), denied, path);
  }
  assert.equal((await read(second, `nights/${code}/${second.uid}`)).choice, 'split');
  assert.deepEqual(Object.keys(await read(host, `nights/${code}`)).sort(), [first.uid, second.uid].sort(), 'the host reads the whole room');
  assert.deepEqual(Object.keys(await read(host, `discards/${code}`)), [third.uid]);
  const hostView = watch(host, code, (session, roomCode, onValue) => watchDiscard(session, roomCode, onValue, undefined, third.uid));
  t.after(() => hostView.stop());
  assert.deepEqual((await hostView.until((value) => value?.seq === 1, 'the host watches one player’s discards')).cards, ['a01']);

  assert.deepEqual(await settleNight(host, code, 2, data), { outcome: 'counted', result: null });
  const seen = await watchers.p3.until((room) => room.games[2].night.submitted === 2, 'third sees two picks sent');
  assert.doesNotMatch(JSON.stringify(seen), /"choice"|"tiers"|"cards"|"gamble"|"split"/, 'the public tree has only the number of picks before the reveal');
  assert.equal(seen.games[2].night.revealAt, undefined, 'not everyone has sent');
});

test('the rules turn down bad picks: no seat, not at night, bad tiers, a made-up time, an old seq, a one-field update, after the deadline and the reveal', TIMEOUT, async (t) => {
  const { code, first, second, third } = await dayRoom(t);
  const mine = (session) => ref(session.db, `nights/${code}/${session.uid}`);
  const choice = (fields = {}) => ({ table: '2', round: 1, choice: 'gamble', tiers: 2, seq: 1, at: serverTimestamp(), ...fields });
  await assert.rejects(set(mine(first), choice()), denied, 'not at night yet');
  await toNight(code, 1, { open: false });
  await assert.rejects(set(mine(first), choice()), denied, 'night, but the host has not opened it yet');
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'opened');

  const { tiers, ...noTiers } = choice();
  assert.equal(tiers, 2);
  const badPicks = [
    [choice({ tiers: 0 }), 'tiers below 1'],
    [choice({ tiers: 4 }), 'tiers above 3'],
    [choice({ tiers: 1.5 }), 'tiers as a fraction'],
    [choice({ tiers: '2' }), 'tiers as text'],
    [noTiers, 'a gamble without tiers'],
    [choice({ choice: 'split' }), 'a split with tiers'],
    [choice({ choice: 'sleep', tiers: 1 }), 'a sleep with tiers'],
    [choice({ choice: 'dance' }), 'not a choice'],
    [choice({ at: Date.now() - 5000 }), 'a time earlier than the server time'],
    [choice({ at: Date.now() + 5000 }), 'a time later than the server time'],
    [choice({ table: 2 }), 'the table is text'],
    [choice({ table: '3' }), 'a table without a game'],
    [choice({ round: 2 }), 'another round'],
    [choice({ seq: 0 }), 'seq starts at 1'],
    [choice({ extra: 1 }), 'no other fields'],
    [{ table: '2', round: 1, choice: 'split', seq: 1 }, 'no time'],
    [{ table: '2', round: 1, seq: 1, at: serverTimestamp() }, 'no choice'],
  ];
  for (const [value, label] of badPicks) await assert.rejects(set(mine(first), value), denied, label);
  await assert.rejects(set(ref(first.db, `nights/${code}/${second.uid}`), choice()), denied, 'only the player writes their own pick');
  await assert.rejects(set(mine(outsider), choice()), denied, 'no seat at that table');
  await set(mine(first), choice({ seq: 5 }));
  await assert.rejects(set(mine(first), choice({ seq: 4 })), denied, 'seq going back');
  await assert.rejects(set(mine(first), choice({ seq: 5 })), denied, 'the same seq again');
  await assert.rejects(set(mine(first), null), denied, 'a pick cannot be deleted');

  // 只改一個欄位的更新：留著舊的序號或舊的時間都被拒，整筆合法的照收。
  await untilServerTime(first, (await read(first, `nights/${code}/${first.uid}`)).at + 50); // 同一毫秒內的「舊」時間就是現在
  await assert.rejects(update(mine(first), { tiers: 3 }), denied, 'one field: the old seq and time');
  await assert.rejects(update(mine(first), { tiers: 3, seq: 6 }), denied, 'the old time cannot be kept');
  await assert.rejects(update(mine(first), { choice: 'split', seq: 6, at: serverTimestamp() }), denied, 'a split cannot keep the old tiers');
  await update(mine(first), { tiers: 3, seq: 6, at: serverTimestamp() });
  assert.deepEqual(await read(first, `nights/${code}/${first.uid}`).then(({ choice: kind, tiers: level, seq }) => [kind, level, seq]), ['gamble', 3, 6]);
  assert.equal(await choose(second, code, 'split'), 1, 'the store sends the next seq and the server time');

  // 截止之後、揭曉之後、下一個階段都不能再選。
  assert.deepEqual(await revealNight(host, code, 2), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/2/night`);
  await untilServerTime(host, revealAt + 50);
  await assert.rejects(choose(third, code, 'sleep'), refused, 'after the deadline');
  await assert.rejects(update(mine(first), { tiers: 1, seq: 7, at: serverTimestamp() }), denied, 'after the deadline, field by field too');
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  assert.equal((await settleNight(host, code, 2, data, always(6))).outcome, 'revealed');
  await assert.rejects(set(mine(first), choice({ seq: 7 })), denied, 'after the reveal');
  await advanceTable(host, code, 2, { round: 1, phase: 'night' });
  await assert.rejects(set(mine(first), choice({ seq: 7, round: 2 })), denied, 'at sunrise');
  const { result } = await read(host, `rooms/${code}/games/2/night`);
  assert.deepEqual(result.players[first.uid], { choice: 'gamble', tiers: 3, rolls: [6, 6, 6], bust: false, pounds: 30, influence: 1, sin: 0 });
  assert.deepEqual([result.players[second.uid].choice, result.players[third.uid]], ['split', missedSleep], 'third never got a pick in: marked missed');
});

test('the rules turn down bad discards, also field by field; a pick is fine before and after the reveal, but only at night', TIMEOUT, async (t) => {
  const { code, first, second } = await dayRoom(t);
  const mine = (session) => ref(session.db, `discards/${code}/${session.uid}`);
  const pick = (fields = {}) => ({ table: '2', round: 1, cards: ['a01', 'a02'], seq: 1, at: serverTimestamp(), ...fields });
  await assert.rejects(set(mine(first), pick()), denied, 'not at night yet');
  await toNight(code, 1, { open: false });
  const badPicks = [
    [pick({ cards: [] }), 'no cards'],
    [pick({ cards: 'a01' }), 'cards are a list'],
    [pick({ cards: ['a01', 'no good'] }), 'card ids'],
    [pick({ cards: ['a01', 2] }), 'card ids are text'],
    [pick({ cards: Array(31).fill('a01') }), 'at most 30 cards'],
    [pick({ table: 2 }), 'the table is text'],
    [pick({ table: '3' }), 'a table without a game'],
    [pick({ round: 2 }), 'another round'],
    [pick({ seq: 0 }), 'seq starts at 1'],
    [pick({ at: Date.now() - 5000 }), 'a made-up time'],
    [pick({ extra: 1 }), 'no other fields'],
    [{ table: '2', round: 1, cards: ['a01'], seq: 1 }, 'no time'],
  ];
  for (const [value, label] of badPicks) await assert.rejects(set(mine(first), value), denied, label);
  await assert.rejects(set(ref(first.db, `discards/${code}/${second.uid}`), pick()), denied, 'only the player picks their own');
  await assert.rejects(set(mine(outsider), pick()), denied, 'no seat at that table');
  await set(mine(first), pick({ cards: Array(30).fill('a01') }));
  await set(mine(first), pick({ seq: 2 }));
  await assert.rejects(set(mine(first), pick({ seq: 2 })), denied, 'the same seq again');
  await assert.rejects(set(mine(first), null), denied, 'a pick cannot be deleted');
  await untilServerTime(first, (await read(first, `discards/${code}/${first.uid}`)).at + 50);
  await assert.rejects(update(mine(first), { cards: ['a03'] }), denied, 'one field: the old seq and time');
  await assert.rejects(update(mine(first), { 'cards/0': 'a03', seq: 3 }), denied, 'one card: the old time');
  await update(mine(first), { cards: ['a03'], seq: 3, at: serverTimestamp() });
  assert.deepEqual((await read(first, `discards/${code}/${first.uid}`)).cards, ['a03']);
  // 黑夜還沒開、選擇中、揭曉後都可以挑；推進到日出就不行。
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'opened');
  assert.equal(await requestDiscard(first, code, { table: 2, round: 1, cards: ['a04'] }), 4);
  assert.deepEqual(await revealNight(host, code, 2), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/2/night`);
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'revealed');
  assert.equal(await requestDiscard(first, code, { table: 2, round: 1, cards: ['a05'] }), 5, 'after the reveal too');
  await advanceTable(host, code, 2, { round: 1, phase: 'night' });
  await assert.rejects(requestDiscard(first, code, { table: 2, round: 2, cards: ['a06'] }), refused, 'not at sunrise');
});

test('the rules check every night field the hosts write', TIMEOUT, async (t) => {
  const { code, first, second, third } = await dayRoom(t);
  const game = `rooms/${code}/games/2`;
  let version = await read(host, `${game}/version`);
  const bumped = (session, writes) => update(ref(session.db), { ...writes, [`${game}/version`]: version + 1 });
  const accept = async (writes) => {
    await bumped(host, writes);
    version += 1;
  };
  const opened = { round: 1, openedAt: serverTimestamp(), submitted: 0 };
  await assert.rejects(bumped(host, { [`${game}/night`]: opened }), denied, 'only at night');
  await toNight(code, 1, { open: false });
  await assert.rejects(bumped(first, { [`${game}/night`]: opened }), denied, 'players cannot open a night');
  const badNights = [
    { ...opened, round: 2 },
    { ...opened, openedAt: Date.now() - 1000 },
    { ...opened, submitted: 7 },
    { ...opened, submitted: 1.5 },
    { ...opened, revealAt: Date.now() - 1000 },
    { ...opened, extra: 1 },
    { round: 1, submitted: 0 },
  ];
  for (const value of badNights) await assert.rejects(bumped(host, { [`${game}/night`]: value }), denied, JSON.stringify(value));
  await assert.rejects(update(ref(host.db), { [`${game}/night`]: opened }), denied, 'every write raises the version');
  await accept({ [`${game}/night`]: opened });
  await assert.rejects(bumped(host, { [`${game}/night/openedAt`]: serverTimestamp() }), denied, 'the night cannot be opened again');
  await assert.rejects(bumped(host, { [`${game}/night`]: null }), denied, 'the night cannot be removed');
  await accept({ [`${game}/night/submitted`]: 3 });

  // 截止時間：伺服器時間到 60 秒後之間；之後只能提早（改成現在），不能延後、不能拿掉。
  await assert.rejects(bumped(host, { [`${game}/night/revealAt`]: Date.now() - 5000 }), denied, 'a deadline in the past');
  await assert.rejects(bumped(host, { [`${game}/night/revealAt`]: Date.now() + 120_000 }), denied, 'a deadline too far away');
  await assert.rejects(bumped(host, { [`${game}/night/revealAt`]: Date.now() + 2000.5 }), denied, 'a fraction');
  const far = serverTime(host) + 30_000;
  await accept({ [`${game}/night/revealAt`]: far });
  await assert.rejects(bumped(host, { [`${game}/night/revealAt`]: far + 1000 }), denied, 'the deadline cannot move later');
  await assert.rejects(bumped(host, { [`${game}/night/revealAt`]: null }), denied, 'the deadline cannot be removed');
  const players = {
    [first.uid]: { choice: 'gamble', tiers: 2, rolls: [6, 2], bust: true, pounds: -2, influence: 0, sin: 0 },
    [second.uid]: { choice: 'split', pounds: 6, influence: 0, sin: 1 },
    [third.uid]: sleeping,
  };
  const reveal = (result = { players }, log = { players }) => ({ [`${game}/night/result`]: result, [`${game}/nightLog/1`]: log });
  await assert.rejects(bumped(host, reveal()), denied, 'no result before the deadline');
  await accept({ [`${game}/night/revealAt`]: serverTimestamp() });

  const player = (uid, fields) => ({ players: { ...players, [uid]: fields } });
  const badResults = [
    { extra: 1 },
    { players, extra: 1 },
    { players: { ...players, [outsider.uid]: sleeping } },
    player(first.uid, { choice: 'gamble', tiers: 2, bust: true, pounds: -2, influence: 0, sin: 0 }),
    player(first.uid, { choice: 'gamble', tiers: 2, rolls: [6, 2, 4], bust: true, pounds: -2, influence: 0, sin: 0 }),
    player(first.uid, { choice: 'gamble', tiers: 2, rolls: [6], bust: false, pounds: 5, influence: 0, sin: 0 }),
    player(first.uid, { choice: 'gamble', tiers: 4, rolls: [6, 6, 6], bust: false, pounds: 30, influence: 1, sin: 0 }),
    player(first.uid, { choice: 'gamble', tiers: 2, rolls: [7, 2], bust: true, pounds: -2, influence: 0, sin: 0 }),
    player(first.uid, { choice: 'gamble', tiers: 2, rolls: [0, 2], bust: true, pounds: -2, influence: 0, sin: 0 }),
    player(first.uid, { choice: 'gamble', tiers: 2, rolls: [6, 2], bust: 'yes', pounds: -2, influence: 0, sin: 0 }),
    player(second.uid, { choice: 'split', tiers: 1, pounds: 6, influence: 0, sin: 1 }),
    player(second.uid, { choice: 'split', pounds: 1.5, influence: 0, sin: 1 }),
    player(second.uid, { choice: 'split', pounds: 6, influence: -1, sin: 1 }),
    player(second.uid, { choice: 'split', pounds: 6, influence: 0, sin: -1 }),
    player(second.uid, { choice: 'split', pounds: 6, influence: 0 }),
    player(second.uid, { choice: 'steal', pounds: 6, influence: 0, sin: 1 }),
    player(third.uid, { ...sleeping, at: 1 }),
  ];
  for (const result of badResults) await assert.rejects(bumped(host, reveal(result, result)), denied, JSON.stringify(result));
  await assert.rejects(bumped(host, { [`${game}/night/result`]: { players } }), denied, 'the result comes with the log');
  await assert.rejects(bumped(host, { [`${game}/nightLog/1`]: { players } }), denied, 'the log comes with the result');
  await assert.rejects(bumped(host, { [`${game}/night/result`]: { players }, [`${game}/nightLog/2`]: { players } }), denied, 'the log key is this round');
  await accept({ ...reveal(), [`${game}/seats/${first.uid}/pounds`]: 13, [`${game}/seats/${second.uid}/sin`]: 1 });
  await assert.rejects(bumped(host, { [`${game}/night/result`]: { players: { [first.uid]: sleeping } } }), denied, 'a result is written once');
  await assert.rejects(bumped(host, { [`${game}/night/result`]: null }), denied, 'a result cannot be removed');
  await assert.rejects(bumped(host, { [`${game}/nightLog/1`]: { players } }), denied, 'a log entry is written once');
  await assert.rejects(bumped(host, { [`${game}/nightLog`]: null }), denied, 'the night log cannot be removed');
  await assert.rejects(bumped(host, { [`${game}/night`]: { round: 1, openedAt: serverTimestamp(), submitted: 0 } }), denied, 'the revealed night cannot be reopened');
  const stored = await read(host, game);
  assert.deepEqual([stored.night.result, stored.nightLog[1]], [{ players }, { players }]);

  // 下一回合的黑夜：回合變了而且在黑夜才能開，開的時候蓋掉上一回合的結果。
  for (const [round, phase] of [
    [1, 'night'],
    [2, 'sunrise'],
    [2, 'day'],
  ]) {
    await advanceTable(host, code, 2, { round, phase });
  }
  await assert.rejects(bumped(host, { [`${game}/night`]: { ...opened, round: 2 } }), denied, 'round 2 is not at night yet');
  await advanceTable(host, code, 2, { round: 2, phase: 'dusk' });
  // 開新回合的黑夜一定是剛開的：伺服器時間、0 人、沒有截止時間、沒有結果（不能沿用上一回合的時間，開的當下就截止或揭曉）。
  const { openedAt: oldOpened, revealAt: oldReveal } = stored.night;
  const badOpenings = [
    { round: 2, openedAt: oldOpened, submitted: 0 },
    { round: 2, openedAt: serverTimestamp(), submitted: 0, revealAt: oldReveal },
    { round: 2, openedAt: oldOpened, submitted: 0, revealAt: oldReveal },
    { round: 2, openedAt: serverTimestamp(), submitted: 1 },
  ];
  for (const value of badOpenings) await assert.rejects(bumped(host, { [`${game}/night`]: value }), denied, `opening ${JSON.stringify(value)}`);
  const atOnce = { [`${game}/night`]: { round: 2, openedAt: serverTimestamp(), submitted: 0, revealAt: serverTimestamp(), result: { players } }, [`${game}/nightLog/2`]: { players } };
  await assert.rejects(bumped(host, atOnce), denied, 'a night cannot open already revealed');
  await accept({ [`${game}/night`]: { ...opened, round: 2 } });
  assert.deepEqual(Object.keys(await read(host, `${game}/night`)).sort(), ['openedAt', 'round', 'submitted']);
});

test('everyone sends, the deadline is 1 second away, and the night reveals by itself on every screen with the right numbers', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await dayRoom(t);
  await toNight(code, 1, { open: false });
  const start = await readTable(code);
  const errorsSeen = [];
  const stop = startSettling(host, code, quick, { random: always(6), onError: (error) => errorsSeen.push(error) });
  t.after(stop);
  const opened = await watchers.p1.until((room) => room.games[2].night?.round === 1, 'the night opens by itself');
  assert.equal(opened.games[2].night.submitted, 0);

  await choose(first, code, 'split');
  await watchers.p3.until((room) => room.games[2].night.submitted === 1, 'one pick sent');
  await choose(second, code, 'split');
  await choose(first, code, 'gamble', 2); // 改：以最後一次為準
  await choose(third, code, 'sleep');
  const allIn = serverTime(host);
  const counting = await watchers.p2.until((room) => room.games[2].night.revealAt, 'everyone sent: the countdown starts');
  const { revealAt } = counting.games[2].night;
  assert.equal(counting.games[2].night.submitted, 3);
  assert.ok(revealAt >= allIn + 1000 - 300 && revealAt <= allIn + 1000 + 600, `the deadline is about 1 s after the last pick (${revealAt - allIn} ms)`);

  const views = await Promise.all(['host', 'p1', 'p2', 'p3'].map((name) => watchers[name].until((room) => room.games[2].night.result, `${name} sees the result`, 8000)));
  const shownAt = serverTime(host);
  assert.ok(shownAt >= nightSettleAt({ revealAt }) - 200 && shownAt < revealAt + 4000, `revealed ${shownAt - revealAt} ms after the deadline`);
  const expected = {
    players: {
      [first.uid]: { choice: 'gamble', tiers: 2, rolls: [6, 6], bust: false, pounds: 20, influence: 1, sin: 0 },
      [second.uid]: { choice: 'split', pounds: 6, influence: 0, sin: 1 },
      [third.uid]: sleeping,
    },
  };
  for (const view of views) assert.deepEqual(view.games[2].night.result, expected);
  const final = await readTable(code);
  assert.deepEqual(final.game.nightLog[1], expected);
  assert.equal(Object.values(final.game.nightLog).filter(Boolean).length, 1);
  const was = (uid, key) => start.game.seats[uid][key] ?? 0;
  assert.deepEqual(stats(final.game, 'pounds'), { [first.uid]: was(first.uid, 'pounds') + 20, [second.uid]: was(second.uid, 'pounds') + 6, [third.uid]: was(third.uid, 'pounds') });
  assert.deepEqual(stats(final.game, 'influence'), { [first.uid]: was(first.uid, 'influence') + 1, [second.uid]: was(second.uid, 'influence'), [third.uid]: was(third.uid, 'influence') });
  assert.deepEqual(stats(final.game, 'sin'), { [first.uid]: undefined, [second.uid]: 1, [third.uid]: undefined });
  assert.deepEqual([final.table.fog, final.game.fogMax, final.game.eventLog], [start.table.fog, start.game.fogMax, start.game.eventLog], 'the night leaves the fog alone');
  // 開黑夜、已送出人數（1 人；後面幾筆靠得近時可能併成一次，最後一次連同截止時間）、揭曉。
  const writes = final.game.version - start.game.version;
  assert.ok(writes >= 4 && writes <= 5, `${writes} writes`);
  await watchers.p1.until((room) => room.games[2].seats[second.uid].sin === 1, 'p1 sees the new sin without reloading');
  await advanceTable(host, code, 2, { round: 1, phase: 'night' });
  await sleep(300);
  assert.equal((await readTable(code)).game.version, final.game.version, 'nothing more happens at sunrise until the deal');
  assert.deepEqual(errorsSeen, []);
});

test('the host reveals early: the deadline is now, whoever has not sent sleeps, and a lone splitter takes all 6', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await nightRoom(t);
  const start = await readTable(code);
  await choose(first, code, 'split');
  await choose(second, code, 'split');
  assert.equal(await choose(first, code, 'gamble', 1), 2);
  const askedAt = serverTime(host);
  assert.deepEqual(await revealNight(host, code, 2), { closed: true });
  assert.deepEqual(await revealNight(host, code, 2), { closed: false }, 'already closed');
  const { revealAt, submitted } = await read(host, `rooms/${code}/games/2/night`);
  assert.ok(revealAt >= askedAt - 1000 && revealAt <= serverTime(host) + 1000, 'the deadline is the server time');
  assert.equal(submitted, 0, 'the host here did not count yet');
  await assert.rejects(choose(third, code, 'split'), refused, 'too late to choose');
  assert.deepEqual(await settleNight(host, code, 2, data), { outcome: 'counted', result: null }, 'before the grace is over, only the count');
  assert.deepEqual(await settleNight(host, code, 2, data), { outcome: 'waiting', result: null });
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  const { outcome, result } = await settleNight(host, code, 2, data, dice(1));
  assert.equal(outcome, 'revealed');
  assert.deepEqual(result.players, {
    [first.uid]: { choice: 'gamble', tiers: 1, rolls: [1], bust: true, pounds: -2, influence: 0, sin: 0 },
    [second.uid]: { choice: 'split', pounds: 6, influence: 0, sin: 1 },
    [third.uid]: missedSleep,
  });
  const final = await readTable(code);
  assert.deepEqual(final.game.nightLog[1], result, 'the log marks the missed one too');
  const was = (uid) => start.game.seats[uid].pounds;
  assert.deepEqual(stats(final.game, 'pounds'), { [first.uid]: was(first.uid) - 2, [second.uid]: was(second.uid) + 6, [third.uid]: was(third.uid) });
  await watchers.p2.until((room) => room.games[2].night.result?.players?.[second.uid]?.pounds === 6, 'second sees the result');
  assert.deepEqual(await settleNight(host, code, 2, data), { outcome: 'none', result: null }, 'revealed once');
  assert.deepEqual(await revealNight(host, code, 2), { closed: false });
});

test('two hosts revealing at once write only once, and two automatic hosts open the next night once', TIMEOUT, async (t) => {
  const { code, first, second, third } = await dayRoom(t);
  const seenByBackup = watch(backup, code);
  t.after(() => seenByBackup.stop());
  await enterAsHost(backup, code);
  await approveHost(host, code, backup.uid);
  await toNight(code, 1, { open: false });
  const start = await readTable(code);
  await seenByBackup.until((room) => room.hosts?.[backup.uid] === true && room.tables[2].phase === 'night', 'backup sees the table');
  const opened = await Promise.all([settleNight(host, code, 2, quick), settleNight(backup, code, 2, quick)]);
  assert.deepEqual(opened.map((result) => result.outcome).sort(), ['opened', 'waiting'], 'the other host finds the night already open');
  await Promise.all([choose(first, code, 'gamble', 1), choose(second, code, 'split'), choose(third, code, 'split')]);
  assert.equal((await settleNight(host, code, 2, quick)).outcome, 'counted');
  const { revealAt } = await read(host, `rooms/${code}/games/2/night`);
  await seenByBackup.until((room) => room.games[2].night.revealAt === revealAt, 'backup sees the deadline');
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  const results = await Promise.all([settleNight(host, code, 2, quick, always(6)), settleNight(backup, code, 2, quick, always(6))]);
  assert.deepEqual(results.map((result) => result.outcome).sort(), ['none', 'revealed']);
  const now = await readTable(code);
  assert.equal(now.game.version, start.game.version + 3, 'opened, counted and revealed once each');
  const was = (uid) => start.game.seats[uid].pounds;
  assert.deepEqual(stats(now.game, 'pounds'), { [first.uid]: was(first.uid) + 5, [second.uid]: was(second.uid) + 3, [third.uid]: was(third.uid) + 3 }, 'paid once');
  assert.deepEqual(stats(now.game, 'sin'), { [first.uid]: undefined, [second.uid]: 1, [third.uid]: 1 }, 'sin once');

  // 下一回合：兩台都開著自動化，黑夜只開一次、揭曉只一次。
  await advanceTable(host, code, 2, { round: 1, phase: 'night' });
  assert.equal((await processSunrise(host, code, 2, quick)).dealt, true);
  await toNight(code, 2, { from: 'sunrise', open: false });
  const errorsSeen = [];
  const stops = [host, backup].map((session) => startSettling(session, code, quick, { random: always(6), onError: (error) => errorsSeen.push(error) }));
  t.after(() => stops.forEach((stop) => stop()));
  await seenByBackup.until((room) => room.games[2].night?.round === 2, 'the round 2 night opens', 8000);
  const before2 = await readTable(code);
  await Promise.all([choose(first, code, 'sleep', null, 2), choose(second, code, 'gamble', 3, 2), choose(third, code, 'sleep', null, 2)]);
  await seenByBackup.until((room) => room.games[2].night.result, 'round 2 is revealed', 8000);
  await sleep(300); // 讓晚到的另一台有機會（錯誤地）再寫一次
  const final = await readTable(code);
  assert.ok(final.game.version <= before2.game.version + 4 && final.game.version >= before2.game.version + 2, `version ${final.game.version - before2.game.version}`);
  assert.equal(final.game.seats[second.uid].pounds, before2.game.seats[second.uid].pounds + 30, 'the treasure paid once');
  assert.deepEqual([final.game.nightLog[1].players[first.uid].choice, final.game.nightLog[2].players[second.uid].rolls], ['gamble', [6, 6, 6]]);
  assert.deepEqual(errorsSeen, []);
});

test('a pick changed while the host was offline still counts: the host asks the server again at the reveal', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await dayRoom(t);
  await toNight(code, 1, { open: false });
  const errorsSeen = [];
  const stop = startSettling(host, code, data, { random: always(6), onError: (error) => errorsSeen.push(error) }); // 揭曉倒數 3 秒
  t.after(stop);
  await watchers.p1.until((room) => room.games[2].night?.round === 1, 'the night opens');
  await choose(first, code, 'gamble', 1);
  await choose(second, code, 'split');
  await choose(third, code, 'sleep');
  const counting = await watchers.host.until((room) => room.games[2].night.revealAt, 'the countdown starts');
  const { revealAt } = counting.games[2].night;
  // 等主持端寫截止時間的那筆收到伺服器確認、自動化閒下來（問一次伺服器就知道），再斷線：它的快取停在 first 豪賭，
  // 計時器照樣在截止＋緩衝時叫醒它。
  await read(host, `nights/${code}`);
  await sleep(100);
  goOffline(host.db);
  t.after(() => goOnline(host.db));
  assert.ok(serverTime(first) < revealAt - 500, 'still time to change the pick');
  await choose(first, code, 'split');
  await untilServerTime(first, nightSettleAt({ revealAt }) + 700);
  goOnline(host.db);
  const done = await watchers.p2.until((room) => room.games[2].night.result, 'revealed after the host is back', 8000);
  assert.deepEqual(done.games[2].night.result.players[first.uid], { choice: 'split', pounds: 3, influence: 0, sin: 1 }, 'the changed pick, read from the server');
  assert.deepEqual(done.games[2].night.result.players[second.uid], { choice: 'split', pounds: 3, influence: 0, sin: 1 });
  assert.ok(serverTime(host) >= revealAt + NIGHT_GRACE_MS, 'not before the deadline and the grace');
  assert.deepEqual(errorsSeen, []);
});

test('a host working from a stale copy of the room (offline while the table moved on) gives up at once instead of waiting', TIMEOUT, async (t) => {
  const { code } = await dayRoom(t);
  const seenByBackup = watch(backup, code);
  t.after(() => seenByBackup.stop());
  await enterAsHost(backup, code);
  await approveHost(host, code, backup.uid);
  await toNight(code, 1, { open: false });
  await seenByBackup.until((room) => room.hosts?.[backup.uid] === true && room.tables[2].phase === 'night', 'backup sees the night');
  // 備援機斷線時桌子被推進到第 2 回合日出；它照快取（還在黑夜）算「開黑夜」，連回來寫入時被規則擋下，
  // 這時看到回合與階段變了就重讀、放手，不用等 3 秒再報錯。
  goOffline(backup.db);
  t.after(() => goOnline(backup.db));
  await advanceTable(host, code, 2, { round: 1, phase: 'night' });
  const settling = settleNight(backup, code, 2, data);
  await sleep(200);
  const back = Date.now();
  goOnline(backup.db);
  assert.deepEqual(await settling, { outcome: 'none', result: null });
  assert.ok(Date.now() - back < 2500, `gave up in ${Date.now() - back} ms, not after a 3 s wait`);
  assert.equal((await read(host, `rooms/${code}/games/2`)).night, undefined, 'no night was opened for the old round');
});

test('a reveal turned down because the host clock runs ahead is tried again a few seconds later instead of hanging', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await dayRoom(t);
  await toNight(code, 1, { open: false });
  const errorsSeen = [];
  const stop = startSettling(host, code, quick, { random: always(6), onError: (error) => errorsSeen.push(error) });
  t.after(stop);
  await watchers.p1.until((room) => room.games[2].night?.round === 1, 'the night opens');
  // 主持端估的伺服器時間比實際快 6 秒（例如裝置時鐘在連線之後被校正）：它在截止前就去揭曉，被規則擋下，試三次就放棄；
  // 之後隔 5 秒再試，伺服器時間過了截止就揭曉成功。
  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
  });
  Date.now = () => realNow() + 6000;
  await Promise.all([choose(first, code, 'split'), choose(second, code, 'split'), choose(third, code, 'sleep')]);
  const done = await watchers.p2.until((room) => room.games[2].night.result, 'revealed after a later try', 20_000);
  Date.now = realNow;
  assert.ok(errorsSeen.length >= 1, 'the early tries were turned down and reported');
  assert.deepEqual(done.games[2].night.result.players[first.uid], { choice: 'split', pounds: 3, influence: 0, sin: 1 });
});

test('a 0-second countdown closes at the server time once everyone has sent', TIMEOUT, async (t) => {
  const { code, first, second, third } = await nightRoom(t);
  const instant = { ...data, settings: { ...data.settings, nightRevealSeconds: 0 } };
  await Promise.all([choose(first, code, 'sleep'), choose(second, code, 'sleep'), choose(third, code, 'gamble', 1)]);
  const before = serverTime(host);
  assert.equal((await settleNight(host, code, 2, instant)).outcome, 'counted');
  const { revealAt, submitted } = await read(host, `rooms/${code}/games/2/night`);
  assert.equal(submitted, 3);
  assert.ok(revealAt >= before - 1000 && revealAt <= serverTime(host) + 1000, 'the deadline is the server time of the write');
  await assert.rejects(choose(first, code, 'split'), refused, 'closed at once');
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  const { outcome, result } = await settleNight(host, code, 2, instant, dice(4));
  assert.equal(outcome, 'revealed');
  assert.deepEqual(result.players[third.uid], { choice: 'gamble', tiers: 1, rolls: [4], bust: false, pounds: 5, influence: 0, sin: 0 });
});

test('hand limit: the next sunrise discards the picked cards first, discards at random for whoever did not pick, then pays and draws', TIMEOUT, async (t) => {
  // 黑夜還沒開就挑（規則只要求在黑夜）；主持端畫面逐人訂閱挑的棄牌，發牌時讀整房要問伺服器、不能吃這些訂閱的快取。
  const { code, watchers, first, second, third } = await dayRoom(t);
  await toNight(code, 1, { open: false });
  // 主持端把手牌排成 first 9 張、second 8 張、third 9 張，其餘照資料順序放回牌庫、棄牌堆清空（牌的總數不變）。
  const cards = buildDeck(data.actions);
  const hands = { [first.uid]: cards.slice(0, 9), [second.uid]: cards.slice(9, 17), [third.uid]: cards.slice(17, 26) };
  const deck = cards.slice(26);
  const game = await read(host, `rooms/${code}/games/2`);
  const writes = {
    [`rooms/${code}/games/2/version`]: game.version + 1,
    [`rooms/${code}/games/2/deckCount`]: deck.length,
    [`rooms/${code}/games/2/discardCount`]: 0,
    [`hostOnly/${code}/2/deck`]: deck,
    [`hostOnly/${code}/2/discard`]: [],
  };
  for (const [uid, hand] of Object.entries(hands)) {
    writes[`private/${code}/${uid}/hand`] = hand;
    writes[`rooms/${code}/games/2/seats/${uid}/handCount`] = hand.length;
  }
  await update(ref(host.db), writes);
  const hostViews = [first, third].map((session) => watch(host, code, (who, roomCode, onDiscard) => watchDiscard(who, roomCode, onDiscard, undefined, session.uid)));
  t.after(() => hostViews.forEach((view) => view.stop()));

  const picked = [hands[first.uid][8], hands[first.uid][0]];
  await requestDiscard(first, code, { table: 2, round: 1, cards: [hands[first.uid][3]] }); // 先挑錯張數，再改
  await hostViews[0].until((value) => value?.seq === 1, 'the host screen sees the first pick');
  assert.equal(await requestDiscard(first, code, { table: 2, round: 1, cards: picked }), 2);
  await requestDiscard(third, code, { table: 2, round: 1, cards: [hands[third.uid][0]] }); // 張數不對：照亂數棄
  await hostViews[0].until((value) => value?.seq === 2, 'the host screen sees the new pick');
  await hostViews[1].until((value) => value?.seq === 1, 'the host screen sees third’s pick');
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'opened', 'the night opens after the picks');
  const start = await readTable(code);
  await advanceTable(host, code, 2, { round: 1, phase: 'night' });
  assert.deepEqual(await processSunrise(host, code, 2, data, seededRandom(5)), { dealt: true, round: 2 });

  const after2 = await readTable(code);
  const handOf = (uid) => read(host, `private/${code}/${uid}/hand`);
  const [firstHand, secondHand, thirdHand] = await Promise.all([first, second, third].map((session) => handOf(session.uid)));
  const kept = hands[first.uid].filter((card, index) => index !== 0 && index !== 8);
  assert.deepEqual(firstHand, [...kept, deck[0], deck[1]], 'first: the picked two, then the top two of the deck');
  assert.deepEqual(secondHand.slice(7), [deck[2], deck[3]], 'second: drew after the discard');
  assert.deepEqual(thirdHand.slice(7), [deck[4], deck[5]]);
  const lost = (hand, now) => {
    const left = [...now];
    return hand.filter((card) => (left.includes(card) ? (left.splice(left.indexOf(card), 1), false) : true));
  };
  const secondLost = lost(hands[second.uid], secondHand.slice(0, 7));
  const thirdLost = lost(hands[third.uid], thirdHand.slice(0, 7));
  assert.deepEqual([secondLost.length, thirdLost.length], [1, 2], 'second down to 7 at random; third’s pick had the wrong count');
  // 被亂數棄的人：同一筆寫入記下棄了哪幾張（照手牌原本的順序），只有本人（與主持端）讀得到；照挑的棄的人不記。
  assert.deepEqual(await read(second, `private/${code}/${second.uid}/randomDiscard`), { round: 2, cards: secondLost }, 'second reads the own random discard');
  assert.deepEqual(await read(third, `private/${code}/${third.uid}/randomDiscard`), { round: 2, cards: thirdLost }, 'third too: the pick had the wrong count');
  assert.equal(await read(first, `private/${code}/${first.uid}/randomDiscard`), null, 'first discarded as picked: nothing listed');
  assert.deepEqual((await read(host, `private/${code}/${third.uid}`)).randomDiscard, { round: 2, cards: thirdLost }, 'the host reads it');
  for (const [session, path] of [
    [first, `private/${code}/${second.uid}/randomDiscard`],
    [third, `private/${code}/${second.uid}/randomDiscard`],
    [second, `private/${code}/${third.uid}/randomDiscard`],
    [outsider, `private/${code}/${second.uid}/randomDiscard`],
    [outsider, `private/${code}`],
  ]) {
    await assert.rejects(get(ref(session.db, path)), denied, `${path} is not for this player`);
  }
  assert.deepEqual(after2.pile.discard, [...picked, ...secondLost, ...thirdLost], 'into the discard pile in seat order');
  assert.deepEqual(after2.pile.deck, deck.slice(6));
  assert.deepEqual([after2.game.deckCount, after2.game.discardCount], [deck.length - 6, 5]);
  assert.deepEqual(stats(after2.game, 'handCount'), { [first.uid]: 9, [second.uid]: 9, [third.uid]: 9 });
  for (const session of [first, second, third]) assert.equal(after2.game.seats[session.uid].pounds, start.game.seats[session.uid].pounds + 5, 'paid after the discard');
  assert.equal(after2.game.version, start.game.version + 1, 'one write');
  await watchers.p1.until((room) => room.games[2].seats[first.uid].handCount === 9 && room.tables[2].phase === 'sunrise', 'every screen sees the new hand counts');
  assert.deepEqual(await read(first, `private/${code}/${first.uid}/hand`), firstHand, 'first sees their own new hand');
  // 下一回合：上一回合挑的棄牌不再算（回合不對），超過上限的照亂數棄。
  await toNight(code, 2, { from: 'sunrise', open: false });
  await advanceTable(host, code, 2, { round: 2, phase: 'night' });
  assert.deepEqual(await processSunrise(host, code, 2, data, seededRandom(6)), { dealt: true, round: 3 });
  const firstHand3 = await handOf(first.uid);
  assert.equal(firstHand3.length, 9);
  assert.ok(firstHand3.slice(0, 7).every((card) => firstHand.includes(card)));
  assert.deepEqual(await read(first, `private/${code}/${first.uid}/randomDiscard`), { round: 3, cards: lost(firstHand, firstHand3.slice(0, 7)) }, 'first, at random this time');
  assert.equal((await read(second, `private/${code}/${second.uid}/randomDiscard`)).round, 3, 'a new random discard replaces the old one');
});

test('the rules: missed is only true and only with a sleep, in the result and in the log; players cannot write it; a one-field update cannot add it', TIMEOUT, async (t) => {
  const { code, first, second, third } = await nightRoom(t);
  const game = `rooms/${code}/games/2`;
  assert.deepEqual(await revealNight(host, code, 2), { closed: true });
  let version = await read(host, `${game}/version`);
  const bumped = (session, writes) => update(ref(session.db), { ...writes, [`${game}/version`]: version + 1 });
  await untilServerTime(host, (await read(host, `${game}/night/revealAt`)) + 50);
  const players = {
    [first.uid]: { choice: 'gamble', tiers: 1, rolls: [4], bust: false, pounds: 5, influence: 0, sin: 0 },
    [second.uid]: { choice: 'sleep', pounds: 0, influence: 0, sin: 0 },
    [third.uid]: missedSleep,
  };
  const reveal = (result, log = result) => ({ [`${game}/night/result`]: result, [`${game}/nightLog/1`]: log });
  const player = (uid, fields) => ({ players: { ...players, [uid]: fields } });
  const badResults = [
    [player(third.uid, { ...missedSleep, missed: false }), 'missed: false'],
    [player(third.uid, { ...missedSleep, missed: 'true' }), 'missed as text'],
    [player(third.uid, { ...missedSleep, missed: 1 }), 'missed as a number'],
    [player(first.uid, { ...players[first.uid], missed: true }), 'missed with a gamble'],
    [player(second.uid, { choice: 'split', missed: true, pounds: 6, influence: 0, sin: 1 }), 'missed with a split'],
  ];
  for (const [result, label] of badResults) {
    await assert.rejects(bumped(host, reveal(result)), denied, `${label}: result and log`);
    await assert.rejects(bumped(host, reveal(result, { players })), denied, `${label}: in the result only`);
    await assert.rejects(bumped(host, reveal({ players }, result)), denied, `${label}: in the log only`);
  }
  await assert.rejects(bumped(first, reveal({ players })), denied, 'players cannot write the result');
  await assert.rejects(bumped(third, reveal({ players })), denied, 'not even the one marked missed');
  await bumped(host, reveal({ players }));
  version += 1;
  const stored = await read(first, game);
  assert.deepEqual([stored.night.result.players[third.uid], stored.nightLog[1].players[third.uid]], [missedSleep, missedSleep], 'everyone reads the mark');
  assert.equal(stored.night.result.players[second.uid].missed, undefined, 'a chosen sleep has no mark');
  // 寫好之後只改一個欄位：加上 missed、把 missed 的人改成分贓、拿掉 missed，都被拒。
  const oneField = [
    [{ [`${game}/night/result/players/${second.uid}/missed`]: true }, 'mark a chosen sleep in the result'],
    [{ [`${game}/nightLog/1/players/${second.uid}/missed`]: true }, 'mark a chosen sleep in the log'],
    [{ [`${game}/night/result/players/${first.uid}/missed`]: true }, 'mark a gamble'],
    [{ [`${game}/nightLog/1/players/${third.uid}/choice`]: 'split' }, 'turn the missed one into a split'],
    [{ [`${game}/night/result/players/${third.uid}/missed`]: null }, 'drop the mark'],
  ];
  for (const [writes, label] of oneField) await assert.rejects(bumped(host, writes), denied, label);
  await assert.rejects(update(ref(host.db, `${game}/nightLog/1/players/${third.uid}`), { missed: false }), denied, 'an update below the version');
  assert.deepEqual((await read(host, game)).nightLog[1], { players }, 'nothing changed');
});

test('the rules: a random discard is written by the hosts only and read by the player alone; the round and the card ids are checked, field by field too', TIMEOUT, async (t) => {
  const { code, first, second } = await dayRoom(t);
  const mine = `private/${code}/${first.uid}/randomDiscard`;
  const at = (session, path = mine) => ref(session.db, path);
  const good = { round: 2, cards: ['a01', 'a03'] };
  const bad = [
    [{ round: 0, cards: ['a01'] }, 'round from 1'],
    [{ round: 1.5, cards: ['a01'] }, 'a whole round'],
    [{ round: '2', cards: ['a01'] }, 'the round is a number'],
    [{ round: 2, cards: [] }, 'at least one card'],
    [{ round: 2, cards: 'a01' }, 'cards are a list'],
    [{ round: 2, cards: ['a01', 'no good'] }, 'card ids'],
    [{ round: 2, cards: ['a01', 2] }, 'card ids are text'],
    [{ round: 2, cards: { x: 'a01' } }, 'list positions only'],
    [{ round: 2 }, 'no cards'],
    [{ cards: ['a01'] }, 'no round'],
    [{ ...good, picked: false }, 'no other fields'],
  ];
  for (const [value, label] of bad) await assert.rejects(set(at(host), value), denied, label);
  await assert.rejects(set(at(first), good), denied, 'the player cannot write it');
  await assert.rejects(set(at(second), good), denied, 'nor anyone else at the table');
  await set(at(host), good);
  assert.deepEqual(await read(first, mine), good);
  for (const session of [second, outsider]) await assert.rejects(get(at(session)), denied, 'only the player reads it');
  // 只改一個欄位也要整筆合法。
  await assert.rejects(update(at(host), { round: 0 }), denied, 'one field: the round');
  await assert.rejects(update(at(host), { 'cards/1': 'no good' }), denied, 'one card');
  await assert.rejects(update(at(host), { 'cards/x': 'a05' }), denied, 'one card at a made-up position');
  await assert.rejects(update(at(host), { extra: 1 }), denied, 'one more field');
  await assert.rejects(update(at(host, `private/${code}/${first.uid}`), { randomDiscard: { round: 2 } }), denied, 'from the parent');
  await update(at(host), { round: 3 });
  assert.deepEqual(await read(first, mine), { ...good, round: 3 });
  await assert.rejects(update(at(first), { round: 4 }), denied, 'the player cannot change it');
});
