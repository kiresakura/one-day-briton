// 玩家畫面（player.js）跟主持人控制台有關的判斷：全場暫停層要不要蓋、「最後一回合」、日落時重畫的時刻、到點重畫的計時器要不要重排、
// 新廣播要不要震。
// 只放純函式（不碰畫面、不讀時間；時間由呼叫的人給伺服器時間），單元測試直接載入（test/unit/player-model.test.js）。
import { endReasonAt, pauseHold, sunsetStatus } from '../game.js';
import { clockOf } from '../rules.js';
import { broadcastOf } from './home.js';

// 全場暫停（display/pause）對自己這一局：{ cover, until, cast }。cover＝現在蓋上暫停層；until＝自己這一桌暫停前就開著、還在跑的
// 倒數（響應窗口、揭曉倒數）結束的伺服器時間，先寫「這個倒數結束後全場暫停」、到點重畫再蓋，沒有是 null；cast＝層上放的那一則廣播
// （broadcastOf，不管這台收起了沒），沒有、已經收回或格式不對是 null——沒有廣播照樣蓋。沒有暫停（含舊房間沒有 display）是
// { cover: false, until: null, cast: null }。game、state 是自己那一局的局面與 tables/{局號}，settings 是卡牌資料的設定（還沒讀到
// 是 undefined），now 是伺服器時間。
export function pauseView(display, game, state, settings, now) {
  const { covered, until } = pauseHold(display?.pause, game, state, settings, now);
  return { cover: covered, until, cast: covered ? broadcastOf(display) : null };
}

// 這一回合是不是最後一回合（這一回合黑夜揭曉後按「下一階段」就算分）：跟主持端推進時（store.js 的 advanceOrEnd、game.js 的
// advancePlan）同一個判斷，日落照那一場的全場日落鐘（clockOf：第 2 場看第 2 場的鐘；沒有鐘的房間照這一桌從開局算起）。
// key 是自己這一桌目前的局號；卡牌資料還沒讀到（沒有 settings）是 false。
export function lastRoundOf(room, key, settings, now) {
  if (!settings) return false;
  return endReasonAt(room?.games?.[key], room?.tables?.[key], settings, now, clockOf(room, key)) !== null;
}

// 日落時要重畫一次的伺服器時間（「最後一回合」、手牌上限的提示跟著換）：sunsetStatus 的日落時刻，跟 lastRoundOf 看同一個鐘。
// 終局、沒開局又沒有鐘、全場鐘暫停中（沒有日落時刻）、卡牌資料還沒讀到是 null（不排）；鐘一被繼續或加減，房間資料變了就會重畫、改排。
export function sunsetWakeOf(room, key, settings, now) {
  const state = room?.tables?.[key];
  if (!settings || !state || state.phase === 'end') return null;
  return sunsetStatus(room.games?.[key], settings, now, clockOf(room, key))?.sunsetAt ?? null;
}

// 到點重畫的計時器 wake（{ at, timer }，at 是伺服器時間，timer 觸發後設成 null）要不要沿用：at 跟排好的一樣，而且計時器還在、
// 不用排（at 是 null）或已經到點了。計時器提早觸發（伺服器時間的估計往回修了，現在還沒到 at）時不沿用，重排。
export function keepsWake(wake, at, now) {
  return wake.at === at && (wake.timer !== null || at === null || now >= at);
}

// 新廣播時要不要短震一次：seen 是這一頁看過的最新一則 { code, seq }，cast 是目前那一則（broadcastOf；沒有是 null）。換了房
// （含剛進房、重新整理）先記下目前那一則、不震；同一間房 seq 變大才震。回傳 { seen, buzz }。
export function buzzStep(seen, code, cast) {
  if (seen?.code !== code) return { seen: { code, seq: cast?.seq ?? 0 }, buzz: false };
  if (!cast || cast.seq <= seen.seq) return { seen, buzz: false };
  return { seen: { code, seq: cast.seq }, buzz: true };
}
