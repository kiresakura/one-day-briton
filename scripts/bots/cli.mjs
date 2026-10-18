// 湊人數機器人：把幾個機器人玩家放進主持端已經開好的房間，用玩家端的流程入座，之後每個階段照規則隨機做合法的動作。
// 用法：npm run bots -- --room <房號> [--count N] [--table T] [--delay 1500-4000] [--fast] [--emulator] [--name-prefix 機器人] [--wait 分鐘]
// （說明見 docs/BOTS.md）。開局、推進、算分、開第 2 場照常由主持端做；機器人只當玩家，結束時印結算摘要、自己斷線。
// 房間不存在、已經開局、坐滿時印出原因就結束，資料庫裡什麼都不寫。
import { readFile } from 'node:fs/promises';
import { MATCH_COUNT, parseKey } from '../../play/js/rules.js';
import { ArgsError, USAGE, parseArgs } from './args.mjs';
import { PlanError, planSeats } from './plan.mjs';
import { combinedSummary, finalSummary } from './text.mjs';

// 連不上（模擬器沒開、沒有網路）時，登入與讀房間各最多等這麼久。
const CONNECT_MS = 20_000;

function timed(promise, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}超過 ${CONNECT_MS / 1000} 秒沒有回應`)), CONNECT_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// 讀一次房間的資料（玩家端的 watchRoom，拿到第一筆就停）：房間不存在是 null。
function readRoomOnce(store, session, code) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let stop = null;
    const finish = (settle) => {
      if (finished) return;
      finished = true;
      queueMicrotask(() => stop?.());
      settle();
    };
    stop = store.watchRoom(
      session,
      code,
      (room) => finish(() => resolve(room)),
      (error) => finish(() => reject(error)),
    );
    if (finished) stop();
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof ArgsError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  // play/js/config.js 依頁面的網址選連線設定（Node 裡沒有網址時選模擬器）：匯入 config、store 之前先擺好網址，
  // 正式站帶 ?env=prod、模擬器帶 ?env=emu，不用改 play/。寫入之前先確認選到的是要的那一組。
  const wanted = options.emulator ? 'emu' : 'prod';
  globalThis.location = { hostname: '', search: `?env=${wanted}` };
  const { env, config } = await import('../../play/js/config.js');
  if (env !== wanted || (wanted === 'prod') !== (config.emulator === null)) {
    console.error('連線設定跟指定的不一樣，沒有連線');
    return 1;
  }
  console.log(`連線：${wanted === 'prod' ? '正式站' : '本機模擬器'}（專案 ${config.firebase.projectId}）`);

  const [{ loadGameData }, store, { startBot }] = await Promise.all([
    import('../../play/js/gamedata.js'),
    import('../../play/js/store.js'),
    import('./bot.mjs'),
  ]);
  const cardDir = new URL('../../play/data/', import.meta.url);
  const { data, errors } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
  if (errors.length > 0) {
    console.error(`卡牌資料有問題：\n${errors.join('\n')}`);
    return 1;
  }

  // 每個機器人一個匿名身分（slot 不同就是不同玩家）。先用第一個讀房間、排座位，排得成才讓其他機器人連線、入座。
  const slot = (index) => `bot-${options.room}-${index + 1}`;
  const sessions = [];
  let room;
  try {
    sessions.push(await timed(store.connect(slot(0)), '登入'));
    room = await timed(readRoomOnce(store, sessions[0], options.room), '讀房間');
  } catch (error) {
    const hint = options.emulator ? '模擬器要先在另一個終端機跑 npm run dev' : '請確認網路';
    console.error(`連不上${wanted === 'prod' ? '正式站' : '本機模擬器'}（${error.message}）；${hint}。沒有寫入任何東西。`);
    return 1;
  }
  let plan;
  try {
    plan = planSeats(room, data, { table: options.table, count: options.count, prefix: options.prefix });
  } catch (error) {
    await store.disconnect(sessions[0]);
    if (!(error instanceof PlanError)) throw error;
    console.error(`${error.message}。沒有寫入任何東西。`);
    return 1;
  }
  for (const note of plan.notes) console.log(note);
  sessions.push(...(await Promise.all(plan.names.slice(1).map((_, index) => store.connect(slot(index + 1))))));
  console.log(`房間 ${options.room}：放 ${plan.names.length} 個機器人到第 ${plan.table} 桌（${plan.names.join('、')}），每個動作前等 ${options.delay.join('–')} 毫秒`);

  // 同一局每個機器人都會看到終局：結算摘要只印一次；第 2 場結束時接著印兩場合計。
  const printed = new Set();
  const onFinal = (latest, key) => {
    if (printed.has(key)) return;
    printed.add(key);
    for (const line of finalSummary(latest, key, data)) console.log(line);
    const { table, match } = parseKey(key);
    if (match === MATCH_COUNT) for (const line of combinedSummary(latest, table)) console.log(line);
  };

  const bots = [];
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    console.log('收到 Ctrl-C：機器人斷線中…');
    for (const bot of bots) bot.stop();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);

  for (const [index, name] of plan.names.entries()) {
    if (interrupted) break;
    try {
      const bot = await startBot({
        session: sessions[index],
        code: options.room,
        name,
        table: plan.table,
        data,
        delay: options.delay,
        waitMs: options.waitMinutes * 60_000,
        log: (line) => console.log(line),
        onFinal,
      });
      bots.push({ name, ...bot });
    } catch (error) {
      console.error(`${name} 沒有入座：${error.message}`);
      interrupt();
    }
  }
  // 沒能開始的機器人（入座失敗或中途按了 Ctrl-C）直接斷線。
  await Promise.all(sessions.slice(bots.length).map((session) => store.disconnect(session).catch(() => {})));
  if (bots.length > 0 && !interrupted) console.log('都入座了，等主持端開局。要提早結束請按 Ctrl-C。');

  const results = await Promise.all(bots.map((bot) => bot.done));
  let failed = false;
  results.forEach((result, index) => {
    const { stats } = result;
    failed ||= result.reason === 'error';
    console.log(
      `${bots[index].name} 結束：${result.detail}｜出牌 ${stats.plays}、結束這一輪 ${stats.passes}、響應 ${stats.responses}、` +
        `表決 ${stats.votes}、黑夜 ${stats.nights}、挑棄牌 ${stats.discards}、被退回 ${stats.rejected}、送不出去 ${stats.failed}`,
    );
  });
  if (interrupted) return 130;
  return failed || bots.length < plan.names.length ? 1 : 0;
}

// 等輸出都寫出去再結束（輸出接到管線時是非同步的），也不留下任何計時器或連線。
function exit(code) {
  process.stdout.write('', () => process.exit(code));
}

main().then(exit, (error) => {
  console.error(error);
  exit(1);
});
