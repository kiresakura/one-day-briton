// 湊人數機器人（scripts/bots/，用法見 docs/BOTS.md）的測試：指令列參數、入座前的安排、機器人的選擇、只用玩家端函式；
// 模擬器上由測試當主持端（開房、開局、自動結算、照「下一階段」推進、開第 2 場），放 3 個與 5 個機器人（動作間隔同 --fast），
// 兩場都跑到終局、算出分數；主持端退回的請求由機器人自己吸收；指令列在房間不存在或已經開局時什麼都不寫（npm run test:sync）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { combineScores, dayStatus, duskStage, nightStage, overLimit, seededRandom } from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';
import { MATCH_COUNT, activeKey, matchKey, parseKey } from '../../play/js/rules.js';
import {
  advanceOrEnd,
  advanceTable,
  connect,
  createRoom,
  disconnect,
  joinRoom,
  openMatch,
  processSunrise,
  startSettling,
  startTable,
  watchRoom,
} from '../../play/js/store.js';
import { ArgsError, DEFAULT_DELAY, DEFAULT_PREFIX, FAST_DELAY, parseArgs } from '../../scripts/bots/args.mjs';
import { startBot } from '../../scripts/bots/bot.mjs';
import { chooseDiscard, chooseNight, chooseVote, playOptions, responseOptions } from '../../scripts/bots/brain.mjs';
import { PlanError, planSeats } from '../../scripts/bots/plan.mjs';

const GAME_TIMEOUT = { timeout: 240_000 };
const TIMEOUT = { timeout: 30_000 };
const cardDir = new URL('../../play/data/', import.meta.url);
const { data: fileData, errors } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
assert.deepEqual(errors, []);
// 跑得快的設定：每場 2 回合、每輪最多出 2 張、響應窗口 1 秒、黃昏與黑夜全員送出就揭曉；手牌上限 2 張，第 1 回合黑夜就有人要棄牌。
const quick = {
  ...fileData,
  settings: { ...fileData.settings, maxRounds: 2, maxPlaysPerTurn: 2, responseSeconds: 1, duskRevealSeconds: 0, nightRevealSeconds: 0, handLimit: 2 },
};
// 不開響應窗口（出牌當下就結算）。
const instant = { ...quick, settings: { ...quick.settings, responseSeconds: 0 } };
// 主持端的卡牌資料裡一般牌都還沒做好（todo）：機器人照自己的資料出牌，每一張都會被主持端退回。
const allTodo = { ...instant, actions: instant.actions.map((action) => (action.kind === 'play' ? { ...action, todo: true } : action)) };

let host;
let person;

before(async () => {
  [host, person] = await Promise.all(['host', 'person'].map((slot) => connect(slot)));
});

after(async () => {
  await Promise.all([host, person].filter(Boolean).map(disconnect));
});

// 讀一次房間的資料（watchRoom 的第一筆）。
function roomOnce(session, code) {
  return new Promise((resolve, reject) => {
    const stop = watchRoom(
      session,
      code,
      (room) => {
        queueMicrotask(() => stop());
        resolve(room);
      },
      reject,
    );
  });
}

// ---- 指令列參數 ----

test('the arguments: defaults, --fast over --delay, and plain messages for bad values', () => {
  const plain = parseArgs(['--room', 'ABCDEF']);
  assert.deepEqual(parseArgs(['--room', 'abc def']), plain, 'spaces and lower case are tidied like the join form');
  assert.deepEqual(plain, { help: false, room: 'ABCDEF', count: null, table: null, delay: DEFAULT_DELAY, emulator: false, prefix: DEFAULT_PREFIX, waitMinutes: 20 });
  const full = parseArgs(['--room=ABCDEF', '--count', '5', '--table', '2', '--delay', '200-300', '--emulator', '--name-prefix', ' Bot ', '--wait', '1.5']);
  assert.deepEqual(full, { help: false, room: 'ABCDEF', count: 5, table: 2, delay: [200, 300], emulator: true, prefix: 'Bot', waitMinutes: 1.5 });
  assert.deepEqual(parseArgs(['--room', 'ABCDEF', '--delay', '800']).delay, [800, 800]);
  assert.deepEqual(parseArgs(['--room', 'ABCDEF', '--delay', '200-300', '--fast']).delay, FAST_DELAY);
  assert.deepEqual(parseArgs(['--help']), { help: true });
  const bad = (argv, pattern) => assert.throws(() => parseArgs(argv), (error) => error instanceof ArgsError && pattern.test(error.message), argv.join(' '));
  bad([], /--room/);
  bad(['--room', 'ABC0EF'], /6 碼/);
  bad(['--room', 'ABCDEF', '--count', '0'], /--count/);
  bad(['--room', 'ABCDEF', '--table', '7'], /--table/);
  bad(['--room', 'ABCDEF', '--delay', '5-1'], /最少不能大於最多/);
  bad(['--room', 'ABCDEF', '--delay', 'fast'], /--delay/);
  bad(['--room', 'ABCDEF', '--wait', '0'], /--wait/);
  bad(['--room', 'ABCDEF', '--name-prefix', '  '], /--name-prefix/);
  bad(['--room', 'ABCDEF', '--bogus'], /看不懂的參數/);
  bad(['--room'], /少了值/);
});

// ---- 入座前的安排 ----

const meta = (tableCount = 3) => ({ hostUid: 'h', createdAt: 1, tableCount });
const players = (...entries) => Object.fromEntries(entries.map(([uid, name, table]) => [uid, { name, table, joinedAt: 1 }]));
const plan = (room, options = {}) => planSeats(room, fileData, { prefix: '機器人', ...options });
const refused = (room, options, pattern) => assert.throws(() => plan(room, options), (error) => error instanceof PlanError && pattern.test(error.message));

test('the seating plan picks the open table with the fewest players and fills it to the suggested three', () => {
  refused(null, {}, /找不到這個房間/);
  const room = { meta: meta(3), players: players(['a', '小明', 1], ['b', '小華', 1], ['c', '阿美', 2]) };
  assert.deepEqual(plan(room), { table: 3, names: ['機器人1', '機器人2', '機器人3'], notes: ['沒有指定桌號，選第 3 桌（還沒開局、人最少的一桌）', '第 3 桌現在 0 人，補 3 個機器人到建議的開局人數（3 人）'] });
  assert.deepEqual(plan(room, { table: 1 }).names, ['機器人1'], 'two people there already');
  // 開局了的桌、開了第 2 場的桌都不收；剩下的照人數挑。
  const started = { ...room, games: { 3: { seats: {} } }, tables: { '1-2': { round: 1, phase: 'sunrise' } } };
  assert.equal(plan(started).table, 2);
  refused(started, { table: 3 }, /第 3 桌已經開局/);
  refused(started, { table: 1 }, /第 1 桌已經開了第 2 場/);
  refused(room, { table: 4 }, /只有 3 桌/);
  refused({ meta: meta(1), players: players(['a', '小明', 1], ['b', '小華', 1], ['c', '阿美', 1]) }, {}, /到了建議的開局人數/);
  refused({ meta: meta(1), games: { 1: { seats: {} } } }, {}, /沒有可以加入的桌/);
});

test('the seating plan stops at six a table, says why, and skips names already in the room', () => {
  const four = players(['a', '機器人1', 1], ['b', '機器人2', 1], ['c', '小明', 1], ['d', '機器人4', 2]);
  const result = plan({ meta: meta(2), players: four }, { table: 1, count: 5 });
  assert.deepEqual(result.names, ['機器人3', '機器人5', '機器人6'], 'three seats left, names not taken yet');
  assert.match(result.notes.at(-1), /只放得下 3 個（要放 5 個）/);
  const six = players(...['a', 'b', 'c', 'd', 'e', 'f'].map((uid) => [uid, uid, 1]));
  refused({ meta: meta(1), players: six }, { count: 1 }, /沒有可以加入的桌/);
  refused({ meta: meta(1), players: six }, { table: 1, count: 1 }, /已經坐滿 6 人/);
  assert.deepEqual(planSeats({ meta: meta(1) }, fileData, { prefix: '十'.repeat(11), count: 1 }).names, [`${'十'.repeat(11)}1`], 'twelve fits');
  assert.throws(() => planSeats({ meta: meta(1) }, fileData, { prefix: '十'.repeat(12), count: 1 }), (error) => error instanceof PlanError && /超過 12 個字/.test(error.message));
});

// ---- 機器人的選擇（只挑規則允許的） ----

test('the choices are legal: cards it can afford, responses that fit, votes within its influence, and exactly the cards over the limit', () => {
  const random = seededRandom(7);
  const [cheap, dear, answer] = ['a01', 'a02', 'a23'].map((id) => fileData.actions.find((action) => action.id === id));
  assert.deepEqual([cheap.cost.pounds, dear.cost.pounds, answer.kind, answer.respondsTo], [2, 5, 'response', ['犯罪']]);
  const seats = { me: { order: 0, role: 'r1', pounds: 3, influence: 2, handCount: 3 }, you: { order: 1, role: 'r2', pounds: 9, influence: 1, handCount: 0 } };
  const view = { round: 1, phase: 'day', seats, startOrder: 0, turn: null, pending: null, hands: { me: ['a01', 'a02', 'a23'] } };
  assert.deepEqual(playOptions(view, 'me', fileData, { random }).map(({ card }) => card), ['a01'], 'only the one it can pay for; a response card is not played');
  assert.deepEqual(playOptions(view, 'me', fileData, { skip: new Set(['a01']), random }), [], 'a card sent back this turn is skipped');
  assert.deepEqual(playOptions(view, 'you', fileData, { random }), [], 'not its turn');
  const crime = fileData.actions.find((action) => action.category === '犯罪' && action.kind === 'play');
  const pending = { id: 'p1', by: 'you', card: crime.id, openedAt: 1000, seconds: 5 };
  assert.deepEqual(responseOptions({ ...view, pending }, 'me', fileData, 2000), ['a23']);
  assert.deepEqual(responseOptions({ ...view, pending }, 'me', fileData, 7000), [], 'too late');
  assert.deepEqual(responseOptions({ ...view, pending: { ...pending, card: 'a01' } }, 'me', fileData, 2000), [], 'a23 answers crimes only');
  const dusk = { table: '1', round: 1, phase: 'dusk', seats, dusk: { round: 1, bill: 'b01', submitted: 0, openedAt: 500 } };
  for (let index = 0; index < 50; index += 1) {
    const vote = chooseVote(dusk, 'me', 1000, { random });
    assert.ok(vote.side === 'abstain' ? vote.bid === 0 : vote.bid >= 0 && vote.bid <= 2, JSON.stringify(vote));
  }
  assert.equal(chooseVote({ ...dusk, phase: 'night' }, 'me', 1000, { random }), null, 'not while the vote is closed');
  const night = { table: '1-2', round: 2, phase: 'night', seats, night: { round: 2, submitted: 0, openedAt: 500 } };
  for (let index = 0; index < 30; index += 1) {
    const pick = chooseNight(night, 'me', 1000, { random });
    assert.equal(pick.table, '1-2');
    assert.ok(pick.choice === 'gamble' ? [1, 2, 3].includes(pick.tiers) : pick.tiers === null, JSON.stringify(pick));
  }
  const hand = ['a01', 'a01', 'a02', 'a03', 'a05', 'a23'];
  const cards = chooseDiscard(hand, { table: '1', round: 1 }, quick.settings, { random });
  assert.equal(cards.length, 4);
  assert.equal(overLimit(hand, quick.settings), 4);
  assert.equal(chooseDiscard(hand.slice(0, 2), { table: '1', round: 1 }, quick.settings, { random }), null, 'not over the limit');
});

// 機器人只能用玩家端的函式：scripts/bots/ 底下從 store.js 拿的名字（靜態匯入，與動態匯入後的 store.xxx(…) 呼叫）都要在這張表上。
test('the bots use player functions of the store only', async () => {
  const player = new Set([
    'StoreError',
    'connect',
    'disconnect',
    'joinRoom',
    'serverTime',
    'trackPresence',
    'watchConnection',
    'watchRoom',
    'watchPrivate',
    'watchRequest',
    'watchVote',
    'watchNight',
    'watchDiscard',
    'requestPlay',
    'requestPass',
    'requestRespond',
    'requestVote',
    'requestNight',
    'requestDiscard',
  ]);
  const dir = new URL('../../scripts/bots/', import.meta.url);
  const used = new Set();
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.mjs'))) {
    const source = await readFile(new URL(file, dir), 'utf8');
    for (const [, names] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[./]*play\/js\/store\.js'/g)) {
      for (const name of names.split(',').map((item) => item.trim()).filter(Boolean)) used.add(name);
    }
    for (const [, name] of source.matchAll(/\bstore\.(\w+)\(/g)) used.add(name);
  }
  assert.ok(used.has('requestPlay') && used.has('watchRoom') && used.has('connect'), 'the scan finds the imports');
  assert.deepEqual([...used].filter((name) => !player.has(name)), []);
});

// ---- 模擬器上跑完整的兩場 ----

// 測試當主持端：startSettling 自動結算，另外照主持畫面的「下一階段」推進：日出發完牌 → 白晝；大家都出完 → 黃昏；黃昏揭曉
// （或休會）→ 黑夜；黑夜揭曉 → 下一回合日出（再發牌）或終局；第 1 場終局 → 開第 2 場、開局。第 2 場終局時 done 拿到房間。
// 20 秒都沒有進展就把卡在哪裡寫進錯誤（不讓測試白等到逾時）。
function autoHost(session, code, table, data, random) {
  const errorsSeen = [];
  const stopSettling = startSettling(session, code, data, { random, onError: (error) => errorsSeen.push(error) });
  let room = null;
  let busy = false;
  let again = false;
  let stopped = false;
  let finish;
  let fail;
  const done = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // 這一刻主持端該按的那一下；沒有要做的回傳 false。
  const act = async (latest) => {
    const key = activeKey(latest, table);
    const state = latest.tables?.[key];
    const game = latest.games?.[key];
    if (!state) return false;
    if (!game) {
      if (parseKey(key).match === 1) return false; // 第 1 場由測試開局
      await startTable(session, code, key, data, random);
      return true;
    }
    const expected = { round: state.round, phase: state.phase };
    if (state.phase === 'sunrise') {
      if ((latest.deals?.[key] ?? 0) < state.round) await processSunrise(session, code, key, data, random);
      else await advanceTable(session, code, key, expected);
      return true;
    }
    if (state.phase === 'day') {
      if (game.pending || !dayStatus(game, state.round).done) return false;
      await advanceTable(session, code, key, expected);
      return true;
    }
    if (state.phase === 'dusk') {
      if (!['revealed', 'adjourned'].includes(duskStage(game.dusk, state.round))) return false;
      await advanceTable(session, code, key, expected);
      return true;
    }
    if (state.phase === 'night') {
      if (nightStage(game.night, state.round) !== 'revealed') return false;
      await advanceOrEnd(session, code, key, expected, data);
      return true;
    }
    if (!game.final) return false;
    if (parseKey(key).match < MATCH_COUNT) {
      await openMatch(session, code, table);
      return true;
    }
    finish(latest);
    return false;
  };
  const step = async () => {
    if (stopped || !room) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        await act(room);
      } while (again && !stopped);
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  };
  let lastChange = Date.now();
  const stopRoom = watchRoom(session, code, (value) => {
    room = value;
    lastChange = Date.now();
    step();
  });
  const timer = setInterval(() => {
    step();
    if (Date.now() - lastChange < 20_000 || !room) return;
    const key = activeKey(room, table);
    const state = room.tables?.[key];
    const game = room.games?.[key];
    fail(new Error(`stuck at ${key} round ${state?.round} ${state?.phase}: ${JSON.stringify({ turn: game?.turn, pending: game?.pending, dusk: game?.dusk, night: game?.night })}`));
  }, 500);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    stopRoom();
    stopSettling();
  };
  done.then(stop, stop);
  return { done, stop, errors: errorsSeen };
}

// 開一個 2 桌的房間，先讓一位真人坐第 1 桌，再照指令列的做法排座位（沒指定桌號：選第 2 桌）、放機器人，測試當主持端開局、
// 一路主持到第 2 場終局。botData 是機器人用的卡牌資料（沒給就跟主持端一樣）。
async function playBots(t, { count, data, botData = data, policy, seed }) {
  const code = await createRoom(host, 2);
  await joinRoom(person, code, '真人', 1);
  const seating = planSeats(await roomOnce(host, code), botData, { count, prefix: DEFAULT_PREFIX });
  assert.equal(seating.table, 2, 'the table without people');
  const sessions = await Promise.all(seating.names.map((_, index) => connect(`bot-${code}-${index + 1}`)));
  const lines = [];
  const finals = [];
  const bots = await Promise.all(
    seating.names.map((name, index) =>
      startBot({
        session: sessions[index],
        code,
        name,
        table: seating.table,
        data: botData,
        delay: FAST_DELAY,
        policy,
        random: seededRandom(seed * 10 + index),
        log: (line) => lines.push(line),
        onFinal: (_, key) => finals.push(key),
      }),
    ),
  );
  t.after(() => Promise.all(bots.map((bot) => bot.stop())));
  const hosting = autoHost(host, code, seating.table, data, seededRandom(seed));
  t.after(hosting.stop);
  const joined = await roomOnce(host, code);
  bots.forEach((bot, index) => assert.deepEqual([joined.players[bot.uid].name, joined.players[bot.uid].table], [seating.names[index], seating.table]));
  assert.deepEqual(await startTable(host, code, seating.table, data, seededRandom(seed)), { started: true });
  const [room, results] = await Promise.all([hosting.done, Promise.all(bots.map((bot) => bot.done))]);
  return { code, table: seating.table, uids: bots.map((bot) => bot.uid), room, results, lines, finals, hostErrors: hosting.errors };
}

// 兩場都終局、每個機器人兩場都有分數、兩場合計列得出來；每個機器人都自己結束（兩場都結束了）並斷線。
function assertBothMatches({ room, table, uids, results, finals }) {
  for (const key of [matchKey(table), matchKey(table, MATCH_COUNT)]) {
    assert.equal(room.tables[key].phase, 'end', `${key} ended`);
    assert.deepEqual(Object.keys(room.games[key].final.scores).sort(), [...uids].sort(), `${key} scored every bot`);
    for (const uid of uids) assert.ok(Number.isInteger(room.games[key].final.scores[uid].total), `${key} total of ${uid}`);
  }
  const combined = combineScores(room.games[matchKey(table)].final, room.games[matchKey(table, MATCH_COUNT)].final, room.games[matchKey(table)].seats);
  assert.deepEqual(Object.keys(combined).sort(), [...uids].sort());
  for (const uid of uids) assert.equal(combined[uid].absent, false);
  assert.deepEqual(results.map((result) => result.reason), uids.map(() => 'done'));
  assert.deepEqual([...new Set(finals)].sort(), [matchKey(table), matchKey(table, MATCH_COUNT)].sort());
}

const total = (results, field) => results.reduce((sum, result) => sum + result.stats[field], 0);

test('three bots play both matches to the end with response windows, answering whenever they can', GAME_TIMEOUT, async (t) => {
  const game = await playBots(t, { count: null, data: quick, policy: { respondChance: 1 }, seed: 3 });
  assert.equal(game.uids.length, 3, 'filled to the suggested three');
  assertBothMatches(game);
  assert.ok(total(game.results, 'plays') + total(game.results, 'passes') > 0);
  assert.ok(total(game.results, 'votes') > 0 && total(game.results, 'nights') > 0);
  // 第 1 回合黑夜手牌超過 4 張的人挑了棄牌（每場都有第 1 回合黑夜）。
  assert.ok(total(game.results, 'discards') > 0, 'someone over the hand limit picked cards to discard');
  assert.ok(game.lines.some((line) => /第 2 桌第 2 場｜.*入座：座位/.test(line)), 'seated again in match 2');
  assert.deepEqual(game.hostErrors, []);
});

test('five bots play both matches to the end when cards settle at once', GAME_TIMEOUT, async (t) => {
  const game = await playBots(t, { count: 5, data: instant, seed: 5 });
  assert.equal(game.uids.length, 5);
  assertBothMatches(game);
  assert.ok(total(game.results, 'plays') > 0, 'cards were played');
  assert.equal(total(game.results, 'responses'), 0, 'no window, no responses');
  assert.deepEqual(game.hostErrors, []);
});

test('the bots take it when the host sends every card back: they try others, end their turn, and the matches still finish', GAME_TIMEOUT, async (t) => {
  const game = await playBots(t, { count: 3, data: allTodo, botData: instant, policy: { passChance: 0, passStep: 0 }, seed: 9 });
  assertBothMatches(game);
  assert.ok(total(game.results, 'rejected') > 0, 'sent back');
  assert.ok(game.lines.some((line) => line.includes('被退回（出牌') && line.includes('這張牌的效果還沒做好')), 'the reason is printed');
  for (const key of [matchKey(game.table), matchKey(game.table, MATCH_COUNT)]) {
    assert.equal(Object.keys(game.room.games[key].log ?? {}).length, 0, 'nothing was played');
  }
  assert.deepEqual(game.hostErrors, []);
});

// ---- 指令列：房間不存在、已經開局時，印出原因就結束，什麼都不寫 ----

const cli = fileURLToPath(new URL('../../scripts/bots/cli.mjs', import.meta.url));

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { timeout: 20_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

test('the command refuses a missing room and a started table without writing anything', TIMEOUT, async () => {
  const missing = await runCli(['--emulator', '--room', 'ZZZZZZ']);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /連線：本機模擬器（專案 demo-one-day-briton）/);
  assert.match(missing.stderr, /找不到這個房間.*沒有寫入任何東西/);
  const code = await createRoom(host, 1);
  await joinRoom(person, code, '真人', 1);
  assert.deepEqual(await startTable(host, code, 1, instant, seededRandom(1)), { started: true });
  const started = await runCli(['--emulator', '--room', code.toLowerCase(), '--table', '1', '--fast']);
  assert.equal(started.code, 1);
  assert.match(started.stderr, /第 1 桌已經開局.*沒有寫入任何東西/);
  const anyTable = await runCli(['--emulator', '--room', code, '--fast']);
  assert.equal(anyTable.code, 1);
  assert.match(anyTable.stderr, /沒有可以加入的桌/);
  assert.deepEqual(Object.keys((await roomOnce(host, code)).players), [person.uid], 'no bot joined');
});
