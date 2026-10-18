// 主持人控制台的同步與權限測試（npm run test:sync）：display（場景、廣播、音效、音樂、全場暫停）、clock（全場日落鐘的開始、暫停、繼續、
// 加減）、screens（投影端回報）三個節點的規則，store.js 的指令、防撞（seq）與錯誤碼，全場暫停一筆寫入，全場鐘與算分，
// 有了這些節點之後遊戲的寫入照常，在等誰，以及全部開始、能推的全推。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectDatabaseEmulator, get, getDatabase, goOffline, goOnline, ref, remove, serverTimestamp, set, update } from 'firebase/database';
import { config } from '../../play/js/config.js';
import { advancePlan, buildDeck, clockRemaining, nightSettleAt, seatsInOrder, seededRandom, startMatch2Plan, startPlan, waitingFor } from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';
import {
  adjustClock,
  advanceAll,
  advanceOrEnd,
  advanceTable,
  approveHost,
  connect,
  createRoom,
  disconnect,
  enterAsHost,
  hideBroadcast,
  joinRoom,
  openMatch,
  pauseClock,
  playSfx,
  processSunrise,
  requestNight,
  requestPlay,
  requestRespond,
  requestVote,
  resumeClock,
  revealNight,
  sendBroadcast,
  serverTime,
  setEndAfterRound,
  setMusic,
  setPause,
  setScene,
  settleDusk,
  settleNight,
  settleRequest,
  settleWindow,
  startAll,
  startClock,
  startTable,
  trackScreen,
  watchRoom,
  watchSubmissions,
} from '../../play/js/store.js';

const TIMEOUT = { timeout: 60_000 };
const denied = /permission[_ ]denied/i;
const MINUTE = 60_000;
const cardDir = new URL('../../play/data/', import.meta.url);
const { data: fileData, errors } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
assert.deepEqual(errors, []);
// 日出不翻一般事件（sunriseEvents 0）；黃昏、黑夜倒數 1 秒，響應窗口 1 秒。天命換成測試用的（每個階層一張，判定一定成立），
// 算分後沒有待判定的天命、可以接著開第 2 場；不依賴正式資料的天命。
const destinies = fileData.roles.map((role, index) => ({
  id: `t${index + 1}`,
  role: role.id,
  text: `測試天命 ${index + 1}`,
  score: { text: '測試', points: 10 },
  check: { kind: 'compare', what: 'pounds', op: '>=', value: 0 },
}));
const settings = { ...fileData.settings, sunriseEvents: 0, duskRevealSeconds: 1, nightRevealSeconds: 1, responseSeconds: 1 };
const data = { ...fileData, destinies, settings };
const sunset = { ...data, settings: { ...data.settings, sunsetMinutes: 0.0001 } }; // 各桌從開局 6 毫秒後就日落
assert.equal(data.settings.sunsetMinutes, 75);

let host;
let backup;
let p1;
let p2;
let p3;
let outsider;

before(async () => {
  [host, backup, p1, p2, p3, outsider] = await Promise.all(['c-host', 'c-backup', 'c-p1', 'c-p2', 'c-p3', 'c-outsider'].map((slot) => connect(slot)));
});

after(async () => {
  await Promise.all([host, backup, p1, p2, p3, outsider].filter(Boolean).map(disconnect));
});

const read = async (session, path) => (await get(ref(session.db, path))).val();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const codeOf = (code) => ({ name: 'StoreError', code });

async function untilServerTime(session, at) {
  for (let left = at - serverTime(session); left > 0; left = at - serverTime(session)) await sleep(Math.min(left + 5, 250));
}

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

// 開一間新房：backup 是核准過的備援主持端，p1、p2、p3 坐第 2 桌，outsider 只登入、沒有加入（像投影端）。
async function consoleRoom(t) {
  const code = await createRoom(host);
  assert.deepEqual(await enterAsHost(backup, code), { code, host: false });
  await approveHost(host, code, backup.uid);
  await joinRoom(p1, code, 'P1', 2);
  await joinRoom(p2, code, 'P2', 2);
  await joinRoom(p3, code, 'P3', 2);
  const watchers = Object.fromEntries([host, backup, p1, outsider].map((session, index) => [['host', 'backup', 'p1', 'outsider'][index], watch(session, code)]));
  t.after(() => Object.values(watchers).forEach((watcher) => watcher.stop()));
  await watchers.host.until((room) => Object.keys(room.players ?? {}).length === 3 && room.hosts?.[backup.uid] === true, 'host sees the players and the backup');
  return { code, watchers };
}

// 第 2 桌開局並推進到第 1 回合白晝；回傳照座位排好的 first、second、third。
async function dayTable(code, cards = data) {
  assert.deepEqual(await startTable(host, code, 2, cards, seededRandom(1)), { started: true });
  await advanceTable(host, code, 2, { round: 1, phase: 'sunrise' });
  const game = await read(host, `rooms/${code}/games/2`);
  const [first, second, third] = seatsInOrder(game.seats).map(([uid]) => [p1, p2, p3].find((session) => session.uid === uid));
  return { first, second, third };
}

// 從這一回合的 from 推進到黑夜（黃昏不開法案也照推），開黑夜、提前揭曉（全員睡覺）、過了緩衝揭曉。
async function nightRevealed(code, round, { from = 'day', key = 2 } = {}) {
  const phases = ['sunrise', 'day', 'dusk'];
  for (const phase of phases.slice(phases.indexOf(from))) await advanceTable(host, code, key, { round, phase });
  assert.equal((await settleNight(host, code, key, data)).outcome, 'opened');
  assert.deepEqual(await revealNight(host, code, key), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/${key}/night`);
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  assert.equal((await settleNight(host, code, key, data)).outcome, 'revealed');
}

// 不經過 store、直接用 SDK 寫一筆（測規則用）。
const put = (session, path, value) => set(ref(session.db, path), value);
const stamp = () => serverTimestamp();
const command = (session, fields, seq) => ({ ...fields, seq, at: stamp(), by: session.uid });
// 直接開一個全場鐘（規則照收；store 的 startClock 要等第 2 場開了才開第 2 場的鐘，這裡不用先打完第 1 場）。
const createClock = (session, path, minutes) => put(session, path, { startedAt: stamp(), minutes, anchor: stamp(), remain: minutes * MINUTE, adjust: 0, seq: 1, by: session.uid });
// 一筆直接寫入（write 是送出它的函式）的結果：'allowed'、'denied'（被規則拒）；其他錯誤（包括送出前就丟的）照原文寫出來，跟預期比一定不符。
const outcome = (write) =>
  Promise.resolve()
    .then(write)
    .then(
      () => 'allowed',
      (error) => (denied.test(`${error?.code} ${error?.message}`) ? 'denied' : `error: ${error?.message ?? error}`),
    );

test('only the hosts write display and clock; seated players, a signed-in screen and a signed-out connection cannot; everyone signed in reads them', TIMEOUT, async (t) => {
  const { code, watchers } = await consoleRoom(t);
  const scene = (session, seq) => put(session, `rooms/${code}/display/scene`, command(session, { id: 'overview' }, seq));
  await assert.rejects(scene(p1, 1), denied, 'a seated player');
  await assert.rejects(scene(outsider, 1), denied, 'signed in but not in the room');
  await scene(host, 1);
  await scene(backup, 2);
  const clock = (session) => put(session, `rooms/${code}/clock/1`, { startedAt: stamp(), minutes: 75, anchor: stamp(), remain: 75 * MINUTE, adjust: 0, seq: 1, by: session.uid });
  await assert.rejects(clock(p1), denied);
  await assert.rejects(clock(outsider), denied);
  await assert.rejects(startClock(p1, code, 1, 75), codeOf('permission-denied'), 'the store says so too');
  await clock(backup);
  // 讀：玩家與只登入的人（投影端）都讀得到。
  for (const name of ['p1', 'outsider', 'backup']) {
    const room = await watchers[name].until((value) => value.display?.scene?.seq === 2 && value.clock?.[1]?.seq === 1, `${name} sees display and clock`);
    assert.deepEqual([room.display.scene.id, room.display.scene.by, room.clock[1].by], ['overview', backup.uid, backup.uid]);
  }
  assert.equal((await read(outsider, `rooms/${code}/display/scene`)).seq, 2);
  // 沒登入的連線：讀、寫都被拒。
  const app = initializeApp(config.firebase, 'console-signed-out');
  t.after(() => deleteApp(app));
  const db = getDatabase(app);
  connectDatabaseEmulator(db, config.emulator.host, config.emulator.databasePort);
  await assert.rejects(get(ref(db, `rooms/${code}/display`)), denied);
  await assert.rejects(set(ref(db, `rooms/${code}/display/scene`), { id: 'rules', seq: 3, at: stamp(), by: 'nobody' }), denied);
  // store：玩家呼叫指令也是 permission-denied。
  await assert.rejects(setScene(p1, code, 'rules'), codeOf('permission-denied'));
});

test('every display command needs the next seq, the server time and the writer; formats, extra fields, partial updates and deletes are rejected', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  const path = (part) => `rooms/${code}/display/${part}`;
  const scene = (fields, seq, session = host) => put(host, path('scene'), { id: 'rules', ...fields, seq, at: stamp(), by: session.uid });
  await assert.rejects(scene({}, 2), denied, 'the first one is not seq 1');
  await scene({ page: 0 }, 1);
  await assert.rejects(scene({}, 1), denied, 'the same seq again');
  await assert.rejects(scene({}, 3), denied, 'a skipped seq');
  await assert.rejects(scene({}, 0), denied, 'going back');
  await assert.rejects(put(host, path('scene'), { id: 'rules', seq: 2, at: Date.now() - 5000, by: host.uid }), denied, 'not the server time');
  await assert.rejects(put(host, path('scene'), { id: 'rules', seq: 2, at: stamp(), by: backup.uid }), denied, 'by is not the writer');
  await assert.rejects(scene({ id: 'lobby' }, 2), denied, 'not a scene');
  await assert.rejects(scene({ page: 21 }, 2), denied);
  await assert.rejects(scene({ page: 1.5 }, 2), denied);
  await assert.rejects(scene({ extra: 1 }, 2), denied, 'an extra field');
  await assert.rejects(update(ref(host.db, path('scene')), { id: 'awards' }), denied, 'changing one field without a new seq and time');
  await assert.rejects(update(ref(host.db, path('scene')), { id: 'awards', seq: 2 }), denied, 'a new seq but the old time');
  await scene({ id: 'awards', page: 20 }, 2);
  // 廣播。
  const broadcast = (fields, seq) => put(host, path('broadcast'), { ...fields, seq, at: stamp(), by: host.uid });
  await assert.rejects(broadcast({ text: '' }, 1), denied, '0 characters');
  await assert.rejects(broadcast({ text: 'a'.repeat(41) }, 1), denied, '41 characters');
  await broadcast({ text: '字'.repeat(40) }, 1);
  await assert.rejects(broadcast({ text: 'x', hidden: false }, 2), denied, 'hidden can only be true');
  await assert.rejects(update(ref(host.db, path('broadcast')), { text: '只改字' }), denied, 'only the text');
  await broadcast({ text: '字'.repeat(40), hidden: true }, 2);
  // 音效：一秒最多一次。
  const sfx = (id, seq) => put(host, path('sfx'), { id, seq, at: stamp(), by: host.uid });
  await assert.rejects(sfx('horn', 1), denied, 'not a sound');
  await sfx('bell', 1);
  await assert.rejects(sfx('gavel', 2), denied, 'again within a second');
  const { at } = await read(host, path('sfx'));
  await untilServerTime(host, at + 1100);
  await sfx('gavel', 2);
  // 音樂。
  await assert.rejects(put(host, path('music'), { track: 'battle', on: true, seq: 1, at: stamp(), by: host.uid }), denied, 'not a track');
  await assert.rejects(put(host, path('music'), { track: 'opening', on: 'yes', seq: 1, at: stamp(), by: host.uid }), denied);
  await put(host, path('music'), { track: 'opening', on: true, seq: 1, at: stamp(), by: host.uid });
  // 全場暫停：on 是 false 時不能帶 clocks。
  const pause = (fields, seq) => put(host, path('pause'), { ...fields, seq, at: stamp(), by: host.uid });
  await assert.rejects(pause({ on: false, clocks: { 1: true } }, 1), denied);
  await assert.rejects(pause({ on: true, clocks: { 3: true } }, 1), denied, 'match 3');
  await assert.rejects(pause({ on: true, clocks: true }, 1), denied, 'clocks must be a list of matches');
  await pause({ on: true, clocks: { 1: true } }, 1);
  await pause({ on: false }, 2);
  // 刪不掉：一筆或整個 display；也不能把 display 寫成一個值或加別的鍵。
  await assert.rejects(remove(ref(host.db, path('scene'))), denied);
  await assert.rejects(update(ref(host.db, `rooms/${code}/display`), { music: null }), denied);
  await assert.rejects(remove(ref(host.db, `rooms/${code}/display`)), denied);
  await assert.rejects(put(host, `rooms/${code}/display/lights`, command(host, { on: true }, 1)), denied);
  const fresh = await createRoom(host);
  await assert.rejects(put(host, `rooms/${fresh}/display`, true), denied, 'display is not a value');
  // 房間底下其他新鍵照舊被拒。
  await assert.rejects(put(host, `rooms/${code}/lights`, { on: true }), denied);
  assert.deepEqual(Object.keys(await read(host, `rooms/${code}/display`)).sort(), ['broadcast', 'music', 'pause', 'scene', 'sfx']);
});

test('the clock is created with the server time and minutes × 60000, and only as match 1 or 2', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  const create = (fields, m = 1) => put(host, `rooms/${code}/clock/${m}`, { startedAt: stamp(), minutes: 75, anchor: stamp(), remain: 75 * MINUTE, adjust: 0, seq: 1, by: host.uid, ...fields });
  await assert.rejects(create({ minutes: 9, remain: 9 * MINUTE }), denied, '9 minutes');
  await assert.rejects(create({ minutes: 181, remain: 181 * MINUTE }), denied, '181 minutes');
  await assert.rejects(create({ minutes: 75.5, remain: 75.5 * MINUTE }), denied);
  await assert.rejects(create({ remain: 74 * MINUTE }), denied, 'remain does not match');
  await assert.rejects(create({ pausedAt: stamp() }), denied, 'created paused');
  await assert.rejects(create({ seq: 2 }), denied);
  await assert.rejects(create({ startedAt: Date.now() - MINUTE }), denied, 'startedAt is not the server time');
  await assert.rejects(create({ adjust: 60000, remain: 76 * MINUTE }), denied);
  await assert.rejects(create({ by: backup.uid }), denied);
  await assert.rejects(create({ extra: 1 }), denied);
  await assert.rejects(create({}, 3), denied, 'match 3');
  await assert.rejects(create({}, '1-2'), denied);
  await create({});
  await create({ minutes: 10, remain: 10 * MINUTE }, 2);
  const clock = await read(host, `rooms/${code}/clock/1`);
  assert.equal(clock.startedAt, clock.anchor);
  assert.ok(Math.abs(clock.startedAt - serverTime(host)) < 5000);
  await assert.rejects(remove(ref(host.db, `rooms/${code}/clock/1`)), denied, 'cannot be deleted');
  await assert.rejects(update(ref(host.db, `rooms/${code}/clock`), { 2: null }), denied);
});

test('pause writes only pausedAt; resume needs the exact remain and the server time; neither works the wrong way round or after sunset', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  const path = `rooms/${code}/clock/1`;
  await startClock(host, code, 1, 10);
  let clock = await read(host, path);
  await assert.rejects(put(host, path, { ...clock, pausedAt: stamp(), remain: clock.remain - 1, seq: 2 }), denied, 'pausing and changing remain');
  await assert.rejects(put(host, path, { ...clock, pausedAt: Date.now() - 1000, seq: 2 }), denied, 'pausedAt is not the server time');
  await assert.rejects(put(host, path, { ...clock, anchor: stamp(), remain: clock.remain, seq: 2 }), denied, 'resuming a running clock');
  await put(host, path, { ...clock, pausedAt: stamp(), seq: 2, by: host.uid });
  clock = await read(host, path);
  await assert.rejects(put(host, path, { ...clock, pausedAt: stamp(), seq: 3 }), denied, 'pausing a paused clock');
  const exact = clock.remain - (clock.pausedAt - clock.anchor);
  const { pausedAt, ...running } = clock;
  await assert.rejects(put(host, path, { ...running, anchor: stamp(), remain: exact - 1, seq: 3 }), denied, '1 ms short');
  await assert.rejects(put(host, path, { ...running, anchor: stamp(), remain: exact + 1, seq: 3 }), denied, '1 ms over');
  await assert.rejects(put(host, path, { ...running, anchor: clock.anchor, remain: exact, seq: 3 }), denied, 'the anchor is not the server time');
  await put(host, path, { ...running, anchor: stamp(), remain: exact, seq: 3, by: backup.uid }).catch(() => {}); // by 不是自己：被拒
  assert.equal((await read(host, path)).seq, 2);
  await put(host, path, { ...running, anchor: stamp(), remain: exact, seq: 3 });
  // 日落之後不能暫停：先減到底（store 會留約 1.5 秒），等它到點。
  const { delta } = await adjustClock(host, code, 1, -10 * MINUTE);
  assert.ok(delta < 0 && delta > -10 * MINUTE, String(delta));
  clock = await read(host, path);
  await untilServerTime(host, clock.anchor + clock.remain + 100);
  await assert.rejects(put(host, path, { ...clock, pausedAt: stamp(), seq: clock.seq + 1 }), denied, 'pausing after sunset');
  await assert.rejects(pauseClock(host, code, 1), codeOf('clock-passed'));
  await assert.rejects(adjustClock(host, code, 1, MINUTE), codeOf('clock-passed'));
});

test('adjusting moves remain and adjust by the same amount, at most 10 minutes a step and 30 in total, never below 0, never after sunset', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  const path = `rooms/${code}/clock/1`;
  await startClock(host, code, 1, 75);
  await pauseClock(host, code, 1); // 暫停中剩餘固定，規則的算術可以精確比對
  const step = async (change, fields = {}) => {
    const clock = await read(host, path);
    return put(host, path, { ...clock, remain: clock.remain + change, adjust: clock.adjust + change, seq: clock.seq + 1, by: host.uid, ...fields });
  };
  await step(10 * MINUTE);
  await step(-10 * MINUTE);
  await assert.rejects(step(10 * MINUTE + 1), denied, '10 minutes and 1 ms');
  await assert.rejects(step(-10 * MINUTE - 1), denied);
  const clock = await read(host, path);
  await assert.rejects(put(host, path, { ...clock, remain: clock.remain + MINUTE, adjust: clock.adjust + 2 * MINUTE, seq: clock.seq + 1 }), denied, 'remain and adjust disagree');
  await assert.rejects(step(MINUTE, { anchor: clock.anchor - 1 }), denied, 'moving the anchor');
  await assert.rejects(step(MINUTE, { pausedAt: clock.pausedAt + 1 }), denied, 'moving pausedAt');
  await assert.rejects(step(MINUTE, { startedAt: clock.startedAt - 1 }), denied, 'moving startedAt');
  await assert.rejects(step(MINUTE, { minutes: 76 }), denied, 'changing minutes');
  await assert.rejects(step(MINUTE, { seq: clock.seq }), denied, 'the same seq');
  await assert.rejects(put(host, path, { ...clock, seq: clock.seq + 1 }), denied, 'nothing changes');
  for (let index = 0; index < 3; index += 1) await step(10 * MINUTE);
  assert.equal((await read(host, path)).adjust, 30 * MINUTE);
  await assert.rejects(step(1), denied, 'past +30 minutes in total');
  // store 夾在上限：再加是 clock-limit；減回來可以；累計 -30 分同樣擋。
  await assert.rejects(adjustClock(host, code, 1, 5 * MINUTE), codeOf('clock-limit'));
  assert.equal((await adjustClock(host, code, 1, -10 * MINUTE)).delta, -10 * MINUTE);
  for (let index = 0; index < 5; index += 1) await adjustClock(host, code, 1, -10 * MINUTE);
  assert.equal((await read(host, path)).adjust, -30 * MINUTE);
  await assert.rejects(step(-1), denied, 'past −30 minutes in total');
  await assert.rejects(adjustClock(host, code, 1, -MINUTE), codeOf('clock-limit'));
  // 減到變負被拒；剛好 0 可以，之後就是日落，什麼都不能調了。
  const second = `rooms/${code}/clock/2`;
  await createClock(host, second, 10);
  await pauseClock(host, code, 2);
  let paused = await read(host, second);
  const left = paused.remain - (paused.pausedAt - paused.anchor);
  assert.ok(left > 9 * MINUTE);
  await assert.rejects(put(host, second, { ...paused, remain: paused.remain - left - 1, adjust: -left - 1, seq: paused.seq + 1 }), denied, 'below 0');
  const { delta, clock: zero } = await adjustClock(host, code, 2, -10 * MINUTE);
  assert.equal(delta, -left, 'clamped to exactly 0');
  assert.equal(clockRemaining(zero, serverTime(host)), 0);
  paused = await read(host, second);
  await assert.rejects(put(host, second, { ...paused, remain: paused.remain + MINUTE, adjust: paused.adjust + MINUTE, seq: paused.seq + 1 }), denied, 'adding after sunset');
  await assert.rejects(adjustClock(host, code, 2, MINUTE), codeOf('clock-passed'));
  await assert.rejects(remove(ref(host.db, second)), denied, 'cannot be deleted');
});

// 下面兩個測試不經過 store、直接寫，只靠規則擋（store 在送出前就會擋掉的情況也一樣要被規則拒）。每一列記下預期與實際，
// 最後一起比對：規則被放寬時，失敗訊息會列出所有被放行的寫入。
test('the rules alone: a resume cannot change adjust, not even back to 0 after an adjustment, and a running clock past sunset can be neither adjusted nor paused', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  const other = await createRoom(host);
  const path = (room, m) => `rooms/${room}/clock/${m}`;
  const rows = [];
  const check = async (label, want, write) => rows.push([label, want, await outcome(write)]);
  const resume = (clock, fields = {}) => {
    const { pausedAt, ...running } = clock;
    return { ...running, anchor: stamp(), remain: clock.remain - (pausedAt - clock.anchor), seq: clock.seq + 1, by: host.uid, ...fields };
  };
  const adjust = (clock, change) => ({ ...clock, remain: clock.remain + change, adjust: clock.adjust + change, seq: clock.seq + 1, by: host.uid });
  // 暫停中的鐘：繼續時順便改 adjust 不行（clock/1）；先合法地 +10 分、再在繼續時把 adjust 歸 0（想繞過累計 ±30 分）也不行（clock/2）。
  // 每一種各用一個鐘：規則被放寬、前一列被放行時，不會連帶讓後面的列看不出來。
  await startClock(host, code, 1, 75);
  await pauseClock(host, code, 1);
  const first = await read(host, path(code, 1));
  await check('clock 1: resume that also adds 1 minute to adjust', 'denied', () => put(host, path(code, 1), resume(first, { adjust: first.adjust + MINUTE })));
  await check('clock 1: the same resume with adjust left alone', 'allowed', () => put(host, path(code, 1), resume(first)));
  await createClock(host, path(code, 2), 75);
  await pauseClock(host, code, 2);
  const second = await read(host, path(code, 2));
  await check('clock 2: +10 minutes while paused', 'allowed', () => put(host, path(code, 2), adjust(second, 10 * MINUTE)));
  const added = await read(host, path(code, 2));
  await check('clock 2: resume that sets adjust back to 0 after the +10 minutes', 'denied', () => put(host, path(code, 2), resume(added, { adjust: 0 })));
  await check('clock 2: the same resume with adjust left alone', 'allowed', () => put(host, path(code, 2), resume(added)));
  // 走著的鐘（另一間房）：減到只剩約 1.5 秒（store 留的餘裕），等伺服器那邊日落 0.3 秒之後，加減、暫停都被拒。
  // 加的 1 分比已經超過的多：放行的話，日落了的鐘又會走起來（加時復活）。
  await startClock(host, other, 1, 10);
  await adjustClock(host, other, 1, -10 * MINUTE);
  const running = await read(host, path(other, 1));
  await untilServerTime(host, running.anchor + running.remain + 300);
  await check('past sunset: +1 minute to a running clock', 'denied', () => put(host, path(other, 1), adjust(running, MINUTE)));
  await check('past sunset: -1 minute to a running clock', 'denied', () => put(host, path(other, 1), adjust(running, -MINUTE)));
  await check('past sunset: pausing a running clock', 'denied', () => put(host, path(other, 1), { ...running, pausedAt: stamp(), seq: running.seq + 1, by: host.uid }));
  assert.deepEqual(rows.filter(([, want, got]) => want !== got), [], 'every write ends as expected');
  assert.equal((await read(host, path(other, 1))).seq, running.seq, 'nothing went into the clock past sunset');
});

test('the rules alone: scene, broadcast, sound, music and pause each refuse a skipped seq, the seq already there, a time that is not the server time and someone else as the writer', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  // 每一種節點的第 1 筆、第 2 筆合法內容。每一列只改一個欄位、其他照合法的寫，被拒只會是因為改的那一個欄位；
  // 最後照合法的寫一次，要寫得進去（也是下一輪的前一筆）。
  const contents = {
    scene: [{ id: 'rules' }, { id: 'awards', page: 1 }],
    broadcast: [{ text: '第一則' }, { text: '第一則', hidden: true }],
    sfx: [{ id: 'bell' }, { id: 'gavel' }],
    music: [{ track: 'opening', on: true }, { track: 'opening', on: false }],
    pause: [{ on: true }, { on: false }],
  };
  const changes = [
    ['a skipped seq', (seq) => ({ seq: seq + 2 })],
    ['the seq already there', (seq) => ({ seq })],
    ['a time that is not the server time', () => ({ at: Date.now() - 5000 })],
    ['someone else as the writer', () => ({ by: backup.uid })],
  ];
  const rows = [];
  for (const [part, writes] of Object.entries(contents)) {
    const path = `rooms/${code}/display/${part}`;
    for (const [seq, fields] of writes.entries()) {
      // 音效一秒最多一次：第 2 筆等過了一秒再寫，被拒就只會是因為改的那一個欄位。
      if (part === 'sfx' && seq > 0) await untilServerTime(host, (await read(host, path)).at + 1100);
      const legal = { ...fields, seq: seq + 1, at: stamp(), by: host.uid };
      for (const [name, change] of changes) rows.push([`${part} #${seq + 1}: ${name}`, 'denied', await outcome(() => put(host, path, { ...legal, ...change(seq) }))]);
      rows.push([`${part} #${seq + 1}: nothing changed`, 'allowed', await outcome(() => put(host, path, legal))]);
    }
  }
  assert.equal(rows.length, 5 * 2 * 5);
  assert.deepEqual(rows.filter(([, want, got]) => want !== got), [], 'only the untouched writes go in');
});

test('the store commands: scene, broadcast and take back, sounds, music, clock pause and resume; each writes seq + 1 and by', TIMEOUT, async (t) => {
  const { code, watchers } = await consoleRoom(t);
  // 換一台主持端下指令之前，先等它看到上一筆（指令接在這台讀到的那一筆後面；沒看到就是 conflict，另一個測試在測）。
  const sees = (name, pick, seq) => watchers[name].until((value) => (pick(value)?.seq ?? 0) === seq, `${name} sees seq ${seq}`);
  assert.deepEqual(await setScene(host, code, 'opening'), { seq: 1 });
  await sees('backup', (value) => value.display?.scene, 1);
  assert.deepEqual(await setScene(backup, code, 'rules', { page: 2 }), { seq: 2 });
  await sees('host', (value) => value.display?.scene, 2);
  assert.deepEqual(await setScene(host, code, 'rules', { page: 2 }), { seq: 3 }, 'the same scene again still writes (a replay)');
  const room = await watchers.outsider.until((value) => value.display?.scene?.seq === 3, 'the screen sees the scene');
  assert.deepEqual({ ...room.display.scene, at: typeof room.display.scene.at }, { id: 'rules', page: 2, seq: 3, at: 'number', by: host.uid });
  await assert.rejects(setScene(host, code, 'lobby'), codeOf('invalid-command'));
  await assert.rejects(setScene(host, code, 'rules', { page: 21 }), codeOf('invalid-command'));
  await assert.rejects(setScene(host, code, 'rules', { expectSeq: 2 }), (error) => error.code === 'conflict' && error.latest.seq === 3, 'the screen moved on');
  // 廣播：修剪、字數、收回。
  assert.deepEqual(await sendBroadcast(host, code, '  休息十分鐘  '), { seq: 1, text: '休息十分鐘' });
  await sees('backup', (value) => value.display?.broadcast, 1);
  await assert.rejects(sendBroadcast(host, code, '   '), codeOf('invalid-command'));
  await assert.rejects(sendBroadcast(host, code, 'a'.repeat(41)), codeOf('invalid-command'));
  assert.deepEqual(await sendBroadcast(backup, code, '😀'.repeat(20)), { seq: 2, text: '😀'.repeat(20) });
  await sees('host', (value) => value.display?.broadcast, 2);
  await assert.rejects(hideBroadcast(host, code, { expectSeq: 1 }), codeOf('conflict'), 'taking back an older one');
  assert.deepEqual(await hideBroadcast(host, code, { expectSeq: 2 }), { changed: true, seq: 3 });
  assert.deepEqual(await hideBroadcast(host, code), { changed: false, seq: 3 }, 'already taken back');
  const hidden = await watchers.p1.until((value) => value.display?.broadcast?.seq === 3, 'the player sees it taken back');
  assert.deepEqual([hidden.display.broadcast.text, hidden.display.broadcast.hidden], ['😀'.repeat(20), true]);
  // 音效：一秒內第二次是 too-soon。
  assert.deepEqual(await playSfx(host, code, 'bell'), { seq: 1 });
  await sees('backup', (value) => value.display?.sfx, 1);
  await assert.rejects(playSfx(backup, code, 'gavel'), codeOf('too-soon'));
  await assert.rejects(playSfx(host, code, 'horn'), codeOf('invalid-command'));
  const { at } = await read(host, `rooms/${code}/display/sfx`);
  await untilServerTime(host, at + 1100);
  assert.deepEqual(await playSfx(backup, code, 'gavel'), { seq: 2 });
  // 音樂：已經是這個狀態就不寫。
  assert.deepEqual(await setMusic(host, code, false), { changed: false, seq: 0 }, 'nothing to stop');
  assert.deepEqual(await setMusic(host, code, true), { changed: true, seq: 1 });
  await sees('backup', (value) => value.display?.music, 1);
  assert.deepEqual(await setMusic(backup, code, true), { changed: false, seq: 1 });
  assert.deepEqual(await setMusic(backup, code, false), { changed: true, seq: 2 });
  await assert.rejects(setMusic(host, code, 'on'), codeOf('invalid-command'));
  // 日落鐘。
  await assert.rejects(pauseClock(host, code, 1), codeOf('no-clock'));
  await assert.rejects(startClock(host, code, 3, 75), codeOf('invalid-command'));
  await assert.rejects(startClock(host, code, 1, 0.0001), codeOf('invalid-command'));
  // 第 2 場的鐘要等第 2 場開了（有 tables/{n}-2）：開了之後照樣開得起來，見「全部開始第 2 場」那個測試。
  await assert.rejects(startClock(host, code, 2, 75), codeOf('invalid-command'), 'the second match is not open yet');
  assert.equal(await read(host, `rooms/${code}/clock/2`), null);
  const opened = await startClock(host, code, 1, 75);
  assert.equal(opened.started, true);
  assert.deepEqual({ ...opened.clock, startedAt: 0, anchor: 0 }, { startedAt: 0, minutes: 75, anchor: 0, remain: 75 * MINUTE, adjust: 0, seq: 1, by: host.uid });
  assert.deepEqual((await startClock(backup, code, 1, 60)).started, false, 'already running: not written again');
  await sees('backup', (value) => value.clock?.[1], 1);
  const paused = await pauseClock(backup, code, 1);
  await sees('host', (value) => value.clock?.[1], 2);
  assert.deepEqual([paused.changed, paused.clock.seq, paused.clock.by, typeof paused.clock.pausedAt], [true, 2, backup.uid, 'number']);
  assert.equal((await pauseClock(host, code, 1)).changed, false);
  const plus = await adjustClock(host, code, 1, 5 * MINUTE);
  assert.deepEqual([plus.delta, plus.clock.adjust, plus.clock.seq], [5 * MINUTE, 5 * MINUTE, 3]);
  const undo = await adjustClock(host, code, 1, -plus.delta);
  assert.deepEqual([undo.delta, undo.clock.adjust], [-5 * MINUTE, 0]);
  await assert.rejects(adjustClock(host, code, 1, 0), codeOf('invalid-command'));
  const resumed = await resumeClock(host, code, 1, { expectSeq: 4 });
  assert.deepEqual([resumed.changed, resumed.clock.seq, 'pausedAt' in resumed.clock], [true, 5, false]);
  assert.equal(resumed.clock.remain, paused.clock.remain - (paused.clock.pausedAt - paused.clock.anchor));
  assert.equal((await resumeClock(host, code, 1)).changed, false);
  await assert.rejects(pauseClock(host, code, 1, { expectSeq: 4 }), codeOf('conflict'));
});

test('two hosts writing the same node at once: one write goes in, the other is rejected and told it was a conflict', TIMEOUT, async (t) => {
  const { code, watchers } = await consoleRoom(t);
  await startClock(host, code, 1, 75);
  await watchers.backup.until((value) => value.clock?.[1]?.seq === 1, 'the backup sees the clock');
  // 兩台都照畫面上的 seq 1 按：只成一筆，另一台回 conflict（不論是在送出前就看到、還是被規則拒）並帶最新的那一筆。
  const results = await Promise.allSettled([adjustClock(host, code, 1, MINUTE, { expectSeq: 1 }), adjustClock(backup, code, 1, -MINUTE, { expectSeq: 1 })]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  const failure = results.find((result) => result.status === 'rejected').reason;
  assert.equal(failure.code, 'conflict');
  assert.equal(failure.latest.seq, 2);
  const clock = await read(host, `rooms/${code}/clock/1`);
  assert.deepEqual([clock.seq, Math.abs(clock.adjust)], [2, MINUTE], 'one adjustment, not both');
  const winner = results.find((result) => result.status === 'fulfilled').value;
  assert.equal(winner.clock.seq, 2);
  // 場景也一樣：兩台同時從「還沒有場景」切，只成一筆。
  const scenes = await Promise.allSettled([setScene(host, code, 'rules', { expectSeq: 0 }), setScene(backup, code, 'awards', { expectSeq: 0 })]);
  assert.deepEqual(scenes.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(scenes.find((result) => result.status === 'rejected').reason.code, 'conflict');
  assert.equal((await read(host, `rooms/${code}/display/scene`)).seq, 1);
  // 規則本身：同一個 seq 寫兩次，第二次被拒（不經過 store 的檢查）。
  const raw = (session) => put(session, `rooms/${code}/display/broadcast`, command(session, { text: '同時' }, 1));
  const writes = await Promise.allSettled([raw(host), raw(backup)]);
  assert.deepEqual(writes.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
});

test('the full pause stops the running clocks in the same write and resumes only those; an invalid clock part rejects the whole write', TIMEOUT, async (t) => {
  const { code, watchers } = await consoleRoom(t);
  await startClock(host, code, 1, 75);
  await createClock(host, `rooms/${code}/clock/2`, 75);
  await pauseClock(host, code, 2); // 原本就手動暫停的鐘
  await watchers.backup.until((value) => value.clock?.[1]?.seq === 1 && value.clock?.[2]?.seq === 2, 'the backup sees both clocks');
  const paused = await setPause(backup, code, true);
  assert.deepEqual(paused, { changed: true, seq: 1, clocks: ['1'] });
  let room = await watchers.p1.until((value) => value.display?.pause?.on === true, 'the player sees the pause');
  assert.deepEqual([room.display.pause.clocks[1], room.display.pause.clocks[2], room.display.pause.by], [true, undefined, backup.uid]);
  assert.equal(room.clock[1].pausedAt, room.display.pause.at, 'stopped in the same write: the same server time');
  await watchers.host.until((value) => value.display?.pause?.seq === 1, 'the host sees the pause');
  assert.deepEqual(await setPause(host, code, true), { changed: false, seq: 1, clocks: [] }, 'already paused');
  const resumed = await setPause(host, code, false);
  assert.deepEqual(resumed, { changed: true, seq: 2, clocks: ['1'] });
  room = await watchers.host.until((value) => value.display?.pause?.on === false, 'resumed');
  assert.equal(room.display.pause.clocks, undefined);
  assert.equal(room.clock[1].pausedAt, undefined, 'the clock the pause stopped runs again');
  assert.equal(typeof room.clock[2].pausedAt, 'number', 'the clock that was paused by hand stays paused');
  assert.equal(room.clock[1].anchor, room.display.pause.at);
  // 一筆寫入：鐘的那部分不合法（已經暫停）時整筆被拒，display/pause 也沒寫進去。
  const clock2 = await read(host, `rooms/${code}/clock/2`);
  await assert.rejects(
    update(ref(host.db), {
      [`rooms/${code}/display/pause`]: { on: true, clocks: { 2: true }, seq: 3, at: stamp(), by: host.uid },
      [`rooms/${code}/clock/2`]: { ...clock2, pausedAt: stamp(), seq: clock2.seq + 1 },
    }),
    denied,
  );
  assert.equal((await read(host, `rooms/${code}/display/pause`)).seq, 2, 'display/pause was not written either');
  // 合法的一筆：暫停＋停住鐘一起成功。
  const clock1 = await read(host, `rooms/${code}/clock/1`);
  await update(ref(host.db), {
    [`rooms/${code}/display/pause`]: { on: true, clocks: { 1: true }, seq: 3, at: stamp(), by: host.uid },
    [`rooms/${code}/clock/1`]: { ...clock1, pausedAt: stamp(), seq: clock1.seq + 1, by: host.uid },
  });
  assert.deepEqual(await setPause(host, code, false, { expectSeq: 3 }), { changed: true, seq: 4, clocks: ['1'] });
  await assert.rejects(setPause(host, code, true, { expectSeq: 3 }), codeOf('conflict'));
  await watchers.p1.until((value) => value.display?.pause?.seq === 4, 'the player sees the resume');
  await assert.rejects(setPause(p1, code, true), codeOf('permission-denied'));
  // 已經日落的鐘不會被暫停帶走（規則也不准暫停它，store 不把它放進那一筆）。
  const other = await createRoom(host);
  await startClock(host, other, 1, 10);
  await adjustClock(host, other, 1, -10 * MINUTE);
  const passed = await read(host, `rooms/${other}/clock/1`);
  await untilServerTime(host, passed.anchor + passed.remain + 100);
  assert.deepEqual(await setPause(host, other, true), { changed: true, seq: 1, clocks: [] });
  assert.equal((await read(host, `rooms/${other}/clock/1`)).seq, 2, 'the clock is left as it was');
});

test('with a room clock, sunset follows it: the night ends the game when it is up and moves on while it is paused', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  await dayTable(code, data);
  await startClock(host, code, 1, 10);
  await pauseClock(host, code, 1);
  // 各桌從開局起算早就過了（sunset 資料只有 6 毫秒），但全場鐘暫停著：照常進下一回合日出。
  await nightRevealed(code, 1);
  const moved = await advanceOrEnd(host, code, 2, { round: 1, phase: 'night' }, sunset);
  assert.deepEqual([moved.advanced, moved.ended, moved.table.round, moved.table.phase], [true, false, 2, 'sunrise']);
  assert.equal((await processSunrise(host, code, 2, data)).dealt, true);
  // 鐘減到剛好 0（暫停中）＝日落：這一回合黑夜揭曉後算分，原因是 sunset（不看各桌的 startedAt）。
  await adjustClock(host, code, 1, -10 * MINUTE);
  await nightRevealed(code, 2, { from: 'sunrise' });
  const held = await advanceOrEnd(host, code, 2, { round: 2, phase: 'night' }, data, { allowEnd: false });
  assert.deepEqual([held.advanced, held.ended, held.held, held.reason], [false, false, true, 'sunset'], 'allowEnd: false holds the scoring step');
  assert.equal(await read(host, `rooms/${code}/tables/2/phase`), 'night');
  const ended = await advanceOrEnd(host, code, 2, { round: 2, phase: 'night' }, data);
  assert.deepEqual([ended.advanced, ended.ended, ended.reason], [true, true, 'sunset']);
  assert.deepEqual([await read(host, `rooms/${code}/tables/2/phase`), await read(host, `rooms/${code}/games/2/final/reason`)], ['end', 'sunset']);
});

test('a running room clock that is not up yet keeps the game going even when the table clock alone would have ended it; the second match follows its own table clock, not the clock of the first match', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  await dayTable(code, data);
  await startClock(host, code, 1, 10);
  await nightRevealed(code, 1);
  const moved = await advanceOrEnd(host, code, 2, { round: 1, phase: 'night' }, sunset);
  assert.deepEqual([moved.ended, moved.table.round], [false, 2], 'the room clock has 10 minutes left');
  // clock/1 減到日落：第 1 場這一回合結束就算分（各桌從開局起算的 75 分還沒到）。
  assert.equal((await processSunrise(host, code, 2, data)).dealt, true);
  await adjustClock(host, code, 1, -10 * MINUTE);
  const clock = await read(host, `rooms/${code}/clock/1`);
  await untilServerTime(host, clock.anchor + clock.remain + 100);
  await nightRevealed(code, 2, { from: 'sunrise' });
  const ended = await advanceOrEnd(host, code, 2, { round: 2, phase: 'night' }, data);
  assert.deepEqual([ended.ended, ended.reason], [true, 'sunset']);
  // 第 2 場沒有自己的鐘（clock/2）：照第 2 場各桌自己從開局起算，已經日落的 clock/1 不算數。
  assert.deepEqual(await openMatch(host, code, 2), { opened: true, key: '2-2' });
  assert.deepEqual(await startTable(host, code, '2-2', data, seededRandom(31)), { started: true });
  await nightRevealed(code, 1, { from: 'sunrise', key: '2-2' });
  const second = await advanceOrEnd(host, code, '2-2', { round: 1, phase: 'night' }, data);
  assert.deepEqual([second.advanced, second.ended, second.table.round, second.table.phase], [true, false, 2, 'sunrise'], 'clock/1 is up, but the second match goes on');
  assert.equal(await read(host, `rooms/${code}/clock/2`), null);
});

test('with display, clock and screens in the room every game write still goes through: start, advance, play, respond, dusk, night, score and the second match', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  await setScene(host, code, 'overview');
  await sendBroadcast(host, code, '開始了');
  await setMusic(host, code, true);
  await startClock(host, code, 1, 75);
  await setPause(host, code, true);
  await setPause(host, code, false);
  const screen = trackScreen(outsider, code, { audio: true, scene: 1 });
  t.after(() => screen.stop());
  assert.equal(await screen.update({ scene: 1 }), true);
  const { first, second } = await dayTable(code, data);
  // 出牌與響應：first 打 a03（交易），second 用 a31 響應。
  const game = await read(host, `rooms/${code}/games/2`);
  const deck = buildDeck(data.actions);
  for (const id of ['a03', 'a31']) deck.splice(deck.indexOf(id), 1);
  const writes = { [`rooms/${code}/games/2/version`]: game.version + 1, [`rooms/${code}/games/2/discardCount`]: 0, [`rooms/${code}/games/2/deckCount`]: deck.length, [`hostOnly/${code}/2`]: { deck, discard: [] } };
  for (const uid of Object.keys(game.seats)) {
    const hand = uid === first.uid ? ['a03'] : uid === second.uid ? ['a31'] : [];
    writes[`private/${code}/${uid}/hand`] = hand;
    writes[`rooms/${code}/games/2/seats/${uid}/handCount`] = hand.length;
  }
  await update(ref(host.db), writes);
  await requestPlay(first, code, { card: 'a03' });
  assert.equal((await settleRequest(host, code, 2, first.uid, data, seededRandom(2))).outcome, 'opened');
  const { pending } = await read(host, `rooms/${code}/games/2`);
  await requestRespond(second, code, { card: 'a31', pending: pending.id });
  assert.deepEqual(await settleWindow(host, code, 2, data, seededRandom(3)), { outcome: 'resolved', response: { by: second.uid, card: 'a31' } });
  // 黃昏：開、投票、揭曉。
  await advanceTable(host, code, 2, { round: 1, phase: 'day' });
  assert.equal((await settleDusk(host, code, 2, data, seededRandom(4))).outcome, 'opened');
  const dusk = await read(host, `rooms/${code}/games/2/dusk`);
  if (dusk.bill) {
    for (const session of [p1, p2, p3]) await requestVote(session, code, { table: '2', round: 1, side: 'yes', bid: 0 });
    assert.equal((await settleDusk(host, code, 2, data, seededRandom(5))).outcome, 'counted');
    const { revealAt } = await read(host, `rooms/${code}/games/2/dusk`);
    await untilServerTime(host, revealAt + 1100);
    assert.equal((await settleDusk(host, code, 2, data, seededRandom(6))).outcome, 'revealed');
  }
  // 黑夜：選擇、揭曉；這一回合結束後算分。
  await advanceTable(host, code, 2, { round: 1, phase: 'dusk' });
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'opened');
  for (const session of [p1, p2, p3]) await requestNight(session, code, { table: '2', round: 1, choice: 'sleep' });
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'counted');
  const { revealAt } = await read(host, `rooms/${code}/games/2/night`);
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  assert.equal((await settleNight(host, code, 2, data, seededRandom(7))).outcome, 'revealed');
  await setEndAfterRound(host, code, 2, true);
  const ended = await advanceOrEnd(host, code, 2, { round: 1, phase: 'night' }, data);
  assert.deepEqual([ended.ended, ended.reason], [true, 'host']);
  // 開第 2 場、開始第 2 場。
  assert.deepEqual(await openMatch(host, code, 2), { opened: true, key: '2-2' });
  assert.deepEqual(await startTable(host, code, '2-2', data, seededRandom(8)), { started: true });
  const room = await read(host, `rooms/${code}`);
  assert.deepEqual([room.tables['2-2'].phase, Object.keys(room.games['2-2'].seats).length], ['sunrise', 3]);
  assert.deepEqual([room.display.scene.id, room.display.broadcast.text, room.display.music.on, room.display.pause.on, room.clock[1].seq], ['overview', '開始了', true, false, 3]);
  assert.equal(room.screens[outsider.uid].audio, true);
});

test('the screen reports itself and the server removes the report when it disconnects; only its own record, only with the server time', TIMEOUT, async (t) => {
  const { code, watchers } = await consoleRoom(t);
  const screenSession = await connect('c-screen');
  const screen = trackScreen(screenSession, code, { audio: false });
  await watchers.host.until((room) => room.screens?.[screenSession.uid]?.audio === false, 'the console sees the screen');
  assert.equal(await screen.update({ audio: true, scene: 4 }), true);
  let room = await watchers.host.until((value) => value.screens?.[screenSession.uid]?.audio === true, 'audio is on');
  assert.deepEqual({ ...room.screens[screenSession.uid], at: typeof room.screens[screenSession.uid].at }, { audio: true, scene: 4, at: 'number' });
  await assert.rejects(put(outsider, `rooms/${code}/screens/${screenSession.uid}`, { audio: true, at: stamp() }), denied, "someone else's record");
  await assert.rejects(put(outsider, `rooms/${code}/screens/${outsider.uid}`, { audio: true, at: Date.now() - 1000 }), denied, 'not the server time');
  await assert.rejects(put(outsider, `rooms/${code}/screens/${outsider.uid}`, { audio: 'yes', at: stamp() }), denied);
  await assert.rejects(put(outsider, `rooms/${code}/screens/${outsider.uid}`, { audio: true, scene: -1, at: stamp() }), denied);
  await assert.rejects(put(outsider, `rooms/${code}/screens/${outsider.uid}`, { audio: true, at: stamp(), extra: 1 }), denied);
  await assert.rejects(put(outsider, 'rooms/AAAAAA/screens/' + outsider.uid, { audio: true, at: stamp() }), denied, 'no such room');
  await put(outsider, `rooms/${code}/screens/${outsider.uid}`, { audio: false, at: stamp() });
  await remove(ref(outsider.db, `rooms/${code}/screens/${outsider.uid}`));
  // 斷線：伺服器代為刪除。
  await disconnect(screenSession);
  room = await watchers.host.until((value) => !value.screens?.[screenSession.uid], 'the report is gone after the screen disconnects');
  assert.equal(room.screens?.[screenSession.uid], undefined);
});

test('waiting for: the host sees who has not voted or chosen yet, the same count as dusk.submitted and night.submitted', TIMEOUT, async (t) => {
  const { code, watchers } = await consoleRoom(t);
  const { first } = await dayTable(code, data);
  let latest = null;
  const stop = watchSubmissions(host, code, (value) => {
    latest = value;
  });
  t.after(stop);
  await advanceTable(host, code, 2, { round: 1, phase: 'day' });
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'none', 'not night yet');
  await advanceTable(host, code, 2, { round: 1, phase: 'dusk' });
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'opened');
  await requestNight(first, code, { table: '2', round: 1, choice: 'gamble', tiers: 2 });
  const deadline = Date.now() + 5000;
  while (!(latest?.nights?.[first.uid]?.seq >= 1) && Date.now() < deadline) await sleep(50);
  const room = await watchers.host.until((value) => value.games?.[2]?.night?.round === 1, 'night opened');
  const waiting = waitingFor(room, '2', latest);
  assert.equal(waiting.kind, 'night');
  assert.deepEqual(waiting.submitted, [first.uid]);
  assert.equal(waiting.missing.length, 2);
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'counted');
  const counted = await watchers.host.until((value) => value.games?.[2]?.night?.submitted === 1, 'submitted is 1');
  assert.equal(waitingFor(counted, '2', latest).submitted.length, counted.games[2].night.submitted);
  // 玩家讀不到別人的選擇；只有主持端能開 watchSubmissions 讀到內容。
  const other = [p1, p2, p3].find((session) => session !== first);
  await assert.rejects(read(other, `nights/${code}/${first.uid}`), denied);
});

test('start all opens every table that can start and then the room clock; advance all moves only the tables that can go, and holds the scoring step; a progress callback that throws stops neither', TIMEOUT, async (t) => {
  const { code, watchers } = await consoleRoom(t);
  await joinRoom(outsider, code, 'Solo', 4);
  let room = await watchers.host.until((value) => Object.keys(value.players ?? {}).length === 4, 'four players');
  const plan = startPlan(room, data);
  assert.deepEqual(plan.start.map(({ key, count }) => [key, count]), [['2', 3], ['4', 1]]);
  assert.equal(plan.skip.length, 4, 'tables 1, 3, 5 and 6 have nobody');
  // 畫面的進度回呼丟錯（例如畫到一半出錯）：批次照做完，每一桌的結果照樣回傳。
  const progress = [];
  const failing = (step) => {
    progress.push([step.done, step.total, step.key]);
    throw new Error('the progress bar failed to draw');
  };
  const started = await startAll(host, code, plan, data, { random: seededRandom(11), clock: true, onProgress: failing });
  assert.deepEqual(started.results.map(({ key, started: ok, error }) => [key, ok, error]), [['2', true, null], ['4', true, null]]);
  assert.deepEqual(started.clock, { started: true, error: null });
  assert.deepEqual(progress, [[1, 2, '2'], [2, 2, '4']]);
  room = await watchers.host.until((value) => value.games?.[4] && value.clock?.[1], 'both started and the clock runs');
  assert.equal(room.clock[1].minutes, 75);
  // 再按一次：沒有要開的桌，鐘也已經開了。
  const again = startPlan(room, data);
  assert.deepEqual([again.start.length, again.started, again.clock.needed], [0, ['2', '4'], false]);
  assert.deepEqual(await startAll(host, code, again, data, { clock: true }), { results: [], clock: null });
  // 能推的全推：兩桌都在日出、已發牌 → 白晝；第 4 桌 1 人，白晝出完才推。
  const plan1 = advancePlan(room, data.settings, serverTime(host));
  assert.deepEqual(plan1.advance.map(({ key, to }) => [key, to.phase]), [['2', 'day'], ['4', 'day']]);
  const moved = await advanceAll(host, code, plan1, data, { random: seededRandom(12), onProgress: failing });
  assert.deepEqual(progress.slice(2), [[1, 2, '2'], [2, 2, '4']], 'called for every table even though it threw');
  assert.deepEqual(moved.results.map(({ key, advanced, error }) => [key, advanced, error]), [['2', true, null], ['4', true, null]]);
  // 同一份計畫再執行一次：局面已經變了，沒有動。
  const stale = await advanceAll(host, code, plan1, data);
  assert.deepEqual(stale.results.map(({ advanced, error }) => [advanced, error]), [[false, null], [false, null]]);
  room = await watchers.host.until((value) => value.tables[2].phase === 'day' && value.tables[4].phase === 'day', 'both in the day');
  assert.deepEqual(advancePlan(room, data.settings, serverTime(host)).skip.filter(({ reason }) => reason === 'playing').map(({ key }) => key), ['2', '4']);
  // 第 2 桌推到黑夜揭曉、第 4 桌留在白晝；這一回合結束後算分。
  await advanceTable(host, code, 2, { round: 1, phase: 'day' });
  await advanceTable(host, code, 2, { round: 1, phase: 'dusk' });
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'opened');
  assert.deepEqual(await revealNight(host, code, 2), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/2/night`);
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'revealed');
  await setEndAfterRound(host, code, 2, true);
  room = await watchers.host.until((value) => value.games[2].night?.result && value.games[2].endAfterRound === 1, 'night revealed and ending');
  const holding = advancePlan(room, data.settings, serverTime(host));
  assert.deepEqual(holding.skip.find(({ key }) => key === '2').reason, 'ending');
  assert.deepEqual(holding.advance, []);
  const scoring = advancePlan(room, data.settings, serverTime(host), { includeEnding: true });
  assert.deepEqual(scoring.advance.map(({ key, to }) => [key, to.phase]), [['2', 'end']]);
  // 全場暫停了：照計畫執行也不推。
  await setPause(host, code, true);
  const blocked = await advanceAll(host, code, scoring, data);
  assert.equal(blocked.results[0].error.code, 'paused');
  assert.equal(await read(host, `rooms/${code}/tables/2/phase`), 'night');
  await setPause(host, code, false);
  const done = await advanceAll(host, code, scoring, data);
  assert.deepEqual(done.results.map(({ key, advanced, ended, reason }) => [key, advanced, ended, reason]), [['2', true, true, 'host']]);
  // 換場：開第 2 場，全部開始第 2 場（照預設名單），第 2 場的鐘一起開。
  assert.deepEqual(await openMatch(host, code, 2), { opened: true, key: '2-2' });
  room = await watchers.host.until((value) => value.tables['2-2'], 'the second match is open');
  const match2 = startMatch2Plan(room, data);
  assert.deepEqual(match2.start.map(({ key, count }) => [key, count]), [['2-2', 3]]);
  const second = await startAll(host, code, match2, data, { random: seededRandom(13), clock: true });
  assert.deepEqual([second.results[0].started, second.clock.started], [true, true]);
  room = await watchers.host.until((value) => value.clock?.[2] && value.games?.['2-2'], 'the second match started with its own clock');
  assert.equal(room.clock[2].seq, 1);
});

// 這台估的伺服器時間偏一點（主持端連上時量的 .info/serverTimeOffset 不準）：只在這一段把 Date.now 挪 shift 毫秒。
async function skewed(shift, run) {
  const realNow = Date.now;
  Date.now = () => realNow() + shift;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

test('the full pause always goes in, even when a clock this host thinks is still running has just set on the server', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  await startClock(host, code, 1, 10);
  await adjustClock(host, code, 1, -10 * MINUTE); // 只剩約 1.5 秒
  const clock = await read(host, `rooms/${code}/clock/1`);
  await untilServerTime(host, clock.anchor + clock.remain + 500); // 伺服器那邊已經日落半秒
  // 這台估的時間慢 3 秒：以為還剩 2.5 秒。離日落不到 10 秒的鐘第一次就不帶，所以不會被拒，不用等。
  let startedAt = Date.now();
  const result = await skewed(-3000, () => setPause(host, code, true));
  assert.ok(Date.now() - startedAt < 1500, `answered in ${Date.now() - startedAt} ms, not after a refusal`);
  assert.deepEqual(result, { changed: true, seq: 1, clocks: [] }, 'the pause went in without the clock');
  assert.equal((await read(host, `rooms/${code}/display/pause`)).on, true);
  assert.equal((await read(host, `rooms/${code}/clock/1`)).seq, 2, 'the clock that had already set was left as it was');
  // 慢 20 秒：以為還剩 19 秒，把鐘放進暫停那一筆，整筆被規則拒；伺服器上沒有變化，一個鐘都不帶再寫一次，暫停照樣寫得進去。
  assert.deepEqual(await setPause(host, code, false), { changed: true, seq: 2, clocks: [] });
  startedAt = Date.now();
  assert.deepEqual(await skewed(-20_000, () => setPause(host, code, true)), { changed: true, seq: 3, clocks: [] }, 'refused once, then in without the clock');
  assert.ok(Date.now() - startedAt >= 2500, 'it waited to see that nothing had changed on the server');
  assert.equal((await read(host, `rooms/${code}/clock/1`)).seq, 2);
});

test('the full pause leaves out a clock less than 10 seconds before sunset at once: that clock runs on, the other one is stopped and later resumed', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  await startClock(host, code, 1, 10);
  await adjustClock(host, code, 1, -(10 * MINUTE - 6000)); // 還剩約 6 秒
  await createClock(host, `rooms/${code}/clock/2`, 75);
  const near = await read(host, `rooms/${code}/clock/1`);
  const left = clockRemaining(near, serverTime(host));
  assert.ok(left > 2000 && left < 10_000, String(left));
  const startedAt = Date.now();
  assert.deepEqual(await setPause(host, code, true), { changed: true, seq: 1, clocks: ['2'] });
  assert.ok(Date.now() - startedAt < 1500, 'at once');
  let room = await read(host, `rooms/${code}`);
  assert.deepEqual([room.display.pause.clocks?.[1], room.display.pause.clocks?.[2]], [undefined, true]);
  assert.deepEqual([room.clock[1].seq, room.clock[1].pausedAt, typeof room.clock[2].pausedAt], [near.seq, undefined, 'number'], 'only the clock far from sunset is stopped');
  assert.deepEqual(await setPause(host, code, false), { changed: true, seq: 2, clocks: ['2'] });
  room = await read(host, `rooms/${code}`);
  assert.deepEqual([room.clock[1].seq, room.clock[2].pausedAt], [near.seq, undefined]);
});

test('a refused resume of the full pause is reported, not written without its clocks: the pause and the clocks it stopped stay as they were', TIMEOUT, async (t) => {
  // 只有這台的快取出錯才會這樣。做法：離線時先寫一筆一定被拒的鐘（同一個 seq、remain 多 1 毫秒），快取先照它改；
  // 恢復照快取組好、排在它後面，連上之後兩筆都被規則拒，伺服器上什麼都沒變。
  const solo = await connect('c-resume');
  const code = await createRoom(solo);
  const watcher = watch(solo, code); // 有訂閱時 get() 讀本機快取（包括還沒送到的寫入）
  t.after(async () => {
    watcher.stop();
    await disconnect(solo);
  });
  await startClock(solo, code, 1, 75);
  assert.deepEqual(await setPause(solo, code, true), { changed: true, seq: 1, clocks: ['1'] });
  const clock = await read(solo, `rooms/${code}/clock/1`);
  goOffline(solo.db);
  const bogus = put(solo, `rooms/${code}/clock/1`, { ...clock, remain: clock.remain + 1 }).then(() => null, (error) => error);
  const resuming = setPause(solo, code, false).then((value) => ({ value }), (error) => ({ error }));
  await sleep(300);
  goOnline(solo.db);
  assert.match(String((await bogus)?.message), denied, 'the bogus clock was refused');
  const { value, error } = await resuming;
  assert.equal(value, undefined, 'not written without the clock');
  assert.deepEqual([error.name, error.code], ['StoreError', 'rejected']);
  const room = await read(host, `rooms/${code}`);
  assert.deepEqual([room.display.pause.on, room.display.pause.seq, room.display.pause.clocks?.[1]], [true, 1, true], 'still paused, still listing the clock');
  assert.deepEqual([room.clock[1].seq, room.clock[1].pausedAt], [clock.seq, room.display.pause.at], 'the clock is still stopped by this pause');
  assert.deepEqual(await setPause(solo, code, false), { changed: true, seq: 2, clocks: ['1'] }, 'pressing again resumes it');
});

test('no room clock starts during the full pause, not by hand and not as the last step of start all', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  await dayTable(code, data); // 第 2 桌已經開局：計畫裡有已開局的桌
  await setPause(host, code, true);
  await assert.rejects(startClock(host, code, 1, 75), codeOf('paused'));
  const plan = startPlan(await read(host, `rooms/${code}`), data);
  assert.deepEqual([plan.start.length, plan.started, plan.clock.needed], [0, ['2'], true]);
  const result = await startAll(host, code, plan, data, { clock: true });
  assert.deepEqual(result.results, []);
  assert.equal(result.clock.error.code, 'paused');
  assert.equal(await read(host, `rooms/${code}/clock/1`), null, 'no clock is running through the pause');
  await setPause(host, code, false);
  assert.equal((await startClock(host, code, 1, 75)).started, true, 'after resuming it starts');
});

test('advance all scores only the tables the confirm box showed as scoring; a table that reaches sunset after the plan is held', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  await joinRoom(outsider, code, 'Solo', 4);
  await dayTable(code, data);
  assert.deepEqual(await startTable(host, code, 4, data, seededRandom(21)), { started: true });
  await advanceTable(host, code, 4, { round: 1, phase: 'sunrise' });
  await nightRevealed(code, 1);
  await nightRevealed(code, 1, { key: 4 });
  await setEndAfterRound(host, code, 2, true); // 第 2 桌這一回合要算分；第 4 桌不用
  await startClock(host, code, 1, 10);
  const plan = advancePlan(await read(host, `rooms/${code}`), data.settings, serverTime(host), { includeEnding: true });
  assert.deepEqual(plan.advance.map(({ key, ending, to }) => [key, ending, to.phase]), [['2', 'host', 'end'], ['4', null, 'sunrise']]);
  // 確認框打開之後全場鐘才到點：第 4 桌在框上寫的是「→ 日出」，不能替它算分。
  await adjustClock(host, code, 1, -10 * MINUTE);
  const clock = await read(host, `rooms/${code}/clock/1`);
  await untilServerTime(host, clock.anchor + clock.remain + 100);
  const { results } = await advanceAll(host, code, plan, data);
  assert.deepEqual(
    results.map(({ key, advanced, ended, held, reason, error }) => [key, advanced, ended, held, reason, error]),
    [
      ['2', true, true, false, 'sunset', null],
      ['4', false, false, true, 'sunset', null],
    ],
  );
  assert.deepEqual([await read(host, `rooms/${code}/tables/4/phase`), await read(host, `rooms/${code}/games/4/final`)], ['night', null]);
});

test('resuming the full pause leaves alone a clock that was resumed and paused again by hand during the pause', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  await startClock(host, code, 1, 75);
  assert.deepEqual((await setPause(host, code, true)).clocks, ['1']);
  assert.equal((await resumeClock(host, code, 1)).changed, true, 'by hand during the pause');
  assert.equal((await pauseClock(host, code, 1)).changed, true, 'and paused again by hand');
  assert.deepEqual(await setPause(host, code, false), { changed: true, seq: 2, clocks: [] });
  assert.equal(typeof (await read(host, `rooms/${code}/clock/1`)).pausedAt, 'number', 'still paused: the host paused it');
});

test('a sound refused at the one-second edge comes back as too-soon at once, even when this host thought a second had passed', TIMEOUT, async (t) => {
  const { code } = await consoleRoom(t);
  await playSfx(host, code, 'bell');
  const { at } = await read(host, `rooms/${code}/display/sfx`);
  await untilServerTime(host, at + 600);
  // 這台估的時間快 0.6 秒：以為已經過了 1.2 秒，送出去被規則拒（伺服器那邊才 0.6 秒）。
  const startedAt = Date.now();
  await skewed(600, () => assert.rejects(playSfx(host, code, 'gavel'), codeOf('too-soon')));
  assert.ok(Date.now() - startedAt < 1500, 'answered without waiting for the server');
  assert.equal((await read(host, `rooms/${code}/display/sfx`)).seq, 1);
});

test('the screen puts its report back when the server removes it for an older connection', TIMEOUT, async (t) => {
  const { code, watchers } = await consoleRoom(t);
  const screenSession = await connect('c-screen2');
  const screen = trackScreen(screenSession, code, { audio: true });
  // 先停回報、再關連線（連線關掉之後再對它下指令會一直等不到回應）。
  t.after(async () => {
    await screen.stop();
    await disconnect(screenSession);
  });
  const first = await watchers.host.until((room) => room.screens?.[screenSession.uid]?.audio === true, 'the console sees the screen');
  const before = first.screens[screenSession.uid].at;
  // 同一個身分較早的連線斷開時，伺服器代為刪除的會是同一筆：直接刪掉來模擬。
  await remove(ref(screenSession.db, `rooms/${code}/screens/${screenSession.uid}`));
  const back = await watchers.host.until((room) => room.screens?.[screenSession.uid]?.at > before, 'the report is back');
  assert.equal(back.screens[screenSession.uid].audio, true);
});
