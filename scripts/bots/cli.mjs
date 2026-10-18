// 湊人數機器人：把幾個機器人玩家放進主持端已經開好的房間，用玩家端的流程入座，之後每個階段照規則隨機做合法的動作。
// 用法：npm run bots -- --room <房號> [--count N] [--table T] [--delay 1500-4000] [--fast] [--emulator] [--name-prefix 機器人] [--wait 分鐘]
// （說明見 docs/BOTS.md）。開局、推進、算分、開第 2 場照常由主持端做；機器人只當玩家，結束時印結算摘要、自己斷線。
// 房間不存在、已經開局、坐滿時印出原因就結束，資料庫裡什麼都不寫。正式站先倒數幾秒才開始寫入，連錯了還來得及按 Ctrl-C。
import { readFile } from 'node:fs/promises';
import { MATCH_COUNT, matchKey, parseKey } from '../../play/js/rules.js';
import { ArgsError, USAGE, parseArgs } from './args.mjs';
import { PlanError, capacityOf, crowdedOut, planSeats, playersAt } from './plan.mjs';
import { combinedSummary, finalSummary } from './text.mjs';

// 連不上（模擬器沒開、沒有網路）時，登入與讀房間各最多等這麼久。
const CONNECT_MS = 20_000;
// 正式站：印出專案之後、第一次登入（開始寫入）之前等這麼久。
const COUNTDOWN_MS = 5000;
// 這麼短的時間內又收到停止訊號不算第二次：npm run 會把終端機送來的同一次 Ctrl-C 再轉送一次。
const REPEAT_MS = 1000;
// 都入座之後隔這麼久再讀一次房間，看有沒有跟同時在跑的另一個指令撞名、超過一桌的人數上限。
const RECHECK_MS = 1000;

function timed(promise, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}超過 ${CONNECT_MS / 1000} 秒沒有回應`)), CONNECT_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// 讀一次房間的資料（玩家端的 watchRoom，拿到第一筆就停）：房間不存在是 null。
function readRoomOnce(watchRoom, session, code) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let stop = null;
    const finish = (settle) => {
      if (finished) return;
      finished = true;
      queueMicrotask(() => stop?.());
      settle();
    };
    stop = watchRoom(
      session,
      code,
      (room) => finish(() => resolve(room)),
      (error) => finish(() => reject(error)),
    );
    if (finished) stop();
  });
}

// 登入、讀房間失敗時給使用者看的說明（後面由呼叫的一端接「資料庫沒有寫入任何東西」）。
function reachProblem(error, emulator) {
  if (error?.code === 'auth/too-many-requests') {
    return '登入被 Firebase 暫時擋下：同一個網路一小時內新開的匿名帳號太多（每個 IP 每小時最多 100 個）。隔一段時間再試；反覆測試請用 --emulator';
  }
  const where = emulator ? '本機模擬器' : '正式站';
  const hint = emulator ? '模擬器要先在另一個終端機跑 npm run dev' : '請確認網路';
  return `連不上${where}（${error?.message ?? error}）；${hint}`;
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

  // ---- 停止：Ctrl-C（SIGINT）、結束訊號（SIGTERM）、關掉終端機視窗（SIGHUP），或入座失敗時中止。halt 是 { code, detail }：結束碼、
  // 給機器人的結束原因 ----
  // 第一次開始乾淨結束（入座了的機器人收好：開局前的離開玩家名單，再離線）；REPEAT_MS 內重複收到的不算；之後再收到就不等，直接結束。
  // 在倒數、登入之前就掛好。
  const bots = [];
  let joining = false; // 開始入座了（在這之前停止，資料庫什麼都沒寫）
  let halt = null;
  let wakeHalt;
  const halted = new Promise((resolve) => (wakeHalt = resolve));
  const stopWith = (next) => {
    if (halt) return;
    halt = next;
    wakeHalt();
    for (const bot of bots) bot.stop(halt.detail);
  };
  // 每種訊號的結束碼（128＋訊號編號）、印出來的、給機器人的結束原因。
  const SIGNALS = {
    SIGINT: { code: 130, what: '收到 Ctrl-C', detail: '收到停止（Ctrl-C）', again: '（卡住的話再按一次 Ctrl-C）' },
    SIGTERM: { code: 143, what: '收到結束訊號（SIGTERM）', detail: '收到停止（結束訊號）', again: '' },
    SIGHUP: { code: 129, what: '終端機視窗關掉了（SIGHUP）', detail: '收到停止（終端機視窗關掉了）', again: '' },
  };
  let signalAt = null;
  const onSignal = (signal) => {
    // 視窗關掉之後輸出已經沒地方去（寫入會出錯）：不理會寫入的錯誤，照樣收好、結束。
    if (signal === 'SIGHUP') {
      for (const stream of [process.stdout, process.stderr]) if (stream.listenerCount('error') === 0) stream.on('error', () => {});
    }
    const kind = SIGNALS[signal];
    const now = Date.now();
    if (signalAt !== null && now - signalAt < REPEAT_MS) return;
    const first = signalAt === null;
    signalAt = now;
    if (!first) {
      console.log('又收到一次停止：不等機器人收好，直接結束');
      exit(halt?.code ?? kind.code);
      return;
    }
    console.log(joining ? `${kind.what}：機器人斷線中…${kind.again}` : `${kind.what}：還沒有入座，資料庫沒有寫入任何東西，結束`);
    stopWith({ code: kind.code, detail: kind.detail });
  };
  for (const signal of Object.keys(SIGNALS)) process.on(signal, () => onSignal(signal));
  // promise 跟停止比快：先停了就回傳 halted（由呼叫的一端收好、結束）。
  const HALTED = Symbol('halted');
  const unlessHalted = (promise) => Promise.race([promise, halted.then(() => HALTED)]);

  // play/js/config.js 依頁面的網址選連線設定（Node 裡沒有網址時選模擬器）：匯入 config、store 之前先擺好網址，
  // 正式站帶 ?env=prod、模擬器帶 ?env=emu，不用改 play/。寫入之前先確認選到的是要的那一組。
  const wanted = options.emulator ? 'emu' : 'prod';
  globalThis.location = { hostname: '', search: `?env=${wanted}` };
  const { env, config } = await import('../../play/js/config.js');
  if (env !== wanted || (wanted === 'prod') !== (config.emulator === null)) {
    console.error('連線設定跟指定的不一樣，沒有連線');
    return 1;
  }
  const project = config.firebase.projectId;
  console.log(`連線：${wanted === 'prod' ? '正式站' : '本機模擬器'}（專案 ${project}）`);

  const { loadGameData } = await import('../../play/js/gamedata.js');
  const { connect, disconnect, watchRoom } = await import('../../play/js/store.js');
  const { startBot } = await import('./bot.mjs');
  const cardDir = new URL('../../play/data/', import.meta.url);
  const { data, errors } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));
  if (errors.length > 0) {
    console.error(`卡牌資料有問題：\n${errors.join('\n')}`);
    return 1;
  }

  if (wanted === 'prod' && !halt) {
    console.log(`${COUNTDOWN_MS / 1000} 秒後開始寫入正式站（專案 ${project}），按 Ctrl-C 取消`);
    let timer;
    await unlessHalted(new Promise((resolve) => (timer = setTimeout(resolve, COUNTDOWN_MS))));
    clearTimeout(timer);
  }
  if (halt) return halt.code;

  // 每個機器人一個匿名身分（slot 不同就是不同玩家）。先用第一個讀房間、排座位，排得成才讓其他機器人登入、入座。
  const slot = (index) => `bot-${options.room}-${index + 1}`;
  const sessions = [];
  const closeAll = (list) => Promise.all(list.map((session) => disconnect(session).catch(() => {})));
  let room;
  try {
    const first = await unlessHalted(timed(connect(slot(0)), '登入'));
    if (first === HALTED) return halt.code;
    sessions.push(first);
    room = await unlessHalted(timed(readRoomOnce(watchRoom, first, options.room), '讀房間'));
  } catch (error) {
    await closeAll(sessions);
    console.error(`${reachProblem(error, options.emulator)}。資料庫沒有寫入任何東西。`);
    return 1;
  }
  if (room === HALTED) {
    await closeAll(sessions);
    return halt.code;
  }
  let plan;
  try {
    plan = planSeats(room, data, { table: options.table, count: options.count, prefix: options.prefix });
  } catch (error) {
    await closeAll(sessions);
    if (!(error instanceof PlanError)) throw error;
    console.error(`${error.message}。資料庫沒有寫入任何東西。`);
    return 1;
  }
  for (const note of plan.notes) console.log(note);
  const others = await unlessHalted(Promise.allSettled(plan.names.slice(1).map((_, index) => timed(connect(slot(index + 1)), '登入'))));
  if (others === HALTED) {
    await closeAll(sessions);
    return halt.code;
  }
  sessions.push(...others.filter((item) => item.status === 'fulfilled').map((item) => item.value));
  const refused = others.find((item) => item.status === 'rejected');
  if (refused) {
    await closeAll(sessions);
    console.error(`${reachProblem(refused.reason, options.emulator)}。資料庫沒有寫入任何東西。`);
    return 1;
  }
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

  joining = true;
  for (const [index, name] of plan.names.entries()) {
    if (halt) break;
    let bot;
    try {
      bot = await startBot({
        session: sessions[index],
        code: options.room,
        name,
        table: plan.table,
        data,
        delay: options.delay,
        waitMs: options.waitMinutes * 60_000,
        waitLabel: String(options.waitMinutes),
        log: (line) => console.log(line),
        onFinal,
      });
    } catch (error) {
      console.error(`${name} 沒有入座：${error.message}`);
      if (!halt) console.log(bots.length > 0 ? '中止：已經入座的機器人離開中…' : '中止：沒有機器人入座');
      stopWith({ code: 1, detail: `中止（${name} 沒有入座）` });
      break;
    }
    bots.push({ name, ...bot });
    if (halt) bot.stop(halt.detail); // 入座途中收到停止：正在入座的這一個也要停
  }
  // 沒能開始的機器人（入座失敗或中途停止）直接斷線。
  await closeAll(sessions.slice(bots.length));

  // 同一個房間同時有另一個指令在放機器人時，可能撞名、超過一桌的人數上限（joinRoom 不查人數，開局才查）：再讀一次，
  // 多出來的（較晚加入的）機器人離開。那一桌已經開局、或機器人已經有座位就不請走（走了座位就沒人動），只印一行提醒。
  let crowdedOff = 0;
  if (bots.length > 0 && !halt) {
    // 隔 RECHECK_MS 用 session 讀一次房間（停了、讀不到是 null）。
    const reread = async (session) => {
      let timer;
      await unlessHalted(new Promise((resolve) => (timer = setTimeout(resolve, RECHECK_MS))));
      clearTimeout(timer);
      return halt ? null : timed(readRoomOnce(watchRoom, session, options.room), '讀房間').catch(() => null);
    };
    const latest = await reread(sessions[0]);
    if (latest?.meta) {
      const capacity = capacityOf(data);
      const crowd = crowdedOut(latest, plan.table, capacity, new Set(bots.map((bot) => bot.uid)));
      const kept = crowd.kept.map(({ uid }) => bots.find((item) => item.uid === uid));
      const leaving = [];
      for (const { uid, why } of crowd.out) {
        const bot = bots.find((item) => item.uid === uid);
        if (!bot.leave(why)) {
          kept.push(bot); // 它自己已經看到開局了
          continue;
        }
        console.log(`注意：${bot.name} ${why}，離開（同一個房間請一次只跑一個指令）`);
        leaving.push(bot);
        crowdedOff += 1;
      }
      if (kept.length > 0) {
        console.log(`注意：第 ${plan.table} 桌已經開局，${kept.map((bot) => bot.name).join('、')} 不離開，有座位的照常玩（同一個房間請一次只跑一個指令）`);
      }
      // 同時在跑的另一個指令也會請走它自己多出來的機器人（這邊算不到）：等這邊的離開、隔一下用還在的機器人再數一次，
      // 還超過一桌（也還沒開局）才提醒。
      const staying = bots.filter((bot) => !leaving.includes(bot));
      const started = Boolean(latest.games?.[matchKey(plan.table)]) || kept.length > 0;
      if (crowd.seated > capacity && !started && staying.length > 0) {
        await unlessHalted(Promise.all(leaving.map((bot) => bot.done)));
        const again = await reread(sessions[bots.indexOf(staying[0])]);
        const crowded = again?.meta && !again.games?.[matchKey(plan.table)] ? playersAt(again, plan.table).length : 0;
        if (crowded > capacity) {
          console.log(`注意：第 ${plan.table} 桌名單上有 ${crowded} 人，超過一桌 ${capacity} 人，主持端開不了局；請有人換桌或按「離開」`);
        }
      }
    }
  }
  if (bots.length > crowdedOff && !halt) console.log('都入座了，等主持端開局。要提早結束請按 Ctrl-C。');

  const results = await Promise.all(bots.map((bot) => bot.done));
  results.forEach((result, index) => {
    const { stats } = result;
    console.log(
      `${bots[index].name} 結束：${result.detail}${result.left ? '，已離開玩家名單' : ''}｜出牌 ${stats.plays}、結束這一輪 ${stats.passes}、` +
        `響應 ${stats.responses}、表決 ${stats.votes}、黑夜 ${stats.nights}、挑棄牌 ${stats.discards}、被退回 ${stats.rejected}、送不出去 ${stats.failed}`,
    );
  });
  // 坐過第 1 場、第 2 場還沒開局就停下的：第 1 場有成績，留在名單上；主持端開第 2 場時預設會把它排進座位，變成不會動的座位。
  const benched = bots.filter((_, index) => results[index].beforeSecond).map((bot) => bot.name);
  if (benched.length > 0) console.log(`開第 2 場時請在「勾選參加」把離線的機器人取消（${benched.join('、')}）`);
  if (halt) return halt.code;
  // 讀不到房間的資料，或丟下一局還沒結束的遊戲（例如房間被刪了）：不算正常結束。
  return results.some((result) => result.reason === 'error' || result.abandoned) ? 1 : 0;
}

// 等輸出都寫出去再結束（輸出接到管線時是非同步的），也不留下任何計時器或連線。
function exit(code) {
  process.stdout.write('', () => process.exit(code));
}

main().then(exit, (error) => {
  console.error(error);
  exit(1);
});
