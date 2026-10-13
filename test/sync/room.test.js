// 對模擬器跑的同步與權限測試，直接使用 play/js/store.js（npm run test:sync）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectDatabaseEmulator, get, getDatabase, ref, set, update } from 'firebase/database';
import { config } from '../../play/js/config.js';
import {
  StoreError,
  advanceTable,
  connect,
  createRoom,
  disconnect,
  joinRoom,
  leaveRoom,
  watchRoom,
} from '../../play/js/store.js';

const TIMEOUT = { timeout: 20_000 };
const denied = /permission[_ ]denied/i;

let host;
let alice;
let bob;

before(async () => {
  [host, alice, bob] = await Promise.all([connect('host'), connect('alice'), connect('bob')]);
});

after(async () => {
  await Promise.all([host, alice, bob].filter(Boolean).map(disconnect));
});

// 訂閱房間並記住最新狀態；until() 等到條件成立，逾時就失敗。
function watch(session, code) {
  let latest;
  const waiters = new Set();
  const stop = watchRoom(session, code, (room) => {
    latest = room;
    for (const check of [...waiters]) check();
  });
  return {
    stop,
    get room() {
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

// 開一間新房，兩位玩家加入第 2 桌，三方都訂閱。
async function openRoomWithTwoPlayers(t) {
  const code = await createRoom(host);
  await joinRoom(alice, code, 'Alice', 2);
  await joinRoom(bob, code, 'Bob', 2);
  const watchers = { host: watch(host, code), alice: watch(alice, code), bob: watch(bob, code) };
  t.after(() => Object.values(watchers).forEach((watcher) => watcher.stop()));
  const bothListed = (room) => Object.keys(room?.players ?? {}).length === 2;
  await Promise.all(Object.values(watchers).map((watcher) => watcher.until(bothListed, 'both players listed')));
  return { code, watchers };
}

const readTable = async (session, code, table) => (await get(ref(session.db, `rooms/${code}/tables/${table}`))).val();

test('each connection gets its own anonymous identity', TIMEOUT, () => {
  assert.equal(new Set([host.uid, alice.uid, bob.uid]).size, 3);
});

test('host and two players see the same room after joining with the code', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoomWithTwoPlayers(t);
  assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);

  const room = watchers.host.room;
  assert.deepEqual(watchers.alice.room, room);
  assert.deepEqual(watchers.bob.room, room);

  assert.equal(room.meta.hostUid, host.uid);
  assert.equal(room.meta.tableCount, 6);
  assert.equal(typeof room.meta.createdAt, 'number');
  assert.deepEqual(Object.keys(room.tables), ['1', '2', '3', '4', '5', '6']);
  for (const table of Object.values(room.tables)) {
    assert.deepEqual({ round: table.round, phase: table.phase, fog: table.fog }, { round: 1, phase: 'sunrise', fog: 0 });
  }
  assert.deepEqual(Object.keys(room.players).sort(), [alice.uid, bob.uid].sort());
  assert.deepEqual(
    { name: room.players[alice.uid].name, table: room.players[alice.uid].table },
    { name: 'Alice', table: 2 },
  );
  assert.deepEqual(
    { name: room.players[bob.uid].name, table: room.players[bob.uid].table },
    { name: 'Bob', table: 2 },
  );
});

test('one advance by the host reaches both players as day of round 1', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoomWithTwoPlayers(t);
  const result = await advanceTable(host, code, 2, { round: 1, phase: 'sunrise' });
  assert.equal(result.advanced, true);
  assert.equal(result.table.phase, 'day');

  const isDay = (room) => room.tables[2].phase === 'day';
  const [seenByAlice, seenByBob] = await Promise.all([
    watchers.alice.until(isDay, 'alice sees day'),
    watchers.bob.until(isDay, 'bob sees day'),
  ]);
  assert.equal(seenByAlice.tables[2].round, 1);
  assert.equal(seenByBob.tables[2].round, 1);
  assert.equal(seenByAlice.tables[1].phase, 'sunrise', 'other tables are untouched');
});

test('advancing with a stale view of the phase changes nothing', TIMEOUT, async (t) => {
  const { code } = await openRoomWithTwoPlayers(t);
  await advanceTable(host, code, 2, { round: 1, phase: 'sunrise' });
  const before = await readTable(host, code, 2);

  const stale = await advanceTable(host, code, 2, { round: 1, phase: 'sunrise' });
  assert.equal(stale.advanced, false);
  assert.deepEqual(await readTable(host, code, 2), before);
  assert.equal(before.phase, 'day');
});

test('a double click advances only one step', TIMEOUT, async (t) => {
  const { code } = await openRoomWithTwoPlayers(t);
  const expected = { round: 1, phase: 'sunrise' };
  const results = await Promise.all([advanceTable(host, code, 2, expected), advanceTable(host, code, 2, expected)]);
  assert.deepEqual(results.map((result) => result.advanced).sort(), [false, true]);
  const table = await readTable(host, code, 2);
  assert.deepEqual({ round: table.round, phase: table.phase }, { round: 1, phase: 'day' });
});

test('four advances lead to sunrise of round 2', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoomWithTwoPlayers(t);
  let state = { round: 1, phase: 'sunrise' };
  for (let step = 0; step < 4; step += 1) {
    const { advanced, table } = await advanceTable(host, code, 2, state);
    assert.equal(advanced, true);
    state = { round: table.round, phase: table.phase };
  }
  assert.deepEqual(state, { round: 2, phase: 'sunrise' });
  const room = await watchers.bob.until((value) => value.tables[2].round === 2, 'bob sees round 2');
  assert.equal(room.tables[2].phase, 'sunrise');
});

test('a player cannot advance the phase', TIMEOUT, async (t) => {
  const { code } = await openRoomWithTwoPlayers(t);
  const before = await readTable(host, code, 2);
  await assert.rejects(
    advanceTable(alice, code, 2, { round: 1, phase: 'sunrise' }),
    (error) => error instanceof StoreError && error.code === 'permission-denied',
  );
  await assert.rejects(update(ref(alice.db, `rooms/${code}/tables/2`), { phase: 'night' }), denied);
  assert.deepEqual(await readTable(host, code, 2), before);
});

test("a player cannot write someone else's player record", TIMEOUT, async (t) => {
  const { code } = await openRoomWithTwoPlayers(t);
  const record = { name: 'Mallory', table: 1, joinedAt: Date.now() - 60_000 };
  await assert.rejects(set(ref(alice.db, `rooms/${code}/players/${bob.uid}`), record), denied);
  await assert.rejects(set(ref(alice.db, `rooms/${code}/players/someone-else`), record), denied);
  const bobRecord = (await get(ref(host.db, `rooms/${code}/players/${bob.uid}`))).val();
  assert.equal(bobRecord.name, 'Bob');
});

test('joining a room that does not exist fails with a clear error', TIMEOUT, async () => {
  await assert.rejects(joinRoom(alice, 'ZZZZ99', 'Alice', 1), (error) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, 'room-not-found');
    assert.match(error.message, /ZZZZ99/);
    return true;
  });
});

test('join input is validated before anything is written', TIMEOUT, async (t) => {
  const { code } = await openRoomWithTwoPlayers(t);
  const codeOf = (expected) => (error) => error instanceof StoreError && error.code === expected;
  await assert.rejects(joinRoom(alice, 'abc', 'Alice', 1), codeOf('invalid-code'));
  await assert.rejects(joinRoom(alice, code, '   ', 1), codeOf('invalid-name'));
  await assert.rejects(joinRoom(alice, code, 'x'.repeat(13), 1), codeOf('invalid-name'));
  await assert.rejects(joinRoom(alice, code, 'Alice', 7), codeOf('invalid-table'));
  assert.equal(await joinRoom(alice, ` ${code.toLowerCase()} `, '  Alice  ', 3), code, 'code and name are normalised');
  const record = (await get(ref(alice.db, `rooms/${code}/players/${alice.uid}`))).val();
  assert.deepEqual({ name: record.name, table: record.table }, { name: 'Alice', table: 3 });
});

test('reading a room without signing in is denied', TIMEOUT, async (t) => {
  const { code } = await openRoomWithTwoPlayers(t);
  // store.js 一律會登入，所以這裡直接用 SDK 開一個沒登入的連線。
  const app = initializeApp(config.firebase, 'signed-out');
  t.after(() => deleteApp(app));
  const db = getDatabase(app);
  connectDatabaseEmulator(db, config.emulator.host, config.emulator.databasePort);
  await assert.rejects(get(ref(db, `rooms/${code}`)), denied);
  await assert.rejects(get(ref(db, `rooms/${code}/meta`)), denied);
});

test('rooms cannot be listed, even when signed in', TIMEOUT, async () => {
  await assert.rejects(get(ref(alice.db, 'rooms')), denied);
  await assert.rejects(get(ref(alice.db, '/')), denied);
});

test('rules reject taking over a room and malformed data', TIMEOUT, async (t) => {
  const { code } = await openRoomWithTwoPlayers(t);
  const now = Date.now() - 60_000;
  const mine = `rooms/${code}/players/${alice.uid}`;

  // 房間建立後，任何人都不能改寫 meta（包含主持端自己）。
  const takeover = { hostUid: alice.uid, createdAt: now, tableCount: 6 };
  await assert.rejects(set(ref(alice.db, `rooms/${code}/meta`), takeover), denied);
  await assert.rejects(update(ref(host.db, `rooms/${code}/meta`), { tableCount: 3 }), denied);

  // 不能替別人開房，也不能在不存在的房間留下資料。
  await assert.rejects(set(ref(alice.db, 'rooms/ABCDEF/meta'), { hostUid: bob.uid, createdAt: now, tableCount: 6 }), denied);
  await assert.rejects(set(ref(alice.db, `rooms/ZZZZ98/players/${alice.uid}`), { name: 'Alice', table: 1, joinedAt: now }), denied);
  await assert.rejects(set(ref(alice.db, 'rooms/bad-code/meta'), { hostUid: alice.uid, createdAt: now, tableCount: 6 }), denied);

  // 玩家資料的格式。
  await assert.rejects(set(ref(alice.db, mine), { name: 'x'.repeat(13), table: 2, joinedAt: now }), denied);
  await assert.rejects(set(ref(alice.db, mine), { name: '', table: 2, joinedAt: now }), denied);
  await assert.rejects(set(ref(alice.db, mine), { name: 'Alice', table: 7, joinedAt: now }), denied);
  await assert.rejects(set(ref(alice.db, mine), { name: 'Alice', table: 1.5, joinedAt: now }), denied);
  await assert.rejects(set(ref(alice.db, mine), { name: 'Alice', table: 2, joinedAt: now, role: 'host' }), denied);

  // 主持端寫入的桌面狀態也要合格。
  const table = `rooms/${code}/tables/2`;
  await assert.rejects(update(ref(host.db, table), { phase: 'noon' }), denied);
  await assert.rejects(update(ref(host.db, table), { round: 0 }), denied);
  await assert.rejects(update(ref(host.db, table), { fog: 101 }), denied);
  await assert.rejects(update(ref(host.db, table), { fog: -1 }), denied);
  await assert.rejects(set(ref(host.db, `rooms/${code}/tables/7`), { round: 1, phase: 'sunrise', fog: 0, updatedAt: now }), denied);
  await update(ref(host.db, table), { fog: 100 });
  assert.equal((await readTable(alice, code, 2)).fog, 100);
});

test('a player who leaves disappears from the room', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoomWithTwoPlayers(t);
  await leaveRoom(alice, code);
  const room = await watchers.host.until((value) => Object.keys(value.players ?? {}).length === 1, 'one player left');
  assert.deepEqual(Object.keys(room.players), [bob.uid]);
});
