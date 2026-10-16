// 玩家端（手機）：階段標頭 → 主要動作區 → 手牌 → 動作列 → 分頁列（行動／階層／同桌／紀錄／天命・按住看）。
// 重畫用 patchChildren 就地更新、按鈕用 data-act 委派事件：別人的動作觸發重畫時，手牌的捲動位置、頁面捲動位置、已選的牌、
// 出價、目前分頁、按住中的天命都不會被打斷。規則與每個按鈕的作用、啟用條件與改版前相同。
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
  eventLogList,
  needsTarget,
  nightStage,
  overLimit,
  playProblem,
  responseDeadline,
  responseProblem,
  seatsInOrder,
  voteProblem as voteCheck,
} from '../game.js';
import { hostUids } from '../rules.js';
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
import {
  CHAIN_BONUS,
  CHOICE_LABELS,
  END_REASON_TEXT,
  MATCH_TEXT,
  PHASE_LATIN,
  PHASE_NAMES,
  PHASE_SHORT,
  PHASE_TONES,
  SIDE_LABELS,
  billEffectText,
  billOf,
  billTitle,
  cardName,
  chainMeter,
  choiceText,
  connPill,
  daySeconds,
  destinyText,
  duskMineTexts,
  duskRevealSeconds,
  endReasonNow,
  eventOf,
  eventOutcome,
  eventTitle,
  explain,
  fogMeter,
  isOnline,
  markPresent,
  nameOf,
  nightMineTexts,
  nightRules,
  notify,
  outcomeText,
  parchmentCard,
  pendingText,
  playEntries,
  playText,
  playersAt,
  rankedScores,
  rerenderAt,
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
  wakeAtSunset,
} from './shared.js';
import { ctx, rerender } from './state.js';

// 階層徽章中間疊的字（照 roles.json 的編號）。
const ROLE_MARKS = { r1: '貴', r2: '蒸', r3: '工', r4: '探', r5: '幫', r6: '靈' };

let composing = null; // 正在準備出的牌 { index, card, target, chainTarget }
let sending = false; // 請求送出中
let windowEnd = { id: null, timer: null }; // 響應截止時重畫一次的計時器（對應哪一張等著響應的牌）
let respondPick = null; // 響應窗口選的牌 { pending, index, card }
let ballot = null; // 正在選的票 { key: '桌:回合', side, bid, touched }；重畫時留著，換回合就清掉
let voting = false;
let duskEdit = null; // 已送出的票按了「修改」：'桌:回合'
let nightPick = null; // 正在選的 { key: '桌:回合', choice, tiers, touched }
let nightSending = false;
let nightEdit = null; // 已送出的黑夜選擇按了「修改」：'桌:回合'
let discardPick = null; // 正在挑的棄牌 { key: '桌:回合:手牌', indexes: [手牌的第幾張…], touched }
let discardSending = false;
let tab = 'action';
let lastNeed = null; // 上一次「需要我動作」的情況；換成新的情況就自動切回「行動」分頁
let handOpen = false; // 黃昏、黑夜時展開手牌
let logFilter = 'all';
let holding = false; // 天命按住中
let showAllDestinies = false; // 終局：看全桌天命
let connected = true;
let watching = false; // 已經訂閱自己的私密資料、請求、票、黑夜選擇、棄牌
let generation = 0;
const stops = [];

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
  tab = 'action';
  lastNeed = null;
  handOpen = false;
  logFilter = 'all';
  holding = false;
  showAllDestinies = false;
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

function model(room, me) {
  const state = room.tables[me.table];
  const game = room.games?.[me.table];
  const seat = game?.seats?.[ctx.session.uid];
  let wait = '';
  if (!game) wait = '等待主持端開局';
  else if (!seat) wait = '本桌已開局，這一局沒有你的座位，請找工作人員';
  else if (ctx.cardsFailed) wait = '卡牌資料有問題，請找工作人員';
  else if (!ctx.cardData || !ctx.mine) wait = '讀取手牌中…';
  const hand = ctx.mine?.hand ?? [];
  const day = wait ? null : dayContext(state, game);
  if (!day?.myTurn || hand[composing?.index] !== composing?.card) composing = null; // 換人了或那張牌已經不在
  const ended = state.phase === 'end' && Boolean(game?.final) && Boolean(ctx.cardData);
  const ending = wait ? false : endReasonNow(game, state) !== null;
  return { room, me, state, game, seat, wait, hand, day, ended, ending };
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

function phaseIcon(phase) {
  return h('span', { class: `phase-icon phase-icon-${PHASE_TONES[phase] ?? 'day'}`, attrs: { 'aria-hidden': 'true' } });
}

function section(key, className, ...children) {
  return h('section', { class: `panel-card ${className}`, data: { key } }, ...children);
}

function heading(latin, text) {
  return h('p', { class: 'eyebrow' }, latin ? h('span', { class: 'eyebrow-latin', text: latin, attrs: { lang: 'en' } }) : null, h('span', { text }));
}

// 圖：事件、法案、階層徽章。圖用背景圖疊在紋飾底與字形記號上面：之後新加的牌沒有圖時只看到紋飾底，不會出現破圖。
function art(kind, id, glyph) {
  return h('div', { class: `art art-${kind}`, attrs: { 'aria-hidden': 'true' }, data: { glyph } }, id ? h('span', { class: 'art-img', style: { 'background-image': `url("./assets/${kind}/${id}.webp")` } }) : null);
}

function roleBadge(roleId, size = '') {
  const known = Boolean(ROLE_MARKS[roleId]);
  const mark = ROLE_MARKS[roleId] ?? roleName(roleId).slice(0, 1);
  return h(
    'span',
    { class: `badge ${size}`, attrs: { 'aria-hidden': 'true' } },
    known ? h('span', { class: 'badge-img', style: { 'background-image': `url("./assets/roles/${roleId}.png")` } }) : null,
    h('span', { class: 'badge-mark', text: mark }),
  );
}

function leaveButton(text = '離開房間') {
  return h('button', { class: 'btn btn-block leave', type: 'button', data: { act: 'leave' }, text });
}

function roomFoot() {
  return h('div', { class: 'room-foot', data: { key: 'room-foot' } }, h('p', { class: 'room-line' }, '房號 ', h('span', { class: 'num', text: ctx.code })), leaveButton());
}

// ---- 標頭 ----

function header(m) {
  const { me, state, game } = m;
  const where = state.phase === 'end' ? `第 ${me.table} 桌・第 ${game?.final?.round ?? state.round} 回合結束` : `第 ${me.table} 桌・第 ${state.round} 回合`;
  return [
    h('div', { class: 'head-top' }, h('span', { class: 'tag tag-match', text: MATCH_TEXT }), h('span', { class: 'head-where', text: where }), connPill(connected)),
    h(
      'div',
      { class: 'head-main' },
      h('div', { class: 'head-phase' }, phaseIcon(state.phase), h('h1', { class: 'phase-name', text: PHASE_NAMES[state.phase] ?? state.phase }), h('span', { class: 'phase-latin', text: PHASE_LATIN[state.phase] ?? '', attrs: { lang: 'en' } })),
      state.phase === 'end' ? null : fogMeter(state.fog, game?.fogFired ?? []),
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
  if (m.wait) {
    nodes.push(waitCard(m));
    return nodes;
  }
  const { state } = m;
  if (m.ended) return finalPanel(m);
  if (state.phase === 'sunrise') nodes.push(...sunrisePanel(m));
  else if (state.phase === 'day') nodes.push(...dayPanel(m));
  else if (state.phase === 'dusk') nodes.push(...duskPanel(m));
  else if (state.phase === 'night') nodes.push(...nightPanel(m));
  else nodes.push(section('end-wait', 'is-plain', h('p', { text: '這一桌已經結束，等結算資料…' })));
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
  const dealt = (room.deals?.[m.me.table] ?? 0) >= state.round;
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
        ring({ since: turnSince(m.me.table, state.round, status.turn.index), total: daySeconds(), label: '提醒秒', overText: '超過' }),
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
    note = ok ? '其他牌這時不能打' : '這次沒有能打的響應牌';
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

function duskResult(m, result, id) {
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
    mineTexts ? h('p', { class: 'result-mine', text: mineTexts.now }) : null,
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
  return myVote && String(myVote.table) === String(m.me.table) && myVote.round === m.state.round ? myVote : null;
}

function syncBallot(m, sent) {
  const key = `${m.me.table}:${m.state.round}`;
  // 換了回合，或自己還沒動過選票時，跟著已送出的票（重新整理後自己的票可能晚一點才到）。
  if (ballot?.key !== key || !ballot.touched) ballot = { key, side: sent?.side ?? null, bid: sent?.bid ?? 0, touched: false };
  return key;
}

// 這張票現在送不送得出去：{ vote, reason }（reason 是停用原因，可以送是 null）。
function ballotState(m, sent) {
  const { me, state, game } = m;
  const vote = { table: me.table, round: state.round, side: ballot.side, bid: ballot.side === 'abstain' ? 0 : ballot.bid };
  const view = { table: me.table, round: state.round, phase: state.phase, seats: game.seats, dusk: game.dusk };
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
    nodes.push(section('dusk-result', 'result-card', heading('RESULT', '揭曉'), ...duskResult(m, dusk.result, dusk.bill)));
    return [...nodes, fold];
  }
  const sent = sentVote(m);
  const total = Object.keys(game.seats).length;
  const key = syncBallot(m, sent);
  const progress = h('p', { class: 'progress-line' }, h('strong', { class: 'num', text: `已送出 ${dusk.submitted ?? 0}／${total}` }), stage === 'voting' ? reminderText(dusk.openedAt, 'dusk') : revealText(dusk.revealAt, duskRevealSeconds(), '投票截止了，揭曉中…'));
  if (stage === 'closing') rerenderAt(dusk.revealAt);
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

function revealText(revealAt, seconds, over) {
  return countdownSpan('is-reveal', revealAt, seconds, '・大家都送出了，', ' 秒後揭曉', `・${over}`);
}

// ---- 黑夜 ----

function sentNight(m) {
  const { myNight } = ctx;
  return myNight && String(myNight.table) === String(m.me.table) && myNight.round === m.state.round ? myNight : null;
}

function nightOpen(m) {
  const { state, game } = m;
  const stage = nightStage(game.night, state.round);
  return stage === 'choosing' || (stage === 'closing' && serverTime(ctx.session) < game.night.revealAt);
}

function syncNightPick(m, sent) {
  const key = `${m.me.table}:${m.state.round}`;
  // 換了回合，或自己還沒動過時，跟著已送出的選擇（重新整理後自己的選擇可能晚一點才到）。
  if (nightPick?.key !== key || !nightPick.touched) nightPick = { key, choice: sent?.choice ?? null, tiers: sent?.tiers ?? 1, touched: false };
  return key;
}

function nightState(m, sent) {
  const { me, state, game } = m;
  const pick = { table: me.table, round: state.round, choice: nightPick.choice, tiers: nightPick.choice === 'gamble' ? nightPick.tiers : null };
  const view = { table: me.table, round: state.round, phase: state.phase, seats: game.seats, night: game.night };
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
  if (duskNow === 'revealed') {
    nodes.push(section('dusk-summary', 'summary-card', h('p', { class: 'summary-title' }, h('span', { class: 'hint', text: '黃昏揭曉' }), ' ', h('strong', { text: billTitle(game.dusk.bill) })), ...duskResult(m, game.dusk.result, game.dusk.bill)));
  } else if (duskNow === 'adjourned') {
    nodes.push(section('dusk-summary', 'summary-card', h('p', { class: 'hint', text: '今天議會休會，沒有投票' })));
  }
  if (state.round === 1) {
    const tips = (ctx.cardData.data.tutorial ?? []).filter((tip) => tip.phase === 'night');
    if (tips.length) nodes.push(section('night-tips', 'tips-card', tips.map((tip) => h('p', { class: 'hint', text: `提示：${tip.text}` }))));
  }
  const stage = nightStage(game.night, state.round);
  const sent = sentNight(m);
  if (stage === 'none') nodes.push(section('night', 'is-plain', statusBar({ kind: 'idle', icon: '…', title: '等主持端開始黑夜…' })));
  else if (stage === 'revealed') {
    const result = game.night.result;
    const mineTexts = nightMineTexts(game, result, ctx.session.uid);
    nodes.push(
      section(
        'night',
        'result-card',
        heading('NIGHT', '黑夜揭曉'),
        h('ul', { class: 'result-list' }, seatsInOrder(game.seats).map(([uid]) => {
          const outcome = result.players?.[uid];
          return h('li', { class: uid === ctx.session.uid ? 'me' : '', text: `${nameOf(room, uid)}：${outcome ? outcomeText(outcome) : '睡覺'}` });
        })),
        mineTexts ? h('p', { class: 'result-mine', text: mineTexts.night }) : null,
        mineTexts ? h('p', { class: 'result-mine', text: mineTexts.now }) : null,
        sent ? null : h('p', { class: 'hint', text: '你沒有送出，算睡覺' }),
      ),
    );
  } else {
    const { night } = game;
    const key = syncNightPick(m, sent);
    const total = Object.keys(game.seats).length;
    const progress = h('p', { class: 'progress-line' }, h('strong', { class: 'num', text: `已送出 ${night.submitted ?? 0}／${total}` }), stage === 'choosing' ? reminderText(night.openedAt, 'night') : revealText(night.revealAt, nightRules().revealSeconds, '黑夜截止了，揭曉中…'));
    if (stage === 'closing') rerenderAt(night.revealAt);
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
    overLimit(m.hand, ctx.cardData.data.settings) === 0 && limit ? h('p', { class: 'hint', text: `手牌上限 ${limit} 張：超過的人在黑夜挑要棄的牌，下一回合日出時棄掉。你現在 ${m.hand.length} 張。` }) : null,
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
  const where = { table: m.me.table, round: m.state.round };
  const { myDiscard } = ctx;
  const saved = myDiscard && String(myDiscard.table) === String(m.me.table) && myDiscard.round === m.state.round ? myDiscard : null;
  const problem = saved ? discardProblem(hand, saved, where, settings) : 'no-pick';
  const key = `${m.me.table}:${m.state.round}:${hand.join()}`;
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
  if (problem === null) state = h('p', { class: 'discard-state is-ready', text: `已選好：${Object.values(saved.cards).map(cardName).join('、')}（天亮前可以改）` });
  else if (saved) state = h('p', { class: 'discard-state problem', text: `之前選的不能用（${DISCARD_REASONS[problem] ?? problem}），請重選` });
  else state = h('p', { class: 'discard-state', text: '還沒選；沒選的話，天亮時隨機棄' });
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

function finalPanel(m) {
  const { room, game } = m;
  const { final } = game;
  const mine = final.scores?.[ctx.session.uid];
  const nodes = [];
  const reason = `第 ${final.round} 回合結束後算分（${END_REASON_TEXT[final.reason] ?? final.reason}）`;
  if (mine) {
    nodes.push(
      section('final-mine', 'final-card', h('div', { class: 'rank-medal', attrs: { 'aria-hidden': 'true' } }, h('span', { text: '第' }), h('strong', { class: 'num', text: mine.rank }), h('span', { text: '名' })), h('div', {}, h('h2', { class: 'final-total', text: `你是第 ${mine.rank} 名，總分 ${mine.total}` }), h('p', { class: 'hint', text: reason }))),
      section(
        'final-detail',
        'score-card',
        h('table', { class: 'score-table' }, h('caption', { class: 'sr-only', text: '你的分數明細' }), h('tbody', {}, scoreRows(mine).map((row) => h('tr', { class: row.label === '總分' ? 'is-total' : '' }, h('th', { attrs: { scope: 'row' }, text: row.label }), h('td', { text: row.detail }), h('td', { class: 'num score-points', text: row.points }))))),
      ),
    );
  } else {
    nodes.push(section('final-mine', 'final-card', h('h2', { class: 'card-title', text: '終局結算' }), h('p', { class: 'hint', text: reason })));
  }
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
    h(
      'div',
      { class: 'final-actions', data: { key: 'final-actions' } },
      h('button', { class: 'btn', type: 'button', data: { act: 'all-destinies' }, attrs: { 'aria-expanded': String(showAllDestinies) }, text: showAllDestinies ? '收起全桌天命' : '看全桌天命' }),
      leaveButton(),
    ),
  );
  if (showAllDestinies) {
    nodes.push(
      section(
        'all-destinies',
        'destinies-card',
        h('h2', { class: 'card-title', text: '全桌天命' }),
        h('ul', { class: 'result-list' }, rankedScores(game).map(([uid, score]) => h('li', {}, h('strong', { text: `${nameOf(room, uid)}：` }), destinyText(score.destiny)))),
      ),
    );
  }
  return nodes;
}

// ---- 「階層」分頁 ----

function rolePanel(m) {
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
      section('mates', 'is-plain', h('h2', { class: 'card-title', text: `同桌 ${players.length} 人` }), h('ul', { class: 'name-list' }, players.map(([uid, player]) => h('li', { class: uid === ctx.session.uid ? 'me' : isOnline(room, uid) ? '' : 'offline', text: uid === ctx.session.uid ? `${player.name}（你）` : isOnline(room, uid) ? player.name : `${player.name}（離線）` }))), h('p', { class: 'hint', text: '等待主持端開局' })),
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
      h('thead', {}, h('tr', {}, h('th', { attrs: { scope: 'col' }, text: '座位' }), h('th', { attrs: { scope: 'col' }, text: '暱稱・階層' }), h('th', { class: 'num', attrs: { scope: 'col' }, text: '英鎊' }), h('th', { class: 'num', attrs: { scope: 'col' }, text: '影響' }), h('th', { class: 'num', attrs: { scope: 'col' }, text: '手牌' }), h('th', { class: 'num', attrs: { scope: 'col' }, text: '罪孽' }))),
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
        unseated.map(([uid, player]) => h('tr', { class: 'is-unseated', data: { key: uid } }, h('td', { class: 'seat-no', text: '—' }), h('td', { class: 'who', attrs: { colspan: 5 } }, h('strong', { text: uid === ctx.session.uid ? `${player.name}（你）` : player.name }), h('span', { class: 'who-role', text: '未入座' })))),
      ),
    ),
    h('p', { class: 'hint', data: { key: 'mates-foot' }, text: `罪孽到終局每 ${rules.sinPerPenalty} 點扣 1 分。` }),
  ];
}

// ---- 「紀錄」分頁：照回合分段、新的在上；資料是出牌紀錄、事件紀錄、黃昏與黑夜的結果 ----

const PHASE_ORDER = { sunrise: 0, day: 1, dusk: 2, night: 3 };

function logItems(m) {
  const { room, game } = m;
  const items = [];
  for (const entry of playEntries(game)) {
    items.push({ round: entry.round, phase: 'day', at: entry.at ?? 0, kind: 'play', icon: entry.response ? '響' : '牌', title: playText(room, entry), detail: '' });
  }
  eventLogList(game.eventLog).forEach((entry, index) => {
    const { effects, problems } = eventOutcome(entry);
    items.push({ round: entry.round, phase: entry.phase ?? 'sunrise', at: index, kind: 'event', icon: entry.kind === 'fog' ? '霧' : '✶', title: entry.kind === 'fog' ? eventTitle(entry) : `今日事件${eventTitle(entry)}`, detail: [effects, ...problems].filter(Boolean).join('；') });
  });
  for (const [round, log] of Object.entries(game.duskLog ?? {})) {
    if (!log?.bill) continue;
    items.push({ round: Number(round), phase: 'dusk', at: 0, kind: 'result', icon: '§', title: `${billTitle(log.bill)}${log.passed ? '通過' : '沒有通過'}`, detail: `贊成 ${log.yes}：反對 ${log.no}` });
  }
  for (const [round, log] of Object.entries(game.nightLog ?? {})) {
    if (!log?.players) continue;
    const lines = seatsInOrder(game.seats).map(([uid]) => `${nameOf(room, uid)}：${log.players[uid] ? outcomeText(log.players[uid]) : '睡覺'}`);
    items.push({ round: Number(round), phase: 'night', at: 0, kind: 'result', icon: '☾', title: '黑夜揭曉', detail: lines.join('；') });
  }
  return items;
}

function logPanel(m) {
  if (!m.game || !ctx.cardData) return [section('log-empty', 'is-plain', h('p', { class: 'hint', text: '開局後這裡會有出牌、事件與揭曉的紀錄' }))];
  const filters = { all: '全部', play: '出牌', event: '事件' };
  const items = logItems(m).filter((item) => logFilter === 'all' || item.kind === logFilter);
  const rounds = [...new Set(items.map((item) => item.round))].sort((a, b) => b - a);
  const current = m.state.phase === 'end' ? null : m.state.round;
  return [
    h(
      'div',
      { class: 'log-filters', data: { key: 'log-filters' } },
      h('div', { class: 'filter-row', attrs: { role: 'group', 'aria-label': '篩選紀錄' } }, Object.entries(filters).map(([key, label]) => h('button', { class: 'btn chip-btn choice', type: 'button', data: { act: 'log-filter', filter: key }, attrs: { 'aria-pressed': String(logFilter === key) }, text: label }))),
      h('span', { class: 'hint', text: '新的在上面' }),
    ),
    rounds.length === 0 ? h('p', { class: 'hint', data: { key: 'log-none' }, text: '還沒有紀錄' }) : null,
    ...rounds.map((round) => {
      const list = items
        .filter((item) => item.round === round)
        .sort((a, b) => (PHASE_ORDER[b.phase] ?? 0) - (PHASE_ORDER[a.phase] ?? 0) || b.at - a.at);
      return h(
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
      );
    }),
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
    const key = `${m.me.table}:${state.round}`;
    if (sent && duskEdit !== key) return [];
    const { reason, label } = ballotState(m, sent);
    return [h('button', { class: 'btn btn-primary btn-block', type: 'button', data: { act: 'vote-send', key: 'vote-send' }, disabled: Boolean(reason), text: reason ?? label })];
  }
  if (state.phase === 'night') {
    const rows = [];
    const discard = discardState(m);
    if (discard && !discard.ending) {
      rows.push(h('button', { class: 'btn btn-block', type: 'button', data: { act: 'discard-send', key: 'discard-send' }, disabled: Boolean(discard.reason), text: discard.reason ?? `選好了，棄這 ${discard.over} 張（${discard.cards.length}／${discard.over}）` }));
    }
    const sent = sentNight(m);
    if (nightOpen(m) && (!sent || nightEdit === `${m.me.table}:${state.round}`)) {
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
  if (!action) why = '沒有能打的響應牌';
  else if (problem) why = problem;
  else if (day.sent) why = '已送出，等結算';
  return [
    h('div', { class: 'bar-summary', data: { key: 'summary' } }, h('span', { class: 'bar-text', text: action ? `打出「${action.name}」：${action.text}` : `${pendingText(m.room, day.waiting)}，你這次沒有能打的響應牌` })),
    h('button', { class: 'btn btn-primary btn-block', type: 'button', data: { act: 'respond', key: 'respond' }, disabled: Boolean(why), text: why ?? '打出響應' }),
  ];
}

// ---- 天命（按住才顯示，放開就收） ----

function destinySheet(m) {
  if (!holding) return [];
  const destiny = !m.wait && ctx.mine ? ctx.cardData.index.destinies.get(ctx.mine.destiny) : null;
  const ended = m.state.phase === 'end';
  if (m.wait) return [h('div', { class: 'destiny-card' }, h('p', { text: '開局後才有天命' }))];
  return [
    h(
      'div',
      { class: 'destiny-card', attrs: { role: 'dialog', 'aria-label': '隱藏天命' } },
      h('p', { class: 'destiny-top' }, h('span', { class: 'eyebrow-latin', text: 'SECRET DESTINY', attrs: { lang: 'en' } }), h('span', { text: ended ? '終局後全桌都看得到' : '只有你看得到' })),
      destiny ? h('p', { class: 'destiny-text', text: destiny.text }) : h('p', { class: 'destiny-text', text: '這一局沒有天命' }),
      destiny ? h('div', { class: 'pcard-rule', attrs: { 'aria-hidden': 'true' } }, h('span')) : null,
      destiny ? h('p', {}, h('strong', { text: '達成條件：' }), destiny.score.text) : null,
      destiny ? h('p', {}, h('strong', { text: '達成 ' }), `+${destiny.score.points} 分`) : null,
      h('span', { class: 'destiny-seal', text: '命', attrs: { 'aria-hidden': 'true' } }),
    ),
    h('p', { class: 'destiny-hint', text: '放開手指就收起來' }),
  ];
}

function setHolding(value) {
  if (holding === value) return;
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
  const { state, game } = m;
  document.body.dataset.phase = PHASE_TONES[state.phase] ?? 'day';
  if (state.phase !== 'end') wakeAtSunset(game);
  // 需要我動作時自動切回「行動」分頁（只在情況換了的時候切一次）。
  const need = needOf(m);
  if (need && need !== lastNeed) tab = 'action';
  lastNeed = need;
  patchChildren($('player-head'), header(m));
  const scene = { sunrise: 'dawn', day: 'day', dusk: 'dusk', night: 'night', end: 'finale' }[state.phase] ?? 'day';
  $('player-head').dataset.scene = scene;
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
  markTruncated($('player-view'));
}

// ---- 事件（委派）：按鈕上的 data-act 決定做什麼，做的時候讀當下的局面 ----

function current() {
  const room = ctx.latestRoom;
  const me = room?.players?.[ctx.session?.uid];
  if (!room || !me || !room.tables?.[me.table]) return null;
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
    duskEdit = `${m.me.table}:${m.state.round}`;
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
    nightEdit = `${m.me.table}:${m.state.round}`;
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
};

$('screen-player').addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]');
  if (!target || target.disabled || !$('screen-player').contains(target)) return;
  actions[target.dataset.act]?.(target.dataset, target);
});

$('screen-player').addEventListener('change', (event) => {
  const target = event.target.closest('[data-change]');
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
