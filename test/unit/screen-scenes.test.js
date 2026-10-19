// 投影的元件（play/js/ui/screen-scenes.js）裡不碰畫面的部分：桌牌狀態那一行怎麼切段（statusParts）。h() 只用到 document.createElement，
// dom.js 載入時在 document、window 上掛監聽：這裡先放最小的替身再載入。
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= {
  addEventListener() {},
  createElement: (tag) => ({ tagName: String(tag).toUpperCase(), className: '', textContent: '', dataset: {}, style: { setProperty() {} }, setAttribute() {}, append() {} }),
};
globalThis.window ??= { addEventListener() {} };
const { statusParts } = await import('../../play/js/ui/screen-scenes.js');

const texts = (parts) => parts.map((part) => part.textContent);
const keeps = (parts) => parts.map((part) => part.className.split(' ').includes('is-keep'));

test('桌牌狀態那一行：〈牌名〉自己一段（不從牌名中間換行），在「・」之後換段', () => {
  const parts = statusParts('白晝：阿明打出〈盧德分子的大鐵鎚〉・輪到小華');
  assert.deepEqual(texts(parts), ['白晝：阿明打出', '〈盧德分子的大鐵鎚〉・', '輪到小華']);
  assert.deepEqual(keeps(parts), [true, true, true]);
  assert.ok(parts.every((part) => part.tagName === 'SPAN' && part.className.startsWith('projector-card-part')));
  // 牌名在最前面或最後面也一樣
  assert.deepEqual(texts(statusParts('〈盧德分子的大鐵鎚〉被響應')), ['〈盧德分子的大鐵鎚〉被響應']);
  assert.deepEqual(texts(statusParts('響應：小華打出〈盧德分子的大鐵鎚〉')), ['響應：小華打出', '〈盧德分子的大鐵鎚〉']);
});

test('桌牌狀態那一行：「・」分開的短段各自一段；超過 12 字的段照常換行（不標 is-keep）', () => {
  const parts = statusParts('黑夜揭曉：2 人豪賭・2 人分贓・2 人睡覺');
  assert.deepEqual(texts(parts), ['黑夜揭曉：2 人豪賭・', '2 人分贓・', '2 人睡覺']);
  assert.deepEqual(keeps(parts), [true, true, true]);
  const long = statusParts('白晝：輪到第三位玩家出牌或結束這一輪');
  assert.deepEqual(texts(long), ['白晝：輪到第三位玩家出牌或結束這一輪']);
  assert.deepEqual(keeps(long), [false]);
});
