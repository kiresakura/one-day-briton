// 首頁：加入（房號分格輸入、暱稱、自己選桌）、主持端入口，以及備援主持申請的等待畫面。
// 全場廣播條（主持端送的 display/broadcast）也在這裡：玩家畫面（player.js）與等待核准畫面共用。
import { MAX_SEATS } from '../game.js';
import {
  MAX_TABLES,
  NAME_MAX_LENGTH,
  ROOM_CODE_LENGTH,
  confirmCode,
  isRoomCode,
  isValidBroadcast,
  isValidName,
  normalizeName,
  normalizeRoomCode,
} from '../rules.js';
import { $, h, patchChildren } from './dom.js';
import { ctx, rerender } from './state.js';

// 加入頁下方的重連說明（照實測：同一個瀏覽器重新整理或關掉分頁再開同一個網址，都會回到同一桌、同一個座位）。
export const REJOIN_TEXT = '斷線或關掉網頁時，用同一支手機的同一個瀏覽器重新打開這個網址，會自動回到同一桌、同一個座位（無痕視窗或換瀏覽器就回不去）';

function codeValue() {
  return normalizeRoomCode($('join-code').value).slice(0, ROOM_CODE_LENGTH);
}

function tableValue() {
  return Number(document.querySelector('input[name="join-table"]:checked')?.value ?? 1);
}

// 「加入」不能按的原因（可以按是 null）；原因直接當成按鈕文字。檢查的是送出時一定會被擋下的情況。
function joinProblem() {
  const code = codeValue();
  if (code.length < ROOM_CODE_LENGTH) return `再輸入 ${ROOM_CODE_LENGTH - code.length} 碼才能加入`;
  if (!isRoomCode(code)) return '房號裡沒有 0、O、1、I、L，請再對一次';
  const name = normalizeName($('join-name').value);
  if (!name) return '輸入名字才能加入';
  if (!isValidName(name)) return `名字最多 ${NAME_MAX_LENGTH} 個字`;
  return null;
}

export function updateJoin() {
  const code = codeValue();
  const cells = $('join-code-cells').querySelectorAll('.code-cell');
  cells.forEach((cell, index) => {
    cell.textContent = code[index] ?? (index === code.length ? '_' : '');
    cell.classList.toggle('is-next', index === code.length);
  });
  const problem = joinProblem();
  $('join-submit').disabled = Boolean(problem);
  $('join-submit').textContent = problem ?? '加入';
  $('join-table-picked').textContent = `第 ${tableValue()} 桌`;
}

export function joinValues() {
  return { code: codeValue(), name: $('join-name').value, table: tableValue() };
}

export function setupHome() {
  const input = $('join-code');
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    $('join-code-cells').insertBefore(h('span', { class: 'code-cell', attrs: { 'aria-hidden': 'true' } }), input);
  }
  $('join-code-hint').textContent = `主持人投影上的 ${ROOM_CODE_LENGTH} 碼房號，英文不分大小寫`;
  // 貼上整串（含空白、小寫）也可以：去掉空白、轉大寫、只留前幾碼。
  input.addEventListener('input', () => {
    const code = codeValue();
    if (input.value !== code) input.value = code;
    updateJoin();
  });
  $('join-name').maxLength = NAME_MAX_LENGTH;
  $('join-name-hint').textContent = `同桌玩家看得到，最多 ${NAME_MAX_LENGTH} 個字`;
  $('join-name').addEventListener('input', updateJoin);
  for (let table = 1; table <= MAX_TABLES; table += 1) {
    const option = h(
      'label',
      { class: 'table-option' },
      h('input', { type: 'radio', attrs: { name: 'join-table', 'aria-label': `第 ${table} 桌` }, value: String(table), checked: table === 1 }),
      h('span', { class: 'num', text: table, attrs: { 'aria-hidden': 'true' } }),
    );
    $('join-table').append(option);
  }
  $('join-table').addEventListener('change', updateJoin);
  $('join-table-hint').textContent = `選你實際坐的那一桌，每桌最多 ${MAX_SEATS} 人`;
  $('join-foot').textContent = REJOIN_TEXT;
  updateJoin();
}

// 備援主持申請的等待畫面：確認碼與房號，最上面是全場廣播條（房間資料是 app.js 剛收到的那一筆 ctx.latestRoom）。
export function renderPending() {
  ctx.requested = true;
  $('pending-confirm').textContent = confirmCode(ctx.session.uid);
  $('pending-code').textContent = ctx.code;
  const slot = pendingSlot();
  const nodes = broadcastNodes(ctx.latestRoom?.display, ctx.code);
  slot.hidden = nodes.length === 0;
  patchChildren(slot, nodes);
}

function pendingSlot() {
  let slot = $('pending-broadcast');
  if (slot) return slot;
  slot = h('div', { class: 'broadcast-slot', attrs: { id: 'pending-broadcast', role: 'status' }, hidden: true });
  slot.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act="broadcast-ok"]');
    if (!button) return;
    dismissBroadcast(ctx.code, Number(button.dataset.seq));
    rerender();
  });
  $('screen-pending').prepend(slot);
  return slot;
}

// ---- 全場廣播條 ----

// 按「知道了」收起的那一則記在這台裝置：{ code: 房號, seq }。只收起自己這支；主持端送新的一則（seq 變大）時再出現。
const BROADCAST_SEEN_KEY = 'one-day-briton:broadcast-seen';
let seenInPage = null; // 存不進 localStorage 時（例如瀏覽器不准）只記在這一頁

// 目前那一則廣播 { text, seq }：沒有、已經收回（hidden）或格式不對是 null。暫停層也用它顯示廣播的字（不管這台收起了沒）。
export function broadcastOf(display) {
  const cast = display?.broadcast;
  if (!cast || typeof cast !== 'object' || cast.hidden === true || !isValidBroadcast(cast.text) || !Number.isInteger(cast.seq)) return null;
  return { text: cast.text, seq: cast.seq };
}

// 存著的字串（localStorage 裡的 { code, seq }）裡，這間房收起到第幾則；沒有、別間房或讀不懂是 0。
export function seenSeqOf(stored, code) {
  try {
    const value = JSON.parse(stored);
    return value?.code === code && Number.isInteger(value.seq) ? value.seq : 0;
  } catch {
    return 0;
  }
}

// 要不要放廣播條：有一則，而且比這台收起的那一則新。要放回傳那一則，不放是 null。
export function shownBroadcast(display, seenSeq) {
  const cast = broadcastOf(display);
  return cast && cast.seq > seenSeq ? cast : null;
}

function seenSeq(code) {
  let stored = null;
  try {
    stored = localStorage.getItem(BROADCAST_SEEN_KEY);
  } catch {
    // 讀不到就只看這一頁記的
  }
  return Math.max(seenSeqOf(stored, code), seenSeqOf(seenInPage, code));
}

// 「知道了」：記下這間房收起到第 seq 則。
export function dismissBroadcast(code, seq) {
  if (!code || !Number.isInteger(seq)) return;
  seenInPage = JSON.stringify({ code, seq });
  try {
    localStorage.setItem(BROADCAST_SEEN_KEY, seenInPage);
  } catch {
    // 存不進去就只記在這一頁
  }
}

// 廣播條（放進各畫面最上面的容器，容器自己帶 role="status"）：「廣播」標籤、內容、「知道了」。不用放時是空陣列。
// 「知道了」是 data-act="broadcast-ok"、data-seq＝那一則的 seq，按下時由各畫面呼叫 dismissBroadcast 再重畫。
export function broadcastNodes(display, code) {
  const cast = shownBroadcast(display, seenSeq(code));
  if (!cast) return [];
  return [
    h(
      'div',
      { class: 'broadcast', data: { key: 'broadcast' } },
      h('span', { class: 'broadcast-tag', text: '廣播' }),
      h('p', { class: 'broadcast-text', text: cast.text }),
      h('button', { class: 'broadcast-ok', type: 'button', data: { act: 'broadcast-ok', seq: cast.seq }, text: '知道了' }),
    ),
  ];
}

