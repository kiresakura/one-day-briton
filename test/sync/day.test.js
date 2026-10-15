// 白晝出牌的同步與權限測試：請求的讀寫權限、主持端結算、version 守門、起始玩家（npm run test:sync）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get, ref, remove, serverTimestamp, set, update } from 'firebase/database';
import { buildDeck, dayStatus, seatsInOrder, seededRandom } from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';
import {
  StoreError,
  advanceTable,
  approveHost,
  connect,
  createRoom,
  disconnect,
  enterAsHost,
  joinRoom,
  processSunrise,
  requestPass,
  requestPlay,
  setStartOrder,
  settleRequest,
  startSettling,
  startTable,
  watchRequest,
  watchRoom,
} from '../../play/js/store.js';

const TIMEOUT = { timeout: 30_000 };
const denied = /permission[_ ]denied/i;
const cardDir = new URL('../../play/data/', import.meta.url);
const { data: fileData, errors } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
assert.deepEqual(errors, []);
// 這裡測的是出牌本身，不開響應窗口（responseSeconds 0＝出牌當下就結算）；響應卡在 respond.test.js。
// 日出也不翻一般事件（sunriseEvents 0），數字才照 M5a 算；事件在 event.test.js。
const data = { ...fileData, settings: { ...fileData.settings, responseSeconds: 0, sunriseEvents: 0 } };
const actionOf = (id) => data.actions.find((action) => action.id === id);

// 這裡用到的牌（資料檔第二版）：a03 交易、成本 4 英鎊、自己英鎊 +7、迷霧 +2、齒輪「中」；
// a15 犯罪、從指定的人偷 3 英鎊（對方夠付＝指定的人 −3、自己 +3）、齒輪「小」；a05 政治、成本 3 英鎊、自己影響力 +2、沒有齒輪。
assert.deepEqual(actionOf('a03').cost, { pounds: 4, influence: 0 });
assert.deepEqual(
  [actionOf('a15').category, actionOf('a15').gear, actionOf('a15').effects],
  ['犯罪', '小', [{ op: 'steal', resource: 'pounds', target: 'chosen', amount: 3 }]],
);

let host;
let backup;
let alice;
let bob;
let carol;

before(async () => {
  [host, backup, alice, bob, carol] = await Promise.all(['host', 'backup', 'alice', 'bob', 'carol'].map((slot) => connect(slot)));
});

after(async () => {
  await Promise.all([host, backup, alice, bob, carol].filter(Boolean).map(disconnect));
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
    until(predicate, label) {
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
        }, 5000);
        waiters.add(check);
        check();
      });
    },
  };
}

const read = async (session, path) => (await get(ref(session.db, path))).val();
const sorted = (list) => [...list].sort();

// 開一間新房，Alice 與 Bob 在第 2 桌、Carol 在第 3 桌；第 2 桌開局並推進到第 1 回合白晝。
// 回傳照座位排好的 first、second（誰坐座位 0 由開局隨機決定）。
async function dayRoom(t) {
  const code = await createRoom(host);
  await joinRoom(alice, code, 'Alice', 2);
  await joinRoom(bob, code, 'Bob', 2);
  await joinRoom(carol, code, 'Carol', 3);
  const watchers = { host: watch(host, code), alice: watch(alice, code), bob: watch(bob, code) };
  t.after(() => Object.values(watchers).forEach((watcher) => watcher.stop()));
  await watchers.host.until((room) => Object.keys(room.players ?? {}).length === 3, 'host sees three players');
  assert.deepEqual(await startTable(host, code, 2, data, seededRandom(1)), { started: true });
  await advanceTable(host, code, 2, { round: 1, phase: 'sunrise' });
  const game = await read(host, `rooms/${code}/games/2`);
  const [first, second] = seatsInOrder(game.seats).map(([uid]) => [alice, bob].find((session) => session.uid === uid));
  return { code, watchers, first, second };
}

// 主持端把指定的牌發到每個人手上，其餘的牌照資料順序放回牌庫、棄牌堆清空（牌的總數不變），之後抽牌的順序就固定了。
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
  for (const [uid, cards] of Object.entries(hands)) {
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

const logOf = (game) => Object.values(game.log ?? {}).sort((a, b) => a.at - b.at);

// 公開的房間樹裡不能有手牌、牌庫、棄牌堆、天命與退回原因；牌編號只出現在出牌紀錄（打出的牌本來就公開）。
function assertPublicOnly(room) {
  assert.doesNotMatch(JSON.stringify(room), /"hand"|"deck"|"discard"|"destiny"|"notice"/);
  const cards = new Set(data.actions.map((action) => action.id));
  const destinies = new Set(data.destinies.map((destiny) => destiny.id));
  const walk = (value, path) => {
    if (typeof value === 'string') {
      assert.ok(!destinies.has(value), path);
      if (cards.has(value)) assert.match(path, /^games\/2\/log\/[^/]+\/card$/, path);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}/${key}` : key);
    }
  };
  walk(room, '');
}

test('players write only their own request, with a rising sequence number, and read only their own', TIMEOUT, async (t) => {
  const { code } = await dayRoom(t);
  const path = (session) => `requests/${code}/${session.uid}`;
  assert.equal(await requestPass(alice, code), 1);
  assert.equal(await requestPlay(alice, code, { card: 'a01', target: bob.uid }), 2);
  const mine = await read(alice, path(alice));
  assert.deepEqual({ ...mine, at: typeof mine.at }, { seq: 2, type: 'play', card: 'a01', target: bob.uid, at: 'number' });
  assert.equal((await read(host, `requests/${code}`))[alice.uid].seq, 2, 'hosts read every request');
  assert.equal((await read(host, path(alice))).card, 'a01');

  // 讀不到別人的請求，也讀不到整個房間的請求。
  await assert.rejects(get(ref(bob.db, path(alice))), denied);
  await assert.rejects(get(ref(carol.db, path(alice))), denied);
  await assert.rejects(get(ref(bob.db, `requests/${code}`)), denied);
  await assert.rejects(get(ref(alice.db, 'requests')), denied);

  // 只能寫自己的；主持端也不能替玩家寫。
  const pass = (seq) => ({ seq, type: 'pass', at: serverTimestamp() });
  await assert.rejects(set(ref(alice.db, path(bob)), pass(1)), denied);
  await assert.rejects(set(ref(host.db, path(alice)), pass(9)), denied);
  // 序號只能往上加，不能刪掉重來。
  await assert.rejects(set(ref(alice.db, path(alice)), pass(2)), denied);
  await assert.rejects(set(ref(alice.db, path(alice)), pass(1)), denied);
  await assert.rejects(remove(ref(alice.db, path(alice))), denied);
  // 欄位逐一檢查，多的欄位拒絕。
  await assert.rejects(set(ref(alice.db, path(alice)), { ...pass(3), extra: true }), denied);
  await assert.rejects(set(ref(alice.db, path(alice)), { seq: 3, type: 'steal', at: serverTimestamp() }), denied);
  await assert.rejects(set(ref(alice.db, path(alice)), { seq: 3, type: 'play', at: serverTimestamp() }), denied, 'a play needs a card');
  await assert.rejects(set(ref(alice.db, path(alice)), { seq: 3, type: 'play', card: 'not a card', at: serverTimestamp() }), denied);
  await assert.rejects(set(ref(alice.db, path(alice)), { seq: 3, type: 'play', card: 'a01', target: 7, at: serverTimestamp() }), denied);
  await assert.rejects(set(ref(alice.db, path(alice)), { seq: 3.5, type: 'pass', at: serverTimestamp() }), denied);
  await assert.rejects(set(ref(alice.db, path(alice)), { seq: 3, type: 'pass' }), denied, 'the time is required');
  await assert.rejects(set(ref(alice.db, `requests/ZZZZ95/${alice.uid}`), pass(1)), denied, 'a room that does not exist');
  assert.equal((await read(alice, path(alice))).seq, 2);
  await set(ref(alice.db, path(alice)), pass(3));
  assert.equal(await requestPass(alice, code), 4, 'the next request follows the stored one');

  // 玩家寫不了處理過的序號、退回原因與出牌紀錄。
  const version = (await read(host, `rooms/${code}/games/2/version`)) + 1;
  await assert.rejects(update(ref(alice.db), { [`rooms/${code}/games/2/lastSeq/${alice.uid}`]: 4, [`rooms/${code}/games/2/version`]: version }), denied);
  await assert.rejects(set(ref(alice.db, `private/${code}/${alice.uid}/notice`), { seq: 4, reason: 'not-day' }), denied);
  await assert.rejects(set(ref(alice.db, `rooms/${code}/games/2/log/x`), { round: 1, by: alice.uid, card: 'a01', level: 1, at: Date.now() }), denied);
});

test('a legal play pays the cost, applies the effects and moves the turn, and every screen sees it', TIMEOUT, async (t) => {
  const { code, watchers, first, second } = await dayRoom(t);
  await arrange(code, { [first.uid]: ['a03', 'a05'], [second.uid]: ['a15', 'a08'] });
  const start = await readTable(code);
  assert.deepEqual(dayStatus(start.game, 1).current, first.uid);
  const deckCount = start.game.deckCount;

  assert.equal(await requestPlay(first, code, { card: 'a03' }), 1);
  assert.deepEqual(await settleRequest(host, code, 2, first.uid, data, seededRandom(2)), { outcome: 'played', reason: null });
  const after = await readTable(code);
  const me = after.game.seats[first.uid];
  assert.deepEqual([me.pounds, me.influence, me.handCount], [15 - 4 + 7, 3, 1]);
  assert.deepEqual(after.privates[first.uid].hand, ['a05']);
  assert.deepEqual(after.discard, ['a03']);
  assert.deepEqual([after.game.deckCount, after.game.discardCount], [deckCount, 1]);
  assert.equal(after.table.fog, 2, 'the fog of the table');
  assert.equal(after.game.fogMax, 2);
  assert.deepEqual(after.game.turn, { round: 1, index: 0, plays: 1, gear: '中', level: 1 });
  assert.equal(after.game.lastSeq[first.uid], 1);
  assert.equal(after.game.version, start.game.version + 1);
  const [entry] = logOf(after.game);
  assert.deepEqual({ ...entry, at: typeof entry.at }, { round: 1, by: first.uid, card: 'a03', level: 1, at: 'number' });
  assert.deepEqual(after.game.seats[second.uid], start.game.seats[second.uid], 'the other player is untouched');

  // 另一位玩家不用重新整理就看到；公開的房間樹裡沒有手牌。
  const seenByOther = await watchers[second === alice ? 'alice' : 'bob'].until(
    (room) => Object.keys(room.games?.[2]?.log ?? {}).length === 1 && room.games[2].seats[first.uid].pounds === 18,
    'the other player sees the play',
  );
  assertPublicOnly(seenByOther);

  // 結束這一輪 → 換 second；second 出一張要指定對象的犯罪牌。
  await requestPass(first, code);
  assert.equal((await settleRequest(host, code, 2, first.uid, data)).outcome, 'passed');
  assert.deepEqual((await read(host, `rooms/${code}/games/2/turn`)), { round: 1, index: 1, plays: 0, level: 0 });
  await requestPlay(second, code, { card: 'a15', target: first.uid });
  assert.equal((await settleRequest(host, code, 2, second.uid, data)).outcome, 'played');
  const last = await readTable(code);
  assert.deepEqual([last.game.seats[first.uid].pounds, last.game.seats[second.uid].pounds], [18 - 3, 15 + 3]);
  assert.equal(last.game.seats[second.uid].sin, 1, 'a crime card adds a sin');
  assert.equal(last.game.seats[first.uid].sin, undefined);
  assert.deepEqual(sorted(last.discard), ['a03', 'a15']);
  assert.equal(logOf(last.game)[1].target, first.uid);
  assert.equal(last.game.version, start.game.version + 3);
  const cards = [...Object.values(last.privates).flatMap((record) => record.hand ?? []), ...last.deck, ...last.discard];
  assert.deepEqual(sorted(cards), sorted(buildDeck(data.actions)), 'no card is lost or made up');
  assertPublicOnly(await read(alice, `rooms/${code}`));
});

test('a request against the rules only writes the reason for its sender and the sequence number', TIMEOUT, async (t) => {
  const { code, first, second } = await dayRoom(t);
  await arrange(code, { [first.uid]: ['a03', 'a05'], [second.uid]: ['a15', 'a08'] });
  const start = await readTable(code);
  const seen = watch(second, code, watchRequest);
  t.after(() => seen.stop());

  const seq = await requestPlay(second, code, { card: 'a15', target: first.uid });
  assert.deepEqual(await settleRequest(host, code, 2, second.uid, data), { outcome: 'rejected', reason: 'not-your-turn' });
  const after = await readTable(code);
  assert.deepEqual(after.privates[second.uid].notice, { seq, reason: 'not-your-turn' });
  const { version, lastSeq, ...rest } = after.game;
  const { version: oldVersion, ...oldRest } = start.game;
  assert.deepEqual([version, lastSeq], [oldVersion + 1, { [second.uid]: seq }]);
  assert.deepEqual(rest, oldRest, 'seats, turn and log stay the same');
  assert.deepEqual([after.deck, after.discard, after.table], [start.deck, start.discard, start.table]);
  for (const uid of [first.uid, second.uid]) assert.deepEqual(after.privates[uid].hand, start.privates[uid].hand);
  assert.deepEqual(await read(second, `private/${code}/${second.uid}/notice`), { seq, reason: 'not-your-turn' }, 'the sender reads the reason');
  await assert.rejects(get(ref(first.db, `private/${code}/${second.uid}/notice`)), denied, 'nobody else does');
  assert.equal((await seen.until((request) => request?.seq === seq, 'second sees the request')).type, 'play');

  // 同一筆再結算一次：已經處理過，什麼都不寫。
  assert.deepEqual(await settleRequest(host, code, 2, second.uid, data), { outcome: 'none', reason: null });
  assert.equal(await read(host, `rooms/${code}/games/2/version`), version);

  // 輪到的人出不在手上的牌、付不起的牌也一樣。
  await requestPlay(first, code, { card: 'a15', target: second.uid });
  assert.equal((await settleRequest(host, code, 2, first.uid, data)).reason, 'not-in-hand');
  await update(ref(host.db), { [`rooms/${code}/games/2/seats/${first.uid}/pounds`]: 2, [`rooms/${code}/games/2/version`]: version + 2 });
  await requestPlay(first, code, { card: 'a05' });
  assert.equal((await settleRequest(host, code, 2, first.uid, data)).reason, 'cannot-afford');
  assert.deepEqual((await read(host, `private/${code}/${first.uid}`)).hand, ['a03', 'a05']);
  assert.equal(await read(host, `rooms/${code}/games/2/seats/${first.uid}/pounds`), 2);
});

test('two hosts settling the same request at once apply it only once', TIMEOUT, async (t) => {
  const { code, first, second } = await dayRoom(t);
  const seenByBackup = watch(backup, code);
  t.after(() => seenByBackup.stop());
  await enterAsHost(backup, code);
  await approveHost(host, code, backup.uid);
  await arrange(code, { [first.uid]: ['a03', 'a05'], [second.uid]: ['a15', 'a08'] });
  const start = await readTable(code);
  await seenByBackup.until((room) => room.hosts?.[backup.uid] === true && room.games?.[2]?.version === start.game.version, 'backup sees the table');

  await requestPlay(first, code, { card: 'a03' });
  const results = await Promise.all([
    settleRequest(host, code, 2, first.uid, data, seededRandom(3)),
    settleRequest(backup, code, 2, first.uid, data, seededRandom(4)),
  ]);
  assert.deepEqual(results.map((result) => result.outcome).sort(), ['none', 'played']);
  const after = await readTable(code);
  assert.equal(after.game.seats[first.uid].pounds, 18, 'paid and paid out once');
  assert.deepEqual(after.discard, ['a03']);
  assert.equal(logOf(after.game).length, 1);
  assert.equal(after.game.version, start.game.version + 1);

  // 兩台都開著自動結算：結束這一輪只換一位、出牌只算一次。
  const errorsSeen = [];
  const stops = [host, backup].map((session) => startSettling(session, code, data, { onError: (error) => errorsSeen.push(error) }));
  t.after(() => stops.forEach((stop) => stop()));
  await requestPass(first, code);
  await seenByBackup.until((room) => room.games[2].turn?.index === 1, 'the turn moves to second');
  await requestPlay(second, code, { card: 'a15', target: first.uid });
  const room = await seenByBackup.until((value) => logOf(value.games[2]).length === 2, 'second has played');
  await new Promise((resolve) => setTimeout(resolve, 300)); // 讓晚到的另一台有機會（錯誤地）再寫一次
  const final = await readTable(code);
  assert.deepEqual(final.game.turn, { round: 1, index: 1, plays: 1, gear: '小', level: 1 });
  assert.deepEqual([final.game.seats[first.uid].pounds, final.game.seats[second.uid].pounds], [15, 18]);
  assert.equal(final.game.version, start.game.version + 3);
  assert.equal(logOf(final.game).length, 2);
  assert.deepEqual(final.game.lastSeq, { [first.uid]: 2, [second.uid]: 1 });
  assert.equal(room.games[2].seats[second.uid].sin, 1);
  assert.deepEqual(errorsSeen, []);
});

test('every write to a game must raise its version by exactly one', TIMEOUT, async (t) => {
  const { code, first } = await dayRoom(t);
  const game = `rooms/${code}/games/2`;
  const pounds = `${game}/seats/${first.uid}/pounds`;
  const version = await read(host, `${game}/version`);
  assert.equal(version, 1, 'starting wrote 1; advancing does not touch the game');

  await assert.rejects(set(ref(host.db, pounds), 1), denied, 'no version');
  for (const next of [version, version + 2, version - 1, 0, String(version + 1), version + 1.5]) {
    await assert.rejects(update(ref(host.db), { [pounds]: 1, [`${game}/version`]: next }), denied, `version ${next}`);
  }
  await assert.rejects(update(ref(host.db), { [pounds]: 1, [`${game}/version`]: null }), denied, 'removing the version');
  assert.equal(await read(host, pounds), 15);
  await update(ref(host.db), { [pounds]: 1, [`${game}/version`]: version + 1 });
  assert.deepEqual([await read(host, pounds), await read(host, `${game}/version`)], [1, version + 1]);

  // 日出發牌也帶 version＋1；推進只動 tables，不碰 version。
  for (const phase of ['day', 'dusk', 'night']) await advanceTable(host, code, 2, { round: 1, phase });
  assert.equal(await read(host, `${game}/version`), version + 1);
  assert.deepEqual(await processSunrise(host, code, 2, data), { dealt: true, round: 2 });
  assert.equal(await read(host, `${game}/version`), version + 2);
  assert.equal(await read(host, pounds), 1 + 5);
});

test('rules keep the new game fields in shape', TIMEOUT, async (t) => {
  const { code, first, second } = await dayRoom(t);
  const game = `rooms/${code}/games/2`;
  let version = await read(host, `${game}/version`);
  const bumped = (writes) => update(ref(host.db), { ...writes, [`${game}/version`]: version + 1 });
  const bad = [
    { [`${game}/turn`]: { round: 1, index: 0, plays: 0 } },
    { [`${game}/turn`]: { round: 1, index: 7, plays: 0, level: 0 } },
    { [`${game}/turn`]: { round: 1, index: 0, plays: -1, level: 0 } },
    { [`${game}/turn`]: { round: 1, index: 0, plays: 0, level: 0, extra: 1 } },
    { [`${game}/turn`]: { round: 0, index: 0, plays: 0, level: 0 } },
    { [`${game}/turn`]: { round: 1, index: 0, plays: 1, level: 1, gear: '' } },
    { [`${game}/startOrder`]: 6 },
    { [`${game}/startOrder`]: 1.5 },
    { [`${game}/fogMax`]: 101 },
    { [`${game}/fogFired`]: 30 },
    { [`${game}/fogFired`]: [30, 'x'] },
    { [`${game}/fogPending`]: [120] },
    { [`${game}/lastSeq/${first.uid}`]: 1 },
    { [`${game}/log/x`]: { round: 1, by: first.uid, card: 'a01', level: 1 } },
    { [`${game}/log/x`]: { round: 1, by: carol.uid, card: 'a01', level: 1, at: Date.now() } },
    { [`${game}/log/x`]: { round: 1, by: first.uid, card: 'a01', level: 0, at: Date.now() } },
    { [`${game}/log/x`]: { round: 1, by: first.uid, card: 'a01', level: 1, target: 'nobody', at: Date.now() } },
    { [`${game}/log/x`]: { round: 1, by: first.uid, card: 'a01', level: 1, note: 'hi', at: Date.now() } },
    { [`${game}/extra`]: 1 },
    { [`private/${code}/${first.uid}/notice`]: { seq: 1 } },
    { [`private/${code}/${first.uid}/notice`]: { seq: 1, reason: 'Not Allowed!' } },
    { [`private/${code}/${first.uid}/notice`]: { seq: 1, reason: 'not-day', extra: 1 } },
  ];
  for (const writes of bad) await assert.rejects(bumped(writes), denied, JSON.stringify(writes));
  assert.equal(await read(host, `${game}/version`), version);

  // 處理過的序號：只能是入座的人、不能比他送出的序號大、不能往回。
  await requestPass(first, code);
  await requestPass(first, code);
  await requestPass(carol, code);
  await assert.rejects(bumped({ [`${game}/lastSeq/${first.uid}`]: 3 }), denied, 'ahead of the request');
  await assert.rejects(bumped({ [`${game}/lastSeq/${carol.uid}`]: 1 }), denied, 'not seated here');
  await bumped({ [`${game}/lastSeq/${first.uid}`]: 2 });
  version += 1;
  await assert.rejects(bumped({ [`${game}/lastSeq/${first.uid}`]: 1 }), denied, 'backwards');

  // 合格的長相照樣寫得進去。
  await bumped({
    [`${game}/turn`]: { round: 1, index: 1, plays: 2, gear: '中', level: 2 },
    [`${game}/fogMax`]: 65,
    [`${game}/fogFired`]: [30, 60],
    [`${game}/fogPending`]: [30, 60],
    [`${game}/log/x`]: { round: 1, by: first.uid, card: 'a01', level: 2, target: second.uid, at: Date.now() - 10 },
    [`private/${code}/${first.uid}/notice`]: { seq: 2, reason: 'not-your-turn' },
  });
  const stored = await read(host, game);
  assert.deepEqual([stored.fogFired, stored.fogPending, stored.turn.level], [[30, 60], [30, 60], 2]);
});

test('the host picks who starts the first round, only before anyone plays', TIMEOUT, async (t) => {
  const { code, first, second } = await dayRoom(t);
  const game = `rooms/${code}/games/2`;
  const version = await read(host, `${game}/version`);
  await setStartOrder(host, code, 2, 1);
  const picked = await read(host, game);
  assert.deepEqual([picked.startOrder, picked.version], [1, version + 1]);
  assert.equal(dayStatus(picked, 1).current, second.uid, 'seat 1 starts');
  await assert.rejects(update(ref(alice.db, game), { startOrder: 0, version: version + 2 }), denied, 'players cannot pick');

  // first 已經不是起始玩家：他的請求被退回；second 先出。
  await requestPass(first, code);
  assert.equal((await settleRequest(host, code, 2, first.uid, data)).reason, 'not-your-turn');
  await requestPass(second, code);
  assert.equal((await settleRequest(host, code, 2, second.uid, data)).outcome, 'passed');
  await assert.rejects(setStartOrder(host, code, 2, 0), (error) => error instanceof StoreError && error.code === 'cannot-set-start');
  const now = await read(host, `${game}/version`);
  await assert.rejects(update(ref(host.db, game), { startOrder: 0, version: now + 1 }), denied, 'the rules say the same once a turn exists');
  assert.equal(await read(host, `${game}/startOrder`), 1);
});
