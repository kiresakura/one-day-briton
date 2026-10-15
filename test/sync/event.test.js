// 事件的同步與權限測試：開局與日出翻一般事件、翻完重洗、事件紀錄與一般事件牌堆的權限與規則、白晝出牌與黃昏法案讓迷霧越過門檻
// 時迷霧事件在同一筆寫入結算、兩台主持端同時日出、「偷」經過真的出牌與響應流程（npm run test:sync）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get, ref, set, update } from 'firebase/database';
import { buildDeck, duskSettleAt, eventLogList, responseSettleAt, seatsInOrder, seededRandom } from '../../play/js/game.js';
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
  requestPlay,
  requestRespond,
  revealDusk,
  serverTime,
  settleDusk,
  settleRequest,
  settleWindow,
  startTable,
  watchRoom,
} from '../../play/js/store.js';

const TIMEOUT = { timeout: 30_000 };
const denied = /permission[_ ]denied/i;
const cardDir = new URL('../../play/data/', import.meta.url);
const { data: fileData, errors } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
assert.deepEqual(errors, []);
assert.equal(fileData.settings.sunriseEvents, 1, 'one deck event per sunrise (the default when settings.json does not say)');

// 測試用的事件（只改這份資料物件，不改資料檔）：一般事件全體英鎊 +1／+2／+3，看數字就知道翻到哪一張；
// 迷霧事件 30＝全體英鎊 −1、r2 影響力 +1，60＝全體影響力 −1，90＝全體英鎊 −2。
const deckEvent = (id, amount) => ({ id, name: `事件${id}`, year: '1851', kind: 'deck', effects: [{ op: 'pounds', target: 'all', amount }], text: `${id} 牌面` });
const fogEvent = (id, threshold, effects) => ({ id, name: `迷霧${id}`, year: null, kind: 'fog', threshold, effects, text: `${id} 牌面` });
const EVENTS = [
  deckEvent('t1', 1),
  deckEvent('t2', 2),
  deckEvent('t3', 3),
  fogEvent('t30', 30, [{ op: 'pounds', target: 'all', amount: -1 }, { op: 'influence', target: 'role', role: 'r2', amount: 1 }]),
  fogEvent('t60', 60, [{ op: 'influence', target: 'all', amount: -1 }]),
  fogEvent('t90', 90, [{ op: 'pounds', target: 'all', amount: -2 }]),
];
const GAIN = { t1: 1, t2: 2, t3: 3 };
const data = { ...fileData, events: EVENTS };
// 迷霧與偷的測試：日出不翻一般事件，數字只看這一張牌；出牌當下結算（instant）或響應窗口 1 秒（quick）、黃昏倒數 1 秒。
const instant = { ...data, settings: { ...data.settings, sunriseEvents: 0, responseSeconds: 0, duskRevealSeconds: 1 } };
// 偷（企劃要改的 a15、a25 的測試複本）：a15 從 @指定 偷 3 英鎊；a25 從 @出牌者 偷 2 英鎊（響應卡）。
const actionOf = (id) => fileData.actions.find((action) => action.id === id);
assert.deepEqual([actionOf('a15').category, actionOf('a25').kind, actionOf('a25').respondsTo, actionOf('a03').category], ['犯罪', 'response', ['交易', '生產'], '交易']);
const quick = {
  ...instant,
  settings: { ...instant.settings, responseSeconds: 1 },
  actions: fileData.actions.map((action) => {
    if (action.id === 'a15') return { ...action, effects: [{ op: 'steal', resource: 'pounds', target: 'chosen', amount: 3 }] };
    if (action.id === 'a25') return { ...action, effects: [{ op: 'steal', resource: 'pounds', target: 'originalPlayer', amount: 2 }] };
    return action;
  }),
};

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

// 訂閱並記住最新狀態與看過的每一個狀態；until() 等到條件成立，逾時就失敗。
function watch(session, code) {
  let latest;
  const history = [];
  const waiters = new Set();
  const stop = watchRoom(session, code, (value) => {
    latest = value;
    history.push(value);
    for (const check of [...waiters]) check();
  });
  return {
    stop,
    history,
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

async function untilServerTime(session, at) {
  for (let left = at - serverTime(session); left > 0; left = at - serverTime(session)) await sleep(Math.min(left + 5, 250));
}

// 開一間新房，p1、p2、p3 在第 2 桌、outsider 在第 3 桌。
async function openRoom(t) {
  const code = await createRoom(host);
  await joinRoom(p1, code, 'P1', 2);
  await joinRoom(p2, code, 'P2', 2);
  await joinRoom(p3, code, 'P3', 2);
  await joinRoom(outsider, code, 'Outsider', 3);
  const watchers = Object.fromEntries([['host', host], ['p1', p1], ['p2', p2]].map(([name, session]) => [name, watch(session, code)]));
  t.after(() => Object.values(watchers).forEach((watcher) => watcher.stop()));
  await watchers.host.until((room) => Object.keys(room.players ?? {}).length === 4, 'host sees four players');
  return { code, watchers };
}

// 推進 count 步（照伺服器現況）。
async function advance(code, count) {
  for (let step = 0; step < count; step += 1) {
    const table = await read(host, `rooms/${code}/tables/2`);
    assert.equal((await advanceTable(host, code, 2, table)).advanced, true);
  }
}

// 開局（cardData）、推進到第 1 回合白晝；照座位排出 first、second、third，階層改成 r1、r2、r3（開局是隨機的），
// 該桌迷霧值設成 fog。
async function dayRoom(t, cardData, { fog = 0, billDeck = null } = {}) {
  const room = await openRoom(t);
  const { code } = room;
  assert.deepEqual(await startTable(host, code, 2, cardData, seededRandom(1)), { started: true });
  await advance(code, 1);
  const game = await read(host, `rooms/${code}/games/2`);
  const [first, second, third] = seatsInOrder(game.seats).map(([uid]) => [p1, p2, p3].find((session) => session.uid === uid));
  const writes = { [`rooms/${code}/games/2/version`]: game.version + 1, [`rooms/${code}/tables/2/fog`]: fog };
  [first, second, third].forEach((session, index) => (writes[`rooms/${code}/games/2/seats/${session.uid}/role`] = `r${index + 1}`));
  if (billDeck) writes[`hostOnly/${code}/2/billDeck`] = billDeck;
  await update(ref(host.db), writes);
  return { ...room, first, second, third };
}

// 主持端把指定的牌發到每個人手上，其餘的牌照資料順序放回牌庫、棄牌堆清空（牌的總數不變）；牌庫與棄牌堆分開寫。
async function arrange(code, hands, cardData) {
  const game = await read(host, `rooms/${code}/games/2`);
  const deck = buildDeck(cardData.actions);
  for (const cards of Object.values(hands)) for (const id of cards) deck.splice(deck.indexOf(id), 1);
  const writes = {
    [`rooms/${code}/games/2/version`]: game.version + 1,
    [`rooms/${code}/games/2/deckCount`]: deck.length,
    [`rooms/${code}/games/2/discardCount`]: 0,
    [`hostOnly/${code}/2/deck`]: deck,
    [`hostOnly/${code}/2/discard`]: [],
  };
  for (const [uid, cards] of Object.entries(hands)) {
    writes[`private/${code}/${uid}/hand`] = cards;
    writes[`rooms/${code}/games/2/seats/${uid}/handCount`] = cards.length;
  }
  await update(ref(host.db), writes);
}

const stats = (game, key) => Object.fromEntries(Object.entries(game.seats).map(([uid, seat]) => [uid, seat[key]]));
const sum = (game, key) => Object.values(game.seats).reduce((total, seat) => total + seat[key], 0);
const allSame = (game, key, value) => Object.values(game.seats).every((seat) => seat[key] === value);

test('the opening flips the first deck event in the same write, each sunrise flips the next, and an empty pile is reshuffled', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoom(t);
  assert.deepEqual(await startTable(host, code, 2, data, seededRandom(1)), { started: true });
  // 玩家看到的第一個局面就已經有第 1 回合的一般事件（跟開局同一筆寫入）。
  const opened = await watchers.p1.until((room) => room.games?.[2], 'p1 sees the game');
  const [firstEvent, ...more] = eventLogList(opened.games[2].eventLog);
  assert.deepEqual(more, []);
  assert.deepEqual({ ...firstEvent, event: firstEvent.event in GAIN }, { round: 1, phase: 'sunrise', event: true, kind: 'deck' });
  assert.equal(opened.games[2].version, 1);
  assert.ok(allSame(opened.games[2], 'pounds', 15 + GAIN[firstEvent.event]), 'everyone got the event after the first sunrise pay');
  assert.doesNotMatch(JSON.stringify(opened), /"eventDeck"|"deck":|"discard":|"hand":/);
  let pile = await read(host, `hostOnly/${code}/2`);
  assert.deepEqual([...pile.eventDeck, firstEvent.event].sort(), ['t1', 't2', 't3']);
  await assert.rejects(get(ref(p1.db, `hostOnly/${code}/2/eventDeck`)), denied, 'players cannot see the event pile');

  let pounds = 15 + GAIN[firstEvent.event];
  const log = [firstEvent.event];
  for (const round of [2, 3, 4]) {
    await advance(code, 4);
    const before = await read(host, `rooms/${code}/games/2`);
    assert.deepEqual(await processSunrise(host, code, 2, data, seededRandom(round)), { dealt: true, round });
    const game = await read(host, `rooms/${code}/games/2`);
    const entries = eventLogList(game.eventLog);
    assert.equal(entries.length, round);
    const flipped = entries[round - 1];
    if (round < 4) assert.equal(flipped.event, pile.eventDeck[0], 'the top of the pile');
    assert.deepEqual(flipped, { round, phase: 'sunrise', event: flipped.event, kind: 'deck' });
    pounds += 5 + GAIN[flipped.event];
    assert.ok(allSame(game, 'pounds', pounds), `round ${round}: salary then the event`);
    assert.equal(game.version, before.version + 1, 'one write');
    log.push(flipped.event);
    pile = await read(host, `hostOnly/${code}/2`);
    if (round === 2) assert.equal(pile.eventDeck.length, 1);
    if (round === 3) assert.equal(pile.eventDeck, undefined, 'all three flipped');
    if (round === 4) assert.deepEqual([...pile.eventDeck, flipped.event].sort(), ['t1', 't2', 't3'], 'reshuffled from all deck events');
    assert.ok(pile.deck && pile.billDeck === undefined, 'the card deck is still there');
  }
  assert.deepEqual([...log.slice(0, 3)].sort(), ['t1', 't2', 't3'], 'each event once before the reshuffle');
});

test('rules: only hosts write the event log, entries are checked as a whole, and written entries never change or go away', TIMEOUT, async (t) => {
  const { code } = await openRoom(t);
  assert.deepEqual(await startTable(host, code, 2, data, seededRandom(1)), { started: true });
  const game = `rooms/${code}/games/2`;
  const [opening] = eventLogList(await read(host, `${game}/eventLog`));
  let version = await read(host, `${game}/version`);
  const bumped = (session, writes) => update(ref(session.db), { ...writes, [`${game}/version`]: version + 1 });
  const accept = async (writes) => {
    await bumped(host, writes);
    version += 1;
  };
  const entry = { round: 1, phase: 'day', event: 't30', kind: 'fog', threshold: 30 };

  // 玩家寫不了事件紀錄，也碰不到一般事件牌堆。
  await assert.rejects(bumped(p1, { [`${game}/eventLog/1`]: entry }), denied, 'players cannot write the log');
  await assert.rejects(set(ref(p1.db, `${game}/eventLog/1`), entry), denied);
  await assert.rejects(set(ref(p1.db, `hostOnly/${code}/2/eventDeck`), ['t1']), denied, 'players cannot write the pile');
  await assert.rejects(get(ref(p2.db, `hostOnly/${code}/2/eventDeck`)), denied, 'players cannot read the pile');

  // 主持端寫壞的紀錄整筆被拒。
  const bad = [
    { ...entry, round: 2 },
    { ...entry, round: 0 },
    { ...entry, phase: 'noon' },
    { ...entry, event: 'no good' },
    { ...entry, kind: 'bill' },
    { ...entry, threshold: 101 },
    { ...entry, threshold: 1.5 },
    { ...entry, skipped: 'yes' },
    { ...entry, extra: 1 },
    { round: 1, phase: 'sunrise', event: 't1', kind: 'deck', threshold: 30 },
    { round: 1, phase: 'day', event: 't30', kind: 'fog' },
    { round: 1, phase: 'day', kind: 'fog', threshold: 30 },
    { round: 1, phase: 'day', kind: 'deck', skipped: true },
    { phase: 'day', event: 't30', kind: 'fog', threshold: 30 },
    { round: 1, event: 't30', kind: 'fog', threshold: 30 },
    { round: 1, phase: 'day', event: 't30', threshold: 30 },
  ];
  for (const value of bad) await assert.rejects(bumped(host, { [`${game}/eventLog/1`]: value }), denied, JSON.stringify(value));
  await assert.rejects(bumped(host, { [`${game}/eventLog/x`]: entry }), denied, 'keys are numbers');
  await assert.rejects(update(ref(host.db), { [`${game}/eventLog/1`]: entry }), denied, 'a log entry still needs version + 1');

  // 合格的照收：迷霧事件、找不到事件只記紀錄（skipped，沒有 event）。
  await accept({ [`${game}/eventLog/1`]: entry, [`${game}/eventLog/2`]: { round: 1, phase: 'day', kind: 'fog', threshold: 60, skipped: true } });

  // 寫了就不能改、不能刪：整筆換掉、只改一個欄位、拿掉一個欄位、刪掉任何一筆、刪掉或縮短整份紀錄。
  await assert.rejects(bumped(host, { [`${game}/eventLog/1`]: { ...entry, threshold: 60 } }), denied, 'replace an entry');
  await assert.rejects(bumped(host, { [`${game}/eventLog/1/event`]: 't60' }), denied, 'update a single field');
  await assert.rejects(bumped(host, { [`${game}/eventLog/0/round`]: 1 }), denied, 'rewrite a field with the same value');
  await assert.rejects(bumped(host, { [`${game}/eventLog/2/skipped`]: null }), denied, 'drop a field');
  await assert.rejects(bumped(host, { [`${game}/eventLog/0`]: null }), denied, 'remove the first entry');
  await assert.rejects(bumped(host, { [`${game}/eventLog/2`]: null }), denied, 'remove the last entry');
  await assert.rejects(bumped(host, { [`${game}/eventLog`]: null }), denied, 'remove the log');
  await assert.rejects(bumped(host, { [`${game}/eventLog`]: [opening] }), denied, 'shrink the log');
  await assert.rejects(update(ref(host.db, game), { eventLog: null, version: version + 1 }), denied, 'remove the log from the game node');
  assert.deepEqual(eventLogList(await read(host, `${game}/eventLog`)), [opening, entry, { round: 1, phase: 'day', kind: 'fog', threshold: 60, skipped: true }]);

  // 一般事件牌堆是事件編號的陣列。
  await assert.rejects(set(ref(host.db, `hostOnly/${code}/2/eventDeck`), ['t1', 'no good']), denied, 'the pile holds event ids');
  await assert.rejects(set(ref(host.db, `hostOnly/${code}/2/eventDeck/x`), 't1'), denied);
  await set(ref(host.db, `hostOnly/${code}/2/eventDeck`), ['t2', 't3']);
  assert.deepEqual(await read(host, `hostOnly/${code}/2/eventDeck`), ['t2', 't3']);
});

test('a day card that pushes the fog over 30 settles the fog event in the same write and clears fogPending', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await dayRoom(t, instant, { fog: 28 });
  const seen = watchers.p2.history;
  const empty = await read(host, `rooms/${code}/games/2`);
  assert.equal(empty.eventLog, undefined);
  const junk = { [`rooms/${code}/games/2/version`]: empty.version + 1, [`rooms/${code}/games/2/eventLog`]: 'junk' };
  await assert.rejects(update(ref(host.db), junk), denied, 'an empty log cannot become a plain value');
  await arrange(code, { [first.uid]: ['a01'], [second.uid]: [], [third.uid]: [] }, instant);
  const before = await read(host, `rooms/${code}/games/2`);
  // a01：成本 2 英鎊，自己英鎊 +5、迷霧 +3（28 → 31，越過 30）。
  await requestPlay(first, code, { card: 'a01' });
  assert.deepEqual(await settleRequest(host, code, 2, first.uid, instant), { outcome: 'played', reason: null });
  const room = await watchers.p2.until((value) => eventLogList(value.games[2].eventLog).length === 1, 'p2 sees the fog event');
  const game = room.games[2];
  assert.deepEqual(eventLogList(game.eventLog), [{ round: 1, phase: 'day', event: 't30', kind: 'fog', threshold: 30 }]);
  assert.deepEqual([room.tables[2].fog, game.fogMax, game.fogFired, game.fogPending], [31, 31, [30], undefined]);
  assert.deepEqual(stats(game, 'pounds'), { [first.uid]: 15 - 2 + 5 - 1, [second.uid]: 14, [third.uid]: 14 });
  assert.deepEqual(stats(game, 'influence'), { [first.uid]: 3, [second.uid]: 4, [third.uid]: 3 }, 'r2 gets 1');
  assert.equal(game.version, before.version + 1, 'one write');
  // 沒有任何一刻看到「牌出了、事件還沒結算」或還在等的門檻。
  for (const value of seen) {
    const games = value.games?.[2];
    if (!games) continue;
    const played = Object.keys(games.log ?? {}).length > 0;
    assert.equal(played, eventLogList(games.eventLog).length === 1);
    assert.equal(games.fogPending, undefined);
  }
});

test('a bill that pushes the fog over 30 settles the fog event in the same reveal', TIMEOUT, async (t) => {
  // b01 不通過：r3 影響力 −1、迷霧 +3（28 → 31）。
  const { code, watchers, first, second, third } = await dayRoom(t, instant, { fog: 28, billDeck: ['b01'] });
  await advance(code, 1);
  assert.equal((await settleDusk(host, code, 2, instant)).outcome, 'opened');
  assert.deepEqual(await revealDusk(host, code, 2), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/2/dusk`);
  await untilServerTime(host, duskSettleAt({ revealAt }) + 50);
  const settled = await settleDusk(host, code, 2, instant);
  assert.deepEqual([settled.outcome, settled.result.passed], ['revealed', false]);
  const room = await watchers.p2.until((value) => value.games[2].dusk?.result, 'p2 sees the result');
  const game = room.games[2];
  assert.deepEqual(eventLogList(game.eventLog), [{ round: 1, phase: 'dusk', event: 't30', kind: 'fog', threshold: 30 }]);
  assert.deepEqual([room.tables[2].fog, game.fogMax, game.fogFired, game.fogPending], [31, 31, [30], undefined]);
  assert.deepEqual(stats(game, 'pounds'), { [first.uid]: 14, [second.uid]: 14, [third.uid]: 14 });
  assert.deepEqual(stats(game, 'influence'), { [first.uid]: 3, [second.uid]: 4, [third.uid]: 2 }, 'r2 +1 from the event, r3 −1 from the bill');
  for (const value of watchers.p2.history) {
    const games = value.games?.[2];
    if (!games) continue;
    assert.equal(Boolean(games.dusk?.result), eventLogList(games.eventLog).length === 1, 'the result and the fog event arrive together');
    assert.equal(games.fogPending, undefined);
  }
});

test('two hosts dealing the same sunrise at once deal it once and flip one event; a threshold left by an older version is settled with it', TIMEOUT, async (t) => {
  const { code } = await openRoom(t);
  const seenByBackup = watch(backup, code);
  t.after(() => seenByBackup.stop());
  await enterAsHost(backup, code);
  await approveHost(host, code, backup.uid);
  assert.deepEqual(await startTable(host, code, 2, data, seededRandom(1)), { started: true });
  await advance(code, 4);
  // 舊版（M5a–M6 只記不處理）留下的門檻：迷霧曾越過 30，事件還沒結算。
  const old = await read(host, `rooms/${code}/games/2`);
  const leftover = { version: old.version + 1, fogPending: [30], fogFired: [30], fogMax: 35 };
  await update(ref(host.db), Object.fromEntries(Object.entries(leftover).map(([key, value]) => [`rooms/${code}/games/2/${key}`, value])));
  await seenByBackup.until((room) => room.hosts?.[backup.uid] === true && room.tables[2].round === 2 && room.deals[2] === 1 && room.games[2].fogPending, 'backup sees the second sunrise');
  const before = await read(host, `rooms/${code}/games/2`);
  const pile = await read(host, `hostOnly/${code}/2`);
  const results = await Promise.all([processSunrise(host, code, 2, data, seededRandom(2)), processSunrise(backup, code, 2, data, seededRandom(3))]);
  assert.deepEqual(results.map((result) => result.dealt).sort(), [false, true]);
  const game = await read(host, `rooms/${code}/games/2`);
  const entries = eventLogList(game.eventLog);
  assert.deepEqual(entries.map((entry) => [entry.round, entry.phase, entry.kind]), [[1, 'sunrise', 'deck'], [2, 'sunrise', 'deck'], [2, 'sunrise', 'fog']]);
  assert.equal(entries[1].event, pile.eventDeck[0]);
  assert.deepEqual(entries[2], { round: 2, phase: 'sunrise', event: 't30', kind: 'fog', threshold: 30 }, 'the leftover threshold is settled at this sunrise');
  assert.deepEqual([game.fogPending, game.fogFired], [undefined, [30]]);
  assert.equal(game.version, before.version + 1);
  assert.deepEqual((await read(host, `hostOnly/${code}/2`)).eventDeck, pile.eventDeck.slice(1));
  assert.ok(allSame(game, 'pounds', 15 + GAIN[entries[0].event] + 5 + GAIN[entries[1].event] - 1), 'paid, flipped and the fog event (−1) once');
});

test('stealing through the real play flow: a card from @指定 and a response from @出牌者 keep the total; the window settles the fog event too', TIMEOUT, async (t) => {
  const { code, first, second, third } = await dayRoom(t, quick, { fog: 29 });
  await arrange(code, { [first.uid]: ['a15', 'a03'], [second.uid]: ['a25'], [third.uid]: [] }, quick);
  const game = `rooms/${code}/games/2`;
  const start = await read(host, game);

  // a15（一般牌、犯罪）：從 second 偷 3 英鎊；沒人響應，時間到結算。
  await requestPlay(first, code, { card: 'a15', target: second.uid });
  assert.equal((await settleRequest(host, code, 2, first.uid, quick)).outcome, 'opened');
  const pending = await read(host, `${game}/pending`);
  await untilServerTime(host, responseSettleAt(pending) + 50);
  assert.deepEqual(await settleWindow(host, code, 2, quick), { outcome: 'resolved', response: null });
  let now = await read(host, game);
  assert.deepEqual(stats(now, 'pounds'), { [first.uid]: 18, [second.uid]: 12, [third.uid]: 15 });
  assert.equal(sum(now, 'pounds'), sum(start, 'pounds'), 'stealing keeps the total');
  const log = Object.values(now.log);
  assert.deepEqual(log.map((entry) => [entry.card, entry.target]), [['a15', second.uid]]);

  // a03（交易，成本 4、自己 +7、迷霧 +2）：second 打出 a25，從出牌者偷 2 英鎊。
  await requestPlay(first, code, { card: 'a03' });
  assert.equal((await settleRequest(host, code, 2, first.uid, quick)).outcome, 'opened');
  const { id } = await read(host, `${game}/pending`);
  await requestRespond(second, code, { card: 'a25', pending: id });
  assert.deepEqual(await settleWindow(host, code, 2, quick), { outcome: 'resolved', response: { by: second.uid, card: 'a25' } });
  now = await read(host, game);
  // a03 的迷霧 +2 讓 29 → 31：同一筆裡結算迷霧事件（全體英鎊 −1、r2 影響力 +1）。
  assert.deepEqual(eventLogList(now.eventLog), [{ round: 1, phase: 'day', event: 't30', kind: 'fog', threshold: 30 }]);
  assert.deepEqual([await read(host, `rooms/${code}/tables/2/fog`), now.fogPending, now.seats[second.uid].influence], [31, undefined, 4]);
  assert.deepEqual(stats(now, 'pounds'), { [first.uid]: 18 - 4 + 7 - 2 - 1, [second.uid]: 14 - 1, [third.uid]: 15 - 1 });
  assert.equal(sum(now, 'pounds'), sum(start, 'pounds') - 4 + 7 - 3, 'the a03 cost and gain and the fog event change the total, the steals do not');
  assert.deepEqual(stats(now, 'sin'), { [first.uid]: 1, [second.uid]: 1, [third.uid]: undefined }, 'a15 and a25 are crimes');
});
