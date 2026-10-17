// 兩場制的同步與權限測試（M9）：第 2 場用局號 {n}-2（npm run test:sync）。這裡先驗安全規則（R2、R4、R5 用到的 endsWith、replace、
// 字串 + 在模擬器上能用）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get, ref, serverTimestamp, set, update } from 'firebase/database';
import { nightSettleAt, seatsInOrder, seededRandom } from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';
import {
  advanceOrEnd,
  advanceTable,
  connect,
  createRoom,
  disconnect,
  joinRoom,
  revealNight,
  serverTime,
  setEndAfterRound,
  settleNight,
  startTable,
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

let host;
let p1;
let p2;
let p3;
let outsider;

before(async () => {
  [host, p1, p2, p3, outsider] = await Promise.all(['host', 'p1', 'p2', 'p3', 'outsider'].map((slot) => connect(slot)));
});

after(async () => {
  await Promise.all([host, p1, p2, p3, outsider].filter(Boolean).map(disconnect));
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
