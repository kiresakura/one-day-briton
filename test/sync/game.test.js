// 開局與日出發牌的同步與權限測試：私密樹、只有主持端讀得到的牌庫、一次寫入不重複（npm run test:sync）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get, ref, remove, set, update } from 'firebase/database';
import { buildDeck } from '../../play/js/game.js';
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
  startTable,
  watchPrivate,
  watchRoom,
} from '../../play/js/store.js';

const TIMEOUT = { timeout: 20_000 };
const denied = /permission[_ ]denied/i;
const cardDir = new URL('../../play/data/', import.meta.url);
const { data, errors } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
assert.deepEqual(errors, []);

// 目前的資料與設定：開局（含第 1 回合日出）後每人英鎊 10＋5、影響力 3、手牌 4＋2；之後每次日出英鎊＋5、手牌＋2。
const salary = data.roles[0].salary;
assert.ok(data.roles.every((role) => role.salary === salary), 'every role has the same salary in the current data');
const START = {
  pounds: data.settings.startingPounds + salary,
  influence: data.settings.startingInfluence,
  handCount: data.settings.startingHand + data.settings.drawPerSunrise,
};
const DECK_SIZE = buildDeck(data.actions).length;
assert.deepEqual([START.pounds, START.influence, START.handCount, DECK_SIZE], [15, 3, 6, 61]);

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

// 訂閱房間並記住最新狀態；until() 等到條件成立，逾時就失敗。
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

// 開一間新房，Alice 與 Bob 加入第 2 桌，Carol 加入第 3 桌。
async function openRoom(t) {
  const code = await createRoom(host);
  await joinRoom(alice, code, 'Alice', 2);
  await joinRoom(bob, code, 'Bob', 2);
  await joinRoom(carol, code, 'Carol', 3);
  const watchers = { host: watch(host, code), alice: watch(alice, code), bob: watch(bob, code) };
  t.after(() => Object.values(watchers).forEach((watcher) => watcher.stop()));
  await watchers.host.until((room) => Object.keys(room.players ?? {}).length === 3, 'host sees three players');
  return { code, watchers };
}

// 備援裝置申請、原主持端核准，等到備援裝置自己看到名單上有它。
async function approveBackup(t, code) {
  const watcher = watch(backup, code);
  t.after(() => watcher.stop());
  await enterAsHost(backup, code);
  await approveHost(host, code, backup.uid);
  await watcher.until((room) => room?.hosts?.[backup.uid] === true, 'backup sees itself on the host list');
  return watcher;
}

const read = async (session, path) => (await get(ref(session.db, path))).val();
const isDeniedByStore = (error) => error instanceof StoreError && error.code === 'permission-denied';
const cannotStart = (pattern) => (error) => error instanceof StoreError && error.code === 'cannot-start' && pattern.test(error.message);
const sorted = (list) => [...list].sort();

// 從目前的回合與階段一路推進到指定的回合與階段。
async function advanceTo(code, table, target) {
  let state = await read(host, `rooms/${code}/tables/${table}`);
  while (state.round !== target.round || state.phase !== target.phase) {
    const result = await advanceTable(host, code, table, { round: state.round, phase: state.phase });
    assert.equal(result.advanced, true);
    state = result.table;
  }
}

// 主持端讀出一桌的全部狀態：公開的局面、處理過的回合、各人的私密資料、牌庫。
async function readGame(code, table) {
  const [game, deals, privates, pile] = await Promise.all([
    read(host, `rooms/${code}/games/${table}`),
    read(host, `rooms/${code}/deals/${table}`),
    read(host, `private/${code}`),
    read(host, `hostOnly/${code}/${table}`),
  ]);
  return { game, deals, privates: privates ?? {}, deck: pile?.deck ?? [], discard: pile?.discard ?? [] };
}

// 牌一張都沒有多、沒有少：入座的人的手牌＋牌庫＋棄牌堆，正好是整副牌。
function assertCardsConserved({ game, privates, deck, discard }) {
  const hands = Object.keys(game.seats).flatMap((uid) => privates[uid].hand ?? []);
  assert.deepEqual(sorted([...hands, ...deck, ...discard]), sorted(buildDeck(data.actions)));
}

function assertSeats(state, expected) {
  for (const [uid, seat] of Object.entries(state.game.seats)) {
    assert.deepEqual({ pounds: seat.pounds, influence: seat.influence, handCount: seat.handCount }, expected, uid);
    assert.equal(state.privates[uid].hand.length, expected.handCount, uid);
  }
}

test('starting a table seats its players with a role, a destiny, cards and money', TIMEOUT, async (t) => {
  const { code } = await openRoom(t);
  assert.deepEqual(await startTable(host, code, 2, data), { started: true });

  const state = await readGame(code, 2);
  const { game } = state;
  assert.equal(typeof game.startedAt, 'number');
  assert.deepEqual(sorted(Object.keys(game.seats)), sorted([alice.uid, bob.uid]), 'only the players of table 2 are seated');
  assert.deepEqual(sorted(Object.values(game.seats).map((seat) => seat.order)), [0, 1]);
  const roles = Object.values(game.seats).map((seat) => seat.role);
  assert.equal(new Set(roles).size, 2);
  for (const role of roles) assert.ok(data.roles.some((record) => record.id === role), role);
  assertSeats(state, START);
  assert.equal(state.deals, 1);
  assert.deepEqual([game.deckCount, game.discardCount], [DECK_SIZE - 2 * START.handCount, 0]);
  assert.equal(state.deck.length, game.deckCount);
  assertCardsConserved(state);

  for (const uid of [alice.uid, bob.uid]) {
    const mine = state.privates[uid];
    assert.equal(mine.table, 2);
    const destiny = data.destinies.find((record) => record.id === mine.destiny);
    assert.equal(destiny.role, game.seats[uid].role, 'the destiny belongs to the player role');
  }
  assert.equal(state.privates[carol.uid], undefined, 'a player of another table gets nothing');
  assert.equal(await read(host, `rooms/${code}/games/3`), null, 'other tables have not started');
  assert.equal(await read(host, `rooms/${code}/deals/3`), null);

  // 再按一次開始不會重來。
  assert.deepEqual(await startTable(host, code, 2, data), { started: false });
  assert.deepEqual(await readGame(code, 2), state);
});

test('players see their own cards without reloading and cannot read anyone else', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoom(t);
  const mine = watch(alice, code, watchPrivate);
  t.after(() => mine.stop());
  await mine.until((value) => value === null, 'alice has nothing before the start');

  await startTable(host, code, 2, data);
  const seen = await mine.until((value) => value?.hand?.length === START.handCount, 'alice sees her hand');
  assert.equal(seen.table, 2);
  assert.equal(typeof seen.destiny, 'string');
  const room = await watchers.alice.until((value) => value.games?.[2], 'alice sees the game');
  assert.deepEqual(room.games[2].seats[alice.uid].handCount, START.handCount);

  assert.deepEqual(await read(alice, `private/${code}/${alice.uid}`), seen);
  assert.equal((await read(bob, `private/${code}/${bob.uid}`)).hand.length, START.handCount);
  await assert.rejects(get(ref(alice.db, `private/${code}/${bob.uid}`)), denied);
  await assert.rejects(get(ref(bob.db, `private/${code}/${alice.uid}`)), denied);
  await assert.rejects(get(ref(alice.db, `private/${code}`)), denied);
  await assert.rejects(get(ref(carol.db, `private/${code}/${alice.uid}`)), denied);
  await assert.rejects(get(ref(alice.db, 'private')), denied);
});

test('hosts read every private record and the deck, players read neither the deck nor others', TIMEOUT, async (t) => {
  const { code } = await openRoom(t);
  await approveBackup(t, code);
  await startTable(host, code, 2, data);

  for (const session of [host, backup]) {
    const privates = await read(session, `private/${code}`);
    assert.deepEqual(sorted(Object.keys(privates)), sorted([alice.uid, bob.uid]));
    assert.equal((await read(session, `private/${code}/${bob.uid}`)).hand.length, START.handCount);
    assert.equal((await read(session, `hostOnly/${code}/2`)).deck.length, DECK_SIZE - 2 * START.handCount);
    assert.ok(await read(session, `hostOnly/${code}`));
  }
  for (const session of [alice, bob, carol]) {
    await assert.rejects(get(ref(session.db, `hostOnly/${code}`)), denied);
    await assert.rejects(get(ref(session.db, `hostOnly/${code}/2`)), denied);
    await assert.rejects(get(ref(session.db, `hostOnly/${code}/2/deck`)), denied);
  }
  await assert.rejects(get(ref(alice.db, 'hostOnly')), denied);
});

test('players cannot write private records, the deck, the game or the deals', TIMEOUT, async (t) => {
  const { code } = await openRoom(t);
  await startTable(host, code, 2, data);
  await advanceTo(code, 2, { round: 2, phase: 'sunrise' });
  const before = await readGame(code, 2);
  const card = data.actions[0].id;

  await assert.rejects(set(ref(alice.db, `private/${code}/${alice.uid}/hand`), [card, card, card, card, card, card, card]), denied);
  await assert.rejects(set(ref(alice.db, `private/${code}/${alice.uid}`), { table: 2, hand: [card] }), denied);
  await assert.rejects(set(ref(alice.db, `private/${code}/${bob.uid}/hand`), []), denied);
  await assert.rejects(set(ref(carol.db, `private/${code}/${carol.uid}`), { table: 3, hand: [card] }), denied);
  await assert.rejects(set(ref(alice.db, `hostOnly/${code}/2/deck`), [card]), denied);
  await assert.rejects(update(ref(alice.db, `rooms/${code}/games/2/seats/${alice.uid}`), { pounds: 99 }), denied);
  await assert.rejects(set(ref(alice.db, `rooms/${code}/games/2/deckCount`), 0), denied);
  await assert.rejects(set(ref(alice.db, `rooms/${code}/deals/2`), 2), denied);
  await assert.rejects(startTable(alice, code, 3, data), isDeniedByStore);
  await assert.rejects(processSunrise(alice, code, 2, data), isDeniedByStore);
  assert.deepEqual(await readGame(code, 2), before);
  assert.equal(before.deals, 1, 'the second sunrise is still waiting for a host');
  assert.equal(await read(host, `rooms/${code}/games/3`), null);
});

test('the public room carries no hand or destiny', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoom(t);
  await startTable(host, code, 2, data);
  const room = await watchers.bob.until((value) => value.games?.[2], 'bob sees the game');
  const text = JSON.stringify(room);
  assert.doesNotMatch(text, /"hand"|"destiny"|"deck"|"discard"/);
  const hidden = new Set([...data.actions.map((action) => action.id), ...data.destinies.map((destiny) => destiny.id)]);
  const values = [];
  JSON.parse(text, (key, value) => {
    if (typeof value === 'string') values.push(value);
    return value;
  });
  for (const value of values) assert.ok(!hidden.has(value), `the room shows ${value}`);
  assert.deepEqual(Object.keys(room.games[2]).sort(), ['deckCount', 'discardCount', 'seats', 'startedAt']);
  for (const seat of Object.values(room.games[2].seats)) {
    assert.deepEqual(Object.keys(seat).sort(), ['handCount', 'influence', 'order', 'pounds', 'role']);
  }
});

test('two hosts starting the same table at once start it only once', TIMEOUT, async (t) => {
  const { code } = await openRoom(t);
  await approveBackup(t, code);
  const results = await Promise.all([startTable(host, code, 2, data), startTable(backup, code, 2, data)]);
  assert.deepEqual(results.map((result) => result.started).sort(), [false, true]);

  const state = await readGame(code, 2);
  assert.equal(state.deals, 1);
  assertSeats(state, START);
  assert.equal(state.game.deckCount, DECK_SIZE - 2 * START.handCount);
  assertCardsConserved(state);
});

test('two hosts dealing the same sunrise at once deal it only once', TIMEOUT, async (t) => {
  const { code } = await openRoom(t);
  const seenByBackup = await approveBackup(t, code);
  await startTable(host, code, 2, data);
  await advanceTo(code, 2, { round: 2, phase: 'sunrise' });
  // 兩台都看到第 2 回合日出、還沒發牌，才會兩台都算好、都送出寫入。
  await seenByBackup.until((room) => room.tables[2].round === 2 && room.deals[2] === 1, 'backup sees the second sunrise');

  const results = await Promise.all([processSunrise(host, code, 2, data), processSunrise(backup, code, 2, data)]);
  assert.deepEqual(results.map((result) => result.dealt).sort(), [false, true]);
  for (const result of results) assert.equal(result.round, 2);

  const state = await readGame(code, 2);
  assert.equal(state.deals, 2);
  assertSeats(state, { pounds: START.pounds + salary, influence: START.influence, handCount: START.handCount + 2 });
  assert.equal(state.game.deckCount, DECK_SIZE - 2 * (START.handCount + 2));
  assertCardsConserved(state);
});

test('dealing at the second sunrise pays and draws for every seated player', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoom(t);
  const mine = watch(bob, code, watchPrivate);
  t.after(() => mine.stop());
  await startTable(host, code, 2, data);
  const startedAt = (await readGame(code, 2)).game.startedAt;

  // 日出以外、或這一回合已經發過，都不發。
  assert.deepEqual(await processSunrise(host, code, 2, data), { dealt: false, round: 1 });
  await advanceTo(code, 2, { round: 1, phase: 'day' });
  assert.deepEqual(await processSunrise(host, code, 2, data), { dealt: false, round: 1 });
  await advanceTo(code, 2, { round: 2, phase: 'sunrise' });
  const waiting = await readGame(code, 2);
  assert.equal(waiting.deals, 1, 'advancing does not deal by itself');
  assertSeats(waiting, START);

  assert.deepEqual(await processSunrise(host, code, 2, data), { dealt: true, round: 2 });
  const state = await readGame(code, 2);
  assert.equal(state.deals, 2);
  assert.equal(state.game.startedAt, startedAt, 'the start time stays');
  assertSeats(state, { pounds: 20, influence: 3, handCount: 8 });
  for (const uid of [alice.uid, bob.uid]) {
    assert.deepEqual(state.privates[uid].hand.slice(0, START.handCount), waiting.privates[uid].hand, 'the old cards stay');
    assert.equal(state.privates[uid].destiny, waiting.privates[uid].destiny);
  }
  assert.equal(state.game.deckCount, DECK_SIZE - 16);
  assertCardsConserved(state);
  await mine.until((value) => value?.hand?.length === 8, 'bob sees 8 cards');
  const room = await watchers.alice.until((value) => value.deals?.[2] === 2, 'alice sees the deal');
  assert.equal(room.games[2].seats[bob.uid].pounds, 20);

  assert.deepEqual(await processSunrise(host, code, 2, data), { dealt: false, round: 2 });
  assert.deepEqual(await readGame(code, 2), state);
  assert.deepEqual(await processSunrise(host, code, 3, data), { dealt: false, round: 1 }, 'a table that has not started');
});

test('deals must equal the current round and only go up', TIMEOUT, async (t) => {
  const { code } = await openRoom(t);
  const deals = `rooms/${code}/deals/2`;
  await assert.rejects(set(ref(host.db, `rooms/${code}/deals/3`), 1), denied, 'a table that has not started');
  await startTable(host, code, 2, data);

  await assert.rejects(set(ref(host.db, deals), 1), denied, 'the same round again');
  await assert.rejects(set(ref(host.db, deals), 2), denied, 'not the current round');
  await assert.rejects(remove(ref(host.db, deals)), denied);
  await advanceTo(code, 2, { round: 2, phase: 'sunrise' });
  await assert.rejects(set(ref(host.db, deals), 3), denied, 'ahead of the current round');
  await assert.rejects(set(ref(host.db, deals), 1), denied, 'backwards');
  await assert.rejects(set(ref(host.db, deals), 1.5), denied);
  await assert.rejects(set(ref(host.db, deals), '2'), denied);
  assert.equal(await read(host, deals), 1);
  assert.deepEqual(await processSunrise(host, code, 2, data), { dealt: true, round: 2 });
  await assert.rejects(set(ref(host.db, deals), 2), denied, 'dealt twice');
  assert.equal(await read(host, deals), 2);
});

test('rules keep the game, private records and deck in shape', TIMEOUT, async (t) => {
  const { code } = await openRoom(t);
  await startTable(host, code, 2, data);
  const game = `rooms/${code}/games/2`;
  const seat = `${game}/seats/${alice.uid}`;
  const before = await readGame(code, 2);

  // 開局只能一次：開始時間不能改、不能刪，整桌也不能刪掉重來。
  await assert.rejects(set(ref(host.db, `${game}/startedAt`), Date.now() - 1000), denied);
  await assert.rejects(remove(ref(host.db, `${game}/startedAt`)), denied);
  await assert.rejects(remove(ref(host.db, game)), denied);
  await assert.rejects(remove(ref(host.db, `rooms/${code}/games`)), denied);
  await assert.rejects(update(ref(host.db), { [game]: { ...before.game, startedAt: Date.now() - 1000 } }), denied);

  // 局面的欄位逐一檢查，多的欄位拒絕。
  await assert.rejects(update(ref(host.db, seat), { pounds: -1 }), denied);
  await assert.rejects(update(ref(host.db, seat), { influence: 1.5 }), denied);
  await assert.rejects(update(ref(host.db, seat), { order: 6 }), denied);
  await assert.rejects(update(ref(host.db, seat), { role: 'not a role' }), denied);
  await assert.rejects(update(ref(host.db, seat), { hand: ['a01'] }), denied);
  await assert.rejects(update(ref(host.db, game), { deckCount: -1 }), denied);
  await assert.rejects(update(ref(host.db, game), { deck: ['a01'] }), denied);
  await assert.rejects(set(ref(host.db, `${game}/seats`), 'none'), denied);
  await assert.rejects(set(ref(host.db, `rooms/${code}/games/7`), before.game), denied);

  // 私密資料與牌庫：牌與天命的編號、桌號、陣列的鍵。
  const mine = `private/${code}/${alice.uid}`;
  await assert.rejects(set(ref(host.db, `${mine}/hand`), ['bad card']), denied);
  await assert.rejects(set(ref(host.db, `${mine}/hand`), 'a01'), denied);
  await assert.rejects(set(ref(host.db, `${mine}/hand`), { first: 'a01' }), denied);
  await assert.rejects(set(ref(host.db, `${mine}/destiny`), 'x'.repeat(33)), denied);
  await assert.rejects(set(ref(host.db, `${mine}/table`), 7), denied);
  await assert.rejects(set(ref(host.db, `${mine}/note`), true), denied);
  await assert.rejects(set(ref(host.db, mine), { hand: ['a01'] }), denied, 'the table is required');
  await assert.rejects(set(ref(host.db, `hostOnly/${code}/2/deck`), ['a01', 'no good']), denied);
  await assert.rejects(set(ref(host.db, `hostOnly/${code}/2/extra`), ['a01']), denied);
  await assert.rejects(set(ref(host.db, `hostOnly/${code}/9`), { deck: ['a01'] }), denied);
  await assert.rejects(set(ref(host.db, `hostOnly/${code}/2/deck/x`), 'a01'), denied);
  assert.deepEqual(await readGame(code, 2), before);

  // 合格的寫入照樣成功（主持端之後的結算會用到）。
  await update(ref(host.db, seat), { pounds: 0 });
  assert.equal(await read(host, `${seat}/pounds`), 0);
});

test('a table cannot start empty, with too many players, or after it has moved on', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoom(t);
  await assert.rejects(startTable(host, code, 1, data), cannotStart(/還沒有玩家/));
  await assert.rejects(startTable(host, code, 9, data), (error) => error instanceof StoreError && error.code === 'invalid-table');
  await assert.rejects(startTable(host, 'ZZZZ95', 1, data), (error) => error instanceof StoreError && error.code === 'room-not-found');

  // 七個人坐同一桌：不能開。
  const extra = await Promise.all(['seven-1', 'seven-2', 'seven-3', 'seven-4', 'seven-5'].map((slot) => connect(slot)));
  t.after(() => Promise.all(extra.map(disconnect)));
  await Promise.all(extra.map((session, index) => joinRoom(session, code, `P${index + 1}`, 2)));
  // 開局照主持端看到的名單算，先等主持端看到每一個人。
  const atTable2 = (count) => (room) => Object.values(room.players ?? {}).filter((player) => player.table === 2).length === count;
  await watchers.host.until(atTable2(7), 'host sees seven players at table 2');
  await assert.rejects(startTable(host, code, 2, data), cannotStart(/最多 6 人，現在有 7 人/));
  // 走掉一個就能開。
  await remove(ref(extra[0].db, `rooms/${code}/players/${extra[0].uid}`));
  await watchers.host.until(atTable2(6), 'host sees six players at table 2');
  assert.deepEqual(await startTable(host, code, 2, data), { started: true });
  const state = await readGame(code, 2);
  assert.equal(Object.keys(state.game.seats).length, 6);
  assert.equal(new Set(Object.values(state.game.seats).map((seat) => seat.role)).size, 6);
  assert.deepEqual(sorted(Object.values(state.game.seats).map((seat) => seat.order)), [0, 1, 2, 3, 4, 5]);
  assertCardsConserved(state);

  // 已經推進過的桌子不能開局。
  await advanceTable(host, code, 3, { round: 1, phase: 'sunrise' });
  await assert.rejects(startTable(host, code, 3, data), cannotStart(/已經推進過/));
});

test('a player who joins after the start is not seated and gets nothing at sunrise', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoom(t);
  await startTable(host, code, 2, data);
  await joinRoom(carol, code, 'Carol', 2);
  await watchers.host.until((room) => room.players[carol.uid].table === 2, 'host sees carol at table 2');
  await advanceTo(code, 2, { round: 2, phase: 'sunrise' });
  assert.deepEqual(await processSunrise(host, code, 2, data), { dealt: true, round: 2 });

  const state = await readGame(code, 2);
  assert.equal(state.game.seats[carol.uid], undefined);
  assert.equal(state.privates[carol.uid], undefined);
  assert.equal(await read(carol, `private/${code}/${carol.uid}`), null);
  assertSeats(state, { pounds: 20, influence: 3, handCount: 8 });
});
