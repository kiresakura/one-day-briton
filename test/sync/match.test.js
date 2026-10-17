// 兩場制的同步與權限測試（M9）：第 2 場用局號 {n}-2，掛在 tables、games、deals、hostOnly 底下；開場分兩步（openMatch 建桌並鎖住
// 第 1 場、startTable 開局）；第 2 場的座位只給第 1 場同桌的人、座位號不變；第 1 場鎖住、第 2 場刪不掉；第 1 場留下的請求、票、
// 選擇、挑的棄牌不算進第 2 場；兩場合計；重新整理後回到第 2 場；兩桌在不同場；離開與新人（npm run test:sync）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get, goOffline, goOnline, ref, serverTimestamp, set, update } from 'firebase/database';
import { combineScores, nightSettleAt, pendingDestinies, rotateSeats, seatsInOrder, seededRandom, shouldEnd } from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';
import { activeKey } from '../../play/js/rules.js';
import {
  StoreError,
  advanceOrEnd,
  advanceTable,
  approveHost,
  connect,
  createRoom,
  disconnect,
  enterAsHost,
  joinRoom,
  judgeDestiny,
  leaveRoom,
  openMatch,
  processSunrise,
  requestDiscard,
  requestNight,
  requestPass,
  requestVote,
  revealNight,
  serverTime,
  setEndAfterRound,
  setStartOrder,
  settleDusk,
  settleNight,
  settleRequest,
  startSettling,
  startTable,
  watchPrivate,
  watchRoom,
} from '../../play/js/store.js';

const TIMEOUT = { timeout: 60_000 };
const denied = /permission[_ ]denied/i;
const cardDir = new URL('../../play/data/', import.meta.url);
const { data: fileData, errors } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
assert.deepEqual(errors, []);
const roleIds = fileData.roles.map((role) => role.id);
const blank = roleIds.map((role, index) => ({ id: `t${index + 1}`, role, text: `測試天命 ${index + 1}`, score: { text: '測試', points: 10 }, check: null }));
// 日出不翻一般事件；黑夜倒數 1 秒；天命都是「判定」空白的（終局時待主持人判定）。第 1 場開局另外翻 1 張一般事件，事件紀錄才有東西。
const data = { ...fileData, destinies: blank, settings: { ...fileData.settings, sunriseEvents: 0, nightRevealSeconds: 1 } };
const withEvent = { ...data, settings: { ...data.settings, sunriseEvents: 1 } };
const { startingPounds, startingInfluence, startingHand, drawPerSunrise } = fileData.settings;
const salary = new Map(fileData.roles.map((role) => [role.id, role.salary]));

let host;
let backup;
let p1;
let p2;
let p3;
let outsider;
let late;

before(async () => {
  [host, backup, p1, p2, p3, outsider, late] = await Promise.all(['host', 'backup', 'p1', 'p2', 'p3', 'outsider', 'late'].map((slot) => connect(slot)));
});

after(async () => {
  await Promise.all([host, backup, p1, p2, p3, outsider, late].filter(Boolean).map(disconnect));
});

function watch(session, code) {
  let latest;
  const waiters = new Set();
  const stop = watchRoom(session, code, (value) => {
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
const storeError = (code, pattern = /./) => (error) => error instanceof StoreError && error.code === code && pattern.test(error.message);
const freshTable = (changes = {}) => ({ round: 1, phase: 'sunrise', fog: 0, updatedAt: serverTimestamp(), ...changes });

async function untilServerTime(session, at) {
  for (let left = at - serverTime(session); left > 0; left = at - serverTime(session)) await sleep(Math.min(left + 5, 250));
}

// 從這一回合的 from 推進到黑夜（黃昏不開法案），開黑夜、提前揭曉（沒人送出，全員睡覺）、過了緩衝揭曉。key 是局號。
async function nightRevealed(code, key, round, { from = 'day' } = {}) {
  const phases = ['sunrise', 'day', 'dusk'];
  for (const phase of phases.slice(phases.indexOf(from))) await advanceTable(host, code, key, { round, phase });
  assert.equal((await settleNight(host, code, key, data)).outcome, 'opened');
  assert.deepEqual(await revealNight(host, code, key), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/${key}/night`);
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  assert.equal((await settleNight(host, code, key, data)).outcome, 'revealed');
}

// 這一局在 round 回合的白晝：按「這回合結束後算分」、黑夜揭曉後算分。
async function endFrom(code, key, round, { from = 'day' } = {}) {
  await setEndAfterRound(host, code, key, true);
  await nightRevealed(code, key, round, { from });
  const ended = await advanceOrEnd(host, code, key, { round, phase: 'night' }, data);
  assert.deepEqual([ended.ended, ended.reason], [true, 'host']);
}

// 主持端把這一局待判定的天命都勾掉（輪流勾達成／沒達成）。
async function judgeAll(code, key) {
  const scores = (await read(host, `rooms/${code}/games/${key}/final/scores`)) ?? {};
  for (const [index, uid] of pendingDestinies(scores).entries()) await judgeDestiny(host, code, key, uid, index % 2 === 0);
}

// 開一間新房：p1、p2、p3 在第 1 桌，outsider 在第 2 桌；第 1 桌開局（翻 1 張一般事件）並推進到第 1 回合白晝。
// table2 是 true 時第 2 桌也開局。回傳座位照順序的 first、second、third。
async function dayRoom(t, { table2 = false } = {}) {
  const code = await createRoom(host);
  await joinRoom(p1, code, 'P1', 1);
  await joinRoom(p2, code, 'P2', 1);
  await joinRoom(p3, code, 'P3', 1);
  await joinRoom(outsider, code, 'Outsider', 2);
  const names = ['host', 'p1', 'p2', 'p3'];
  const watchers = Object.fromEntries([host, p1, p2, p3].map((session, index) => [names[index], watch(session, code)]));
  t.after(() => Object.values(watchers).forEach((watcher) => watcher.stop()));
  await watchers.host.until((room) => Object.keys(room.players ?? {}).length === 4, 'host sees four players');
  assert.deepEqual(await startTable(host, code, 1, withEvent, seededRandom(1)), { started: true });
  if (table2) assert.deepEqual(await startTable(host, code, 2, data, seededRandom(2)), { started: true });
  await advanceTable(host, code, 1, { round: 1, phase: 'sunrise' });
  const seats1 = await read(host, `rooms/${code}/games/1/seats`);
  const [first, second, third] = seatsInOrder(seats1).map(([uid]) => [p1, p2, p3].find((session) => session.uid === uid));
  return { code, watchers, first, second, third, seats1 };
}

// 第 1 桌打完第 1 回合提早收場、勾完天命。
async function endedRoom(t, options) {
  const room = await dayRoom(t, options);
  await endFrom(room.code, 1, 1);
  await judgeAll(room.code, 1);
  return room;
}

// 開第 2 場（兩步），推進到第 2 場第 1 回合白晝。
async function secondMatch(code, { include, seed = 5 } = {}) {
  assert.deepEqual(await openMatch(host, code, 1), { opened: true, key: '1-2' });
  assert.deepEqual(await startTable(host, code, '1-2', data, seededRandom(seed), include ? { include } : undefined), { started: true });
  await advanceTable(host, code, '1-2', { round: 1, phase: 'sunrise' });
}

test('the rules can read the match key: endsWith, replace and + work on $table (R2, R4, R5)', TIMEOUT, async (t) => {
  const { code } = await dayRoom(t, { table2: true });
  await endFrom(code, 1, 1);
  const v1 = await read(host, `rooms/${code}/games/1/version`);
  const judged = (version, done) => ({ [`rooms/${code}/games/1/version`]: version, [`rooms/${code}/games/1/final/scores/${p1.uid}/destiny/done`]: done });
  await update(ref(host.db), judged(v1 + 1, false));
  // R2：第 2 桌還在第 1 場（沒有 end），它的第 2 場建不起來；第 1 桌已經 end、有 final，建得起來。
  await assert.rejects(set(ref(host.db, `rooms/${code}/tables/2-2`), freshTable()), denied, 'R2: table 2 has not ended');
  await set(ref(host.db, `rooms/${code}/tables/1-2`), freshTable());
  assert.deepEqual(await read(host, `rooms/${code}/tables/1-2/phase`), 'sunrise', 'R2: table 1 has ended with a final');
  // R4：tables/1-2 有了之後 games/1 鎖住（同一種寫法，剛才收、現在拒）；games/2（沒有 2-2）照常可寫。
  await assert.rejects(update(ref(host.db), judged(v1 + 2, true)), denied, 'R4: games/1 is locked');
  const v2 = await read(host, `rooms/${code}/games/2/version`);
  await update(ref(host.db, `rooms/${code}/games/2`), { endAfterRound: 1, version: v2 + 1 });
  assert.equal(await read(host, `rooms/${code}/games/2/endAfterRound`), 1, 'R4: games/2 is not locked');
  // R5：第 2 場的座位只能給第 1 場同桌坐過的人、座位號不變。
  const seats1 = await read(host, `rooms/${code}/games/1/seats`);
  const seat = (order) => ({ order, role: roleIds[order], pounds: 15, influence: 3, handCount: 0 });
  const opening = (seats) => ({
    [`rooms/${code}/games/1-2`]: { startedAt: serverTimestamp(), seats, deckCount: 0, discardCount: 0, version: 1 },
    [`rooms/${code}/deals/1-2`]: 1,
  });
  const same = Object.fromEntries(Object.entries(seats1).map(([uid, { order }]) => [uid, seat(order)]));
  await assert.rejects(update(ref(host.db), opening({ ...same, [outsider.uid]: seat(5) })), denied, 'R5: not seated in match 1');
  const [moved] = Object.keys(seats1);
  await assert.rejects(update(ref(host.db), opening({ ...same, [moved]: seat((seats1[moved].order + 1) % 6) })), denied, 'R5: another seat number');
  await update(ref(host.db), opening(same));
  assert.deepEqual(Object.keys(await read(host, `rooms/${code}/games/1-2/seats`)).sort(), Object.keys(seats1).sort(), 'R5: the same seats');
});

test('the full handover: match 1 stays as it was, step 1 opens 1-2 at round 1 sunrise, step 2 deals a fresh game with the roles passed on', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third, seats1 } = await dayRoom(t);
  // 第 1 場：third 搶先出（退回、留下 notice）；first 結束這一輪（處理過），之後又送一筆沒處理的；second 沒送過請求。
  await requestPass(third, code);
  assert.deepEqual(await settleRequest(host, code, 1, third.uid, data), { outcome: 'rejected', reason: 'not-your-turn' });
  await requestPass(first, code);
  assert.equal((await settleRequest(host, code, 1, first.uid, data)).outcome, 'passed');
  await requestPass(first, code);
  // 出牌紀錄（直接寫進局面）與第 1 回合的一般事件：換場後要原樣留著。
  const v0 = await read(host, `rooms/${code}/games/1/version`);
  await update(ref(host.db, `rooms/${code}/games/1`), { version: v0 + 1, 'log/m9c': { round: 1, by: second.uid, card: fileData.actions[0].id, level: 2, at: serverTimestamp() } });
  await set(ref(host.db, `private/${code}/${second.uid}/randomDiscard`), { round: 1, cards: [fileData.actions[0].id] });
  assert.ok(await read(host, `private/${code}/${third.uid}/notice`), 'a notice from match 1');
  await endFrom(code, 1, 1);
  await judgeAll(code, 1);
  const table1 = await read(host, `rooms/${code}/tables/1`);
  const game1 = await read(host, `rooms/${code}/games/1`);
  const deals1 = await read(host, `rooms/${code}/deals/1`);
  assert.ok(game1.final && game1.log?.m9c && Object.keys(game1.eventLog ?? {}).length >= 1, 'match 1 has a final, a log and an event log');
  const handsBefore = Object.fromEntries(await Promise.all([first, second, third].map(async (s) => [s.uid, await read(host, `private/${code}/${s.uid}/hand`)])));

  // 第 ① 步：只建 tables/1-2（第 1 回合日出、迷霧 0），第 1 場一個欄位都沒變。
  assert.deepEqual(await openMatch(host, code, 1), { opened: true, key: '1-2' });
  const opened = await read(host, `rooms/${code}/tables/1-2`);
  assert.deepEqual([opened.round, opened.phase, opened.fog], [1, 'sunrise', 0]);
  assert.ok(Math.abs(opened.updatedAt - serverTime(host)) < 5000);
  assert.equal(await read(host, `rooms/${code}/games/1-2`), null, 'not dealt yet');
  await watchers.p1.until((room) => activeKey(room, 1) === '1-2', 'the players see match 2 without reloading');

  // 第 ② 步：全新的一局，座位照 rotateSeats，私密資料整筆換掉，lastSeq 接上每人目前的請求序號。
  assert.deepEqual(await startTable(host, code, '1-2', data, seededRandom(5)), { started: true });
  const game2 = await read(host, `rooms/${code}/games/1-2`);
  assert.equal(game2.version, 1);
  assert.ok(Math.abs(game2.startedAt - serverTime(host)) < 5000, 'startedAt is the server time');
  assert.ok(game2.startedAt > game1.startedAt);
  const expected = rotateSeats(seats1, Object.keys(seats1));
  for (const { uid, order, role } of expected) {
    const seat = game2.seats[uid];
    assert.deepEqual([seat.order, seat.role], [order, role], `${uid} keeps seat ${order} and gets ${role}`);
    assert.notEqual(seat.role, seats1[uid].role);
    assert.deepEqual([seat.pounds, seat.influence, seat.handCount], [startingPounds + salary.get(role), startingInfluence, startingHand + drawPerSunrise]);
    assert.deepEqual([seat.sin, seat.aligned], [undefined, undefined]);
  }
  assert.deepEqual([startingPounds + salary.get(expected[0].role), startingInfluence, startingHand + drawPerSunrise], [15, 3, 6], 'the card data as planned');
  assert.equal(await read(host, `rooms/${code}/deals/1-2`), 1);
  assert.deepEqual(game2.lastSeq, { [first.uid]: 2, [third.uid]: 1 }, 'everyone who has sent a request, at their current seq');
  assert.equal(game2.final, undefined);
  assert.equal(game2.log, undefined);
  const pile = await read(host, `hostOnly/${code}/1-2`);
  assert.equal(pile.deck.length, game2.deckCount);
  for (const session of [first, second, third]) {
    const record = await read(host, `private/${code}/${session.uid}`);
    assert.deepEqual(Object.keys(record).sort(), ['destiny', 'hand', 'table'], 'the whole record is replaced: no notice, no randomDiscard');
    assert.equal(record.table, 1, 'the real table number');
    assert.equal(record.hand.length, startingHand + drawPerSunrise);
    assert.notDeepEqual(record.hand, handsBefore[session.uid]);
    assert.equal(blank.find((card) => card.id === record.destiny).role, game2.seats[session.uid].role, 'a destiny of the new role');
  }
  // 第 1 場一個欄位都沒變。
  assert.deepEqual(await read(host, `rooms/${code}/tables/1`), table1);
  assert.deepEqual(await read(host, `rooms/${code}/games/1`), game1);
  assert.equal(await read(host, `rooms/${code}/deals/1`), deals1);
  // 玩家看得到第 2 場的局面與自己的新手牌。
  const seen = await watchers.p2.until((room) => room.games?.['1-2']?.seats, 'p2 sees match 2');
  assert.deepEqual(seen.games['1-2'].seats[p2.uid].role, game2.seats[p2.uid].role);
  assert.deepEqual(await read(p2, `private/${code}/${p2.uid}/hand`), (await read(host, `private/${code}/${p2.uid}`)).hand);
});

test('match 2 cannot open before match 1 ends, while destinies wait for the host, twice, or with a table that is not fresh', TIMEOUT, async (t) => {
  const { code, first } = await dayRoom(t);
  await enterAsHost(backup, code);
  await approveHost(host, code, backup.uid);
  // 第 1 場還沒 end：store 與規則都擋。
  await assert.rejects(openMatch(host, code, 1), storeError('cannot-open', /還沒結束/));
  await assert.rejects(set(ref(host.db, `rooms/${code}/tables/1-2`), freshTable()), denied, 'match 1 has not ended');
  // 在 tables/1-2 建立之前寫 games/1-2 或 deals/1-2：被拒。
  await assert.rejects(
    update(ref(host.db), {
      [`rooms/${code}/games/1-2`]: { startedAt: serverTimestamp(), seats: { [first.uid]: { order: 0, role: 'r1', pounds: 1, influence: 1, handCount: 0 } }, deckCount: 0, discardCount: 0, version: 1 },
      [`rooms/${code}/deals/1-2`]: 1,
    }),
    denied,
    'games/1-2 before tables/1-2',
  );
  await assert.rejects(set(ref(host.db, `rooms/${code}/deals/1-2`), 1), denied, 'deals/1-2 before tables/1-2');
  await endFrom(code, 1, 1);
  // 天命還沒勾完：store 擋（規則擋不了這一項）。
  await assert.rejects(openMatch(host, code, 1), storeError('cannot-open', /還有 3 張天命待判定/));
  const scores = await read(host, `rooms/${code}/games/1/final/scores`);
  const [last, ...others] = Object.keys(scores);
  for (const uid of others) await judgeDestiny(host, code, 1, uid, true);
  await assert.rejects(openMatch(host, code, 1), storeError('cannot-open', /還有 1 張天命待判定/));
  await judgeDestiny(host, code, 1, last, false);
  // 不是全新的一桌：被拒。
  for (const [label, changes] of [
    ['round 2', { round: 2 }],
    ['day', { phase: 'day' }],
    ['fog 5', { fog: 5 }],
    ['end', { phase: 'end' }],
  ]) {
    await assert.rejects(set(ref(host.db, `rooms/${code}/tables/1-2`), freshTable(changes)), denied, label);
  }
  await assert.rejects(openMatch(host, code, 7), storeError('invalid-table'));
  await assert.rejects(openMatch(host, code, '1-2'), storeError('invalid-table'));
  await assert.rejects(openMatch(host, code, 3), storeError('cannot-open', /還沒結束/), 'a table nobody played');
  await assert.rejects(openMatch(first, code, 1), storeError('permission-denied'), 'a player cannot open it');
  // 兩台主持端同時按：只成一筆，另一台看到已經有了就停。
  const results = await Promise.all([host, backup].map((session) => openMatch(session, code, 1)));
  assert.deepEqual(results.map((result) => result.opened).sort(), [false, true]);
  assert.deepEqual(results.map((result) => result.key), ['1-2', '1-2']);
  // 已經開了：再按也不會把進行中的第 2 場蓋回第 1 回合。
  assert.deepEqual(await startTable(backup, code, '1-2', data, seededRandom(3)), { started: true });
  await advanceTable(host, code, '1-2', { round: 1, phase: 'sunrise' });
  assert.deepEqual(await openMatch(host, code, 1), { opened: false, key: '1-2' });
  assert.deepEqual(await openMatch(backup, code, '1'), { opened: false, key: '1-2' });
  assert.equal(await read(host, `rooms/${code}/tables/1-2/phase`), 'day');
  assert.deepEqual(await startTable(host, code, '1-2', data, seededRandom(4)), { started: false }, 'step 2 twice');
  await assert.rejects(startTable(host, code, '2-2', data), storeError('cannot-start', /還沒開第 2 場/));
});

test('once match 2 is open, match 1 is locked: every write to games/1 is refused, and the store says so in words', TIMEOUT, async (t) => {
  const { code, first, second } = await endedRoom(t);
  // 建 tables/1-2 的同一筆順便改 games/1：整筆被拒。
  const v = await read(host, `rooms/${code}/games/1/version`);
  await assert.rejects(
    update(ref(host.db), {
      [`rooms/${code}/tables/1-2`]: freshTable(),
      [`rooms/${code}/games/1/version`]: v + 1,
      [`rooms/${code}/games/1/final/scores/${first.uid}/total`]: 99,
    }),
    denied,
    'the same write as the new table',
  );
  assert.equal(await read(host, `rooms/${code}/tables/1-2`), null);
  assert.deepEqual(await openMatch(host, code, 1), { opened: true, key: '1-2' });
  const before = await read(host, `rooms/${code}/games/1`);
  const games1 = (changes) => update(ref(host.db, `rooms/${code}/games/1`), changes);
  for (const [label, changes] of [
    ['judge a destiny', { version: v + 1, [`final/scores/${first.uid}/destiny/done`]: false }],
    ['end after round', { version: v + 1, endAfterRound: 1 }],
    ['one field of the final', { version: v + 1, [`final/scores/${first.uid}/total`]: 99 }],
    ['one rank', { version: v + 1, [`final/scores/${second.uid}/rank`]: 1 }],
    ['remove a score', { version: v + 1, [`final/scores/${second.uid}`]: null }],
    ['version alone', { version: v + 1 }],
    ['a seat', { version: v + 1, [`seats/${first.uid}/pounds`]: 0 }],
  ]) {
    await assert.rejects(games1(changes), denied, label);
  }
  await assert.rejects(set(ref(host.db, `rooms/${code}/games/1/final/scores/${second.uid}`), null), denied, 'remove a score directly');
  await assert.rejects(set(ref(host.db, `rooms/${code}/games/1/endAfterRound`), null), denied, 'remove a field directly');
  assert.deepEqual(await read(host, `rooms/${code}/games/1`), before);
  // store：回看得懂的錯，不是原始的權限錯誤。
  const locked = storeError('match-locked', /第 1 場已鎖定/);
  await assert.rejects(judgeDestiny(host, code, 1, first.uid, false), locked);
  await assert.rejects(judgeDestiny(host, code, '1', first.uid, null), locked);
  await assert.rejects(setEndAfterRound(host, code, 1, true), locked);
  await assert.rejects(setStartOrder(host, code, 1, 0), locked);
  // 主持端的快取還沒看到第 2 場開了（離線時另一台開的）：寫入被拒之後照樣回 match-locked。
  const other = await endedRoom(t);
  const code2 = other.code;
  await enterAsHost(backup, code2);
  await approveHost(host, code2, backup.uid);
  const stale = watch(host, code2);
  t.after(() => stale.stop());
  await stale.until((room) => room.hosts?.[backup.uid] === true, 'host sees the backup');
  const done = await read(host, `rooms/${code2}/games/1/final/scores/${other.first.uid}/destiny/done`);
  goOffline(host.db);
  t.after(() => goOnline(host.db));
  assert.deepEqual(await openMatch(backup, code2, 1), { opened: true, key: '1-2' });
  const judging = judgeDestiny(host, code2, 1, other.first.uid, !done);
  await sleep(300); // 主持端用離線的快取判斷「還沒鎖」，寫入排在本機
  goOnline(host.db);
  await assert.rejects(judging, locked);
});

test('match 2 seats only the people who sat at this table in match 1, on the same seat numbers; seats can be rewritten by settling', TIMEOUT, async (t) => {
  const { code, first, seats1 } = await endedRoom(t);
  assert.deepEqual(await openMatch(host, code, 1), { opened: true, key: '1-2' });
  const opening = (seats) => ({
    [`rooms/${code}/games/1-2`]: { startedAt: serverTimestamp(), seats, deckCount: 0, discardCount: 0, version: 1 },
    [`rooms/${code}/deals/1-2`]: 1,
  });
  const seatOf = (order) => ({ order, role: roleIds[order], pounds: 15, influence: 3, handCount: 0 });
  const same = Object.fromEntries(Object.entries(seats1).map(([uid, { order }]) => [uid, seatOf(order)]));
  await assert.rejects(update(ref(host.db), opening({ ...same, [outsider.uid]: seatOf(5) })), denied, 'outsider sat at table 2');
  await assert.rejects(update(ref(host.db), opening({ ...same, [first.uid]: seatOf((seats1[first.uid].order + 3) % 6) })), denied, 'another seat number');
  // store 照第 1 場的座位開局；之後黑夜揭曉照樣重寫整份座位，也通過。
  assert.deepEqual(await startTable(host, code, '1-2', data, seededRandom(6)), { started: true });
  const version = await read(host, `rooms/${code}/games/1-2/version`);
  await nightRevealed(code, '1-2', 1, { from: 'sunrise' });
  assert.ok((await read(host, `rooms/${code}/games/1-2/version`)) > version + 1, 'the night rewrote the seats');
  const seats2 = await read(host, `rooms/${code}/games/1-2/seats`);
  for (const [uid, { order }] of Object.entries(seats1)) assert.equal(seats2[uid].order, order);
  // 結算寫座位時加人或換座位號：被拒。
  const v = await read(host, `rooms/${code}/games/1-2/version`);
  await assert.rejects(update(ref(host.db, `rooms/${code}/games/1-2`), { version: v + 1, [`seats/${outsider.uid}`]: seatOf(5) }), denied);
  await assert.rejects(update(ref(host.db, `rooms/${code}/games/1-2`), { version: v + 1, [`seats/${first.uid}/order`]: (seats1[first.uid].order + 1) % 6 }), denied);
  await update(ref(host.db, `rooms/${code}/games/1-2`), { version: v + 1, [`seats/${first.uid}/pounds`]: 1 });
});

test('match 2 cannot be removed: not the table, not the game, deals only go up, and after its end nothing moves', TIMEOUT, async (t) => {
  const { code } = await endedRoom(t);
  await secondMatch(code);
  await assert.rejects(set(ref(host.db, `rooms/${code}/tables/1-2`), null), denied, 'delete the table');
  const tables = await read(host, `rooms/${code}/tables`);
  const without = Object.fromEntries(Object.entries(tables).filter(([key]) => key !== '1-2'));
  await assert.rejects(set(ref(host.db, `rooms/${code}/tables`), without), denied, 'overwrite tables without it');
  await assert.rejects(update(ref(host.db, `rooms/${code}`), { tables: without }), denied, 'the same from the room');
  await assert.rejects(set(ref(host.db, `rooms/${code}/games/1-2`), null), denied, 'delete the game');
  await assert.rejects(set(ref(host.db, `rooms/${code}/deals/1-2`), null), denied, 'delete deals');
  await assert.rejects(set(ref(host.db, `rooms/${code}/deals/1-2`), 0), denied, 'deals down');
  // 第 2 場打完：終局後不能再推進（沿用現有的保護）。
  await endFrom(code, '1-2', 1);
  assert.equal((await advanceTable(host, code, '1-2', { round: 1, phase: 'end' })).advanced, false);
  assert.equal((await advanceOrEnd(host, code, '1-2', { round: 1, phase: 'night' }, data)).advanced, false);
  await assert.rejects(update(ref(host.db, `rooms/${code}/tables/1-2`), { phase: 'sunrise', round: 2 }), denied);
  await assert.rejects(set(ref(host.db, `rooms/${code}/tables/1-2`), freshTable()), denied, 'cannot start over at round 1');
  await assert.rejects(setEndAfterRound(host, code, '1-2', true), storeError('game-over'));
  assert.deepEqual(await openMatch(host, code, 1), { opened: false, key: '1-2' });
});

test('in match 2 players cannot write the table, the game or deals, cannot read the host-only piles, and send votes, choices and discards for "1-2" only', TIMEOUT, async (t) => {
  const { code, first, second, third } = await endedRoom(t);
  // third 被主持端勾掉、不參加第 2 場。
  await secondMatch(code, { include: [first.uid, second.uid] });
  const v = await read(host, `rooms/${code}/games/1-2/version`);
  await assert.rejects(update(ref(first.db, `rooms/${code}/tables/1-2`), { phase: 'dusk' }), denied);
  await assert.rejects(update(ref(first.db, `rooms/${code}/games/1-2`), { version: v + 1, [`seats/${first.uid}/pounds`]: 99 }), denied);
  await assert.rejects(set(ref(first.db, `rooms/${code}/deals/1-2`), 2), denied);
  await assert.rejects(read(first, `hostOnly/${code}/1-2`), denied);
  await assert.rejects(read(first, `private/${code}/${second.uid}`), denied);
  assert.ok((await read(first, `private/${code}/${first.uid}`)).hand.length > 0, 'own record is readable');
  // 黃昏：翻法案後，填 "1-2" 的票才收；填 "1"（第 1 場已經 end）、被勾掉的人、不合法的局號都被拒。
  await advanceTable(host, code, '1-2', { round: 1, phase: 'day' });
  assert.equal((await settleDusk(host, code, '1-2', data)).outcome, 'opened');
  const bill = await read(host, `rooms/${code}/games/1-2/dusk/bill`);
  assert.ok(bill, 'a bill is on the table');
  const vote = (session, table) => requestVote(session, code, { table, round: 1, side: 'yes', bid: 0 });
  assert.equal(await vote(first, '1-2'), 1);
  const voteDenied = storeError('permission-denied');
  await assert.rejects(vote(second, 1), voteDenied, 'match 1 has ended');
  await assert.rejects(vote(third, '1-2'), voteDenied, 'not seated in match 2');
  for (const table of ['7', '1-3', '1-2-2', '2-2']) await assert.rejects(vote(second, table), voteDenied, table);
  await assert.rejects(set(ref(second.db, `votes/${code}/${second.uid}`), { table: 2, round: 1, side: 'yes', bid: 0, seq: 9, at: serverTimestamp() }), denied, 'a number');
  // 黑夜：同上；挑的棄牌也是。
  await advanceTable(host, code, '1-2', { round: 1, phase: 'dusk' });
  assert.equal((await settleNight(host, code, '1-2', data)).outcome, 'opened');
  const choose = (session, table) => requestNight(session, code, { table, round: 1, choice: 'sleep' });
  assert.equal(await choose(first, '1-2'), 1);
  await assert.rejects(choose(second, '1'), voteDenied);
  await assert.rejects(choose(third, '1-2'), voteDenied);
  for (const table of ['7', '1-3', '1-2-2']) await assert.rejects(choose(second, table), voteDenied, table);
  const card = (await read(second, `private/${code}/${second.uid}`)).hand[0];
  const pick = (session, table) => requestDiscard(session, code, { table, round: 1, cards: [card] });
  assert.equal(await pick(second, '1-2'), 1);
  await assert.rejects(pick(second, '1'), voteDenied);
  await assert.rejects(pick(third, '1-2'), voteDenied);
  for (const table of ['7', '1-3', '1-2-2']) await assert.rejects(pick(first, table), voteDenied, table);
});

test('leftovers from match 1 do not count: its last request is not settled, and its votes, choices and discards do not count in match 2', TIMEOUT, async (t) => {
  const { code, first, second, third } = await dayRoom(t);
  // 第 1 場第 1 回合：first 送了一筆沒處理的請求；黃昏三人都投票、黑夜都送選擇與挑的棄牌（table 都是 "1"）。
  await requestPass(first, code);
  await advanceTable(host, code, 1, { round: 1, phase: 'day' });
  assert.equal((await settleDusk(host, code, 1, data)).outcome, 'opened');
  for (const session of [first, second, third]) await requestVote(session, code, { table: 1, round: 1, side: 'no', bid: 0 });
  await setEndAfterRound(host, code, 1, true);
  await advanceTable(host, code, 1, { round: 1, phase: 'dusk' });
  assert.equal((await settleNight(host, code, 1, data)).outcome, 'opened');
  for (const session of [first, second, third]) {
    await requestNight(session, code, { table: 1, round: 1, choice: 'gamble', tiers: 1 });
    const hand = await read(session, `private/${code}/${session.uid}/hand`);
    await requestDiscard(session, code, { table: 1, round: 1, cards: [hand[0]] });
  }
  assert.deepEqual(await revealNight(host, code, 1), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/1/night`);
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  assert.equal((await settleNight(host, code, 1, data)).outcome, 'revealed');
  assert.equal((await advanceOrEnd(host, code, 1, { round: 1, phase: 'night' }, data)).ended, true);
  await judgeAll(code, 1);
  const requestSeq = (await read(host, `requests/${code}/${first.uid}`)).seq;
  await secondMatch(code);
  assert.equal(await read(host, `rooms/${code}/games/1-2/lastSeq/${first.uid}`), requestSeq);
  // 第 1 場的請求：第 2 場的白晝也不結算、不寫 notice（自動化開著）。
  const errorsSeen = [];
  const stop = startSettling(host, code, data, { onError: (error) => errorsSeen.push(error) });
  t.after(stop);
  assert.deepEqual(await settleRequest(host, code, '1-2', first.uid, data), { outcome: 'none', reason: null });
  await sleep(1000);
  assert.equal(await read(first, `private/${code}/${first.uid}/notice`), null);
  // 第 2 場第 1 回合的黃昏與黑夜：已送出 0 人（第 1 場的票與選擇是 "1"）。
  await advanceTable(host, code, '1-2', { round: 1, phase: 'day' });
  const watcher = watch(host, code);
  t.after(() => watcher.stop());
  await watcher.until((room) => room.games?.['1-2']?.dusk?.round === 1, 'the automation opens the match 2 dusk');
  await sleep(500);
  assert.equal(await read(host, `rooms/${code}/games/1-2/dusk/submitted`), 0);
  await advanceTable(host, code, '1-2', { round: 1, phase: 'dusk' });
  await watcher.until((room) => room.games?.['1-2']?.night?.round === 1, 'the automation opens the match 2 night');
  await sleep(500);
  assert.equal(await read(host, `rooms/${code}/games/1-2/night/submitted`), 0);
  stop();
  // 手牌上限：first 的手牌超過上限（主持端直接改），第 1 場挑的棄牌（同樣是第 1 回合）不照用，日出亂數棄。
  const hand = (await read(host, `private/${code}/${first.uid}/hand`)) ?? [];
  const extra = [...hand, ...hand].slice(0, fileData.settings.handLimit + 1);
  await set(ref(host.db, `private/${code}/${first.uid}/hand`), extra);
  assert.deepEqual(await revealNight(host, code, '1-2'), { closed: true });
  const night2 = await read(host, `rooms/${code}/games/1-2/night`);
  await untilServerTime(host, nightSettleAt(night2) + 50);
  assert.equal((await settleNight(host, code, '1-2', data)).outcome, 'revealed');
  const result = await read(host, `rooms/${code}/games/1-2/night/result/players`);
  for (const session of [first, second, third]) assert.deepEqual([result[session.uid].choice, result[session.uid].missed], ['sleep', true], 'match 1 choices are not used');
  assert.equal((await advanceOrEnd(host, code, '1-2', { round: 1, phase: 'night' }, data)).ended, false);
  assert.equal((await processSunrise(host, code, '1-2', data, seededRandom(8))).dealt, true);
  const random = await read(host, `private/${code}/${first.uid}/randomDiscard`);
  assert.equal(random?.round, 2, 'discarded at random: the match 1 pick was not used');
  assert.equal(random.cards.length, 1);
  assert.deepEqual(errorsSeen, []);
});

test('match 2 scores on its own; the two finals add up with combineScores, and judging match 2 moves the total while match 1 stays put', TIMEOUT, async (t) => {
  const { code, seats1 } = await endedRoom(t);
  await secondMatch(code);
  // 第 2 場的 final 只能從揭曉後的黑夜建立。
  await setEndAfterRound(host, code, '1-2', true);
  await advanceTable(host, code, '1-2', { round: 1, phase: 'day' });
  await advanceTable(host, code, '1-2', { round: 1, phase: 'dusk' });
  assert.equal((await settleNight(host, code, '1-2', data)).outcome, 'opened');
  await assert.rejects(advanceOrEnd(host, code, '1-2', { round: 1, phase: 'night' }, data), storeError('night-not-revealed'));
  const v = await read(host, `rooms/${code}/games/1-2/version`);
  await assert.rejects(
    update(ref(host.db), {
      [`rooms/${code}/tables/1-2/phase`]: 'end',
      [`rooms/${code}/games/1-2/version`]: v + 1,
      [`rooms/${code}/games/1-2/final`]: { round: 1, reason: 'host', endedAt: serverTimestamp(), scores: {} },
    }),
    denied,
  );
  assert.deepEqual(await revealNight(host, code, '1-2'), { closed: true });
  const night = await read(host, `rooms/${code}/games/1-2/night`);
  await untilServerTime(host, nightSettleAt(night) + 50);
  assert.equal((await settleNight(host, code, '1-2', data)).outcome, 'revealed');
  assert.equal((await advanceOrEnd(host, code, '1-2', { round: 1, phase: 'night' }, data)).ended, true);
  const final1 = await read(host, `rooms/${code}/games/1/final`);
  const final2 = await read(host, `rooms/${code}/games/1-2/final`);
  const combined = combineScores(final1, final2, seats1);
  for (const uid of Object.keys(seats1)) {
    assert.deepEqual([combined[uid].first, combined[uid].second], [final1.scores[uid].total, final2.scores[uid].total]);
    assert.equal(combined[uid].total, final1.scores[uid].total + final2.scores[uid].total);
    assert.deepEqual([combined[uid].absent, combined[uid].missingFirst, combined[uid].pending], [false, false, true]);
  }
  // 勾第 2 場的天命：合計跟著變；第 1 場的 final 不動。
  const [uid] = Object.keys(seats1);
  assert.deepEqual(await judgeDestiny(host, code, '1-2', uid, true), { changed: true });
  const judged = combineScores(final1, await read(host, `rooms/${code}/games/1-2/final`), seats1);
  assert.equal(judged[uid].total, combined[uid].total + 10);
  assert.equal(judged[uid].pending, false);
  assert.deepEqual(await read(host, `rooms/${code}/games/1/final`), final1);
  const watcher = watch(p1, code);
  t.after(() => watcher.stop());
  const seen = await watcher.until((room) => room.games?.['1-2']?.final?.scores?.[uid]?.destiny?.done === true, 'players see it');
  assert.deepEqual(combineScores(seen.games[1].final, seen.games['1-2'].final, seen.games[1].seats), judged, 'the same numbers on every screen');
});

test('after a reload the player is still in match 2 and the host automation handles match 2 only', TIMEOUT, async (t) => {
  const { code, first, second, third } = await endedRoom(t);
  await secondMatch(code);
  const version1 = await read(host, `rooms/${code}/games/1/version`);
  // 玩家斷線再連回來（同一個身分），重新訂閱：從房間資料推出 1-2，私密資料是第 2 場的手牌。
  goOffline(second.db);
  t.after(() => goOnline(second.db));
  await sleep(200);
  goOnline(second.db);
  const reloaded = watch(second, code);
  t.after(() => reloaded.stop());
  const room = await reloaded.until((value) => value.games?.['1-2'], 'the player sees match 2 again');
  const me = room.players[second.uid];
  assert.equal(activeKey(room, me.table), '1-2');
  let stopPrivate = null;
  const mine = await new Promise((resolve, reject) => {
    stopPrivate = watchPrivate(second, code, (value) => value && resolve(value), reject);
  });
  stopPrivate();
  assert.deepEqual(mine, await read(host, `private/${code}/${second.uid}`));
  assert.ok(room.games['1-2'].seats[second.uid], 'seated in the active match');
  // 主持端「重新整理」：關掉自動化、斷線、連回來、再開：第 2 場的出牌、黃昏、黑夜照常處理，第 1 場什麼都不做。
  const errorsSeen = [];
  const stop1 = startSettling(host, code, data, { onError: (error) => errorsSeen.push(error) });
  stop1();
  goOffline(host.db);
  t.after(() => goOnline(host.db));
  await sleep(200);
  goOnline(host.db);
  const stop2 = startSettling(host, code, data, { onError: (error) => errorsSeen.push(error) });
  t.after(stop2);
  const order = seatsInOrder(room.games['1-2'].seats).map(([uid]) => uid);
  const sessions = { [first.uid]: first, [second.uid]: second, [third.uid]: third };
  for (const uid of order) {
    await requestPass(sessions[uid], code);
    await reloaded.until((value) => (value.games['1-2'].lastSeq?.[uid] ?? 0) >= 1 && value.games['1-2'].turn, `${uid} pass handled`, 8000);
  }
  await reloaded.until((value) => value.games['1-2'].turn?.index === 3, 'everyone passed in match 2');
  await advanceTable(host, code, '1-2', { round: 1, phase: 'day' });
  await reloaded.until((value) => value.games['1-2'].dusk?.round === 1, 'the automation opens the dusk');
  await advanceTable(host, code, '1-2', { round: 1, phase: 'dusk' });
  await reloaded.until((value) => value.games['1-2'].night?.round === 1, 'the automation opens the night');
  for (const session of [first, second, third]) await requestNight(session, code, { table: '1-2', round: 1, choice: 'sleep' });
  await reloaded.until((value) => value.games['1-2'].night?.result, 'everyone chose, the automation counts down and reveals', 10000);
  assert.equal(await read(host, `rooms/${code}/games/1/version`), version1, 'match 1 untouched');
  assert.deepEqual(errorsSeen, []);
});

test('two tables in different matches: one host settles both, and each sunset clock runs from its own start', TIMEOUT, async (t) => {
  const { code } = await endedRoom(t);
  // 第 2 桌（outsider 一人）晚一點開第 1 場；第 1 桌已經在第 2 場。
  assert.deepEqual(await startTable(host, code, 2, data, seededRandom(2)), { started: true });
  await secondMatch(code);
  await advanceTable(host, code, 2, { round: 1, phase: 'sunrise' });
  const errorsSeen = [];
  const stop = startSettling(host, code, data, { onError: (error) => errorsSeen.push(error) });
  t.after(stop);
  const watcher = watch(host, code);
  t.after(() => watcher.stop());
  // 兩桌都在白晝：第 2 桌 outsider 結束這一輪、第 1 桌第 2 場輪到的人結束這一輪，都由同一台主持端處理。
  const seats2 = await read(host, `rooms/${code}/games/1-2/seats`);
  const [firstUp] = seatsInOrder(seats2).map(([uid]) => [p1, p2, p3].find((session) => session.uid === uid));
  await requestPass(outsider, code);
  await requestPass(firstUp, code);
  await watcher.until((room) => room.games[2].lastSeq?.[outsider.uid] >= 1 && room.games['1-2'].lastSeq?.[firstUp.uid] >= 1, 'both tables settled', 8000);
  assert.equal(watcher.value.games[2].turn.index, 1);
  assert.equal(watcher.value.games['1-2'].turn.index, 1);
  // 兩桌同時在黃昏：各自開黃昏。
  await advanceTable(host, code, 2, { round: 1, phase: 'day' });
  await advanceTable(host, code, '1-2', { round: 1, phase: 'day' });
  await watcher.until((room) => room.games[2].dusk?.round === 1 && room.games['1-2'].dusk?.round === 1, 'both dusks open');
  // 日落鐘：各算各的。
  const started2 = await read(host, `rooms/${code}/games/2/startedAt`);
  const started12 = await read(host, `rooms/${code}/games/1-2/startedAt`);
  const started1 = await read(host, `rooms/${code}/games/1/startedAt`);
  assert.ok(started1 < started2 && started2 < started12);
  // 日落鐘設成兩桌開局時間差的一半：那一刻第 2 桌（先開）到了，第 1 桌的第 2 場（後開）還沒。
  const gap = started12 - started2;
  assert.ok(gap > 2);
  const settings = { ...data.settings, sunsetMinutes: gap / 2 / 60_000 };
  const now = started2 + gap / 2 + 1;
  assert.equal(shouldEnd({ round: 1, startedAt: started2 }, settings, now), 'sunset');
  assert.equal(shouldEnd({ round: 1, startedAt: started12 }, settings, now), null);
  assert.equal(await read(host, `rooms/${code}/tables/1/phase`), 'end', 'match 1 of table 1 stays ended');
  assert.deepEqual(errorsSeen, []);
});

test('someone who left after match 1 has no seat by default and their role still passes on; a newcomer cannot get a seat', TIMEOUT, async (t) => {
  const { code, first, second, third, seats1 } = await endedRoom(t);
  await leaveRoom(third, code); // 第 1 場有座位、之後按了「離開房間」
  await joinRoom(late, code, 'Late', 1); // 第 1 場之後才加入第 1 桌
  const watcher = watch(host, code);
  t.after(() => watcher.stop());
  await watcher.until((room) => !room.players[third.uid] && room.players[late.uid], 'host sees the leave and the join');
  assert.deepEqual(await openMatch(host, code, 1), { opened: true, key: '1-2' });
  await assert.rejects(startTable(host, code, '1-2', data, seededRandom(1), { include: [first.uid, late.uid] }), storeError('cannot-start', /Late 第 1 場沒有坐第 1 桌/));
  await assert.rejects(startTable(host, code, '1-2', data, seededRandom(1), { include: [] }), storeError('cannot-start', /至少要有 1 人/));
  // 硬寫新人的座位：規則也擋。
  const seatOf = (order) => ({ order, role: roleIds[order], pounds: 15, influence: 3, handCount: 0 });
  await assert.rejects(
    update(ref(host.db), {
      [`rooms/${code}/games/1-2`]: { startedAt: serverTimestamp(), seats: { [first.uid]: seatOf(seats1[first.uid].order), [late.uid]: seatOf(5) }, deckCount: 0, discardCount: 0, version: 1 },
      [`rooms/${code}/deals/1-2`]: 1,
    }),
    denied,
  );
  // 預設：third（離開了）與 late（新人）都沒有座位；third 的階層照樣傳給下一個座位。
  assert.deepEqual(await startTable(host, code, '1-2', data, seededRandom(1)), { started: true });
  const seats2 = await read(host, `rooms/${code}/games/1-2/seats`);
  assert.deepEqual(Object.keys(seats2).sort(), [first.uid, second.uid].sort());
  const ring = rotateSeats(seats1, Object.keys(seats1));
  for (const { uid, role } of ring.filter(({ uid }) => uid !== third.uid)) assert.equal(seats2[uid].role, role);
  assert.equal(ring.find(({ from }) => from === third.uid).role, seats1[third.uid].role);
  const record = await read(host, `private/${code}/${third.uid}`);
  assert.equal(record.destiny, (await read(host, `rooms/${code}/games/1/final/scores/${third.uid}/destiny/id`)), 'the one who left keeps match 1 data');
  assert.equal(await read(host, `private/${code}/${late.uid}`), null);
  // 合計：third 列出來，第 2 場沒參加。
  await endFrom(code, '1-2', 1, { from: 'sunrise' });
  const combined = combineScores(await read(host, `rooms/${code}/games/1/final`), await read(host, `rooms/${code}/games/1-2/final`), seats1);
  assert.deepEqual([combined[third.uid].absent, combined[third.uid].second], [true, 0]);
  assert.equal(combined[late.uid], undefined, 'the newcomer is not in the combined scores');
});
