// 玩家端（手機）：階段標頭 → 主要動作區 → 手牌 → 動作列 → 分頁列（行動／階層／同桌／紀錄／天命・按住看）。
// 重畫用 patchChildren 就地更新、按鈕用 data-act 委派事件：別人的動作觸發重畫時，手牌的捲動位置、頁面捲動位置、已選的牌、
// 出價、目前分頁、按住中的天命都不會被打斷。規則與每個按鈕的作用、啟用條件與改版前相同。
// 兩場制（M9）：每次重畫先用 rules.js 的 activeKey 找自己這一桌目前的局號（第 1 場 "3"、第 2 場 "3-2"），局面、送出的票／黑夜選擇／
// 挑的棄牌、本機暫存與計時器的鍵都用局號；畫面上的「第 3 桌」用實體桌號。第 2 場準備中看得到自己的新階層與要交卡給誰（shared.js 的
// handovers），第 2 場結束看兩場合計（combinedOf）。
// 主持人控制台（docs/CONSOLE-API.md）：畫面最上面一條全場廣播（home.js 的 broadcastNodes，「知道了」只收起這支手機）；全場暫停時
// 蓋上暫停層（自己這一桌暫停前就開著的倒數先跑完）；「最後一回合」照那一場的全場日落鐘判斷。這些判斷是 player-model.js 的純函式。
import {
  DISCARD_REASONS,
  NIGHT_CHOICES,
  NIGHT_REASONS,
  REJECT_REASONS,
  VOTE_REASONS,
  chainLevel,
  choiceProblem,
  dayStatus,
  discardProblem,
  duskStage,
  needsTarget,
  nightStage,
  overLimit,
  playProblem,
  responseDeadline,
  responseProblem,
  seatsInOrder,
  showsTutorial,
  voteProblem as voteCheck,
} from '../game.js';
import { activeKey, hostUids, matchKey, parseKey } from '../rules.js';
import {
  requestDiscard,
  requestNight,
  requestPass,
  requestPlay,
  requestRespond,
  requestVote,
  serverTime,
  watchDiscard,
  watchNight,
  watchPrivate,
  watchRequest,
  watchVote,
} from '../store.js';
import { $, h, markTruncated, patchChildren } from './dom.js';
import { broadcastNodes, broadcastOf, dismissBroadcast } from './home.js';
import { buzzStep, lastRoundOf, pauseView, sunsetWakeOf } from './player-model.js';
import {
  CHAIN_BONUS,
  CHOICE_LABELS,
  END_REASON_TEXT,
  PHASE_LATIN,
  PHASE_NAMES,
  PHASE_SHORT,
  PHASE_TONES,
  SIDE_LABELS,
  SLEEP_TEXT,
  billEffectText,
  billOf,
  billTitle,
  cardName,
  chainMeter,
  choiceText,
  combinedOf,
  combinedTotalText,
  connPill,
  daySeconds,
  destinyText,
  duskMineTexts,
  eventOf,
  eventOutcome,
  eventTitle,
  explain,
  fogMeter,
  handovers,
  isOnline,
  isTied,
  logItems,
  logRounds,
  markPresent,
  matchScoreText,
  matchText,
  nameOf,
  nightMineTexts,
  nightRules,
  notify,
  outcomeText,
  parchmentCard,
  pendingText,
  playEntries,
  playersAt,
  rankedScores,
  rerenderAt,
  revealDeadline,
  revealTotal,
  ring,
  roleName,
  scoreRows,
  scoreRules,
  secondsLeft,
  sideText,
  statusBar,
  tierRows,
  todaysEvents,
  turnSince,
} from './shared.js';
import { ctx, rerender } from './state.js';

// 階層徽章中間疊的字（照 roles.json 的編號）。
const ROLE_MARKS = { r1: '貴', r2: '蒸', r3: '工', r4: '探', r5: '幫', r6: '靈' };

let composing = null; // 正在準備出的牌 { index, card, target, chainTarget }
let sending = false; // 請求送出中
let windowEnd = { id: null, timer: null }; // 響應截止時重畫一次的計時器（對應哪一張等著響應的牌）
let respondPick = null; // 響應窗口選的牌 { pending, index, card }
let ballot = null; // 正在選的票 { key: '局號:回合', side, bid, touched }；重畫時留著，換回合就清掉
let voting = false;
let duskEdit = null; // 已送出的票按了「修改」：'局號:回合'
let nightPick = null; // 正在選的 { key: '局號:回合', choice, tiers, touched }
let nightSending = false;
let nightEdit = null; // 已送出的黑夜選擇按了「修改」：'局號:回合'
let discardPick = null; // 正在挑的棄牌 { key: '局號:回合:手牌', indexes: [手牌的第幾張…], touched }
let discardSending = false;
let tab = 'action';
let lastNeed = null; // 上一次「需要我動作」的情況（帶局號）；換成新的情況就自動切回「行動」分頁
let handOpen = false; // 黃昏、黑夜時展開手牌
let logFilter = 'all';
let holding = false; // 天命按住中
let showAllDestinies = false; // 終局：看全桌天命
let showFirst = false; // 第 2 場：展開「第 1 場結算」（只讀）
let showFirstDestinies = false; // 「第 1 場結算」裡看第 1 場的全桌天命
let shownKey = null; // 上一次畫的局號：換到第 2 場時，上一場展開的東西收起來
let connected = true;
let watching = false; // 已經訂閱自己的私密資料、請求、票、黑夜選擇、棄牌
let shownPhase = null; // 上一次畫的階段：換階段時標頭淡入一次
let sunsetWake = { at: null, timer: null }; // 日落鐘到點時重畫一次的計時器（at 是伺服器時間）
let pauseWake = { at: null, timer: null }; // 「這個倒數結束後全場暫停」的倒數結束時重畫一次（蓋上暫停層）
let covered = false; // 暫停層蓋著：所有動作都不接
let generation = 0;
const stops = [];

// 最上面一條（捲動時也留在畫面上方）：「這個倒數結束後全場暫停」與全場廣播；動作列與分頁列在畫面底部，不會被它蓋到。
const topBar = h('div', { class: 'player-top', attrs: { id: 'player-top', role: 'status' }, hidden: true });
$('screen-player').prepend(topBar);
// 全場暫停層：蓋住整個玩家畫面；底下的區塊設成 inert，按不到也移不了焦點。
const pauseLayer = h('div', { class: 'pause-layer', attrs: { id: 'player-pause', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'player-pause-title', 'aria-describedby': 'player-pause-text', tabindex: '-1' }, hidden: true });
$('screen-player').append(pauseLayer);
const underPause = () => [topBar, $('player-head'), $('player-view'), $('screen-player').querySelector('.dock'), $('destiny-sheet')];

// 回首頁時清掉玩家端的訂閱與暫存。
export function resetPlayer() {
  generation += 1;
  watching = false;
  for (const stop of stops.splice(0)) stop();
  ctx.mine = ctx.myRequest = ctx.myVote = ctx.myNight = ctx.myDiscard = null;
  composing = respondPick = ballot = nightPick = discardPick = null;
  duskEdit = nightEdit = null;
  sending = voting = nightSending = discardSending = false;
  clearTimeout(windowEnd.timer);
  windowEnd = { id: null, timer: null };
  sunsetWake = wakeAt(sunsetWake, null);
  pauseWake = wakeAt(pauseWake, null);
  setCovered(false);
  topBar.hidden = true;
  topBar.replaceChildren();
  buzzSeen = { code: null, seq: 0 };
  tab = 'action';
  lastNeed = null;
  handOpen = false;
  logFilter = 'all';
  holding = false;
  showAllDestinies = false;
  showFirst = false;
  showFirstDestinies = false;
  shownKey = null;
  shownPhase = null;
  $('destiny-sheet').hidden = true;
  $('destiny-sheet').replaceChildren();
}

export function setConnected(value) {
  connected = value;
  if (!$('screen-player').hidden) rerender();
}

// ---- 訂閱自己的私密資料、請求、票、黑夜選擇、棄牌（一有變動就重畫） ----

// 快取裡已經有資料時，回呼會在訂閱的當下就跑（會再進到重畫），所以先把停止函式登記好再訂閱。
function subscribe(watch, assign) {
  let stopped = false;
  let stop = null;
  stops.push(() => {
    stopped = true;
    stop?.();
  });
  stop = watch(
    ctx.session,
    ctx.code,
    (value) => {
      assign(value);
      rerender();
    },
    () => {},
  );
  if (stopped) stop();
}

function watchAll() {
  if (watching) return;
  watching = true;
  const mine = generation;
  const fields = [
    [watchPrivate, 'mine'],
    [watchRequest, 'myRequest'],
    [watchVote, 'myVote'],
    [watchNight, 'myNight'],
    [watchDiscard, 'myDiscard'],
  ];
  for (const [watch, field] of fields) {
    if (mine !== generation) return; // 訂閱途中回了首頁
    subscribe(watch, (value) => (ctx[field] = value));
  }
}

// ---- 白晝 ----

// 白晝時畫面需要的東西：輪次、自己的請求處理到哪、等著響應的那張牌（waiting）、同桌其他人、給 playProblem 與
// responseProblem 查的局面。不是白晝或沒入座是 null。有牌在等響應時，出牌與結束這一輪都停用（busy）。
function dayContext(state, game) {
  const { mine, myRequest, cardData } = ctx;
  if (state.phase !== 'day' || !game?.seats?.[ctx.session.uid] || !cardData || !mine) return null;
  const status = dayStatus(game, state.round);
  const done = game.lastSeq?.[ctx.session.uid] ?? 0;
  const unsettled = Boolean(myRequest) && myRequest.seq > done; // 送出了、主持端還沒處理
  const rejected = !unsettled && myRequest && mine.notice?.seq === myRequest.seq ? mine.notice.reason : null;
  const waiting = game.pending ?? null;
  return {
    status,
    unsettled,
    rejected,
    waiting,
    sent: sending || unsettled,
    busy: sending || unsettled || Boolean(waiting),
    myTurn: status.current === ctx.session.uid,
    others: seatsInOrder(game.seats)
      .map(([uid]) => uid)
      .filter((uid) => uid !== ctx.session.uid),
    view: {
      round: state.round,
      phase: state.phase,
      seats: game.seats,
      startOrder: game.startOrder,
      turn: game.turn,
      pending: waiting,
      hands: { [ctx.session.uid]: mine.hand ?? [] },
    },
  };
}

// 這張牌現在為什麼出不了（出得了是 null）。要指定對象的牌先拿同桌第一個人代入，只看牌本身與成本。
function cardProblem(day, action) {
  const someone = day.others[0] ?? null;
  const reason = playProblem(day.view, ctx.session.uid, { card: action.id, target: someone, chainTarget: someone }, ctx.cardData.data);
  if (!reason) return null;
  if (!someone && ['need-target', 'need-chain-target'].includes(reason)) return '同桌沒有可以指定的人';
  return REJECT_REASONS[reason] ?? reason;
}

// 這張響應卡現在為什麼打不出去（打得出去是 null）：時間用估計的伺服器時間，主持端結算時照樣再查一次。
function answerProblem(day, action) {
  const reason = responseProblem(day.view, ctx.session.uid, { card: action.id, pending: day.waiting.id, at: serverTime(ctx.session) }, ctx.cardData.data);
  return reason ? (REJECT_REASONS[reason] ?? reason) : null;
}

// 送出請求；送出到主持端結算完之間，出牌與結束這一輪的按鈕停用。
async function submit(action) {
  sending = true;
  composing = null;
  notify();
  rerender();
  try {
    await action();
  } catch (error) {
    notify(explain(error));
  } finally {
    sending = false;
    rerender();
  }
}

// 響應截止的那一刻重畫一次：響應鈕停用、提示換成「時間到了」。
function rerenderAtDeadline(pending) {
  if (windowEnd.id === pending.id) return;
  clearTimeout(windowEnd.timer);
  const left = responseDeadline(pending) - serverTime(ctx.session);
  windowEnd = { id: pending.id, timer: left > 0 ? setTimeout(rerender, left + 50) : null };
}

// ---- 黃昏、黑夜的送出 ----

async function castVote(vote) {
  voting = true;
  notify();
  rerender();
  try {
    await requestVote(ctx.session, ctx.code, vote);
    duskEdit = null;
  } catch (error) {
    notify(explain(error));
  } finally {
    voting = false;
    rerender();
  }
}

async function sendNight(action, which) {
  if (which === 'night') nightSending = true;
  else discardSending = true;
  notify();
  rerender();
  try {
    await action();
    if (which === 'night') nightEdit = null;
  } catch (error) {
    notify(explain(error));
  } finally {
    if (which === 'night') nightSending = false;
    else discardSending = false;
    rerender();
  }
}

// 手牌第幾張（同一張牌有好幾張時照順序對）：挑的牌對回手牌的位置。
function handIndexes(hand, cards) {
  const used = new Set();
  return cards.map((card) => {
    const index = hand.findIndex((id, at) => id === card && !used.has(at));
    used.add(index);
    return index;
  });
}

// ---- 這一次重畫要用的局面 ----

// key 是自己這一桌目前的局號（activeKey；tables、games、deals 有 "1-2" 這種鍵後是物件，只用 [局號] 取值），match 是第幾場。
// 第 2 場時 first 是同一桌第 1 場的局面（已被規則鎖住，只讀），firstSeat 是自己第 1 場的座位；prep＝主持端開了第 2 場、還沒開局。
function model(room, me) {
  const key = activeKey(room, me.table);
  const { match } = parseKey(key);
  const state = room.tables[key];
  const game = room.games?.[key];
  const first = match === 1 ? null : (room.games?.[matchKey(me.table)] ?? null);
  const firstSeat = first?.seats?.[ctx.session.uid] ?? null;
  const seat = game?.seats?.[ctx.session.uid];
  let wait = '';
  if (!game) wait = match === 1 ? '等待主持端開局' : `${matchText(match)}準備中`;
  else if (!seat && match === 1) wait = '本桌已開局，這一場沒有你的座位，請找工作人員';
  else if (!seat) wait = firstSeat ? '這一場你沒有座位（主持人設為不參加）' : `${matchText(match)}不收新人，請找工作人員`;
  else if (ctx.cardsFailed) wait = '卡牌資料有問題，請找工作人員';
  else if (!ctx.cardData || !ctx.mine) wait = '讀取手牌中…';
  const hand = ctx.mine?.hand ?? [];
  const day = wait ? null : dayContext(state, game);
  if (!day?.myTurn || hand[composing?.index] !== composing?.card) composing = null; // 換人了或那張牌已經不在
  const ended = state.phase === 'end' && Boolean(game?.final) && Boolean(ctx.cardData);
  // 最後一回合：跟主持端推進時（advanceOrEnd）同一個判斷，日落照那一場的全場日落鐘（沒有鐘的房間照這一桌從開局算起）。
  const ending = !wait && lastRoundOf(room, key, ctx.cardData?.data.settings, serverTime(ctx.session));
  return { room, me, key, match, first, firstSeat, prep: match !== 1 && !game, state, game, seat, wait, hand, day, ended, ending };
}

// ---- 到點重畫、全場廣播與暫停 ----

// 到了伺服器時間 at 時重畫一次：at 跟排好的一樣就不動，變了就改排，null 是不排。回傳新的 { at, timer }。
function wakeAt(wake, at) {
  if (wake.at === at) return wake;
  clearTimeout(wake.timer);
  const left = at === null ? 0 : at - serverTime(ctx.session);
  return { at, timer: left > 0 ? setTimeout(rerender, left + 50) : null };
}

// 日落時重畫一次（「最後一回合」、手牌上限的提示跟著換）：照 sunsetWakeOf 的日落時刻；全場鐘暫停中沒有日落時刻（null）就不排，
// 鐘一被繼續或加減，房間資料變了就會重畫、改排。
function wakeAtSunset(m) {
  sunsetWake = wakeAt(sunsetWake, sunsetWakeOf(m.room, m.key, ctx.cardData?.data.settings, serverTime(ctx.session)));
}

// 全場暫停（display/pause）對自己這一局：{ cover, until, cast }（player-model.js 的 pauseView）。
function pauseOf(m) {
  return pauseView(m.room.display, m.game, m.state, ctx.cardData?.data.settings, serverTime(ctx.session));
}

function setCovered(value) {
  if (covered === value) return;
  covered = value;
  pauseLayer.hidden = !value;
  for (const node of underPause()) node?.toggleAttribute('inert', value);
  if (!value) return;
  setHolding(false);
  pauseLayer.focus({ preventScroll: true });
}

// 暫停層：暫停字樣、目前的廣播 cast（不管這支手機收起了沒；沒有廣播、已經收回時是 null，不放）、自己的連線狀態。
function pauseNodes(cast) {
  return [
    h('span', { class: 'pause-mark', attrs: { 'aria-hidden': 'true' } }),
    h('h2', { class: 'pause-title', attrs: { id: 'player-pause-title' }, text: '暫停中' }),
    h('p', { class: 'pause-text', attrs: { id: 'player-pause-text' }, text: '請聽主持人說明' }),
    cast ? h('p', { class: 'pause-cast', data: { key: 'pause-cast' } }, h('span', { class: 'broadcast-tag', text: '廣播' }), h('span', { class: 'pause-cast-text', text: cast.text })) : null,
    h('p', { class: 'pause-conn', data: { key: 'pause-conn' } }, connPill(connected)),
  ].filter(Boolean);
}

// 最上面一條與暫停層。until 有值（暫停前就開著的倒數還在跑）時先寫「這個倒數結束後全場暫停」，到點重畫時蓋上。
// 蓋不蓋只看 pauseOf：最上面一條或層上的內容組不起來（丟出錯誤）時也照樣蓋上、擋住操作。
function renderConsole(m) {
  const { cover, until, cast } = pauseOf(m);
  pauseWake = wakeAt(pauseWake, until);
  try {
    buzzOnNew(m.room.display);
    const nodes = [
      until === null ? null : h('p', { class: 'pause-soon', data: { key: 'pause-soon' } }, h('span', { class: 'pause-soon-mark', attrs: { 'aria-hidden': 'true' } }), h('span', { text: '這個倒數結束後全場暫停' })),
      ...broadcastNodes(m.room.display, ctx.code),
    ].filter(Boolean);
    topBar.hidden = nodes.length === 0;
    patchChildren(topBar, nodes);
    if (cover) patchChildren(pauseLayer, pauseNodes(cast));
  } finally {
    setCovered(cover);
  }
}

// 現在需要我動作的情況（輪到我、響應窗口、黃昏開票、黑夜、要棄牌）；沒有是 null。
function needOf(m) {
  if (m.wait) return null;
  const { state, game, day } = m;
  if (day?.waiting && day.waiting.by !== ctx.session.uid && serverTime(ctx.session) < responseDeadline(day.waiting)) return `respond:${day.waiting.id}`;
  if (day?.myTurn && !day.status.done) return `turn:${state.round}:${day.status.turn.index}`;
  if (state.phase === 'dusk' && ['voting', 'closing'].includes(duskStage(game.dusk, state.round))) return `dusk:${state.round}`;
  if (state.phase === 'night' && ['choosing', 'closing'].includes(nightStage(game.night, state.round))) return `night:${state.round}`;
  if (state.phase === 'night' && overLimit(m.hand, ctx.cardData.data.settings) > 0 && !m.ending) return `discard:${state.round}`;
  return null;
}

// ---- 共用的小元件 ----

// 標頭與頁面的色調（<body data-phase>）：照階段；第 2 場準備中（還沒開局）是中性的 prep，不用日出的。
function toneOf(m) {
  return m.prep ? 'prep' : (PHASE_TONES[m.state.phase] ?? 'day');
}

function phaseIcon(tone) {
  return h('span', { class: `phase-icon phase-icon-${tone}`, attrs: { 'aria-hidden': 'true' } });
}

function section(key, className, ...children) {
  return h('section', { class: `panel-card ${className}`, data: { key } }, ...children);
}

function heading(latin, text) {
  return h('p', { class: 'eyebrow' }, latin ? h('span', { class: 'eyebrow-latin', text: latin, attrs: { lang: 'en' } }) : null, h('span', { text }));
}

// 圖：事件、法案、階層徽章。圖用背景圖疊在紋飾底上（multiply，白底透出羊皮紙）：之後新加的牌沒有圖時只看到紋飾底，不會出現破圖。
// 字形記號只在沒有牌（id 是 null）時顯示，有圖時不放，免得從圖的白底透出來。
function art(kind, id, glyph) {
  return h('div', { class: `art art-${kind}`, attrs: { 'aria-hidden': 'true' }, data: { glyph: id ? null : glyph } }, id ? h('span', { class: 'art-img', style: { 'background-image': `url("./assets/${kind}/${id}.webp")` } }) : null);
}

function roleBadge(roleId, size = '') {
  const known = Boolean(ROLE_MARKS[roleId]);
  const mark = ROLE_MARKS[roleId] ?? roleName(roleId).slice(0, 1);
  return h(
    'span',
    { class: `badge ${size}`, attrs: { 'aria-hidden': 'true' } },
    known ? h('span', { class: 'badge-img', style: { 'background-image': `url("./assets/roles/${roleId}.webp")` } }) : null,
    h('span', { class: 'badge-mark', text: mark }),
  );
}

function leaveButton(text = '離開房間') {
  return h('button', { class: 'btn btn-block leave', type: 'button', data: { act: 'leave' }, text });
}

function roomFoot() {
  return h('div', { class: 'room-foot', data: { key: 'room-foot' } }, h('p', { class: 'room-line' }, '房號 ', h('span', { class: 'num', text: ctx.code })), buzzToggle(), leaveButton());
}

// ---- 新廣播時短震一次（可以關；瀏覽器不支援震動就不震、也不放開關） ----

const BUZZ_OFF_KEY = 'one-day-briton:broadcast-buzz-off';
let buzzSeen = { code: null, seq: 0 }; // 這一頁看過的最新一則廣播：剛進房時看到的那一則不震

const canBuzz = () => typeof navigator.vibrate === 'function';

function buzzOff() {
  try {
    return localStorage.getItem(BUZZ_OFF_KEY) === '1';
  } catch {
    return false;
  }
}

function buzzToggle() {
  if (!canBuzz()) return null;
  const on = !buzzOff();
  return h('button', { class: 'btn-link buzz-toggle', type: 'button', data: { act: 'buzz' }, attrs: { 'aria-pressed': String(on) }, text: `新廣播時震動：${on ? '開' : '關'}` });
}

function buzzOnNew(display) {
  const step = buzzStep(buzzSeen, ctx.code, broadcastOf(display));
  buzzSeen = step.seen;
  if (!step.buzz) return;
  // 還沒碰過這一頁（剛重新整理）時瀏覽器不准震，不叫，免得留下警告。
  if (!canBuzz() || buzzOff() || navigator.userActivation?.hasBeenActive === false) return;
  try {
    navigator.vibrate(200);
  } catch {
    // 震不了就算了
  }
}

// ---- 標頭 ----

function header(m) {
  const { me, state, game } = m;
  // 第 2 場準備中：桌況已經是新一場的第 1 回合日出，但還沒開局，標頭寫「準備中」、配準備中的記號與羊皮紙底（不用日出的圖示、場景圖與底色），
  // 不寫回合、不放迷霧值，免得像已經開始了。
  let where = state.phase === 'end' ? `第 ${me.table} 桌・第 ${game?.final?.round ?? state.round} 回合結束` : `第 ${me.table} 桌・第 ${state.round} 回合`;
  if (m.prep) where = `第 ${me.table} 桌・還沒開局`;
  const phase = m.prep ? { key: 'prep', name: '準備中', latin: 'NEXT MATCH' } : { key: state.phase, name: PHASE_NAMES[state.phase] ?? state.phase, latin: PHASE_LATIN[state.phase] ?? '' };
  return [
    h('div', { class: 'head-top' }, h('span', { class: `tag tag-match${m.match === 1 ? '' : ' is-second'}`, text: matchText(m.match) }), h('span', { class: 'head-where', text: where }), connPill(connected)),
    h(
      'div',
      { class: 'head-main' },
      h('div', { class: 'head-phase phase-in', data: { key: `phase-${phase.key}` } }, phaseIcon(toneOf(m)), h('h1', { class: 'phase-name', text: phase.name }), h('span', { class: 'phase-latin', text: phase.latin, attrs: { lang: 'en' } })),
      state.phase === 'end' || m.prep ? null : fogMeter(state.fog, game?.fogFired ?? []),
    ),
  ];
}

// 每個分頁最上面的提醒：最後一回合、主持端離線。
function banners(m) {
  const nodes = [];
  if (!m.wait && m.ending) nodes.push(h('p', { class: 'banner banner-last', data: { key: 'last-round' } }, h('span', { class: 'tag tag-strong', text: '最後一回合' }), '這一回合黑夜結束後就算分'));
  if (!hostUids(m.room).some((uid) => isOnline(m.room, uid))) nodes.push(h('p', { class: 'banner banner-host', data: { key: 'host-offline' }, attrs: { role: 'status' } }, h('span', { class: 'conn is-off', text: '離線' }), '主持端目前離線'));
  return nodes;
}

// 非「行動」分頁最上面的一行：現在輪到誰／要我做什麼，「回行動」。
function strip(m) {
  const { state, game, day } = m;
  let text = PHASE_NAMES[state.phase] ?? state.phase;
  let mine = false;
  if (m.wait) text = m.wait;
  else if (day?.waiting && day.waiting.by !== ctx.session.uid) {
    text = `▶ 可以響應：${pendingText(m.room, day.waiting)}`;
    mine = true;
  } else if (day && !day.status.done) {
    mine = day.myTurn;
    text = day.myTurn ? '▶ 輪到你出牌' : `● 輪到 ${nameOf(m.room, day.status.current)} 出牌`;
  } else if (needOf(m)?.startsWith('dusk')) {
    text = '▶ 黃昏表決中';
    mine = true;
  } else if (needOf(m)?.startsWith('night')) {
    text = '▶ 黑夜：選豪賭、分贓或睡覺';
    mine = true;
  } else if (needOf(m)?.startsWith('discard')) {
    text = '▶ 手牌超過上限，要選棄牌';
    mine = true;
  } else if (game && state.phase === 'day') text = '白晝：大家都出完了';
  return h(
    'div',
    { class: `strip${mine ? ' is-mine' : ''}`, data: { key: 'strip' } },
    h('span', { class: 'strip-text', text }),
    h('button', { class: 'btn-link', type: 'button', data: { act: 'tab', tab: 'action' }, text: '回行動' }),
  );
}

// ---- 「行動」分頁 ----

function actionPanel(m) {
  const nodes = [];
  if (m.prep) return prepPanel(m);
  // 第 2 場開局了、這一場沒有自己的座位：說明，加上自己第 1 場的結算；第 2 場結束後一樣看兩場合計。
  if (m.wait && m.match !== 1 && m.game) return m.ended ? finalPanel(m) : seatlessPanel(m);
  if (m.wait) {
    nodes.push(waitCard(m));
    return nodes;
  }
  const { state } = m;
  if (m.ended) return finalPanel(m);
  const dropped = randomDiscardNote(m);
  if (dropped) nodes.push(dropped);
  if (m.match !== 1 && state.round === 1 && state.phase === 'sunrise') nodes.push(switchCard(m));
  if (state.phase === 'sunrise') nodes.push(...sunrisePanel(m));
  else if (state.phase === 'day') nodes.push(...dayPanel(m));
  else if (state.phase === 'dusk') nodes.push(...duskPanel(m));
  else if (state.phase === 'night') nodes.push(...nightPanel(m));
  else nodes.push(section('end-wait', 'is-plain', h('p', { text: '這一桌已經結束，等結算資料…' })));
  return nodes;
}

// 日出時被系統隨機棄的牌（手牌超過上限、黑夜沒挑完）：只有本人讀得到，這一回合裡都顯示。
function randomDiscardNote(m) {
  const record = ctx.mine?.randomDiscard;
  if (!record || record.round !== m.state.round || m.state.phase === 'end') return null;
  const names = Object.values(record.cards ?? {}).map((id) => `〈${cardName(id)}〉`).join('、');
  return section(`random-discard-${record.round}`, 'notice-card', h('p', { text: `手牌超過上限沒挑完，黑夜結束時隨機棄了：${names}` }));
}

// ---- 兩場制：準備中、換場說明、沒座位 ----

// 第 1 場的座位上那個人的名字（已經離開房間的人沒有名字）。
function seatName(m, uid) {
  return m.room.players?.[uid]?.name ?? null;
}

// 第 2 場準備中：自己第 2 場的階層、誰交給你、你的角色卡要交給誰（shared.js 的 handovers；方向與空位的規則在 game.js 的 rotateSeats）。
// 第 1 場之後才加入的人沒有第 1 場的座位：第 2 場不收新人。
function handoverLines(m) {
  const uid = ctx.session.uid;
  if (!m.firstSeat) return null;
  const passed = handovers(m.first.seats);
  const mine = passed.get(uid);
  const seats1 = m.first.seats;
  const giver = mine.from === uid ? '只有你一人，階層照舊' : `座位 ${seats1[mine.from].order + 1} 的 ${seatName(m, mine.from) ?? '（已離開房間）'} 交給你`;
  const receiver = [...passed].find(([, seat]) => seat.from === uid)?.[0];
  let give = null;
  if (receiver && receiver !== uid) {
    const name = seatName(m, receiver);
    give = name ? `請把你的角色卡交給座位 ${seats1[receiver].order + 1} 的 ${name}` : `座位 ${seats1[receiver].order + 1} 的人已經離開房間，你的角色卡請交給工作人員`;
  }
  return { role: mine.role, head: `你${matchText(m.match)}的階層：〈${roleName(mine.role)}〉`, from: `（${giver}）`, text: `你${matchText(m.match)}的階層：〈${roleName(mine.role)}〉（${giver}）`, give };
}

function prepPanel(m) {
  const lines = handoverLines(m);
  if (!lines) {
    return [section('prep', 'wait-card', statusBar({ kind: 'wait', icon: '!', title: `${matchText(m.match)}不收新人，請找工作人員`, sub: `第 ${m.me.table} 桌` }), leaveButton())];
  }
  return [
    section(
      'prep',
      'is-accent prep-card',
      heading('NEXT MATCH', `${matchText(m.match)}・準備中`),
      h('div', { class: 'prep-role' }, roleBadge(lines.role, 'is-large'), h('p', { class: 'prep-role-text' }, lines.head, h('span', { class: 'prep-from', text: lines.from }))),
      lines.give ? h('p', { class: 'prep-give', text: lines.give }) : null,
      h('p', { class: 'hint', text: `主持人按「開始${matchText(m.match)}」後，這裡會自動換成${matchText(m.match)}的手牌與天命，不用重新整理。${matchText(1)}的結算在「紀錄」分頁。` }),
    ),
  ];
}

// 第 2 場開局後、第 1 回合白晝之前：換場說明（新階層、重發了什麼、第 1 場的分數與名次）。
function switchCard(m) {
  const mine = m.first?.final?.scores?.[ctx.session.uid];
  const result = mine ? `${matchText(1)}你得了 ${mine.total} 分（第 ${mine.rank} 名）` : `${matchText(1)}沒有你的分數（算 0 分）`;
  return section(
    'match-switch',
    'is-accent switch-card',
    heading('NEW MATCH', `${matchText(m.match)}開始`),
    h('p', { class: 'switch-text', text: `${matchText(m.match)}開始：你是〈${roleName(m.seat.role)}〉。英鎊、影響力、手牌、天命都重發了。${result}，最後看兩場合計` }),
  );
}

function seatlessPanel(m) {
  const nodes = [section('seatless', 'wait-card', statusBar({ kind: 'wait', icon: '!', title: m.wait, sub: `第 ${m.me.table} 桌・${matchText(m.match)}` }))];
  if (m.firstSeat && m.first?.final && ctx.cardData) {
    nodes.push(h('div', { class: 'first-final is-open', data: { key: 'first-final' } }, h('h2', { class: 'list-title', text: `你的${matchText(1)}結算（只讀）` }), h('div', { class: 'first-body' }, ...scoreSummary(m.room, m.first, { ranks: false }))));
  }
  nodes.push(leaveButton());
  return nodes;
}

function waitCard(m) {
  const players = playersAt(m.room, m.me.table);
  return section(
    'wait',
    'wait-card',
    statusBar({ kind: m.game ? 'wait' : 'idle', icon: m.game ? '!' : '…', title: m.wait, sub: m.game ? '' : `第 ${m.me.table} 桌目前 ${players.length} 人` }),
    m.game ? null : h('ul', { class: 'name-list' }, players.map(([uid, player]) => h('li', { class: uid === ctx.session.uid ? 'me' : isOnline(m.room, uid) ? '' : 'offline', text: uid === ctx.session.uid ? `${player.name}（你）` : isOnline(m.room, uid) ? player.name : `${player.name}（離線）` }))),
    m.game ? null : h('p', { class: 'hint', text: '選錯桌時，先離開房間，再用同一個房號重新加入。' }),
    leaveButton(),
  );
}

// 今日事件（日出到白晝）與這一回合觸發的迷霧事件；底下寫自己現在的數字。
function eventCards(m, compact = false) {
  const { game, state, seat } = m;
  const entries = todaysEvents(game, state);
  return entries.map((entry, index) => {
    const event = eventOf(entry.event);
    const { effects, problems } = eventOutcome(entry);
    const fog = entry.kind === 'fog';
    return section(
      `event-${entry.round}-${entry.event ?? index}-${entry.kind}`,
      `event-card${fog ? ' is-fog' : ''}${compact ? ' is-compact' : ''}`,
      h(
        'div',
        { class: 'event-body' },
        heading(fog ? 'FOG' : 'TODAY', fog ? `迷霧越過 ${entry.threshold}` : '今日事件'),
        h('p', { class: 'event-name', text: fog ? eventTitle(entry).replace(/^迷霧越過 \d+：/, '') : eventTitle(entry) }),
        event && !compact ? h('p', { class: 'event-text', text: event.text }) : null,
        effects ? h('p', { class: 'event-effects', text: effects }) : null,
        problems.map((problem) => h('p', { class: 'problem-line', text: problem })),
        seat && index === entries.length - 1 ? h('p', { class: 'event-now', text: `你現在：英鎊 ${seat.pounds}・影響力 ${seat.influence}・迷霧值 ${state.fog}` }) : null,
      ),
      art('events', event ? entry.event : null, '✶'),
    );
  });
}

function sunrisePanel(m) {
  const { room, game, state } = m;
  const dealt = (room.deals?.[m.key] ?? 0) >= state.round;
  const first = dayStatus(game, state.round).order[0];
  return [
    section(
      'sunrise',
      'is-accent',
      h('h2', { class: 'card-title', text: '等主持人進入白晝' }),
      h('p', { text: `${dealt ? '薪水與抽牌都發好了。' : '主持端發薪水與抽牌中…'}白晝${first ? `由 ${nameOf(room, first)} 先出，` : ''}照座位順序輪流出牌。` }),
    ),
    ...eventCards(m),
    handBlock(m, { hint: '白晝輪到你才能出' }),
  ];
}

// 同桌的出牌順序：輪到誰、已出幾張、手牌張數。
function turnStrip(m) {
  const { room, game, state, day } = m;
  const played = new Map();
  for (const entry of playEntries(game)) if (entry.round === state.round) played.set(entry.by, (played.get(entry.by) ?? 0) + 1);
  return h(
    'ol',
    { class: 'turn-strip', data: { key: 'turn-strip' }, attrs: { 'aria-label': '出牌順序' } },
    day.status.order.map((uid) => {
      const current = uid === day.status.current;
      const me = uid === ctx.session.uid;
      const seat = game.seats[uid];
      const sub = [current ? (me ? '輪到你' : '出牌中') : null, played.get(uid) ? `已出 ${played.get(uid)}` : null, `手牌 ${seat?.handCount ?? 0}`].filter(Boolean).join('・');
      return h(
        'li',
        { class: `turn-chip${current ? ' is-current' : ''}${me ? ' is-me' : ''}`, data: { key: uid } },
        h('span', { class: 'turn-name', text: `${current ? '▶ ' : ''}${nameOf(room, uid)}` }),
        h('span', { class: 'turn-sub', text: sub }),
      );
    }),
  );
}

function requestLine(day) {
  const responding = day.waiting && day.waiting.by !== ctx.session.uid;
  if (day.sent) return h('p', { class: 'request-state', data: { key: 'request' }, attrs: { role: 'status' }, text: responding ? '已送出，等結算' : '結算中…' });
  if (day.rejected) {
    const what = ctx.myRequest?.type === 'respond' ? '響應沒有成功' : '沒有出成';
    return h('p', { class: 'request-state problem', data: { key: 'request' }, attrs: { role: 'alert' }, text: `${what}：${REJECT_REASONS[day.rejected] ?? day.rejected}` });
  }
  return null;
}

function dayPanel(m) {
  const { room, state, day } = m;
  if (!day) return [...eventCards(m), handBlock(m, { hint: '' })];
  const max = ctx.cardData.data.settings.maxPlaysPerTurn;
  const nodes = [turnStrip(m)];
  const { status, waiting } = day;
  if (status.done && !waiting) {
    nodes.push(section('day-done', 'is-plain', statusBar({ kind: 'ready', icon: '✓', title: '這一回合大家都出完了', sub: '等主持端進黃昏' })));
  } else if (waiting && waiting.by !== ctx.session.uid) {
    rerenderAtDeadline(waiting);
    const open = serverTime(ctx.session) < responseDeadline(waiting);
    nodes.push(
      section(
        'respond',
        'is-alert respond-card',
        h(
          'div',
          { class: 'turn-main' },
          h('h2', { class: 'card-title', text: open ? '可以響應' : '響應時間到了' }),
          h('p', { text: open ? `${pendingText(room, waiting)}，可以在倒數內打出響應卡` : `${pendingText(room, waiting)}——等主持端結算` }),
        ),
        ring({ deadline: responseDeadline(waiting), total: waiting.seconds, label: '響應秒', overText: '到' }),
      ),
    );
  } else if (waiting) {
    rerenderAtDeadline(waiting);
    nodes.push(
      section(
        'respond-own',
        'is-plain respond-card',
        h('div', { class: 'turn-main' }, h('h2', { class: 'card-title', text: `你打出「${cardName(waiting.card)}」` }), h('p', { text: '等其他人響應，時間到就結算' })),
        ring({ deadline: responseDeadline(waiting), total: waiting.seconds, label: '響應秒', overText: '到' }),
      ),
    );
  } else {
    nodes.push(
      section(
        'turn',
        day.myTurn ? 'is-accent turn-card' : 'is-plain turn-card',
        h(
          'div',
          { class: 'turn-main' },
          h('h2', { class: 'card-title', text: day.myTurn ? '輪到你出牌' : `輪到 ${nameOf(room, status.current)} 出牌` }),
          h('p', { class: 'turn-sub', text: `這一輪已出 ${status.turn.plays}／${max} 張・還有 ${status.remaining} 人沒出完` }),
          chainMeter(status.turn),
        ),
        ring({ since: turnSince(m.key, state.round, status.turn.index), total: daySeconds(), label: '提醒秒', overText: '超過' }),
      ),
    );
  }
  nodes.push(requestLine(day));
  nodes.push(handBlock(m, { day }));
  nodes.push(...eventCards(m, true));
  return nodes.filter(Boolean);
}

// 手牌（橫向滑動）。白晝輪到自己時點牌選取；響應窗口時只亮能打的響應牌；其他時候只看。
function handBlock(m, { day = null, hint = '' } = {}) {
  const { hand } = m;
  const responding = day?.waiting && day.waiting.by !== ctx.session.uid;
  let title = `手牌 ${hand.length} 張`;
  let note = hint;
  let cards;
  if (responding) {
    const problems = hand.map((id) => {
      const action = ctx.cardData.index.actions.get(id);
      return action ? answerProblem(day, action) : '卡牌資料裡沒有這張牌';
    });
    const ok = problems.filter((problem) => !problem).length;
    if (respondPick?.pending !== day.waiting.id || hand[respondPick.index] !== respondPick.card) {
      const index = problems.findIndex((problem) => !problem);
      respondPick = { pending: day.waiting.id, index, card: index >= 0 ? hand[index] : null };
    }
    title = `能響應的牌 ${ok} 張`;
    note = ok ? '其他牌這時不能打' : '這次沒有能打的響應卡';
    cards = hand.map((id, index) =>
      parchmentCard(id, {
        tag: 'button',
        key: `${index}:${id}`,
        data: { act: 'pick-response', index },
        selected: !problems[index] && respondPick.index === index,
        disabled: Boolean(problems[index]) || day.sent,
        why: problems[index] ?? '',
        pressed: respondPick.index === index,
      }),
    );
  } else if (day?.myTurn && !day.status.done) {
    note = day.busy ? '結算中，稍等' : '左右滑動・點牌選取';
    cards = hand.map((id, index) => {
      const action = ctx.cardData.index.actions.get(id);
      const problem = action ? cardProblem(day, action) : '卡牌資料裡沒有這張牌';
      const selected = composing?.index === index && composing.card === id;
      return parchmentCard(id, { tag: 'button', key: `${index}:${id}`, data: { act: 'pick-card', index }, selected, disabled: Boolean(problem) || day.busy, why: problem ?? '', pressed: selected });
    });
  } else {
    if (!note && day) note = day.status.done ? '白晝結束了' : '白晝輪到你才能出';
    cards = hand.map((id, index) => parchmentCard(id, { key: `${index}:${id}` }));
  }
  return h(
    'div',
    { class: 'hand', data: { key: 'hand' } },
    h('div', { class: 'hand-head' }, h('h2', { class: 'hand-title', text: title }), note ? h('span', { class: 'hand-note', text: note }) : null),
    hand.length ? h('div', { class: 'hand-row', data: { key: 'hand-row' }, attrs: { role: 'list', 'aria-label': '手牌' } }, cards.map((card) => h('div', { class: 'hand-slot', attrs: { role: 'listitem' }, data: { key: card.dataset.key } }, card))) : h('p', { class: 'hint', text: '沒有手牌' }),
  );
}

// 黃昏、黑夜：手牌收起來，按「看手牌」展開。
function handFold(m, why) {
  if (!handOpen) {
    return h(
      'div',
      { class: 'hand-fold', data: { key: 'hand-fold' } },
      h('span', {}, h('strong', { text: `手牌 ${m.hand.length} 張` }), ` ${why}`),
      h('button', { class: 'btn-link', type: 'button', data: { act: 'hand-open' }, attrs: { 'aria-expanded': 'false' }, text: '看手牌 ▸' }),
    );
  }
  return h(
    'div',
    { class: 'hand-fold is-open', data: { key: 'hand-fold' } },
    h('div', { class: 'hand-fold-head' }, h('span', {}, h('strong', { text: `手牌 ${m.hand.length} 張` }), ` ${why}`), h('button', { class: 'btn-link', type: 'button', data: { act: 'hand-open' }, attrs: { 'aria-expanded': 'true' }, text: '收起 ▾' })),
    h('div', { class: 'hand-row', data: { key: 'hand-row' } }, m.hand.map((id, index) => h('div', { class: 'hand-slot', data: { key: `${index}:${id}` } }, parchmentCard(id, { key: `${index}:${id}` })))),
  );
}

// ---- 黃昏 ----

function billCard(m, id, label = '法案表決') {
  const bill = billOf(id);
  return section(
    `bill-${id}`,
    'bill-card',
    h(
      'div',
      { class: 'bill-top' },
      h('div', { class: 'bill-body' }, heading('THE BILL', label), h('p', { class: 'bill-name', text: billTitle(id) }), bill ? h('p', { class: 'bill-text', text: bill.text }) : null),
      art('bills', bill ? id : null, '§'),
    ),
    bill
      ? h(
          'div',
          { class: 'bill-effects' },
          h('div', { class: 'bill-pass' }, h('p', { class: 'bill-effect-title', text: '通過' }), h('p', { text: billEffectText(bill.onPass) })),
          h('div', { class: 'bill-fail' }, h('p', { class: 'bill-effect-title', text: '不通過' }), h('p', { text: billEffectText(bill.onFail) })),
        )
      : h('p', { class: 'problem-line', text: '卡牌資料裡找不到這張法案' }),
  );
}

// showNow：黃昏結果卡留到黑夜、黑夜揭曉之後，「你現在」的數字已經含黑夜的變化，不再寫（只在黑夜揭曉前寫）。
function duskResult(m, result, id, { showNow = true } = {}) {
  const { room, game } = m;
  const rows = seatsInOrder(game.seats).map(([uid]) => {
    const vote = result.votes?.[uid];
    return h('li', { class: uid === ctx.session.uid ? 'me' : '', text: `${nameOf(room, uid)}：${vote ? sideText(vote) : '沒送出（算棄權）'}` });
  });
  const mineTexts = game.seats[ctx.session.uid] ? duskMineTexts(game, result, ctx.session.uid) : null;
  const bill = billOf(id);
  return [
    h('p', { class: `result-head ${result.passed ? 'is-pass' : 'is-fail'}` }, h('span', { class: 'result-mark', text: result.passed ? '✓ 通過' : '✗ 沒有通過' }), ` 贊成 ${result.yes}：反對 ${result.no}`),
    h('ul', { class: 'result-list' }, rows),
    mineTexts ? h('p', { class: 'result-mine', text: mineTexts.paid }) : null,
    mineTexts && showNow ? h('p', { class: 'result-mine', text: mineTexts.now }) : null,
    bill?.todo === true ? h('p', { class: 'problem-line', text: '這張法案的效果還沒做好（todo），這次沒有結算' }) : null,
  ];
}

function duskOpen(m) {
  const { state, game } = m;
  const stage = duskStage(game.dusk, state.round);
  return state.phase === 'dusk' && (stage === 'voting' || (stage === 'closing' && serverTime(ctx.session) < game.dusk.revealAt));
}

function sentVote(m) {
  const { myVote } = ctx;
  return myVote && String(myVote.table) === m.key && myVote.round === m.state.round ? myVote : null;
}

function syncBallot(m, sent) {
  const key = `${m.key}:${m.state.round}`;
  // 換了回合，或自己還沒動過選票時，跟著已送出的票（重新整理後自己的票可能晚一點才到）。
  if (ballot?.key !== key || !ballot.touched) ballot = { key, side: sent?.side ?? null, bid: sent?.bid ?? 0, touched: false };
  return key;
}

// 這張票現在送不送得出去：{ vote, reason }（reason 是停用原因，可以送是 null）。
function ballotState(m, sent) {
  const { key, state, game } = m;
  const vote = { table: key, round: state.round, side: ballot.side, bid: ballot.side === 'abstain' ? 0 : ballot.bid };
  const view = { table: key, round: state.round, phase: state.phase, seats: game.seats, dusk: game.dusk };
  const problem = ballot.side ? voteProblem(view, vote) : null;
  let reason = null;
  if (!ballot.side) reason = '先選贊成、反對或棄權';
  else if (problem) reason = VOTE_REASONS[problem] ?? problem;
  else if (voting) reason = '送出中…';
  const label = `${sent ? '改成這一張' : '送出'}：${ballot.side ? (ballot.side === 'abstain' ? '棄權' : `${SIDE_LABELS[ballot.side]}・出價 ${vote.bid}`) : ''}`;
  return { vote, reason, label };
}

function voteProblem(view, vote) {
  return voteCheck(view, ctx.session.uid, { ...vote, at: serverTime(ctx.session) });
}

function duskPanel(m) {
  const { state, game } = m;
  const stage = duskStage(game.dusk, state.round);
  const fold = handFold(m, '黃昏不能出牌');
  if (stage === 'none') return [section('dusk-wait', 'is-plain', statusBar({ kind: 'idle', icon: '…', title: '等主持端翻開法案…' })), fold];
  if (stage === 'adjourned') return [section('dusk-adjourned', 'is-plain', h('h2', { class: 'card-title', text: '今天議會休會' }), h('p', { text: '這一回合不用投票，等主持端進黑夜' })), fold];
  const { dusk } = game;
  const nodes = [billCard(m, dusk.bill)];
  if (stage === 'revealed') {
    nodes.push(section('dusk-result', 'result-card result-in', heading('RESULT', '揭曉'), ...duskResult(m, dusk.result, dusk.bill)));
    return [...nodes, fold];
  }
  const sent = sentVote(m);
  const total = Object.keys(game.seats).length;
  const key = syncBallot(m, sent);
  const progress = h('p', { class: 'progress-line' }, h('strong', { class: 'num', text: `已送出 ${dusk.submitted ?? 0}／${total}` }), stage === 'voting' ? reminderText(dusk.openedAt, 'dusk') : revealText('dusk', dusk, total));
  if (stage === 'closing') {
    rerenderAt(dusk.revealAt);
    nodes.push(revealCard(m, 'dusk', dusk));
  }
  if (!duskOpen(m)) {
    nodes.push(section('ballot', 'ballot-card', h('h2', { class: 'card-title', text: '你的表決' }), progress, h('p', { text: sent ? `投票截止了，等揭曉。你送出：${sideText(sent)}` : '投票截止了，你沒有送出，算棄權' })));
    return [...nodes, fold];
  }
  if (sent && duskEdit !== key) {
    nodes.push(
      section(
        'ballot',
        'ballot-card is-sent',
        h('div', { class: 'sent-row' }, h('div', {}, h('p', { class: 'hint', text: '你的表決' }), h('p', { class: 'sent-choice', text: `✓ ${sideText(sent)}` })), h('button', { class: 'btn', type: 'button', data: { act: 'dusk-edit' }, text: '修改' })),
        progress,
        h('p', { class: 'hint', text: '揭曉前可以改' }),
      ),
    );
    return [...nodes, fold];
  }
  const seat = game.seats[ctx.session.uid];
  const bid = ballot.side === 'abstain' ? 0 : ballot.bid;
  nodes.push(
    section(
      'ballot',
      'ballot-card',
      h('div', { class: 'ballot-head' }, h('h2', { class: 'card-title', text: '你的表決' }), progress),
      h(
        'div',
        { class: 'choice-row', attrs: { role: 'group', 'aria-label': '選邊' } },
        ['yes', 'no', 'abstain'].map((side) => h('button', { class: 'btn choice', type: 'button', data: { act: 'side', side }, attrs: { 'aria-pressed': String(ballot.side === side) }, text: `${ballot.side === side ? '✓ ' : ''}${SIDE_LABELS[side]}` })),
      ),
      h(
        'div',
        { class: 'bid-row' },
        h('div', {}, h('p', { class: 'bid-title', text: '影響力出價' }), h('p', { class: 'hint', text: `0 到 ${seat.influence}・選邊的人不論輸贏都要付；棄權不用付` })),
        h(
          'div',
          { class: 'stepper', attrs: { role: 'group', 'aria-label': '影響力出價' } },
          h('button', { class: 'btn step', type: 'button', data: { act: 'bid', step: -1 }, attrs: { 'aria-label': '少 1' }, disabled: ballot.side === 'abstain' || bid <= 0, text: '−' }),
          h('output', { class: 'step-value num', attrs: { 'aria-live': 'polite' }, text: bid }),
          h('button', { class: 'btn step', type: 'button', data: { act: 'bid', step: 1 }, attrs: { 'aria-label': '多 1' }, disabled: ballot.side === 'abstain' || bid >= seat.influence, text: '+' }),
        ),
      ),
      h('p', { class: 'note', text: ballot.side === 'abstain' ? '棄權不用付影響力。揭曉前可以改。' : `揭曉時付 ${bid} 影響力（不論輸贏），剩 ${seat.influence - bid}。揭曉前可以改。` }),
      sent ? h('button', { class: 'btn-link', type: 'button', data: { act: 'dusk-cancel-edit' }, text: `不改了（維持 ${sideText(sent)}）` }) : null,
    ),
  );
  return [...nodes, fold];
}

// 提醒倒數（只顯示，不會自動揭曉）與揭曉倒數：照伺服器時間，每 250 毫秒更新（shared.js）。
function countdownSpan(className, deadline, seconds, before, after, over) {
  const left = secondsLeft(deadline, seconds);
  return h('span', { class: `server-countdown progress-time ${className}`, data: { deadline, seconds, before, after, over }, text: left > 0 ? `${before}${left}${after}` : over });
}

function reminderText(openedAt, phase) {
  const seconds = ctx.cardData?.data.settings.reminderSeconds[phase] ?? 120;
  return countdownSpan('', openedAt + seconds * 1000, seconds, '・提醒 ', ' 秒', `・已經超過 ${seconds} 秒（只是提醒）`);
}

// 揭曉倒數照實際：倒數到截止＋緩衝（主持端真正揭曉的時間），到 0 還沒揭曉寫「揭曉中…」。提前揭曉時不是大家都送出了。
function revealText(kind, at, total) {
  const all = (at.submitted ?? 0) >= total;
  return countdownSpan('is-reveal', revealDeadline(kind, at), revealTotal(kind), `・${all ? '大家都送出了' : '已截止'}，`, ' 秒後揭曉', '・揭曉中…');
}

// 「大家都送出了」之後的揭曉：大數字倒數圈（每秒輕輕放大回彈），倒數到真正揭曉的時間；到 0 還沒揭曉寫「揭曉中…」。
function revealCard(m, kind, at) {
  const deadline = revealDeadline(kind, at);
  rerenderAt(deadline);
  const all = (at.submitted ?? 0) >= Object.keys(m.game.seats).length;
  const over = serverTime(ctx.session) >= deadline;
  return section(
    `reveal-${kind}-${m.state.round}`,
    'reveal-card',
    heading(kind === 'dusk' ? 'THE BILL' : 'NIGHT', '揭曉倒數'),
    ring({ deadline, total: revealTotal(kind), label: '揭曉倒數', overText: '…', big: true }),
    h('p', { class: 'reveal-hint', text: over ? '揭曉中…' : all ? '大家都送出了，倒數完就揭曉' : '主持人提前截止，倒數完就揭曉' }),
  );
}

// ---- 黑夜 ----

function sentNight(m) {
  const { myNight } = ctx;
  return myNight && String(myNight.table) === m.key && myNight.round === m.state.round ? myNight : null;
}

function nightOpen(m) {
  const { state, game } = m;
  const stage = nightStage(game.night, state.round);
  return stage === 'choosing' || (stage === 'closing' && serverTime(ctx.session) < game.night.revealAt);
}

function syncNightPick(m, sent) {
  const key = `${m.key}:${m.state.round}`;
  // 換了回合，或自己還沒動過時，跟著已送出的選擇（重新整理後自己的選擇可能晚一點才到）。
  if (nightPick?.key !== key || !nightPick.touched) nightPick = { key, choice: sent?.choice ?? null, tiers: sent?.tiers ?? 1, touched: false };
  return key;
}

function nightState(m, sent) {
  const { key, state, game } = m;
  const pick = { table: key, round: state.round, choice: nightPick.choice, tiers: nightPick.choice === 'gamble' ? nightPick.tiers : null };
  const view = { table: key, round: state.round, phase: state.phase, seats: game.seats, night: game.night };
  const problem = nightPick.choice ? choiceProblem(view, ctx.session.uid, { ...pick, at: serverTime(ctx.session) }) : null;
  let reason = null;
  if (!nightPick.choice) reason = '先選豪賭、分贓或睡覺';
  else if (problem) reason = NIGHT_REASONS[problem] ?? problem;
  else if (nightSending) reason = '送出中…';
  return { pick, reason, label: `${sent ? '改成這個' : '送出'}：${nightPick.choice ? choiceText(pick) : ''}` };
}

function nightPanel(m) {
  const { room, state, game } = m;
  const nodes = [];
  const duskNow = duskStage(game.dusk, state.round);
  const stage = nightStage(game.night, state.round);
  if (duskNow === 'revealed') {
    nodes.push(section('dusk-summary', 'summary-card', h('p', { class: 'summary-title' }, h('span', { class: 'hint', text: '黃昏揭曉' }), ' ', h('strong', { text: billTitle(game.dusk.bill) })), ...duskResult(m, game.dusk.result, game.dusk.bill, { showNow: stage !== 'revealed' })));
  } else if (duskNow === 'adjourned') {
    nodes.push(section('dusk-summary', 'summary-card', h('p', { class: 'hint', text: '今天議會休會，沒有投票' })));
  }
  if (showsTutorial(m.match, state.round)) {
    const tips = (ctx.cardData.data.tutorial ?? []).filter((tip) => tip.phase === 'night');
    if (tips.length) nodes.push(section('night-tips', 'tips-card', tips.map((tip) => h('p', { class: 'hint', text: `提示：${tip.text}` }))));
  }
  const sent = sentNight(m);
  if (stage === 'none') nodes.push(section('night', 'is-plain', statusBar({ kind: 'idle', icon: '…', title: '等主持端開始黑夜…' })));
  else if (stage === 'revealed') {
    const result = game.night.result;
    const mineTexts = nightMineTexts(game, result, ctx.session.uid);
    // 沒送出的人結果有 missed（M11 起）；舊資料沒有這一欄時照自己這台裝置有沒有送出來寫。
    const missed = result.players?.[ctx.session.uid]?.missed ?? !sent;
    nodes.push(
      section(
        'night-result',
        'result-card result-in',
        heading('NIGHT', '黑夜揭曉'),
        h('ul', { class: 'result-list' }, seatsInOrder(game.seats).map(([uid]) => {
          const outcome = result.players?.[uid];
          return h('li', { class: uid === ctx.session.uid ? 'me' : '', text: `${nameOf(room, uid)}：${outcome ? outcomeText(outcome) : SLEEP_TEXT}` });
        })),
        mineTexts ? h('p', { class: 'result-mine', text: mineTexts.night }) : null,
        mineTexts ? h('p', { class: 'result-mine', text: mineTexts.now }) : null,
        missed ? h('p', { class: 'hint', text: '你沒有送出，算睡覺' }) : null,
      ),
    );
  } else {
    const { night } = game;
    const key = syncNightPick(m, sent);
    const total = Object.keys(game.seats).length;
    const progress = h('p', { class: 'progress-line' }, h('strong', { class: 'num', text: `已送出 ${night.submitted ?? 0}／${total}` }), stage === 'choosing' ? reminderText(night.openedAt, 'night') : revealText('night', night, total));
    if (stage === 'closing') {
      rerenderAt(night.revealAt);
      nodes.push(revealCard(m, 'night', night));
    }
    if (!nightOpen(m)) {
      nodes.push(section('night', 'night-card', h('h2', { class: 'card-title', text: '今晚要做什麼？' }), progress, h('p', { text: sent ? `黑夜截止了，等揭曉。你送出：${choiceText(sent)}` : '黑夜截止了，你沒有送出，算睡覺' })));
    } else if (sent && nightEdit !== key) {
      nodes.push(
        section(
          'night',
          'night-card is-sent',
          h('div', { class: 'sent-row' }, h('div', {}, h('p', { class: 'hint', text: '你今晚的選擇' }), h('p', { class: 'sent-choice', text: `✓ ${choiceText(sent)}` })), h('button', { class: 'btn', type: 'button', data: { act: 'night-edit' }, text: '修改' })),
          progress,
          h('p', { class: 'hint', text: '揭曉前可以改' }),
        ),
      );
    } else {
      nodes.push(nightForm(m, progress, sent));
    }
  }
  nodes.push(...discardPanel(m));
  if (!nodes.some((node) => node.dataset.key === 'discard')) nodes.push(handFold(m, '黑夜不能出牌'));
  return nodes;
}

function nightForm(m, progress, sent) {
  const rules = nightRules();
  const limit = ctx.cardData.data.settings.handLimit;
  const option = (choice, title, desc, extra = null) =>
    h(
      'div',
      { class: `night-option${nightPick.choice === choice ? ' is-chosen' : ''}`, data: { key: `opt-${choice}` } },
      h(
        'button',
        { class: 'night-option-head', type: 'button', data: { act: 'choice', choice }, attrs: { 'aria-pressed': String(nightPick.choice === choice) } },
        h('span', { class: 'radio', attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'night-option-title', text: title }),
        h('span', { class: 'night-option-desc', text: desc }),
      ),
      extra,
    );
  const tiers = h(
    'div',
    { class: 'tier-row', attrs: { role: 'group', 'aria-label': '豪賭最多賭到' } },
    tierRows().map((row) =>
      h(
        'button',
        { class: 'tier', type: 'button', data: { act: 'tier', tiers: row.tier }, attrs: { 'aria-pressed': String(nightPick.choice === 'gamble' && nightPick.tiers === row.tier) } },
        h('span', { class: 'tier-title', text: `第 ${row.tier} 層` }),
        h('span', { class: 'tier-odds', text: row.odds }),
        h('span', { class: 'tier-gain', text: `${row.gain}${row.treasure ? '（秘寶）' : ''}` }),
      ),
    ),
  );
  return section(
    'night',
    'night-card',
    h('h2', { class: 'card-title', text: '今晚要做什麼？' }),
    progress,
    h('p', { class: 'hint', text: '揭曉前可以改；沒送出算睡覺' }),
    NIGHT_CHOICES.map((choice) => {
      if (choice === 'gamble') return option(choice, CHOICE_LABELS[choice], '從第 1 層開始，每層擲一顆六面骰，過到選的那一層就收手拿走累積', h('div', { class: 'gamble-extra' }, tiers, h('p', { class: 'note', text: `爆了累積歸零，另付 ${rules.medicalFee} 英鎊醫藥費（不夠就付到 0）` })));
      if (choice === 'split') return option(choice, CHOICE_LABELS[choice], `選分贓的人平分 ${rules.splitPounds} 英鎊（捨去）、每人記 ${rules.splitSin} 罪孽`);
      if (choice === 'sleep') return option(choice, CHOICE_LABELS[choice], '什麼都不發生');
      return option(choice, CHOICE_LABELS[choice] ?? choice, '');
    }),
    overLimit(m.hand, ctx.cardData.data.settings) === 0 && limit ? h('p', { class: 'hint', text: `手牌上限 ${limit} 張：超過的人在黑夜挑要棄的牌，黑夜結束時棄掉。你現在 ${m.hand.length} 張。` }) : null,
    sent ? h('button', { class: 'btn-link', type: 'button', data: { act: 'night-cancel-edit' }, text: `不改了（維持 ${choiceText(sent)}）` }) : null,
  );
}

// 手牌超過上限時：要棄幾張、點牌挑選；已送出的挑選合法就寫「已選好」。黑夜期間（揭曉前後）都可以改。
function discardState(m) {
  const { hand } = m;
  const { settings } = ctx.cardData.data;
  const over = overLimit(hand, settings);
  if (over === 0 || m.state.phase !== 'night') return null;
  if (m.ending) return { ending: true, over };
  const where = { table: m.key, round: m.state.round };
  const { myDiscard } = ctx;
  const saved = myDiscard && String(myDiscard.table) === m.key && myDiscard.round === m.state.round ? myDiscard : null;
  const problem = saved ? discardProblem(hand, saved, where, settings) : 'no-pick';
  const key = `${m.key}:${m.state.round}:${hand.join()}`;
  if (discardPick?.key !== key || !discardPick.touched) {
    discardPick = { key, indexes: problem === null ? handIndexes(hand, Object.values(saved.cards)) : [], touched: false };
  }
  const cards = [...discardPick.indexes].sort((a, b) => a - b).map((index) => hand[index]);
  let reason = null;
  if (cards.length < over) reason = `再選 ${over - cards.length} 張才能確定棄牌`;
  else if (cards.length > over) reason = `多選了 ${cards.length - over} 張，請取消 ${cards.length - over} 張`;
  else if (discardSending) reason = '送出中…';
  return { over, where, saved, problem, cards, reason };
}

function discardPanel(m) {
  const info = discardState(m);
  if (!info) return [];
  const { settings } = ctx.cardData.data;
  // 這一回合黑夜結束就算分：終局不棄牌（棄牌在下一回合日出才做），天命判定的手牌照上限算（game.js 的 destinyDone）。
  if (info.ending) return [section('discard-skip', 'is-plain', h('p', { text: `手牌 ${m.hand.length} 張超過上限，但這一回合結束就算分：不用棄牌，算分時超過上限的照上限 ${settings.handLimit} 張算` }))];
  const { over, saved, problem } = info;
  let state;
  if (problem === null) state = h('p', { class: 'discard-state is-ready', text: `已選好：${Object.values(saved.cards).map(cardName).join('、')}（黑夜結束前可以改）` });
  else if (saved) state = h('p', { class: 'discard-state problem', text: `之前選的不能用（${DISCARD_REASONS[problem] ?? problem}），請重選` });
  else state = h('p', { class: 'discard-state', text: '還沒選；沒選的話，黑夜結束時隨機棄' });
  return [
    h(
      'section',
      { class: 'discard', data: { key: 'discard' } },
      h('h2', { class: 'discard-title', text: `手牌超過上限，選 ${over} 張棄掉` }),
      h('p', { class: 'discard-sub' }, h('span', { text: `手牌 ${m.hand.length} 張・上限 ${settings.handLimit}` }), h('strong', { class: 'num', text: `已選 ${discardPick.indexes.length}／${over}` })),
      state,
      h(
        'div',
        { class: 'discard-grid' },
        m.hand.map((id, index) => {
          const chosen = discardPick.indexes.includes(index);
          return parchmentCard(id, { tag: 'button', key: `${index}:${id}`, data: { act: 'discard-pick', index }, selected: chosen, flag: '棄', pressed: chosen });
        }),
      ),
    ),
  ];
}

// ---- 終局 ----

function medal(rank) {
  return h('div', { class: 'rank-medal', attrs: { 'aria-hidden': 'true' } }, h('span', { text: '第' }), h('strong', { class: 'num', text: rank }), h('span', { text: '名' }));
}

function scoreTable(score, caption) {
  return h(
    'table',
    { class: 'score-table' },
    h('caption', { class: 'sr-only', text: caption }),
    h('tbody', {}, scoreRows(score).map((row) => h('tr', { class: row.label === '總分' ? 'is-total' : '' }, h('th', { attrs: { scope: 'row' }, text: row.label }), h('td', { text: row.detail }), h('td', { class: 'num score-points', text: row.points })))),
  );
}

// 一場的結算：自己的名次與分數明細、全桌名次（ranks 是 false 時不列）。第 1 場結束時的畫面，也是第 2 場裡「第 1 場結算」展開後的內容
// （只讀）；note 是名次底下多一行的說明。
function scoreSummary(room, game, { ranks = true, note = null } = {}) {
  const { final } = game;
  const mine = final.scores?.[ctx.session.uid];
  const nodes = [];
  const reason = `第 ${final.round} 回合結束後算分（${END_REASON_TEXT[final.reason] ?? final.reason}）`;
  const noteLine = note ? h('p', { class: 'final-next', text: note }) : null;
  if (mine) {
    nodes.push(
      section('final-mine', 'final-card', medal(mine.rank), h('div', {}, h('h2', { class: 'final-total', text: `你是第 ${mine.rank} 名，總分 ${mine.total}` }), h('p', { class: 'hint', text: reason }), noteLine)),
      section('final-detail', 'score-card', scoreTable(mine, '你的分數明細')),
    );
  } else {
    nodes.push(section('final-mine', 'final-card', h('div', {}, h('h2', { class: 'card-title', text: '終局結算' }), h('p', { class: 'hint', text: reason }), noteLine)));
  }
  if (!ranks) return nodes;
  nodes.push(
    h('h2', { class: 'list-title', data: { key: 'rank-title' }, text: '全桌名次' }),
    h(
      'ol',
      { class: 'rank-list', data: { key: 'rank-list' } },
      rankedScores(game).map(([uid, score]) => {
        const seat = game.seats[uid];
        const done = score.destiny?.done === true ? `天命 ✓ 達成 +${score.destiny.points}` : score.destiny?.done === false ? '天命 ✗ 沒達成' : score.destiny?.id ? '天命 ？待主持人判定' : '沒有天命';
        return h(
          'li',
          { class: `rank-row${uid === ctx.session.uid ? ' is-me' : ''}`, data: { key: uid, uid } },
          h('span', { class: 'rank-no', text: `第 ${score.rank}` }),
          h('span', { class: 'rank-who' }, h('strong', { text: nameOf(room, uid) }), h('span', { class: 'hint', text: `${seat ? roleName(seat.role) : ''}・${done}` })),
          h('span', { class: 'rank-total num', text: score.total }),
        );
      }),
    ),
  );
  return nodes;
}

function destiniesCard(key, title, room, game) {
  return section(
    key,
    'destinies-card',
    h('h2', { class: 'card-title', text: title }),
    h('ul', { class: 'result-list' }, rankedScores(game).map(([uid, score]) => h('li', {}, h('strong', { text: `${nameOf(room, uid)}：` }), destinyText(score.destiny)))),
  );
}

function destiniesButton(act, open) {
  return h('button', { class: 'btn', type: 'button', data: { act }, attrs: { 'aria-expanded': String(open) }, text: open ? '收起全桌天命' : '看全桌天命' });
}

function finalPanel(m) {
  if (m.match !== 1) return combinedPanel(m);
  const { room, game } = m;
  return [
    ...scoreSummary(room, game, { note: `如果主持人開${matchText(2)}，這裡會自動換過去，不用重新整理` }),
    h('div', { class: 'final-actions', data: { key: 'final-actions' } }, destiniesButton('all-destinies', showAllDestinies), leaveButton()),
    showAllDestinies ? destiniesCard('all-destinies', '全桌天命', room, game) : null,
  ].filter(Boolean);
}

// 「第 1 場結算」（只讀）：展開後是第 1 場結束時的畫面。open 是 false 時只有展開的按鈕；toggle 是 false 時一直展開、不出現按鈕。
function firstFinalBlock(m, { open, toggle = true }) {
  const { room, first } = m;
  if (!first?.final || !ctx.cardData) return null;
  const head = toggle
    ? h('button', { class: 'btn btn-block first-toggle', type: 'button', data: { act: 'first-final' }, attrs: { 'aria-expanded': String(open) }, text: open ? `收起${matchText(1)}結算` : `${matchText(1)}結算（只讀）▸` })
    : h('h2', { class: 'list-title', text: `${matchText(1)}結算（只讀）` });
  return h(
    'div',
    { class: `first-final${open ? ' is-open' : ''}`, data: { key: 'first-final' } },
    head,
    open ? h('div', { class: 'first-body' }, ...scoreSummary(room, first), h('div', { class: 'final-actions' }, destiniesButton('first-destinies', showFirstDestinies)), showFirstDestinies ? destiniesCard('first-destinies', `${matchText(1)}全桌天命`, room, first) : null) : null,
  );
}

// 第 2 場結束，由上而下：兩場合計的名次與算式、第 2 場分數明細、全桌合計名次表、看全桌天命（第 2 場）與「第 1 場結算」。合計一律用
// game.js 的 combineScores（shared.js 的 combinedOf），畫面不自己加。
function combinedPanel(m) {
  const { room, game, first } = m;
  const uid = ctx.session.uid;
  const combined = combinedOf(room, m.me.table) ?? {};
  const row = combined[uid];
  const mine = game.final.scores?.[uid];
  const reason = `${matchText(2)}第 ${game.final.round} 回合結束後算分（${END_REASON_TEXT[game.final.reason] ?? game.final.reason}）`;
  const nodes = [];
  if (row) {
    nodes.push(
      section(
        'combined-mine',
        'final-card combined-card',
        medal(row.rank),
        h(
          'div',
          {},
          h('h2', { class: 'final-total', text: `兩場合計第 ${row.rank} 名${isTied(combined, row) ? '（並列）' : ''}` }),
          h('p', { class: 'combined-sum', text: `合計 ${row.total} 分＝${matchText(1)} ${matchScoreText(row, first?.final, uid, 1)}＋${matchText(2)} ${matchScoreText(row, game.final, uid, 2)}` }),
          row.pending ? h('p', { class: 'final-next', text: `你${matchText(2)}的天命還待主持人判定，判定後合計會跟著變` }) : null,
          h('p', { class: 'hint', text: reason }),
        ),
      ),
    );
  } else {
    nodes.push(section('combined-mine', 'final-card', h('div', {}, h('h2', { class: 'card-title', text: '兩場合計' }), h('p', { class: 'hint', text: reason }))));
  }
  if (mine) nodes.push(section('final-detail', 'score-card', h('h2', { class: 'list-title', text: `你的${matchText(2)}分數明細` }), scoreTable(mine, `你的${matchText(2)}分數明細`)));
  nodes.push(
    h('h2', { class: 'list-title', data: { key: 'combined-title' }, text: '全桌兩場合計' }),
    h(
      'table',
      { class: 'combined-table', data: { key: 'combined-table' } },
      h('thead', {}, h('tr', {}, ['名次', `名字（${matchText(2)}的階層）`, matchText(1), matchText(2), '合計'].map((text) => h('th', { attrs: { scope: 'col' }, text })))),
      h(
        'tbody',
        {},
        Object.entries(combined).map(([who, line]) => {
          const seat = game.seats[who];
          return h(
            'tr',
            { class: who === uid ? 'is-me' : '', data: { key: who } },
            h('td', { class: 'combined-rank' }, `第 ${line.rank}`, isTied(combined, line) ? h('small', { text: '並列' }) : null),
            h('td', { class: 'combined-who' }, h('strong', { text: nameOf(room, who) }), h('small', { text: seat ? roleName(seat.role) : `${matchText(2)}沒座位` })),
            h('td', { class: 'num', text: line.missingFirst ? '—' : line.first }),
            h('td', { class: 'num', text: line.absent ? '沒參加' : `${line.second}${line.pending ? '+?' : ''}` }),
            h('td', { class: 'num combined-total', text: combinedTotalText(line) }),
          );
        }),
      ),
    ),
    h('div', { class: 'final-actions', data: { key: 'final-actions' } }, destiniesButton('all-destinies', showAllDestinies), h('button', { class: 'btn', type: 'button', data: { act: 'first-final' }, attrs: { 'aria-expanded': String(showFirst) }, text: showFirst ? `收起${matchText(1)}結算` : `${matchText(1)}結算` })),
    showAllDestinies ? destiniesCard('all-destinies', `${matchText(2)}全桌天命`, room, game) : null,
    showFirst ? firstFinalBlock(m, { open: true, toggle: false }) : null,
    leaveButton(),
  );
  return nodes.filter(Boolean);
}

// ---- 「階層」分頁 ----

function rolePanel(m) {
  if (m.prep) {
    const lines = handoverLines(m);
    return [section('role-wait', 'is-plain', h('p', { text: lines ? lines.text : `${matchText(m.match)}不收新人，請找工作人員` }), lines?.give ? h('p', { text: lines.give }) : null), roomFoot()];
  }
  if (m.wait) return [section('role-wait', 'is-plain', h('p', { text: m.wait })), roomFoot()];
  const { seat } = m;
  const role = ctx.cardData.index.roles.get(seat.role);
  return [
    section(
      'role',
      'role-card',
      h('div', { class: 'role-top' }, roleBadge(seat.role, 'is-large'), h('div', {}, h('p', { class: 'hint', text: '你的階層' }), h('h2', { class: 'role-name', text: role?.name ?? seat.role }))),
      h('dl', { class: 'money' }, h('div', {}, h('dt', { text: '英鎊' }), h('dd', { class: 'num', text: seat.pounds })), h('div', {}, h('dt', { text: '影響力' }), h('dd', { class: 'num', text: seat.influence })), h('div', {}, h('dt', { text: '罪孽' }), h('dd', { class: 'num', text: seat.sin ?? 0 }))),
    ),
    section('missions', 'list-card', h('h2', { class: 'card-title', text: '使命' }), h('ul', { class: 'diamond-list' }, (role?.missions ?? []).map((text) => h('li', { text })))),
    section('privileges', 'list-card', h('h2', { class: 'card-title', text: '特權' }), h('ul', { class: 'plain-list' }, (role?.privileges ?? []).map((text) => h('li', { text })))),
    h('p', { class: 'hint center', data: { key: 'destiny-note' }, text: '隱藏天命不在這裡——按住右下角「天命」才看得到' }),
    roomFoot(),
  ];
}

// ---- 「同桌」分頁 ----

function matesPanel(m) {
  const { room, game, day } = m;
  const players = playersAt(room, m.me.table);
  if (!game) {
    return [
      section('mates', 'is-plain', h('h2', { class: 'card-title', text: `同桌 ${players.length} 人` }), h('ul', { class: 'name-list' }, players.map(([uid, player]) => h('li', { class: uid === ctx.session.uid ? 'me' : isOnline(room, uid) ? '' : 'offline', text: uid === ctx.session.uid ? `${player.name}（你）` : isOnline(room, uid) ? player.name : `${player.name}（離線）` }))), h('p', { class: 'hint', text: m.prep ? `等主持人開始${matchText(m.match)}` : '等待主持端開局' })),
    ];
  }
  const current = day && !day.status.done ? day.status.current : null;
  const seated = seatsInOrder(game.seats);
  const unseated = players.filter(([uid]) => !game.seats[uid]);
  const rules = scoreRules();
  return [
    h('div', { class: 'list-head', data: { key: 'mates-head' } }, h('h2', { class: 'list-title', text: `同桌 ${seated.length} 人` }), h('span', { class: 'hint', text: '照座位順序・白晝依序出牌' })),
    h(
      'table',
      { class: 'mates-table', data: { key: 'mates-table' } },
      h('thead', {}, h('tr', {}, h('th', { attrs: { scope: 'col' }, text: '座位' }), h('th', { attrs: { scope: 'col' }, text: '名字・階層' }), h('th', { class: 'num', attrs: { scope: 'col' }, text: '英鎊' }), h('th', { class: 'num', attrs: { scope: 'col' }, text: '影響' }), h('th', { class: 'num', attrs: { scope: 'col' }, text: '手牌' }), h('th', { class: 'num', attrs: { scope: 'col' }, text: '罪孽' }))),
      h(
        'tbody',
        {},
        seated.map(([uid, seat]) => {
          const player = room.players?.[uid];
          const me = uid === ctx.session.uid;
          const name = player ? (me ? `${player.name}（你）` : isOnline(room, uid) ? player.name : `${player.name}（離線）`) : '（已離開房間）';
          return h(
            'tr',
            { class: `${uid === current ? 'is-current' : ''}${me ? ' is-me' : ''}`, data: { key: uid } },
            h('td', { class: 'seat-no' }, uid === current ? h('span', { class: 'turn-mark', text: '▶', attrs: { 'aria-label': '輪到他' } }) : h('span', { class: 'num', text: seat.order + 1 })),
            h('td', { class: 'who' }, h('div', { class: 'who-row' }, roleBadge(seat.role), h('div', {}, h('strong', { class: `who-name${player && !isOnline(room, uid) ? ' offline' : ''}`, text: name }), h('span', { class: 'who-role', text: roleName(seat.role) })))),
            h('td', { class: 'num', text: seat.pounds }),
            h('td', { class: 'num', text: seat.influence }),
            h('td', { class: 'num', text: seat.handCount }),
            h('td', { class: `num${seat.sin ? ' is-sin' : ''}`, text: seat.sin ?? 0 }),
          );
        }),
        unseated.map(([uid, player]) => h('tr', { class: 'is-unseated', data: { key: uid } }, h('td', { class: 'seat-no', text: '—' }), h('td', { class: 'who', attrs: { colspan: 5 } }, h('strong', { text: uid === ctx.session.uid ? `${player.name}（你）` : player.name }), h('span', { class: 'who-role', text: m.match === 1 ? '未入座' : `${matchText(m.match)}沒座位` })))),
      ),
    ),
    h('p', { class: 'hint', data: { key: 'mates-foot' }, text: `罪孽到終局每 ${rules.sinPerPenalty} 點扣 1 分。` }),
  ];
}

// ---- 「紀錄」分頁：照回合分段、新的在上；資料是出牌紀錄、事件紀錄、黃昏與黑夜的結果（shared.js 的 logItems） ----

function logPanel(m) {
  // 第 2 場：最上面是「第 1 場結算」（只讀）；準備中還沒有第 2 場的紀錄，直接展開。
  const first = m.match === 1 ? null : firstFinalBlock(m, { open: m.prep || showFirst, toggle: !m.prep });
  if (m.prep) return [first ?? section('log-empty', 'is-plain', h('p', { class: 'hint', text: `${matchText(m.match)}開局後這裡會有出牌、事件與揭曉的紀錄` }))];
  if (!m.game || !ctx.cardData) return [section('log-empty', 'is-plain', h('p', { class: 'hint', text: '開局後這裡會有出牌、事件與揭曉的紀錄' }))];
  const filters = { all: '全部', play: '出牌', event: '事件' };
  const items = logItems(m.room, m.game).filter((item) => logFilter === 'all' || item.kind === logFilter);
  const rounds = logRounds(items);
  const current = m.state.phase === 'end' ? null : m.state.round;
  return [
    first,
    m.match === 1 ? null : h('h2', { class: 'list-title', data: { key: 'log-title' }, text: `${matchText(m.match)}的紀錄` }),
    h(
      'div',
      { class: 'log-filters', data: { key: 'log-filters' } },
      h('div', { class: 'filter-row', attrs: { role: 'group', 'aria-label': '篩選紀錄' } }, Object.entries(filters).map(([key, label]) => h('button', { class: 'btn chip-btn choice', type: 'button', data: { act: 'log-filter', filter: key }, attrs: { 'aria-pressed': String(logFilter === key) }, text: label }))),
      h('span', { class: 'hint', text: '新的在上面' }),
    ),
    rounds.length === 0 ? h('p', { class: 'hint', data: { key: 'log-none' }, text: '還沒有紀錄' }) : null,
    ...rounds.map(({ round, items: list }) =>
      h(
        'section',
        { class: 'log-round', data: { key: `round-${round}` } },
        h('h3', { class: 'log-round-title' }, `第 ${round} 回合`, h('span', { class: round === current ? 'tag-live' : 'hint', text: round === current ? '進行中' : '已結束' })),
        h(
          'ol',
          { class: 'log-list' },
          list.map((item) =>
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
    ),
  ].filter(Boolean);
}

// ---- 動作列 ----

function actionBar(m) {
  if (m.wait || tab !== 'action' || m.ended) return [];
  const { state, day } = m;
  if (state.phase === 'day' && day) {
    if (day.waiting && day.waiting.by !== ctx.session.uid) return respondBar(m, day);
    if (day.myTurn && !day.status.done) return playBar(m, day);
    return [];
  }
  if (state.phase === 'dusk' && duskOpen(m)) {
    const sent = sentVote(m);
    const key = `${m.key}:${state.round}`;
    if (sent && duskEdit !== key) return [];
    const { reason, label } = ballotState(m, sent);
    return [h('button', { class: 'btn btn-primary btn-block', type: 'button', data: { act: 'vote-send', key: 'vote-send' }, disabled: Boolean(reason), text: reason ?? label })];
  }
  if (state.phase === 'night') {
    const rows = [];
    const discard = discardState(m);
    const sent = sentNight(m);
    const choosing = nightOpen(m) && (!sent || nightEdit === `${m.key}:${state.round}`);
    // 黑夜的選擇已送出、只剩棄牌時，棄牌是主要按鈕；兩個都在時維持「送出黑夜選擇」為主。
    if (discard && !discard.ending) {
      rows.push(h('button', { class: `btn btn-block${choosing ? '' : ' btn-primary'}`, type: 'button', data: { act: 'discard-send', key: 'discard-send' }, disabled: Boolean(discard.reason), text: discard.reason ?? `選好了，棄這 ${discard.over} 張（${discard.cards.length}／${discard.over}）` }));
    }
    if (choosing) {
      const { reason, label } = nightState(m, sent);
      rows.push(h('button', { class: 'btn btn-primary btn-block', type: 'button', data: { act: 'night-send', key: 'night-send' }, disabled: Boolean(reason), text: reason ?? label }));
    }
    return rows;
  }
  return [];
}

function playBar(m, day) {
  const nodes = [];
  if (composing) {
    const action = ctx.cardData.index.actions.get(composing.card);
    const level = chainLevel(day.status.turn, action);
    const bonus = CHAIN_BONUS[Math.min(level, 4)];
    const { pounds, influence } = action.cost;
    const cost = [pounds && `${pounds} 英鎊`, influence && `${influence} 影響力`].filter(Boolean).join('＋');
    nodes.push(
      h('div', { class: 'bar-summary', data: { key: 'summary' } }, h('span', { class: 'bar-text', text: `已選「${action.name}」・${cost ? `付 ${cost}` : '不用成本'}` }), h('span', { class: 'chip', text: `這張會是 ${level} 級連鎖` })),
      bonus ? h('p', { class: 'bar-note', data: { key: 'bonus' }, text: `${level} 級連鎖：${bonus}` }) : null,
    );
    if (needsTarget(action)) nodes.push(personPicker(m, day, '指定對象', 'target'));
    if (level === 3) nodes.push(personPicker(m, day, '3 級連鎖：指定一人隨機棄 1 張', 'chainTarget'));
  } else {
    nodes.push(h('div', { class: 'bar-summary', data: { key: 'summary' } }, h('span', { class: 'bar-text', text: day.busy ? '結算中，稍等' : '點一張牌選取，或結束這一輪' })));
  }
  const action = composing ? ctx.cardData.index.actions.get(composing.card) : null;
  const level = action ? chainLevel(day.status.turn, action) : 1;
  let why = null;
  if (day.busy) why = '結算完才能出牌';
  else if (!composing) why = '先點一張牌';
  else if (needsTarget(action) && !composing.target) why = '選好指定對象才能出牌';
  else if (level === 3 && !composing.chainTarget) why = '選好要棄牌的人才能出牌';
  nodes.push(
    h(
      'div',
      { class: 'bar-buttons', data: { key: 'buttons' } },
      h('button', { class: 'btn', type: 'button', data: { act: 'pass' }, disabled: day.busy, text: '結束這一輪' }),
      h('button', { class: 'btn btn-primary', type: 'button', data: { act: 'play' }, disabled: Boolean(why), text: why ?? '確定出牌' }),
    ),
    composing ? h('button', { class: 'btn-link bar-cancel', type: 'button', data: { act: 'cancel-card', key: 'cancel' }, text: '取消選牌' }) : null,
  );
  return nodes.filter(Boolean);
}

// 選同桌的一個人（要指定對象的牌、3 級連鎖的棄牌）；選的值記在 composing，重畫時留著。
function personPicker(m, day, text, key) {
  return h(
    'label',
    { class: 'picker', data: { key: `picker-${key}` } },
    h('span', { class: 'picker-label', text }),
    h(
      'select',
      { class: 'select', data: { change: 'person', field: key } },
      h('option', { value: '', text: '請選一個人', selected: !composing[key] }),
      day.others.map((uid) => h('option', { value: uid, text: nameOf(m.room, uid), selected: composing[key] === uid })),
    ),
  );
}

function respondBar(m, day) {
  const pick = respondPick;
  const action = pick?.card ? ctx.cardData.index.actions.get(pick.card) : null;
  const problem = action ? answerProblem(day, action) : null;
  let why = null;
  if (!action) why = '沒有能打的響應卡';
  else if (problem) why = problem;
  else if (day.sent) why = '已送出，等結算';
  return [
    h('div', { class: 'bar-summary', data: { key: 'summary' } }, h('span', { class: 'bar-text', text: action ? `打出「${action.name}」：${action.text}` : `${pendingText(m.room, day.waiting)}，你這次沒有能打的響應卡` })),
    h('button', { class: 'btn btn-primary btn-block', type: 'button', data: { act: 'respond', key: 'respond' }, disabled: Boolean(why), text: why ?? '打出響應' }),
  ];
}

// ---- 天命（按住才顯示，放開就收） ----

function destinySheet(m) {
  if (!holding) return [];
  const destiny = !m.wait && ctx.mine ? ctx.cardData.index.destinies.get(ctx.mine.destiny) : null;
  const ended = m.state.phase === 'end';
  if (m.wait) {
    let text = '開局後才有天命';
    if (m.prep) text = `${matchText(m.match)}開局後才有新的天命`;
    else if (m.match !== 1 && m.game) text = '這一場你沒有座位，沒有天命';
    return [h('div', { class: 'destiny-card' }, h('p', { text }))];
  }
  return [
    h(
      'div',
      { class: 'destiny-card', attrs: { role: 'dialog', 'aria-label': '隱藏天命' } },
      h('p', { class: 'destiny-top' }, h('span', { class: 'eyebrow-latin', text: 'SECRET DESTINY', attrs: { lang: 'en' } }), h('span', { text: ended ? '終局後全桌都看得到' : '只有你看得到' })),
      destiny ? h('p', { class: 'destiny-text', text: destiny.text }) : h('p', { class: 'destiny-text', text: '這一場沒有天命' }),
      destiny ? h('div', { class: 'pcard-rule', attrs: { 'aria-hidden': 'true' } }, h('span')) : null,
      destiny ? h('p', {}, h('strong', { text: '達成條件：' }), destiny.score.text) : null,
      destiny ? h('p', {}, h('strong', { text: '達成 ' }), `+${destiny.score.points} 分`) : null,
      h('span', { class: 'destiny-seal', text: '命', attrs: { 'aria-hidden': 'true' } }),
    ),
    h('p', { class: 'destiny-hint', text: '放開手指就收起來' }),
  ];
}

function setHolding(value) {
  if (holding === value || (value && covered)) return;
  holding = value;
  const sheet = $('destiny-sheet');
  sheet.hidden = !holding;
  $('destiny-hold').classList.toggle('is-holding', holding);
  if (!holding) sheet.replaceChildren();
  else rerender();
}

// ---- 畫面 ----

export function renderPlayer(room, me) {
  markPresent();
  watchAll();
  const m = model(room, me);
  const { state } = m;
  document.body.dataset.phase = toneOf(m);
  wakeAtSunset(m);
  // 換到第 2 場（主持端開了第 2 場）：上一場展開的全桌天命、手牌收起來。
  if (shownKey !== null && shownKey !== m.key) showAllDestinies = showFirst = showFirstDestinies = handOpen = false;
  shownKey = m.key;
  // 需要我動作時自動切回「行動」分頁（只在情況換了的時候切一次；帶局號，兩場的第 1 回合不會當成同一個情況）。
  const need = needOf(m);
  const scoped = need && `${m.key}|${need}`;
  if (scoped && scoped !== lastNeed) tab = 'action';
  lastNeed = scoped;
  patchChildren($('player-head'), header(m));
  // 第 2 場準備中不放場景圖（沒有對應的圖，標頭只剩羊皮紙底）。
  const scene = m.prep ? 'prep' : ({ sunrise: 'dawn', day: 'day', dusk: 'dusk', night: 'night', end: 'finale' }[state.phase] ?? 'day');
  $('player-head').dataset.scene = scene;
  // 換階段時標頭（顏色＋場景圖）淡入 0.45 秒；系統設了減少動態效果時直接換。準備中到開局（都是日出）也算換一次。
  const look = m.prep ? 'prep' : state.phase;
  if (shownPhase !== null && shownPhase !== look) {
    $('player-head').classList.remove('is-switching');
    void $('player-head').offsetWidth;
    $('player-head').classList.add('is-switching');
  }
  shownPhase = look;
  const panels = { action: actionPanel(m), role: rolePanel(m), mates: matesPanel(m), log: logPanel(m) };
  patchChildren(
    $('player-view'),
    [
      ...banners(m),
      tab === 'action' ? null : strip(m),
      ...Object.entries(panels).map(([name, nodes]) => h('div', { class: `panel panel-${name}`, data: { key: `panel-${name}` }, hidden: tab !== name, attrs: { role: 'region', 'aria-label': { action: '行動', role: '階層', mates: '同桌', log: '紀錄' }[name] } }, nodes)),
    ].filter(Boolean),
  );
  const bar = actionBar(m);
  $('player-actions').hidden = bar.length === 0;
  patchChildren($('player-actions'), bar);
  for (const button of document.querySelectorAll('.tab-bar .tab[data-tab]')) button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
  if (holding) patchChildren($('destiny-sheet'), destinySheet(m));
  renderConsole(m);
  markTruncated($('player-view'));
}

// ---- 事件（委派）：按鈕上的 data-act 決定做什麼，做的時候讀當下的局面 ----

function current() {
  const room = ctx.latestRoom;
  const me = room?.players?.[ctx.session?.uid];
  const key = room && me ? activeKey(room, me.table) : null;
  if (!key || !room.tables?.[key]) return null;
  return model(room, me);
}

const actions = {
  tab: ({ tab: name }) => {
    tab = name;
    rerender();
    window.scrollTo({ top: 0 });
  },
  leave: () => document.dispatchEvent(new CustomEvent('player-leave')),
  'pick-card': ({ index }) => {
    const m = current();
    const at = Number(index);
    if (!m?.day?.myTurn) return;
    const id = m.hand[at];
    composing = composing?.index === at && composing.card === id ? null : { index: at, card: id, target: null, chainTarget: null };
    rerender();
  },
  'cancel-card': () => {
    composing = null;
    rerender();
  },
  play: () => {
    const m = current();
    if (!m?.day?.myTurn || !composing) return;
    const action = ctx.cardData.index.actions.get(composing.card);
    const level = chainLevel(m.day.status.turn, action);
    const wantsTarget = needsTarget(action);
    const request = { card: action.id, target: wantsTarget ? composing.target : null, chainTarget: level === 3 ? composing.chainTarget : null };
    submit(() => requestPlay(ctx.session, ctx.code, request));
  },
  pass: () => submit(() => requestPass(ctx.session, ctx.code)),
  'pick-response': ({ index }) => {
    const m = current();
    const at = Number(index);
    if (!m?.day?.waiting) return;
    respondPick = { pending: m.day.waiting.id, index: at, card: m.hand[at] };
    rerender();
  },
  respond: () => {
    const m = current();
    if (!m?.day?.waiting || !respondPick?.card) return;
    const pending = m.day.waiting.id;
    const card = respondPick.card;
    submit(() => requestRespond(ctx.session, ctx.code, { card, pending }));
  },
  side: ({ side }) => {
    const m = current();
    if (!m?.seat) return;
    ballot = { ...ballot, side, bid: side === 'abstain' ? 0 : Math.min(ballot.bid, m.seat.influence), touched: true };
    rerender();
  },
  bid: ({ step }) => {
    const m = current();
    if (!m?.seat || ballot.side === 'abstain') return;
    ballot = { ...ballot, bid: Math.max(0, Math.min(m.seat.influence, ballot.bid + Number(step))), touched: true };
    rerender();
  },
  'vote-send': () => {
    const m = current();
    if (!m?.game) return;
    const { vote, reason } = ballotState(m, sentVote(m));
    if (!reason) castVote(vote);
  },
  'dusk-edit': () => {
    const m = current();
    if (!m) return;
    duskEdit = `${m.key}:${m.state.round}`;
    ballot = null;
    rerender();
  },
  'dusk-cancel-edit': () => {
    duskEdit = null;
    ballot = null;
    rerender();
  },
  choice: ({ choice }) => {
    nightPick = { ...nightPick, choice, touched: true };
    rerender();
  },
  tier: ({ tiers }) => {
    nightPick = { ...nightPick, choice: 'gamble', tiers: Number(tiers), touched: true };
    rerender();
  },
  'night-send': () => {
    const m = current();
    if (!m?.game) return;
    const { pick, reason } = nightState(m, sentNight(m));
    if (!reason) sendNight(() => requestNight(ctx.session, ctx.code, pick), 'night');
  },
  'night-edit': () => {
    const m = current();
    if (!m) return;
    nightEdit = `${m.key}:${m.state.round}`;
    nightPick = null;
    rerender();
  },
  'night-cancel-edit': () => {
    nightEdit = null;
    nightPick = null;
    rerender();
  },
  'discard-pick': ({ index }) => {
    const at = Number(index);
    const chosen = discardPick.indexes.includes(at);
    discardPick = { ...discardPick, indexes: chosen ? discardPick.indexes.filter((value) => value !== at) : [...discardPick.indexes, at], touched: true };
    rerender();
  },
  'discard-send': () => {
    const m = current();
    const info = m ? discardState(m) : null;
    if (!info || info.ending || info.reason) return;
    sendNight(() => requestDiscard(ctx.session, ctx.code, { ...info.where, cards: info.cards }), 'discard');
  },
  'hand-open': () => {
    handOpen = !handOpen;
    rerender();
  },
  'log-filter': ({ filter }) => {
    logFilter = filter;
    rerender();
  },
  'all-destinies': () => {
    showAllDestinies = !showAllDestinies;
    rerender();
  },
  'first-final': () => {
    showFirst = !showFirst;
    rerender();
  },
  'first-destinies': () => {
    showFirstDestinies = !showFirstDestinies;
    rerender();
  },
  'broadcast-ok': ({ seq }) => {
    dismissBroadcast(ctx.code, Number(seq));
    rerender();
  },
  buzz: () => {
    try {
      if (buzzOff()) localStorage.removeItem(BUZZ_OFF_KEY);
      else localStorage.setItem(BUZZ_OFF_KEY, '1');
    } catch {
      // 存不進去就維持原狀
    }
    rerender();
  },
};

// 暫停層蓋著時什麼都不接（底下已經是 inert；不支援 inert 的舊瀏覽器靠這裡與下面的焦點檢查擋）。
$('screen-player').addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]');
  if (covered || !target || target.disabled || !$('screen-player').contains(target)) return;
  actions[target.dataset.act]?.(target.dataset, target);
});

$('screen-player').addEventListener('change', (event) => {
  const target = event.target.closest('[data-change]');
  if (covered) return;
  if (target?.dataset.change === 'person' && composing) {
    composing[target.dataset.field] = target.value || null;
    rerender();
  }
});

// 天命：按住才顯示、放開就收（觸控、滑鼠、鍵盤都一樣）；長按不跳出選單。
const hold = $('destiny-hold');
hold.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  hold.setPointerCapture?.(event.pointerId);
  setHolding(true);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) hold.addEventListener(type, () => setHolding(false));
hold.addEventListener('contextmenu', (event) => event.preventDefault());
hold.addEventListener('keydown', (event) => {
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    setHolding(true);
  }
});
hold.addEventListener('keyup', () => setHolding(false));
hold.addEventListener('blur', () => setHolding(false));
document.addEventListener('visibilitychange', () => setHolding(false));

// 暫停層蓋著時焦點留在暫停層上（用 Tab 鍵或讀出畫面的工具也到不了底下的按鈕）。
document.addEventListener('focusin', (event) => {
  if (covered && !pauseLayer.contains(event.target)) pauseLayer.focus({ preventScroll: true });
});
