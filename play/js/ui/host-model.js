// 主持人控制台的判斷（只有純函式，不碰畫面）：日落鐘會不會被減到 0、復原能不能按。畫面在 host.js，測試在 test/unit/host-model.test.js。
import { clockAdjustWrite, clockPassed, clockPaused, isClock } from '../game.js';

// 走著的鐘，store.js 照「現在＋這麼多毫秒」判斷日落與加減（減到底時會剩約 1.5 秒）。同 store.js 的 CLOCK_MARGIN_MS（store.js 還沒有匯出它）。
export const CLOCK_MARGIN_MS = 1500;

// 加減 delta 毫秒（負的是減）會不會把鐘減到 0（直接日落，日落後加不回來）：照 store.js 的 adjustClock 算，走著的鐘看「現在＋
// CLOCK_MARGIN_MS」、暫停中的看現在，再照 game.js 的 clockAdjustWrite 夾（單次、累計上限、剩餘不小於 0）。照那個時間已經日落的
// 不算（store 會丟 clock-passed，什麼都不會寫）。
export function zeroAfter(clock, delta, now) {
  if (!isClock(clock) || !(delta < 0)) return false;
  const at = now + (clockPaused(clock) ? 0 : CLOCK_MARGIN_MS);
  if (clockPassed(clock, at)) return false;
  const next = clockAdjustWrite(clock, delta, at);
  return next !== null && clockPassed(next, at);
}

// 結果條的「復原」能不能按（null＝可以；會減到 0 的另外先確認）。
export function undoWhy(clock, now) {
  if (!isClock(clock)) return '這一場沒有全場日落鐘';
  return clockPassed(clock, now) ? '已經日落了，不能復原' : null;
}
