// 響應卡的同步與權限測試：響應窗口、先到先算、時間到、抵銷、窗口中的請求、兩台主持端、規則（npm run test:sync）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get, goOffline, goOnline, ref, serverTimestamp, set, update } from 'firebase/database';
import { buildDeck, responseSettleAt, seatsInOrder, seededRandom } from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';
import {
  advanceTable,
  approveHost,
  connect,
  createRoom,
  disconnect,
  enterAsHost,
  joinRoom,
  requestPlay,
  requestRespond,
  serverTime,
  settleRequest,
  settleWindow,
  startSettling,
  startTable,
  watchRoom,
} from '../../play/js/store.js';

const TIMEOUT = { timeout: 30_000 };
const denied = /permission[_ ]denied/i;
const cardDir = new URL('../../play/data/', import.meta.url);
const { data: fileData, errors } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
// 這裡測的是 M4–M6 的流程與數字，日出不翻一般事件（sunriseEvents 0）；事件在 event.test.js。
const data = { ...fileData, settings: { ...fileData.settings, sunriseEvents: 0 } };
assert.deepEqual(errors, []);
assert.equal(data.settings.responseSeconds, 5);
// 測時間到的地方把響應秒數改成 1（只改這份資料物件，不改資料檔）。
const quick = { ...data, settings: { ...data.settings, responseSeconds: 1 } };
const actionOf = (id) => data.actions.find((action) => action.id === id);

// 這裡用到的牌（資料檔第二版）：a03 交易、成本 4 英鎊、自己英鎊 +7、迷霧 +2、齒輪「中」；a05 政治、成本 3 英鎊、自己影響力 +2；
// a15 犯罪、從指定的人偷 3 英鎊、齒輪「小」；a01 生產、成本 2、自己英鎊 +5、迷霧 +3、齒輪「小」。
// 響應卡：a31 可回應交易、成本 1 英鎊、自己英鎊 +3；a25 犯罪、可回應交易與生產、從出牌者偷 2 英鎊；
// a24 可回應犯罪、成本 1 影響力、抵銷。
assert.deepEqual([actionOf('a31').respondsTo, actionOf('a31').cost.pounds, actionOf('a31').effects], [['交易'], 1, [{ op: 'pounds', target: 'self', amount: 3 }]]);
assert.deepEqual([actionOf('a25').category, actionOf('a25').respondsTo], ['犯罪', ['交易', '生產']]);
assert.deepEqual([actionOf('a24').respondsTo, actionOf('a24').cost.influence, actionOf('a24').effects], [['犯罪'], 1, [{ op: 'cancel' }]]);
assert.deepEqual([actionOf('a15').gear, actionOf('a01').gear], ['小', '小']);

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
const sorted = (list) => [...list].sort();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 等到伺服器時間（session 估計的）到了 at。
async function untilServerTime(session, at) {
  for (let left = at - serverTime(session); left > 0; left = at - serverTime(session)) await sleep(Math.min(left + 5, 250));
}

// 開一間新房，p1、p2、p3 在第 2 桌、outsider 在第 3 桌；第 2 桌開局並推進到第 1 回合白晝。
// 回傳照座位排好的 first、second、third（誰坐座位 0 由開局隨機決定）。
async function dayRoom(t) {
  const code = await createRoom(host);
  await joinRoom(p1, code, 'P1', 2);
  await joinRoom(p2, code, 'P2', 2);
  await joinRoom(p3, code, 'P3', 2);
  await joinRoom(outsider, code, 'Outsider', 3);
  const watchers = Object.fromEntries([host, p1, p2, p3, outsider].map((session, index) => [['host', 'p1', 'p2', 'p3', 'outsider'][index], watch(session, code)]));
  t.after(() => Object.values(watchers).forEach((watcher) => watcher.stop()));
  await watchers.host.until((room) => Object.keys(room.players ?? {}).length === 4, 'host sees four players');
  assert.deepEqual(await startTable(host, code, 2, data, seededRandom(1)), { started: true });
  await advanceTable(host, code, 2, { round: 1, phase: 'sunrise' });
  const game = await read(host, `rooms/${code}/games/2`);
  const [first, second, third] = seatsInOrder(game.seats).map(([uid]) => [p1, p2, p3].find((session) => session.uid === uid));
  return { code, watchers, first, second, third };
}

// 主持端把指定的牌發到每個人手上，其餘的牌照資料順序放回牌庫、棄牌堆清空（牌的總數不變）。
async function arrange(code, hands) {
  const game = await read(host, `rooms/${code}/games/2`);
  const deck = buildDeck(data.actions);
  for (const cards of Object.values(hands)) for (const id of cards) deck.splice(deck.indexOf(id), 1);
  const writes = {
    [`rooms/${code}/games/2/version`]: game.version + 1,
    [`rooms/${code}/games/2/deckCount`]: deck.length,
    [`rooms/${code}/games/2/discardCount`]: 0,
    [`hostOnly/${code}/2`]: { deck, discard: [] },
  };
  for (const uid of Object.keys(game.seats)) {
    const cards = hands[uid] ?? [];
    writes[`private/${code}/${uid}/hand`] = cards;
    writes[`rooms/${code}/games/2/seats/${uid}/handCount`] = cards.length;
  }
  await update(ref(host.db), writes);
}

// 主持端讀出第 2 桌的全部狀態。
async function readTable(code) {
  const [table, game, privates, pile] = await Promise.all([
    read(host, `rooms/${code}/tables/2`),
    read(host, `rooms/${code}/games/2`),
    read(host, `private/${code}`),
    read(host, `hostOnly/${code}/2`),
  ]);
  return { table, game, privates: privates ?? {}, deck: pile?.deck ?? [], discard: pile?.discard ?? [] };
}

function assertAllCards(state) {
  const cards = [...Object.values(state.privates).flatMap((record) => record.hand ?? []), ...state.deck, ...state.discard];
  if (state.game.pending) cards.push(state.game.pending.card);
  assert.deepEqual(sorted(cards), sorted(buildDeck(data.actions)), 'no card is lost or made up');
}

// 公開的房間樹裡不能有手牌、牌庫、棄牌堆、天命與退回原因；牌編號只出現在打出來的牌：出牌紀錄（含響應卡）與等著響應的那張。
function assertPublicOnly(room) {
  assert.doesNotMatch(JSON.stringify(room), /"hand"|"deck"|"discard"|"destiny"|"notice"/);
  const cards = new Set(data.actions.map((action) => action.id));
  const destinies = new Set(data.destinies.map((destiny) => destiny.id));
  const walk = (value, path) => {
    if (typeof value === 'string') {
      assert.ok(!destinies.has(value), path);
      if (cards.has(value)) assert.match(path, /^games\/2\/(log\/[^/]+\/(response\/)?card|pending\/card)$/, path);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}/${key}` : key);
    }
  };
  walk(room, '');
}

test('a play opens a response window that every screen sees, and a response settles it with the card', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await dayRoom(t);
  await arrange(code, { [first.uid]: ['a03', 'a05'], [second.uid]: ['a31'], [third.uid]: ['a25'] });
  const start = await readTable(code);

  assert.equal(await requestPlay(first, code, { card: 'a03' }), 1);
  const sentAt = serverTime(host);
  assert.deepEqual(await settleRequest(host, code, 2, first.uid, data, seededRandom(2)), { outcome: 'opened', reason: null });
  const opened = await readTable(code);
  const { pending } = opened.game;
  assert.match(pending.id, /^[A-Za-z0-9_-]{20}$/);
  assert.deepEqual(
    { ...pending, id: 'id', openedAt: typeof pending.openedAt },
    { id: 'id', by: first.uid, seq: 1, card: 'a03', level: 1, openedAt: 'number', seconds: 5 },
  );
  assert.ok(pending.openedAt >= sentAt - 1000 && pending.openedAt <= serverTime(host) + 1000, 'openedAt is the server time');
  const me = opened.game.seats[first.uid];
  assert.deepEqual([me.pounds, me.handCount, opened.privates[first.uid].hand], [15 - 4, 1, ['a05']], 'paid, and the card left the hand');
  assert.equal(opened.game.turn, undefined, 'the turn waits for the card to settle');
  assert.deepEqual([opened.discard, opened.game.discardCount, opened.game.deckCount], [[], 0, start.game.deckCount]);
  assert.deepEqual([opened.game.lastSeq, opened.game.version, opened.game.log], [{ [first.uid]: 1 }, start.game.version + 1, undefined]);
  assert.equal(opened.table.fog, 0, 'no effect yet');
  assertAllCards(opened);
  for (const name of ['p1', 'p2', 'p3', 'outsider']) {
    await watchers[name].until((room) => room.games?.[2]?.pending?.id === pending.id, `${name} sees the card waiting`);
  }
  assertPublicOnly(watchers.p2.value);
  assert.deepEqual(await settleWindow(host, code, 2, data), { outcome: 'waiting', response: null }, 'inside the window, nothing to do yet');

  assert.equal(await requestRespond(second, code, { card: 'a31', pending: pending.id }), 1);
  const request = await read(second, `requests/${code}/${second.uid}`);
  assert.deepEqual({ ...request, at: typeof request.at }, { seq: 1, type: 'respond', card: 'a31', pending: pending.id, at: 'number' });
  assert.deepEqual(await settleWindow(host, code, 2, data, seededRandom(3)), { outcome: 'resolved', response: { by: second.uid, card: 'a31' } });
  const after = await readTable(code);
  assert.equal(after.game.pending, undefined);
  assert.deepEqual([after.game.seats[first.uid].pounds, after.game.seats[second.uid].pounds], [11 + 7, 15 - 1 + 3]);
  assert.deepEqual([after.game.seats[second.uid].handCount, after.privates[second.uid].hand], [0, undefined]);
  assert.deepEqual(after.game.seats[third.uid], start.game.seats[third.uid], 'the third player is untouched');
  assert.deepEqual(after.discard, ['a03', 'a31']);
  assert.deepEqual(after.game.turn, { round: 1, index: 0, plays: 1, gear: '中', level: 1 }, 'the response is not a play');
  assert.deepEqual(after.game.lastSeq, { [first.uid]: 1, [second.uid]: 1 });
  assert.deepEqual([after.table.fog, after.game.version], [2, start.game.version + 2]);
  assert.deepEqual(Object.keys(after.game.log), [pending.id], 'the log entry keeps the id of the window');
  const entry = after.game.log[pending.id];
  assert.deepEqual(
    { ...entry, at: typeof entry.at },
    { round: 1, by: first.uid, card: 'a03', level: 1, response: { by: second.uid, card: 'a31' }, at: 'number' },
  );
  assertAllCards(after);
  const seen = await watchers.p3.until((room) => room.games[2].log?.[pending.id]?.response?.by === second.uid && !room.games[2].pending, 'third sees the result');
  assertPublicOnly(seen);
  await watchers.p1.until((room) => room.games[2].seats[first.uid].pounds === 18, 'first sees the result without reloading');
});

test('two responses at almost the same time: the one the server got first counts, the other gets a notice', TIMEOUT, async (t) => {
  const { code, first, second, third } = await dayRoom(t);
  await arrange(code, { [first.uid]: ['a03'], [second.uid]: ['a31'], [third.uid]: ['a25'] });
  await requestPlay(first, code, { card: 'a03' });
  assert.equal((await settleRequest(host, code, 2, first.uid, data)).outcome, 'opened');
  const { id } = await read(host, `rooms/${code}/games/2/pending`);
  await Promise.all([requestRespond(second, code, { card: 'a31', pending: id }), requestRespond(third, code, { card: 'a25', pending: id })]);
  const sent = await read(host, `requests/${code}`);
  const [winner, loser] = [second, third].sort((a, b) => sent[a.uid].at - sent[b.uid].at || (a.uid < b.uid ? -1 : 1));
  assert.deepEqual(await settleWindow(host, code, 2, data), { outcome: 'resolved', response: { by: winner.uid, card: sent[winner.uid].card } });
  const after = await readTable(code);
  assert.deepEqual(after.privates[loser.uid].notice, { seq: 1, reason: 'beaten' });
  assert.equal(after.privates[winner.uid].notice, undefined);
  assert.deepEqual([after.privates[loser.uid].hand, after.game.seats[loser.uid].pounds], [[sent[loser.uid].card], 15], 'the loser keeps the card and pays nothing');
  assert.deepEqual(after.game.lastSeq, { [first.uid]: 1, [second.uid]: 1, [third.uid]: 1 });
  assert.equal(Object.keys(after.game.log).length, 1);
  const secondWon = winner === second;
  assert.deepEqual(
    [after.game.seats[first.uid].pounds, after.game.seats[winner.uid].pounds, after.game.seats[third.uid].sin],
    secondWon ? [18, 17, undefined] : [16, 17, 1],
    'a03 then the winning response; a crime response adds a sin',
  );
  assertAllCards(after);
  assert.deepEqual(await settleWindow(host, code, 2, data), { outcome: 'none', response: null }, 'settled already');
  assert.deepEqual(await read(loser, `private/${code}/${loser.uid}/notice`), { seq: 1, reason: 'beaten' }, 'the loser reads why');
});

test('nobody responds: the card settles by itself once the time is up', TIMEOUT, async (t) => {
  const { code, watchers, first } = await dayRoom(t);
  await arrange(code, { [first.uid]: ['a03'] });
  const errorsSeen = [];
  const stop = startSettling(host, code, quick, { onError: (error) => errorsSeen.push(error) });
  t.after(stop);
  await requestPlay(first, code, { card: 'a03' });
  const waiting = await watchers.p2.until((room) => room.games[2].pending, 'the card waits');
  const { id, openedAt, seconds } = waiting.games[2].pending;
  assert.equal(seconds, 1);
  const settled = await watchers.p2.until((room) => room.games[2].log?.[id] && !room.games[2].pending, 'the card settles', 8000);
  const entry = settled.games[2].log[id];
  assert.equal(entry.response, undefined);
  const late = entry.at - openedAt;
  assert.ok(late >= 2000 - 200 && late < 5000, `settled ${late} ms after the window opened (1 s and a 1 s grace)`);
  assert.equal(settled.games[2].seats[first.uid].pounds, 18);
  assert.deepEqual(errorsSeen, []);
});

test('a response after the deadline is turned down, and the card settles as if nobody responded', TIMEOUT, async (t) => {
  const { code, first, second } = await dayRoom(t);
  await arrange(code, { [first.uid]: ['a03'], [second.uid]: ['a31'] });
  await requestPlay(first, code, { card: 'a03' });
  assert.equal((await settleRequest(host, code, 2, first.uid, quick)).outcome, 'opened');
  const pending = await read(host, `rooms/${code}/games/2/pending`);
  await untilServerTime(host, pending.openedAt + 1000 + 100); // 過了截止，還在緩衝時間內
  await requestRespond(second, code, { card: 'a31', pending: pending.id });
  assert.ok((await read(second, `requests/${code}/${second.uid}`)).at > pending.openedAt + 1000);
  assert.deepEqual(await settleWindow(host, code, 2, quick), { outcome: 'rejected', response: null });
  let now = await readTable(code);
  assert.deepEqual(now.privates[second.uid].notice, { seq: 1, reason: 'too-late' });
  assert.deepEqual([now.game.pending.id, now.game.lastSeq[second.uid]], [pending.id, 1], 'the card still waits for the grace to pass');
  assert.deepEqual([now.privates[second.uid].hand, now.game.seats[second.uid].pounds], [['a31'], 15]);

  await untilServerTime(host, responseSettleAt(pending) + 50);
  assert.deepEqual(await settleWindow(host, code, 2, quick), { outcome: 'resolved', response: null });
  now = await readTable(code);
  assert.equal(now.game.pending, undefined);
  assert.equal(now.game.log[pending.id].response, undefined);
  assert.deepEqual([now.game.seats[first.uid].pounds, now.game.seats[second.uid].pounds], [18, 15]);
  assertAllCards(now);
});

test('a cancel response: the card does nothing, but its cost stays paid, it counts as a play, breaks the chain and adds its sin', TIMEOUT, async (t) => {
  const { code, first, second } = await dayRoom(t);
  await arrange(code, { [first.uid]: ['a15', 'a01'], [second.uid]: ['a24'] });
  await requestPlay(first, code, { card: 'a15', target: second.uid });
  assert.equal((await settleRequest(host, code, 2, first.uid, data)).outcome, 'opened');
  const pending = await read(host, `rooms/${code}/games/2/pending`);
  assert.equal(pending.target, second.uid);
  await requestRespond(second, code, { card: 'a24', pending: pending.id });
  assert.deepEqual(await settleWindow(host, code, 2, data), { outcome: 'resolved', response: { by: second.uid, card: 'a24' } });
  const after = await readTable(code);
  const [mine, theirs] = [after.game.seats[first.uid], after.game.seats[second.uid]];
  assert.deepEqual([mine.pounds, theirs.pounds], [15, 15], 'no −3 and no +3');
  assert.deepEqual([theirs.influence, theirs.handCount], [3 - 1, 0], 'the responder paid 1 influence');
  assert.equal(mine.sin, 1, 'the canceled crime still adds a sin');
  assert.deepEqual(after.game.turn, { round: 1, index: 0, plays: 1, level: 0 }, 'it counts as a play and breaks the chain');
  assert.deepEqual(after.discard, ['a15', 'a24']);
  const entry = after.game.log[pending.id];
  assert.deepEqual(
    { ...entry, at: typeof entry.at },
    { round: 1, by: first.uid, card: 'a15', level: 1, target: second.uid, response: { by: second.uid, card: 'a24' }, canceled: true, at: 'number' },
  );
  assertAllCards(after);
  await requestPlay(first, code, { card: 'a01' });
  assert.equal((await settleRequest(host, code, 2, first.uid, data)).outcome, 'opened');
  assert.equal((await read(host, `rooms/${code}/games/2/pending`)).level, 1, 'the next card of the same gear starts at level 1');
});

test('the next card the player sends during the window waits for the card to settle, and is handled once', TIMEOUT, async (t) => {
  const { code, watchers, first } = await dayRoom(t);
  await arrange(code, { [first.uid]: ['a03', 'a05'] });
  const start = await readTable(code);
  const errorsSeen = [];
  const stop = startSettling(host, code, quick, { onError: (error) => errorsSeen.push(error) });
  t.after(stop);
  await requestPlay(first, code, { card: 'a03' });
  const opened = await watchers.p1.until((room) => room.games[2].pending, 'a03 waits');
  assert.equal(await requestPlay(first, code, { card: 'a05' }), 2);
  await sleep(400);
  const during = await read(host, `rooms/${code}/games/2`);
  assert.deepEqual(
    [during.pending?.id, during.lastSeq[first.uid], during.version],
    [opened.games[2].pending.id, 1, start.game.version + 1],
    'the second card is not touched while the first one waits',
  );
  const done = await watchers.p1.until((room) => Object.keys(room.games[2].log ?? {}).length === 2 && !room.games[2].pending, 'both cards settle', 10_000);
  const cards = Object.values(done.games[2].log)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.card);
  assert.deepEqual(cards, ['a03', 'a05']);
  await sleep(300); // 讓多出來的寫入（如果有）落地
  const final = await readTable(code);
  assert.deepEqual([final.game.lastSeq[first.uid], final.game.version], [2, start.game.version + 4], 'each card opened and settled once');
  assert.deepEqual([final.game.seats[first.uid].pounds, final.game.seats[first.uid].influence], [15 - 4 + 7 - 3, 3 + 2]);
  assert.deepEqual(final.game.turn, { round: 1, index: 0, plays: 2, level: 1 });
  assertAllCards(final);
  assert.deepEqual(errorsSeen, []);
});

test('two hosts settling the same window write only once, whether a response or the time decides it', TIMEOUT, async (t) => {
  const { code, first, second, third } = await dayRoom(t);
  const seenByBackup = watch(backup, code);
  t.after(() => seenByBackup.stop());
  await enterAsHost(backup, code);
  await approveHost(host, code, backup.uid);
  await arrange(code, { [first.uid]: ['a03', 'a05'], [second.uid]: ['a31'], [third.uid]: ['a25'] });
  const start = await readTable(code);
  await seenByBackup.until((room) => room.hosts?.[backup.uid] === true && room.games?.[2]?.version === start.game.version, 'backup sees the table');

  // a03：second 在截止前響應、third 過了截止才響應；兩台主持端在緩衝之後同時結算。
  await requestPlay(first, code, { card: 'a03' });
  const opened = await Promise.all([settleRequest(host, code, 2, first.uid, quick), settleRequest(backup, code, 2, first.uid, quick)]);
  assert.deepEqual(opened.map((result) => result.outcome).sort(), ['none', 'opened']);
  const pending = await read(host, `rooms/${code}/games/2/pending`);
  await requestRespond(second, code, { card: 'a31', pending: pending.id });
  await untilServerTime(host, pending.openedAt + 1000 + 50);
  await requestRespond(third, code, { card: 'a25', pending: pending.id });
  await untilServerTime(host, responseSettleAt(pending) + 50);
  const results = await Promise.all([settleWindow(host, code, 2, quick), settleWindow(backup, code, 2, quick)]);
  assert.deepEqual(results.map((result) => result.outcome).sort(), ['none', 'resolved']);
  let now = await readTable(code);
  assert.equal(now.game.version, start.game.version + 2, 'opened once and settled once');
  assert.deepEqual(now.game.log[pending.id].response, { by: second.uid, card: 'a31' });
  assert.deepEqual(now.privates[third.uid].notice, { seq: 1, reason: 'too-late' });
  assert.deepEqual([now.game.seats[first.uid].pounds, now.game.seats[second.uid].pounds], [18, 17], 'paid and paid out once');

  // a05：兩台都開著自動結算、沒人響應，時間到只結算一次。
  const errorsSeen = [];
  const stops = [host, backup].map((session) => startSettling(session, code, quick, { onError: (error) => errorsSeen.push(error) }));
  t.after(() => stops.forEach((stop) => stop()));
  await requestPlay(first, code, { card: 'a05' });
  await seenByBackup.until((room) => Object.keys(room.games[2].log ?? {}).length === 2 && !room.games[2].pending, 'a05 settles', 8000);
  await sleep(300); // 讓晚到的另一台有機會（錯誤地）再寫一次
  now = await readTable(code);
  assert.equal(now.game.version, start.game.version + 4);
  assert.deepEqual([now.game.seats[first.uid].pounds, now.game.seats[first.uid].influence], [18 - 3, 3 + 2]);
  assertAllCards(now);
  assert.deepEqual(errorsSeen, []);
});

test('a response the host had not seen when the time was up still counts: the host asks the server again', TIMEOUT, async (t) => {
  const { code, watchers, first, second } = await dayRoom(t);
  await arrange(code, { [first.uid]: ['a03'], [second.uid]: ['a31'] });
  const errorsSeen = [];
  const stop = startSettling(host, code, quick, { onError: (error) => errorsSeen.push(error) });
  t.after(stop);
  await requestPlay(first, code, { card: 'a03' });
  const waiting = await watchers.p2.until((room) => room.games[2].pending, 'the card waits');
  const { pending } = waiting.games[2];
  await watchers.host.until((room) => room.games[2].pending?.id === pending.id, 'the host has seen the window');
  // 等主持端開窗口的那筆寫入收到伺服器確認、自動結算閒下來（同一條連線的回覆照順序到，問一次伺服器就知道），再斷線：
  // 它的快取停在「沒人響應」，計時器照樣在時間到時叫醒它。
  await read(host, `hostOnly/${code}/2`);
  await sleep(100);
  goOffline(host.db);
  t.after(() => goOnline(host.db));
  await requestRespond(second, code, { card: 'a31', pending: pending.id });
  await untilServerTime(second, responseSettleAt(pending) + 700);
  goOnline(host.db);
  const settled = await watchers.p2.until((room) => room.games[2].log?.[pending.id], 'the card settles', 8000);
  assert.deepEqual(settled.games[2].log[pending.id].response, { by: second.uid, card: 'a31' });
  assert.deepEqual(errorsSeen, []);
});

test('automatic settling only sets a timer while a card waits for responses', TIMEOUT, async (t) => {
  const { code, watchers, first } = await dayRoom(t);
  await arrange(code, { [first.uid]: ['a03'] });
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (callback, ms, ...rest) => {
    delays.push(ms);
    return realSetTimeout(callback, ms, ...rest);
  };
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
  });
  const stop = startSettling(host, code, quick);
  t.after(stop);
  await sleep(300);
  await requestPlay(first, code, { card: 'a03' });
  const { id } = (await watchers.host.until((room) => room.games[2].pending, 'the card waits')).games[2].pending;
  await watchers.host.until((room) => room.games[2].log?.[id], 'the card settles', 8000);
  await sleep(300);
  globalThis.setTimeout = realSetTimeout;
  assert.deepEqual(delays.filter((ms) => ms === Infinity || Number.isNaN(ms)), [], 'no endless timer without a waiting card');
  assert.ok(delays.some((ms) => ms > 1500 && ms <= 2100), 'one timer for the end of the window');
});

test('rules: a request changed field by field cannot keep an old time', TIMEOUT, async (t) => {
  const { code, first, second } = await dayRoom(t);
  await arrange(code, { [first.uid]: ['a03'], [second.uid]: ['a31'] });
  await requestPlay(first, code, { card: 'a03' });
  assert.equal((await settleRequest(host, code, 2, first.uid, data)).outcome, 'opened');
  const { id } = await read(host, `rooms/${code}/games/2/pending`);
  const mine = ref(second.db, `requests/${code}/${second.uid}`);
  await set(mine, { seq: 1, type: 'pass', at: serverTimestamp() });
  const old = (await read(second, `requests/${code}/${second.uid}`)).at;
  await untilServerTime(second, old + 50); // 同一毫秒內的「舊」時間就是現在，要等時間走過去
  // 只改其他欄位、留著舊的 at：響應會被當成很早送到（先到先算、也過得了截止）。規則要整筆檢查時間。
  await assert.rejects(update(mine, { seq: 2, type: 'respond', card: 'a31', pending: id }), denied, 'the old time cannot be kept');
  await update(mine, { seq: 2, type: 'respond', card: 'a31', pending: id, at: serverTimestamp() });
  assert.ok((await read(second, `requests/${code}/${second.uid}`)).at >= old, 'a fresh time is fine');
});

test('rules: a response names its card and window, the time is the server time, and only hosts write the window', TIMEOUT, async (t) => {
  const { code, first, second, third } = await dayRoom(t);
  const mine = (session) => ref(session.db, `requests/${code}/${session.uid}`);
  const respond = (fields = {}) => ({ seq: 1, type: 'respond', card: 'a31', pending: 'abc_DEF-123', at: serverTimestamp(), ...fields });
  const badRequests = [
    [respond({ pending: null }), 'a response needs the window'],
    [respond({ card: null }), 'a response needs a card'],
    [respond({ pending: 'not ok!' }), 'the window id format'],
    [respond({ pending: 'x'.repeat(41) }), 'the window id length'],
    [respond({ pending: 7 }), 'the window id is text'],
    [respond({ type: 'play', card: 'a03' }), 'only a response names a window'],
    [respond({ at: Date.now() - 5000 }), 'a time earlier than the server time'],
    [respond({ at: Date.now() + 5000 }), 'a time later than the server time'],
    [{ seq: 1, type: 'pass', at: Date.now() - 5000 }, 'a pass with a made-up time'],
  ];
  for (const [value, label] of badRequests) await assert.rejects(set(mine(second), value), denied, label);
  await set(mine(second), respond());
  assert.equal((await read(second, `requests/${code}/${second.uid}`)).type, 'respond');

  // pending：只有主持端寫得進去，欄位逐一檢查，還在等的那張不能換成別張。
  const game = `rooms/${code}/games/2`;
  let version = await read(host, `${game}/version`);
  const bumped = (session, writes) => update(ref(session.db), { ...writes, [`${game}/version`]: version + 1 });
  const window = { id: 'w1', by: first.uid, seq: 1, card: 'a03', level: 1, openedAt: serverTimestamp(), seconds: 5 };
  await assert.rejects(bumped(first, { [`${game}/pending`]: window }), denied, 'players cannot write the window');
  const { openedAt, ...noTime } = window;
  const badWindows = [
    { ...window, id: 'not ok!' },
    { ...window, by: outsider.uid },
    { ...window, by: 'nobody' },
    { ...window, target: outsider.uid },
    { ...window, chainTarget: 'nobody' },
    { ...window, seq: 0 },
    { ...window, level: 0 },
    { ...window, card: 'not a card' },
    { ...window, openedAt: Date.now() - 1000 },
    { ...window, seconds: 61 },
    { ...window, seconds: 1.5 },
    { ...window, seconds: -1 },
    { ...window, extra: 1 },
    noTime,
  ];
  for (const value of badWindows) await assert.rejects(bumped(host, { [`${game}/pending`]: value }), denied, JSON.stringify(value));
  await bumped(host, { [`${game}/pending`]: { ...window, target: second.uid, chainTarget: third.uid } });
  version += 1;
  await assert.rejects(bumped(host, { [`${game}/pending`]: { ...window, id: 'w2' } }), denied, 'a waiting card cannot be swapped for another');
  await assert.rejects(bumped(host, { [`${game}/startOrder`]: 1 }), denied, 'the first player cannot change while the first card waits');
  await bumped(host, { [`${game}/pending`]: null });
  version += 1;

  // 出牌紀錄的新欄位。
  const entry = { round: 1, by: first.uid, card: 'a03', level: 3, at: Date.now() - 10 };
  const badEntries = [
    { ...entry, chainTarget: outsider.uid },
    { ...entry, response: { by: outsider.uid, card: 'a31' } },
    { ...entry, response: { by: first.uid, card: 'a31' } },
    { ...entry, response: { by: second.uid } },
    { ...entry, response: { by: second.uid, card: 'a31', extra: 1 } },
    { ...entry, response: { by: second.uid, card: 'a31' }, canceled: false },
    { ...entry, canceled: true },
  ];
  for (const value of badEntries) await assert.rejects(bumped(host, { [`${game}/log/x`]: value }), denied, JSON.stringify(value));
  await bumped(host, { [`${game}/log/x`]: { ...entry, chainTarget: third.uid, response: { by: second.uid, card: 'a24' }, canceled: true } });
  assert.deepEqual((await read(host, `${game}/log/x`)).response, { by: second.uid, card: 'a24' });
});
