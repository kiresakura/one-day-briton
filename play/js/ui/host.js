// 主持端（筆電 1280×800／平板）：頂列（房號、各狀態桌數、主持端在線數、備援主持申請、離開）＋ 6 桌固定 3×2 的桌卡（階段色帶 →
// 狀態列 → 玩家表 → 今日事件或法案 → 底部），每桌的「紀錄」與終局的「結算明細」開右側抽屜；開房／接手的畫面是 renderHostEntry。
// 重畫用 patchChildren 就地更新、按鈕用 data-act 委派事件（同玩家端）：別人的動作觸發重畫時，開著的抽屜、備援申請面板、
// 起始玩家的下拉選單與焦點都不會被打斷。規則、流程、每個按鈕的作用與啟用條件與改版前相同。
// 兩場制（M9）：每桌畫的是目前那一局（rules.js 的 activeKey：第 1 場 "3"、第 2 場 "3-2"），按鈕的 data-table 一律是局號字串，直接傳給
// store；畫面上的「第 3 桌」用實體桌號。第 1 場結束的桌可以「開第 2 場」（store 的 openMatch），之後是「第 2 場・未開局」的座位預覽與
// 「開始第 2 場」（startTable 帶 include）；第 2 場結束後結算明細有兩場合計（game.js 的 combineScores）。
// 控制台模式：頂列下面多一條控制列（全場動作、日落鐘、投影畫面、音效台、全場廣播、緊急全場暫停）＋結果條，桌卡改成緊湊版；
// 寬 1360、高 860 以上預設開，頂列「控制台」切換（記在這台裝置），窄螢幕點開是上方抽屜。控制列只放「全場」的東西，每桌的操作照舊在桌卡
// 與抽屜。資料、規則與函式見 docs/CONSOLE-API.md：畫面只呼叫 store.js 的指令與 game.js 的純函式，不自己組寫入、不自己算日落鐘。
import {
  CLOCK_ADJUST_MAX_MS,
  MAX_SEATS,
  SUGGESTED_SEATS,
  advancePlan,
  checkSeating,
  clockElapsed,
  clockLength,
  clockPassed,
  clockPaused,
  clockRemaining,
  clockStartWrite,
  clockSunsetAt,
  dayStatus,
  duskStage,
  endReasonAt,
  isClock,
  nightStage,
  pendingDestinies,
  responseDeadline,
  seatsInOrder,
  skippedEffects,
  standingsOf,
  startMatch2Plan,
  startPlan,
  sunsetStatus,
  waitingFor,
} from '../game.js';
import { WEB_VERSION } from '../config.js';
import {
  BROADCAST_MAX_LENGTH,
  FOG_MAX,
  FOG_MIN,
  FOG_THRESHOLDS,
  MATCH_COUNT,
  MAX_TABLES,
  SCENE_PAGE_MAX,
  activeKey,
  clockOf,
  confirmCode,
  hostUids,
  isValidBroadcast,
  matchKey,
  normalizeBroadcast,
  parseKey,
} from '../rules.js';
import {
  StoreError,
  adjustClock,
  advanceAll,
  advanceOrEnd,
  approveHost,
  hideBroadcast,
  judgeDestiny,
  openMatch,
  pauseClock,
  playSfx,
  processSunrise,
  rejectHost,
  resumeClock,
  revealDusk,
  revealNight,
  sendBroadcast,
  serverTime,
  setEndAfterRound,
  setMusic,
  setPause,
  setScene,
  setStartOrder,
  startAll,
  startClock,
  startSettling,
  startTable,
  watchConnection,
  watchSubmissions,
} from '../store.js';
import { $, h, markTruncated, patchChildren } from './dom.js';
import {
  END_REASON_TEXT,
  PHASE_NAMES,
  PHASE_SHORT,
  PHASE_TONES,
  SLEEP_TEXT,
  billEffectText,
  billOf,
  billTitle,
  combinedOf,
  combinedTotalText,
  daySeconds,
  endReasonNow,
  eventOf,
  eventOutcome,
  eventTitle,
  explain,
  handovers,
  isOnline,
  isTied,
  logItems,
  logRounds,
  markPresent,
  matchScoreText,
  matchText,
  nameOf,
  notify,
  outcomeShort,
  pendingText,
  playersAt,
  rankedScores,
  revealDeadline,
  revealTotal,
  rerenderAt,
  ring,
  roleName,
  scoreRows,
  scoreRules,
  sideText,
  todaysEvents,
  turnSince,
  wakeAtSunset,
} from './shared.js';
import { ctx, random, rerender } from './state.js';

const dealing = new Set(); // 這台主持端正在發牌的局號
let stopSettling = null; // 主持端的自動結算（出牌請求、黃昏、黑夜）
const startChoices = new Map(); // 局號 → 下拉選單裡選好、還沒按「指定」的起始座位
const seatPicks = new Map(); // 第 2 場的局號 → 勾了參加的 uid（Set）：只存在這台裝置，換裝置要重勾；沒動過就照預設
const busy = new Set(); // 送出中的動作（「next:3」「start:3-2」「clock:1」之類）：按鈕停用到做完
let drawer = null; // 開著的抽屜 { kind: 'log' | 'final' | 'seats', table: 實體桌號, view: 'current' | 'first' }
let drawerOpener = null; // 開抽屜的按鈕（選擇器），關掉時焦點回到那裡
// 確認框：「開第 2 場」{ kind: 'one', table: 實體桌號 } 或 { kind: 'all' }；控制列的確認見 consoleDialog（kind 是 start-all、advance-all…，
// 打開時的計畫存在 plan，確認後原封交給 store）。
let confirming = null;
let confirmOpener = null; // 開確認框的按鈕（選擇器）
let requestsOpen = false; // 備援主持申請面板

// 控制台（這台裝置）：開或關記在 localStorage（沒選過就照視窗大小），控制列收合成一行也記著。
const CONSOLE_KEY = 'one-day-briton:console';
const FOLD_KEY = 'one-day-briton:console-fold';
let stopSubmissions = null; // 在等誰：入座的人的票、黑夜選擇、挑的棄牌（store.js 的 watchSubmissions）
let submissions = { votes: {}, nights: {}, discards: {} };
let stopConnection = null;
let connected = true; // .info/connected：false 時整條控制列停用
let outcome = null; // 結果條 { ok, text, full, at, undo: { match, delta, seq } | null }
let progress = null; // 批次動作進行中 { label, done, total }
let draft = ''; // 廣播輸入框的字（重畫時保留；送不出去也保留）

function readPref(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 無痕模式等存不了：這次開著的畫面照樣切換。
  }
}

let consolePref = readPref(CONSOLE_KEY); // 'on'｜'off'｜null（沒選過）
let folded = readPref(FOLD_KEY) === '1';
let compactCards = false; // 控制列在頂列下面時桌卡用緊湊版（今日事件一行）

// 回首頁時清掉主持端的訂閱與暫存。
export function resetHost() {
  stopSettling?.();
  stopSettling = null;
  stopSubmissions?.();
  stopSubmissions = null;
  submissions = { votes: {}, nights: {}, discards: {} };
  stopConnection?.();
  stopConnection = null;
  connected = true;
  outcome = null;
  progress = null;
  draft = '';
  dealing.clear();
  startChoices.clear();
  seatPicks.clear();
  busy.clear();
  drawer = null;
  drawerOpener = null;
  confirming = null;
  confirmOpener = null;
  requestsOpen = false;
  document.body.classList.remove('has-drawer');
}

// ---- H01：開房／接手（桌數、日落鐘目前固定；數字從程式與卡牌資料的設定取；場次寫一行說明） ----

export function renderHostEntry() {
  $('entry-tables').textContent = String(MAX_TABLES);
  const minutes = ctx.cardData ? scoreRules().sunsetMinutes : null;
  $('entry-sunset').textContent = minutes ? `${minutes} 分` : ctx.cardsFailed ? '讀不到設定' : '讀取中…';
  // 「第 1 場」「開第 2 場」中間有空格，1280 寬時會在空格斷行，拆成兩行：這兩段不准斷行（host.css 的 .keep）。
  $('entry-match').replaceChildren(
    '兩場制：',
    h('span', { class: 'keep', text: matchText(1) }),
    '結束後，在主持畫面各桌按',
    h('span', { class: 'keep', text: `「開${matchText(2)}」` }),
    '，同一間房接著打',
  );
  const capacity = Math.min(MAX_SEATS, ctx.cardData?.data.roles.length ?? MAX_SEATS);
  $('entry-seats').textContent = `1 到 ${capacity} 人`;
  $('entry-seats-hint').textContent = `建議至少 ${SUGGESTED_SEATS} 人；人少也能開始`;
  const thresholds = ctx.cardData?.data.settings.fogThresholds ?? FOG_THRESHOLDS;
  $('entry-fog').textContent = `迷霧值 ${FOG_MIN}–${FOG_MAX}。每桌迷霧第一次越過 ${thresholds.join('、')} 時各觸發一次迷霧事件，之後回落再越過不會再觸發。`;
}

// ---- 一桌的局面與「下一步」 ----

// 一局的局面。key 是局號（第 1 場 "3"、第 2 場 "3-2"；按鈕的 data-table、store 的參數、本機暫存的鍵都用它），number 是實體桌號
// （畫面上的「第 3 桌」、同桌的玩家），match 是第幾場；第 2 場時 first 是同一桌第 1 場的局面（座位與結算，已被規則鎖住，只讀）。
function tableModel(room, key) {
  const parsed = parseKey(key);
  const state = parsed ? room.tables?.[key] : null;
  if (!state) return null;
  const game = room.games?.[key] ?? null;
  // 已開局、在日出、這一回合還沒發牌（主持機在推進與發牌之間掛掉時，任何主持端都可以補發）。
  const pending = Boolean(game) && state.phase === 'sunrise' && (room.deals?.[key] ?? 0) < state.round;
  const ended = state.phase === 'end';
  // 這一回合是最後一回合（日落鐘、回合上限、主持端按了「這回合結束後算分」）：黑夜揭曉後的「下一階段」就是算分。日落鐘帶那一場的
  // 全場日落鐘（沒有就照這一桌的 startedAt），跟 advanceOrEnd 同一個判斷。
  const reason = game && !ended ? endReasonNow(game, state, String(key)) : null;
  const first = parsed.match === 1 ? null : (room.games?.[matchKey(parsed.table)] ?? null);
  const tone = game ? (PHASE_TONES[state.phase] ?? 'day') : 'idle';
  return { room, key: String(key), number: parsed.table, match: parsed.match, first, state, game, pending, ended, ending: reason !== null, reason, tone };
}

// 黑夜時手牌超過上限的人：誰挑好了、誰還沒挑（推進到下一回合日出時會被隨機棄）。主持端沒有訂閱別人的手牌，這裡只看張數；
// 挑的牌在不在手上，發牌時再查。挑的棄牌來自 watchSubmissions（「能推的全推」的提醒用同一份）。
// 回傳 { limit, missing: Set, picked: Set, text, problem }。
function handLimits(t) {
  const none = { limit: null, missing: new Set(), picked: new Set(), text: '', problem: false };
  const limit = ctx.cardData?.data.settings.handLimit;
  if (!limit || !t.game || t.state.phase !== 'night') return none;
  const over = seatsInOrder(t.game.seats).filter(([, seat]) => seat.handCount > limit);
  if (over.length === 0) return { ...none, limit };
  // 這一回合黑夜結束就算分：終局不棄牌，天命判定的手牌照上限算（game.js 的 destinyDone）。
  if (t.ending) return { ...none, limit, text: `這一回合結束就算分：手牌超過上限的不用棄，算分時照上限 ${limit} 張算` };
  const done = ([uid, seat]) => {
    const value = submissions.discards[uid];
    const count = Object.keys(value?.cards ?? {}).length;
    return Boolean(value) && String(value.table) === t.key && value.round === t.state.round && count === seat.handCount - limit;
  };
  const missing = over.filter((entry) => !done(entry));
  const picked = over.filter(done);
  const text = missing.length
    ? `手牌超過上限、還沒挑：${missing.map(([uid, seat]) => `${nameOf(t.room, uid)}（要棄 ${seat.handCount - limit}）`).join('、')}`
    : `手牌超過上限的人都挑好了：${picked.map(([uid]) => nameOf(t.room, uid)).join('、')}`;
  return { limit, missing: new Set(missing.map(([uid]) => uid)), picked: new Set(picked.map(([uid]) => uid)), text, problem: missing.length > 0 };
}

// 「下一階段」：why 是停用原因（照現行真正的條件），note 是可以按時的提醒。黑夜要有卡牌資料才知道要不要算分（同改版前）。
// data.ending 記著按鈕上寫的是不是「（算分）」：按下去時局面已經跟畫面不一樣（例如全場日落鐘剛被調過）就先不送，重畫給主持人看。
function nextAction(t, why = null, note = null) {
  const scoring = t.state.phase === 'night' && t.ending;
  const label = scoring ? '下一階段（算分）' : '下一階段 ▸';
  const noData = t.state.phase === 'night' && !ctx.cardData ? '卡牌資料讀取中…' : null;
  return { act: 'next', label, why: why ?? noData, note, primary: true, data: { round: t.state.round, phase: t.state.phase, ending: String(scoring) } };
}

// 在等誰（黃昏表決中、黑夜選擇中）：還沒送出的人名，照座位（game.js 的 waitingFor，跟「已送出 x／n」同一套判斷）。只在主持端顯示。
function missingNames(t) {
  const waiting = waitingFor(t.room, t.key, submissions);
  return waiting?.missing.length ? waiting.missing.map((uid) => nameOf(t.room, uid)).join('、') : '';
}

// 揭曉倒數（黃昏、黑夜）：照實際倒數到截止＋緩衝（真正揭曉的時間），到 0 還沒揭曉寫「揭曉中…」。
function revealStep(t, kind, at, early, blocked, missing) {
  const deadline = revealDeadline(kind, at);
  rerenderAt(at.revealAt); // 截止時「提前揭曉」要收起來
  rerenderAt(deadline); // 倒數到 0 時換成「揭曉中…」
  const total = Object.keys(t.game.seats).length;
  const sent = at.submitted ?? 0;
  const over = serverTime(ctx.session) >= deadline;
  const names = sent < total ? missingNames(t) : '';
  return {
    kind: 'wait',
    dial: ring({ deadline, total: revealTotal(kind), label: '揭曉倒數', overText: '…' }),
    title: over ? '揭曉中…' : sent >= total ? '大家都送出了・倒數揭曉' : '已截止・倒數揭曉',
    sub: `已送出 ${sent}／${total}・${missing}${names ? `：${names}` : ''}`,
    actions: [early, nextAction(t, blocked)],
  };
}

function sunriseStep(t) {
  if (t.pending) {
    const doing = dealing.has(t.key);
    return {
      kind: 'wait',
      icon: doing ? '…' : '!',
      title: doing ? '發牌中…' : '日出還沒發牌',
      sub: doing ? '薪水、抽牌與今日事件一次寫入' : '主持機在推進與發牌之間斷線時會這樣，按「補發」',
      actions: [doing ? null : { act: 'redeal', label: '補發', why: ctx.cardData ? null : '卡牌資料讀取中…' }, nextAction(t, '日出還沒發牌，發完才能按')],
    };
  }
  const first = dayStatus(t.game, t.state.round).order[0];
  return { kind: 'ready', icon: '✓', title: '可以按下一階段', sub: `薪水與抽牌已完成・白晝由 ${nameOf(t.room, first)} 先出`, actions: [nextAction(t)] };
}

function dayStep(t) {
  const { room, game, state, key } = t;
  const status = dayStatus(game, state.round);
  if (game.pending) {
    return {
      kind: 'wait',
      dial: ring({ deadline: responseDeadline(game.pending), total: game.pending.seconds, label: '響應' }),
      title: '等響應',
      sub: `${pendingText(room, game.pending)}・其他人可以響應`,
      actions: [nextAction(t, '響應結算後才能按')],
    };
  }
  if (status.done) return { kind: 'ready', icon: '✓', title: '白晝出完了・可以按下一階段', sub: '下一階段是黃昏', actions: [nextAction(t)] };
  return {
    kind: 'wait',
    dial: ring({ since: turnSince(key, state.round, status.turn.index), total: daySeconds(), label: '提醒' }),
    title: `在等 ${nameOf(room, status.current)} 出牌`,
    sub: `第 ${status.turn.index + 1}／${status.order.length} 位・這一輪出了 ${status.turn.plays} 張・還有 ${status.remaining} 人沒出完（下一階段隨時可以按）`,
    actions: [nextAction(t)],
  };
}

function duskStep(t) {
  const { game, state } = t;
  const stage = duskStage(game.dusk, state.round);
  const blocked = '法案揭曉後才能按';
  if (stage === 'none') return { kind: 'wait', icon: '…', title: '翻開法案中…', sub: '黃昏的法案由主持端自動翻開', actions: [nextAction(t, blocked)] };
  if (stage === 'adjourned') return { kind: 'ready', icon: '✓', title: '今天議會休會・可以按下一階段', sub: '法案都通過了，這一回合不投票', actions: [nextAction(t)] };
  const { dusk } = game;
  if (stage === 'revealed') {
    const { result } = dusk;
    return { kind: 'ready', icon: '✓', title: `法案${result.passed ? '通過' : '沒有通過'}・可以按下一階段`, sub: `贊成 ${result.yes}：反對 ${result.no}・下一階段是黑夜`, actions: [nextAction(t)] };
  }
  const early = state.phase === 'dusk' && (stage === 'voting' || dusk.revealAt > serverTime(ctx.session) + 500) ? { act: 'reveal-dusk', label: '提前揭曉' } : null;
  if (stage === 'voting') {
    const seconds = ctx.cardData?.data.settings.reminderSeconds.dusk ?? 120;
    const total = Object.keys(game.seats).length;
    const names = missingNames(t);
    return {
      kind: 'wait',
      dial: ring({ deadline: dusk.openedAt + seconds * 1000, total: seconds, label: '提醒' }),
      title: `表決中・已送出 ${dusk.submitted ?? 0}／${total}`,
      sub: `${names ? `還沒送出：${names}・` : ''}全部送出就倒數揭曉；按「提前揭曉」時沒送出的算棄權`,
      actions: [early, nextAction(t, blocked)],
    };
  }
  return revealStep(t, 'dusk', dusk, early, blocked, '沒送出的算棄權');
}

function nightStep(t, limits) {
  const { game, state } = t;
  const stage = nightStage(game.night, state.round);
  const blocked = '黑夜揭曉後才能按';
  if (stage === 'none') return { kind: 'wait', icon: '…', title: '黑夜開始中…', sub: '黑夜由主持端自動開始', actions: [nextAction(t, blocked)] };
  const { night } = game;
  if (stage === 'revealed') {
    return {
      kind: 'ready',
      icon: '✓',
      title: t.ending ? '黑夜揭曉了・可以算分' : '黑夜揭曉了・可以按下一階段',
      sub: limits.text || (t.ending ? `這一回合結束就算分（${END_REASON_TEXT[t.reason] ?? t.reason}）` : `下一階段是第 ${state.round + 1} 回合日出`),
      actions: [nextAction(t, null, limits.problem ? '推進時沒挑的人會被隨機棄' : null)],
    };
  }
  const early = stage === 'choosing' || night.revealAt > serverTime(ctx.session) + 500 ? { act: 'reveal-night', label: '提前揭曉' } : null;
  if (stage === 'choosing') {
    const seconds = ctx.cardData?.data.settings.reminderSeconds.night ?? 120;
    const total = Object.keys(game.seats).length;
    const names = missingNames(t);
    return {
      kind: 'wait',
      dial: ring({ deadline: night.openedAt + seconds * 1000, total: seconds, label: '提醒' }),
      title: `選擇中・已送出 ${night.submitted ?? 0}／${total}`,
      sub: `${names ? `還沒送出：${names}・` : ''}全部送出就倒數揭曉；按「提前揭曉」時沒送出的算睡覺`,
      actions: [early, nextAction(t, blocked)],
    };
  }
  return revealStep(t, 'night', night, early, blocked, '沒送出的算睡覺');
}

// 「判定」空白的天命（終局時由主持端勾）。
function judgedByHost(id) {
  const card = id ? ctx.cardData?.index.destinies.get(id) : null;
  return Boolean(card) && (card.check ?? null) === null;
}

// 還沒判定的天命：[uid, 分數]。
function unjudged(game) {
  return rankedScores(game).filter(([, score]) => score.destiny?.id && score.destiny.done !== true && score.destiny.done !== false);
}

function endReasonText(final) {
  return `第 ${final.round} 回合結束後算分（${END_REASON_TEXT[final.reason] ?? final.reason}）`;
}

// 第 1 場結束的桌：「開第 2 場」（第 ① 步，屬「可推進」）。有待判定的天命時停用（開了之後第 1 場被規則鎖住；判斷同 store 的
// openMatch，用 game.js 的 pendingDestinies），卡牌資料還沒讀到也停用（接著要開局）。
function openAction(t) {
  const waiting = pendingDestinies(t.game.final.scores).length;
  let why = null;
  if (waiting) why = `${matchText(1)}還有 ${waiting} 張天命待判定（在結算明細勾），開${matchText(2)}之後就不能改了`;
  else if (!ctx.cardData) why = ctx.cardsFailed ? '卡牌資料有問題，請找工作人員' : '卡牌資料讀取中…';
  return { act: 'open-match', label: `開${matchText(2)}`, why, primary: true };
}

function endStep(t) {
  const { room, game } = t;
  if (!game.final) return { kind: 'wait', icon: '…', title: '算分中…', sub: '', actions: [] };
  const waiting = unjudged(game);
  const open = t.match === 1 ? openAction(t) : null;
  if (waiting.length) {
    return {
      kind: 'judge',
      icon: '?',
      title: `${matchText(t.match)}待判定 ${waiting.length} 份天命`,
      sub: `${waiting.map(([uid]) => nameOf(room, uid)).join('、')} 的天命要主持人判定；判定前那份算 0 分`,
      actions: [{ act: 'final', label: '展開結算明細', primary: true }, open],
    };
  }
  if (t.match === 1) {
    const top = rankedScores(game).filter(([, score]) => score.rank === 1).map(([uid]) => nameOf(room, uid));
    return {
      kind: 'ready',
      icon: '✓',
      title: `${matchText(1)}已算分・第 1 名 ${top.join('、')}`,
      sub: `${endReasonText(game.final)}・可以開${matchText(2)}`,
      actions: [{ act: 'final', label: '結算明細' }, open],
    };
  }
  const combined = Object.entries(combinedOf(room, t.number) ?? {});
  const top = combined.filter(([, row]) => row.rank === 1).map(([uid]) => nameOf(room, uid));
  return { kind: 'done', icon: '✓', title: `兩場合計第 1 名 ${top.join('、')}`, sub: `${matchText(2)}・${endReasonText(game.final)}`, actions: [{ act: 'final', label: '展開結算明細' }] };
}

// 第 2 場・未開局的座位預覽：第 1 場的每個座位（照座位號）第 2 場拿到哪個階層、誰交過來（shared.js 的 handovers）、有沒有勾參加，
// 加上第 1 場之後才加入這一桌的人（不能勾）。勾選只存在這台裝置（seatPicks），沒動過就照預設：第 1 場有座位、而且現在還選這一桌
// 的人（同 store 的 startTable）。回傳 { rows: [{ uid, order, before, role, from, include }], newcomers: [uid], include: [uid] }。
function seatPlan(t) {
  const seats1 = t.first?.seats ?? {};
  const picked = seatPicks.get(t.key) ?? new Set(Object.keys(seats1).filter((uid) => t.room.players?.[uid]?.table === t.number));
  const passed = handovers(seats1);
  const rows = seatsInOrder(seats1).map(([uid, seat]) => ({ uid, before: seat.role, ...passed.get(uid), include: picked.has(uid) }));
  const newcomers = playersAt(t.room, t.number)
    .filter(([uid]) => !seats1[uid])
    .map(([uid]) => uid);
  return { rows, newcomers, include: rows.filter((row) => row.include).map((row) => row.uid) };
}

// 一個座位第 1 場 → 第 2 場的階層：「貴族 → 蒸汽大亨（由座位 6 的〈名字〉交過來）」；沒勾的座位這場空著，傳給它的階層第 2 場沒有人坐。
function passText(t, row) {
  if (!row.include) return `這場空著，${matchText(2)}的〈${roleName(row.role)}〉沒有人坐`;
  const from = row.from === row.uid ? '只有 1 人，階層照舊' : `由座位 ${t.first.seats[row.from].order + 1} 的 ${nameOf(t.room, row.from)} 交過來`;
  return `${roleName(row.before)} → ${roleName(row.role)}（${from}）`;
}

// 桌卡座位預覽那一格：第 2 場的階層一定整個看得到；放不下時只縮第 1 場的階層（「…」點一下看全文，全文含誰交過來）。
// 誰交過來另外寫在「勾選參加」抽屜。
function passCell(t, row) {
  const full = passText(t, row);
  if (!row.include) return trunc('span', 'tc-state', `〈${roleName(row.role)}〉沒有人坐`, full);
  if (row.from === row.uid) return trunc('span', 'tc-state', `${roleName(row.role)}（照舊）`, full);
  return h('span', { class: 'tc-pass' }, trunc('span', 'tc-pass-from', roleName(row.before), full), h('span', { class: 'tc-pass-arrow', text: '→' }), h('b', { class: 'tc-pass-to', text: roleName(row.role) }));
}

// 第 2 場・未開局（第 ① 步之後、第 ② 步之前）：玩家手機上已經看得到自己的新階層，現場交接角色卡；按「開始第 2 場」照座位預覽開局。
function seatsStep(t) {
  const { include } = seatPlan(t);
  const { error, warning } = checkSeating(include.length, ctx.cardData?.data.roles.length);
  let why = error;
  if (ctx.cardsFailed) why = '卡牌資料有問題，請找工作人員';
  else if (!ctx.cardData) why = '卡牌資料讀取中…';
  else if (include.length === 0) why = `${matchText(2)}至少要勾 1 人參加`;
  return {
    kind: 'idle',
    icon: String(include.length),
    title: `${matchText(2)}・未開局・勾了 ${include.length} 人參加`,
    sub: warning ?? '玩家手機上已經看得到自己的新階層，交接角色卡後開始',
    actions: [{ act: 'start', label: `開始${matchText(2)}`, why, primary: true }],
  };
}

function idleStep(t) {
  const players = playersAt(t.room, t.number);
  const roles = ctx.cardData?.data.roles.length;
  const { error, warning } = checkSeating(players.length, roles);
  const capacity = Math.min(MAX_SEATS, roles ?? MAX_SEATS);
  const why = ctx.cardsFailed ? '卡牌資料有問題，請找工作人員' : ctx.cardData ? error : '卡牌資料讀取中…';
  return {
    kind: 'idle',
    icon: String(players.length),
    title: `等玩家加入・已加入 ${players.length} 人`,
    sub: warning ?? `建議至少 ${SUGGESTED_SEATS} 人，最多 ${capacity} 人`,
    actions: [{ act: 'start', label: '開始', why, primary: true }],
  };
}

function stepOf(t, limits) {
  if (!t.game) return pauseGuard(t, t.match === 1 ? idleStep(t) : seatsStep(t));
  if (t.ended) return pauseGuard(t, endStep(t));
  if (t.state.phase === 'sunrise') return pauseGuard(t, sunriseStep(t));
  if (t.state.phase === 'day') return pauseGuard(t, dayStep(t));
  if (t.state.phase === 'dusk') return pauseGuard(t, duskStep(t));
  return pauseGuard(t, nightStep(t, limits));
}

// 全場暫停中：「開始」「下一階段」「開第 2 場」停用，原因寫「全場暫停中」（本來就停用的照原本的原因）。自動結算照常跑，已經在倒數的
// 響應窗口與揭曉照樣收尾；沒有人能推進，就不會開新的階段。
const PAUSED_TEXT = '全場暫停中';
const PAUSE_BLOCKED = new Set(['start', 'next', 'open-match']);

function isPaused(room) {
  return room?.display?.pause?.on === true;
}

function pauseGuard(t, step) {
  if (!isPaused(t.room)) return step;
  return { ...step, actions: step.actions.map((action) => (action && PAUSE_BLOCKED.has(action.act) ? { ...action, why: action.why ?? PAUSED_TEXT } : action)) };
}

// ---- 桌卡 ----

function trunc(tag, className, text, full = text) {
  return h(tag, { class: `trunc ${className}`, data: { full }, text });
}

function fogMini(fog, fired) {
  const thresholds = ctx.cardData?.data.settings.fogThresholds ?? FOG_THRESHOLDS;
  const hit = new Set(fired ?? []);
  const value = Math.max(FOG_MIN, Math.min(FOG_MAX, Number(fog) || 0));
  const firedText = [...hit].sort((a, b) => a - b).join('、');
  return h(
    'span',
    { class: 'tc-fog', attrs: { role: 'img', 'aria-label': `迷霧值 ${value}／${FOG_MAX}${firedText ? `，已觸發 ${firedText}` : ''}` } },
    h('span', { class: 'tc-fog-num', text: `迷霧 ${value}`, attrs: { 'aria-hidden': 'true' } }),
    h(
      'span',
      { class: 'tc-fog-bar', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'tc-fog-fill', style: { width: `${value}%` } }),
      thresholds.map((threshold) => h('span', { class: `tc-fog-mark${hit.has(threshold) ? ' is-hit' : ''}`, style: { left: `${threshold}%` } })),
    ),
  );
}

// 色帶的場次、回合與階段：「第 2 場・第 3 回合・白晝」「第 1 場・第 4 回合結束・終局」「第 2 場・未開局」。
function bandText(t) {
  const { state, game } = t;
  const match = matchText(t.match);
  if (!game) return `${match}・${t.match === 1 ? '未開始' : '未開局'}`;
  if (t.ended) return `${match}・第 ${game.final?.round ?? state.round} 回合結束・${PHASE_NAMES.end}`;
  return `${match}・第 ${state.round} 回合・${PHASE_NAMES[state.phase] ?? state.phase}`;
}

function band(t) {
  const { state, game } = t;
  return h(
    'div',
    { class: 'tc-band' },
    h('h2', { class: 'tc-name', attrs: { id: `tc-${t.number}-name` }, text: `第 ${t.number} 桌` }),
    h('span', { class: 'tc-phase' }, game ? h('span', { class: `phase-icon phase-icon-${t.tone}`, attrs: { 'aria-hidden': 'true' } }) : null, h('span', { class: 'tc-phase-text', text: bandText(t) })),
    t.ending ? h('span', { class: 'tag tag-strong tc-last', text: '最後一回合' }) : null,
    game && !t.ended ? fogMini(state.fog, game.fogFired) : null,
  );
}

function statusRow(step) {
  return h(
    'div',
    { class: `status tc-status is-${step.kind}`, attrs: { role: 'status' } },
    step.dial ?? h('span', { class: 'status-icon', text: step.icon ?? '', attrs: { 'aria-hidden': 'true' } }),
    h('div', { class: 'status-body' }, trunc('p', 'status-title', step.title), step.sub ? trunc('p', 'status-sub', step.sub) : null),
  );
}

// 名字與階層：太長時「…」＋點線底線，點一下彈出全文（名字、階層、座位）。unseated 是沒有座位時寫的字。
function whoCell(room, uid, seat, unseated = '未入座') {
  const player = room.players?.[uid];
  const name = player?.name ?? '（已離開房間）';
  const role = seat ? roleName(seat.role) : '';
  const full = `${name}\n${[role, seat ? `座位 ${seat.order + 1}` : unseated].filter(Boolean).join('・')}`;
  const offline = Boolean(player) && !isOnline(room, uid);
  return h(
    'div',
    { class: 'who' },
    trunc('b', `who-name${player ? '' : ' is-gone'}`, name, full),
    offline ? h('span', { class: 'tag-off', text: '離線' }) : null,
    role ? trunc('span', 'who-role', role, full) : null,
  );
}

// 玩家表最後一欄（照階段）：{ head, cell(uid, seat) → { text, hot } }。
function statusColumn(t, limits) {
  const { room, game, state } = t;
  if (state.phase === 'sunrise') {
    const first = dayStatus(game, state.round).order[0];
    return { head: '狀態', cell: (uid) => (uid === first ? { text: '起始玩家', hot: true } : { text: '—' }) };
  }
  if (state.phase === 'day') {
    const status = dayStatus(game, state.round);
    if (game.pending) return { head: '狀態', cell: (uid) => (uid === game.pending.by ? { text: '出牌・等響應', hot: true } : { text: '可響應' }) };
    const at = (uid) => status.order.indexOf(uid);
    return { head: '狀態', cell: (uid) => (status.done || at(uid) < status.turn.index ? { text: '出完了' } : uid === status.current ? { text: '▶ 出牌中', hot: true } : { text: '—' }) };
  }
  if (state.phase === 'dusk') {
    const stage = duskStage(game.dusk, state.round);
    if (stage === 'revealed') return { head: '表決', cell: (uid) => ({ text: game.dusk.result.votes?.[uid] ? sideText(game.dusk.result.votes[uid]) : '沒送出（棄權）' }) };
    return { head: '表決', cell: () => ({ text: stage === 'adjourned' ? '休會' : stage === 'none' ? '—' : '表決中' }) };
  }
  const stage = nightStage(game.night, state.round);
  const result = stage === 'revealed' ? game.night.result : null;
  return {
    head: '黑夜結果',
    cell: (uid, seat) => {
      const base = result ? (result.players?.[uid] ? outcomeShort(result.players[uid]) : SLEEP_TEXT) : stage === 'none' ? '—' : '選擇中';
      if (limits.missing.has(uid)) return { text: `${base}・要棄 ${seat.handCount - limits.limit} 張`, hot: true };
      if (limits.picked.has(uid)) return { text: `${base}・已挑棄牌` };
      return { text: base };
    },
  };
}

function playerTable(t, limits) {
  const { room, game } = t;
  const column = statusColumn(t, limits);
  const unseated = playersAt(room, t.number).filter(([uid]) => !game.seats[uid]);
  const unseatedLabel = t.match === 1 ? '未入座' : `${matchText(t.match)}沒座位`;
  return h(
    'table',
    // 黑夜的結果欄字比較長（「— 沒送出・要棄 1 張」「豪賭 1 層 +5・已挑棄牌」），黑夜時把數字欄的寬度讓給它（host.css 的 is-night）。
    { class: `tc-table${t.state.phase === 'night' ? ' is-night' : ''}` },
    h(
      'thead',
      {},
      h('tr', {}, ['玩家・階層', '英鎊', '影響', '手牌', '罪孽'].map((text) => h('th', { attrs: { scope: 'col' }, text })), h('th', { attrs: { scope: 'col' }, text: column.head })),
    ),
    h(
      'tbody',
      {},
      seatsInOrder(game.seats).map(([uid, seat]) => {
        const cell = column.cell(uid, seat);
        return h(
          'tr',
          { class: cell.hot ? 'is-hot' : '', data: { key: uid } },
          h('td', {}, whoCell(room, uid, seat)),
          h('td', { class: 'num', text: seat.pounds }),
          h('td', { class: 'num', text: seat.influence }),
          h('td', { class: 'num', text: seat.handCount }),
          h('td', { class: 'num', text: seat.sin ?? 0 }),
          h('td', {}, trunc('span', `tc-state${cell.hot ? ' is-hot' : ''}`, cell.text)),
        );
      }),
      unseated.length
        ? h('tr', { class: 'is-unseated', data: { key: 'unseated' } }, h('td', { attrs: { colspan: 6 } }, trunc('span', 'tc-state', `${unseatedLabel}：${unseated.map(([, player]) => player.name).join('、')}`)))
        : null,
    ),
  );
}

function rankTable(t) {
  const { room, game } = t;
  return h(
    'table',
    { class: 'tc-table is-rank' },
    h('thead', {}, h('tr', {}, ['名次', '玩家・階層', '總分', '天命'].map((text) => h('th', { attrs: { scope: 'col' }, text })))),
    h(
      'tbody',
      {},
      rankedScores(game).map(([uid, score]) => {
        const done = score.destiny?.done;
        const waiting = score.destiny?.id && done !== true && done !== false;
        const destiny = !score.destiny?.id ? '沒有天命' : done === true ? `✓ 達成 +${score.destiny.points}` : done === false ? '✗ 沒達成' : '? 待判定';
        return h(
          'tr',
          { class: waiting ? 'is-hot' : '', data: { key: uid } },
          h('td', { class: 'tc-rank', text: `第 ${score.rank}` }),
          h('td', {}, whoCell(room, uid, game.seats[uid])),
          h('td', { class: 'num tc-total', text: waiting ? `${score.total}+?` : score.total }),
          h('td', {}, trunc('span', `tc-state${waiting ? ' is-hot' : ''}`, destiny)),
        );
      }),
    ),
  );
}

// 第 2 場結束的桌：兩場合計的名次（game.js 的 combineScores；第 2 場天命待判定的寫「+?」，沒參加的寫出來）。
function combinedTable(t) {
  const { room, game } = t;
  const combined = combinedOf(room, t.number) ?? {};
  return h(
    'table',
    { class: 'tc-table is-combined' },
    h('thead', {}, h('tr', {}, ['合計名次', '玩家・第 2 場階層', matchText(1), matchText(2), '合計'].map((text) => h('th', { attrs: { scope: 'col' }, text })))),
    h(
      'tbody',
      {},
      Object.entries(combined).map(([uid, row]) =>
        h(
          'tr',
          { class: row.pending ? 'is-hot' : '', data: { key: uid } },
          h('td', { class: 'tc-rank', text: `第 ${row.rank}${isTied(combined, row) ? '・並列' : ''}` }),
          h('td', {}, whoCell(room, uid, game.seats[uid], `${matchText(2)}沒座位`)),
          h('td', { class: 'num', text: row.missingFirst ? '—' : row.first }),
          h('td', { class: 'num', text: row.absent ? '沒參加' : `${row.second}${row.pending ? '+?' : ''}` }),
          h('td', { class: 'num tc-total', text: combinedTotalText(row) }),
        ),
      ),
    ),
  );
}

// 第 2 場・未開局：座位預覽（座位｜玩家｜第 1 場 → 第 2 場的階層｜參加）。勾選在「勾選參加」抽屜裡改（按鈕要夠大，桌卡裡放不下）。
function seatPreview(t) {
  const { room } = t;
  const plan = seatPlan(t);
  const nameCell = (uid) => trunc('b', `who-name${room.players?.[uid] ? '' : ' is-gone'}`, room.players?.[uid]?.name ?? '（已離開房間）');
  return h(
    'table',
    { class: 'tc-table is-seats' },
    h('thead', {}, h('tr', {}, ['座位', '玩家', `${matchText(1)} → ${matchText(2)}`, '參加'].map((text) => h('th', { attrs: { scope: 'col' }, text })))),
    h(
      'tbody',
      {},
      plan.rows.map((row) =>
        h(
          'tr',
          { class: row.include ? '' : 'is-off', data: { key: row.uid } },
          h('td', { class: 'num', text: row.order + 1 }),
          h('td', {}, nameCell(row.uid)),
          h('td', {}, passCell(t, row)),
          h('td', { class: row.include ? 'tc-yes' : 'tc-no', text: row.include ? '✓ 參加' : '不參加' }),
        ),
      ),
      plan.newcomers.map((uid) =>
        h(
          'tr',
          { class: 'is-off', data: { key: uid } },
          h('td', { text: '—' }),
          h('td', {}, nameCell(uid)),
          h('td', {}, trunc('span', 'tc-state', `未入座（${matchText(2)}不收新人）`)),
          h('td', { class: 'tc-no', text: '不能勾' }),
        ),
      ),
    ),
  );
}

function idleList(t) {
  const players = playersAt(t.room, t.number);
  if (players.length === 0) return h('p', { class: 'tc-empty', text: '還沒有玩家選這一桌' });
  return h(
    'ul',
    { class: 'tc-joined' },
    players.map(([uid, player]) => h('li', { data: { key: uid } }, trunc('b', 'who-name', player.name), h('span', { class: isOnline(t.room, uid) ? 'tc-online' : 'tc-offline', text: isOnline(t.room, uid) ? '已連線' : '離線' }))),
  );
}

// 今日事件（日出、白晝；這一回合觸發的迷霧事件在任何階段都列）或法案（黃昏、黑夜）或黑夜的手牌上限：最多兩行，太長「…」點一下看全文。
function infoLines(t, limits, { compact = false } = {}) {
  const { game, state } = t;
  if (!ctx.cardData) return [];
  const lines = [];
  const events = todaysEvents(game, state);
  for (const entry of events) {
    const event = eventOf(entry.event);
    const { effects, problems } = eventOutcome(entry);
    const label = entry.kind === 'fog' ? '事件' : '今日事件';
    const title = eventTitle(entry);
    const detail = [effects.replace(/^效果：/, ''), ...problems].filter(Boolean).join('；');
    const full = [`${label}　${title}`, event?.text, detail].filter(Boolean).join('\n');
    if (compact || events.length > 1) lines.push({ label, text: `${title}${detail ? `・${detail}` : ''}`, full, problem: problems.length > 0 });
    else lines.push({ label, text: title, full }, { label: '', text: detail || (event?.text ?? ''), full, problem: problems.length > 0 });
  }
  if (state.phase === 'dusk' || state.phase === 'night') {
    const stage = duskStage(game.dusk, state.round);
    if (stage === 'adjourned') lines.push({ label: '法案', text: '今天議會休會，沒有投票', full: '今天議會休會：法案都通過了，這一回合不投票' });
    else if (stage !== 'none') {
      const bill = billOf(game.dusk.bill);
      const title = billTitle(game.dusk.bill);
      const both = bill ? `通過：${billEffectText(bill.onPass)}｜不通過：${billEffectText(bill.onFail)}` : '卡牌資料裡找不到這張法案';
      if (stage === 'revealed') {
        const { passed } = game.dusk.result;
        let problem = '';
        if (!bill) problem = '卡牌資料裡找不到這張法案，效果沒有結算';
        else if (bill.todo === true) problem = '這張法案的效果還沒做好（todo），這次沒有結算';
        else if (skippedEffects(bill, passed).length) problem = `這張法案有 ${skippedEffects(bill, passed).length} 個效果要指定一人，這一版不結算，已略過`;
        const effect = bill ? `${passed ? '通過' : '沒有通過'}：${billEffectText(passed ? bill.onPass : bill.onFail)}` : '';
        const full = [`法案　${title}`, bill?.text, both, problem].filter(Boolean).join('\n');
        if (state.phase === 'night') lines.push({ label: '黃昏', text: `${title}${passed ? '通過' : '沒有通過'}`, full });
        else lines.push({ label: '法案', text: title, full }, { label: '', text: problem || effect, full, problem: Boolean(problem) });
      } else {
        const full = [`法案　${title}`, bill?.text, both].filter(Boolean).join('\n');
        lines.push({ label: '法案', text: title, full }, { label: '', text: both, full, problem: !bill });
      }
    }
  }
  // 黑夜揭曉後，手牌上限那句已經寫在狀態列的副標（nightStep），這裡就不再寫一次。
  const inStatus = state.phase === 'night' && nightStage(game.night, state.round) === 'revealed';
  if (limits.text && !inStatus) lines.unshift({ label: '手牌', text: limits.text, full: limits.text, problem: limits.problem });
  return lines.slice(0, compact ? 1 : 2);
}

function infoBlock(t, limits, options) {
  const lines = infoLines(t, limits, options);
  if (lines.length === 0) return null;
  return h(
    'div',
    { class: 'tc-info', data: { key: 'info' } },
    lines.map((line) =>
      h(
        'p',
        { class: `tc-info-line${line.problem ? ' is-problem' : ''}` },
        line.label ? h('span', { class: 'tc-info-label', text: line.label }) : null,
        trunc('span', 'tc-info-text', line.text, line.full),
      ),
    ),
  );
}

// 第 1 回合、還沒有人出過牌：選起始玩家（預設座位 0）。選了還沒按「指定」的值記在 startChoices，重畫時留著。
function startOrderRow(t) {
  const { room, game, key } = t;
  const current = startChoices.get(key) ?? game.startOrder ?? 0;
  return h(
    'div',
    { class: 'tc-start', data: { key: 'start-order' } },
    h('label', { class: 'tc-start-label', attrs: { for: `start-order-${key}` }, text: '第 1 回合起始玩家' }),
    h(
      'select',
      { class: 'select tc-select', attrs: { id: `start-order-${key}` }, data: { change: 'start-order', table: key } },
      seatsInOrder(game.seats).map(([uid, seat]) => h('option', { value: String(seat.order), selected: seat.order === current, text: `座位 ${seat.order + 1}：${nameOf(room, uid)}` })),
    ),
    h('button', { class: 'btn tc-btn', type: 'button', data: { act: 'start-order', table: key }, disabled: busy.has(`start-order:${key}`), text: '指定' }),
  );
}

const MINUTE = 60_000;

// 桌卡底部的日落鐘（game.js 的 sunsetStatus）：那一場有全場日落鐘就照全場鐘，沒有照這一桌從按「開始」起算（同改版前）。
function sunsetLine(room, key) {
  const game = room?.games?.[key];
  const status = ctx.cardData && game ? sunsetStatus(game, ctx.cardData.data.settings, serverTime(ctx.session), clockOf(room, key)) : null;
  if (!status) return '';
  const left = `剩 ${Math.ceil(status.remaining / MINUTE)} 分`;
  if (status.global) return status.passed ? '全場日落鐘　時間到了' : `全場日落鐘　${status.paused ? '暫停中・' : ''}${left}`;
  const elapsed = Math.floor(status.elapsed / MINUTE);
  return status.passed ? `日落鐘　開局 ${elapsed} 分・時間到了` : `日落鐘　開局 ${elapsed} 分・${left}`;
}

setInterval(() => tick(), 1000);

function linkButton(act, table, text, extra = {}) {
  return h('button', { class: `btn-link tc-link${extra.className ? ` ${extra.className}` : ''}`, type: 'button', data: { act, table, key: act }, disabled: busy.has(`${act}:${table}`), attrs: extra.attrs, text });
}

// 底部：第一行是日落鐘（終局寫算分的原因）與牌庫／棄牌；第二行左邊是「紀錄」「這回合結束後算分」（或取消），右邊是這一步的按鈕；
// 按鈕停用時第三行寫原因（照現行真正的條件），可以按但有要注意的事時寫提醒。
function footer(t, step) {
  const { game, state, key } = t;
  let clock = null;
  if (game && !t.ended && ctx.cardData && typeof game.startedAt === 'number') {
    clock = h('span', { class: 'tc-clock sunset-clock', data: { sunset: key }, text: sunsetLine(t.room, key) });
  } else if (t.ended && game?.final) {
    clock = trunc('span', 'tc-clock', endReasonText(game.final));
  } else if (!game && t.match !== 1) {
    clock = trunc('span', 'tc-clock', '勾選只存在這台裝置，換一台要重勾');
  }
  const links = [];
  if (game) {
    links.push(linkButton('log', key, '紀錄'));
    // 日落鐘到了或到了回合上限時，按不按都會算分：不顯示這個鈕（取消也沒用）；色帶上有「最後一回合」。
    if (!t.ended && ctx.cardData && (t.reason === null || t.reason === 'host')) {
      const marked = game.endAfterRound === state.round;
      links.push(linkButton('end-toggle', key, marked ? '取消提早算分' : '這回合結束後算分', { className: 'is-accent', attrs: { 'aria-pressed': String(marked) } }));
    }
  } else if (t.match !== 1) {
    links.push(linkButton('seats', key, '勾選參加', { className: 'is-accent' }), linkButton('final', key, `${matchText(1)}結算`));
  }
  const actions = step.actions.filter(Boolean);
  const why = actions.map((action) => (busy.has(`${action.act}:${key}`) ? '處理中…' : action.why)).find(Boolean) ?? null;
  const note = actions.find((action) => action.note)?.note ?? null;
  return h(
    'div',
    { class: 'tc-foot' },
    clock || game ? h('p', { class: 'tc-foot-info' }, clock ?? h('span'), game ? h('span', { class: 'tc-pile', text: `牌庫 ${game.deckCount ?? 0}・棄牌 ${game.discardCount ?? 0}` }) : null) : null,
    h(
      'div',
      { class: 'tc-foot-row' },
      h('div', { class: 'tc-links' }, links),
      h(
        'div',
        { class: 'tc-actions' },
        actions.map((action) => {
          const working = busy.has(`${action.act}:${key}`);
          return h('button', {
            class: `btn tc-btn${action.primary && !action.why ? ' btn-primary' : ''}`,
            type: 'button',
            data: { act: action.act, table: key, key: action.act, ...(action.data ?? {}) },
            disabled: Boolean(action.why) || working,
            text: action.label,
          });
        }),
      ),
    ),
    why || note ? h('p', { class: `reason tc-reason${why ? ' problem' : ''}`, text: why ?? note }) : null,
  );
}

function cardBody(t, step, limits) {
  const { game, state } = t;
  if (!game) return [statusRow(step), t.match === 1 ? idleList(t) : seatPreview(t)];
  if (t.ended) return [statusRow(step), game.final ? (t.match === 1 ? rankTable(t) : combinedTable(t)) : null];
  const showStart = state.round === 1 && !game.turn && !game.pending;
  // 起始玩家選單出現時（第 1 回合出牌前）今日事件縮成一行，5 人以上的桌不列（1280×800 不用捲動；事件在「紀錄」裡）。
  // 控制台的緊湊版桌卡一律一行。
  const seats = Object.keys(game.seats).length;
  const info = showStart && seats >= 5 ? null : infoBlock(t, limits, { compact: showStart || compactCards });
  return [statusRow(step), playerTable(t, limits), info, showStart ? startOrderRow(t) : null];
}

function tableCard(t, step, limits) {
  return h(
    'article',
    { class: `tcard tone-${t.tone} is-${step.kind}`, data: { key: `t${t.number}`, table: t.key }, attrs: { 'aria-labelledby': `tc-${t.number}-name` } },
    band(t),
    h('div', { class: 'tc-body' }, cardBody(t, step, limits), footer(t, step)),
  );
}

// ---- 頂列與備援主持申請 ----

const KIND_CHIPS = [
  ['ready', '✓ 可推進', '桌'],
  ['wait', '等待中', '桌'],
  ['judge', '待判定', ''],
  ['idle', '未開始', ''],
  ['done', '已結束', ''],
];

// 頂列分開數各桌在哪一場：第 1 場結束（還沒開第 2 場）、第 2 場進行中（含未開局）、第 2 場結束。都還在第 1 場時不列。
function matchChips(cards) {
  const count = (test) => cards.filter(({ t }) => test(t)).length;
  const chips = [
    ['first-end', `${matchText(1)}結束`, count((t) => t.match === 1 && t.ended)],
    ['second-live', `${matchText(2)}進行中`, count((t) => t.match !== 1 && !t.ended)],
    ['second-end', `${matchText(2)}結束`, count((t) => t.match !== 1 && t.ended)],
  ];
  if (chips.every(([, , n]) => n === 0)) return null;
  return h(
    'ul',
    { class: 'host-chips host-matches', data: { key: 'matches' }, attrs: { 'aria-label': '各桌在哪一場' } },
    chips.map(([key, label, n]) => h('li', { class: `chip-match${n ? '' : ' is-zero'}`, data: { key }, text: `${label} ${n} 桌` })),
  );
}

// 「已結束的桌全部開第 2 場」：字分兩行，頂列放得下。只做第 ① 步（各桌的座位要逐桌核對後按「開始第 2 場」）；有待判定的桌跳過，
// 確認框裡列出來。
function openAllButton(room) {
  const working = busy.has('open-all');
  const paused = isPaused(room);
  return h(
    'button',
    { class: 'btn top-btn host-open-all', type: 'button', data: { act: 'open-all', key: 'open-all' }, attrs: { title: paused ? PAUSED_TEXT : undefined }, disabled: working || paused },
    working ? h('span', { text: '處理中…' }) : [h('span', { text: '已結束的桌' }), h('span', { text: paused ? PAUSED_TEXT : `全部開${matchText(2)}` })],
  );
}

// 頂列：控制台開著時「已結束的桌全部開第 2 場」放進控制列；右邊多「控制台」切換（記在這台裝置）與「開投影畫面」（新視窗）。
// 網頁版本號（config.js 的 WEB_VERSION）寫在品牌下面，現場逐台核對每台都重新整理到新版。
function topBar(room, cards, mode = null) {
  const counts = new Map();
  for (const { step } of cards) counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1);
  const requests = requestList(room);
  const hosts = hostUids(room);
  const online = hosts.filter((uid) => isOnline(room, uid)).length;
  const firstEnded = !mode && cards.some(({ t }) => t.match === 1 && t.ended && t.game?.final);
  const matches = matchChips(cards);
  return [
    h(
      'div',
      { class: 'host-brand', data: { key: 'brand' } },
      h('p', { class: 'host-brand-title', text: '一日英國人' }),
      h('p', { class: 'host-brand-sub' }, '女皇陛下萬歲！・主持端', h('span', { class: 'host-version', text: `・第 ${WEB_VERSION} 版` })),
    ),
    h('div', { class: 'host-room', data: { key: 'room' } }, h('span', { class: 'host-room-label', text: '房號' }), h('strong', { class: 'host-room-code', attrs: { id: 'host-code', lang: 'en' }, text: ctx.code })),
    // 各狀態的桌數；有桌子到了第 1 場結束之後，下面多一行各場的桌數（兩行都改小號，頂列高度不變）。
    h(
      'div',
      { class: `host-status${matches ? ' has-matches' : ''}`, data: { key: 'status' } },
      h(
        'ul',
        { class: 'host-chips', data: { key: 'chips' }, attrs: { 'aria-label': '各桌狀態' } },
        KIND_CHIPS.filter(([kind]) => kind !== 'done' || counts.get('done')).map(([kind, label, unit]) => h('li', { class: `chip-${kind}${counts.get(kind) ? '' : ' is-zero'}`, data: { key: kind }, text: `${label} ${counts.get(kind) ?? 0}${unit ? ` ${unit}` : ''}` })),
      ),
      matches,
    ),
    firstEnded ? openAllButton(room) : null,
    h(
      'div',
      { class: 'host-top-right', data: { key: 'right' } },
      h('span', { class: 'host-online', text: `主持端 ${online} 台在線` }),
      h('button', {
        class: `btn top-btn host-console-toggle${consoleOn() ? ' is-on' : ''}`,
        type: 'button',
        data: { act: 'console-toggle' },
        attrs: { 'aria-pressed': String(consoleOn()), 'aria-controls': 'host-console', title: isWide() ? '控制列開或關（記在這台裝置）' : '控制台抽屜開或關（記在這台裝置）' },
        text: '控制台',
      }),
      h('button', { class: 'btn top-btn', type: 'button', data: { act: 'open-screen' }, attrs: { title: '在新視窗開投影畫面，拖到投影機那一邊' }, text: '開投影畫面' }),
      h('button', { class: `btn top-btn${requests.length ? ' is-alert' : ''}`, type: 'button', data: { act: 'requests' }, attrs: { 'aria-expanded': String(requestsOpen), 'aria-controls': 'host-requests' }, text: `備援主持申請 ${requests.length}` }),
      h('button', { class: 'btn top-btn', type: 'button', data: { act: 'leave' }, text: '離開' }),
      requestsOpen ? requestsPanel(room, requests, hosts, online) : null,
    ),
  ].filter(Boolean);
}

function requestList(room) {
  return Object.entries(room.hostRequests ?? {}).sort(([, a], [, b]) => a.requestedAt - b.requestedAt);
}

// 待核准的申請：主持端核對確認碼與對方畫面上的相同，再按核准。
function requestsPanel(room, requests, hosts, online) {
  return h(
    'div',
    { class: 'requests-panel', attrs: { id: 'host-requests', role: 'dialog', 'aria-label': '備援主持申請' } },
    h('div', { class: 'requests-head' }, h('p', { class: 'requests-title', text: '備援主持申請' }), h('button', { class: 'btn top-btn', type: 'button', data: { act: 'requests' }, text: '關閉' })),
    requests.length
      ? h(
          'ul',
          { class: 'requests-list' },
          requests.map(([uid]) =>
            h(
              'li',
              { class: 'request', data: { key: uid } },
              h('span', { class: 'request-label', text: '確認碼' }),
              h('strong', { class: 'request-code', attrs: { lang: 'en' }, text: confirmCode(uid) }),
              h('button', { class: 'btn btn-primary', type: 'button', data: { act: 'approve', uid }, disabled: busy.has(`approve:${uid}`), text: '核准' }),
              h('button', { class: 'btn', type: 'button', data: { act: 'reject', uid }, disabled: busy.has(`reject:${uid}`), text: '拒絕' }),
            ),
          ),
        )
      : h('p', { class: 'requests-empty', text: '目前沒有待核准的申請' }),
    h('p', { class: 'hint', text: '請對方念出畫面上的確認碼，跟這裡相同才按核准。' }),
    h('p', { class: 'hint', text: `目前主持端 ${hosts.length} 台，${online} 台在線` }),
  );
}

// ---- 抽屜：每桌的紀錄、終局的結算明細 ----

function drawerShell(t, kind, title, sub, content, note = null) {
  return h(
    'aside',
    { class: `drawer drawer-${kind}`, data: { key: `drawer-${kind}-${t.key}` }, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'drawer-title' } },
    h(
      'div',
      { class: `drawer-head tone-${t.tone}` },
      h('span', { class: `phase-icon phase-icon-${t.tone}`, attrs: { 'aria-hidden': 'true' } }),
      h('h2', { class: 'drawer-title', attrs: { id: 'drawer-title' }, text: title }),
      sub ? h('span', { class: 'drawer-sub', text: sub }) : null,
      h('button', { class: 'btn drawer-close', type: 'button', data: { act: 'close-drawer' }, attrs: { 'aria-label': '關閉' }, text: '×' }),
    ),
    note,
    h('div', { class: 'drawer-body', attrs: { tabindex: '-1' } }, content),
  );
}

// 第 2 場的「紀錄」可以切換看第 1 場（只讀；第 1 場已被規則鎖住）。第 2 場還沒開局時只有第 1 場。
function matchSwitch(t, view) {
  const button = (value, label, disabled = false) =>
    h('button', { class: 'btn drawer-switch-btn', type: 'button', data: { act: 'drawer-view', view: value, key: value }, attrs: { 'aria-pressed': String(view === value) }, disabled, text: label });
  return h(
    'div',
    { class: 'drawer-switch', attrs: { role: 'group', 'aria-label': '看哪一場' } },
    button('current', matchText(t.match), !t.game),
    button('first', `${matchText(1)}（只讀）`),
  );
}

function logDrawer(t) {
  const { room, state } = t;
  const first = t.match !== 1 && (drawer.view === 'first' || !t.game);
  const game = first ? t.first : t.game;
  const rounds = logRounds(logItems(room, game));
  const current = first || t.ended ? null : state.round;
  let sub = `${matchText(t.match)}・第 ${state.round} 回合・${PHASE_NAMES[state.phase] ?? state.phase}`;
  if (first) sub = `${matchText(1)}・${game.final ? endReasonText(game.final) : '已結束'}・只讀`;
  else if (t.ended) sub = `${matchText(t.match)}・${endReasonText(game.final)}`;
  const content = rounds.length
    ? rounds.map(({ round, items }) =>
        h(
          'section',
          { class: 'log-round', data: { key: `round-${round}` } },
          h('h3', { class: 'log-round-title' }, `第 ${round} 回合`, h('span', { class: round === current ? 'tag-live' : 'hint', text: round === current ? '進行中' : '已結束' })),
          h(
            'ol',
            { class: 'log-list' },
            items.map((item) =>
              h(
                'li',
                { class: `log-item is-${item.kind}` },
                h('span', { class: `log-icon is-${item.kind}`, text: item.icon, attrs: { 'aria-hidden': 'true' } }),
                h('div', { class: 'log-body' }, h('p', { class: 'log-title', text: item.title }), item.detail ? h('p', { class: 'log-detail', text: item.detail }) : null),
                h('span', { class: 'log-phase', text: PHASE_SHORT[item.phase] ?? '' }),
              ),
            ),
          ),
        ),
      )
    : [h('p', { class: 'hint', data: { key: 'none' }, text: '還沒有紀錄' })];
  return drawerShell(t, 'log', `第 ${t.number} 桌・紀錄`, sub, content, t.match !== 1 ? matchSwitch(t, first ? 'first' : 'current') : null);
}

function judgeButtons(t, uid, score) {
  const { done, points } = score.destiny;
  const working = busy.has(`judge:${t.key}:${uid}`);
  const button = (value, label) =>
    h('button', {
      class: `btn${done === undefined || done === null ? (value ? ' btn-primary' : '') : ''}`,
      type: 'button',
      data: { act: 'judge', table: t.key, uid, done: String(value), key: String(value) },
      attrs: { 'aria-pressed': String(done === value) },
      disabled: done === value || working,
      text: label,
    });
  const yes = done === true ? '✓ 已判定：達成' : done === false ? `改成：達成 +${points}` : `判定：達成 +${points}`;
  const no = done === false ? '✓ 已判定：沒達成' : done === true ? '改成：沒達成' : '判定：沒達成';
  return h('div', { class: 'fc-judge' }, button(true, yes), button(false, no));
}

// 一場的結算明細（每人一張，照名次）：天命內容、條件、是否達成、資產換算、公共成就、罪孽扣分、總分算式。locked＝第 1 場在第 2 場
// 開了之後被規則鎖住：只讀，不出現判定鈕。
function scoreCards(t, game, { locked = false } = {}) {
  return rankedScores(game).map(([uid, score]) => {
    const seat = game.seats[uid];
    const pending = score.destiny?.id && score.destiny.done !== true && score.destiny.done !== false;
    const rows = scoreRows(score).filter((row) => row.label !== '總分');
    return h(
      'section',
      { class: `fc${pending ? ' is-pending' : ''}`, data: { key: uid } },
      h(
        'div',
        { class: 'fc-head' },
        h('b', { class: 'fc-rank', text: `第 ${score.rank}` }),
        h('b', { class: 'fc-name', text: nameOf(t.room, uid) }),
        h('span', { class: 'fc-role', text: seat ? `${roleName(seat.role)}・座位 ${seat.order + 1}` : '' }),
        h('b', { class: 'fc-total', text: pending ? `${score.total}+?` : score.total }),
      ),
      h('dl', { class: 'fc-rows' }, rows.map((row) => [h('dt', { text: row.label }), h('dd', { text: row.detail }), h('dd', { class: 'fc-points', text: row.points })])),
      h('p', { class: 'fc-sum', text: `總分 ${scoreRows(score).find((row) => row.label === '總分').detail}` }),
      judgedByHost(score.destiny?.id) && !locked ? judgeButtons(t, uid, score) : null,
    );
  });
}

function finalPart(key, title, tag, content) {
  return h('section', { class: 'fc-part', data: { key } }, h('h3', { class: 'fc-part-title' }, title, tag ? h('span', { class: 'tag fc-part-tag', text: tag }) : null), content);
}

// 第 2 場結束的桌：兩場合計（名次｜名字｜第 1 場總分（名次）｜第 2 場總分（名次）｜合計；沒參加、待判定寫成文字）。
function combinedPart(t) {
  const { room, game, first } = t;
  const combined = combinedOf(room, t.number) ?? {};
  const table = h(
    'table',
    { class: 'fc-combined' },
    h('thead', {}, h('tr', {}, ['名次', '名字', `${matchText(1)}總分（名次）`, `${matchText(2)}總分（名次）`, '合計'].map((text) => h('th', { attrs: { scope: 'col' }, text })))),
    h(
      'tbody',
      {},
      Object.entries(combined).map(([uid, row]) =>
        h(
          'tr',
          { class: row.pending ? 'is-pending' : '', data: { key: uid } },
          h('td', { class: 'fc-combined-rank', text: `第 ${row.rank}${isTied(combined, row) ? '（並列）' : ''}` }),
          h('td', { text: nameOf(room, uid) }),
          h('td', { text: matchScoreText(row, first?.final, uid, 1) }),
          h('td', { text: `${matchScoreText(row, game.final, uid, 2)}${row.pending ? '・天命待判定' : ''}` }),
          h('td', { class: 'fc-combined-total', text: combinedTotalText(row) }),
        ),
      ),
    ),
  );
  return finalPart('part-combined', '兩場合計', null, [table, h('p', { class: 'hint', text: `合計＝兩場總分相加，同分並列；${matchText(2)}的天命勾了之後跟著變。` })]);
}

function finalDrawer(t) {
  const lockedNote = `${matchText(1)}已鎖定（${matchText(2)}已經開了），只能看、不能改。`;
  if (t.match === 1) {
    // 第 1 場結束、還沒開第 2 場：現有的明細，最上面一行提醒開了之後就不能改。
    const waiting = unjudged(t.game);
    const note = h(
      'div',
      { class: `drawer-note${waiting.length ? ' is-problem' : ''}`, attrs: { role: 'status' } },
      h('p', { class: 'drawer-note-lead', text: `開${matchText(2)}之後，${matchText(1)}的判定就不能再改。` }),
      h(
        'p',
        { text: waiting.length ? `還有 ${waiting.length} 份天命要你判定：判定前那份算 0 分、名次照現在的分數排；判定後分數與名次馬上更新，玩家手機也跟著更新。` : '天命都判定了，這就是這一場的名次（玩家手機上的一樣）。' },
      ),
    );
    return drawerShell(t, 'final', `第 ${t.number} 桌・${matchText(1)}結算明細`, endReasonText(t.game.final), scoreCards(t, t.game), note);
  }
  // 第 2 場：兩場合計、第 2 場明細（可以勾）、第 1 場明細（只讀、已鎖定）三段。第 2 場還沒結束時只有第 1 場明細。
  const second = t.ended && t.game?.final;
  const waiting = second ? unjudged(t.game) : [];
  const note = h(
    'p',
    { class: `drawer-note${waiting.length ? ' is-problem' : ''}`, attrs: { role: 'status' } },
    second
      ? waiting.length
        ? `${matchText(2)}還有 ${waiting.length} 份天命要你判定：判定前那份算 0 分；判定後兩場合計與名次馬上更新，玩家手機也跟著更新。`
        : '天命都判定了，這就是兩場合計的最後名次（玩家手機上的一樣）。'
      : lockedNote,
  );
  const parts = [];
  if (second) parts.push(combinedPart(t), finalPart('part-second', `${matchText(2)}明細`, null, scoreCards(t, t.game)));
  if (t.first?.final) parts.push(finalPart('part-first', `${matchText(1)}明細`, '已鎖定', [h('p', { class: 'hint', text: `${endReasonText(t.first.final)}・${lockedNote}` }), ...scoreCards(t, t.first, { locked: true })]));
  return drawerShell(t, 'final', `第 ${t.number} 桌・結算明細`, second ? `${matchText(2)}・${endReasonText(t.game.final)}` : `${matchText(2)}${t.game ? '進行中' : '・未開局'}`, parts, note);
}

// 第 2 場・未開局：勾選誰參加（按鈕夠大，放在抽屜裡），下面是「開始第 2 場」。
function seatsDrawer(t) {
  const plan = seatPlan(t);
  const step = pauseGuard(t, seatsStep(t));
  const [start] = step.actions;
  const working = busy.has(`start:${t.key}`);
  const rows = [
    ...plan.rows.map((row) =>
      h(
        'li',
        { class: `seat-row${row.include ? '' : ' is-off'}`, data: { key: row.uid } },
        h('span', { class: 'seat-no', text: `座位 ${row.order + 1}` }),
        h('div', { class: 'seat-body' }, h('b', { class: 'seat-name', text: nameOf(t.room, row.uid) }), h('span', { class: 'seat-pass', text: passText(t, row) })),
        h('button', { class: `btn seat-pick${row.include ? ' is-on' : ''}`, type: 'button', data: { act: 'seat-pick', table: t.key, uid: row.uid }, attrs: { 'aria-pressed': String(row.include) }, text: row.include ? '✓ 參加' : '不參加' }),
      ),
    ),
    ...plan.newcomers.map((uid) =>
      h(
        'li',
        { class: 'seat-row is-off', data: { key: uid } },
        h('span', { class: 'seat-no', text: '—' }),
        h('div', { class: 'seat-body' }, h('b', { class: 'seat-name', text: nameOf(t.room, uid) }), h('span', { class: 'seat-pass', text: `未入座（${matchText(2)}不收新人）` })),
        h('span', { class: 'seat-locked', text: '不能勾' }),
      ),
    ),
  ];
  const note = h(
    'div',
    { class: 'drawer-note' },
    h('p', { text: `每個座位${matchText(2)}拿到的階層照下表（由誰交過來）。沒勾的座位這場空著，交給它的階層${matchText(2)}沒有人坐；${matchText(1)}之後才加入的人不能勾（${matchText(2)}不收新人）。至少勾 1 人。` }),
    h('p', { class: 'hint', text: '勾選只存在這台裝置，換一台裝置要重勾。' }),
  );
  const why = working ? '處理中…' : start.why;
  const foot = h(
    'div',
    { class: 'drawer-foot', data: { key: 'foot' } },
    h('p', { class: `reason${why ? ' problem' : ''}`, text: why ?? step.sub }),
    h('button', { class: `btn${why ? '' : ' btn-primary'}`, type: 'button', data: { act: 'start', table: t.key, key: 'start' }, disabled: Boolean(why), text: start.label }),
  );
  return drawerShell(t, 'seats', `第 ${t.number} 桌・${matchText(2)}座位`, `勾了 ${plan.include.length} 人參加`, [h('ul', { class: 'seat-list', data: { key: 'seats' } }, rows), foot], note);
}

// 抽屜跟著目前那一局（另一台主持端開了第 2 場時，第 1 場的結算明細變成只讀）；這一局沒有可以看的就關掉。
function drawerLayer(room) {
  if (!drawer) return [];
  const t = tableModel(room, activeKey(room, drawer.table));
  const first = Boolean(t?.first?.final);
  let panel = null;
  if (t && drawer.kind === 'log' && (t.game || first)) panel = logDrawer(t);
  else if (t && drawer.kind === 'final' && ((t.ended && t.game?.final) || first)) panel = finalDrawer(t);
  else if (t && drawer.kind === 'seats' && t.match !== 1 && !t.game) panel = seatsDrawer(t);
  if (!panel) {
    drawer = null;
    return [];
  }
  return [h('div', { class: 'scrim', data: { key: 'scrim', act: 'close-drawer' } }), panel];
}

// ---- 「開第 2 場」的確認框（只做第 ① 步）----

// 要開哪幾桌：第 1 場結束、有結算、沒有待判定的天命；有待判定的桌跳過（寫出張數）。一桌的確認框在那一桌已經不是第 1 場結束時關掉。
function openPlan(room, request) {
  const ended = [];
  for (let number = 1; number <= room.meta.tableCount; number += 1) {
    if (request.kind === 'one' && number !== request.table) continue;
    const t = tableModel(room, activeKey(room, number));
    if (t?.match === 1 && t.ended && t.game?.final) ended.push(t);
  }
  if (ended.length === 0) return null;
  const waitingOf = (t) => pendingDestinies(t.game.final.scores).length;
  return { ready: ended.filter((t) => waitingOf(t) === 0), skipped: ended.filter((t) => waitingOf(t) > 0).map((t) => ({ number: t.number, waiting: waitingOf(t) })) };
}

function confirmLayer(room) {
  if (!confirming) return [];
  const scrim = h('div', { class: 'scrim is-confirm', data: { key: 'confirm-scrim', act: 'cancel-confirm' } });
  if (confirming.kind !== 'one' && confirming.kind !== 'all') {
    const dialog = consoleDialog(room);
    if (!dialog) {
      confirming = null;
      return [];
    }
    return [scrim, dialog];
  }
  const plan = openPlan(room, confirming);
  if (!plan) {
    confirming = null;
    return [];
  }
  const one = confirming.kind === 'one';
  const list = (items) => items.map((item) => `第 ${item.number} 桌`).join('、');
  let why = null;
  if (!ctx.cardData) why = ctx.cardsFailed ? '卡牌資料有問題，請找工作人員' : '卡牌資料讀取中…';
  else if (isPaused(room)) why = PAUSED_TEXT;
  else if (plan.ready.length === 0) why = '沒有可以開的桌：天命都要先判定完';
  const working = busy.has('open-all') || plan.ready.some((t) => busy.has(`open-match:${t.key}`));
  return [
    scrim,
    h(
      'div',
      { class: 'confirm', data: { key: 'confirm' }, attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-title', 'aria-describedby': 'confirm-text' } },
      h('h2', { class: 'confirm-title', attrs: { id: 'confirm-title' }, text: one ? `開第 ${confirming.table} 桌的${matchText(2)}？` : `已結束的桌全部開${matchText(2)}？` }),
      h('p', { class: 'confirm-text', attrs: { id: 'confirm-text' }, text: `開了${matchText(2)}，${matchText(1)}的結算就鎖住，不能再改。` }),
      !one && plan.ready.length ? h('p', { class: 'confirm-line', text: `要開：${list(plan.ready)}（${plan.ready.length} 桌）` }) : null,
      plan.skipped.length ? h('p', { class: 'confirm-line is-problem', text: `跳過（天命待判定，先在結算明細勾）：${plan.skipped.map((item) => `第 ${item.number} 桌 ${item.waiting} 張`).join('、')}` }) : null,
      h('p', { class: 'hint', text: `開了之後玩家手機上會看到自己${matchText(2)}的階層；座位在各桌核對後，逐桌按「開始${matchText(2)}」。` }),
      why ? h('p', { class: 'reason problem', text: why }) : null,
      h(
        'div',
        { class: 'confirm-actions' },
        h('button', { class: 'btn', type: 'button', data: { act: 'cancel-confirm', key: 'cancel' }, text: '取消' }),
        h('button', { class: `btn${why ? '' : ' btn-primary'}`, type: 'button', data: { act: 'confirm-open', key: 'ok' }, disabled: Boolean(why) || working, text: one ? `開${matchText(2)}` : `開${matchText(2)}（${plan.ready.length} 桌）` }),
      ),
    ),
  ];
}

// ---- 控制台：開關、純函式（文字、網址、按鈕能不能按） ----

export const CONSOLE_MIN_WIDTH = 1360;
export const CONSOLE_MIN_HEIGHT = 860;
const OFFLINE_TEXT = '離線中，連回來才能操作';
const SCENES = [
  ['opening', '開場影片'],
  ['rules', '規則說明'],
  ['overview', '比賽中總覽'],
  ['standings', '兩場合計排行'],
  ['awards', '頒獎'],
];
const SCENE_LABELS = Object.fromEntries(SCENES);
const PAGED_SCENES = new Set(['rules', 'awards']); // 有 ◀ ▶ 換頁的場景
const SFX_LABELS = { bell: '日落大鐘', gavel: '法槌' };
const ABSENT_TEXT = { left: '已離開', moved: '換到別桌', unchecked: '被勾掉' };
// 廣播的常用句（只是幫忙填進輸入框，送出前照樣看得到、改得了）。
const PHRASES = ['請各桌派一人到前台', '休息 10 分鐘，請在座位上稍候', '比賽即將開始，請回到自己的座位', '請把手機調成靜音', '日落鐘剩 10 分鐘', '第 1 場結束，請準備交接角色卡', '頒獎典禮即將開始'];

// 寬螢幕（寬 1360、高 860 以上）：控制列在頂列下面、桌卡改緊湊版。其他是窄螢幕：控制台預設關，點開是上方抽屜。
export function consoleWide(width, height) {
  return width >= CONSOLE_MIN_WIDTH && height >= CONSOLE_MIN_HEIGHT;
}

function isWide() {
  return consoleWide(window.innerWidth, window.innerHeight);
}

// 控制台開著沒：這台裝置選過就照選的，沒選過照視窗大小。
function consoleOn() {
  return consolePref === 'on' || (consolePref === null && isWide());
}

// 控制列的樣子：'bar'（寬螢幕，頂列下面一條）、'fold'（收合成一行）、'drawer'（窄螢幕的上方抽屜）、null（關著）。
function consoleMode() {
  if (!consoleOn()) return null;
  if (!isWide()) return 'drawer';
  return folded ? 'fold' : 'bar';
}

// 毫秒 → 「33:52」（分鐘可以超過 60）。剩餘無條件進位（還沒到不會先顯示 0:00），已進行（up）捨去。
export function clockText(ms, { up = false } = {}) {
  const total = Math.max(0, up ? Math.floor(ms / 1000) : Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// 伺服器時間 → 這台的時刻「18:44」（seconds 時「18:44:05」）。offset＝伺服器時間 − 本機時間。
export function wallTime(serverMs, offset = 0, { seconds = false } = {}) {
  const date = new Date(serverMs - offset);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ''}`;
}

// 日落鐘加減了多少：「＋5 分」「－1 分」；不是整分鐘（夾到上限或減到底）時寫到秒「－2 分 58 秒」。
export function deltaText(ms) {
  const sign = ms < 0 ? '－' : '＋';
  const seconds = Math.round(Math.abs(ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  if (seconds % 60 === 0) return `${sign}${minutes} 分`;
  return `${sign}${minutes ? `${minutes} 分 ` : ''}${seconds % 60} 秒`;
}

// 指令是誰下的：「這台」或「別台（K7Q2）」（by 是那台主持端的 uid，確認碼同備援主持那一套）。
export function byText(by, self) {
  if (!by) return '';
  return by === self ? '這台' : `別台（${confirmCode(by)}）`;
}

// 投影畫面的網址：同一頁加 view=screen、room；保留目前網址的 env（本機模擬器或正式站）。「開投影畫面」的新視窗加 slot=screen
// （同一個瀏覽器時不跟主持端共用身分）；控制列的小預覽加 preview=1、slot=preview。search 是 location.search。
export function screenUrl(search, code, { preview = false } = {}) {
  const env = new URLSearchParams(search).get('env');
  const params = new URLSearchParams({ view: 'screen', room: code });
  if (preview) params.set('preview', '1');
  params.set('slot', preview ? 'preview' : 'screen');
  if (env) params.set('env', env);
  return `?${params}`;
}

// 控制台指令的錯誤 → 結果條的一句（docs/CONSOLE-API.md 第 6 節）。clock＝日落鐘的指令；conflict 帶的最新那一筆用 describe(latest)
// 寫成「現在剩 33:52」這種。不是 StoreError 的（權限以外的連線錯誤會原樣丟出來）照錯誤的代碼寫。
export function commandError(error, { clock = false, describe = null } = {}) {
  if (!(error instanceof StoreError)) {
    const detail = error?.code ?? error?.message ?? '';
    return `沒有成功${detail ? `（${detail}）` : ''}，請確認連線後再按一次`;
  }
  if (error.code === 'rules-outdated') return clock ? '日落鐘控制要等規則更新，各桌照舊各自計時' : `${error.message}（資料庫規則還沒發布）`;
  if (error.code === 'conflict') {
    const latest = describe ? describe(error.latest ?? null) : '';
    return `別台剛改過${latest ? `，${latest}` : ''}；看清楚再按一次`;
  }
  return error.message;
}

// 「能推的全推」確認框的一桌：「第 3 桌：黑夜 → 第 4 回合日出（會發牌）」「第 2 桌：黑夜 → 算分（日落鐘到了…）」，後面接原本的提醒。
export function advanceLine(item) {
  const from = PHASE_NAMES[item.phase] ?? item.phase;
  const to =
    item.to.phase === 'end'
      ? `算分（${END_REASON_TEXT[item.ending] ?? item.ending}，算分後不能回頭）`
      : `${item.to.round !== item.round ? `第 ${item.to.round} 回合` : ''}${PHASE_NAMES[item.to.phase] ?? item.to.phase}${item.deal ? '（會發牌）' : ''}`;
  const match = item.match === 1 ? '' : `${matchText(item.match)}・`;
  return `第 ${item.table} 桌：${match}${from} → ${to}${item.note ? `；${item.note}` : ''}`;
}

// 「能推的全推」一桌的結果（store.js 的 advanceAll；item 是計畫裡的那一桌）：{ ok, text }。
export function advanceResult(result, item = null) {
  const name = `第 ${result.table} 桌`;
  if (result.error && result.advanced) return { ok: false, text: `${name}：推進了，但發牌沒成功（${commandError(result.error)}），請按那一桌的「補發」` };
  if (result.error) return { ok: false, text: `${name}：${commandError(result.error)}` };
  if (result.held) return { ok: false, text: `${name}：這一回合要算分，沒推（要算分請在那一桌按「下一階段（算分）」）` };
  if (!result.advanced) return { ok: false, text: `${name}：局面已經變了，沒有動` };
  if (result.ended) return { ok: true, text: `${name}：已算分（${END_REASON_TEXT[result.reason] ?? result.reason}）` };
  const to = item ? `${item.to.round !== item.round ? `第 ${item.to.round} 回合` : ''}${PHASE_NAMES[item.to.phase] ?? item.to.phase}` : '下一階段';
  return { ok: true, text: `${name}：${to}${result.dealt ? '（已發牌）' : ''}` };
}

// 「全部開始」「全部開始第 2 場」一桌的結果（store.js 的 startAll）：{ ok, text }。started 是 false 又沒有錯＝別台先開了。
export function startResult(result, item = null) {
  const name = `第 ${result.table} 桌`;
  if (result.error) return { ok: false, text: `${name}：${commandError(result.error)}` };
  if (!result.started) return { ok: true, text: `${name}：別台先開了` };
  return { ok: true, text: `${name}：已開局${item?.count ? `（${item.count} 人）` : ''}` };
}

// 日落鐘按鈕的停用原因（null＝可以按）：toggle（暫停／繼續）、minus、plus。日落後都不能按；累計加減到上限的那一邊不能按；
// 全場暫停中不能手動暫停或繼續（恢復全場時被它停住的鐘一起繼續，手動繼續的鐘會在暫停中一路走）。
export function clockGuards(clock, now, { paused = false } = {}) {
  if (!isClock(clock)) return null;
  const sunset = '已經日落了，不能再暫停或加減';
  if (clockPassed(clock, now)) return { toggle: sunset, minus: sunset, plus: sunset };
  const adjust = clock.adjust ?? 0;
  const cap = CLOCK_ADJUST_MAX_MS / MINUTE;
  return {
    toggle: paused ? '全場暫停中：恢復全場時日落鐘會一起繼續' : null,
    minus: adjust <= -CLOCK_ADJUST_MAX_MS ? `累計已經減了 ${cap} 分（上限）` : null,
    plus: adjust >= CLOCK_ADJUST_MAX_MS ? `累計已經加了 ${cap} 分（上限）` : null,
  };
}

// 控制列要顯示哪幾場的日落鐘：[1]、[2]，或第 1 場還有桌在打（已開局、還沒算分）而且有桌開了第 2 場時兩個並排 [1, 2]。
export function clockMatches(room) {
  let first = false;
  let second = Boolean(room?.clock?.[MATCH_COUNT]);
  for (let table = 1; table <= (room?.meta?.tableCount ?? 0); table += 1) {
    if (room.tables?.[matchKey(table, MATCH_COUNT)]) second = true;
    else if (room.games?.[matchKey(table)] && room.tables?.[matchKey(table)]?.phase !== 'end') first = true;
  }
  if (!second) return [1];
  return first ? [1, MATCH_COUNT] : [MATCH_COUNT];
}

// 統一開始第 match 場的全場日落鐘時，已開局（還沒算分）的各桌怎麼變：[{ table, text, problem }]。原本照各桌從開局起算，之後照全場鐘
// （剛開的鐘＝minutes 分）；原本因為日落這一回合就是最後一回合、改了之後不是的，標成 problem（主持人要知道）。
export function clockStartChanges(room, match, minutes, settings, now) {
  const fresh = clockStartWrite(minutes, now);
  const changes = [];
  for (let table = 1; table <= (room?.meta?.tableCount ?? 0); table += 1) {
    const key = matchKey(table, match);
    const state = room.tables?.[key];
    const game = room.games?.[key];
    if (!state || !game?.seats || state.phase === 'end') continue;
    const before = sunsetStatus(game, settings, now, null);
    const lost = endReasonAt(game, state, settings, now, null) === 'sunset' && endReasonAt(game, state, settings, now, fresh) !== 'sunset';
    const left = before.passed ? '原本已經日落' : `原本還剩 ${Math.ceil(before.remaining / MINUTE)} 分`;
    changes.push({ table, problem: lost, text: `第 ${table} 桌：${left}，改照全場鐘是 ${minutes} 分${lost ? '（這一回合本來結束就算分，改了之後不是最後一回合）' : ''}` });
  }
  return changes;
}

// 投影端狀態（rooms/{code}/screens）：每一台的確認碼、聲音開了沒、場景跟上了沒、最後回報時間（照最後回報排）。投影端只在解鎖聲音與
// 換場景時回報、斷線時伺服器代為刪除，所以「最新的場景切換已經過了 SCREEN_LAG_MS 還沒跟上」的標成灰色（可能當掉或網路卡住）。
// 這一筆任何登入的人都能寫自己的（可能是假的），所以一定列出確認碼與時間，不只寫「聲音已開」。
export const SCREEN_LAG_MS = 10_000;

export function screenRows(screens, scene, now, self) {
  return Object.entries(screens ?? {})
    .filter(([, value]) => value && typeof value === 'object')
    .map(([uid, value]) => {
      const synced = !scene || value.scene === scene.seq;
      return {
        uid,
        code: confirmCode(uid),
        self: uid === self,
        audio: value.audio === true,
        synced,
        lagging: !synced && typeof scene?.at === 'number' && now - scene.at > SCREEN_LAG_MS,
        at: typeof value.at === 'number' ? value.at : null,
      };
    })
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

// ---- 控制台：畫面 ----

function offsetNow() {
  return serverTime(ctx.session) - Date.now();
}

function noDataText() {
  return ctx.cardsFailed ? '卡牌資料有問題，請找工作人員' : '卡牌資料讀取中…';
}

function tablesText(items) {
  return `第 ${items.map((item) => item.table).join('、')} 桌`;
}

function panel(key, title, content, extra = '') {
  return h('section', { class: `cs-panel cs-${key}${extra ? ` ${extra}` : ''}`, data: { key }, attrs: { 'aria-label': title } }, h('h2', { class: 'cs-title', text: title }), content);
}

function csButton(act, label, { why = null, data = {}, className = '', busyKey = null, pressed } = {}) {
  const working = busyKey !== null && busy.has(busyKey);
  return h('button', {
    class: `btn cs-btn${className ? ` ${className}` : ''}`,
    type: 'button',
    data: { act, ...data },
    attrs: { title: why ?? undefined, 'aria-pressed': pressed === undefined ? undefined : String(pressed) },
    disabled: Boolean(why) || working,
    text: label,
  });
}

// 全場動作：能推的全推、全部開始、已結束的桌全部開第 2 場、全部開始第 2 場。都先開確認框，確認框列出計畫。
function actionsPanel(view) {
  const { room, now, off, paused } = view;
  const data = ctx.cardData?.data ?? null;
  const common = off ? OFFLINE_TEXT : paused ? PAUSED_TEXT : data ? null : noDataText();
  const advance = data ? advancePlan(room, data.settings, now, { discards: submissions.discards }) : null;
  const start = data ? startPlan(room, data) : null;
  const second = data ? startMatch2Plan(room, data, seatPicks) : null;
  const open = openPlan(room, { kind: 'all' });
  const working = ['advance-all', 'start-all', 'start-all-2', 'open-all'].some((key) => busy.has(key));

  const advanceWhy = common ?? (working ? '處理中…' : advance.advance.length ? null : '沒有可以推的桌');
  let advanceNote = advanceWhy;
  if (!advanceWhy) advanceNote = `${tablesText(advance.advance)}；按了會先列出來確認`;
  else if (!common && advance) {
    const ending = advance.skip.filter((item) => item.reason === 'ending');
    if (ending.length) advanceNote = `${tablesText(ending)}這一回合要算分，在確認框另外勾`;
  }

  let startWhy = common;
  if (!startWhy && start.start.length === 0) startWhy = start.started.length && start.skip.length === 0 ? `${start.started.length} 桌都開始了` : start.started.length || start.skip.length ? '沒有可以開的桌' : '第 1 場都結束了';
  let openWhy = off ? OFFLINE_TEXT : paused ? PAUSED_TEXT : data ? null : noDataText();
  if (!openWhy && !open) openWhy = `還沒有桌打完${matchText(1)}`;
  else if (!openWhy && open.ready.length === 0) openWhy = '天命都要先判定完';
  let secondWhy = common;
  if (!secondWhy && second.start.length === 0) secondWhy = second.started.length ? `${matchText(2)}都開始了` : second.skip.length ? '沒有可以開的桌' : `還沒有桌開${matchText(2)}`;

  // 停用的鈕原因寫在滑鼠提示（title），也寫在下面那一格（最該看的那一個）。
  const small = (act, title, why, count) =>
    h('button', { class: 'btn cs-btn cs-small', type: 'button', data: { act }, attrs: { title: why ?? undefined }, disabled: Boolean(why) || working, text: why ? title : `${title}・${count} 桌` });
  let status = '';
  if (progress) status = `${progress.label} ${progress.done}／${progress.total}`;
  else if (working) status = '處理中…';
  else if (!common && !startWhy) status = '可以一起開全場日落鐘';
  else if (!common && !openWhy) status = `第 1 場結束的桌可以開${matchText(2)}`;
  else if (!common && !secondWhy) status = `可以一起開${matchText(2)}的日落鐘`;
  else status = common ?? (open ? (secondWhy ?? openWhy) : startWhy) ?? '';
  return panel('actions', '全場動作', [
    h(
      'button',
      { class: `btn cs-btn cs-advance${advanceWhy ? '' : ' btn-primary'}`, type: 'button', data: { act: 'advance-all' }, attrs: { title: advanceWhy ?? undefined }, disabled: Boolean(advanceWhy) },
      advance && advance.advance.length ? `能推的全推下一階段・${advance.advance.length} 桌` : '能推的全推下一階段',
    ),
    trunc('p', 'cs-note', advanceNote ?? ''),
    h(
      'div',
      { class: 'cs-grid2' },
      small('start-all', '全部開始', startWhy, start?.start.length),
      small('open-all', `全部開${matchText(2)}`, openWhy, open?.ready.length),
      small('start-all-2', `全部開始${matchText(2)}`, secondWhy, second?.start.length),
      trunc('p', `cs-note cs-busy${progress || working ? ' is-on' : ''}`, status),
    ),
  ]);
}

// 一場的日落鐘：剩餘（大字）、已進行、預計日落時刻（本機時間）、進度條、暫停／繼續、－5／－1／＋1／＋5。small＝兩場並排的小鐘。
function clockBox(view, match, small) {
  const clock = view.room.clock?.[match];
  if (!isClock(clock)) return noClockBox(view, match, small);
  const { now, off } = view;
  const guards = clockGuards(clock, now, { paused: view.paused });
  const paused = clockPaused(clock);
  const passed = clockPassed(clock, now);
  const key = `clock:${match}`;
  const working = busy.has(key);
  const lock = off ? OFFLINE_TEXT : working ? '處理中…' : null;
  const adjustButton = (minutes) =>
    csButton('clock-adjust', `${minutes > 0 ? '＋' : '－'}${Math.abs(minutes)}${small ? '' : ' 分'}`, {
      why: lock ?? (minutes < 0 ? guards.minus : guards.plus),
      data: { match, delta: minutes * MINUTE },
      className: 'cs-step',
    });
  const note = guards.toggle && !passed ? guards.toggle : passed ? '日落了：各桌這一回合結束就算分；日落後不能再加回來' : '加減只移動日落時刻，已進行的時間不會倒退';
  return h(
    'div',
    { class: `cs-clock${small ? ' is-small' : ''}${paused ? ' is-paused' : ''}${passed ? ' is-passed' : ''}`, data: { key: `clock-${match}`, clock: match } },
    h(
      'div',
      { class: 'cs-clock-main' },
      h('b', { class: 'cs-remaining', text: clockText(clockRemaining(clock, now)) }),
      h(
        'div',
        { class: 'cs-clock-side' },
        h('span', { class: 'tag cs-match', text: `${matchText(match)}${passed ? '・已日落' : paused ? '・暫停中' : ''}` }),
        h('span', { class: 'cs-elapsed', text: `已進行 ${clockText(clockElapsed(clock, now), { up: true })}` }),
        h('span', { class: 'cs-sunset', text: sunsetAtText(clock, now) }),
      ),
    ),
    h('div', { class: 'cs-progress', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'cs-progress-fill', style: { width: `${progressOf(clock, now)}%` } })),
    h(
      'div',
      { class: 'cs-clock-btns' },
      paused
        ? csButton('clock-resume', small ? '▶' : '▶ 繼續', { why: lock ?? guards.toggle, data: { match }, className: 'cs-toggle' })
        : csButton('clock-pause', small ? '⏸' : '⏸ 暫停', { why: lock ?? guards.toggle, data: { match }, className: 'cs-toggle' }),
      [-5, -1, 1, 5].map(adjustButton),
    ),
    trunc('p', 'cs-note', small ? `${clock.by ? `最後由${byText(clock.by, ctx.session.uid)}改・` : ''}${note}` : `${note}${clock.by ? `（最後由${byText(clock.by, ctx.session.uid)}改）` : ''}`),
  );
}

function progressOf(clock, now) {
  const length = clockLength(clock);
  return length > 0 ? Math.max(0, Math.min(100, (clockElapsed(clock, now) / length) * 100)) : 100;
}

function sunsetAtText(clock, now) {
  if (clockPassed(clock, now)) {
    const at = clockSunsetAt(clock);
    return at === null ? '已經日落' : `${wallTime(at, offsetNow())} 日落了`;
  }
  const at = clockSunsetAt(clock);
  return at === null ? '暫停中，不會日落' : `預計 ${wallTime(at, offsetNow())} 日落`;
}

// 那一場還沒有全場日落鐘：各桌各自計時，按「統一開始全場日落鐘」開（確認框寫已開局的桌會怎麼變）。第 2 場要有桌開始了第 2 場才能開
// （store.js 不檢查；太早開會吃掉第 2 場的時間）。
function clockStartWhy(view, match) {
  if (view.off) return OFFLINE_TEXT;
  if (view.paused) return '全場暫停中，恢復之後再開';
  if (!ctx.cardData) return noDataText();
  const error = startPlan(view.room, ctx.cardData.data).clock.error;
  if (error) return error;
  let started = false;
  for (let table = 1; table <= view.room.meta.tableCount; table += 1) if (view.room.games?.[matchKey(table, match)]) started = true;
  if (!started) return match === 1 ? '還沒有桌開局（可以在「全部開始」時一起開）' : `還沒有桌開始${matchText(2)}（可以在「全部開始${matchText(2)}」時一起開）`;
  return busy.has(`clock:${match}`) ? '處理中…' : null;
}

function noClockBox(view, match, small) {
  const minutes = ctx.cardData?.data.settings.sunsetMinutes;
  const why = clockStartWhy(view, match);
  return h(
    'div',
    { class: `cs-clock is-none${small ? ' is-small' : ''}`, data: { key: `none-${match}` } },
    h('div', { class: 'cs-clock-main' }, h('span', { class: 'tag cs-match', text: matchText(match) }), h('b', { class: 'cs-none-text', text: '各桌各自計時' })),
    h('p', { class: 'cs-note', text: '從各桌按「開始」起算' }),
    csButton('clock-start', `統一開始全場日落鐘${minutes ? `（${minutes} 分）` : ''}`, { why, data: { match }, className: 'cs-wide' }),
    trunc('p', 'cs-note', why ?? '開了之後這一場所有桌一起日落'),
  );
}

function clockPanel(view) {
  const matches = clockMatches(view.room);
  return panel('clock', '日落鐘・全場', h('div', { class: `cs-clocks${matches.length > 1 ? ' is-two' : ''}` }, matches.map((match) => clockBox(view, match, matches.length > 1))));
}

// 投影畫面：小預覽（把投影畫面縮小放在 iframe 裡；旁邊用文字寫目前的場景與頁碼，不靠 iframe）、五顆場景鈕、規則與頒獎的 ◀ ▶。
function scenePanel(view) {
  const { room, off } = view;
  const scene = room.display?.scene ?? null;
  const current = SCENE_LABELS[scene?.id] ? scene.id : null;
  const page = Number.isInteger(scene?.page) ? scene.page : 0;
  const lock = off ? OFFLINE_TEXT : busy.has('scene') ? '處理中…' : null;
  const now = current ? `投影中：${SCENE_LABELS[current]}${PAGED_SCENES.has(current) ? `・第 ${page + 1} 頁` : ''}` : '還沒有切過場景';
  const who = scene?.by ? `${byText(scene.by, ctx.session.uid)}${typeof scene.at === 'number' ? ` ${wallTime(scene.at, offsetNow())}` : ''} 切的` : '投影那台先顯示「開始投影」頁';
  const paged = PAGED_SCENES.has(current);
  const pageWhy = lock ?? (paged ? null : '規則說明、頒獎才有換頁');
  return panel('scene', '投影畫面', [
    h(
      'div',
      { class: 'cs-scene-side' },
      h(
        'div',
        { class: 'cs-preview', data: { key: 'preview' } },
        h('iframe', { class: 'cs-preview-frame', attrs: { src: screenUrl(location.search, ctx.code, { preview: true }), title: '投影畫面的縮小預覽', tabindex: '-1', loading: 'lazy' } }),
      ),
      trunc('p', 'cs-scene-now', now),
      trunc('p', 'cs-note', who),
    ),
    h(
      'div',
      { class: 'cs-scene-btns' },
      SCENES.map(([id, label]) =>
        h(
          'button',
          { class: `btn cs-btn cs-scene-btn${id === current ? ' is-live' : ''}`, type: 'button', data: { act: 'scene', scene: id, key: id }, attrs: { 'aria-pressed': String(id === current), title: lock ?? undefined }, disabled: Boolean(lock) },
          h('span', { text: label }),
          id === current ? h('small', { class: 'cs-live', text: '投影中' }) : null,
        ),
      ),
      h(
        'div',
        { class: 'cs-pager', data: { key: 'pager' }, attrs: { role: 'group', 'aria-label': '換頁' } },
        csButton('scene-page', '◀', { why: pageWhy ?? (page <= 0 ? '已經是第 1 頁' : null), data: { step: -1 }, className: 'cs-step' }),
        csButton('scene-page', '▶', { why: pageWhy ?? (page >= SCENE_PAGE_MAX ? '已經是最後一頁' : null), data: { step: 1 }, className: 'cs-step' }),
      ),
    ),
  ]);
}

// 音效台：日落大鐘、法槌（一次性）、開場音樂（播放／停止）；延遲與「開始投影」的說明；投影端狀態（screens）。
function soundPanel(view) {
  const { room, off, now } = view;
  const music = room.display?.music ?? null;
  const playing = music?.on === true;
  const lock = off ? OFFLINE_TEXT : null;
  const rows = screenRows(room.screens, room.display?.scene ?? null, now, ctx.session.uid);
  const offset = offsetNow();
  const screenLine = (row) => `${row.self ? '這台' : row.code}・${row.audio ? '聲音已開' : '聲音未開'}・${row.synced ? '場景已跟上' : '場景沒跟上'}・${row.at ? wallTime(row.at, offset, { seconds: true }) : '—'}`;
  const screenFull = (row) =>
    [`投影端 ${row.code}${row.self ? '（這台）' : ''}`, row.audio ? '聲音已開（按過「開始投影」）' : '聲音還沒開：投影那台要按「開始投影」', row.synced ? '已經照最新的場景畫' : '還沒照最新的場景畫', `最後回報 ${row.at ? wallTime(row.at, offset, { seconds: true }) : '—'}`].join('\n');
  const stale = rows.find((row) => !row.synced && !row.lagging);
  if (stale && typeof room.display?.scene?.at === 'number') rerenderAt(room.display.scene.at + SCREEN_LAG_MS + 100);
  // 投影端一般是一台：一行寫第一台，還有別台就接「另 N 台」，全部的內容點一下看（每台一段）。
  const [first] = rows;
  const more = rows.length > 1 ? `・另 ${rows.length - 1} 台` : '';
  return panel('sound', '音效・在投影端播', [
    h(
      'div',
      { class: 'cs-sfx' },
      ['bell', 'gavel'].map((id) => csButton('sfx', `♪ ${SFX_LABELS[id]}`, { why: lock, data: { sfx: id, key: id }, busyKey: 'sfx' })),
      csButton('music', playing ? '■ 停止開場音樂' : '▶ 開場音樂', { why: lock, data: { on: String(!playing), key: 'music' }, busyKey: 'music', className: `cs-music${playing ? ' is-on' : ''}`, pressed: playing }),
    ),
    trunc('p', 'cs-note', '經資料庫傳過去，約 0.2–1 秒才響（不適合對拍）'),
    trunc('p', 'cs-note', '投影那台要先按「開始投影」才有聲音'),
    first
      ? h(
          'p',
          { class: `cs-screens ${first.lagging ? 'is-stale' : first.audio ? 'is-ok' : 'is-warn'}`, attrs: { 'aria-label': '投影端狀態' } },
          trunc('span', 'cs-screen-text', `投影端 ${screenLine(first)}${more}`, rows.map(screenFull).join('\n')),
        )
      : trunc('p', 'cs-screens is-empty', '投影端：還沒有連上（按頂列「開投影畫面」）'),
  ]);
}

// 全場廣播：1–40 字（還剩幾字）、預覽「所有手機與投影會看到：…」、Enter 或送出；上一則（時間＋內容）與「收回」；常用句只是填進輸入框。
function broadcastPanel(view) {
  const { room, off } = view;
  const last = room.display?.broadcast ?? null;
  const text = normalizeBroadcast(draft);
  const left = BROADCAST_MAX_LENGTH - text.length;
  const working = busy.has('broadcast');
  const sendWhy = off ? OFFLINE_TEXT : working ? '處理中…' : !isValidBroadcast(text) ? (text.length ? `最多 ${BROADCAST_MAX_LENGTH} 字` : '先打字') : null;
  const offset = offsetNow();
  let lastLine;
  if (!last?.text) lastLine = h('p', { class: 'cs-note cs-cast-last', data: { key: 'last' }, text: '還沒有廣播過' });
  else {
    const when = typeof last.at === 'number' ? wallTime(last.at, offset) : '';
    const who = byText(last.by, ctx.session.uid);
    lastLine = h(
      'div',
      { class: `cs-cast-last${last.hidden ? ' is-hidden' : ''}`, data: { key: 'last' } },
      trunc('span', 'cs-cast-last-text', `上一則 ${when}${who ? `・${who}` : ''}${last.hidden ? '（已收回）' : ''}：${last.text}`),
      last.hidden ? null : csButton('broadcast-hide', '收回', { why: off ? OFFLINE_TEXT : working ? '處理中…' : null, className: 'cs-hide' }),
    );
  }
  return panel('broadcast', '全場廣播', [
    h(
      'div',
      { class: 'cs-cast-row' },
      h('input', {
        class: 'input cs-cast-input',
        type: 'text',
        value: draft,
        disabled: off,
        data: { input: 'broadcast' },
        attrs: { id: 'console-broadcast', 'aria-label': '廣播內容', placeholder: `打一行字，所有手機與投影都看得到`, autocomplete: 'off', enterkeyhint: 'send' },
      }),
      csButton('broadcast-send', working ? '處理中…' : '送出', { why: sendWhy, className: sendWhy ? 'cs-send' : 'cs-send btn-primary' }),
    ),
    h(
      'p',
      { class: 'cs-cast-meta' },
      h('span', { class: `cs-count${left < 0 ? ' is-over' : ''}`, text: text.length === 0 ? `最多 ${BROADCAST_MAX_LENGTH} 字` : left >= 0 ? `還剩 ${left} 字` : `多了 ${-left} 字` }),
      trunc('span', 'cs-cast-preview', text ? `所有手機與投影會看到：${text}` : '按 Enter 或「送出」；送錯可以收回'),
    ),
    lastLine,
    h(
      'select',
      { class: 'select cs-phrases', data: { change: 'phrase' }, attrs: { 'aria-label': '常用句（填進輸入框）' }, disabled: off },
      h('option', { value: '', text: '常用句…' }),
      PHRASES.map((phrase) => h('option', { value: phrase, text: phrase })),
    ),
  ]);
}

// 緊急全場暫停：最右邊的紅色大鈕；暫停中換成「全場暫停中（18:44 起）」＋「恢復」。暫停、恢復都要確認。
function pausePanel(view) {
  const { room, off } = view;
  const pause = room.display?.pause ?? null;
  const working = busy.has('pause');
  if (pause?.on === true) {
    return panel('pause', '緊急全場暫停', [
      h('p', { class: 'cs-pause-on', text: '全場暫停中' }),
      h('p', { class: 'cs-note', text: pauseSince(pause) }),
      csButton('pause-off', working ? '處理中…' : '恢復', { why: off ? OFFLINE_TEXT : working ? '處理中…' : null, className: 'cs-resume' }),
    ], 'is-on');
  }
  return h(
    'section',
    { class: 'cs-panel cs-pause', data: { key: 'pause' }, attrs: { 'aria-label': '緊急全場暫停' } },
    h(
      'button',
      { class: 'cs-pause-btn', type: 'button', data: { act: 'pause-on' }, attrs: { title: off ? OFFLINE_TEXT : undefined }, disabled: off || working },
      h('span', { class: 'cs-pause-title', text: working ? '處理中…' : '緊急全場暫停' }),
      h('span', { class: 'cs-pause-sub', text: '手機與投影蓋上暫停畫面・日落鐘停住' }),
    ),
  );
}

function pauseSince(pause) {
  const when = typeof pause.at === 'number' ? `${wallTime(pause.at, offsetNow())} 起` : '';
  const who = byText(pause.by, ctx.session.uid);
  return [when, who].filter(Boolean).join('・');
}

// 控制列最上面的狀態條（蓋在面板標題上，不佔高度、桌卡不會跳）：離線、全場暫停中＋「恢復」。
function statusStrip(view) {
  const pause = view.room.display?.pause ?? null;
  const paused = pause?.on === true;
  return h(
    'div',
    { class: `cs-strip${paused ? ' is-paused' : ''}${view.off ? ' is-off' : ''}`, data: { key: 'strip' }, attrs: { role: 'status' } },
    view.off ? h('span', { class: 'cs-strip-off', text: OFFLINE_TEXT }) : null,
    paused ? h('b', { class: 'cs-strip-text', text: `全場暫停中（${pauseSince(pause)}）` }) : null,
    paused ? csButton('pause-off', busy.has('pause') ? '處理中…' : '恢復', { why: view.off ? OFFLINE_TEXT : busy.has('pause') ? '處理中…' : null, className: 'cs-strip-btn' }) : null,
  );
}

// 結果條：✓／✗＋原因（太長「…」點一下看全文，批次動作逐桌寫在全文裡）、時間、加減日落鐘之後的「復原」；右邊是收合／收起。
function resultBar(view, mode) {
  let text = '每個動作的結果會寫在這裡';
  if (progress) text = `${progress.label} ${progress.done}／${progress.total}…`;
  else if (outcome) text = `${outcome.ok ? (outcome.warn ? '⚠' : '✓') : '✗'} ${outcome.text}`;
  const tone = progress ? ' is-busy' : outcome ? (outcome.ok ? (outcome.warn ? ' is-warn' : ' is-ok') : ' is-error') : '';
  const undo = outcome?.undo;
  return h(
    'div',
    { class: `cs-result${tone}`, data: { key: 'result' }, attrs: { role: 'status', 'aria-live': 'polite' } },
    trunc('p', 'cs-result-text', text, outcome && !progress ? `${text}${outcome.full !== outcome.text ? `\n${outcome.full}` : ''}` : text),
    outcome && !progress ? h('span', { class: 'cs-result-time', text: wallTime(outcome.at, 0, { seconds: true }) }) : null,
    undo ? csButton('clock-undo', '復原', { why: view.off ? OFFLINE_TEXT : busy.has(`clock:${undo.match}`) ? '處理中…' : null, className: 'cs-undo' }) : null,
    mode === 'bar' ? h('button', { class: 'btn-link cs-link', type: 'button', data: { act: 'console-fold' }, text: '收合成一行' }) : null,
    mode === 'drawer' ? h('button', { class: 'btn-link cs-link', type: 'button', data: { act: 'console-toggle' }, text: '收起控制台' }) : null,
  );
}

// 收合成一行：日落鐘、目前投影的場景、結果、暫停鈕（暫停中是「恢復」）、展開。
function foldBar(view) {
  const { room, now, off } = view;
  const pause = room.display?.pause ?? null;
  const paused = pause?.on === true;
  const clocks = clockMatches(room).map((match) => {
    const clock = room.clock?.[match];
    if (!isClock(clock)) return h('span', { class: 'cs-fold-clock', data: { key: `fold-${match}` } }, `${matchText(match)}・各桌各自計時`);
    const state = clockPassed(clock, now) ? '已日落' : clockPaused(clock) ? '暫停中' : '';
    return h(
      'span',
      { class: 'cs-fold-clock', data: { key: `fold-${match}`, clock: match } },
      `${matchText(match)}日落鐘 `,
      h('b', { class: 'cs-remaining', text: clockText(clockRemaining(clock, now)) }),
      state ? ` ${state}` : '',
    );
  });
  const scene = room.display?.scene ?? null;
  const result = outcome ? `${outcome.ok ? (outcome.warn ? '⚠' : '✓') : '✗'} ${outcome.text}` : '';
  return h(
    'div',
    { class: `cs-fold${paused ? ' is-paused' : ''}`, data: { key: 'fold' } },
    clocks,
    h('span', { class: 'cs-fold-scene', text: SCENE_LABELS[scene?.id] ? `投影中：${SCENE_LABELS[scene.id]}` : '還沒有切過場景' }),
    trunc('span', 'cs-fold-result', progress ? `${progress.label} ${progress.done}／${progress.total}…` : off ? OFFLINE_TEXT : paused ? `全場暫停中（${pauseSince(pause)}）` : result, outcome?.full ?? result),
    paused
      ? csButton('pause-off', busy.has('pause') ? '處理中…' : '恢復全場', { why: off ? OFFLINE_TEXT : busy.has('pause') ? '處理中…' : null, className: 'cs-resume' })
      : csButton('pause-on', busy.has('pause') ? '處理中…' : '緊急全場暫停', { why: off ? OFFLINE_TEXT : busy.has('pause') ? '處理中…' : null, className: 'cs-fold-pause' }),
    h('button', { class: 'btn-link cs-link', type: 'button', data: { act: 'console-fold' }, text: '展開控制列' }),
  );
}

function consoleView(room, mode) {
  if (!mode) return [];
  const now = serverTime(ctx.session);
  const view = { room, now, off: !connected, paused: isPaused(room) };
  if (mode === 'fold') return [foldBar(view)];
  const parts = [
    view.off || view.paused ? statusStrip(view) : null,
    h('div', { class: 'cs-panels', data: { key: 'panels' } }, actionsPanel(view), clockPanel(view), scenePanel(view), soundPanel(view), broadcastPanel(view), pausePanel(view)),
    resultBar(view, mode),
  ].filter(Boolean);
  return mode === 'drawer' ? [h('div', { class: 'cs-sheet', data: { key: 'sheet' } }, parts)] : parts;
}

// 控制台關著（或窄螢幕抽屜收起）時全場暫停：頂列下方浮一條紅條＋「恢復」（不佔高度，1280×800 照樣不用捲動）。
function pauseFloat(room, mode) {
  const pause = room.display?.pause ?? null;
  if (pause?.on !== true || mode) return [];
  return [
    h(
      'div',
      { class: 'pause-float', data: { key: 'pause-float' }, attrs: { role: 'status' } },
      h('b', { text: `全場暫停中（${pauseSince(pause)}）` }),
      csButton('pause-off', busy.has('pause') ? '處理中…' : '恢復', { why: !connected ? OFFLINE_TEXT : busy.has('pause') ? '處理中…' : null, className: 'cs-strip-btn' }),
    ),
  ];
}

// ---- 控制台：確認框 ----

// 控制列的確認框打開時就把計畫算好存起來（確認後原封交給 store；「能推的全推」每桌帶著這一刻的回合與階段）。之後局面變了，框裡寫一行
// 提醒（照框裡的計畫做，已經變了的桌不會動；要看最新的請取消再按一次）。
function openConsoleConfirm(request, opener) {
  const room = ctx.latestRoom;
  const data = ctx.cardData?.data;
  if (!room) return;
  const now = serverTime(ctx.session);
  if (request.kind === 'start-all') Object.assign(request, { plan: startPlan(room, data), clock: true });
  else if (request.kind === 'start-all-2') Object.assign(request, { plan: startMatch2Plan(room, data, seatPicks), clock: true });
  else if (request.kind === 'advance-all') Object.assign(request, { ending: false, plan: advancePlan(room, data.settings, now, { discards: submissions.discards }) });
  else if (request.kind === 'pause' || request.kind === 'resume') {
    const pause = room.display?.pause ?? null;
    Object.assign(request, { seq: pause?.seq ?? 0, clocks: Object.keys(pause?.clocks ?? {}).filter((match) => pause.clocks[match] === true) });
  }
  request.signature = planSignature(request.kind, room);
  openConfirm(request, opener);
}

// 局面的「指紋」：只看計畫會用到的東西（各桌的回合、階段、有沒有開局、人數；暫停；鐘的序號），變了就在確認框提醒。
function planSignature(kind, room) {
  if (!['start-all', 'start-all-2', 'advance-all'].includes(kind)) return '';
  const parts = [];
  for (let table = 1; table <= room.meta.tableCount; table += 1) {
    const key = activeKey(room, table);
    const state = room.tables?.[key];
    parts.push(`${key}:${state?.round}:${state?.phase}:${room.games?.[key] ? 1 : 0}:${playersAt(room, table).length}:${room.deals?.[key] ?? 0}`);
  }
  return `${parts.join('|')}|${isPaused(room)}`;
}

function dialogNode({ title, text, lines = [], options = [], hint = null, why = null, ok, danger = false, stale = false }) {
  return h(
    'div',
    { class: 'confirm is-console', data: { key: `confirm-${confirming.kind}` }, attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-title', 'aria-describedby': 'confirm-text' } },
    h('h2', { class: 'confirm-title', attrs: { id: 'confirm-title' }, text: title }),
    h('p', { class: 'confirm-text', attrs: { id: 'confirm-text' }, text }),
    lines.length ? h('ul', { class: 'confirm-list' }, lines.map((line) => h('li', { class: `confirm-line${line.problem ? ' is-problem' : ''}`, text: line.text }))) : null,
    options.map((option) =>
      h('label', { class: 'confirm-option', data: { key: `option-${option.name}` } }, h('input', { type: 'checkbox', checked: option.checked, data: { change: 'confirm-option', option: option.name } }), h('span', { text: option.label })),
    ),
    stale ? h('p', { class: 'reason problem', text: '打開這個確認框之後局面變了：照框裡的計畫做，已經變了的桌不會動；要看最新的計畫請取消再按一次。' }) : null,
    hint ? h('p', { class: 'hint', text: hint }) : null,
    why ? h('p', { class: 'reason problem', text: why }) : null,
    h(
      'div',
      { class: 'confirm-actions' },
      h('button', { class: 'btn', type: 'button', data: { act: 'cancel-confirm', key: 'cancel' }, text: '取消' }),
      h('button', { class: `btn${why ? '' : danger ? ' btn-primary cs-danger' : ' btn-primary'}`, type: 'button', data: { act: 'confirm-console', key: 'ok' }, disabled: Boolean(why), text: ok }),
    ),
  );
}

function startLines(room, plan) {
  const lines = [];
  const second = plan.match !== 1;
  if (plan.start.length) {
    for (const item of plan.start) {
      const absent = second && item.absent.length ? `；沒參加：${item.absent.map((entry) => `${nameOf(room, entry.uid)}（${ABSENT_TEXT[entry.why] ?? entry.why}）`).join('、')}` : '';
      lines.push({ text: `第 ${item.table} 桌：${item.count} 人${second ? '參加' : ''}${absent}` });
      if (item.warning) lines.push({ text: `第 ${item.table} 桌${item.warning}`, problem: true });
    }
  }
  // 跳過的桌照原因分組：「跳過第 3、4、5 桌：這一桌還沒有玩家」。
  const reasons = new Map();
  for (const item of plan.skip) reasons.set(item.reason, [...(reasons.get(item.reason) ?? []), item]);
  for (const [reason, items] of reasons) lines.push({ text: `跳過${tablesText(items)}：${reason}`, problem: true });
  if (plan.started.length) lines.push({ text: `已經開局：${plan.started.map((key) => `第 ${parseKey(key).table} 桌`).join('、')}` });
  return lines;
}

function consoleDialog(room) {
  const request = confirming;
  const data = ctx.cardData?.data ?? null;
  const now = serverTime(ctx.session);
  const off = !connected ? OFFLINE_TEXT : null;
  const stale = request.signature !== '' && request.signature !== planSignature(request.kind, room);
  switch (request.kind) {
    case 'start-all':
    case 'start-all-2': {
      const { plan } = request;
      const second = plan.match !== 1;
      const lines = startLines(room, plan);
      const options = [];
      if (plan.clock.needed && !plan.clock.error) {
        options.push({ name: 'clock', checked: request.clock, label: `同時開始${second ? `${matchText(2)}的` : ''}全場日落鐘（${plan.clock.minutes} 分鐘）` });
        if (request.clock && plan.started.length) {
          for (const change of clockStartChanges(room, plan.match, plan.clock.minutes, data.settings, now)) lines.push({ text: `已開局的${change.text}`, problem: change.problem });
        }
      } else if (plan.clock.needed) lines.push({ text: `${plan.clock.error}；各桌照舊各自計時`, problem: true });
      const why = off ?? (isPaused(room) ? PAUSED_TEXT : !data ? noDataText() : plan.start.length === 0 ? '沒有可以開的桌' : busy.has(request.kind) ? '處理中…' : null);
      return dialogNode({
        title: second ? `全部開始${matchText(2)}？` : '全部開始？',
        text: second ? `照這台裝置的勾選開局（每桌各自洗牌）；開了之後就不能改名單。` : '每桌各自洗牌、發階層與天命，等同逐桌按「開始」。',
        lines,
        options,
        hint: second ? '勾選只存在這台裝置；要改名單請先取消，在各桌的「勾選參加」改。' : '中途斷掉時已開的保留，再按一次只會開剩下的。',
        why,
        stale,
        ok: `開始（${plan.start.length} 桌）`,
      });
    }
    case 'advance-all': {
      const { plan } = request;
      const lines = plan.advance.map((item) => ({ text: advanceLine(item), problem: Boolean(item.ending || item.note) }));
      const skipped = plan.skip.filter((item) => item.reason !== 'ended' && item.reason !== 'not-started');
      if (skipped.length) lines.push({ text: `不推：${skipped.map((item) => `第 ${item.table} 桌（${item.text}）`).join('、')}` });
      const scoring = plan.advance.some((item) => item.ending) || plan.skip.some((item) => item.reason === 'ending');
      const why = off ?? (isPaused(room) ? PAUSED_TEXT : !data ? noDataText() : plan.advance.length === 0 ? '沒有可以推的桌' : busy.has('advance-all') ? '處理中…' : null);
      return dialogNode({
        title: '能推的全推下一階段？',
        text: '只推「可推進」的桌，每桌照框裡的回合與階段推（別台先推了的桌不會動）；不替還在出牌的人結束白晝。',
        lines,
        options: scoring ? [{ name: 'ending', checked: request.ending, label: '連要算分的桌一起推（算分後不能回頭）' }] : [],
        why,
        stale,
        ok: `推進（${plan.advance.length} 桌）`,
      });
    }
    case 'clock-start': {
      const minutes = data?.settings.sunsetMinutes;
      const why = clockStartWhy({ room, off: !connected, paused: isPaused(room) }, request.match);
      const lines = data && !why ? clockStartChanges(room, request.match, minutes, data.settings, now) : [];
      return dialogNode({
        title: `統一開始${matchText(request.match)}的全場日落鐘？`,
        text: `從現在起 ${minutes} 分鐘後日落；${matchText(request.match)}所有桌的日落都照這個鐘，不再各自計時。`,
        lines,
        hint: '開了之後可以暫停、加減；鐘一旦開了就不能刪掉。',
        why: room.clock?.[request.match] ? '別台已經開了這一場的全場日落鐘' : why,
        ok: '開始全場日落鐘',
      });
    }
    case 'clock-toggle': {
      const clock = room.clock?.[request.match];
      const guards = clockGuards(clock, now, { paused: isPaused(room) });
      const why = off ?? (!isClock(clock) ? '這一場還沒有全場日落鐘' : clock.seq !== request.seq ? '別台剛改過這個鐘，請取消再看一次' : guards.toggle);
      return request.pause
        ? dialogNode({ title: `暫停${matchText(request.match)}的日落鐘？`, text: '暫停時鐘不走、不會到點；投影的鐘寫「暫停」。玩家手機上沒有鐘，畫面不變。', why, ok: '暫停日落鐘' })
        : dialogNode({ title: `繼續${matchText(request.match)}的日落鐘？`, text: '從現在起接著倒數，暫停的時間不算。', why, ok: '繼續' });
    }
    case 'clock-zero': {
      const clock = room.clock?.[request.match];
      const why = off ?? (!isClock(clock) ? '這一場還沒有全場日落鐘' : clock.seq !== request.seq ? '別台剛改過這個鐘，請取消再看一次' : clockGuards(clock, now).minus);
      const left = isClock(clock) ? clockText(clockRemaining(clock, now)) : '';
      return dialogNode({
        title: `把${matchText(request.match)}的日落鐘減到 0？`,
        text: `現在剩 ${left}，減 ${Math.abs(request.delta) / MINUTE} 分就直接日落：各桌這一回合結束就算分。日落之後不能再加回來。`,
        why,
        danger: true,
        ok: '減到 0（日落）',
      });
    }
    case 'pause':
      return dialogNode({
        title: '全場暫停？',
        text: '所有手機與投影會蓋上暫停畫面、日落鐘停住；正在倒數的響應窗口與揭曉會先跑完',
        hint: `暫停中「開始」「下一階段」「全部…」「開${matchText(2)}」都不能按；任何一台主持端都能按「恢復」。`,
        why: off ?? (isPaused(room) ? '已經是全場暫停中' : null),
        danger: true,
        ok: '全場暫停',
      });
    case 'resume':
      return dialogNode({
        title: '恢復全場？',
        text: '手機與投影拿掉暫停畫面；被這次暫停停住的日落鐘接著走。',
        why: off ?? (!isPaused(room) ? '現在沒有全場暫停' : null),
        ok: '恢復',
      });
    case 'awards':
      return dialogNode({
        title: '切到頒獎？',
        text: `${tablesText(request.open)}還在比賽，頒獎只會顯示已結束的桌`,
        why: off,
        ok: '切到頒獎',
      });
    default:
      return null;
  }
}

// ---- 控制台：指令 ----

// 控制列的一個指令：送出到做完之間按鈕寫「處理中…」並停用（busy），結果寫在結果條（控制台關著時寫在頁首的提示）。
// work 回傳 { ok, text, full?, warn?, undo? }；丟錯時照 commandError 寫成一句。
async function command(key, work, { clock = false, describe = null } = {}) {
  if (busy.has(key)) return;
  busy.add(key);
  rerender();
  let result;
  try {
    result = await work();
  } catch (error) {
    result = { ok: false, text: commandError(error, { clock, describe }) };
  } finally {
    busy.delete(key);
  }
  if (result) {
    outcome = { ok: result.ok, warn: result.warn === true, text: result.text, full: result.full ?? result.text, undo: result.undo ?? null, at: Date.now() };
    if (!consoleMode() || consoleMode() === 'fold') notify(`${result.ok ? '' : '沒有成功：'}${result.text}`);
  }
  rerender();
}

// 批次動作的進度：store 每做完一桌呼叫一次（store 沒有包 try／catch，這裡一定不能丟錯）。
function onProgress(label) {
  return ({ done, total }) => {
    try {
      progress = { label, done, total };
      soon();
    } catch {
      // 進度只是顯示，不影響批次動作。
    }
  };
}

function describeClock(latest) {
  if (!isClock(latest)) return '';
  const now = serverTime(ctx.session);
  return clockPassed(latest, now) ? '現在已經日落' : `現在剩 ${clockText(clockRemaining(latest, now))}${clockPaused(latest) ? '（暫停中）' : ''}`;
}

function runStartAll(request) {
  const { plan } = request;
  const label = plan.match === 1 ? '開局中' : `${matchText(2)}開局中`;
  command(request.kind, async () => {
    progress = { label, done: 0, total: plan.start.length };
    try {
      const { results, clock } = await startAll(ctx.session, ctx.code, plan, ctx.cardData.data, { random, clock: request.clock && plan.clock.needed && !plan.clock.error, onProgress: onProgress(label) });
      const items = new Map(plan.start.map((item) => [item.key, item]));
      const lines = results.map((result) => startResult(result, items.get(result.key)));
      if (plan.match !== 1) for (const result of results) if (result.started) seatPicks.delete(result.key);
      if (clock) {
        if (clock.error) lines.push({ ok: false, text: `全場日落鐘沒開成：${commandError(clock.error, { clock: true })}` });
        else lines.push({ ok: true, text: clock.started ? `全場日落鐘開始了（${plan.clock.minutes} 分鐘）` : '全場日落鐘別台已經開了' });
      }
      const started = results.filter((result) => result.started).length;
      const failed = lines.filter((line) => !line.ok);
      const head = `${plan.match === 1 ? '全部開始' : `全部開始${matchText(2)}`}：${started} 桌開局${failed.length ? `；${failed.map((line) => line.text).join('；')}` : ''}${clock && !clock.error && clock.started ? '；全場日落鐘開始了' : ''}`;
      return { ok: failed.length === 0, text: head, full: lines.map((line) => `${line.ok ? '✓' : '✗'} ${line.text}`).join('\n') };
    } finally {
      progress = null;
    }
  });
}

function runAdvanceAll(request) {
  const { plan } = request;
  command('advance-all', async () => {
    progress = { label: '推進中', done: 0, total: plan.advance.length };
    try {
      const { results } = await advanceAll(ctx.session, ctx.code, plan, ctx.cardData.data, { random, onProgress: onProgress('推進中') });
      const items = new Map(plan.advance.map((item) => [item.key, item]));
      const lines = results.map((result) => advanceResult(result, items.get(result.key)));
      const moved = results.filter((result) => result.advanced).length;
      const failed = lines.filter((line) => !line.ok);
      const head = `能推的全推：${moved} 桌推進了${failed.length ? `；${failed.map((line) => line.text).join('；')}` : ''}`;
      return { ok: failed.length === 0, warn: failed.length > 0 && moved > 0, text: head, full: lines.map((line) => `${line.ok ? '✓' : '✗'} ${line.text}`).join('\n') };
    } finally {
      progress = null;
    }
  });
}

// 加減日落鐘（不確認）：結果條寫「＋5 分（日落改在 18:44）」＋「復原」（＝反方向調一次，帶著調完之後的序號：別台又改過就不會亂調）。
function runAdjust(match, delta, expectSeq, { undo = false } = {}) {
  command(
    `clock:${match}`,
    async () => {
      const { delta: done, clock } = await adjustClock(ctx.session, ctx.code, match, delta, { expectSeq });
      const at = clockSunsetAt(clock);
      const when = at === null ? `暫停中，剩 ${clockText(clockRemaining(clock, serverTime(ctx.session)))}` : `日落改在 ${wallTime(at, offsetNow())}`;
      const clipped = Math.abs(done) < Math.abs(delta) ? (Math.abs((clock.adjust ?? 0)) >= CLOCK_ADJUST_MAX_MS ? `；到了累計 ${CLOCK_ADJUST_MAX_MS / MINUTE} 分的上限` : '；減到底了') : '';
      return { ok: true, text: `${undo ? '復原：' : ''}${matchText(match)}日落鐘${deltaText(done)}（${when}）${clipped}`, undo: undo ? null : { match, delta: -done, seq: clock.seq } };
    },
    { clock: true, describe: describeClock },
  );
}

function runClockToggle(request) {
  const { match, pause, seq } = request;
  command(
    `clock:${match}`,
    async () => {
      const { changed, clock } = pause ? await pauseClock(ctx.session, ctx.code, match, { expectSeq: seq }) : await resumeClock(ctx.session, ctx.code, match, { expectSeq: seq });
      const left = clockText(clockRemaining(clock, serverTime(ctx.session)));
      if (!changed) return { ok: true, text: `${matchText(match)}日落鐘本來就${pause ? '暫停著' : '在走'}（剩 ${left}）` };
      return { ok: true, text: `${matchText(match)}日落鐘${pause ? '暫停了' : '繼續走'}（剩 ${left}）` };
    },
    { clock: true, describe: describeClock },
  );
}

function runClockStart(match) {
  const minutes = ctx.cardData?.data.settings.sunsetMinutes;
  command(
    `clock:${match}`,
    async () => {
      const { started, clock } = await startClock(ctx.session, ctx.code, match, minutes);
      if (!started) return { ok: true, text: `${matchText(match)}的全場日落鐘別台已經開了` };
      return { ok: true, text: `${matchText(match)}全場日落鐘開始了：${minutes} 分鐘後（${wallTime(clockSunsetAt(clock), offsetNow())}）日落` };
    },
    { clock: true },
  );
}

// 全場暫停／恢復（一筆寫入，連同日落鐘）。回傳的 clocks 跟按下去時畫面上的鐘對不上（快日落、別台剛好動了鐘、暫停中被手動動過）就提醒。
function runPause(request) {
  const on = request.kind === 'pause';
  const room = ctx.latestRoom;
  const now = serverTime(ctx.session);
  const running = [1, MATCH_COUNT].filter((match) => {
    const clock = room?.clock?.[match];
    return isClock(clock) && !clockPaused(clock) && !clockPassed(clock, now);
  });
  command(
    'pause',
    async () => {
      const { changed, clocks } = await setPause(ctx.session, ctx.code, on, { expectSeq: request.seq });
      if (!changed) return { ok: true, text: on ? '本來就是全場暫停中' : '本來就沒有全場暫停' };
      const names = (list) => list.map((match) => matchText(Number(match))).join('、');
      const done = clocks.map(String);
      const expected = on ? running.map(String) : request.clocks;
      const missed = expected.filter((match) => !done.includes(match));
      let text = on ? `全場暫停了${done.length ? `；${names(done)}日落鐘一起停住` : ''}` : `恢復全場了${done.length ? `；${names(done)}日落鐘接著走` : ''}`;
      if (missed.length) {
        text += on
          ? `；${names(missed)}日落鐘沒有停住（快日落或別台剛動了鐘），要停請在日落鐘面板按暫停`
          : `；${names(missed)}日落鐘沒有跟著繼續（暫停中被動過），要的話在日落鐘面板按繼續`;
      }
      return { ok: true, warn: missed.length > 0, text };
    },
    { describe: (latest) => (latest ? (latest.on === true ? '現在是全場暫停中' : '現在沒有暫停') : '') },
  );
}

function runScene(id, page = null) {
  command('scene', async () => {
    await setScene(ctx.session, ctx.code, id, page === null ? {} : { page });
    return { ok: true, text: `投影切到〈${SCENE_LABELS[id]}〉${page === null ? '' : `第 ${page + 1} 頁`}` };
  });
}

// 頂列的「控制台」切換、窄螢幕抽屜的收起、控制列的收合都記在這台裝置。
function setConsole(on) {
  consolePref = on ? 'on' : 'off';
  writePref(CONSOLE_KEY, consolePref);
  rerender();
}

// 在等誰、連線狀態有變時重畫（訂閱的回呼可能在 renderHost 裡同步回來，排到下一輪再畫，不重入）。
let redraw = false;
function soon() {
  if (redraw) return;
  redraw = true;
  queueMicrotask(() => {
    redraw = false;
    rerender();
  });
}

// 每秒：桌卡底部的日落鐘、控制列的日落鐘（剩餘、已進行、進度條）只換字，不整個重畫；到點（日落）由 rerenderAt 重畫。
function tick() {
  const room = ctx.latestRoom;
  if (!room || $('screen-host').hidden) return;
  for (const node of document.querySelectorAll('.sunset-clock[data-sunset]')) node.textContent = sunsetLine(room, node.dataset.sunset);
  const now = serverTime(ctx.session);
  for (const node of $('host-console').querySelectorAll('[data-clock]')) {
    const clock = room.clock?.[node.dataset.clock];
    if (!isClock(clock)) continue;
    const set = (selector, text) => {
      const target = node.querySelector(selector);
      if (target && target.textContent !== text) target.textContent = text;
    };
    set('.cs-remaining', clockText(clockRemaining(clock, now)));
    set('.cs-elapsed', `已進行 ${clockText(clockElapsed(clock, now), { up: true })}`);
    node.querySelector('.cs-progress-fill')?.style.setProperty('width', `${progressOf(clock, now)}%`);
  }
}

// ---- 畫面 ----

export function renderHost(room) {
  ctx.requested = false;
  markPresent();
  // 出牌請求、黃昏與黑夜自動結算，畫面不用按；卡牌資料讀到才開始。
  if (ctx.cardData && !stopSettling) {
    stopSettling = startSettling(ctx.session, ctx.code, ctx.cardData.data, { random, onError: (error) => notify(explain(error)) });
  }
  // 在等誰（入座的人的票、黑夜選擇、挑的棄牌）與這台的連線狀態：進主持畫面就訂閱，回首頁時停（resetHost）。
  if (!stopSubmissions) {
    stopSubmissions = () => {};
    stopSubmissions = watchSubmissions(
      ctx.session,
      ctx.code,
      (value) => {
        submissions = value;
        soon();
      },
      () => {},
    );
  }
  if (!stopConnection) {
    stopConnection = () => {};
    stopConnection = watchConnection(ctx.session, (value) => {
      if (value === connected) return;
      connected = value;
      soon();
    });
  }
  const mode = consoleMode();
  compactCards = mode === 'bar' || mode === 'fold';
  const cards = [];
  // 每桌只畫目前那一局（有 tables/{n}-2 就是第 2 場）；tables、games、deals 有 "1-2" 這種鍵後是物件，只用 [局號] 取值。
  for (let number = 1; number <= room.meta.tableCount; number += 1) {
    const t = tableModel(room, activeKey(room, number));
    if (!t) continue;
    if (t.game && !t.ended) wakeAtSunset(t.game, t.key);
    const limits = handLimits(t);
    cards.push({ t, limits, step: stepOf(t, limits) });
  }
  // 全場日落鐘到點時重畫（控制列的鐘換成「已日落」、按鈕停用）。
  for (const match of [1, MATCH_COUNT]) {
    const clock = room.clock?.[match];
    if (isClock(clock) && clockSunsetAt(clock) !== null) rerenderAt(clockSunsetAt(clock));
  }
  patchChildren($('host-top'), topBar(room, cards, mode));
  const section = $('host-console');
  section.hidden = !mode;
  section.className = `console${mode ? ` is-${mode}` : ''}`;
  patchChildren(section, consoleView(room, mode));
  // 控制列在頂列下面（或收合成一行）時桌卡用緊湊版；窄螢幕的抽屜蓋在桌卡上，桌卡照舊。
  $('screen-host').classList.toggle('is-console', compactCards);
  patchChildren(
    $('host-tables'),
    cards.map(({ t, step, limits }) => tableCard(t, step, limits)),
  );
  patchChildren($('host-layer'), [...pauseFloat(room, mode), ...drawerLayer(room), ...confirmLayer(room)]);
  document.body.classList.toggle('has-drawer', Boolean(drawer || confirming));
  markTopHeight();
  markTruncated($('screen-host'));
}

// 頁首的提示框放在頂列下方（host.css 的 --host-top-h）：頂列在比較小的畫面會變成兩行，照實際高度放；控制列開著時放在控制列下面
// （不蓋住緊急暫停鈕；抽屜很高時最多到畫面六成的位置）。
function markTopHeight() {
  if ($('screen-host').hidden) return;
  const section = $('host-console');
  const top = $('host-top').getBoundingClientRect().bottom;
  const bar = section.hidden ? 0 : Math.min(section.getBoundingClientRect().bottom, window.innerHeight * 0.6);
  document.body.style.setProperty('--host-top-h', `${Math.round(Math.max(top, bar))}px`);
}

// ---- 事件（委派）：按鈕上的 data-act 決定做什麼，做的時候讀當下的局面 ----

// table 是按鈕上的局號（字串，"3" 或 "3-2"），直接拿去找局面、傳給 store。
function current(table) {
  const room = ctx.latestRoom;
  return room ? tableModel(room, table) : null;
}

// 送出一個動作：同一個動作做完之前按鈕停用；失敗就把原因顯示出來。
async function act(key, work) {
  if (busy.has(key)) return;
  busy.add(key);
  notify();
  rerender();
  try {
    await work();
  } catch (error) {
    notify(explain(error));
  } finally {
    busy.delete(key);
    rerender();
  }
}

// 發這一局這一回合的日出；送出到寫完之間，畫面顯示「發牌中…」。key 是局號。
async function deal(key) {
  dealing.add(key);
  rerender();
  try {
    await processSunrise(ctx.session, ctx.code, key, ctx.cardData.data, random);
  } finally {
    dealing.delete(key);
    rerender();
  }
}

// 抽屜記實體桌號：開著的時候另一台主持端開了第 2 場，抽屜就跟著換到第 2 場（第 1 場變成只讀）。
function openDrawer(kind, key, opener) {
  drawer = { kind, table: parseKey(key).table, view: 'current' };
  drawerOpener = opener;
  requestsOpen = false;
  rerender();
  $('host-layer').querySelector('.drawer-close')?.focus();
}

function closeDrawer() {
  if (!drawer) return;
  drawer = null;
  rerender();
  if (drawerOpener) document.querySelector(drawerOpener)?.focus();
  drawerOpener = null;
}

function openConfirm(request, opener) {
  confirming = request;
  confirmOpener = opener;
  requestsOpen = false;
  rerender();
  $('host-layer').querySelector('.confirm [data-act="cancel-confirm"]')?.focus();
}

function closeConfirm() {
  if (!confirming) return;
  confirming = null;
  rerender();
  if (confirmOpener) document.querySelector(confirmOpener)?.focus();
  confirmOpener = null;
}

// 確認後開第 2 場（第 ① 步）。opened 是 false＝另一台主持端先開了，不是錯誤。全部開的時候逐桌開，失敗的桌與跳過的桌寫在提示列。
function openMatches(plan, one) {
  if (one) {
    const [t] = plan.ready;
    act(`open-match:${t.key}`, () => openMatch(ctx.session, ctx.code, t.number));
    return;
  }
  act('open-all', async () => {
    const failed = [];
    for (const t of plan.ready) {
      try {
        await openMatch(ctx.session, ctx.code, t.number);
      } catch (error) {
        failed.push(`第 ${t.number} 桌：${explain(error)}`);
      }
    }
    const skipped = plan.skipped.length ? `跳過（天命待判定）：${plan.skipped.map((item) => `第 ${item.number} 桌 ${item.waiting} 張`).join('、')}` : '';
    const message = [failed.length ? `沒開成：${failed.join('；')}` : '', skipped].filter(Boolean).join('。');
    if (message) notify(message);
  });
}

const actions = {
  // 帶著畫面上這一刻的回合與階段去推進；資料庫已經不一樣就不會動。黑夜時該算分就算分（同一筆寫入），不然推進到下一回合日出；
  // 是自己這一筆把桌子推進到新回合的日出，就接著發牌。table 一律是局號字串（不轉數字：Number('3-2') 是 NaN）。
  // 黑夜：按鈕上寫的「下一階段 ▸」或「下一階段（算分）」跟按下去這一刻的判斷不一樣（全場日落鐘剛被調過或暫停、別台改了「這回合結束後
  // 算分」）就先不送，重畫給主持人看；寫「下一階段 ▸」的不替它算分（allowEnd: false，送出途中剛好到點時回 held）。
  next: ({ table, round, phase, ending }) => {
    const t = current(table);
    if (t?.game && phase === 'night' && t.state.phase === 'night' && String(t.ending) !== ending) {
      notify(
        t.ending
          ? `第 ${t.number} 桌這一回合變成要算分了（${END_REASON_TEXT[t.reason] ?? t.reason}），請看清楚再按一次`
          : `第 ${t.number} 桌這一回合不算分了，會推進到下一回合（手牌超過上限的人要先挑棄牌），請看清楚再按一次`,
      );
      rerender();
      return;
    }
    act(`next:${table}`, async () => {
      const result = await advanceOrEnd(ctx.session, ctx.code, table, { round: Number(round), phase }, ctx.cardData?.data, { allowEnd: phase !== 'night' || ending !== 'false' });
      if (result.held) notify(`第 ${parseKey(table).table} 桌這一回合剛好變成要算分了，請看清楚再按「下一階段（算分）」`);
      if (result.advanced && !result.ended && result.table.phase === 'sunrise' && ctx.cardData) await deal(table);
    });
  },
  // 第 1 場照舊；第 2 場（"3-2"）帶這台裝置勾的人（include），座位由 store 照 rotateSeats 算。
  start: ({ table }) => {
    const t = current(table);
    if (!t) return;
    const options = t.match === 1 ? undefined : { include: seatPlan(t).include };
    act(`start:${table}`, async () => {
      await startTable(ctx.session, ctx.code, table, ctx.cardData.data, random, options);
      seatPicks.delete(table);
    });
  },
  redeal: ({ table }) => act(`redeal:${table}`, () => deal(table)),
  'reveal-dusk': ({ table }) => act(`reveal-dusk:${table}`, () => revealDusk(ctx.session, ctx.code, table)),
  'reveal-night': ({ table }) => act(`reveal-night:${table}`, () => revealNight(ctx.session, ctx.code, table)),
  'end-toggle': ({ table }) => {
    const t = current(table);
    if (!t?.game) return;
    const marked = t.game.endAfterRound === t.state.round;
    act(`end-toggle:${table}`, () => setEndAfterRound(ctx.session, ctx.code, t.key, !marked));
  },
  'start-order': ({ table }) => {
    const t = current(table);
    if (!t?.game) return;
    const order = startChoices.get(t.key) ?? t.game.startOrder ?? 0;
    act(`start-order:${table}`, async () => {
      await setStartOrder(ctx.session, ctx.code, t.key, order);
      startChoices.delete(t.key);
    });
  },
  judge: ({ table, uid, done }) => act(`judge:${table}:${uid}`, () => judgeDestiny(ctx.session, ctx.code, table, uid, done === 'true')),
  log: ({ table }) => openDrawer('log', table, `[data-act="log"][data-table="${table}"]`),
  final: ({ table }) => openDrawer('final', table, `[data-act="final"][data-table="${table}"]`),
  seats: ({ table }) => openDrawer('seats', table, `[data-act="seats"][data-table="${table}"]`),
  'drawer-view': ({ view }) => {
    if (!drawer) return;
    drawer.view = view;
    rerender();
  },
  // 勾掉或勾回一個第 1 場的座位（只在這台裝置）；第 1 場之後才加入的人沒有這個鈕。
  'seat-pick': ({ table, uid }) => {
    const t = current(table);
    if (!t || t.match === 1 || t.game || !t.first?.seats?.[uid]) return;
    const picked = new Set(seatPlan(t).include);
    if (picked.has(uid)) picked.delete(uid);
    else picked.add(uid);
    seatPicks.set(t.key, picked);
    rerender();
  },
  'open-match': ({ table }) => openConfirm({ kind: 'one', table: parseKey(table).table }, `[data-act="open-match"][data-table="${table}"]`),
  'open-all': () => openConfirm({ kind: 'all' }, '[data-act="open-all"]'),
  'cancel-confirm': () => closeConfirm(),
  'confirm-open': () => {
    const request = confirming;
    const plan = request && ctx.latestRoom ? openPlan(ctx.latestRoom, request) : null;
    closeConfirm();
    if (plan?.ready.length && ctx.cardData) openMatches(plan, request.kind === 'one');
  },
  'close-drawer': () => closeDrawer(),
  requests: () => {
    requestsOpen = !requestsOpen;
    rerender();
  },
  approve: ({ uid }) => act(`approve:${uid}`, () => approveHost(ctx.session, ctx.code, uid)),
  reject: ({ uid }) => act(`reject:${uid}`, () => rejectHost(ctx.session, ctx.code, uid)),
  leave: () => document.dispatchEvent(new CustomEvent('host-leave')),

  // ---- 控制台 ----
  'console-toggle': () => setConsole(!consoleOn()),
  'console-fold': () => {
    folded = !folded;
    writePref(FOLD_KEY, folded ? '1' : '0');
    rerender();
  },
  'open-screen': () => window.open(screenUrl(location.search, ctx.code), 'one-day-briton-screen'),
  'start-all': () => openConsoleConfirm({ kind: 'start-all' }, '[data-act="start-all"]'),
  'start-all-2': () => openConsoleConfirm({ kind: 'start-all-2' }, '[data-act="start-all-2"]'),
  'advance-all': () => openConsoleConfirm({ kind: 'advance-all' }, '[data-act="advance-all"]'),
  'clock-start': ({ match }) => openConsoleConfirm({ kind: 'clock-start', match: Number(match) }, `[data-act="clock-start"][data-match="${match}"]`),
  'clock-pause': ({ match }) => openConsoleConfirm({ kind: 'clock-toggle', match: Number(match), pause: true, seq: ctx.latestRoom?.clock?.[match]?.seq }, `[data-act="clock-pause"][data-match="${match}"]`),
  'clock-resume': ({ match }) => openConsoleConfirm({ kind: 'clock-toggle', match: Number(match), pause: false, seq: ctx.latestRoom?.clock?.[match]?.seq }, `[data-act="clock-resume"][data-match="${match}"]`),
  // 加減不確認；減到 0（直接日落、加不回來）才確認。帶著畫面上那個鐘的序號：別台剛改過就不會疊上去（＋1 加 ＋1 變 ＋2）。
  'clock-adjust': ({ match, delta }) => {
    const clock = ctx.latestRoom?.clock?.[match];
    if (!isClock(clock)) return;
    const amount = Number(delta);
    if (amount < 0 && clockRemaining(clock, serverTime(ctx.session)) <= -amount) {
      openConsoleConfirm({ kind: 'clock-zero', match: Number(match), delta: amount, seq: clock.seq }, `[data-act="clock-adjust"][data-match="${match}"][data-delta="${delta}"]`);
      return;
    }
    runAdjust(Number(match), amount, clock.seq);
  },
  'clock-undo': () => {
    const undo = outcome?.undo;
    if (undo) runAdjust(undo.match, undo.delta, undo.seq, { undo: true });
  },
  scene: ({ scene }) => {
    const room = ctx.latestRoom;
    if (!room) return;
    if (scene === 'awards') {
      const open = [];
      for (let table = 1; table <= room.meta.tableCount; table += 1) if (standingsOf(room, table)?.status === 'playing') open.push({ table });
      if (open.length) {
        openConsoleConfirm({ kind: 'awards', open }, '[data-act="scene"][data-scene="awards"]');
        return;
      }
    }
    runScene(scene);
  },
  'scene-page': ({ step }) => {
    const scene = ctx.latestRoom?.display?.scene;
    if (!PAGED_SCENES.has(scene?.id)) return;
    const page = Math.max(0, Math.min(SCENE_PAGE_MAX, (Number.isInteger(scene.page) ? scene.page : 0) + Number(step)));
    runScene(scene.id, page);
  },
  sfx: ({ sfx }) =>
    command('sfx', async () => {
      await playSfx(ctx.session, ctx.code, sfx);
      return { ok: true, text: `${SFX_LABELS[sfx]}送到投影端了（約 0.2–1 秒後響）` };
    }),
  music: ({ on }) => {
    const music = ctx.latestRoom?.display?.music ?? null;
    const play = on === 'true';
    command(
      'music',
      async () => {
        const { changed } = await setMusic(ctx.session, ctx.code, play, { expectSeq: music?.seq ?? 0 });
        if (!changed) return { ok: true, text: play ? '開場音樂本來就在播' : '開場音樂本來就停著' };
        return { ok: true, text: play ? '開場音樂：播放（投影端）' : '開場音樂：停止' };
      },
      { describe: (latest) => (latest ? (latest.on === true ? '現在在播開場音樂' : '現在音樂停著') : '') },
    );
  },
  'broadcast-send': () => sendDraft(),
  'broadcast-hide': () => {
    const broadcast = ctx.latestRoom?.display?.broadcast ?? null;
    command(
      'broadcast',
      async () => {
        const { changed } = await hideBroadcast(ctx.session, ctx.code, { expectSeq: broadcast?.seq ?? 0 });
        return { ok: true, text: changed ? '廣播收回了：手機與投影都拿掉' : '這則廣播已經收回了' };
      },
      { describe: (latest) => (latest?.text ? `現在是「${latest.text}」${latest.hidden ? '（已收回）' : ''}` : '') },
    );
  },
  'pause-on': () => openConsoleConfirm({ kind: 'pause' }, '[data-act="pause-on"]'),
  'pause-off': () => openConsoleConfirm({ kind: 'resume' }, '[data-act="pause-off"]'),
  'confirm-console': () => {
    const request = confirming;
    if (!request) return;
    closeConfirm();
    if (request.kind === 'start-all' || request.kind === 'start-all-2') runStartAll(request);
    else if (request.kind === 'advance-all') runAdvanceAll(request);
    else if (request.kind === 'clock-start') runClockStart(request.match);
    else if (request.kind === 'clock-toggle') runClockToggle(request);
    else if (request.kind === 'clock-zero') runAdjust(request.match, request.delta, request.seq);
    else if (request.kind === 'pause' || request.kind === 'resume') runPause(request);
    else if (request.kind === 'awards') runScene('awards');
  },
};

// 送出廣播：送不出去時輸入框保留原本的字（結果條寫原因）；送出去之後輸入框還是剛剛那些字才清掉。
function sendDraft() {
  const input = draft;
  if (!isValidBroadcast(normalizeBroadcast(input)) || !connected) return;
  command('broadcast', async () => {
    const { text } = await sendBroadcast(ctx.session, ctx.code, input);
    if (draft === input) draft = '';
    return { ok: true, text: `廣播送出了：「${text}」` };
  });
}

$('screen-host').addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]');
  if (requestsOpen && !event.target.closest('.requests-panel') && target?.dataset.act !== 'requests') {
    requestsOpen = false;
    rerender();
  }
  if (!target || target.disabled || !$('screen-host').contains(target)) return;
  actions[target.dataset.act]?.(target.dataset, target);
});

$('screen-host').addEventListener('change', (event) => {
  const target = event.target.closest('[data-change]');
  if (!target) return;
  if (target.dataset.change === 'start-order') startChoices.set(target.dataset.table, Number(target.value));
  // 控制列確認框的勾選：「同時開始全場日落鐘」、「連要算分的桌一起推」（重算計畫，框裡的清單跟著換）。
  if (target.dataset.change === 'confirm-option' && confirming) {
    if (target.dataset.option === 'clock') confirming.clock = target.checked;
    if (target.dataset.option === 'ending' && ctx.latestRoom && ctx.cardData) {
      confirming.ending = target.checked;
      confirming.plan = advancePlan(ctx.latestRoom, ctx.cardData.data.settings, serverTime(ctx.session), { includeEnding: target.checked, discards: submissions.discards });
      confirming.signature = planSignature('advance-all', ctx.latestRoom);
    }
    rerender();
  }
  // 廣播的常用句：填進輸入框（不送出），游標放回輸入框。
  if (target.dataset.change === 'phrase' && target.value) {
    draft = target.value;
    target.value = '';
    rerender();
    $('console-broadcast')?.focus();
  }
});

// 廣播輸入框：每打一個字就記下來（重畫時保留，字數與預覽跟著換）；Enter 送出（選字中的 Enter 不算）。
$('screen-host').addEventListener('input', (event) => {
  if (event.target.dataset?.input !== 'broadcast') return;
  draft = event.target.value;
  rerender();
});

$('screen-host').addEventListener('keydown', (event) => {
  if (event.target.dataset?.input !== 'broadcast' || event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  sendDraft();
});

// 鍵盤：Esc 關確認框、抽屜（或備援申請面板）；確認框或抽屜開著時 Tab 只在裡面轉。
document.addEventListener('keydown', (event) => {
  if ($('screen-host').hidden) return;
  if (event.key === 'Escape') {
    if (confirming) closeConfirm();
    else if (drawer) closeDrawer();
    else if (requestsOpen) {
      requestsOpen = false;
      rerender();
    }
    return;
  }
  if (event.key !== 'Tab' || !(drawer || confirming)) return;
  const panel = $('host-layer').querySelector(confirming ? '.confirm' : '.drawer');
  const focusable = [...(panel?.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!panel.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

// 視窗大小變了，重新看頂列多高、哪些名字被截斷；跨過寬螢幕的門檻（1360×860）時控制台換版面（沒選過開關的跟著開或關）。
let resizeTimer = null;
let wideBefore = isWide();
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (isWide() !== wideBefore) {
      wideBefore = isWide();
      if (!$('screen-host').hidden) rerender();
    }
    markTopHeight();
    markTruncated($('screen-host'));
  }, 150);
});
