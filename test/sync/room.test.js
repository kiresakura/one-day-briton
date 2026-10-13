// 對模擬器跑的同步與權限測試，直接使用 play/js/store.js（npm run test:sync）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp, initializeApp } from 'firebase/app';
import {
  connectDatabaseEmulator,
  get,
  getDatabase,
  goOffline,
  goOnline,
  ref,
  remove,
  set,
  update,
} from 'firebase/database';
import { config } from '../../play/js/config.js';
import { hostUids, isHostOf } from '../../play/js/rules.js';
import {
  StoreError,
  advanceTable,
  approveHost,
  cancelHostRequest,
  connect,
  createRoom,
  disconnect,
  enterAsHost,
  joinRoom,
  leaveRoom,
  rejectHost,
  trackPresence,
  watchConnection,
  watchRoom,
} from '../../play/js/store.js';

const TIMEOUT = { timeout: 20_000 };
const denied = /permission[_ ]denied/i;

let host;
let alice;
let bob;
let backup;

before(async () => {
  [host, alice, bob, backup] = await Promise.all([
    connect('host'),
    connect('alice'),
    connect('bob'),
    connect('backup'),
  ]);
});

after(async () => {
  await Promise.all([host, alice, bob, backup].filter(Boolean).map(disconnect));
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

// 備援裝置用房號申請、原主持端核准，等到備援裝置自己看到名單上有它。回傳備援裝置的訂閱。
async function approveBackup(t, code, hostWatcher) {
  const watcher = watch(backup, code);
  t.after(() => watcher.stop());
  assert.deepEqual(await enterAsHost(backup, code), { code, host: false });
  await hostWatcher.until(asksToHost(backup.uid), 'host sees the request');
  await approveHost(host, code, backup.uid);
  await watcher.until(listsAsHost(backup.uid), 'backup sees itself on the host list');
  return watcher;
}

const asksToHost = (uid) => (room) => Boolean(room?.hostRequests?.[uid]);
const listsAsHost = (uid) => (room) => room?.hosts?.[uid] === true;
const isOnline = (uid) => (room) => room?.presence?.[uid] === true;
const isOffline = (uid) => (room) => room?.presence?.[uid] === undefined;
const isDeniedByStore = (error) => error instanceof StoreError && error.code === 'permission-denied';
const stepOf = (table) => ({ round: table.round, phase: table.phase });

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

test('advancing works without the room loaded on that device', TIMEOUT, async () => {
  // 沒有訂閱時本機沒有這一桌的資料，交易第一次會拿到 null，要靠伺服器帶最新資料重跑。
  const code = await createRoom(host);
  const first = await advanceTable(host, code, 1, { round: 1, phase: 'sunrise' });
  assert.equal(first.advanced, true);
  assert.deepEqual({ round: first.table.round, phase: first.table.phase }, { round: 1, phase: 'day' });

  const stale = await advanceTable(host, code, 1, { round: 1, phase: 'sunrise' });
  assert.equal(stale.advanced, false);
  assert.equal((await readTable(host, code, 1)).phase, 'day');

  await assert.rejects(
    advanceTable(bob, code, 1, { round: 1, phase: 'day' }),
    (error) => error instanceof StoreError && error.code === 'permission-denied',
  );
  assert.equal((await readTable(host, code, 1)).phase, 'day');

  const missing = await advanceTable(host, code, 9, { round: 1, phase: 'sunrise' });
  assert.deepEqual(missing, { advanced: false, table: null });
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
  const { code, watchers } = await openRoomWithTwoPlayers(t);
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
  // 合格的寫入要成功，並且傳到另一台裝置（對方有訂閱時 get 會先回本機快取，所以用訂閱等）。
  await update(ref(host.db, table), { fog: 100 });
  const room = await watchers.alice.until((value) => value.tables[2].fog === 100, 'alice sees fog 100');
  assert.equal(room.tables[2].fog, 100);
});

test('a player who leaves disappears from the room', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoomWithTwoPlayers(t);
  await leaveRoom(alice, code);
  const room = await watchers.host.until((value) => Object.keys(value.players ?? {}).length === 1, 'one player left');
  assert.deepEqual(Object.keys(room.players), [bob.uid]);
});

test('a backup device asks to host, is approved, and can then advance', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoomWithTwoPlayers(t);
  const seenByBackup = watch(backup, code);
  t.after(() => seenByBackup.stop());

  assert.deepEqual(await enterAsHost(backup, ` ${code.toLowerCase()} `), { code, host: false });
  const asked = await watchers.host.until(asksToHost(backup.uid), 'host sees the request');
  assert.deepEqual(Object.keys(asked.hostRequests), [backup.uid]);
  assert.equal(typeof asked.hostRequests[backup.uid].requestedAt, 'number');
  assert.ok(!isHostOf(asked, backup.uid));

  await approveHost(host, code, backup.uid);
  const approved = await seenByBackup.until(listsAsHost(backup.uid), 'backup sees itself on the host list');
  assert.equal(approved.hostRequests, undefined, 'the request is cleared by the same write');
  assert.deepEqual(hostUids(approved), [host.uid, backup.uid]);
  assert.equal(approved.meta.hostUid, host.uid, 'the room creator stays the same');

  const result = await advanceTable(backup, code, 2, { round: 1, phase: 'sunrise' });
  assert.equal(result.advanced, true);
  const isDay = (room) => room.tables[2].phase === 'day';
  await Promise.all([watchers.alice.until(isDay, 'alice sees day'), watchers.host.until(isDay, 'host sees day')]);

  // 已經是主持端的人再用房號進來，直接算主持端，不會再留下申請。
  assert.deepEqual(await enterAsHost(backup, code), { code, host: true });
  assert.deepEqual(await enterAsHost(host, code), { code, host: true });
  await advanceTable(host, code, 1, { round: 1, phase: 'sunrise' });
  const later = await watchers.alice.until((room) => room.tables[1].phase === 'day', 'alice sees table 1 move');
  assert.equal(later.hostRequests, undefined);
});

test('a device that was not approved cannot advance or change the host list', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoomWithTwoPlayers(t);
  const now = Date.now() - 60_000;
  await enterAsHost(backup, code);
  await watchers.host.until(asksToHost(backup.uid), 'host sees the request');

  await assert.rejects(advanceTable(backup, code, 2, { round: 1, phase: 'sunrise' }), isDeniedByStore);

  // 任何人都不能把自己或別人加進主持名單，申請中的人也不能核准自己。
  await assert.rejects(set(ref(backup.db, `rooms/${code}/hosts/${backup.uid}`), true), denied);
  await assert.rejects(set(ref(alice.db, `rooms/${code}/hosts/${alice.uid}`), true), denied);
  await assert.rejects(set(ref(alice.db, `rooms/${code}/hosts/${bob.uid}`), true), denied);
  await assert.rejects(approveHost(backup, code, backup.uid), isDeniedByStore);
  await assert.rejects(approveHost(alice, code, backup.uid), isDeniedByStore);
  await assert.rejects(
    update(ref(backup.db, `rooms/${code}`), { [`hosts/${backup.uid}`]: true, 'tables/2/phase': 'night' }),
    denied,
  );

  // 玩家不能刪別人的申請，也不能替別人申請。
  await assert.rejects(remove(ref(alice.db, `rooms/${code}/hostRequests/${backup.uid}`)), denied);
  await assert.rejects(rejectHost(alice, code, backup.uid), isDeniedByStore);
  await assert.rejects(set(ref(alice.db, `rooms/${code}/hostRequests/${bob.uid}`), { requestedAt: now }), denied);

  // 申請與名單的格式。
  const mine = `rooms/${code}/hostRequests/${alice.uid}`;
  await assert.rejects(set(ref(alice.db, mine), true), denied);
  await assert.rejects(set(ref(alice.db, mine), { requestedAt: 'now' }), denied);
  await assert.rejects(set(ref(alice.db, mine), { requestedAt: Date.now() + 3_600_000 }), denied);
  await assert.rejects(set(ref(alice.db, mine), { requestedAt: now, note: 'let me in' }), denied);
  await assert.rejects(set(ref(host.db, `rooms/${code}/hosts/${backup.uid}`), 'yes'), denied);
  await assert.rejects(set(ref(host.db, `rooms/${code}/hosts/${backup.uid}`), { role: 'host' }), denied);

  // 房間不存在就不能申請。
  await assert.rejects(enterAsHost(backup, 'ZZZZ97'), (error) => error instanceof StoreError && error.code === 'room-not-found');
  await assert.rejects(enterAsHost(backup, 'abc'), (error) => error instanceof StoreError && error.code === 'invalid-code');
  await assert.rejects(set(ref(backup.db, `rooms/ZZZZ97/hostRequests/${backup.uid}`), { requestedAt: now }), denied);

  // 以上都沒留下任何東西：等主持端下一筆寫入傳到玩家，再看那時的房間。
  await advanceTable(host, code, 1, { round: 1, phase: 'sunrise' });
  const room = await watchers.alice.until((value) => value.tables[1].phase === 'day', 'alice sees table 1 move');
  assert.equal(room.hosts, undefined);
  assert.deepEqual(Object.keys(room.hostRequests), [backup.uid]);
  assert.deepEqual(stepOf(room.tables[2]), { round: 1, phase: 'sunrise' });
});

test('an approved backup host keeps the room going after the first host drops offline', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoomWithTwoPlayers(t);
  const seenByBackup = await approveBackup(t, code, watchers.host);

  t.after(() => goOnline(host.db));
  goOffline(host.db);
  const result = await advanceTable(backup, code, 2, { round: 1, phase: 'sunrise' });
  assert.equal(result.advanced, true);
  const isDay = (room) => room.tables[2].phase === 'day';
  await Promise.all([watchers.alice.until(isDay, 'alice sees day'), watchers.bob.until(isDay, 'bob sees day')]);
  assert.equal(watchers.host.room.tables[2].phase, 'sunrise', 'the offline host has not heard about it');

  // 原主持端連回來後跟上進度，而且仍然是主持端。
  goOnline(host.db);
  await watchers.host.until(isDay, 'the first host catches up after reconnecting');
  const next = await advanceTable(host, code, 2, { round: 1, phase: 'day' });
  assert.equal(next.advanced, true);
  await seenByBackup.until((room) => room.tables[2].phase === 'dusk', 'backup sees dusk');
});

test('two hosts advancing from the same state move the table one step only', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoomWithTwoPlayers(t);
  await approveBackup(t, code, watchers.host);

  const expected = { round: 1, phase: 'sunrise' };
  const results = await Promise.all([
    advanceTable(host, code, 2, expected),
    advanceTable(backup, code, 2, expected),
  ]);
  assert.deepEqual(results.map((result) => result.advanced).sort(), [false, true]);
  for (const result of results) assert.deepEqual(stepOf(result.table), { round: 1, phase: 'day' });

  // 兩筆都結束後再送一筆別桌的推進，玩家收到時第 2 桌仍然只前進了一步。
  await advanceTable(backup, code, 1, expected);
  const room = await watchers.alice.until((value) => value.tables[1].phase === 'day', 'alice sees table 1 move');
  assert.deepEqual(stepOf(room.tables[2]), { round: 1, phase: 'day' });
});

test('a host can turn a request down and an applicant can withdraw it', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoomWithTwoPlayers(t);
  const seenByBackup = watch(backup, code);
  t.after(() => seenByBackup.stop());
  const noRequests = (room) => room.hostRequests === undefined;

  await enterAsHost(backup, code);
  await watchers.host.until(asksToHost(backup.uid), 'host sees the request');
  await rejectHost(host, code, backup.uid);
  const rejected = await seenByBackup.until(noRequests, 'backup sees the request removed');
  assert.equal(rejected.hosts, undefined);

  await enterAsHost(backup, code);
  await watchers.host.until(asksToHost(backup.uid), 'host sees the second request');
  await cancelHostRequest(backup, code);
  const withdrawn = await watchers.host.until(noRequests, 'host sees the request withdrawn');
  assert.equal(withdrawn.hosts, undefined);

  await assert.rejects(advanceTable(backup, code, 2, { round: 1, phase: 'sunrise' }), isDeniedByStore);
});

test('an approved host can approve another device', TIMEOUT, async (t) => {
  const code = await createRoom(host);
  const watchers = { host: watch(host, code), bob: watch(bob, code) };
  t.after(() => Object.values(watchers).forEach((watcher) => watcher.stop()));
  const seenByBackup = await approveBackup(t, code, watchers.host);

  assert.deepEqual(await enterAsHost(bob, code), { code, host: false });
  await seenByBackup.until(asksToHost(bob.uid), 'backup sees the request');
  await approveHost(backup, code, bob.uid);
  const approved = await watchers.bob.until(listsAsHost(bob.uid), 'bob sees itself on the host list');
  assert.deepEqual(hostUids(approved).sort(), [host.uid, backup.uid, bob.uid].sort());
  assert.equal(approved.hostRequests, undefined);

  const result = await advanceTable(bob, code, 1, { round: 1, phase: 'sunrise' });
  assert.equal(result.advanced, true);
  await watchers.host.until((room) => room.tables[1].phase === 'day', 'host sees day');
});

test('a device is told when its own connection drops and comes back', TIMEOUT, async (t) => {
  const seen = [];
  let wake = () => {};
  const stop = watchConnection(bob, (connected) => {
    seen.push(connected);
    wake();
  });
  t.after(() => {
    stop();
    goOnline(bob.db);
  });
  const until = (connected) =>
    new Promise((resolve) => {
      wake = () => seen.at(-1) === connected && resolve();
      wake();
    });

  await until(true);
  goOffline(bob.db);
  await until(false);
  goOnline(bob.db);
  await until(true);
  assert.deepEqual(seen.slice(-3), [true, false, true]);
});

test('presence follows each device as it connects, drops, returns and leaves', TIMEOUT, async (t) => {
  const { code, watchers } = await openRoomWithTwoPlayers(t);
  assert.equal(watchers.bob.room.presence, undefined, 'nobody is marked online before tracking starts');

  const stopAlice = trackPresence(alice, code);
  const stopHost = trackPresence(host, code);
  t.after(async () => {
    goOnline(alice.db);
    await Promise.allSettled([stopAlice(), stopHost()]);
  });
  const both = await watchers.bob.until(
    (room) => isOnline(alice.uid)(room) && isOnline(host.uid)(room),
    'bob sees alice and the host online',
  );
  assert.deepEqual(both.presence, { [alice.uid]: true, [host.uid]: true });

  goOffline(alice.db);
  const dropped = await watchers.bob.until(isOffline(alice.uid), 'bob sees alice drop');
  assert.deepEqual(dropped.presence, { [host.uid]: true });
  assert.equal(dropped.players[alice.uid].name, 'Alice', 'the player record stays while offline');

  // 連回來後要重新登記：再斷一次，伺服器仍然會代為移除。
  goOnline(alice.db);
  await watchers.bob.until(isOnline(alice.uid), 'bob sees alice return');
  goOffline(alice.db);
  await watchers.bob.until(isOffline(alice.uid), 'bob sees alice drop a second time');
  goOnline(alice.db);
  await watchers.bob.until(isOnline(alice.uid), 'bob sees alice return a second time');

  await stopAlice();
  const left = await watchers.bob.until(isOffline(alice.uid), 'bob sees alice leave');
  assert.deepEqual(left.presence, { [host.uid]: true });
});

test('presence is restored when something else removes it while the device is still connected', TIMEOUT, async (t) => {
  // 同一個身分較早的連線晚一步斷開時，伺服器會移掉這一筆；這裡直接移除來模擬。
  const { code, watchers } = await openRoomWithTwoPlayers(t);
  const stopAlice = trackPresence(alice, code);
  t.after(() => stopAlice().catch(() => {}));
  await watchers.bob.until(isOnline(alice.uid), 'bob sees alice online');

  const sawDrop = watchers.bob.until(isOffline(alice.uid), 'bob sees the record removed');
  await remove(ref(alice.db, `rooms/${code}/presence/${alice.uid}`));
  await sawDrop;
  await watchers.bob.until(isOnline(alice.uid), 'bob sees alice online again');

  // 離開之後就不再補回去。
  await stopAlice();
  await watchers.bob.until(isOffline(alice.uid), 'bob sees alice leave');
  await advanceTable(host, code, 1, { round: 1, phase: 'sunrise' });
  const room = await watchers.bob.until((value) => value.tables[1].phase === 'day', 'bob sees table 1 move');
  assert.equal(room.presence, undefined);
});

test("a device cannot write someone else's presence", TIMEOUT, async (t) => {
  const { code, watchers } = await openRoomWithTwoPlayers(t);
  const mine = `rooms/${code}/presence/${alice.uid}`;
  const bobs = `rooms/${code}/presence/${bob.uid}`;
  await set(ref(bob.db, bobs), true);
  await watchers.alice.until(isOnline(bob.uid), 'alice sees bob online');

  await assert.rejects(set(ref(alice.db, bobs), true), denied);
  await assert.rejects(remove(ref(alice.db, bobs)), denied);
  await assert.rejects(remove(ref(host.db, bobs)), denied);
  await assert.rejects(set(ref(host.db, `rooms/${code}/presence/someone-else`), true), denied);
  await assert.rejects(set(ref(alice.db, mine), 'yes'), denied);
  await assert.rejects(set(ref(alice.db, mine), false), denied);
  await assert.rejects(set(ref(alice.db, mine), { since: Date.now() - 60_000 }), denied);
  await assert.rejects(set(ref(alice.db, `rooms/ZZZZ96/presence/${alice.uid}`), true), denied);

  // 自己那一筆寫得進去，而且前面被拒絕的都沒有留下東西。
  await set(ref(alice.db, mine), true);
  const room = await watchers.host.until(isOnline(alice.uid), 'host sees alice online');
  assert.deepEqual(room.presence, { [alice.uid]: true, [bob.uid]: true });
});
