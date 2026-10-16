// 首頁：加入（房號分格輸入、暱稱、自己選桌）、主持端入口，以及備援主持申請的等待畫面。
import { MAX_SEATS } from '../game.js';
import {
  MAX_TABLES,
  NAME_MAX_LENGTH,
  ROOM_CODE_LENGTH,
  confirmCode,
  isRoomCode,
  isValidName,
  normalizeName,
  normalizeRoomCode,
} from '../rules.js';
import { $, h } from './dom.js';
import { ctx } from './state.js';

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

// 備援主持申請的等待畫面：確認碼與房號。
export function renderPending() {
  ctx.requested = true;
  $('pending-confirm').textContent = confirmCode(ctx.session.uid);
  $('pending-code').textContent = ctx.code;
}

