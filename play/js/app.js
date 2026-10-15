// 畫面與事件：首頁、等待核准、主持端、玩家端幾個畫面切換。資料一律從 store.js 的訂閱來，
// 牌名與牌面文字從卡牌資料檔（gamedata.js）來。
import { seed } from './config.js';
import {
  DISCARD_REASONS,
  NIGHT_CHOICES,
  NIGHT_REASONS,
  REJECT_REASONS,
  VOTE_REASONS,
  chainLevel,
  checkSeating,
  choiceProblem,
  dayStatus,
  discardProblem,
  duskStage,
  eventLogList,
  needsTarget,
  nightSettings,
  nightStage,
  overLimit,
  playProblem,
  responseDeadline,
  responseProblem,
  scoreSettings,
  seatsInOrder,
  seededRandom,
  shouldEnd,
  skippedEffects,
  skippedEventEffects,
  sunriseEventsOf,
  sunsetClock,
  voteProblem,
} from './game.js';
import { indexGameData, loadGameData } from './gamedata.js';
import { MAX_TABLES, PHASE_LABELS, confirmCode, hostUids, isHostOf, isRoomCode } from './rules.js';
import {
  StoreError,
  advanceOrEnd,
  approveHost,
  cancelHostRequest,
  connect,
  createRoom,
  enterAsHost,
  joinRoom,
  judgeDestiny,
  leaveRoom,
  processSunrise,
  rejectHost,
  requestDiscard,
  requestNight,
  requestPass,
  requestPlay,
  requestRespond,
  requestVote,
  revealDusk,
  revealNight,
  serverTime,
  setEndAfterRound,
  setStartOrder,
  startSettling,
  startTable,
  trackPresence,
  watchConnection,
  watchDiscard,
  watchNight,
  watchPrivate,
  watchRequest,
  watchRoom,
  watchVote,
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
let stopVote = null;
let myVote = null; // 自己最新的一張票 { table, round, side, bid, seq, at }
let ballot = null; // 玩家：正在選的票 { key: '桌:回合', side, bid, touched }；重畫時留著，換回合就清掉
let voting = false; // 玩家：票送出中
const wakeups = new Map(); // 黃昏與黑夜的截止時間 → 到時重畫一次的計時器（送出鈕、提前揭曉鈕要跟著停用）
const SIDE_LABELS = { yes: '贊成', no: '反對', abstain: '棄權' };
let stopNight = null;
let myNight = null; // 自己最新的黑夜選擇 { table, round, choice, tiers, seq, at }
let nightPick = null; // 玩家：正在選的 { key: '桌:回合', choice, tiers, touched }；重畫時留著，換回合就清掉
let nightSending = false; // 玩家：黑夜的選擇送出中
let stopDiscard = null;
let myDiscard = null; // 自己最新挑的棄牌 { table, round, cards, seq, at }
let discardPick = null; // 玩家：正在挑的棄牌 { key: '桌:回合:手牌', indexes: [手牌的第幾張…], touched }
let discardSending = false;
const hostDiscards = new Map(); // 主持端：uid → { stop, value }（各入座玩家挑的棄牌，列出還沒挑的人用）

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
  stopVote?.();
  stopVote = null;
  stopNight?.();
  stopNight = null;
  stopDiscard?.();
  stopDiscard = null;
  for (const { stop } of hostDiscards.values()) stop();
  hostDiscards.clear();
  mine = null;
  myRequest = null;
  myVote = null;
  ballot = null;
  myNight = null;
  nightPick = null;
  myDiscard = null;
  discardPick = null;
  composing = null;
  for (const { timer } of wakeups.values()) clearTimeout(timer);
  wakeups.clear();
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

const RESOURCE_LABELS = { pounds: '英鎊', influence: '影響力' };

// 這張牌的「偷」寫成「從 ○○ 偷走 3 英鎊」；from 是被偷的人。數量是牌上的數量（4 級連鎖加倍）：出牌紀錄沒有記實際拿到多少，
// 對方不夠時實際拿到的比較少（見座位上的數字）。
function stealText(room, action, from, level = 1) {
  const steals = (action?.effects ?? []).filter((effect) => effect.op === 'steal');
  if (!from || steals.length === 0) return '';
  const parts = steals.map((effect) => `${effect.amount * (level >= 4 ? 2 : 1)} ${RESOURCE_LABELS[effect.resource] ?? effect.resource}`);
  return `・從 ${nameOf(room, from)} 偷走 ${parts.join('、')}`;
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
    const stolen = entry.canceled ? '' : stealText(room, cardData?.index.actions.get(entry.card), entry.target, entry.level);
    const answer = entry.response ? `・被 ${nameOf(room, entry.response.by)} 以「${cardName(entry.response.card)}」響應${entry.canceled ? '，被抵銷' : ''}` : '';
    const answered = entry.response ? stealText(room, cardData?.index.actions.get(entry.response.card), entry.by) : '';
    list.append(element('li', '', `第 ${entry.round} 回合・${nameOf(room, entry.by)} 打出「${name}」${level}${target}${stolen}${chain}${answer}${answered}`));
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
function windowLine(className, pending, texts) {
  return deadlineLine(`response-window ${className}`, responseDeadline(pending), pending.seconds, texts);
}

// 照伺服器時間倒數到 deadline 的一行（響應窗口、黃昏的提醒與揭曉倒數共用），顯示的秒數不超過 seconds。
function deadlineLine(className, deadline, seconds, { before, after, over }) {
  const node = element('p', `server-countdown ${className}`);
  Object.assign(node.dataset, { deadline, seconds, before, after, over });
  showWindowLine(node);
  return node;
}

function showWindowLine(node) {
  const left = Math.min(Number(node.dataset.seconds), Math.ceil((Number(node.dataset.deadline) - serverTime(session)) / 1000));
  node.textContent = left > 0 ? `${node.dataset.before}${left}${node.dataset.after}` : node.dataset.over;
}

setInterval(() => {
  for (const node of document.querySelectorAll('.server-countdown[data-deadline]')) showWindowLine(node);
}, 250);

// 到了伺服器時間 at 時重畫一次（同一個時間只排一次）。
function rerenderAt(at) {
  if (wakeups.has(at)) return;
  const left = at - serverTime(session);
  wakeups.set(at, { timer: left > 0 ? setTimeout(rerender, left + 50) : null });
}

// ---- 事件（M7） ----

function eventOf(id) {
  return cardData?.index.events?.get(id) ?? null;
}

const TARGET_TEXT = { all: '全體', chosen: '指定一人' };

// 一個效果寫成一句：「全體英鎊 +3」「蒸汽工業大亨抽 1 張」「迷霧 +3」。
function effectText(effect) {
  if (effect.op === 'fog') return `迷霧 ${effect.amount > 0 ? '+' : ''}${effect.amount}`;
  const who = effect.target === 'role' ? roleName(effect.role) : (TARGET_TEXT[effect.target] ?? effect.target);
  if (effect.op === 'pounds' || effect.op === 'influence') return `${who}${RESOURCE_LABELS[effect.op]} ${effect.amount > 0 ? '+' : ''}${effect.amount}`;
  if (effect.op === 'draw') return `${who}抽 ${effect.amount} 張`;
  if (effect.op === 'discard') return `${who}隨機棄 ${effect.amount} 張`;
  return effect.op;
}

// 一筆事件紀錄的標題：一般事件是「《名稱》（年代）」，迷霧事件是「迷霧越過 30：《名稱》」。
function eventTitle(entry) {
  const event = eventOf(entry.event);
  const name = event ? `《${event.name}》${event.year ? `（${event.year}）` : ''}` : entry.event ? `事件 ${entry.event}` : '資料裡沒有這個門檻的事件';
  return entry.kind === 'fog' ? `迷霧越過 ${entry.threshold}：${name}` : name;
}

// 一張事件：標題、牌面文字、效果（含數字），以及沒結算的部分。有沒有結算看紀錄的 skipped（結算當時的結果），
// 不看現在的卡牌資料：資料之後改了也不會寫錯。
function eventLines(entry) {
  const event = eventOf(entry.event);
  const nodes = [element('p', `event-title${entry.kind === 'fog' ? ' fog-event' : ''}`, eventTitle(entry))];
  if (event) nodes.push(element('p', 'event-text', event.text));
  if (entry.skipped) {
    const why = entry.event ? '這張事件的效果還沒做好（todo），沒有結算' : '沒有效果';
    return [...nodes, element('p', 'table-note problem', why)];
  }
  if (!event) return [...nodes, element('p', 'table-note problem', '卡牌資料裡找不到這張事件的內容')];
  if (event.effects.length) nodes.push(element('p', 'event-effects', `效果：${event.effects.map(effectText).join('、')}`));
  const skipped = skippedEventEffects(event);
  if (skipped.length) nodes.push(element('p', 'table-note problem', `有 ${skipped.length} 個效果要指定一人，這一版不結算，已略過`));
  return nodes;
}

// 這一回合要一直顯示的事件：日出到白晝結束顯示今天翻到的一般事件；這一回合觸發過的迷霧事件（任何階段）。
function todaysEvents(game, state) {
  const deck = state.phase === 'sunrise' || state.phase === 'day' ? sunriseEventsOf(game.eventLog, state.round) : [];
  const fog = eventLogList(game.eventLog).filter((entry) => entry.kind === 'fog' && entry.round === state.round);
  return [...deck, ...fog];
}

function eventsBlock(game, state) {
  if (!cardData) return []; // 卡牌資料還沒讀到時不顯示，免得寫成「找不到這張事件」
  const entries = todaysEvents(game, state);
  if (entries.length === 0) return [];
  const deck = entries.filter((entry) => entry.kind === 'deck');
  const nodes = [];
  if (deck.length) nodes.push(element('h3', 'events-heading', '今日事件'));
  for (const entry of entries) {
    const block = element('div', `event ${entry.kind === 'fog' ? 'event-fog' : 'event-deck'}`);
    block.append(...eventLines(entry));
    nodes.push(block);
  }
  return nodes;
}

// 迷霧值旁邊列已觸發的門檻。
function firedText(game) {
  const fired = [...(game?.fogFired ?? [])].sort((a, b) => a - b);
  return fired.length ? `已觸發：${fired.join('、')}` : '';
}

const PHASE_SHORT = { sunrise: '日出', day: '白晝', dusk: '黃昏', night: '黑夜' };

// 本場的事件紀錄（翻過的一般事件、觸發過的迷霧事件），照發生順序。
function eventLogItems(game) {
  return eventLogList(game?.eventLog).map((entry) => {
    const kind = entry.kind === 'fog' ? '' : '一般事件';
    return element('li', entry.kind === 'fog' ? 'fog-event' : '', `第 ${entry.round} 回合${PHASE_SHORT[entry.phase] ?? ''}・${kind}${eventTitle(entry)}`);
  });
}

// ---- 黃昏（M6） ----

function billOf(id) {
  return cardData?.data.bills.find((bill) => bill.id === id) ?? null;
}

// 法案卡：名稱、年代、說明。資料檔裡找不到時只顯示編號。
function billLines(id) {
  const bill = billOf(id);
  if (!bill) return [element('p', 'dusk-bill', `法案 ${id}`)];
  return [element('p', 'dusk-bill', `《${bill.name}》${bill.year ? `（${bill.year}）` : ''}`), element('p', 'dusk-text', bill.text)];
}

function sideText(vote) {
  return vote.side === 'abstain' ? '棄權' : `${SIDE_LABELS[vote.side] ?? vote.side} ${vote.bid}`;
}

// 黃昏的提醒倒數（只顯示，不會自動揭曉）：從翻開法案的伺服器時間算起。
function reminderLine(dusk) {
  const seconds = cardData?.data.settings.reminderSeconds.dusk ?? 120;
  return deadlineLine('countdown dusk-reminder', dusk.openedAt + seconds * 1000, seconds, {
    before: '提醒倒數 ',
    after: ' 秒',
    over: `已經超過 ${seconds} 秒（只是提醒，不會自動揭曉）`,
  });
}

// 截止時間（revealAt）的倒數：全員送出後是「n 秒後揭曉」，提前揭曉時直接是截止了。
function revealLine(dusk) {
  rerenderAt(dusk.revealAt);
  return deadlineLine('dusk-countdown', dusk.revealAt, cardData?.data.settings.duskRevealSeconds ?? 3, {
    before: '大家都送出了，',
    after: ' 秒後揭曉',
    over: '投票截止了，揭曉中…',
  });
}

// 揭曉結果：通過與否、兩邊總和、每個人的選邊與出價（沒送出的算棄權）。uid 是玩家自己時，另外寫付了多少、現在的數字。
function resultLines(room, game, id, result, uid) {
  const nodes = [
    element('p', `dusk-result ${result.passed ? 'passed' : 'failed'}`, `揭曉：${result.passed ? '通過' : '沒有通過'}（贊成 ${result.yes}：反對 ${result.no}）`),
  ];
  const list = element('ul', 'dusk-votes');
  for (const [seatUid] of seatsInOrder(game.seats)) {
    const vote = result.votes?.[seatUid];
    list.append(element('li', seatUid === uid ? 'me' : '', `${nameOf(room, seatUid)}：${vote ? sideText(vote) : '沒送出（算棄權）'}`));
  }
  nodes.push(list);
  const bill = billOf(id);
  if (uid && game.seats[uid]) {
    const vote = result.votes?.[uid];
    const paid = vote && vote.side !== 'abstain' ? vote.bid : 0;
    const seat = game.seats[uid];
    const sided = vote && ((vote.side === 'yes' && result.passed) || (vote.side === 'no' && !result.passed));
    nodes.push(
      element('p', 'dusk-paid', `你付了 ${paid} 影響力${sided ? '・站在結果這一邊（議會之聲 +1）' : ''}`),
      element('p', 'dusk-now', `照「${result.passed ? '通過' : '不通過'}」的效果結算後，你現在：英鎊 ${seat.pounds}・影響力 ${seat.influence}`),
    );
  } else if (!bill) {
    nodes.push(element('p', 'table-note problem', '卡牌資料裡找不到這張法案，效果沒有結算'));
  } else {
    const skipped = skippedEffects(bill, result.passed);
    if (bill.todo === true) nodes.push(element('p', 'table-note problem', '這張法案的效果還沒做好（todo），這次沒有結算'));
    else if (skipped.length) nodes.push(element('p', 'table-note problem', `這張法案有 ${skipped.length} 個效果要指定一人，這一版不結算，已略過`));
  }
  return nodes;
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
  if (state.phase === 'dusk' && (stage === 'voting' || dusk.revealAt > serverTime(session) + 500)) {
    const early = element('button', 'dusk-reveal quiet', '提前揭曉');
    early.type = 'button';
    early.addEventListener('click', () => run(early, () => revealDusk(session, roomCode, table)));
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

// ---- 黑夜（M8）：豪賭、分贓、睡覺，與手牌上限 ----

const CHOICE_LABELS = { gamble: '豪賭', split: '分贓', sleep: '睡覺' };

// 黑夜的數值（資料檔沒寫時用預設值）。
function nightRules() {
  return nightSettings(cardData?.data.settings);
}

function choiceText(pick) {
  return pick.choice === 'gamble' ? `豪賭到第 ${pick.tiers} 層` : (CHOICE_LABELS[pick.choice] ?? pick.choice);
}

const signed = (amount) => (amount > 0 ? `+${amount}` : `${amount}`);

function gains(pounds, influence) {
  return [pounds && `${pounds} 英鎊`, influence && `${influence} 影響力`].filter(Boolean).join('＋') || '什麼都沒有';
}

// 豪賭每一層：爆的機率與過關時累積變成多少。
function tierTexts() {
  const rules = nightRules();
  return rules.bust.map((bust, index) => {
    const odds = bust <= 0 ? '不會爆' : bust >= 6 ? '一定爆' : `擲到 ${bust} 以下就爆（${bust}/6）`;
    return `第 ${index + 1} 層：${odds}，過關累積變成 ${gains(rules.pounds[index], rules.influence[index])}${index === rules.bust.length - 1 ? '（秘寶）' : ''}`;
  });
}

// 一個人的結果：豪賭逐層的點數與過關／爆、拿到多少；分贓拿多少；睡覺。
function outcomeText(outcome) {
  if (outcome.choice === 'gamble') {
    const rolls = outcome.rolls.map((roll, index) => `第 ${index + 1} 層擲 ${roll}${outcome.bust && index === outcome.rolls.length - 1 ? ' 爆了' : ' 過關'}`).join('、');
    const money = outcome.bust ? (outcome.pounds < 0 ? `付醫藥費 ${-outcome.pounds} 英鎊` : '沒有英鎊付醫藥費') : `拿到 ${gains(outcome.pounds, outcome.influence)}`;
    return `豪賭到第 ${outcome.tiers} 層——${rolls}——${money}`;
  }
  if (outcome.choice === 'split') return `分贓——拿到 ${outcome.pounds} 英鎊、罪孽 +${outcome.sin}`;
  return '睡覺';
}

// 黑夜的提醒倒數（只顯示，不會自動揭曉）：從黑夜開始的伺服器時間算起。
function nightReminderLine(night) {
  const seconds = cardData?.data.settings.reminderSeconds.night ?? 120;
  return deadlineLine('countdown night-reminder', night.openedAt + seconds * 1000, seconds, {
    before: '提醒倒數 ',
    after: ' 秒',
    over: `已經超過 ${seconds} 秒（只是提醒，不會自動揭曉）`,
  });
}

// 截止時間的倒數：全員送出後是「n 秒後揭曉」，提前揭曉時直接是截止了。
function nightRevealLine(night) {
  rerenderAt(night.revealAt);
  return deadlineLine('night-countdown', night.revealAt, nightRules().revealSeconds, {
    before: '大家都送出了，',
    after: ' 秒後揭曉',
    over: '黑夜截止了，揭曉中…',
  });
}

// 揭曉結果：每個人的選擇與結果（沒送出的算睡覺）。uid 是玩家自己時，另外寫自己這一夜的變化與現在的數字。
function nightResultLines(room, game, result, uid) {
  const nodes = [element('p', 'night-result', '黑夜揭曉')];
  const list = element('ul', 'night-players');
  for (const [seatUid] of seatsInOrder(game.seats)) {
    const outcome = result.players?.[seatUid];
    list.append(element('li', seatUid === uid ? 'me' : '', `${nameOf(room, seatUid)}：${outcome ? outcomeText(outcome) : '睡覺'}`));
  }
  nodes.push(list);
  const outcome = uid ? result.players?.[uid] : null;
  const seat = uid ? game.seats[uid] : null;
  if (outcome && seat) {
    const sin = outcome.sin ? `・罪孽 +${outcome.sin}` : '';
    nodes.push(
      element('p', 'night-mine', `你這一夜：英鎊 ${signed(outcome.pounds)}・影響力 ${signed(outcome.influence)}${sin}`),
      element('p', 'night-now', `你現在：英鎊 ${seat.pounds}・影響力 ${seat.influence}${seat.sin ? `・罪孽 ${seat.sin}` : ''}`),
    );
  }
  return nodes;
}

// 主持端：這一桌入座的人挑的棄牌（逐人訂閱，列出還沒挑的人用）。
function watchHostDiscards(roomCode, game) {
  for (const uid of Object.keys(game.seats ?? {})) {
    if (hostDiscards.has(uid)) continue;
    const entry = { stop: () => {}, value: null };
    hostDiscards.set(uid, entry);
    entry.stop = watchDiscard(
      session,
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
  const limit = cardData?.data.settings.handLimit;
  if (!limit) return [];
  const over = seatsInOrder(game.seats).filter(([, seat]) => seat.handCount > limit);
  if (over.length === 0) return [];
  // 這一回合黑夜結束就算分：終局不棄牌，照現在的手牌算。
  if (endReasonNow(game, state) !== null) return [element('p', 'table-note hand-limit-ending', '這一回合結束就算分：手牌超過上限的人不用棄牌，照現在的手牌算')];
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
    if (stage === 'choosing' || night.revealAt > serverTime(session) + 500) {
      const early = element('button', 'night-reveal quiet', '提前揭曉');
      early.type = 'button';
      early.addEventListener('click', () => run(early, () => revealNight(session, roomCode, table)));
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

// ---- 終局與計分（M9） ----

const PHASE_NAMES = { ...PHASE_LABELS, end: '終局' };
const END_REASON_TEXT = { sunset: '日落鐘到了', maxRounds: '到了回合上限', host: '主持端提早收場' };
const ACHIEVEMENT_LABELS = { parliament: '議會之聲', gear: '齒輪大師' };
const MINUTE_MS = 60_000;

function scoreRules() {
  return scoreSettings(cardData?.data.settings);
}

// 這一回合是不是最後一回合（這一回合黑夜揭曉後按「下一階段」就算分）：原因或 null。玩家畫面的「這是最後一回合」、主持端的
// 「下一階段（算分）」都看它；日落鐘照伺服器時間算。
function endReasonNow(game, state) {
  if (!game?.seats || !cardData || state.phase === 'end') return null;
  return shouldEnd({ round: state.round, startedAt: game.startedAt, endAfterRound: game.endAfterRound }, cardData.data.settings, serverTime(session));
}

// 日落鐘到點時重畫一次（「這是最後一回合」、按鈕跟著換）。
function wakeAtSunset(game) {
  if (cardData && typeof game?.startedAt === 'number') rerenderAt(game.startedAt + scoreRules().sunsetMinutes * MINUTE_MS);
}

const clockText = (ms) => `${Math.floor(ms / MINUTE_MS)} 分 ${String(Math.floor((ms % MINUTE_MS) / 1000)).padStart(2, '0')} 秒`;

// 主持端的日落鐘：已過多久、還剩多久；過了就寫「這回合結束後算分」。照伺服器時間每秒更新。
function sunsetLine(game) {
  const node = element('p', 'sunset-clock table-note');
  node.dataset.started = game.startedAt;
  showSunset(node);
  wakeAtSunset(game);
  return node;
}

function showSunset(node) {
  const clock = sunsetClock(Number(node.dataset.started), cardData?.data.settings, serverTime(session));
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
    toggle.addEventListener('click', () => run(toggle, () => setEndAfterRound(session, roomCode, table, !marked)));
    nodes.push(toggle);
    if (!marked) nodes.push(element('p', 'caption', '試玩時間不夠時用：這一回合黑夜揭曉後就算分，按了還可以取消'));
  }
  return nodes;
}

// 「判定」空白的天命（終局時由主持端勾）。
function judgedByHost(id) {
  const card = id ? cardData?.index.destinies.get(id) : null;
  return Boolean(card) && (card.check ?? null) === null;
}

// 天命那一項：內容與是否達成（終局時公開）。
function destinyText(destiny) {
  if (!destiny?.id) return '天命：這一局沒有天命（0 分）';
  const condition = cardData?.index.destinies.get(destiny.id)?.score.text;
  const state = destiny.done === true ? `達成 +${destiny.points}` : destiny.done === false ? '沒達成 0 分' : `待主持人判定（目前 0 分，達成 +${destiny.points}）`;
  return `天命「${destiny.text}」${condition ? `（${condition}）` : ''}：${state}`;
}

// 一個人的分數明細（每一項怎麼算的）。公共成就的分數從存下來的總分推回來（算分那一刻的設定），算式一定對得上存下來的總分。
function scoreLines(score) {
  const rules = scoreRules();
  const { assets } = score;
  const earned = score.destiny?.done === true ? score.destiny.points : 0;
  const list = score.achievements ?? [];
  const bonus = score.total - earned - assets.points + score.sinPenalty;
  return [
    destinyText(score.destiny),
    `資產：英鎊 ${assets.pounds} ÷ ${rules.poundsRate} → ${Math.floor(assets.pounds / rules.poundsRate)} 分、影響力 ${assets.influence} ÷ ${rules.influenceRate} → ${Math.floor(assets.influence / rules.influenceRate)} 分（各自捨去），共 ${assets.points} 分`,
    `公共成就：${list.length ? list.map((key) => `${ACHIEVEMENT_LABELS[key] ?? key} +${bonus / list.length}`).join('、') : '沒有'}`,
    `罪孽：${score.sin} 點 ÷ ${rules.sinPerPenalty} → 扣 ${score.sinPenalty} 分（捨去）`,
    `總分：${earned}＋${assets.points}＋${bonus}－${score.sinPenalty}＝${score.total}`,
  ];
}

// 照名次排好的 [uid, 分數]（同名次照座位）。
function rankedScores(game) {
  return Object.entries(game.final?.scores ?? {}).sort(([a, x], [b, y]) => x.rank - y.rank || (game.seats[a]?.order ?? 0) - (game.seats[b]?.order ?? 0));
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
        button.addEventListener('click', () => run(button, () => judgeDestiny(session, roomCode, table, uid, done)));
        box.append(button);
      }
      item.append(box);
    }
    list.append(item);
  }
  nodes.push(list);
  return nodes;
}

// 結算（玩家）：自己的分數明細、全桌名次、每個人的天命與是否達成。
function finalCard(room, game) {
  const { final } = game;
  const mine = final.scores?.[session.uid];
  const nodes = [element('h2', '', '終局結算'), element('p', 'caption final-reason', `第 ${final.round} 回合結束後算分（${END_REASON_TEXT[final.reason] ?? final.reason}）`)];
  if (mine) {
    nodes.push(element('p', 'final-mine', `你是第 ${mine.rank} 名，總分 ${mine.total}`));
    const detail = element('ul', 'final-detail');
    detail.append(...scoreLines(mine).map((line) => element('li', '', line)));
    nodes.push(detail);
  }
  nodes.push(element('h3', '', '全桌名次'));
  const list = element('ol', 'final-scores');
  for (const [uid, score] of rankedScores(game)) {
    const item = element('li', uid === session.uid ? 'final-row me' : 'final-row');
    item.dataset.uid = uid;
    item.append(element('p', 'final-head', `第 ${score.rank} 名・${nameOf(room, uid)}・總分 ${score.total}`), element('p', 'final-line caption', destinyText(score.destiny)));
    list.append(item);
  }
  nodes.push(list);
  return nodes;
}

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
  if (state.phase === 'end' && game.final) nodes.push(...finalLines(room, table, game, roomCode));
  else if (cardData) nodes.push(...endControls(table, game, state, roomCode));
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
    next.disabled = !game || pending || Boolean(why) || (state.phase === 'night' && !cardData);
    const blocked = why ? [element('p', 'table-note problem next-blocked', why)] : [];
    // 帶著畫面上這一刻的回合與階段去推進；資料庫已經不一樣就不會動。黑夜時該算分就算分（同一筆寫入），不然推進到下一回合日出。
    // 是自己這一筆把桌子推進到新回合的日出，就接著發牌。
    next.addEventListener('click', () =>
      run(next, async () => {
        const result = await advanceOrEnd(session, roomCode, table, { round: state.round, phase: state.phase }, cardData?.data);
        if (result.advanced && !result.ended && result.table.phase === 'sunrise' && cardData) await deal(roomCode, table);
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

// 送出（或改）自己的票；送出到寫完之間，送出鈕停用。
async function castVote(vote) {
  voting = true;
  notify();
  rerender();
  try {
    await requestVote(session, code, vote);
  } catch (error) {
    notify(explain(error));
  } finally {
    voting = false;
    rerender();
  }
}

// 選邊（贊成／反對／棄權）與出價（0 到自己的影響力）、「送出」；選的值記在 ballot，重畫時留著。送不出去就停用並寫原因。
function ballotBox(me, state, game, sent) {
  const seat = game.seats[session.uid];
  const key = `${me.table}:${state.round}`;
  // 換了回合，或自己還沒動過選票時，跟著已送出的票（重新整理後自己的票可能晚一點才到）。
  if (ballot?.key !== key || !ballot.touched) ballot = { key, side: sent?.side ?? null, bid: sent?.bid ?? 0, touched: false };
  const box = element('div', 'ballot');
  box.append(element('p', 'caption', `你的影響力 ${seat.influence}：出價 0 到 ${seat.influence}，選邊的人不論輸贏都要付；棄權不用付`));
  const sides = element('p', 'ballot-sides');
  for (const side of ['yes', 'no', 'abstain']) {
    const button = element('button', `ballot-side${ballot.side === side ? ' chosen' : ' quiet'}`, SIDE_LABELS[side]);
    button.type = 'button';
    button.dataset.side = side;
    button.setAttribute('aria-pressed', String(ballot.side === side));
    button.addEventListener('click', () => {
      ballot = { ...ballot, side, bid: side === 'abstain' ? 0 : Math.min(ballot.bid, seat.influence), touched: true };
      rerender();
    });
    sides.append(button);
  }
  const select = element('select', 'ballot-bid');
  for (let bid = 0; bid <= seat.influence; bid += 1) {
    const option = element('option', '', `${bid}`);
    option.value = bid;
    option.selected = ballot.bid === bid;
    select.append(option);
  }
  select.disabled = ballot.side === 'abstain';
  select.addEventListener('change', () => {
    ballot = { ...ballot, bid: Number(select.value), touched: true };
    rerender();
  });
  const label = element('label', 'ballot-bid-label', '影響力出價');
  label.append(select);
  const vote = { table: me.table, round: state.round, side: ballot.side, bid: ballot.side === 'abstain' ? 0 : ballot.bid };
  const view = { table: me.table, round: state.round, phase: state.phase, seats: game.seats, dusk: game.dusk };
  const reason = ballot.side ? voteProblem(view, session.uid, { ...vote, at: serverTime(session) }) : null;
  const send = element('button', 'ballot-send', sent ? '改成這一張' : '送出');
  send.type = 'button';
  send.disabled = !ballot.side || Boolean(reason) || voting;
  send.addEventListener('click', () => castVote(vote));
  box.append(sides, label, send);
  if (reason) box.append(element('p', 'hand-problem', VOTE_REASONS[reason] ?? reason));
  return box;
}

// 黃昏的那張卡：法案、已送出人數、提醒倒數、自己的票與選票、揭曉倒數、揭曉結果；休會時只有一句話。
function duskCard(room, me, state, game) {
  const stage = duskStage(game.dusk, state.round);
  const nodes = [element('h2', '', '黃昏：法案表決')];
  if (stage === 'none') return [...nodes, element('p', 'caption', '等主持端翻開法案…')];
  if (stage === 'adjourned') return [...nodes, element('p', 'dusk-bill', '今天議會休會'), element('p', 'caption', '這一回合不用投票，等主持端進黑夜')];
  const { dusk } = game;
  nodes.push(...billLines(dusk.bill));
  if (stage === 'revealed') return [...nodes, ...resultLines(room, game, dusk.bill, dusk.result, session.uid)];
  nodes.push(element('p', 'dusk-submitted', `已送出 ${dusk.submitted ?? 0}／${Object.keys(game.seats).length} 人`));
  nodes.push(stage === 'voting' ? reminderLine(dusk) : revealLine(dusk));
  const sent = myVote && String(myVote.table) === String(me.table) && myVote.round === state.round ? myVote : null;
  if (sent) nodes.push(element('p', 'dusk-sent', `已送出：${sideText(sent)}（揭曉前可以改）`));
  if (state.phase === 'dusk' && (stage === 'voting' || serverTime(session) < dusk.revealAt)) nodes.push(ballotBox(me, state, game, sent));
  else nodes.push(element('p', 'caption', sent ? '投票截止了，等揭曉' : '投票截止了，你沒有送出，算棄權'));
  return nodes;
}

// 送出（或改）黑夜的選擇、挑的棄牌；送出到寫完之間，送出鈕停用。
async function sendNight(action, which) {
  if (which === 'night') nightSending = true;
  else discardSending = true;
  notify();
  rerender();
  try {
    await action();
  } catch (error) {
    notify(explain(error));
  } finally {
    if (which === 'night') nightSending = false;
    else discardSending = false;
    rerender();
  }
}

// 三個選項（豪賭附層數與每層的機率、獎勵；分贓；睡覺）與「送出」；選的值記在 nightPick，重畫時留著。送不出去就停用並寫原因。
function nightBox(me, state, game, sent) {
  const key = `${me.table}:${state.round}`;
  // 換了回合，或自己還沒動過時，跟著已送出的選擇（重新整理後自己的選擇可能晚一點才到）。
  if (nightPick?.key !== key || !nightPick.touched) nightPick = { key, choice: sent?.choice ?? null, tiers: sent?.tiers ?? 1, touched: false };
  const rules = nightRules();
  const box = element('div', 'night-box');
  const choices = element('p', 'night-choices');
  for (const choice of NIGHT_CHOICES) {
    const button = element('button', `night-choice${nightPick.choice === choice ? ' chosen' : ' quiet'}`, CHOICE_LABELS[choice]);
    button.type = 'button';
    button.dataset.choice = choice;
    button.setAttribute('aria-pressed', String(nightPick.choice === choice));
    button.addEventListener('click', () => {
      nightPick = { ...nightPick, choice, touched: true };
      rerender();
    });
    choices.append(button);
  }
  const select = element('select', 'night-tiers');
  for (let tiers = 1; tiers <= rules.bust.length; tiers += 1) {
    const option = element('option', '', `第 ${tiers} 層`);
    option.value = tiers;
    option.selected = nightPick.tiers === tiers;
    select.append(option);
  }
  select.disabled = nightPick.choice !== 'gamble';
  select.addEventListener('change', () => {
    nightPick = { ...nightPick, tiers: Number(select.value), touched: true };
    rerender();
  });
  const label = element('label', 'night-tiers-label', '豪賭最多賭到');
  label.append(select);
  const gamble = element('ul', 'night-tier-list');
  gamble.append(...tierTexts().map((text) => element('li', '', text)));
  box.append(
    choices,
    element('p', 'night-option', '豪賭：從第 1 層開始，每層擲一顆六面骰，過到選的那一層就收手拿走累積'),
    label,
    gamble,
    element('p', 'caption', `爆了累積歸零，另付 ${rules.medicalFee} 英鎊醫藥費（不夠就付到 0）`),
    element('p', 'night-option', `分贓：選分贓的人平分 ${rules.splitPounds} 英鎊（捨去）、每人記 ${rules.splitSin} 罪孽`),
    element('p', 'night-option', '睡覺：什麼都不發生'),
  );
  const pick = { table: me.table, round: state.round, choice: nightPick.choice, tiers: nightPick.choice === 'gamble' ? nightPick.tiers : null };
  const view = { table: me.table, round: state.round, phase: state.phase, seats: game.seats, night: game.night };
  const reason = nightPick.choice ? choiceProblem(view, session.uid, { ...pick, at: serverTime(session) }) : null;
  const send = element('button', 'night-send', sent ? '改成這個' : '送出');
  send.type = 'button';
  send.disabled = !nightPick.choice || Boolean(reason) || nightSending;
  send.addEventListener('click', () => sendNight(() => requestNight(session, code, pick), 'night'));
  box.append(send);
  if (reason) box.append(element('p', 'hand-problem', NIGHT_REASONS[reason] ?? reason));
  return box;
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

// 手牌超過上限時：要棄幾張、點牌挑選、「選好了」；已送出的挑選合法就寫「已選好」。黑夜期間（揭曉前後）都可以改。
function discardBox(me, state, ending) {
  const hand = mine.hand ?? [];
  const { settings } = cardData.data;
  const over = overLimit(hand, settings);
  if (over === 0) return [];
  // 這一回合黑夜結束就算分：終局不棄牌（棄牌在下一回合日出才做），照現在的手牌算。
  if (ending) return [element('p', 'caption discard-skip', `手牌 ${hand.length} 張超過上限，但這一回合結束就算分：不用棄牌，照現在的手牌算`)];
  const where = { table: me.table, round: state.round };
  const saved = myDiscard && String(myDiscard.table) === String(me.table) && myDiscard.round === state.round ? myDiscard : null;
  const problem = saved ? discardProblem(hand, saved, where, settings) : 'no-pick';
  const key = `${me.table}:${state.round}:${hand.join()}`;
  if (discardPick?.key !== key || !discardPick.touched) {
    discardPick = { key, indexes: problem === null ? handIndexes(hand, Object.values(saved.cards)) : [], touched: false };
  }
  const box = element('div', 'discard-box');
  box.append(
    element('h3', '', '手牌上限'),
    element('p', 'discard-need', `手牌 ${hand.length} 張，黑夜結束要棄到 ${settings.handLimit} 張：選 ${over} 張`),
  );
  if (problem === null) box.append(element('p', 'discard-state ready', `已選好：${Object.values(saved.cards).map(cardName).join('、')}（天亮前可以改）`));
  else if (saved) box.append(element('p', 'discard-state problem', `之前選的不能用（${DISCARD_REASONS[problem] ?? problem}），請重選`));
  else box.append(element('p', 'discard-state', '還沒選；沒選的話，天亮時隨機棄'));
  const list = element('ul', 'discard-list');
  hand.forEach((id, index) => {
    const chosen = discardPick.indexes.includes(index);
    const button = element('button', `discard-card${chosen ? ' chosen' : ' quiet'}`, `${chosen ? '✓ ' : ''}${cardName(id)}`);
    button.type = 'button';
    button.dataset.index = index;
    button.setAttribute('aria-pressed', String(chosen));
    button.addEventListener('click', () => {
      const indexes = chosen ? discardPick.indexes.filter((at) => at !== index) : [...discardPick.indexes, index];
      discardPick = { ...discardPick, indexes, touched: true };
      rerender();
    });
    const item = element('li', '');
    item.append(button);
    list.append(item);
  });
  const cards = [...discardPick.indexes].sort((a, b) => a - b).map((index) => hand[index]);
  const send = element('button', 'discard-send', `選好了（${cards.length}／${over}）`);
  send.type = 'button';
  send.disabled = cards.length !== over || discardSending;
  send.addEventListener('click', () => sendNight(() => requestDiscard(session, code, { ...where, cards }), 'discard'));
  box.append(list, send);
  return [box];
}

// 黑夜的那張卡：教學提示（第 1 回合）、已送出人數、提醒倒數、自己的選擇與選項、揭曉倒數、揭曉結果；手牌超過上限時的挑牌。
function nightCard(room, me, state, game) {
  const nodes = [element('h2', '', '黑夜：豪賭、分贓或睡覺')];
  if (state.round === 1) {
    for (const tip of cardData.data.tutorial ?? []) if (tip.phase === 'night') nodes.push(element('p', 'caption night-tip', `提示：${tip.text}`));
  }
  const stage = nightStage(game.night, state.round);
  const sent = myNight && String(myNight.table) === String(me.table) && myNight.round === state.round ? myNight : null;
  if (stage === 'none') {
    nodes.push(element('p', 'caption', '等主持端開始黑夜…'));
  } else if (stage === 'revealed') {
    nodes.push(...nightResultLines(room, game, game.night.result, session.uid));
    if (!sent) nodes.push(element('p', 'caption', '你沒有送出，算睡覺'));
  } else {
    const { night } = game;
    nodes.push(element('p', 'night-submitted', `已送出 ${night.submitted ?? 0}／${Object.keys(game.seats).length} 人`));
    nodes.push(stage === 'choosing' ? nightReminderLine(night) : nightRevealLine(night));
    if (sent) nodes.push(element('p', 'night-sent', `已送出：${choiceText(sent)}（揭曉前可以改）`));
    if (stage === 'choosing' || serverTime(session) < night.revealAt) nodes.push(nightBox(me, state, game, sent));
    else nodes.push(element('p', 'caption', sent ? '黑夜截止了，等揭曉' : '黑夜截止了，你沒有送出，算睡覺'));
  }
  return [...nodes, ...discardBox(me, state, endReasonNow(game, state) !== null)];
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
  // 黃昏，以及同一回合的黑夜（看得到這一回合的結果）。
  const dusk = state.phase === 'dusk' || (state.phase === 'night' && duskStage(game.dusk, state.round) !== 'none');
  $('player-dusk').hidden = !dusk;
  $('player-dusk').replaceChildren(...(dusk ? duskCard(room, me, state, game) : []));
  const night = state.phase === 'night';
  $('player-night').hidden = !night;
  $('player-night').replaceChildren(...(night ? nightCard(room, me, state, game) : []));
  $('player-hand-count').textContent = hand.length;
  $('player-hand').replaceChildren(...hand.map((id, index) => handItem(room, day, id, index)));
  const log = logList(room, game);
  $('player-log-card').hidden = !log;
  $('player-log').replaceChildren(...(log ? log.children : []));
  const events = eventLogItems(game);
  $('player-event-log-card').hidden = events.length === 0;
  $('player-event-log').replaceChildren(...events);
}

// 今日事件（日出到白晝結束）與這一回合觸發的迷霧事件，放在最上面，出牌時也看得到；底下寫自己現在的數字（事件結算後、之後的出牌也算進去）。
function renderEvents(game, state) {
  const seat = game?.seats?.[session.uid];
  const nodes = game && cardData ? eventsBlock(game, state) : [];
  if (nodes.length && seat) nodes.push(element('p', 'event-now caption', `你現在：英鎊 ${seat.pounds}・影響力 ${seat.influence}・迷霧值 ${state.fog}`));
  $('player-events').hidden = nodes.length === 0;
  $('player-events').replaceChildren(...nodes);
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

// 訂閱自己的票（送出後顯示「已送出：…」），做法同 watchMine。
function watchMyVote() {
  if (stopVote) return;
  let stopped = false;
  let stop = null;
  stopVote = () => {
    stopped = true;
    stop?.();
  };
  stop = watchVote(
    session,
    code,
    (value) => {
      myVote = value;
      rerender();
    },
    () => {},
  );
  if (stopped) stop();
}

// 訂閱自己的黑夜選擇與挑的棄牌（送出後顯示「已送出」「已選好」），做法同 watchMine。
function watchMyNight() {
  if (stopNight) return;
  let stopped = false;
  let stop = null;
  stopNight = () => {
    stopped = true;
    stop?.();
  };
  stop = watchNight(
    session,
    code,
    (value) => {
      myNight = value;
      rerender();
    },
    () => {},
  );
  if (stopped) stop();
}

function watchMyDiscard() {
  if (stopDiscard) return;
  let stopped = false;
  let stop = null;
  stopDiscard = () => {
    stopped = true;
    stop?.();
  };
  stop = watchDiscard(
    session,
    code,
    (value) => {
      myDiscard = value;
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
  watchMyVote();
  watchMyNight();
  watchMyDiscard();
  const state = room.tables[me.table];
  const game = room.games?.[me.table];
  $('player-stage').dataset.phase = state.phase;
  $('player-table').textContent = `第 ${me.table} 桌`;
  $('player-round').textContent = `第 ${state.round} 回合`;
  $('player-phase').textContent = PHASE_NAMES[state.phase] ?? state.phase;
  // 最後一回合的提示（日落鐘照伺服器時間算，到點時重畫）。
  $('player-last-round').hidden = endReasonNow(game, state) === null;
  if (state.phase !== 'end') wakeAtSunset(game);
  const ended = state.phase === 'end' && Boolean(game?.final) && Boolean(cardData);
  $('player-final').hidden = !ended;
  $('player-final').replaceChildren(...(ended ? finalCard(room, game) : []));
  $('player-destiny-private').hidden = state.phase === 'end'; // 終局後天命已經公開
  $('player-fog').textContent = state.fog;
  $('player-fog-meter').value = state.fog;
  $('player-fog-fired').textContent = firedText(game);
  renderEvents(game, state);
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
