// DOM 小工具：建立元素、比對後就地更新（重畫時不打斷操作），以及截斷文字點一下看全文的彈出框。

export const $ = (id) => document.getElementById(id);

// 暱稱是玩家輸入的文字，一律用 textContent 放進畫面。
export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// h('div', { class, text, data: {…}, attrs: {…}, style: {…}, hidden, disabled }, ...子節點)。子節點可以是節點、字串、陣列，
// null／false 略過。
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  const { class: className, text, data, attrs, style, hidden, disabled, type, value, checked, selected, html, ...rest } = props ?? {};
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (data) for (const [key, val] of Object.entries(data)) if (val !== undefined && val !== null) node.dataset[key] = String(val);
  if (attrs) for (const [key, val] of Object.entries(attrs)) if (val !== undefined && val !== null && val !== false) node.setAttribute(key, val === true ? '' : String(val));
  if (style) for (const [key, val] of Object.entries(style)) node.style.setProperty(key, String(val));
  if (hidden) node.hidden = true;
  if (disabled) node.disabled = true;
  if (type) node.type = type;
  if (value !== undefined) node.value = value;
  if (checked) node.checked = true;
  if (selected) node.selected = true;
  if (Object.keys(rest).length) throw new Error(`h(): unknown props ${Object.keys(rest).join(',')}`);
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else node.append(child instanceof Node ? child : String(child));
  }
}

// 把 parent 的子節點更新成 next（節點陣列）：有 data-key 的照 key 對、沒有的照順序對；對到同樣標籤的節點就地改屬性與文字，
// 不換掉。這樣別人的動作觸發重畫時，捲動位置、焦點、打開中的下拉選單、選取的牌都不會被打斷。
export function patchChildren(parent, next) {
  const old = [...parent.childNodes];
  const byKey = new Map();
  const unkeyed = [];
  for (const node of old) {
    const key = keyOf(node);
    if (key !== null && !byKey.has(key)) byKey.set(key, node);
    else unkeyed.push(node);
  }
  let cursor = 0;
  const pairs = next.map((node) => {
    const key = keyOf(node);
    let match = null;
    if (key !== null) {
      const candidate = byKey.get(key);
      if (candidate && sameKind(candidate, node)) {
        match = candidate;
        byKey.delete(key);
      }
    } else {
      const candidate = unkeyed[cursor];
      cursor += 1;
      if (candidate && sameKind(candidate, node)) match = candidate;
    }
    return [node, match];
  });
  // 先拿掉用不到的舊節點，留下來的舊節點相對順序不變，新節點插在它們前後，不用搬動（搬動會讓捲動位置歸零）。
  const reused = new Set(pairs.map(([, match]) => match).filter(Boolean));
  for (const node of old) if (!reused.has(node)) node.remove();
  pairs.forEach(([node, match], index) => {
    const at = parent.childNodes[index] ?? null;
    if (match) {
      patchNode(match, node);
      if (match !== at) parent.insertBefore(match, at);
    } else {
      parent.insertBefore(node, at);
    }
  });
}

function keyOf(node) {
  return node.nodeType === Node.ELEMENT_NODE && node.hasAttribute('data-key') ? node.getAttribute('data-key') : null;
}

function sameKind(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  if (a.nodeType !== Node.ELEMENT_NODE) return true;
  return (a.getAttribute('data-key') ?? '') === (b.getAttribute('data-key') ?? '') && (a.getAttribute('type') ?? '') === (b.getAttribute('type') ?? '');
}

function patchNode(old, node) {
  if (old.nodeType !== Node.ELEMENT_NODE) {
    if (old.nodeValue !== node.nodeValue) old.nodeValue = node.nodeValue;
    return;
  }
  for (const { name } of [...old.attributes]) if (!node.hasAttribute(name)) old.removeAttribute(name);
  for (const { name, value } of [...node.attributes]) if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  patchChildren(old, [...node.childNodes]);
  // 表單的值不是屬性，另外對。
  if (old.tagName === 'SELECT' && old.value !== node.value) old.value = node.value;
  if (old.tagName === 'INPUT') {
    if (old.value !== node.value) old.value = node.value;
    if (old.checked !== node.checked) old.checked = node.checked;
  }
}

// ---- 被截斷的文字：只有真的被截斷時才加點線底線；點一下彈出全文，點其他地方關閉（不靠滑鼠移過） ----

let popover = null;

function closePopover() {
  popover?.remove();
  popover = null;
}

// 檢查 root 底下的 .trunc 有沒有被截斷，有的加上 is-truncated 與可以按的標示。
export function markTruncated(root) {
  for (const node of root.querySelectorAll('.trunc')) {
    const cut = node.scrollWidth > node.clientWidth + 1;
    node.classList.toggle('is-truncated', cut);
    if (cut) {
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
    } else {
      node.removeAttribute('role');
      node.removeAttribute('tabindex');
    }
  }
}

function openPopover(node) {
  closePopover();
  popover = element('div', 'popover');
  popover.setAttribute('role', 'dialog');
  popover.append(element('p', 'popover-text', node.dataset.full || node.textContent), element('p', 'popover-hint', '點其他地方關閉'));
  document.body.append(popover);
  const rect = node.getBoundingClientRect();
  const width = popover.offsetWidth;
  popover.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
  popover.style.top = `${rect.bottom + 6}px`;
}

document.addEventListener('click', (event) => {
  const node = event.target.closest?.('.trunc.is-truncated');
  if (node) {
    event.preventDefault();
    openPopover(node);
  } else if (!event.target.closest?.('.popover')) {
    closePopover();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePopover();
  const node = event.target.closest?.('.trunc.is-truncated');
  if (node && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    openPopover(node);
  }
});

window.addEventListener('scroll', closePopover, { passive: true });
