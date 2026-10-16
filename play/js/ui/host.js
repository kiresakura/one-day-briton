// 主持端畫面：6 桌的桌卡、推進、發牌、結算表、主持端名單。長相下一段照畫面規格重做；這裡的行為與改版前相同。
import {
  checkSeating,
  dayStatus,
  duskStage,
  nightStage,
  seatsInOrder,
  sunsetClock,
} from '../game.js';
import { confirmCode, hostUids } from '../rules.js';
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
import { $, element } from './dom.js';
import {
  END_REASON_TEXT,
  PHASE_NAMES,
  billLines,
  chainText,
  clockText,
  countdown,
  endReasonNow,
  eventLogItems,
  eventsBlock,
  explain,
  firedText,
  isOnline,
  logList,
  markPresent,
  nameOf,
  nameTag,
  nightResultLines,
  nightReminderLine,
  nightRevealLine,
  notify,
  pendingText,
  playersAt,
  rankedScores,
  reminderLine,
  resultLines,
  revealLine,
  roleName,
  run,
  scoreLines,
  wakeAtSunset,
  windowLine,
} from './shared.js';
import { ctx, random, rerender } from './state.js';

const dealing = new Set(); // 這台主持端正在發牌的桌號
let stopSettling = null; // 主持端的自動結算（出牌請求）
const startChoices = new Map(); // 主持端：桌號 → 下拉選單裡選好、還沒按「指定」的起始座位
const hostDiscards = new Map(); // 主持端：uid → { stop, value }（各入座玩家挑的棄牌，列出還沒挑的人用）

// 回首頁時清掉主持端的訂閱與暫存。
export function resetHost() {
  stopSettling?.();
  stopSettling = null;
  for (const { stop } of hostDiscards.values()) stop();
  hostDiscards.clear();
  dealing.clear();
  startChoices.clear();
}

// 名字排成一行，用「、」隔開。
function nameLine(room, entries, prefix) {
  const line = element('p', 'table-players', prefix);
  entries.forEach(([uid, player], index) => line.append(index ? '、' : '', nameTag(room, uid, player, 'span')));
  return line;
}

// 待核准的申請：主持端核對確認碼與對方畫面上的相同，再按核准。
function requestItems(room, roomCode) {
  return Object.entries(room.hostRequests ?? {})
    .sort(([, a], [, b]) => a.requestedAt - b.requestedAt)
    .map(([uid]) => {
      const approve = element('button', 'request-approve', '核准');
      approve.type = 'button';
      approve.addEventListener('click', () => run(approve, () => approveHost(ctx.session, roomCode, uid)));
      const reject = element('button', 'request-reject quiet', '拒絕');
      reject.type = 'button';
      reject.addEventListener('click', () => run(reject, () => rejectHost(ctx.session, roomCode, uid)));
      const item = element('li', 'request');
      item.append(element('span', '', '確認碼'), element('strong', 'request-code', confirmCode(uid)), approve, reject);
      return item;
    });
}

// 黃昏（主持端）：法案、已送出人數、提醒倒數、提前揭曉、截止倒數、揭曉結果。翻法案、計人數、揭曉都是自動的。
function duskLines(room, table, game, state, roomCode) {
  const stage = duskStage(game.dusk, state.round);
  if (stage === 'none') return state.phase === 'dusk' ? [element('p', 'table-note', '黃昏：翻開法案中…')] : [];
  if (stage === 'adjourned') return [element('p', 'dusk-bill', '今天議會休會'), element('p', 'table-note', '法案都通過了，這一回合不投票')];
  const { dusk } = game;
  const nodes = [element('h3', '', '黃昏法案'), ...billLines(dusk.bill)];
  if (stage === 'revealed') return [...nodes, ...resultLines(room, game, dusk.bill, dusk.result, null)];
  nodes.push(element('p', 'dusk-submitted', `已送出 ${dusk.submitted ?? 0}／${Object.keys(game.seats).length} 人`));
  nodes.push(stage === 'voting' ? reminderLine(dusk) : revealLine(dusk));
  if (state.phase === 'dusk' && (stage === 'voting' || dusk.revealAt > serverTime(ctx.session) + 500)) {
    const early = element('button', 'dusk-reveal quiet', '提前揭曉');
    early.type = 'button';
    early.addEventListener('click', () => run(early, () => revealDusk(ctx.session, roomCode, table)));
    nodes.push(early, element('p', 'caption', '沒送出的人算棄權；截止後約 1 秒揭曉'));
  }
  return nodes;
}

// 黃昏還沒揭曉時，主持端的「下一階段」停用的原因（不用停是 null）。
function duskBlock(game, state) {
  if (!game || state.phase !== 'dusk') return null;
  const stage = duskStage(game.dusk, state.round);
  if (stage === 'none') return '法案還沒翻開，揭曉後才能進下一階段';
  if (stage === 'voting' || stage === 'closing') return '法案還沒揭曉，揭曉後才能進下一階段';
  return null;
}

// 主持端：這一桌入座的人挑的棄牌（逐人訂閱，列出還沒挑的人用）。
function watchHostDiscards(roomCode, game) {
  for (const uid of Object.keys(game.seats ?? {})) {
    if (hostDiscards.has(uid)) continue;
    const entry = { stop: () => {}, value: null };
    hostDiscards.set(uid, entry);
    entry.stop = watchDiscard(
      ctx.session,
      roomCode,
      (value) => {
        entry.value = value;
        rerender();
      },
      () => {},
      uid,
    );
  }
}

// 主持端：手牌超過上限的人，誰挑好了、誰還沒挑（推進到下一回合日出時會被隨機棄）。主持端沒有訂閱別人的手牌，
// 這裡只看張數；挑的牌在不在手上，發牌時再查。
function handLimitLines(room, table, game, state) {
  const limit = ctx.cardData?.data.settings.handLimit;
  if (!limit) return [];
  const over = seatsInOrder(game.seats).filter(([, seat]) => seat.handCount > limit);
  if (over.length === 0) return [];
  // 這一回合黑夜結束就算分：終局不棄牌，天命判定的手牌照上限算（game.js 的 destinyDone）。
  if (endReasonNow(game, state) !== null) return [element('p', 'table-note hand-limit-ending', `這一回合結束就算分：手牌超過上限的人不用棄牌，算分時超過上限的照上限 ${limit} 張算`)];
  const picked = (uid, seat) => {
    const value = hostDiscards.get(uid)?.value;
    const count = Object.keys(value?.cards ?? {}).length;
    return Boolean(value) && String(value.table) === String(table) && value.round === state.round && count === seat.handCount - limit;
  };
  const ready = over.filter(([uid, seat]) => picked(uid, seat));
  const missing = over.filter(([uid, seat]) => !picked(uid, seat));
  const nodes = [];
  if (ready.length) nodes.push(element('p', 'table-note hand-limit-ready', `手牌超過上限、已挑好要棄的牌：${ready.map(([uid]) => nameOf(room, uid)).join('、')}`));
  if (missing.length) {
    const names = missing.map(([uid, seat]) => `${nameOf(room, uid)}（${seat.handCount} 張，要棄 ${seat.handCount - limit} 張）`).join('、');
    nodes.push(element('p', 'table-note problem hand-limit-missing', `手牌超過上限、還沒挑：${names}——推進到下一回合日出時會被隨機棄`));
  }
  return nodes;
}

// 黑夜（主持端）：已送出人數、提醒倒數、提前揭曉、截止倒數、揭曉結果、手牌超過上限的人。開黑夜、計人數、揭曉都是自動的。
function nightLines(room, table, game, state, roomCode) {
  if (state.phase !== 'night') return [];
  const stage = nightStage(game.night, state.round);
  const nodes = [element('h3', '', '黑夜')];
  if (stage === 'none') nodes.push(element('p', 'table-note', '黑夜：開始中…'));
  else if (stage === 'revealed') nodes.push(...nightResultLines(room, game, game.night.result, null));
  else {
    const { night } = game;
    nodes.push(element('p', 'night-submitted', `已送出 ${night.submitted ?? 0}／${Object.keys(game.seats).length} 人`));
    nodes.push(stage === 'choosing' ? nightReminderLine(night) : nightRevealLine(night));
    if (stage === 'choosing' || night.revealAt > serverTime(ctx.session) + 500) {
      const early = element('button', 'night-reveal quiet', '提前揭曉');
      early.type = 'button';
      early.addEventListener('click', () => run(early, () => revealNight(ctx.session, roomCode, table)));
      nodes.push(early, element('p', 'caption', '沒送出的人算睡覺；截止後約 1 秒揭曉'));
    }
  }
  return [...nodes, ...handLimitLines(room, table, game, state)];
}

// 黑夜還沒揭曉時，主持端的「下一階段」停用的原因（不用停是 null）。
function nightBlock(game, state) {
  if (!game || state.phase !== 'night') return null;
  const stage = nightStage(game.night, state.round);
  if (stage === 'none') return '黑夜還沒開始，揭曉後才能進下一階段';
  if (stage === 'choosing' || stage === 'closing') return '黑夜還沒揭曉，揭曉後才能進下一階段';
  return null;
}

// 主持端的日落鐘：已過多久、還剩多久；過了就寫「這回合結束後算分」。照伺服器時間每秒更新。
function sunsetLine(game) {
  const node = element('p', 'sunset-clock table-note');
  node.dataset.started = game.startedAt;
  showSunset(node);
  wakeAtSunset(game);
  return node;
}

function showSunset(node) {
  const clock = sunsetClock(Number(node.dataset.started), ctx.cardData?.data.settings, serverTime(ctx.session));
  node.textContent = clock.passed
    ? `日落鐘：開局後 ${clockText(clock.elapsed)}，時間到了——這回合結束後算分`
    : `日落鐘：開局後 ${clockText(clock.elapsed)}，還剩 ${clockText(clock.remaining)}`;
}

setInterval(() => {
  for (const node of document.querySelectorAll('.sunset-clock[data-started]')) showSunset(node);
}, 1000);

// 主持端（開局後、終局前）：日落鐘、這一回合會不會算分、「這回合結束後算分」與取消。
function endControls(table, game, state, roomCode) {
  const nodes = [sunsetLine(game)];
  const reason = endReasonNow(game, state);
  const marked = game.endAfterRound === state.round;
  if (reason === 'maxRounds') nodes.push(element('p', 'table-note last-round', `第 ${state.round} 回合是回合上限：這一回合黑夜揭曉後，按「下一階段」就算分`));
  if (reason === 'host') nodes.push(element('p', 'table-note last-round', '已按「這回合結束後算分」：這一回合黑夜揭曉後，按「下一階段」就算分'));
  // 日落鐘到了或到了回合上限時，按不按都會算分：不顯示這個鈕（取消也沒用）。
  if (reason === null || reason === 'host') {
    const toggle = element('button', marked ? 'end-after-round quiet' : 'end-after-round', marked ? '取消「這回合結束後算分」' : '這回合結束後算分');
    toggle.type = 'button';
    toggle.addEventListener('click', () => run(toggle, () => setEndAfterRound(ctx.session, roomCode, table, !marked)));
    nodes.push(toggle);
    if (!marked) nodes.push(element('p', 'caption', '試玩時間不夠時用：這一回合黑夜揭曉後就算分，按了還可以取消'));
  }
  return nodes;
}

// 「判定」空白的天命（終局時由主持端勾）。
function judgedByHost(id) {
  const card = id ? ctx.cardData?.index.destinies.get(id) : null;
  return Boolean(card) && (card.check ?? null) === null;
}

// 結算表（主持端）：名次、每人的天命（內容與是否達成）、資產換算、公共成就、罪孽扣分、總分；「判定」空白的天命可以勾「達成／沒達成」。
function finalLines(room, table, game, roomCode) {
  const { final } = game;
  const nodes = [element('h3', '', '終局結算'), element('p', 'table-note final-reason', `第 ${final.round} 回合結束後算分（${END_REASON_TEXT[final.reason] ?? final.reason}）`)];
  const list = element('ol', 'final-scores');
  for (const [uid, score] of rankedScores(game)) {
    const item = element('li', 'final-row');
    item.dataset.uid = uid;
    item.append(element('p', 'final-head', `第 ${score.rank} 名・${nameOf(room, uid)}・總分 ${score.total}`));
    for (const line of scoreLines(score)) item.append(element('p', 'final-line caption', line));
    if (judgedByHost(score.destiny?.id)) {
      const box = element('p', 'final-judge');
      box.append(element('span', '', '主持人判定天命：'));
      for (const [done, label] of [[true, '達成'], [false, '沒達成']]) {
        const button = element('button', score.destiny.done === done ? 'judge-pick' : 'judge-pick quiet', label);
        button.type = 'button';
        button.dataset.done = String(done);
        button.disabled = score.destiny.done === done;
        button.addEventListener('click', () => run(button, () => judgeDestiny(ctx.session, roomCode, table, uid, done)));
        box.append(button);
      }
      item.append(box);
    }
    list.append(item);
  }
  nodes.push(list);
  return nodes;
}

// 發這一桌這一回合的日出；送出到寫完之間，畫面顯示「發牌中…」。
async function deal(roomCode, table) {
  dealing.add(table);
  rerender();
  try {
    await processSunrise(ctx.session, roomCode, table, ctx.cardData.data, random);
  } finally {
    dealing.delete(table);
    rerender();
  }
}

// 開局前：入座候選與人數、「開始」鈕；不能開時寫原因（沒有玩家也是），人少時寫提醒。
function startControls(room, table, roomCode) {
  const players = playersAt(room, table);
  const { error, warning } = checkSeating(players.length, ctx.cardData?.data.roles.length);
  const reason = ctx.cardsFailed ? '卡牌資料有問題，請找工作人員' : ctx.cardData ? error : '卡牌資料讀取中…';
  const start = element('button', 'table-start', '開始');
  start.type = 'button';
  start.disabled = Boolean(reason);
  start.addEventListener('click', () => run(start, () => startTable(ctx.session, roomCode, table, ctx.cardData.data, random)));
  const nodes = players.length ? [nameLine(room, players, `入座候選 ${players.length} 人：`)] : [];
  const note = reason || warning || (players.length ? '' : '還沒有玩家');
  if (note) nodes.push(element('p', reason ? 'table-note problem' : 'table-note', note));
  return [...nodes, start];
}

// 第 1 回合、還沒有人出過牌：選起始玩家（預設座位 0）。選了還沒按「指定」的值記在 startChoices，重畫時留著。
function startOrderControls(room, table, game, roomCode) {
  const current = game.startOrder ?? 0;
  const select = element('select', 'start-order');
  for (const [uid, seat] of seatsInOrder(game.seats)) {
    const option = element('option', '', `座位 ${seat.order + 1}：${nameOf(room, uid)}`);
    option.value = seat.order;
    option.selected = seat.order === (startChoices.get(table) ?? current);
    select.append(option);
  }
  select.addEventListener('change', () => startChoices.set(table, Number(select.value)));
  const label = element('label', 'start-order-label', '第 1 回合的起始玩家（第一張牌之前可以改）');
  label.append(select);
  const set = element('button', 'start-order-set quiet', '指定起始玩家');
  set.type = 'button';
  set.addEventListener('click', () =>
    run(set, async () => {
      await setStartOrder(ctx.session, roomCode, table, Number(select.value));
      startChoices.delete(table);
    }),
  );
  return [label, set];
}

// 白晝：輪到誰、這一輪出了幾張、連鎖狀態、提醒倒數、還有幾人沒出完、等著響應的牌與倒數。結算是自動的，這裡只顯示。
function dayLines(room, table, game, state) {
  const status = dayStatus(game, state.round);
  const waiting = game.pending
    ? [
        windowLine('table-note problem', game.pending, {
          before: `等響應：${pendingText(room, game.pending)}，還有 `,
          after: ' 秒',
          over: `等響應：${pendingText(room, game.pending)}，時間到了，結算中…`,
        }),
      ]
    : [];
  if (status.done) return [...waiting, element('p', 'table-note', '白晝：大家都出完了，可以進黃昏')];
  return [
    element('p', 'day-turn', `輪到 ${nameOf(room, status.current)}（第 ${status.turn.index + 1}／${status.order.length} 位）`),
    element('p', 'table-note', `這一輪出了 ${status.turn.plays} 張・${chainText(status.turn)}`),
    ...waiting,
    countdown(table, state.round, status.turn.index),
    element('p', 'table-note problem', `還有 ${status.remaining} 人沒出完`),
  ];
}

// 開局後：座位（暱稱、階層、英鎊、影響力、手牌張數、罪孽）、未入座的人、牌庫與棄牌堆，日出還沒發牌時的「補發」；
// 第 1 回合出牌前的起始玩家，白晝的輪次，最近的出牌紀錄。
function gameControls(room, table, game, state, pending, roomCode) {
  const seats = element('ol', 'seats');
  for (const [uid, seat] of seatsInOrder(game.seats)) {
    const player = room.players?.[uid];
    const item = element('li', 'seat');
    item.append(
      player ? nameTag(room, uid, player, 'strong') : element('strong', 'offline', '（已離開房間）'),
      element('span', 'seat-role', roleName(seat.role)),
      element('span', 'seat-stats', `英鎊 ${seat.pounds}・影響力 ${seat.influence}・手牌 ${seat.handCount}${seat.sin ? `・罪孽 ${seat.sin}` : ''}`),
    );
    seats.append(item);
  }
  const nodes = [seats];
  const unseated = playersAt(room, table).filter(([uid]) => !game.seats[uid]);
  if (unseated.length) nodes.push(nameLine(room, unseated, '未入座：'));
  nodes.push(element('p', 'table-pile', `牌庫 ${game.deckCount} 張・棄牌堆 ${game.discardCount} 張`));
  if (state.phase === 'end' && game.final) nodes.push(...finalLines(room, table, game, roomCode));
  else if (ctx.cardData) nodes.push(...endControls(table, game, state, roomCode));
  nodes.push(...eventsBlock(game, state));
  if (state.round === 1 && state.phase !== 'end' && !game.turn && !game.pending) nodes.push(...startOrderControls(room, table, game, roomCode));
  if (state.phase === 'day') nodes.push(...dayLines(room, table, game, state));
  if (state.phase === 'dusk' || state.phase === 'night') nodes.push(...duskLines(room, table, game, state, roomCode));
  nodes.push(...nightLines(room, table, game, state, roomCode));
  const log = logList(room, game);
  if (log) nodes.push(element('h3', '', '最近出牌'), log);
  const events = eventLogItems(game);
  if (events.length) {
    const list = element('ol', 'log event-log');
    list.append(...events);
    nodes.push(element('h3', '', '事件紀錄'), list);
  }
  if (pending && dealing.has(table)) {
    nodes.push(element('p', 'table-note', '發牌中…'));
  } else if (pending) {
    const redeal = element('button', 'table-deal', '補發');
    redeal.type = 'button';
    redeal.disabled = !ctx.cardData;
    redeal.addEventListener('click', () => run(redeal, () => deal(roomCode, table)));
    nodes.push(element('p', 'table-note problem', '日出還沒發牌'), redeal);
  }
  return nodes;
}

export function renderHost(room) {
  ctx.requested = false;
  markPresent();
  const roomCode = ctx.code;
  // 出牌請求自動結算，畫面不用按；卡牌資料讀到才開始。
  if (ctx.cardData && !stopSettling) {
    stopSettling = startSettling(ctx.session, roomCode, ctx.cardData.data, { random, onError: (error) => notify(explain(error)) });
  }
  const cards = [];
  for (let table = 1; table <= room.meta.tableCount; table += 1) {
    const state = room.tables?.[table];
    if (!state) continue;
    const game = room.games?.[table];
    // 已開局、在日出、這一回合還沒發牌（主持機在推進與發牌之間掛掉時，任何主持端都可以補發）。
    const pending = Boolean(game) && state.phase === 'sunrise' && (room.deals?.[table] ?? 0) < state.round;

    const card = element('article', 'card table');
    card.dataset.table = table;
    const status = element('p', 'table-state');
    status.append(
      element('span', 'table-round', `第 ${state.round} 回合`),
      element('span', 'table-phase', PHASE_NAMES[state.phase] ?? state.phase),
      element('span', 'table-fog', `迷霧值 ${state.fog}${firedText(game) ? `（${firedText(game)}）` : ''}`),
    );
    // 黑夜時這一回合該算分了（日落鐘、回合上限、主持端按了「這回合結束後算分」），「下一階段」就是算分。
    const ending = state.phase === 'night' && endReasonNow(game, state) !== null;
    const next = element('button', 'table-next', ending ? '下一階段（算分）' : '下一階段');
    next.type = 'button';
    if (game) watchHostDiscards(roomCode, game);
    // 開局前、日出還沒發牌、有牌在等響應、黃昏的法案或黑夜還沒揭曉時不能推進（畫面擋，規則不擋）；黑夜要有卡牌資料才知道要不要算分。
    const why = game?.pending ? '有牌在等響應，結算完才能進下一階段' : (duskBlock(game, state) ?? nightBlock(game, state));
    next.disabled = !game || pending || Boolean(why) || (state.phase === 'night' && !ctx.cardData);
    const blocked = why ? [element('p', 'table-note problem next-blocked', why)] : [];
    // 帶著畫面上這一刻的回合與階段去推進；資料庫已經不一樣就不會動。黑夜時該算分就算分（同一筆寫入），不然推進到下一回合日出。
    // 是自己這一筆把桌子推進到新回合的日出，就接著發牌。
    next.addEventListener('click', () =>
      run(next, async () => {
        const result = await advanceOrEnd(ctx.session, roomCode, table, { round: state.round, phase: state.phase }, ctx.cardData?.data);
        if (result.advanced && !result.ended && result.table.phase === 'sunrise' && ctx.cardData) await deal(roomCode, table);
      }),
    );
    // 終局後這一桌不再推進。
    const closing = state.phase === 'end' ? [element('p', 'table-note table-ended', '這一桌已經算分，遊戲結束')] : [...blocked, next];
    card.append(
      element('h2', '', `第 ${table} 桌`),
      status,
      ...(game ? gameControls(room, table, game, state, pending, roomCode) : startControls(room, table, roomCode)),
      ...closing,
    );
    cards.push(card);
  }
  $('host-code').textContent = roomCode;
  $('host-tables').replaceChildren(...cards);
  const requests = requestItems(room, roomCode);
  const hosts = hostUids(room);
  const online = hosts.filter((uid) => isOnline(room, uid)).length;
  $('host-count').textContent =
    `目前主持端 ${hosts.length} 台，${online} 台在線` + (requests.length ? '；待核准的申請：' : '');
  $('host-requests').replaceChildren(...requests);
}
