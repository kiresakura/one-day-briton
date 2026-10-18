// 湊人數機器人的指令列參數（用法見 docs/BOTS.md）。只檢查參數本身；房間、桌號、空位要連上資料庫才知道，由 plan.mjs 查。
import { parseArgs as parseNodeArgs } from 'node:util';
import { MAX_TABLES, isRoomCode, normalizeRoomCode } from '../../play/js/rules.js';

export const DEFAULT_DELAY = [1500, 4000];
export const FAST_DELAY = [50, 150];
export const DEFAULT_PREFIX = '機器人';
export const DEFAULT_WAIT_MINUTES = 20;
// 一個動作前最多等多久（毫秒）：再長旁觀的人就以為卡住了，響應窗口也會錯過。
const MAX_DELAY_MS = 60_000;

export const USAGE = `用法：npm run bots -- --room <房號> [選項]
  --room <房號>          要加入的房間（主持端開房後畫面上的 6 碼房號）
  --count <人數>         放幾個機器人；不給就補到這一桌建議的開局人數（3 人）
  --table <桌號>         坐第幾桌；不給就選還沒開局、有空位、人最少的那一桌
  --delay <最少-最多>    每個動作前隨機等多久（毫秒），預設 ${DEFAULT_DELAY.join('-')}
  --fast                 動作前只等 ${FAST_DELAY.join('-')} 毫秒（測試用，會蓋過 --delay）
  --emulator             連本機模擬器（npm run dev 開的那個）；不給就連正式站
  --name-prefix <前綴>   名字的前綴，預設「${DEFAULT_PREFIX}」（${DEFAULT_PREFIX}1、${DEFAULT_PREFIX}2…）
  --wait <分鐘>          還沒開局、等第 2 場時，房間這麼久都沒有任何變動就自己離開，預設 ${DEFAULT_WAIT_MINUTES}
                         （坐在還沒結束的一局裡不會自己離開）
  --help                 顯示這段說明`;

export class ArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgsError';
  }
}

function wholeNumber(text, flag, min, max) {
  if (!/^\d+$/.test(text)) throw new ArgsError(`${flag} 要是 ${min}–${max} 的整數，收到「${text}」`);
  const value = Number(text);
  if (value < min || value > max) throw new ArgsError(`${flag} 要是 ${min}–${max} 的整數，收到「${text}」`);
  return value;
}

// 「1500-4000」→ [1500, 4000]；只給一個數（「800」）就是固定等那麼久。
function delayRange(text) {
  const found = /^(\d+)(?:-(\d+))?$/.exec(text);
  if (!found) throw new ArgsError(`--delay 的寫法是「最少-最多」（毫秒），例如 1500-4000，收到「${text}」`);
  const min = Number(found[1]);
  const max = Number(found[2] ?? found[1]);
  if (min > max) throw new ArgsError(`--delay 的最少不能大於最多，收到「${text}」`);
  if (max > MAX_DELAY_MS) throw new ArgsError(`--delay 最多 ${MAX_DELAY_MS} 毫秒，收到「${text}」`);
  return [min, max];
}

// argv 是 process.argv.slice(2)。回傳 { room, count, table, delay, emulator, prefix, waitMinutes, help }：count、table 沒給是 null。
// 參數不對丟 ArgsError（訊息直接給使用者看）。
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseNodeArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        room: { type: 'string' },
        count: { type: 'string' },
        table: { type: 'string' },
        delay: { type: 'string' },
        fast: { type: 'boolean' },
        emulator: { type: 'boolean' },
        'name-prefix': { type: 'string' },
        wait: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    const reasons = {
      ERR_PARSE_ARGS_UNKNOWN_OPTION: '有看不懂的參數',
      ERR_PARSE_ARGS_INVALID_OPTION_VALUE: '有參數少了值（例如 --room 後面要接房號）',
      ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: '有多出來的字（參數的寫法是「--名稱 值」）',
    };
    throw new ArgsError(`${reasons[error.code] ?? '參數有問題'}：${error.message}`);
  }
  const values = parsed.values;
  if (values.help) return { help: true };
  if (values.room === undefined) throw new ArgsError('要用 --room 給房號');
  const room = normalizeRoomCode(values.room);
  if (!isRoomCode(room)) throw new ArgsError(`房號是 6 碼英數字（沒有 0、O、1、I、L），收到「${values.room}」`);
  const prefix = (values['name-prefix'] ?? DEFAULT_PREFIX).trim();
  if (!prefix) throw new ArgsError('--name-prefix 不能是空的');
  const wait = values.wait === undefined ? DEFAULT_WAIT_MINUTES : Number(values.wait);
  if (!(Number.isFinite(wait) && wait > 0)) throw new ArgsError(`--wait 要是大於 0 的分鐘數，收到「${values.wait}」`);
  let delay = values.delay === undefined ? DEFAULT_DELAY : delayRange(values.delay);
  if (values.fast) delay = FAST_DELAY;
  return {
    help: false,
    room,
    count: values.count === undefined ? null : wholeNumber(values.count, '--count', 1, 99),
    table: values.table === undefined ? null : wholeNumber(values.table, '--table', 1, MAX_TABLES),
    delay,
    emulator: Boolean(values.emulator),
    prefix,
    waitMinutes: wait,
  };
}
