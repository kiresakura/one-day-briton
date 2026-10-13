// 畫面與事件：首頁、等待核准、主持端、玩家端幾個畫面切換。資料一律從 store.js 的訂閱來。
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
  rejectHost,
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
let requested = false; // 這台裝置送過主持端申請、還在等核准

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

function goHome(message = '') {
  stopWatching?.();
  stopWatching = null;
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

function renderHost(room) {
  requested = false;
  const roomCode = code;
  const cards = [];
  for (let table = 1; table <= room.meta.tableCount; table += 1) {
    const state = room.tables?.[table];
    if (!state) continue;
    const names = playersAt(room, table).map(([, player]) => player.name);

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
    // 帶著畫面上這一刻的回合與階段去推進；資料庫已經不一樣就不會動。
    next.addEventListener('click', () =>
      run(next, () => advanceTable(session, roomCode, table, { round: state.round, phase: state.phase })),
    );
    card.append(
      element('h2', '', `第 ${table} 桌`),
      status,
      element('p', 'table-players', names.length ? names.join('、') : '還沒有玩家'),
      next,
    );
    cards.push(card);
  }
  $('host-code').textContent = roomCode;
  $('host-tables').replaceChildren(...cards);
  const requests = requestItems(room, roomCode);
  $('host-count').textContent = `目前主持端 ${hostUids(room).length} 台${requests.length ? '，待核准的申請：' : ''}`;
  $('host-requests').replaceChildren(...requests);
  show('host');
}

function renderPlayer(room, me) {
  const state = room.tables[me.table];
  $('player-stage').dataset.phase = state.phase;
  $('player-table').textContent = `第 ${me.table} 桌`;
  $('player-round').textContent = `第 ${state.round} 回合`;
  $('player-phase').textContent = PHASE_LABELS[state.phase];
  $('player-fog').textContent = state.fog;
  $('player-fog-meter').value = state.fog;
  $('player-mates').replaceChildren(
    ...playersAt(room, me.table).map(([uid, player]) =>
      uid === session.uid ? element('li', 'me', `${player.name}（你）`) : element('li', '', player.name),
    ),
  );
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

try {
  session = await connect(slot);
  const saved = localStorage.getItem(savedRoomKey);
  if (isRoomCode(saved)) enterRoom(saved);
  else show('home');
} catch {
  notify('連不上遊戲伺服器，請確認網路後重新整理頁面');
}
