// 終局與計分的同步與權限測試（M9）：日落鐘到了黑夜推進就算分（沒到照常進日出）、第 12 回合上限、提早收場與取消、終局後不能再推進、
// 自動化不再動、玩家寫不了 final、只改一個欄位繞不過 final 的條件、主持端勾天命、兩台主持端同時算分只成一筆（npm run test:sync）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get, ref, serverTimestamp, set, update } from 'firebase/database';
import { judgeScores, nightSettleAt, scoreGame, seatsInOrder, seededRandom } from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';
import {
  advanceOrEnd,
  advanceTable,
  approveHost,
  connect,
  createRoom,
  disconnect,
  enterAsHost,
  joinRoom,
  judgeDestiny,
  processSunrise,
  requestPass,
  revealDusk,
  revealNight,
  serverTime,
  setEndAfterRound,
  settleDusk,
  settleNight,
  startSettling,
  startTable,
  watchRoom,
} from '../../play/js/store.js';

const TIMEOUT = { timeout: 60_000 };
const denied = /permission[_ ]denied/i;
const cardDir = new URL('../../play/data/', import.meta.url);
const { data: fileData, errors } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
assert.deepEqual(errors, []);
// 天命換成測試用的：每個階層一張，前三個階層的判定一定達成（英鎊 >= 0）、後三個一定不達成（英鎊 > 9999）；不依賴正式資料的天命。
const roleIds = fileData.roles.map((role) => role.id);
const destiny = (role, index, check) => ({ id: `t${index + 1}`, role, text: `測試天命 ${index + 1}`, score: { text: '測試', points: 10 }, check });
const checked = roleIds.map((role, index) => destiny(role, index, { kind: 'compare', what: 'pounds', op: index < 3 ? '>=' : '>', value: index < 3 ? 0 : 9999 }));
const blank = roleIds.map((role, index) => destiny(role, index, null));
// 日出不翻一般事件（sunriseEvents 0）；黑夜倒數 1 秒。
const data = { ...fileData, destinies: checked, settings: { ...fileData.settings, sunriseEvents: 0, nightRevealSeconds: 1 } };
const sunset = { ...data, settings: { ...data.settings, sunsetMinutes: 0.0001 } }; // 開局 6 毫秒後日落鐘就到了
assert.equal(data.settings.sunsetMinutes, 75);
assert.equal(data.settings.maxRounds, 12);

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

async function untilServerTime(session, at) {
  for (let left = at - serverTime(session); left > 0; left = at - serverTime(session)) await sleep(Math.min(left + 5, 250));
}

// 主持端讀出第 2 桌：桌、局面、發過牌的回合、牌庫、各人的私密資料。
async function readTable(code) {
  const [table, game, deals, pile] = await Promise.all([
    read(host, `rooms/${code}/tables/2`),
    read(host, `rooms/${code}/games/2`),
    read(host, `rooms/${code}/deals/2`),
    read(host, `hostOnly/${code}/2`),
  ]);
  const privates = Object.fromEntries(await Promise.all(Object.keys(game.seats).map(async (uid) => [uid, await read(host, `private/${code}/${uid}`)])));
  return { table, game, deals, pile, privates };
}

// 開一間新房，p1、p2、p3 在第 2 桌、outsider 在第 3 桌；第 2 桌開局並推進到第 1 回合白晝。
async function dayRoom(t, cards = data) {
  const code = await createRoom(host);
  await joinRoom(p1, code, 'P1', 2);
  await joinRoom(p2, code, 'P2', 2);
  await joinRoom(p3, code, 'P3', 2);
  await joinRoom(outsider, code, 'Outsider', 3);
  const names = ['host', 'p1', 'p2', 'p3'];
  const watchers = Object.fromEntries([host, p1, p2, p3].map((session, index) => [names[index], watch(session, code)]));
  t.after(() => Object.values(watchers).forEach((watcher) => watcher.stop()));
  await watchers.host.until((room) => Object.keys(room.players ?? {}).length === 4, 'host sees four players');
  assert.deepEqual(await startTable(host, code, 2, cards, seededRandom(1)), { started: true });
  await advanceTable(host, code, 2, { round: 1, phase: 'sunrise' });
  const game = await read(host, `rooms/${code}/games/2`);
  const [first, second, third] = seatsInOrder(game.seats).map(([uid]) => [p1, p2, p3].find((session) => session.uid === uid));
  return { code, watchers, first, second, third };
}

// 從這一回合的 from 推進到黑夜（黃昏不開法案），開黑夜、提前揭曉（沒人送出，全員睡覺）、過了緩衝揭曉。
async function nightRevealed(code, round, { from = 'day' } = {}) {
  const phases = ['sunrise', 'day', 'dusk'];
  for (const phase of phases.slice(phases.indexOf(from))) await advanceTable(host, code, 2, { round, phase });
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'opened');
  assert.deepEqual(await revealNight(host, code, 2), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/2/night`);
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'revealed');
}

// 終局時的局面（照 store.js 的讀法）：用來比對 final 的分數。
function endStateOf({ table, game, privates }) {
  const destinies = Object.fromEntries(Object.entries(privates).map(([uid, record]) => [uid, record.destiny ?? null]));
  return { round: table.round, seats: game.seats, destinies, fog: table.fog, fogMax: game.fogMax, bills: game.bills ?? {}, log: game.log ?? {} };
}

// 資料庫不存 null 與空陣列：分數存進去再讀回來的樣子。
const stored = (value) =>
  JSON.parse(JSON.stringify(value), (key, item) => {
    if (item === null) return undefined;
    if (Array.isArray(item) && item.length === 0) return undefined;
    return item;
  });

test('before sunset the night moves on to the next sunrise as usual; once the clock is up it ends the game in one write and shows every destiny', TIMEOUT, async (t) => {
  const { code, watchers, first, second, third } = await dayRoom(t);
  // 出牌紀錄、議會之聲、罪孽：直接寫進局面，看算分有沒有讀到（second 打出過 2 級連鎖、first 有 1 次議會之聲、third 罪孽 3）。
  const v0 = (await read(host, `rooms/${code}/games/2/version`)) ?? 0;
  await update(ref(host.db, `rooms/${code}/games/2`), {
    version: v0 + 1,
    [`log/m9chain`]: { round: 1, by: second.uid, card: fileData.actions[0].id, level: 2, at: serverTimestamp() },
    [`seats/${first.uid}/aligned`]: 1,
    [`seats/${third.uid}/sin`]: 3,
  });
  await nightRevealed(code, 1);
  // 75 分鐘還沒到：照常進第 2 回合日出、發牌。
  const moved = await advanceOrEnd(host, code, 2, { round: 1, phase: 'night' }, data);
  assert.deepEqual([moved.advanced, moved.ended, moved.reason, moved.table.round, moved.table.phase], [true, false, null, 2, 'sunrise']);
  assert.equal((await processSunrise(host, code, 2, data)).dealt, true);
  await nightRevealed(code, 2, { from: 'sunrise' });
  const before = await readTable(code);
  assert.equal(before.deals, 2);
  await assert.rejects(read(first, `private/${code}/${second.uid}`), denied, 'destinies stay private before the end');

  const ended = await advanceOrEnd(host, code, 2, { round: 2, phase: 'night' }, sunset);
  assert.deepEqual([ended.advanced, ended.ended, ended.reason, ended.table.phase], [true, true, 'sunset', 'end']);
  const after = await readTable(code);
  assert.deepEqual([after.table.round, after.table.phase], [2, 'end']);
  assert.equal(after.game.version, before.game.version + 1, 'one write');
  const { final } = after.game;
  assert.deepEqual([final.round, final.reason], [2, 'sunset']);
  assert.ok(Math.abs(final.endedAt - serverTime(host)) < 5000, 'endedAt is the server time');
  assert.deepEqual(final.scores, stored(scoreGame(endStateOf(before), sunset)), 'the scores from the seats, the private destinies, the log and the bills');
  for (const uid of Object.keys(after.game.seats)) {
    const role = after.game.seats[uid].role;
    const index = roleIds.indexOf(role);
    assert.equal(final.scores[uid].destiny.id, before.privates[uid].destiny, 'the destiny dealt to the player');
    assert.deepEqual(final.scores[uid].destiny, { id: `t${index + 1}`, text: `測試天命 ${index + 1}`, done: index < 3, points: 10 });
  }
  assert.deepEqual(final.scores[second.uid].achievements, ['gear'], 'the gear master from the log');
  assert.ok(final.scores[first.uid].achievements.includes('parliament'));
  assert.deepEqual([final.scores[third.uid].sin, final.scores[third.uid].sinPenalty], [3, 1]);
  // 這一筆不做日出：沒有發牌、手牌與牌庫不動。
  assert.equal(after.deals, 2);
  assert.deepEqual(after.pile, before.pile);
  for (const uid of Object.keys(after.privates)) assert.deepEqual(after.privates[uid].hand, before.privates[uid].hand);
  // 四個畫面不重新整理就看到，玩家也看得到別人的天命。
  for (const name of ['host', 'p1', 'p2', 'p3']) await watchers[name].until((room) => room.games[2].final?.scores && room.tables[2].phase === 'end', `${name} sees the final scores`);
  assert.equal(watchers.p1.value.games[2].final.scores[second.uid].destiny.id, before.privates[second.uid].destiny);
});

test('round 12 is the last: its night ends the game, and a night that is not revealed yet cannot end it', TIMEOUT, async (t) => {
  const { code } = await dayRoom(t);
  for (let round = 1; round <= 11; round += 1) {
    for (const phase of ['day', 'dusk']) await advanceTable(host, code, 2, { round, phase });
    const moved = await advanceOrEnd(host, code, 2, { round, phase: 'night' }, data);
    assert.deepEqual([moved.ended, moved.table.round, moved.table.phase], [false, round + 1, 'sunrise'], `round ${round}`);
    await advanceTable(host, code, 2, { round: round + 1, phase: 'sunrise' });
  }
  for (const phase of ['day', 'dusk']) await advanceTable(host, code, 2, { round: 12, phase });
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'opened');
  await assert.rejects(advanceOrEnd(host, code, 2, { round: 12, phase: 'night' }, data), { name: 'StoreError', code: 'night-not-revealed' });
  assert.deepEqual([(await read(host, `rooms/${code}/tables/2/phase`)), (await read(host, `rooms/${code}/games/2/final`))], ['night', null]);
  assert.deepEqual(await revealNight(host, code, 2), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/2/night`);
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'revealed');
  const ended = await advanceOrEnd(host, code, 2, { round: 12, phase: 'night' }, data);
  assert.deepEqual([ended.ended, ended.reason], [true, 'maxRounds']);
  const final = await read(host, `rooms/${code}/games/2/final`);
  assert.deepEqual([final.round, final.reason, Object.keys(final.scores).length], [12, 'maxRounds', 3]);
});

test('the host ends after this round or cancels it; only the host writes it, and only for the current round', TIMEOUT, async (t) => {
  const { code, watchers, first } = await dayRoom(t);
  const version = async () => read(host, `rooms/${code}/games/2/version`);
  const v1 = await version();
  assert.deepEqual(await setEndAfterRound(host, code, 2, true), { endAfterRound: 1 });
  assert.equal(await version(), v1 + 1);
  await watchers.p1.until((room) => room.games[2].endAfterRound === 1, 'the players see the last round');
  assert.deepEqual(await setEndAfterRound(host, code, 2, true), { endAfterRound: 1 }, 'pressed twice');
  assert.equal(await version(), v1 + 1, 'nothing written the second time');
  assert.deepEqual(await setEndAfterRound(host, code, 2, false), { endAfterRound: null });
  assert.equal(await read(host, `rooms/${code}/games/2/endAfterRound`), null, 'cancel removes it');
  assert.equal(await version(), v1 + 2);
  // 規則：玩家不能寫；主持端只能寫目前的回合、整數；沒帶 version 不行。
  const now = await version();
  await assert.rejects(update(ref(first.db, `rooms/${code}/games/2`), { endAfterRound: 1, version: now + 1 }), denied);
  await assert.rejects(update(ref(host.db, `rooms/${code}/games/2`), { endAfterRound: 2, version: now + 1 }), denied, 'not the current round');
  await assert.rejects(update(ref(host.db, `rooms/${code}/games/2`), { endAfterRound: 1.5, version: now + 1 }), denied);
  await assert.rejects(update(ref(host.db, `rooms/${code}/games/2`), { endAfterRound: '1', version: now + 1 }), denied);
  await assert.rejects(update(ref(host.db, `rooms/${code}/games/2`), { endAfterRound: 1 }), denied, 'without version');
  // 取消了：第 1 回合照常進第 2 回合。
  await nightRevealed(code, 1);
  const moved = await advanceOrEnd(host, code, 2, { round: 1, phase: 'night' }, data);
  assert.deepEqual([moved.ended, moved.table.round], [false, 2]);
  assert.equal((await processSunrise(host, code, 2, data)).dealt, true);
  // 第 2 回合按下去：這一回合黑夜結束就算分。
  assert.deepEqual(await setEndAfterRound(host, code, 2, true), { endAfterRound: 2 });
  await nightRevealed(code, 2, { from: 'sunrise' });
  const ended = await advanceOrEnd(host, code, 2, { round: 2, phase: 'night' }, data);
  assert.deepEqual([ended.ended, ended.reason], [true, 'host']);
  assert.deepEqual([await read(host, `rooms/${code}/games/2/final/round`), await read(host, `rooms/${code}/games/2/final/reason`)], [2, 'host']);
  await assert.rejects(setEndAfterRound(host, code, 2, false), { name: 'StoreError', code: 'game-over' });
});

// 第 1 回合按「這回合結束後算分」、黑夜揭曉後算分，回傳房間。
async function endedRoom(t, cards = data) {
  const room = await dayRoom(t, cards);
  await setEndAfterRound(host, room.code, 2, true);
  await nightRevealed(room.code, 1);
  const ended = await advanceOrEnd(host, room.code, 2, { round: 1, phase: 'night' }, cards);
  assert.equal(ended.ended, true);
  return room;
}

test('after the end nothing moves: no next phase, no automatic night or dusk, no request handled, and players cannot write the final', TIMEOUT, async (t) => {
  const { code, first, second } = await dayRoom(t);
  await setEndAfterRound(host, code, 2, true);
  // 最後一回合的黃昏翻了法案、提前截止，還沒揭曉就被推進到黑夜（畫面擋、規則不擋）：終局後自動化也不能去揭曉它。
  await advanceTable(host, code, 2, { round: 1, phase: 'day' });
  assert.equal((await settleDusk(host, code, 2, data)).outcome, 'opened');
  assert.deepEqual(await revealDusk(host, code, 2), { closed: true });
  await advanceTable(host, code, 2, { round: 1, phase: 'dusk' });
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'opened');
  assert.deepEqual(await revealNight(host, code, 2), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/2/night`);
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'revealed');
  assert.equal((await advanceOrEnd(host, code, 2, { round: 1, phase: 'night' }, data)).ended, true);
  const before = await readTable(code);
  assert.ok(before.game.dusk.revealAt && !before.game.dusk.result, 'the dusk is still waiting for its reveal');
  assert.deepEqual((await advanceTable(host, code, 2, { round: 1, phase: 'end' })).advanced, false);
  assert.deepEqual((await advanceOrEnd(host, code, 2, { round: 1, phase: 'end' }, data)).advanced, false);
  assert.deepEqual((await advanceOrEnd(host, code, 2, { round: 1, phase: 'night' }, data)).advanced, false, 'a host still showing the night');
  // 規則：終局後階段與回合都不能改（主持端也不行）。
  await assert.rejects(update(ref(host.db, `rooms/${code}/tables/2`), { phase: 'sunrise', round: 2 }), denied);
  await assert.rejects(update(ref(host.db, `rooms/${code}/tables/2`), { phase: 'night' }), denied);
  await assert.rejects(update(ref(host.db, `rooms/${code}/tables/2`), { round: 2 }), denied);
  await assert.rejects(set(ref(host.db, `rooms/${code}/tables/2`), { round: 2, phase: 'sunrise', fog: 0, updatedAt: serverTimestamp() }), denied);
  assert.deepEqual(await update(ref(host.db, `rooms/${code}/tables/2`), { updatedAt: serverTimestamp() }), undefined, 'the time stamp alone is fine');
  // 自動化開著：不揭曉黃昏、不開黑夜、不處理請求、不報錯。
  const errorsSeen = [];
  const stop = startSettling(host, code, data, { onError: (error) => errorsSeen.push(error) });
  t.after(stop);
  await requestPass(first, code);
  await sleep(2000);
  const afterwards = await readTable(code);
  assert.equal(afterwards.game.version, before.game.version, 'nothing written');
  assert.equal(afterwards.game.dusk.result, undefined);
  assert.equal(afterwards.game.lastSeq?.[first.uid], before.game.lastSeq?.[first.uid]);
  assert.equal(await read(first, `private/${code}/${first.uid}/notice`), null);
  assert.deepEqual(errorsSeen, []);
  assert.deepEqual(await settleNight(host, code, 2, data), { outcome: 'none', result: null });
  assert.deepEqual(await settleDusk(host, code, 2, data), { outcome: 'none', result: null });
  // 玩家讀得到 final、寫不了。
  const final = await read(first, `rooms/${code}/games/2/final`);
  assert.equal(final.round, 1);
  const version = afterwards.game.version;
  await assert.rejects(update(ref(first.db, `rooms/${code}/games/2`), { version: version + 1, 'final/reason': 'sunset' }), denied);
  await assert.rejects(update(ref(first.db, `rooms/${code}/games/2/final/scores/${first.uid}`), { total: 99 }), denied);
  await assert.rejects(update(ref(first.db, `rooms/${code}/games/2`), { version: version + 1, [`final/scores/${second.uid}/destiny/done`]: false }), denied);
  await assert.rejects(set(ref(first.db, `rooms/${code}/games/2/final`), null), denied);
  assert.deepEqual(await read(host, `rooms/${code}/games/2/final`), final);
});

test('a one-field update cannot get around the final rules, and the final can only come with the end of a revealed night', TIMEOUT, async (t) => {
  const { code, first, second } = await dayRoom(t);
  const seated = Object.keys(await read(host, `rooms/${code}/games/2/seats`));
  const score = { destiny: { id: 't1', text: '測試天命 1', points: 10 }, assets: { pounds: 5, influence: 1, points: 1 }, sin: 0, sinPenalty: 0, total: 1, rank: 1 };
  const scores = (changes = {}) => ({ ...Object.fromEntries(seated.map((uid) => [uid, score])), ...changes });
  const final = (extra = {}) => ({ round: 1, reason: 'host', endedAt: serverTimestamp(), scores: scores(), ...extra });
  const writes = (changes) => update(ref(host.db), changes);
  const version = async () => read(host, `rooms/${code}/games/2/version`);
  const ending = async (changes = {}) => ({
    [`rooms/${code}/tables/2/phase`]: 'end',
    [`rooms/${code}/tables/2/updatedAt`]: serverTimestamp(),
    [`rooms/${code}/games/2/version`]: (await version()) + 1,
    [`rooms/${code}/games/2/final`]: final(),
    ...changes,
  });
  // 只能從黑夜、而且黑夜揭曉之後才能終局。
  await assert.rejects(writes(await ending()), denied, 'not from the day');
  for (const phase of ['day', 'dusk']) await advanceTable(host, code, 2, { round: 1, phase });
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'opened');
  await assert.rejects(writes(await ending()), denied, 'the night is not revealed yet');
  assert.deepEqual(await revealNight(host, code, 2), { closed: true });
  const { revealAt } = await read(host, `rooms/${code}/games/2/night`);
  await untilServerTime(host, nightSettleAt({ revealAt }) + 50);
  assert.equal((await settleNight(host, code, 2, data)).outcome, 'revealed');
  // final 要跟 phase＝end 一起寫；phase＝end 也要跟 final 一起寫；每個欄位的格式。
  const v = await version();
  await assert.rejects(writes({ [`rooms/${code}/games/2/version`]: v + 1, [`rooms/${code}/games/2/final`]: final() }), denied, 'final without the end');
  await assert.rejects(writes({ [`rooms/${code}/tables/2/phase`]: 'end', [`rooms/${code}/tables/2/updatedAt`]: serverTimestamp() }), denied, 'the end without a final');
  const finalWith = async (extra) => writes(await ending({ [`rooms/${code}/games/2/final`]: final(extra) }));
  await assert.rejects(finalWith({ round: 2 }), denied, 'another round');
  await assert.rejects(finalWith({ endedAt: 1000 }), denied, 'a made-up time');
  await assert.rejects(finalWith({ reason: 'bored' }), denied, 'an unknown reason');
  await assert.rejects(finalWith({ extra: 1 }), denied, 'an extra field');
  await assert.rejects(finalWith({ scores: scores({ [outsider.uid]: score }) }), denied, 'not seated');
  await assert.rejects(writes(await ending({ [`rooms/${code}/games/2/final`]: { round: 1, reason: 'host', endedAt: serverTimestamp() } })), denied, 'no scores');
  for (const [label, bad] of [
    ['rank 0', { ...score, rank: 0 }],
    ['total 1.5', { ...score, total: 1.5 }],
    ['negative pounds', { ...score, assets: { ...score.assets, pounds: -1 } }],
    ['done is a word', { ...score, destiny: { ...score.destiny, done: 'yes' } }],
    ['an id without text', { ...score, destiny: { id: 't1', points: 10 } }],
    ['unknown achievement', { ...score, achievements: ['luck'] }],
    ['extra field', { ...score, bonus: 3 }],
    ['no total', { destiny: score.destiny, assets: score.assets, sin: 0, sinPenalty: 0, rank: 1 }],
  ]) {
    await assert.rejects(finalWith({ scores: scores({ [first.uid]: bad }) }), denied, label);
  }
  await assert.rejects(writes(await ending({ [`rooms/${code}/tables/2/round`]: 2, [`rooms/${code}/games/2/final`]: final({ round: 2 }) })), denied, 'the round moves with the end');
  await assert.rejects(writes({ ...(await ending()), [`rooms/${code}/games/2/version`]: v + 2 }), denied, 'version +2');
  // 合法的一筆照收。
  await finalWith({ scores: scores({ [first.uid]: { ...score, achievements: ['parliament', 'gear'] } }) });
  const saved = await read(host, `rooms/${code}/games/2/final`);
  assert.deepEqual([saved.reason, (await read(host, `rooms/${code}/tables/2/phase`))], ['host', 'end']);
  // 之後只改一個欄位：回合、原因、時間、算好的分數都改不了；只有天命的勾選、總分、名次可以改。
  const now = v + 1;
  const field = (path, value, step = 1) => writes({ [`rooms/${code}/games/2/version`]: now + step, [`rooms/${code}/games/2/final/${path}`]: value });
  for (const [path, value] of [
    ['reason', 'sunset'],
    ['round', 2],
    ['endedAt', saved.endedAt - 1],
    [`scores/${first.uid}/assets/points`, 9],
    [`scores/${first.uid}/assets/pounds`, 9],
    [`scores/${first.uid}/sin`, 9],
    [`scores/${first.uid}/sinPenalty`, 9],
    [`scores/${first.uid}/destiny/id`, 't2'],
    [`scores/${first.uid}/destiny/text`, '換一張'],
    [`scores/${first.uid}/destiny/points`, 99],
    [`scores/${first.uid}/achievements/0`, 'gear'],
    [`scores/${first.uid}/achievements`, null],
    [`scores/${second.uid}/achievements`, ['gear']],
    [`scores/${first.uid}/rank`, 0],
    [`scores/${first.uid}/total`, 1.5],
    [`scores/${first.uid}/destiny/done`, 'yes'],
    [`scores/${first.uid}/extra`, 1],
    [`scores/${outsider.uid}`, score],
    ['extra', 1],
  ]) {
    await assert.rejects(field(path, value), denied, path);
  }
  await assert.rejects(writes({ [`rooms/${code}/games/2/version`]: now + 1, [`rooms/${code}/games/2/final`]: null }), denied, 'the final cannot be removed');
  await assert.rejects(writes({ [`rooms/${code}/games/2/final/scores/${first.uid}/destiny/done`]: true }), denied, 'without version');
  await field(`scores/${first.uid}/destiny/done`, true);
  await writes({ [`rooms/${code}/games/2/version`]: now + 2, [`rooms/${code}/games/2/final/scores/${first.uid}/total`]: 11, [`rooms/${code}/games/2/final/scores/${first.uid}/rank`]: 2 });
  await field(`scores/${first.uid}/destiny/done`, null, 3);
  assert.deepEqual(await read(host, `rooms/${code}/games/2/final/scores/${first.uid}`), { ...score, achievements: ['parliament', 'gear'], total: 11, rank: 2 });
});

test('the host judges a blank destiny: the total and the ranks change on every screen, and it can be undone', TIMEOUT, async (t) => {
  const cards = { ...data, destinies: blank };
  const { code, watchers, first, second } = await endedRoom(t, cards);
  const start = await read(host, `rooms/${code}/games/2/final`);
  for (const score of Object.values(start.scores)) assert.equal(score.destiny.done, undefined, 'waiting for the host');
  const version = await read(host, `rooms/${code}/games/2/version`);
  assert.deepEqual(await judgeDestiny(host, code, 2, first.uid, true), { changed: true });
  const yes = await read(host, `rooms/${code}/games/2/final`);
  assert.deepEqual(yes.scores, stored(judgeScores(start.scores, first.uid, true)));
  assert.equal(yes.scores[first.uid].total, start.scores[first.uid].total + 10);
  assert.equal(yes.scores[first.uid].rank, 1);
  assert.deepEqual([yes.round, yes.reason, yes.endedAt], [start.round, start.reason, start.endedAt]);
  assert.equal(await read(host, `rooms/${code}/games/2/version`), version + 1);
  await watchers.p2.until((room) => room.games[2].final.scores[first.uid].destiny.done === true, 'the players see the judgement');
  assert.deepEqual(await judgeDestiny(host, code, 2, first.uid, true), { changed: false }, 'already done');
  assert.deepEqual(await judgeDestiny(host, code, 2, second.uid, false), { changed: true });
  assert.deepEqual(await judgeDestiny(host, code, 2, first.uid, false), { changed: true });
  const no = await read(host, `rooms/${code}/games/2/final`);
  assert.deepEqual([no.scores[first.uid].destiny.done, no.scores[first.uid].total], [false, start.scores[first.uid].total]);
  assert.deepEqual(no.scores, stored(judgeScores(judgeScores(start.scores, second.uid, false), first.uid, false)));
  assert.deepEqual(await judgeDestiny(host, code, 2, first.uid, null), { changed: true });
  assert.equal(await read(host, `rooms/${code}/games/2/final/scores/${first.uid}/destiny/done`), null, 'back to waiting');
  assert.equal(await read(host, `rooms/${code}/games/2/version`), version + 4);
  await assert.rejects(update(ref(second.db, `rooms/${code}/games/2`), { version: version + 5, [`final/scores/${second.uid}/destiny/done`]: true }), denied, 'a player cannot judge');
});

test('two hosts ending at once write only once', TIMEOUT, async (t) => {
  const { code } = await dayRoom(t);
  await enterAsHost(backup, code);
  await approveHost(host, code, backup.uid);
  await nightRevealed(code, 1);
  const before = await readTable(code);
  const results = await Promise.all([host, backup].map((session) => advanceOrEnd(session, code, 2, { round: 1, phase: 'night' }, sunset)));
  assert.deepEqual(results.map((result) => result.ended).sort(), [false, true]);
  assert.deepEqual(results.map((result) => result.advanced).sort(), [false, true]);
  const after = await readTable(code);
  assert.equal(after.game.version, before.game.version + 1, 'one write');
  assert.deepEqual([after.table.phase, after.game.final.reason, after.deals], ['end', 'sunset', 1]);
});
