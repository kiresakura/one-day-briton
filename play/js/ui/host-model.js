// 主持人控制台的判斷（只有純函式，不碰畫面）：日落鐘會不會被減到 0、復原能不能按、全場暫停中每個鐘是哪一種、全場暫停／恢復之後
// 結果條怎麼寫、確認框打開後局面變了沒。畫面在 host.js，測試在 test/unit/host-model.test.js。
import { clockAdjustWrite, clockPassed, clockPaused, clockRemaining, endReasonAt, isClock } from '../game.js';
import { MATCH_COUNT, activeKey, clockOf } from '../rules.js';
import { PAUSE_NEAR_SUNSET_MS } from '../store.js';

// 走著的鐘，store.js 照「現在＋這麼多毫秒」判斷日落與加減（減到底時會剩約 1.5 秒）。同 store.js 的 CLOCK_MARGIN_MS（store.js 還沒有匯出它）。
export const CLOCK_MARGIN_MS = 1500;
const CLOCK_KEYS = ['1', String(MATCH_COUNT)];
const NEAR_SECONDS = PAUSE_NEAR_SUNSET_MS / 1000;

// 同 shared.js 的 matchText（這裡不載入畫面的模組）。
function matchName(match) {
  return `第 ${match} 場`;
}

function namesOf(matches) {
  return matches.map(matchName).join('、');
}

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

// 這個鐘是不是被這一次全場暫停停住的：記在 pause.clocks，而且停住的時刻就是暫停那一筆的時刻（store.js 的 setPause 恢復時只恢復這種）。
export function heldByPause(clock, pause, match) {
  return pause?.clocks?.[match] === true && clockPaused(clock) && clock.pausedAt === pause.at;
}

// 全場暫停中，這一場的鐘是哪一種（沒有全場暫停、沒有鐘、已經日落是 null）：held＝被這次全場暫停停住；manual＝手動暫停的；
// near＝正在走、離日落不到 PAUSE_NEAR_SUNSET_MS（全場暫停照設計不停它）；free＝正在走、沒被停住（例如被拒後不帶鐘重送）。
export function clockUnderPause(clock, pause, match, now) {
  if (pause?.on !== true || !isClock(clock) || clockPassed(clock, now)) return null;
  if (clockPaused(clock)) return heldByPause(clock, pause, match) ? 'held' : 'manual';
  return clockRemaining(clock, now) <= PAUSE_NEAR_SUNSET_MS ? 'near' : 'free';
}

// 上面四種在日落鐘面板的說明；held、manual、near 也是暫停／繼續鈕停用的原因（free 可以手動暫停）。
export const PAUSE_HOLD_TEXT = {
  held: '被這次全場暫停停住（恢復時一起繼續）',
  manual: '手動暫停的（恢復全場後要自己按繼續）',
  near: '快日落・照常日落、不停',
  free: '沒被全場暫停停住（可手動暫停）',
};

// 正在走、還沒日落、離日落不到 PAUSE_NEAR_SUNSET_MS 的場次（全場暫停不會停住它們）：全場暫停的確認框先講一句。
export function nearSunsetMatches(room, now) {
  return CLOCK_KEYS.filter((match) => {
    const clock = room?.clock?.[match];
    return isClock(clock) && !clockPaused(clock) && !clockPassed(clock, now) && clockRemaining(clock, now) <= PAUSE_NEAR_SUNSET_MS;
  });
}

export function nearSunsetLine(matches) {
  return `${namesOf(matches)}日落鐘剩不到 ${NEAR_SECONDS} 秒：快日落・照常日落、不停（各桌這一回合結束後算分）`;
}

// 手動暫停的場次（暫停著、不是被這次全場暫停停住的）：恢復全場不會讓它們繼續。
export function manualPausedMatches(room) {
  const pause = room?.display?.pause ?? null;
  return CLOCK_KEYS.filter((match) => {
    const clock = room?.clock?.[match];
    return isClock(clock) && clockPaused(clock) && !heldByPause(clock, pause, match);
  });
}

// 全場暫停（on）或恢復之後結果條的一句：{ ok, warn, text }。result 是 store.js setPause 的回傳 { changed, clocks, nearSunset }；
// before 是按下去時的房間資料，after 是寫完之後的（還沒收到就給 before），now 是寫完的時刻。暫停：在 clocks 的停住了、在 nearSunset 的
// 快日落照常日落（不叫人手動暫停）、按下去時在走而且現在還沒日落、兩邊都不在的沒停住（可以手動暫停，恢復全場時不會自動繼續）。
// 恢復：被這次暫停停住卻沒跟著繼續的、手動暫停而且還停著的都提醒。
export function pauseReport(on, result, before, after, now) {
  if (!result?.changed) return { ok: true, warn: false, text: on ? '本來就是全場暫停中' : '本來就沒有全場暫停' };
  const done = (result.clocks ?? []).map(String);
  const clocks = CLOCK_KEYS.filter((match) => isClock(before?.clock?.[match]));
  const parts = [];
  if (on) {
    const near = (result.nearSunset ?? []).map(String);
    const missed = clocks.filter((match) => {
      const clock = before.clock[match];
      return !clockPaused(clock) && !clockPassed(clock, now) && !done.includes(match) && !near.includes(match);
    });
    parts.push('全場暫停了');
    if (done.length) parts.push(`${namesOf(done)}日落鐘一起停住`);
    if (near.length) parts.push(`${namesOf(near)}日落鐘快日落（不到 ${NEAR_SECONDS} 秒）・照常日落、不停：各桌這一回合結束後算分`);
    if (missed.length) parts.push(`${namesOf(missed)}日落鐘沒有停住：要停可以在日落鐘面板按暫停（全場恢復時不會自動繼續，要記得手動繼續）`);
    return { ok: true, warn: near.length + missed.length > 0, text: parts.join('；') };
  }
  const pause = before?.display?.pause ?? null;
  const missed = clocks.filter((match) => heldByPause(before.clock[match], pause, match) && !done.includes(match));
  const latest = after ?? before;
  const manual = manualPausedMatches(before).filter((match) => !done.includes(match) && clockPaused(latest?.clock?.[match]) && !clockPassed(latest.clock[match], now));
  parts.push('恢復全場了');
  if (done.length) parts.push(`${namesOf(done)}日落鐘接著走`);
  if (missed.length) parts.push(`${namesOf(missed)}日落鐘沒有跟著繼續（暫停中被動過），要的話在日落鐘面板按繼續`);
  if (manual.length) parts.push(`${namesOf(manual)}日落鐘還在暫停（手動暫停的），要繼續請在日落鐘面板按繼續`);
  return { ok: true, warn: missed.length + manual.length > 0, text: parts.join('；') };
}

// 全場動作確認框的局面「指紋」：計畫會用到的東西（各桌的回合、階段、有沒有開局、人數、發牌、「這回合結束後算分」、黑夜的桌這一刻
// 該不該算分；兩個全場鐘的序號；全場暫停），變了就在確認框提醒。settings、now 只有「能推的全推」用（黑夜的桌該不該算分）。
export function planSignature(kind, room, settings = null, now = 0) {
  if (!['start-all', 'start-all-2', 'advance-all'].includes(kind) || !room) return '';
  const parts = [];
  for (let table = 1; table <= (room.meta?.tableCount ?? 0); table += 1) {
    const key = activeKey(room, table);
    const state = room.tables?.[key];
    const game = room.games?.[key];
    const players = Object.values(room.players ?? {}).filter((player) => player?.table === table).length;
    const ending = kind === 'advance-all' && settings && state?.phase === 'night' ? (endReasonAt(game, state, settings, now, clockOf(room, key)) ?? '-') : '';
    parts.push(`${key}:${state?.round}:${state?.phase}:${game ? 1 : 0}:${players}:${room.deals?.[key] ?? 0}:${game?.endAfterRound ?? ''}:${ending}`);
  }
  const clocks = CLOCK_KEYS.map((match) => room.clock?.[match]?.seq ?? '').join(':');
  return `${parts.join('|')}|${clocks}|${room.display?.pause?.on === true}`;
}
