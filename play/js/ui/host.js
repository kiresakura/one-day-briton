// 主持端（筆電 1280×800／平板）：頂列（房號、各狀態桌數、主持端在線數、備援主持申請、離開）＋ 6 桌固定 3×2 的桌卡（階段色帶 →
// 狀態列 → 玩家表 → 今日事件或法案 → 底部），每桌的「紀錄」與終局的「結算明細」開右側抽屜；開房／接手的畫面是 renderHostEntry。
// 重畫用 patchChildren 就地更新、按鈕用 data-act 委派事件（同玩家端）：別人的動作觸發重畫時，開著的抽屜、備援申請面板、
// 起始玩家的下拉選單與焦點都不會被打斷。規則、流程、每個按鈕的作用與啟用條件與改版前相同。
// 兩場制（M9）：每桌畫的是目前那一局（rules.js 的 activeKey：第 1 場 "3"、第 2 場 "3-2"），按鈕的 data-table 一律是局號字串，直接傳給
// store；畫面上的「第 3 桌」用實體桌號。第 1 場結束的桌可以「開第 2 場」（store 的 openMatch），之後是「第 2 場・未開局」的座位預覽與
// 「開始第 2 場」（startTable 帶 include）；第 2 場結束後結算明細有兩場合計（game.js 的 combineScores）。
import {
  MAX_SEATS,
  SUGGESTED_SEATS,
  checkSeating,
  dayStatus,
  duskStage,
  nightStage,
  pendingDestinies,
  responseDeadline,
  seatsInOrder,
  skippedEffects,
  sunsetClock,
} from '../game.js';
import { FOG_MAX, FOG_MIN, FOG_THRESHOLDS, MAX_TABLES, activeKey, confirmCode, hostUids, matchKey, parseKey } from '../rules.js';
import {
  advanceOrEnd,
  approveHost,
  judgeDestiny,
  openMatch,
  processSunrise,
  rejectHost,
  revealDusk,
  revealNight,
  serverTime,
  setEndAfterRound,
  setStartOrder,
  startSettling,
  startTable,
  watchDiscard,
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
const hostDiscards = new Map(); // uid → { stop, value }（各入座玩家挑的棄牌，列出還沒挑的人用）
const busy = new Set(); // 送出中的動作（「next:3」「start:3-2」之類）：按鈕停用到做完
let drawer = null; // 開著的抽屜 { kind: 'log' | 'final' | 'seats', table: 實體桌號, view: 'current' | 'first' }
let drawerOpener = null; // 開抽屜的按鈕（選擇器），關掉時焦點回到那裡
let confirming = null; // 「開第 2 場」的確認框 { kind: 'one', table: 實體桌號 } 或 { kind: 'all' }
let confirmOpener = null; // 開確認框的按鈕（選擇器）
let requestsOpen = false; // 備援主持申請面板

// 回首頁時清掉主持端的訂閱與暫存。
export function resetHost() {
  stopSettling?.();
  stopSettling = null;
  for (const { stop } of hostDiscards.values()) stop();
  hostDiscards.clear();
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
  // 這一回合是最後一回合（日落鐘、回合上限、主持端按了「這回合結束後算分」）：黑夜揭曉後的「下一階段」就是算分。
  const reason = game && !ended ? endReasonNow(game, state) : null;
  const first = parsed.match === 1 ? null : (room.games?.[matchKey(parsed.table)] ?? null);
  const tone = game ? (PHASE_TONES[state.phase] ?? 'day') : 'idle';
  return { room, key: String(key), number: parsed.table, match: parsed.match, first, state, game, pending, ended, ending: reason !== null, reason, tone };
}

// 主持端：這一桌入座的人挑的棄牌（逐人訂閱，列出還沒挑的人用）。
function watchHostDiscards(game) {
  for (const uid of Object.keys(game.seats ?? {})) {
    if (hostDiscards.has(uid)) continue;
    const entry = { stop: () => {}, value: null };
    hostDiscards.set(uid, entry);
    entry.stop = watchDiscard(
      ctx.session,
      ctx.code,
      (value) => {
        entry.value = value;
        rerender();
      },
      () => {},
      uid,
    );
  }
}

// 黑夜時手牌超過上限的人：誰挑好了、誰還沒挑（推進到下一回合日出時會被隨機棄）。主持端沒有訂閱別人的手牌，這裡只看張數；
// 挑的牌在不在手上，發牌時再查。回傳 { limit, missing: Set, picked: Set, text, problem }。
function handLimits(t) {
  const none = { limit: null, missing: new Set(), picked: new Set(), text: '', problem: false };
  const limit = ctx.cardData?.data.settings.handLimit;
  if (!limit || !t.game || t.state.phase !== 'night') return none;
  const over = seatsInOrder(t.game.seats).filter(([, seat]) => seat.handCount > limit);
  if (over.length === 0) return { ...none, limit };
  // 這一回合黑夜結束就算分：終局不棄牌，天命判定的手牌照上限算（game.js 的 destinyDone）。
  if (t.ending) return { ...none, limit, text: `這一回合結束就算分：手牌超過上限的不用棄，算分時照上限 ${limit} 張算` };
  const done = ([uid, seat]) => {
    const value = hostDiscards.get(uid)?.value;
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
function nextAction(t, why = null, note = null) {
  const label = t.state.phase === 'night' && t.ending ? '下一階段（算分）' : '下一階段 ▸';
  const noData = t.state.phase === 'night' && !ctx.cardData ? '卡牌資料讀取中…' : null;
  return { act: 'next', label, why: why ?? noData, note, primary: true, data: { round: t.state.round, phase: t.state.phase } };
}

// 揭曉倒數（黃昏、黑夜）：照實際倒數到截止＋緩衝（真正揭曉的時間），到 0 還沒揭曉寫「揭曉中…」。
function revealStep(t, kind, at, early, blocked, missing) {
  const deadline = revealDeadline(kind, at);
  rerenderAt(at.revealAt); // 截止時「提前揭曉」要收起來
  rerenderAt(deadline); // 倒數到 0 時換成「揭曉中…」
  const total = Object.keys(t.game.seats).length;
  const sent = at.submitted ?? 0;
  const over = serverTime(ctx.session) >= deadline;
  return {
    kind: 'wait',
    dial: ring({ deadline, total: revealTotal(kind), label: '揭曉倒數', overText: '…' }),
    title: over ? '揭曉中…' : sent >= total ? '大家都送出了・倒數揭曉' : '已截止・倒數揭曉',
    sub: `已送出 ${sent}／${total}・${missing}`,
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
    return {
      kind: 'wait',
      dial: ring({ deadline: dusk.openedAt + seconds * 1000, total: seconds, label: '提醒' }),
      title: `表決中・已送出 ${dusk.submitted ?? 0}／${total}`,
      sub: '全部送出就倒數揭曉；按「提前揭曉」時沒送出的算棄權',
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
    return {
      kind: 'wait',
      dial: ring({ deadline: night.openedAt + seconds * 1000, total: seconds, label: '提醒' }),
      title: `選擇中・已送出 ${night.submitted ?? 0}／${total}`,
      sub: '全部送出就倒數揭曉；按「提前揭曉」時沒送出的算睡覺',
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
  if (!t.game) return t.match === 1 ? idleStep(t) : seatsStep(t);
  if (t.ended) return endStep(t);
  if (t.state.phase === 'sunrise') return sunriseStep(t);
  if (t.state.phase === 'day') return dayStep(t);
  if (t.state.phase === 'dusk') return duskStep(t);
  return nightStep(t, limits);
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

function sunsetText(startedAt) {
  const clock = sunsetClock(startedAt, ctx.cardData?.data.settings, serverTime(ctx.session));
  const elapsed = Math.floor(clock.elapsed / MINUTE);
  return clock.passed ? `日落鐘　開局 ${elapsed} 分・時間到了` : `日落鐘　開局 ${elapsed} 分・剩 ${Math.ceil(clock.remaining / MINUTE)} 分`;
}

setInterval(() => {
  for (const node of document.querySelectorAll('.sunset-clock[data-started]')) node.textContent = sunsetText(Number(node.dataset.started));
}, 1000);

function linkButton(act, table, text, extra = {}) {
  return h('button', { class: `btn-link tc-link${extra.className ? ` ${extra.className}` : ''}`, type: 'button', data: { act, table, key: act }, disabled: busy.has(`${act}:${table}`), attrs: extra.attrs, text });
}

// 底部：第一行是日落鐘（終局寫算分的原因）與牌庫／棄牌；第二行左邊是「紀錄」「這回合結束後算分」（或取消），右邊是這一步的按鈕；
// 按鈕停用時第三行寫原因（照現行真正的條件），可以按但有要注意的事時寫提醒。
function footer(t, step) {
  const { game, state, key } = t;
  let clock = null;
  if (game && !t.ended && ctx.cardData && typeof game.startedAt === 'number') {
    clock = h('span', { class: 'tc-clock sunset-clock', data: { started: game.startedAt }, text: sunsetText(game.startedAt) });
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
  const seats = Object.keys(game.seats).length;
  const info = showStart && seats >= 5 ? null : infoBlock(t, limits, { compact: showStart });
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
function openAllButton() {
  const working = busy.has('open-all');
  return h(
    'button',
    { class: 'btn top-btn host-open-all', type: 'button', data: { act: 'open-all', key: 'open-all' }, disabled: working },
    working ? h('span', { text: '處理中…' }) : [h('span', { text: '已結束的桌' }), h('span', { text: `全部開${matchText(2)}` })],
  );
}

function topBar(room, cards) {
  const counts = new Map();
  for (const { step } of cards) counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1);
  const requests = requestList(room);
  const hosts = hostUids(room);
  const online = hosts.filter((uid) => isOnline(room, uid)).length;
  const firstEnded = cards.some(({ t }) => t.match === 1 && t.ended && t.game?.final);
  const matches = matchChips(cards);
  return [
    h('div', { class: 'host-brand', data: { key: 'brand' } }, h('p', { class: 'host-brand-title', text: '一日英國人' }), h('p', { class: 'host-brand-sub', text: '女皇陛下萬歲！・主持端' })),
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
    firstEnded ? openAllButton() : null,
    h(
      'div',
      { class: 'host-top-right', data: { key: 'right' } },
      h('span', { class: 'host-online', text: `主持端 ${online} 台在線` }),
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
  const step = seatsStep(t);
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
  const plan = openPlan(room, confirming);
  if (!plan) {
    confirming = null;
    return [];
  }
  const one = confirming.kind === 'one';
  const list = (items) => items.map((item) => `第 ${item.number} 桌`).join('、');
  let why = null;
  if (!ctx.cardData) why = ctx.cardsFailed ? '卡牌資料有問題，請找工作人員' : '卡牌資料讀取中…';
  else if (plan.ready.length === 0) why = '沒有可以開的桌：天命都要先判定完';
  const working = busy.has('open-all') || plan.ready.some((t) => busy.has(`open-match:${t.key}`));
  return [
    h('div', { class: 'scrim is-confirm', data: { key: 'confirm-scrim', act: 'cancel-confirm' } }),
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

// ---- 畫面 ----

export function renderHost(room) {
  ctx.requested = false;
  markPresent();
  // 出牌請求、黃昏與黑夜自動結算，畫面不用按；卡牌資料讀到才開始。
  if (ctx.cardData && !stopSettling) {
    stopSettling = startSettling(ctx.session, ctx.code, ctx.cardData.data, { random, onError: (error) => notify(explain(error)) });
  }
  const cards = [];
  // 每桌只畫目前那一局（有 tables/{n}-2 就是第 2 場）；tables、games、deals 有 "1-2" 這種鍵後是物件，只用 [局號] 取值。
  for (let number = 1; number <= room.meta.tableCount; number += 1) {
    const t = tableModel(room, activeKey(room, number));
    if (!t) continue;
    if (t.game) {
      watchHostDiscards(t.game);
      if (!t.ended) wakeAtSunset(t.game);
    }
    const limits = handLimits(t);
    cards.push({ t, limits, step: stepOf(t, limits) });
  }
  patchChildren($('host-top'), topBar(room, cards));
  patchChildren(
    $('host-tables'),
    cards.map(({ t, step, limits }) => tableCard(t, step, limits)),
  );
  patchChildren($('host-layer'), [...drawerLayer(room), ...confirmLayer(room)]);
  document.body.classList.toggle('has-drawer', Boolean(drawer || confirming));
  markTopHeight();
  markTruncated($('screen-host'));
}

// 頁首的提示框放在頂列下方（host.css 的 --host-top-h）：頂列在比較小的畫面會變成兩行，照實際高度放。
function markTopHeight() {
  if (!$('screen-host').hidden) document.body.style.setProperty('--host-top-h', `${$('host-top').offsetHeight}px`);
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
  next: ({ table, round, phase }) => {
    act(`next:${table}`, async () => {
      const result = await advanceOrEnd(ctx.session, ctx.code, table, { round: Number(round), phase }, ctx.cardData?.data);
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
};

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
  const target = event.target.closest('[data-change="start-order"]');
  if (target) startChoices.set(target.dataset.table, Number(target.value));
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
  const focusable = [...(panel?.querySelectorAll('button:not(:disabled), [tabindex="0"]') ?? [])];
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

// 視窗大小變了，重新看頂列多高、哪些名字被截斷。
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    markTopHeight();
    markTruncated($('screen-host'));
  }, 150);
});
