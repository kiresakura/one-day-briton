// 畫面的就地更新（play/js/ui/dom.js 的 patchChildren）：陣列裡有 null／undefined／false 時略過、不丟錯，照 data-key 與順序沿用舊節點。
// Node 裡沒有 DOM，這裡給一個只夠 patchChildren 用的最小替身（元素、文字、屬性、插入與移除）。
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  static ELEMENT_NODE = 1;
  static TEXT_NODE = 3;
  constructor(nodeType, nodeName) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
  }
  remove() {
    if (!this.parentNode) return;
    const kids = this.parentNode.kids;
    kids.splice(kids.indexOf(this), 1);
    this.parentNode = null;
  }
}

class FakeText extends FakeNode {
  constructor(text) {
    super(FakeNode.TEXT_NODE, '#text');
    this.nodeValue = text;
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super(FakeNode.ELEMENT_NODE, tag.toUpperCase());
    this.tagName = this.nodeName;
    this.kids = [];
    this.attrs = new Map();
  }
  get childNodes() {
    return [...this.kids];
  }
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  removeAttribute(name) {
    this.attrs.delete(name);
  }
  insertBefore(node, ref) {
    node.remove();
    const index = ref ? this.kids.indexOf(ref) : -1;
    if (index < 0) this.kids.push(node);
    else this.kids.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
}

// dom.js 載入時在 document、window 上掛監聽，元素判斷用全域的 Node。
globalThis.Node ??= FakeNode;
globalThis.document ??= { addEventListener() {} };
globalThis.window ??= { addEventListener() {} };
const { patchChildren } = await import('../../play/js/ui/dom.js');

// el('p', { 'data-key': 'a' }, '文字', el(...))
function el(tag, attrs = {}, ...children) {
  const node = new FakeElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const child of children) node.insertBefore(typeof child === 'string' ? new FakeText(child) : child, null);
  return node;
}
const texts = (parent) => parent.childNodes.map((node) => node.childNodes.map((kid) => kid.nodeValue).join(''));

test('patchChildren：陣列裡的 null／undefined／false 略過，不丟錯，其餘照順序放進去', () => {
  const parent = el('div');
  assert.doesNotThrow(() => patchChildren(parent, [null, el('p', {}, '甲'), undefined, false, el('p', {}, '乙'), null]));
  assert.deepEqual(texts(parent), ['甲', '乙']);
  // 整個陣列只有空位：清空，不丟錯
  assert.doesNotThrow(() => patchChildren(parent, [null, undefined, false]));
  assert.equal(parent.childNodes.length, 0);
  // 已經蓋著的層再畫一次、少了一格（例如廣播收回）時照樣更新
  const layer = el('section');
  patchChildren(layer, [el('h2', { 'data-key': 'title' }, '全場暫停'), el('p', { 'data-key': 'cast' }, '請先停下來'), el('p', { 'data-key': 'conn' }, '已連線')]);
  const [title, , conn] = layer.childNodes;
  assert.doesNotThrow(() => patchChildren(layer, [el('h2', { 'data-key': 'title' }, '全場暫停'), null, el('p', { 'data-key': 'conn' }, '已連線')]));
  assert.deepEqual(layer.childNodes, [title, conn]);
});

test('patchChildren：有 data-key 的照 key 沿用舊節點（換順序、中間有空位也一樣），屬性與文字就地改', () => {
  const parent = el('div');
  patchChildren(parent, [el('p', { 'data-key': 'a', class: 'one' }, '一'), el('p', { 'data-key': 'b' }, '二')]);
  const [a, b] = parent.childNodes;
  patchChildren(parent, [null, el('p', { 'data-key': 'b', class: 'moved' }, '二改'), false, el('p', { 'data-key': 'a' }, '一'), undefined]);
  assert.equal(parent.childNodes.length, 2);
  assert.equal(parent.childNodes[0], b);
  assert.equal(parent.childNodes[1], a);
  assert.equal(b.getAttribute('class'), 'moved');
  assert.equal(a.hasAttribute('class'), false);
  assert.deepEqual(texts(parent), ['二改', '一']);
  // key 不在新陣列裡的舊節點拿掉
  patchChildren(parent, [el('p', { 'data-key': 'a' }, '一')]);
  assert.deepEqual(parent.childNodes, [a]);
  assert.equal(b.parentNode, null);
});

test('patchChildren：沒有 key 的照順序對，空位不佔順序（後面的節點照樣對到原本那一個）', () => {
  const parent = el('div');
  patchChildren(parent, [el('p', {}, '甲'), el('span', {}, '乙')]);
  const [p, span] = parent.childNodes;
  patchChildren(parent, [null, el('p', {}, '甲改'), false, el('span', {}, '乙改')]);
  assert.deepEqual(parent.childNodes, [p, span]);
  assert.deepEqual(texts(parent), ['甲改', '乙改']);
  // 標籤不同就換新節點
  patchChildren(parent, [el('div', {}, '丙'), undefined, el('span', {}, '乙')]);
  assert.notEqual(parent.childNodes[0], p);
  assert.equal(parent.childNodes[1], span);
  assert.equal(p.parentNode, null);
});
