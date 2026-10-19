// 主持人控制台的判斷（只有純函式，不碰畫面）：日落鐘會不會被減到 0、復原能不能按、全場暫停中每個鐘是哪一種、全場暫停／恢復之後
// 結果條怎麼寫、確認框打開後局面變了沒、全場動作與全場暫停中每桌按鈕的停用原因。畫面在 host.js，測試在 test/unit/host-model.test.js。
import { clockAdjustWrite, clockPassed, clockPaused, clockRemaining, clockSunsetAt, endReasonAt, isClock } from '../game.js';
import { MATCH_COUNT, activeKey, clockOf } from '../rules.js';
import { CLOCK_MARGIN_MS, PAUSE_NEAR_SUNSET_MS } from '../store.js';

export const PAUSED_TEXT = '全場暫停中';
export const OFFLINE_TEXT = '離線中，連回來才能操作';
const CLOCK_KEYS = ['1', String(MATCH_COUNT)];
const NEAR_SECONDS = PAUSE_NEAR_SUNSET_MS / 1000;

// 同 shared.js 的 matchText（這裡不載入畫面的模組）。
function matchName(match) {
  return `第 ${match} 場`;
}

function namesOf(matches) {
  return matches.map(matchName).join('、');
}

export function tablesText(items) {
  return `第 ${items.map((item) => item.table).join('、')} 桌`;
}

// 減 delta 毫秒（負的）之後照這台估的時間（now）還剩多少毫秒：照 store.js 的 adjustClock 算，走著的鐘看「現在＋CLOCK_MARGIN_MS」、
// 暫停中的看現在，再照 game.js 的 clockAdjustWrite 夾（單次、累計上限、剩餘不小於 0；走著的鐘減到底時照 now 看還剩約 1.5 秒）。
// 不是減、沒有鐘、照那個時間已經日落（store 會丟 clock-passed，什麼都不會寫）是 null。
export function leftAfter(clock, delta, now) {
  if (!isClock(clock) || !(delta < 0)) return null;
  const at = now + (clockPaused(clock) ? 0 : CLOCK_MARGIN_MS);
  if (clockPassed(clock, at)) return null;
  const next = clockAdjustWrite(clock, delta, at);
  return next === null ? null : Math.max(0, clockRemaining(next, now));
}

// 減 delta 毫秒會不會（幾乎）直接日落、要先確認（日落後加不回來）：走著的鐘減完照這台估的時間剩不到 PAUSE_NEAR_SUNSET_MS 就算
// （store 寫入時多留 1.5 秒、網路慢一兩秒時它照晚一點的時間夾，剩幾秒跟剩 0 一樣來不及）；暫停中的鐘剛好減到 0 才算（暫停中還加得回來）。
export function zeroAfter(clock, delta, now) {
  const left = leftAfter(clock, delta, now);
  if (left === null) return false;
  return clockPaused(clock) ? left <= 0 : left <= PAUSE_NEAR_SUNSET_MS;
}

// 結果條的「復原」能不能按（null＝可以；會減到 0 的另外先確認）。
export function undoWhy(clock, now) {
  if (!isClock(clock)) return '這一場沒有全場日落鐘';
  return clockPassed(clock, now) ? '已經日落了，不能復原' : null;
}

// 日落鐘「－5／－1／＋1／＋5」按下去怎麼做（host.js 的處理函式只照這個做）：'confirm'＝先開確認框（會幾乎直接日落，見 zeroAfter）、
// 'send'＝直接送、'disabled'＝不送（沒有鐘、已經日落；鈕本來就停用，只重畫）。
export function stepPlan(clock, delta, now) {
  if (!isClock(clock) || clockPassed(clock, now)) return 'disabled';
  return zeroAfter(clock, delta, now) ? 'confirm' : 'send';
}

// 結果條「復原」（undo＝{ match, delta, seq }，反方向調一次）按下去怎麼做：同上；沒有可以復原的、undoWhy 有原因（已經日落）是 'disabled'。
export function undoPlan(undo, clock, now) {
  if (!undo || undoWhy(clock, now)) return 'disabled';
  return zeroAfter(clock, undo.delta, now) ? 'confirm' : 'send';
}

// 這個鐘是不是被這一次全場暫停停住的：記在 pause.clocks，而且停住的時刻就是暫停那一筆的時刻（store.js 的 setPause 恢復時只恢復這種）。
export function heldByPause(clock, pause, match) {
  return pause?.clocks?.[match] === true && clockPaused(clock) && clock.pausedAt === pause.at;
}

// 全場暫停中，第 match 場的鐘是哪一種（沒有全場暫停、沒有鐘、已經日落是 null）。只看房間資料（display/pause 與 clock），不看 setPause
// 的回傳：回傳只有按的那一台、這一次寫進去才有（changed: false 的那一台、別台主持端、重新整理後都沒有），所以每一台、每次重畫都照這個分。
// held＝在 pause.clocks、停住的時刻就是暫停那一筆的時刻（恢復全場時一起繼續）；manual＝其他暫停著的（恢復全場後要自己按繼續）；
// near＝正在走、照這台估的伺服器時間離日落不到 PAUSE_NEAR_SUNSET_MS（照常日落、不給手動暫停；暫停中才走進最後 10 秒的也是）；
// free＝其他正在走的（沒被停住，例如被拒後不帶鐘重送；可以手動暫停）。
export function clockPauseState(room, match, now) {
  const pause = room?.display?.pause ?? null;
  const clock = room?.clock?.[match];
  if (pause?.on !== true || !isClock(clock) || clockPassed(clock, now)) return null;
  if (clockPaused(clock)) return heldByPause(clock, pause, match) ? 'held' : 'manual';
  return clockRemaining(clock, now) <= PAUSE_NEAR_SUNSET_MS ? 'near' : 'free';
}

// 下一次要整個重畫的時刻（伺服器時間）：正在走的鐘走進最後 PAUSE_NEAR_SUNSET_MS 的那一刻。全場暫停中沒停住（free）的鐘那時變成快日落
// （near）：面板的說明、手動暫停鈕與它的停用原因要跟上；「全場暫停？」確認框要補上快日落那一行。每秒的 tick 只換剩餘的字，不會重算這些。
// 取還沒到的最早一個；沒有是 null（暫停中的鐘不會走進去；日落那一刻 host.js 另外照 clockSunsetAt 排）。
export function nextWakeAt(room, now) {
  let next = null;
  for (const match of CLOCK_KEYS) {
    const clock = room?.clock?.[match];
    if (!isClock(clock) || clockPaused(clock)) continue;
    const at = clockSunsetAt(clock) - PAUSE_NEAR_SUNSET_MS;
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

// 上面四種在日落鐘面板的說明；held、manual、near 也是暫停／繼續鈕停用的原因（free 可以手動暫停）。
export const PAUSE_HOLD_TEXT = {
  held: '被這次全場暫停停住（恢復時一起繼續）',
  manual: '手動暫停的（恢復全場後要自己按繼續）',
  near: '快日落・照常日落、不停',
  free: '沒被全場暫停停住（可手動暫停）',
};

// 「暫停日落鐘？」確認框多寫的行：全場暫停中手動暫停沒被停住（free）的鐘，它不在這次暫停的紀錄裡，恢復全場時不會跟著繼續。
export function toggleDialogLines(room, match, now) {
  return clockPauseState(room, match, now) === 'free' ? [{ text: '全場恢復時不會自動繼續，要記得手動繼續', problem: true }] : [];
}

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

// 全場暫停（on）或恢復之後，按的那一台結果條的一句：{ ok, warn, text }。result 是 store.js setPause 的回傳 { changed, clocks, nearSunset }，
// 只用在這裡（面板與按鈕照 clockPauseState）；changed: false（本來就是那樣，例如兩台同時按的後到者）時兩欄都是空的，不拿來推論鐘。
// before 是按下去時的房間資料，after 是寫完之後的（還沒收到就給 before），now 是寫完的時刻。暫停：在 clocks 的停住了、在 nearSunset 的
// 快日落照常日落；其他正在走、還沒日落的照寫完的鐘分：離日落不到 PAUSE_NEAR_SUNSET_MS 的也是快日落（面板不給手動暫停，這裡也不叫人
// 按），其餘沒停住（可以手動暫停，恢復全場時不會自動繼續）。恢復：被這次暫停停住卻沒跟著繼續的照回傳提醒；還停著的手動暫停鐘照房間
// 資料比（按下去時是手動暫停的、寫完還停著），不看回傳，changed: false 的那一台也提醒。
export function pauseReport(on, result, before, after, now) {
  const changed = result?.changed === true;
  const done = changed ? (result.clocks ?? []).map(String) : [];
  const clocks = CLOCK_KEYS.filter((match) => isClock(before?.clock?.[match]));
  const latest = after ?? before;
  const parts = [];
  if (on) {
    if (!changed) return { ok: true, warn: false, text: '本來就是全場暫停中' };
    const near = (result.nearSunset ?? []).map(String);
    const running = clocks.filter((match) => {
      const clock = latest?.clock?.[match];
      return !done.includes(match) && !near.includes(match) && isClock(clock) && !clockPaused(clock) && !clockPassed(clock, now);
    });
    near.push(...running.filter((match) => clockRemaining(latest.clock[match], now) <= PAUSE_NEAR_SUNSET_MS));
    const missed = running.filter((match) => !near.includes(match));
    parts.push('全場暫停了');
    if (done.length) parts.push(`${namesOf(done)}日落鐘一起停住`);
    if (near.length) parts.push(`${namesOf(near)}日落鐘快日落（不到 ${NEAR_SECONDS} 秒）・照常日落、不停：各桌這一回合結束後算分`);
    if (missed.length) parts.push(`${namesOf(missed)}日落鐘沒有停住：要停可以在日落鐘面板按暫停（全場恢復時不會自動繼續，要記得手動繼續）`);
    return { ok: true, warn: near.length + missed.length > 0, text: parts.join('；') };
  }
  const pause = before?.display?.pause ?? null;
  const missed = clocks.filter((match) => changed && heldByPause(before.clock[match], pause, match) && !done.includes(match));
  const manual = manualPausedMatches(before).filter((match) => clockPaused(latest?.clock?.[match]) && !clockPassed(latest.clock[match], now));
  parts.push(changed ? '恢復全場了' : '本來就沒有全場暫停');
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

// 全場暫停中每桌停用的按鈕：「開始」「下一階段」「開第 2 場」，還有「提前揭曉」（玩家被暫停畫面蓋著、不能投票或選擇，提前揭曉等於
// 替還沒送出的人棄權或睡覺）。自動結算照常跑，已經在倒數的響應窗口與揭曉照樣收尾；沒有人能推進，就不會開新的階段。
export const PAUSE_BLOCKED = new Set(['start', 'next', 'open-match', 'reveal-dusk', 'reveal-night']);

// 每桌按鈕 act 的停用原因：全場暫停中、在上面那一組的寫「全場暫停中」，本來就因別的原因停用的在原因前面加「全場暫停中・」
// （例「全場暫停中・響應結算後才能按」）；其他照原本的 why。
export function pausedWhy(act, why, paused) {
  if (!paused || !PAUSE_BLOCKED.has(act)) return why ?? null;
  return why ? `${PAUSED_TEXT}・${why}` : PAUSED_TEXT;
}

// 全場動作四顆鈕的停用原因（null＝可以按）與兩格說明：{ advance, advanceNote, start, open, second, status }。advance、start、second 是
// game.js 的 advancePlan、startPlan、startMatch2Plan（卡牌資料還沒讀到時是 null），open 是 host.js 的 openPlan；noData 是卡牌資料還沒讀到
// 時的字（讀到了是 null），working＝四個裡有一個正在做。status 是下面那一格（最該看的那一個），批次動作的進度由畫面自己蓋上。
export function actionWhy({ off = false, paused = false, noData = null, working = false }, { advance = null, start = null, second = null, open = null } = {}) {
  const common = off ? OFFLINE_TEXT : paused ? PAUSED_TEXT : noData;
  // 只剩這一回合要算分的桌時也能按：確認框裡另外勾「連要算分的桌一起推」才會推。
  const ending = advance ? advance.skip.filter((item) => item.reason === 'ending') : [];
  const advanceWhy = common ?? (working ? '處理中…' : advance.advance.length || ending.length ? null : '沒有可以推的桌');
  let advanceNote = advanceWhy;
  if (!advanceWhy) advanceNote = advance.advance.length ? `${tablesText(advance.advance)}；按了會先列出來確認` : `${tablesText(ending)}這一回合要算分，在確認框另外勾`;
  let startWhy = common;
  if (!startWhy && start.start.length === 0) startWhy = start.started.length && start.skip.length === 0 ? `${start.started.length} 桌都開始了` : start.started.length || start.skip.length ? '沒有可以開的桌' : '第 1 場都結束了';
  let openWhy = common;
  if (!openWhy && !open) {
    // 已經有桌在第 2 場（開了或打完）時，不是「還沒打完第 1 場」，而是沒有要開的桌了。
    const inSecond = second && second.start.length + second.started.length + second.skip.length > 0;
    openWhy = inSecond ? `沒有打完${matchName(1)}、還沒開${matchName(2)}的桌` : `還沒有桌打完${matchName(1)}`;
  } else if (!openWhy && open.ready.length === 0) openWhy = '天命都要先判定完';
  let secondWhy = common;
  if (!secondWhy && second.start.length === 0) secondWhy = second.started.length ? `${matchName(2)}都開始了` : second.skip.length ? '沒有可以開的桌' : `還沒有桌開${matchName(2)}`;
  let status;
  if (working) status = '處理中…';
  else if (!common && !startWhy) status = '可以一起開全場日落鐘';
  else if (!common && !openWhy) status = `${matchName(1)}結束的桌可以開${matchName(2)}`;
  else if (!common && !secondWhy) status = `可以一起開${matchName(2)}的日落鐘`;
  else status = common ?? (open ? (secondWhy ?? openWhy) : startWhy) ?? '';
  return { advance: advanceWhy, advanceNote, start: startWhy, open: openWhy, second: secondWhy, status };
}
