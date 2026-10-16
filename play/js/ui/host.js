// 主持端（筆電 1280×800／平板）：頂列（房號、各狀態桌數、主持端在線數、備援主持申請、離開）＋ 6 桌固定 3×2 的桌卡（階段色帶 →
// 狀態列 → 玩家表 → 今日事件或法案 → 底部），每桌的「紀錄」與終局的「結算明細」開右側抽屜；開房／接手的畫面是 renderHostEntry。
// 重畫用 patchChildren 就地更新、按鈕用 data-act 委派事件（同玩家端）：別人的動作觸發重畫時，開著的抽屜、備援申請面板、
// 起始玩家的下拉選單與焦點都不會被打斷。規則、流程、每個按鈕的作用與啟用條件與改版前相同。
import {
  MAX_SEATS,
  SUGGESTED_SEATS,
  checkSeating,
  dayStatus,
  duskStage,
  nightStage,
  responseDeadline,
  seatsInOrder,
  skippedEffects,
  sunsetClock,
} from '../game.js';
import { FOG_MAX, FOG_MIN, FOG_THRESHOLDS, MAX_TABLES, confirmCode, hostUids } from '../rules.js';
import {
  advanceOrEnd,
  approveHost,
  judgeDestiny,
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
  MATCH_TEXT,
  PHASE_NAMES,
  PHASE_SHORT,
  PHASE_TONES,
  SLEEP_TEXT,
  billEffectText,
  billOf,
  billTitle,
  daySeconds,
  endReasonNow,
  eventOf,
  eventOutcome,
  eventTitle,
  explain,
  isOnline,
  logItems,
  logRounds,
  markPresent,
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

const dealing = new Set(); // 這台主持端正在發牌的桌號
let stopSettling = null; // 主持端的自動結算（出牌請求、黃昏、黑夜）
const startChoices = new Map(); // 桌號 → 下拉選單裡選好、還沒按「指定」的起始座位
const hostDiscards = new Map(); // uid → { stop, value }（各入座玩家挑的棄牌，列出還沒挑的人用）
const busy = new Set(); // 送出中的動作（「next:3」之類）：按鈕停用到做完
let drawer = null; // 開著的抽屜 { kind: 'log' | 'final', table }
let drawerOpener = null; // 開抽屜的按鈕（選擇器），關掉時焦點回到那裡
let requestsOpen = false; // 備援主持申請面板

// 回首頁時清掉主持端的訂閱與暫存。
export function resetHost() {
  stopSettling?.();
  stopSettling = null;
  for (const { stop } of hostDiscards.values()) stop();
  hostDiscards.clear();
  dealing.clear();
  startChoices.clear();
  busy.clear();
  drawer = null;
  drawerOpener = null;
  requestsOpen = false;
  document.body.classList.remove('has-drawer');
}

// ---- H01：開房／接手（桌數、日落鐘、第幾場目前固定；數字從程式與卡牌資料的設定取） ----

export function renderHostEntry() {
  $('entry-tables').textContent = String(MAX_TABLES);
  const minutes = ctx.cardData ? scoreRules().sunsetMinutes : null;
  $('entry-sunset').textContent = minutes ? `${minutes} 分` : ctx.cardsFailed ? '讀不到設定' : '讀取中…';
  $('entry-match').textContent = MATCH_TEXT;
  const capacity = Math.min(MAX_SEATS, ctx.cardData?.data.roles.length ?? MAX_SEATS);
  $('entry-seats').textContent = `1 到 ${capacity} 人`;
  $('entry-seats-hint').textContent = `建議至少 ${SUGGESTED_SEATS} 人；人少也能開始`;
  const thresholds = ctx.cardData?.data.settings.fogThresholds ?? FOG_THRESHOLDS;
  $('entry-fog').textContent = `迷霧值 ${FOG_MIN}–${FOG_MAX}。每桌迷霧第一次越過 ${thresholds.join('、')} 時各觸發一次迷霧事件，之後回落再越過不會再觸發。`;
}

// ---- 一桌的局面與「下一步」 ----

function tableModel(room, table) {
  const state = room.tables?.[table];
  if (!state) return null;
  const game = room.games?.[table] ?? null;
  // 已開局、在日出、這一回合還沒發牌（主持機在推進與發牌之間掛掉時，任何主持端都可以補發）。
  const pending = Boolean(game) && state.phase === 'sunrise' && (room.deals?.[table] ?? 0) < state.round;
  const ended = state.phase === 'end';
  // 這一回合是最後一回合（日落鐘、回合上限、主持端按了「這回合結束後算分」）：黑夜揭曉後的「下一階段」就是算分。
  const reason = game && !ended ? endReasonNow(game, state) : null;
  return { room, table, state, game, pending, ended, ending: reason !== null, reason, tone: game ? (PHASE_TONES[state.phase] ?? 'day') : 'idle' };
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
    return Boolean(value) && String(value.table) === String(t.table) && value.round === t.state.round && count === seat.handCount - limit;
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
    const doing = dealing.has(t.table);
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
  const { room, game, state, table } = t;
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
    dial: ring({ since: turnSince(table, state.round, status.turn.index), total: daySeconds(), label: '提醒' }),
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

function endStep(t) {
  const { room, game } = t;
  if (!game.final) return { kind: 'wait', icon: '…', title: '算分中…', sub: '', actions: [] };
  const waiting = unjudged(game);
  if (waiting.length) {
    return {
      kind: 'judge',
      icon: '?',
      title: `待判定 ${waiting.length} 份天命`,
      sub: `${waiting.map(([uid]) => nameOf(room, uid)).join('、')} 的天命要主持人判定；判定前那份算 0 分`,
      actions: [{ act: 'final', label: '展開結算明細', primary: true }],
    };
  }
  const top = rankedScores(game).filter(([, score]) => score.rank === 1).map(([uid]) => nameOf(room, uid));
  return { kind: 'done', icon: '✓', title: `已算分・第 1 名 ${top.join('、')}`, sub: endReasonText(game.final), actions: [{ act: 'final', label: '展開結算明細' }] };
}

function idleStep(t) {
  const players = playersAt(t.room, t.table);
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
  if (!t.game) return idleStep(t);
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

function band(t) {
  const { table, state, game } = t;
  const final = t.ended ? game?.final : null;
  return h(
    'div',
    { class: 'tc-band' },
    h('h2', { class: 'tc-name', attrs: { id: `tc-${table}-name` }, text: `第 ${table} 桌` }),
    game
      ? h('span', { class: 'tc-phase' }, h('span', { class: `phase-icon phase-icon-${t.tone}`, attrs: { 'aria-hidden': 'true' } }), PHASE_NAMES[state.phase] ?? state.phase)
      : h('span', { class: 'tc-phase', text: '未開始' }),
    game && !t.ended ? h('span', { class: 'tc-round', text: `第 ${state.round} 回合` }) : null,
    final ? h('span', { class: 'tc-round', text: `第 ${final.round} 回合結束` }) : null,
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

// 名字與階層：太長時「…」＋點線底線，點一下彈出全文（名字、階層、座位）。
function whoCell(room, uid, seat) {
  const player = room.players?.[uid];
  const name = player?.name ?? '（已離開房間）';
  const role = seat ? roleName(seat.role) : '';
  const full = `${name}\n${[role, seat ? `座位 ${seat.order + 1}` : '未入座'].filter(Boolean).join('・')}`;
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
  const unseated = playersAt(room, t.table).filter(([uid]) => !game.seats[uid]);
  return h(
    'table',
    { class: 'tc-table' },
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
        ? h('tr', { class: 'is-unseated', data: { key: 'unseated' } }, h('td', { attrs: { colspan: 6 } }, trunc('span', 'tc-state', `未入座：${unseated.map(([, player]) => player.name).join('、')}`)))
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

function idleList(t) {
  const players = playersAt(t.room, t.table);
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
  if (limits.text) lines.unshift({ label: '手牌', text: limits.text, full: limits.text, problem: limits.problem });
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
  const { room, game, table } = t;
  const current = startChoices.get(table) ?? game.startOrder ?? 0;
  return h(
    'div',
    { class: 'tc-start', data: { key: 'start-order' } },
    h('label', { class: 'tc-start-label', attrs: { for: `start-order-${table}` }, text: '第 1 回合起始玩家' }),
    h(
      'select',
      { class: 'select tc-select', attrs: { id: `start-order-${table}` }, data: { change: 'start-order', table } },
      seatsInOrder(game.seats).map(([uid, seat]) => h('option', { value: String(seat.order), selected: seat.order === current, text: `座位 ${seat.order + 1}：${nameOf(room, uid)}` })),
    ),
    h('button', { class: 'btn tc-btn', type: 'button', data: { act: 'start-order', table }, disabled: busy.has(`start-order:${table}`), text: '指定' }),
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
  const { game, state, table } = t;
  let clock = null;
  if (game && !t.ended && ctx.cardData && typeof game.startedAt === 'number') {
    clock = h('span', { class: 'tc-clock sunset-clock', data: { started: game.startedAt }, text: sunsetText(game.startedAt) });
  } else if (t.ended && game?.final) {
    clock = trunc('span', 'tc-clock', endReasonText(game.final));
  }
  const links = [];
  if (game) {
    links.push(linkButton('log', table, '紀錄'));
    // 日落鐘到了或到了回合上限時，按不按都會算分：不顯示這個鈕（取消也沒用）；色帶上有「最後一回合」。
    if (!t.ended && ctx.cardData && (t.reason === null || t.reason === 'host')) {
      const marked = game.endAfterRound === state.round;
      links.push(linkButton('end-toggle', table, marked ? '取消提早算分' : '這回合結束後算分', { className: 'is-accent', attrs: { 'aria-pressed': String(marked) } }));
    }
  }
  const actions = step.actions.filter(Boolean);
  const why = actions.map((action) => (busy.has(`${action.act}:${table}`) ? '處理中…' : action.why)).find(Boolean) ?? null;
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
          const working = busy.has(`${action.act}:${table}`);
          return h('button', {
            class: `btn tc-btn${action.primary && !action.why ? ' btn-primary' : ''}`,
            type: 'button',
            data: { act: action.act, table, key: action.act, ...(action.data ?? {}) },
            disabled: Boolean(action.why) || working,
            text: action.label,
          });
        }),
      ),
    ),
    why || note ? h('p', { class: `reason tc-reason${why ? ' problem' : ''}`, text: why ?? note }) : null,
  );
}

function tableCard(t, step, limits) {
  const { game, state } = t;
  const showStart = Boolean(game) && !t.ended && state.round === 1 && !game.turn && !game.pending;
  // 起始玩家選單出現時（第 1 回合出牌前）今日事件縮成一行，5 人以上的桌不列（1280×800 不用捲動；事件在「紀錄」裡）。
  const seats = game ? Object.keys(game.seats).length : 0;
  const info = !game || t.ended || (showStart && seats >= 5) ? null : infoBlock(t, limits, { compact: showStart });
  const body = game
    ? [statusRow(step), t.ended ? (game.final ? rankTable(t) : null) : playerTable(t, limits), info, showStart ? startOrderRow(t) : null]
    : [statusRow(step), idleList(t)];
  return h(
    'article',
    { class: `tcard tone-${t.tone} is-${step.kind}`, data: { key: `t${t.table}`, table: t.table }, attrs: { 'aria-labelledby': `tc-${t.table}-name` } },
    band(t),
    h('div', { class: 'tc-body' }, body, footer(t, step)),
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

function topBar(room, cards) {
  const counts = new Map();
  for (const { step } of cards) counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1);
  const requests = requestList(room);
  const hosts = hostUids(room);
  const online = hosts.filter((uid) => isOnline(room, uid)).length;
  return [
    h('div', { class: 'host-brand', data: { key: 'brand' } }, h('p', { class: 'host-brand-title', text: '一日英國人' }), h('p', { class: 'host-brand-sub', text: '女皇陛下萬歲！・主持端' })),
    h('div', { class: 'host-room', data: { key: 'room' } }, h('span', { class: 'host-room-label', text: '房號' }), h('strong', { class: 'host-room-code', attrs: { id: 'host-code', lang: 'en' }, text: ctx.code })),
    h(
      'ul',
      { class: 'host-chips', data: { key: 'chips' }, attrs: { 'aria-label': '各桌狀態' } },
      KIND_CHIPS.filter(([kind]) => kind !== 'done' || counts.get('done')).map(([kind, label, unit]) => h('li', { class: `chip-${kind}${counts.get(kind) ? '' : ' is-zero'}`, data: { key: kind }, text: `${label} ${counts.get(kind) ?? 0}${unit ? ` ${unit}` : ''}` })),
    ),
    h(
      'div',
      { class: 'host-top-right', data: { key: 'right' } },
      h('span', { class: 'host-online', text: `主持端 ${online} 台在線` }),
      h('button', { class: `btn top-btn${requests.length ? ' is-alert' : ''}`, type: 'button', data: { act: 'requests' }, attrs: { 'aria-expanded': String(requestsOpen), 'aria-controls': 'host-requests' }, text: `備援主持申請 ${requests.length}` }),
      h('button', { class: 'btn top-btn', type: 'button', data: { act: 'leave' }, text: '離開' }),
      requestsOpen ? requestsPanel(room, requests, hosts, online) : null,
    ),
  ];
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
    { class: `drawer drawer-${kind}`, data: { key: `drawer-${kind}-${t.table}` }, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'drawer-title' } },
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

function logDrawer(t) {
  const { room, game, state } = t;
  const rounds = logRounds(logItems(room, game));
  const current = t.ended ? null : state.round;
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
  return drawerShell(t, 'log', `第 ${t.table} 桌・紀錄`, t.ended ? endReasonText(game.final) : `第 ${state.round} 回合・${PHASE_NAMES[state.phase] ?? state.phase}`, content);
}

function judgeButtons(t, uid, score) {
  const { done, points } = score.destiny;
  const working = busy.has(`judge:${t.table}:${uid}`);
  const button = (value, label) =>
    h('button', {
      class: `btn${done === undefined || done === null ? (value ? ' btn-primary' : '') : ''}`,
      type: 'button',
      data: { act: 'judge', table: t.table, uid, done: String(value), key: String(value) },
      attrs: { 'aria-pressed': String(done === value) },
      disabled: done === value || working,
      text: label,
    });
  const yes = done === true ? '✓ 已判定：達成' : done === false ? `改成：達成 +${points}` : `判定：達成 +${points}`;
  const no = done === false ? '✓ 已判定：沒達成' : done === true ? '改成：沒達成' : '判定：沒達成';
  return h('div', { class: 'fc-judge' }, button(true, yes), button(false, no));
}

function finalDrawer(t) {
  const { room, game } = t;
  const waiting = unjudged(game);
  const note = h(
    'p',
    { class: `drawer-note${waiting.length ? ' is-problem' : ''}`, attrs: { role: 'status' } },
    waiting.length
      ? `還有 ${waiting.length} 份天命要你判定：判定前那份算 0 分、名次照現在的分數排；判定後分數與名次馬上更新，玩家手機也跟著更新。`
      : '天命都判定了，這就是最後的名次（玩家手機上的一樣）。',
  );
  const content = rankedScores(game).map(([uid, score]) => {
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
        h('b', { class: 'fc-name', text: nameOf(room, uid) }),
        h('span', { class: 'fc-role', text: seat ? `${roleName(seat.role)}・座位 ${seat.order + 1}` : '' }),
        h('b', { class: 'fc-total', text: pending ? `${score.total}+?` : score.total }),
      ),
      h('dl', { class: 'fc-rows' }, rows.map((row) => [h('dt', { text: row.label }), h('dd', { text: row.detail }), h('dd', { class: 'fc-points', text: row.points })])),
      h('p', { class: 'fc-sum', text: `總分 ${scoreRows(score).find((row) => row.label === '總分').detail}` }),
      judgedByHost(score.destiny?.id) ? judgeButtons(t, uid, score) : null,
    );
  });
  return drawerShell(t, 'final', `第 ${t.table} 桌・結算明細`, endReasonText(game.final), content, note);
}

function drawerLayer(room) {
  if (!drawer) return [];
  const t = tableModel(room, drawer.table);
  if (!t?.game || (drawer.kind === 'final' && !(t.ended && t.game.final))) {
    drawer = null;
    return [];
  }
  return [h('div', { class: 'scrim', data: { key: 'scrim', act: 'close-drawer' } }), drawer.kind === 'final' ? finalDrawer(t) : logDrawer(t)];
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
  for (let table = 1; table <= room.meta.tableCount; table += 1) {
    const t = tableModel(room, table);
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
  patchChildren($('host-layer'), drawerLayer(room));
  document.body.classList.toggle('has-drawer', Boolean(drawer));
  markTruncated($('screen-host'));
}

// ---- 事件（委派）：按鈕上的 data-act 決定做什麼，做的時候讀當下的局面 ----

function current(table) {
  const room = ctx.latestRoom;
  return room ? tableModel(room, Number(table)) : null;
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

// 發這一桌這一回合的日出；送出到寫完之間，畫面顯示「發牌中…」。
async function deal(table) {
  dealing.add(table);
  rerender();
  try {
    await processSunrise(ctx.session, ctx.code, table, ctx.cardData.data, random);
  } finally {
    dealing.delete(table);
    rerender();
  }
}

function openDrawer(kind, table, opener) {
  drawer = { kind, table: Number(table) };
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

const actions = {
  // 帶著畫面上這一刻的回合與階段去推進；資料庫已經不一樣就不會動。黑夜時該算分就算分（同一筆寫入），不然推進到下一回合日出；
  // 是自己這一筆把桌子推進到新回合的日出，就接著發牌。
  next: ({ table, round, phase }) => {
    const number = Number(table);
    act(`next:${number}`, async () => {
      const result = await advanceOrEnd(ctx.session, ctx.code, number, { round: Number(round), phase }, ctx.cardData?.data);
      if (result.advanced && !result.ended && result.table.phase === 'sunrise' && ctx.cardData) await deal(number);
    });
  },
  start: ({ table }) => act(`start:${table}`, () => startTable(ctx.session, ctx.code, Number(table), ctx.cardData.data, random)),
  redeal: ({ table }) => act(`redeal:${table}`, () => deal(Number(table))),
  'reveal-dusk': ({ table }) => act(`reveal-dusk:${table}`, () => revealDusk(ctx.session, ctx.code, Number(table))),
  'reveal-night': ({ table }) => act(`reveal-night:${table}`, () => revealNight(ctx.session, ctx.code, Number(table))),
  'end-toggle': ({ table }) => {
    const t = current(table);
    if (!t?.game) return;
    const marked = t.game.endAfterRound === t.state.round;
    act(`end-toggle:${table}`, () => setEndAfterRound(ctx.session, ctx.code, t.table, !marked));
  },
  'start-order': ({ table }) => {
    const t = current(table);
    if (!t?.game) return;
    const order = startChoices.get(t.table) ?? t.game.startOrder ?? 0;
    act(`start-order:${table}`, async () => {
      await setStartOrder(ctx.session, ctx.code, t.table, order);
      startChoices.delete(t.table);
    });
  },
  judge: ({ table, uid, done }) => act(`judge:${table}:${uid}`, () => judgeDestiny(ctx.session, ctx.code, Number(table), uid, done === 'true')),
  log: ({ table }) => openDrawer('log', table, `[data-act="log"][data-table="${table}"]`),
  final: ({ table }) => openDrawer('final', table, `[data-act="final"][data-table="${table}"]`),
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
  if (target) startChoices.set(Number(target.dataset.table), Number(target.value));
});

// 鍵盤：Esc 關抽屜（或備援申請面板）；抽屜開著時 Tab 只在抽屜裡面轉。
document.addEventListener('keydown', (event) => {
  if ($('screen-host').hidden) return;
  if (event.key === 'Escape') {
    if (drawer) closeDrawer();
    else if (requestsOpen) {
      requestsOpen = false;
      rerender();
    }
    return;
  }
  if (event.key !== 'Tab' || !drawer) return;
  const panel = $('host-layer').querySelector('.drawer');
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

// 視窗大小變了，重新看哪些名字被截斷。
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => markTruncated($('screen-host')), 150);
});
