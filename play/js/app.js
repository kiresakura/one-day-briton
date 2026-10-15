// 畫面與事件：首頁、等待核准、主持端、玩家端幾個畫面切換。資料一律從 store.js 的訂閱來，
// 牌名與牌面文字從卡牌資料檔（gamedata.js）來。
import { seed } from './config.js';
import {
  REJECT_REASONS,
  chainLevel,
  checkSeating,
  dayStatus,
  needsTarget,
  playProblem,
  responseDeadline,
  responseProblem,
  seatsInOrder,
  seededRandom,
} from './game.js';
import { indexGameData, loadGameData } from './gamedata.js';
import { MAX_TABLES, PHASE_LABELS, confirmCode, hostUids, isHostOf, isRoomCode } from './rules.js';
import {
  StoreError,
  advanceTable,
  approveHost,
  cancelHostRequest,
  connect,
  createRoom,
  enterAsHost,
  joinRoom,
  leaveRoom,
  processSunrise,
  rejectHost,
  requestPass,
  requestPlay,
  requestRespond,
  serverTime,
  setStartOrder,
  startSettling,
  startTable,
  trackPresence,
  watchConnection,
  watchPrivate,
  watchRequest,
  watchRoom,
} from './store.js';

const $ = (id) => document.getElementById(id);

// ?slot=xxx：同一個瀏覽器的不同分頁可以是不同玩家。不帶就是這個瀏覽器的預設身分。
const slotParam = new URLSearchParams(location.search).get('slot') ?? '';
const slot = /^[A-Za-z0-9_-]{1,20}$/.test(slotParam) ? slotParam : '';
// 記住目前在哪個房間，重新整理後回到同一個房。
const savedRoomKey = `one-day-briton:room:${slot || 'default'}`;

let session = null;
let code = null;
let stopWatching = null;
let stopPresence = null;
let offlineTimer = null;
let requested = false; // 這台裝置送過主持端申請、還在等核准
let latestRoom = null; // 最近一次收到的房間資料，私密資料或卡牌資料晚到時拿來重畫
let stopPrivate = null;
let mine = null; // 自己的私密資料 { table, hand, destiny }；還沒收到或沒有入座時是 null
let cardData = null; // 卡牌資料 { data, index }：讀到而且檢查沒有錯誤才有
let cardsFailed = false; // 卡牌資料讀不到或有錯誤
const dealing = new Set(); // 這台主持端正在發牌的桌號
let stopSettling = null; // 主持端的自動結算（出牌請求）
const startChoices = new Map(); // 主持端：桌號 → 下拉選單裡選好、還沒按「指定」的起始座位
let stopRequest = null;
let myRequest = null; // 自己最新的一筆請求 { seq, type, card, … }（出牌、結束這一輪或響應）
let composing = null; // 玩家：正在準備出的牌 { index, card, target, chainTarget }
let sending = false; // 玩家：請求送出中
const clocks = new Map(); // 桌號 → { key: '回合:第幾位', since }：白晝每人的提醒倒數從這台裝置看到輪到他時算起
let windowEnd = { id: null, timer: null }; // 玩家：響應截止時重畫一次的計時器（對應哪一張等著響應的牌）

// ?seed=<整數>（只有模擬器認）：主持端洗牌、隨機棄牌用固定種子，畫面測試時手牌每次都一樣。
const random = seed === null ? undefined : seededRandom(seed);

const KIND_LABELS = { play: '一般', response: '響應' };
// 齒輪連鎖各級的加成（企劃 10/15 回覆第 10 題）。
const CHAIN_BONUS = {
  2: '給自己的英鎊、影響力加倍',
  3: '另外抽 2 張，並指定一人隨機棄 1 張',
  4: '英鎊、影響力、抽牌、棄牌的數量全部加倍',
};

function show(screen) {
  for (const name of ['loading', 'home', 'pending', 'host', 'player']) $(`screen-${name}`).hidden = name !== screen;
}

function notify(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function explain(error) {
  return error instanceof StoreError ? error.message : '連線有問題，請稍後再試一次';
}

// 暱稱是玩家輸入的文字，一律用 textContent 放進畫面。
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 按下去先停用按鈕，做完再恢復；失敗就把原因顯示出來。
async function run(button, action) {
  button.disabled = true;
  notify();
  try {
    await action();
  } catch (error) {
    notify(explain(error));
  } finally {
    button.disabled = false;
  }
}

// 自己的連線：斷了超過一秒才提示，剛開頁面還沒連上或瞬間抖動時不閃。
function showConnection(connected) {
  clearTimeout(offlineTimer);
  if (connected) $('connection').hidden = true;
  else offlineTimer = setTimeout(() => ($('connection').hidden = false), 1000);
}

// 進到主持或玩家畫面後才標示自己在線上；回首頁時移除。
function markPresent() {
  stopPresence ??= trackPresence(session, code);
}

function isOnline(room, uid) {
  return uid === session.uid || room.presence?.[uid] === true;
}

function goHome(message = '') {
  stopWatching?.();
  stopWatching = null;
  stopPresence?.().catch(() => {});
  stopPresence = null;
  stopPrivate?.();
  stopPrivate = null;
  stopSettling?.();
  stopSettling = null;
  stopRequest?.();
  stopRequest = null;
  mine = null;
  myRequest = null;
  composing = null;
  latestRoom = null;
  dealing.clear();
  startChoices.clear();
  clocks.clear();
  clearTimeout(windowEnd.timer);
  windowEnd = { id: null, timer: null };
  code = null;
  requested = false;
  localStorage.removeItem(savedRoomKey);
  notify(message);
  show('home');
}

function enterRoom(roomCode) {
  code = roomCode;
  localStorage.setItem(savedRoomKey, roomCode);
  notify();
  const stop = watchRoom(session, roomCode, render, () => goHome('讀不到這個房間，請重新加入'));
  if (code === roomCode) stopWatching = stop;
  else stop(); // 第一筆資料就把人送回首頁了
}

function render(room) {
  if (!room?.meta) return goHome('房間不存在或已關閉');
  latestRoom = room;
  if (isHostOf(room, session.uid)) return renderHost(room);
  if (room.hostRequests?.[session.uid]) return renderPending();
  if (requested) return goHome('主持端沒有核准這次申請');
  const me = room.players?.[session.uid];
  if (me && room.tables?.[me.table]) return renderPlayer(room, me);
  return goHome('你還沒加入這個房間');
}

function playersAt(room, table) {
  return Object.entries(room.players ?? {})
    .filter(([, player]) => player.table === table)
    .sort(([, a], [, b]) => a.joinedAt - b.joinedAt);
}

// 玩家的名字；不在線上的變淡並標「離線」。
function nameTag(room, uid, player, tag) {
  if (uid === session.uid) return element(tag, 'me', `${player.name}（你）`);
  return isOnline(room, uid) ? element(tag, '', player.name) : element(tag, 'offline', `${player.name}（離線）`);
}

function renderPending() {
  requested = true;
  $('pending-confirm').textContent = confirmCode(session.uid);
  $('pending-code').textContent = code;
  show('pending');
}

// 待核准的申請：主持端核對確認碼與對方畫面上的相同，再按核准。
function requestItems(room, roomCode) {
  return Object.entries(room.hostRequests ?? {})
    .sort(([, a], [, b]) => a.requestedAt - b.requestedAt)
    .map(([uid]) => {
      const approve = element('button', 'request-approve', '核准');
      approve.type = 'button';
      approve.addEventListener('click', () => run(approve, () => approveHost(session, roomCode, uid)));
      const reject = element('button', 'request-reject quiet', '拒絕');
      reject.type = 'button';
      reject.addEventListener('click', () => run(reject, () => rejectHost(session, roomCode, uid)));
      const item = element('li', 'request');
      item.append(element('span', '', '確認碼'), element('strong', 'request-code', confirmCode(uid)), approve, reject);
      return item;
    });
}

function rerender() {
  if (latestRoom) render(latestRoom);
}

function roleName(roleId) {
  return cardData?.index.roles.get(roleId)?.name ?? roleId;
}

// 名字排成一行，用「、」隔開。
function nameLine(room, entries, prefix) {
  const line = element('p', 'table-players', prefix);
  entries.forEach(([uid, player], index) => line.append(index ? '、' : '', nameTag(room, uid, player, 'span')));
  return line;
}

// 入座的人的暱稱；已經離開房間的人也照樣有座位。
function nameOf(room, uid) {
  const name = room?.players?.[uid]?.name ?? '（已離開房間）';
  return uid === session.uid ? `${name}（你）` : name;
}

// 連鎖狀態：這一輪上一張牌的齒輪與級數。
function chainText(turn) {
  if (turn.plays === 0) return '連鎖：這一輪還沒出牌';
  return turn.gear === null ? '連鎖：上一張沒有齒輪' : `連鎖：齒輪「${turn.gear}」${turn.level} 級`;
}

function cardName(id) {
  return cardData?.index.actions.get(id)?.name ?? id;
}

// 最近幾筆出牌紀錄，新的在上面。響應卡寫在被響應的那張後面。
function logList(room, game, count = 5) {
  const entries = Object.values(game?.log ?? {})
    .sort((a, b) => a.at - b.at)
    .slice(-count)
    .reverse();
  const list = element('ol', 'log');
  for (const entry of entries) {
    const name = cardName(entry.card);
    const level = entry.level > 1 ? `（${entry.level} 級連鎖）` : '';
    const target = entry.target ? ` → ${nameOf(room, entry.target)}` : '';
    const chain = entry.chainTarget && !entry.canceled ? `・${nameOf(room, entry.chainTarget)} 隨機棄 1 張` : '';
    const answer = entry.response ? `・被 ${nameOf(room, entry.response.by)} 以「${cardName(entry.response.card)}」響應${entry.canceled ? '，被抵銷' : ''}` : '';
    list.append(element('li', '', `第 ${entry.round} 回合・${nameOf(room, entry.by)} 打出「${name}」${level}${target}${chain}${answer}`));
  }
  return entries.length ? list : null;
}

// 白晝每人的提醒倒數（只顯示，不會自動換人）：從這台裝置看到輪到這個人的那一刻算起，每秒更新一次。
function countdown(table, round, index) {
  const key = `${round}:${index}`;
  if (clocks.get(table)?.key !== key) clocks.set(table, { key, since: Date.now() });
  const node = element('p', 'countdown');
  node.dataset.since = clocks.get(table).since;
  node.textContent = countdownText(Number(node.dataset.since));
  return node;
}

function countdownText(since) {
  const total = cardData?.data.settings.reminderSeconds.day ?? 60;
  const left = total - Math.floor((Date.now() - since) / 1000);
  return left > 0 ? `提醒倒數 ${left} 秒` : `已經超過 ${total} 秒（只是提醒，不會自動換人）`;
}

setInterval(() => {
  for (const node of document.querySelectorAll('.countdown[data-since]')) node.textContent = countdownText(Number(node.dataset.since));
}, 1000);

// 響應窗口的倒數：照伺服器時間算到截止還有幾秒（主持端判斷用的也是伺服器時間），每 250 毫秒更新一次；
// 本機估的伺服器時間差個幾毫秒時，顯示的秒數不超過窗口的秒數。before＋秒數＋after 是倒數中的文字，over 是時間到之後的文字。
function windowLine(className, pending, { before, after, over }) {
  const node = element('p', `response-window ${className}`);
  Object.assign(node.dataset, { deadline: responseDeadline(pending), seconds: pending.seconds, before, after, over });
  showWindowLine(node);
  return node;
}

function showWindowLine(node) {
  const left = Math.min(Number(node.dataset.seconds), Math.ceil((Number(node.dataset.deadline) - serverTime(session)) / 1000));
  node.textContent = left > 0 ? `${node.dataset.before}${left}${node.dataset.after}` : node.dataset.over;
}

setInterval(() => {
  for (const node of document.querySelectorAll('.response-window[data-deadline]')) showWindowLine(node);
}, 250);

// 等著響應的那張牌：「○○ 打出「X」（分類）」。
function pendingText(room, pending) {
  const action = cardData?.index.actions.get(pending.card);
  const category = action?.category ? `（${action.category}）` : '';
  return `${nameOf(room, pending.by)} 打出「${cardName(pending.card)}」${category}`;
}

// 發這一桌這一回合的日出；送出到寫完之間，畫面顯示「發牌中…」。
async function deal(roomCode, table) {
  dealing.add(table);
  rerender();
  try {
    await processSunrise(session, roomCode, table, cardData.data, random);
  } finally {
    dealing.delete(table);
    rerender();
  }
}

// 開局前：入座候選與人數、「開始」鈕；不能開時寫原因（沒有玩家也是），人少時寫提醒。
function startControls(room, table, roomCode) {
  const players = playersAt(room, table);
  const { error, warning } = checkSeating(players.length, cardData?.data.roles.length);
  const reason = cardsFailed ? '卡牌資料有問題，請找工作人員' : cardData ? error : '卡牌資料讀取中…';
  const start = element('button', 'table-start', '開始');
  start.type = 'button';
  start.disabled = Boolean(reason);
  start.addEventListener('click', () => run(start, () => startTable(session, roomCode, table, cardData.data, random)));
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
      await setStartOrder(session, roomCode, table, Number(select.value));
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
  if (state.round === 1 && !game.turn && !game.pending) nodes.push(...startOrderControls(room, table, game, roomCode));
  if (state.phase === 'day') nodes.push(...dayLines(room, table, game, state));
  const log = logList(room, game);
  if (log) nodes.push(element('h3', '', '最近出牌'), log);
  if (pending && dealing.has(table)) {
    nodes.push(element('p', 'table-note', '發牌中…'));
  } else if (pending) {
    const redeal = element('button', 'table-deal', '補發');
    redeal.type = 'button';
    redeal.disabled = !cardData;
    redeal.addEventListener('click', () => run(redeal, () => deal(roomCode, table)));
    nodes.push(element('p', 'table-note problem', '日出還沒發牌'), redeal);
  }
  return nodes;
}

function renderHost(room) {
  requested = false;
  markPresent();
  const roomCode = code;
  // 出牌請求自動結算，畫面不用按；卡牌資料讀到才開始。
  if (cardData && !stopSettling) {
    stopSettling = startSettling(session, roomCode, cardData.data, { random, onError: (error) => notify(explain(error)) });
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
      element('span', 'table-phase', PHASE_LABELS[state.phase]),
      element('span', 'table-fog', `迷霧值 ${state.fog}`),
    );
    const next = element('button', 'table-next', '下一階段');
    next.type = 'button';
    // 開局前、日出還沒發牌、有牌在等響應時不能推進（畫面擋，規則不擋）。
    next.disabled = !game || pending || Boolean(game?.pending);
    const blocked = game?.pending ? [element('p', 'table-note problem next-blocked', '有牌在等響應，結算完才能進下一階段')] : [];
    // 帶著畫面上這一刻的回合與階段去推進；資料庫已經不一樣就不會動。
    // 是自己這一筆把桌子推進到新回合的日出，就接著發牌。
    next.addEventListener('click', () =>
      run(next, async () => {
        const result = await advanceTable(session, roomCode, table, { round: state.round, phase: state.phase });
        if (result.advanced && result.table.phase === 'sunrise' && cardData) await deal(roomCode, table);
      }),
    );
    card.append(
      element('h2', '', `第 ${table} 桌`),
      status,
      ...(game ? gameControls(room, table, game, state, pending, roomCode) : startControls(room, table, roomCode)),
      ...blocked,
      next,
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
  show('host');
}

// 白晝時畫面需要的東西：輪次、自己的請求處理到哪、等著響應的那張牌（waiting）、同桌其他人、給 playProblem 與
// responseProblem 查的局面。不是白晝或沒入座是 null。有牌在等響應時，出牌與結束這一輪都停用（busy）。
function dayContext(state, game) {
  if (state.phase !== 'day' || !game?.seats?.[session.uid] || !cardData || !mine) return null;
  const status = dayStatus(game, state.round);
  const done = game.lastSeq?.[session.uid] ?? 0;
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
    myTurn: status.current === session.uid,
    others: seatsInOrder(game.seats)
      .map(([uid]) => uid)
      .filter((uid) => uid !== session.uid),
    view: {
      round: state.round,
      phase: state.phase,
      seats: game.seats,
      startOrder: game.startOrder,
      turn: game.turn,
      pending: waiting,
      hands: { [session.uid]: mine.hand ?? [] },
    },
  };
}

// 這張牌現在為什麼出不了（出得了是 null）。要指定對象的牌先拿同桌第一個人代入，只看牌本身與成本。
function cardProblem(day, action) {
  const someone = day.others[0] ?? null;
  const reason = playProblem(day.view, session.uid, { card: action.id, target: someone, chainTarget: someone }, cardData.data);
  if (!reason) return null;
  if (!someone && ['need-target', 'need-chain-target'].includes(reason)) return '同桌沒有可以指定的人';
  return REJECT_REASONS[reason] ?? reason;
}

// 這張響應卡現在為什麼打不出去（打得出去是 null）：時間用估計的伺服器時間，主持端結算時照樣再查一次。
function answerProblem(day, action) {
  const reason = responseProblem(day.view, session.uid, { card: action.id, pending: day.waiting.id, at: serverTime(session) }, cardData.data);
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

// 選同桌的一個人（要指定對象的牌、3 級連鎖的棄牌）；選的值記在 composing，重畫時留著。
function pickPerson(room, day, text, key) {
  const select = element('select', `composer-${key}`);
  const blank = element('option', '', '請選一個人');
  blank.value = '';
  select.append(blank);
  for (const uid of day.others) {
    const option = element('option', '', nameOf(room, uid));
    option.value = uid;
    option.selected = composing[key] === uid;
    select.append(option);
  }
  select.addEventListener('change', () => {
    composing[key] = select.value || null;
    rerender();
  });
  const label = element('label', '', text);
  label.append(select);
  return label;
}

// 出牌前的確認：這張會是幾級連鎖、要選的人，再按「確定出牌」。
function composer(room, day, action) {
  const level = chainLevel(day.status.turn, action);
  const bonus = CHAIN_BONUS[Math.min(level, 4)];
  const box = element('div', 'composer');
  box.append(element('p', 'composer-level', `這張會是 ${level} 級連鎖${bonus ? `：${bonus}` : ''}`));
  const wantsTarget = needsTarget(action);
  if (wantsTarget) box.append(pickPerson(room, day, '指定對象', 'target'));
  if (level === 3) box.append(pickPerson(room, day, '3 級連鎖：指定一人隨機棄 1 張', 'chainTarget'));
  const send = element('button', 'composer-send', '確定出牌');
  send.type = 'button';
  send.disabled = day.busy || (wantsTarget && !composing.target) || (level === 3 && !composing.chainTarget);
  const request = { card: action.id, target: wantsTarget ? composing.target : null, chainTarget: level === 3 ? composing.chainTarget : null };
  send.addEventListener('click', () => submit(() => requestPlay(session, code, request)));
  const cancel = element('button', 'composer-cancel quiet', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    composing = null;
    rerender();
  });
  box.append(send, cancel);
  return box;
}

// 一張手牌：牌名、類型、成本、牌面文字；白晝輪到自己時加上「出牌」（出不了就停用並寫原因）；別人出的牌在等響應時，
// 響應卡加上「響應」。資料檔裡找不到的牌只顯示編號。
function handItem(room, day, id, index) {
  const action = cardData.index.actions.get(id);
  const item = element('li', 'hand-card');
  if (!action) {
    item.append(element('strong', 'hand-name', id));
    return item;
  }
  const { pounds, influence } = action.cost;
  const cost = [pounds && `${pounds} 英鎊`, influence && `${influence} 影響力`].filter(Boolean).join('＋');
  const head = element('p', 'hand-head');
  head.append(
    element('strong', 'hand-name', action.name),
    element('span', `hand-kind ${action.kind}`, KIND_LABELS[action.kind] ?? action.kind),
    element('span', 'hand-cost', cost ? `成本 ${cost}` : '不用成本'),
  );
  if (action.gear) head.append(element('span', 'hand-gear', `齒輪「${action.gear}」`));
  item.append(head, element('p', 'hand-text', action.text));
  if (day?.waiting && day.waiting.by !== session.uid && action.kind === 'response') return withAnswer(item, day, action);
  if (!day?.myTurn) return item;
  const problem = cardProblem(day, action);
  if (!problem && composing?.index === index && composing.card === id) {
    item.append(composer(room, day, action));
    return item;
  }
  const play = element('button', 'hand-play', '出牌');
  play.type = 'button';
  play.disabled = Boolean(problem) || day.busy;
  play.addEventListener('click', () => {
    composing = { index, card: id, target: null, chainTarget: null };
    rerender();
  });
  item.append(play);
  if (problem) item.append(element('p', 'hand-problem', problem));
  return item;
}

// 「響應」鈕：打不出去（分類不合、付不起、時間過了…）就停用並寫原因；送出後到主持端處理完之間停用。
function withAnswer(item, day, action) {
  const problem = answerProblem(day, action);
  const answer = element('button', 'hand-respond', '響應');
  answer.type = 'button';
  answer.disabled = Boolean(problem) || day.sent;
  const pending = day.waiting.id;
  answer.addEventListener('click', () => submit(() => requestRespond(session, code, { card: action.id, pending })));
  item.append(answer);
  if (problem) item.append(element('p', 'hand-problem', problem));
  return item;
}

// 響應截止的那一刻重畫一次：「響應」鈕停用、提示換成「時間到了」。
function rerenderAtDeadline(pending) {
  if (windowEnd.id === pending.id) return;
  clearTimeout(windowEnd.timer);
  const left = responseDeadline(pending) - serverTime(session);
  windowEnd = { id: pending.id, timer: left > 0 ? setTimeout(rerender, left + 50) : null };
}

// 白晝的那張卡：輪到誰、這一輪出了幾張、連鎖、等著響應的牌與倒數、提醒倒數、請求的狀態、「結束這一輪」。
function dayCard(room, me, state, day) {
  const { status } = day;
  const nodes = [element('h2', '', '白晝出牌')];
  if (status.done) {
    nodes.push(element('p', 'day-turn', '這一回合大家都出完了，等主持端進黃昏'));
    return nodes;
  }
  const max = cardData.data.settings.maxPlaysPerTurn;
  nodes.push(
    element('p', `day-turn${day.myTurn ? ' mine' : ''}`, day.myTurn ? '輪到你出牌' : `輪到 ${nameOf(room, status.current)}`),
    element('p', 'caption', `這一輪已出 ${status.turn.plays}／${max} 張・${chainText(status.turn)}・還有 ${status.remaining} 人沒出完`),
  );
  const { waiting } = day;
  if (waiting) {
    const own = waiting.by === session.uid;
    const played = own ? `你打出「${cardName(waiting.card)}」` : pendingText(room, waiting);
    nodes.push(
      windowLine(own ? 'day-window' : 'day-window can-respond', waiting, {
        before: own ? `${played}——等其他人響應 ` : `${played}——`,
        after: own ? ' 秒' : ' 秒內可以響應',
        over: `${played}——響應時間到了，等主持端結算`,
      }),
    );
    rerenderAtDeadline(waiting);
  }
  nodes.push(countdown(me.table, state.round, status.turn.index));
  const responding = waiting && waiting.by !== session.uid;
  if (day.sent) nodes.push(element('p', 'request-state', responding ? '已送出，等結算' : '結算中…'));
  else if (day.rejected) {
    const what = myRequest?.type === 'respond' ? '響應沒有成功' : '沒有出成';
    nodes.push(element('p', 'request-state problem', `${what}：${REJECT_REASONS[day.rejected] ?? day.rejected}`));
  }
  if (day.myTurn) {
    const pass = element('button', 'day-pass quiet', '結束這一輪');
    pass.type = 'button';
    pass.disabled = day.busy;
    pass.addEventListener('click', () => submit(() => requestPass(session, code)));
    nodes.push(pass);
  }
  return nodes;
}

// 自己的階層、資源、天命與手牌。還沒開局、沒有入座或資料還沒到時，只顯示一句說明。
function renderMyGame(room, me, state, game) {
  const seat = game?.seats?.[session.uid];
  let wait = '';
  if (!game) wait = '等待主持端開局';
  else if (!seat) wait = '本桌已開局，這一局沒有你的座位，請找工作人員';
  else if (cardsFailed) wait = '卡牌資料有問題，請找工作人員';
  else if (!cardData || !mine) wait = '讀取手牌中…';
  $('player-wait').textContent = wait;
  $('player-wait').hidden = !wait;
  $('player-game').hidden = Boolean(wait);
  if (wait) return;

  const role = cardData.index.roles.get(seat.role);
  $('player-role').textContent = role?.name ?? seat.role;
  $('player-pounds').textContent = seat.pounds;
  $('player-influence').textContent = seat.influence;
  $('player-missions').replaceChildren(...(role?.missions ?? []).map((text) => element('li', '', text)));
  $('player-privileges').replaceChildren(...(role?.privileges ?? []).map((text) => element('li', '', text)));
  const destiny = cardData.index.destinies.get(mine.destiny);
  $('player-destiny').textContent = destiny?.text ?? '這一局沒有天命';
  $('player-destiny-score').textContent = destiny ? `達成條件：${destiny.score.text}` : '';
  const hand = mine.hand ?? [];
  const day = dayContext(state, game);
  if (!day?.myTurn || hand[composing?.index] !== composing?.card) composing = null; // 換人了或那張牌已經不在
  $('player-day').hidden = !day;
  $('player-day').replaceChildren(...(day ? dayCard(room, me, state, day) : []));
  $('player-hand-count').textContent = hand.length;
  $('player-hand').replaceChildren(...hand.map((id, index) => handItem(room, day, id, index)));
  const log = logList(room, game);
  $('player-log-card').hidden = !log;
  $('player-log').replaceChildren(...(log ? log.children : []));
}

// 同桌玩家。開局後照座位排，附階層、英鎊、影響力、手牌張數；沒入座的排在最後。
function mateItems(room, table, game) {
  const players = playersAt(room, table);
  if (!game) return players.map(([uid, player]) => nameTag(room, uid, player, 'li'));
  const withNote = (item, note) => {
    item.append(element('span', 'mate-stats', note));
    return item;
  };
  const seated = seatsInOrder(game.seats).map(([uid, seat]) => {
    const player = room.players?.[uid];
    const item = player ? nameTag(room, uid, player, 'li') : element('li', 'offline', '（已離開房間）');
    return withNote(item, `${roleName(seat.role)}・英鎊 ${seat.pounds}・影響力 ${seat.influence}・手牌 ${seat.handCount}`);
  });
  const unseated = players.filter(([uid]) => !game.seats[uid]).map(([uid, player]) => withNote(nameTag(room, uid, player, 'li'), '未入座'));
  return [...seated, ...unseated];
}

// 訂閱自己的私密資料，一有變動就重畫。快取裡已經有資料時，回呼會在訂閱的當下就跑（會再進到這裡），
// 所以先把 stopPrivate 設好再訂閱。
function watchMine() {
  if (stopPrivate) return;
  let stopped = false;
  let stop = null;
  stopPrivate = () => {
    stopped = true;
    stop?.();
  };
  stop = watchPrivate(
    session,
    code,
    (value) => {
      mine = value;
      rerender();
    },
    () => {},
  );
  if (stopped) stop();
}

// 訂閱自己最新的一筆出牌請求（看主持端處理到哪），做法同 watchMine。
function watchMyRequest() {
  if (stopRequest) return;
  let stopped = false;
  let stop = null;
  stopRequest = () => {
    stopped = true;
    stop?.();
  };
  stop = watchRequest(
    session,
    code,
    (value) => {
      myRequest = value;
      rerender();
    },
    () => {},
  );
  if (stopped) stop();
}

function renderPlayer(room, me) {
  markPresent();
  watchMine();
  watchMyRequest();
  const state = room.tables[me.table];
  const game = room.games?.[me.table];
  $('player-stage').dataset.phase = state.phase;
  $('player-table').textContent = `第 ${me.table} 桌`;
  $('player-round').textContent = `第 ${state.round} 回合`;
  $('player-phase').textContent = PHASE_LABELS[state.phase];
  $('player-fog').textContent = state.fog;
  $('player-fog-meter').value = state.fog;
  renderMyGame(room, me, state, game);
  $('player-mates').replaceChildren(...mateItems(room, me.table, game));
  $('player-host-offline').hidden = hostUids(room).some((uid) => isOnline(room, uid));
  $('player-code').textContent = code;
  show('player');
}

$('create-room').addEventListener('click', () =>
  run($('create-room'), async () => enterRoom(await createRoom(session))),
);

// 已經是主持端就直接回到主持畫面；還不是就送出申請，在等待畫面等核准。
$('host-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.target.querySelector('button'), async () => {
    enterRoom((await enterAsHost(session, $('host-join-code').value)).code);
    event.target.reset();
  });
});

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.target.querySelector('button'), async () =>
    enterRoom(await joinRoom(session, $('join-code').value, $('join-name').value, Number($('join-table').value))),
  );
});

$('pending-cancel').addEventListener('click', () => {
  const leaving = code;
  goHome();
  cancelHostRequest(session, leaving).catch((error) => notify(explain(error)));
});

$('player-leave').addEventListener('click', () => {
  const leaving = code;
  goHome();
  leaveRoom(session, leaving).catch((error) => notify(explain(error)));
});

$('host-leave').addEventListener('click', () => {
  if (confirm('離開後房間會保留，這台裝置之後可以在首頁用房號「以主持端進入」回來。確定離開？')) goHome();
});

for (let table = 1; table <= MAX_TABLES; table += 1) {
  const option = element('option', '', `第 ${table} 桌`);
  option.value = table;
  $('join-table').append(option);
}

// 卡牌資料與連線同時開始讀。讀不到或檢查有錯誤時，畫面頂端一直顯示提醒，開局與發牌都停用。
loadGameData()
  .then(({ data, errors }) => {
    if (errors.length) throw new Error(errors.join('\n'));
    cardData = { data, index: indexGameData(data) };
  })
  .catch((error) => {
    cardsFailed = true;
    $('data-problem').hidden = false;
    console.error(`卡牌資料有問題：\n${error.message}`);
  })
  .finally(rerender);

try {
  session = await connect(slot);
  watchConnection(session, showConnection);
  const saved = localStorage.getItem(savedRoomKey);
  if (isRoomCode(saved)) enterRoom(saved);
  else show('home');
} catch {
  notify('連不上遊戲伺服器，請確認網路後重新整理頁面');
}
