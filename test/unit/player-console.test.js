// 玩家端接上主持人控制台：全場廣播條要不要顯示（js/ui/home.js 的純函式；玩家畫面與等待核准畫面共用）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BROADCAST_MAX_LENGTH } from '../../play/js/rules.js';

// home.js 連帶載入 dom.js，dom.js 載入時在 document、window 上掛點擊與捲動的監聽；Node 裡沒有這兩個，給最小的替身。
globalThis.document ??= { addEventListener() {} };
globalThis.window ??= { addEventListener() {} };
const { broadcastOf, seenSeqOf, shownBroadcast } = await import('../../play/js/ui/home.js');

const CODE = 'K7Q2MX';
const cast = (fields = {}) => ({ broadcast: { text: '十分鐘後開始第 2 場', seq: 3, at: 1_000, by: 'host', ...fields } });

test('broadcastOf：目前那一則的字與 seq；沒有、收回了、格式不對都是 null', () => {
  assert.deepEqual(broadcastOf(cast()), { text: '十分鐘後開始第 2 場', seq: 3 });
  assert.deepEqual(broadcastOf(cast({ text: '字'.repeat(BROADCAST_MAX_LENGTH) })), { text: '字'.repeat(BROADCAST_MAX_LENGTH), seq: 3 });
  // 舊房間（沒有 display）、還沒廣播過
  assert.equal(broadcastOf(undefined), null);
  assert.equal(broadcastOf(null), null);
  assert.equal(broadcastOf({}), null);
  assert.equal(broadcastOf({ pause: { on: true, seq: 1 } }), null);
  // 收回＝同一則加 hidden: true
  assert.equal(broadcastOf(cast({ hidden: true, seq: 4 })), null);
  // 規則擋得掉的格式，讀到了也不顯示
  assert.equal(broadcastOf(cast({ text: '' })), null);
  assert.equal(broadcastOf(cast({ text: ' 前後有空白 ' })), null);
  assert.equal(broadcastOf(cast({ text: '字'.repeat(BROADCAST_MAX_LENGTH + 1) })), null);
  assert.equal(broadcastOf(cast({ text: 12 })), null);
  assert.equal(broadcastOf(cast({ seq: '3' })), null);
  assert.equal(broadcastOf(cast({ seq: undefined })), null);
  assert.equal(broadcastOf({ broadcast: '請回座位' }), null);
  // hidden 只有 true 算收回
  assert.deepEqual(broadcastOf(cast({ hidden: false })), { text: '十分鐘後開始第 2 場', seq: 3 });
});

test('seenSeqOf：這台裝置在這間房收起到第幾則；沒有、別間房、讀不懂都是 0', () => {
  assert.equal(seenSeqOf(JSON.stringify({ code: CODE, seq: 5 }), CODE), 5);
  assert.equal(seenSeqOf(JSON.stringify({ code: 'AB3CDE', seq: 5 }), CODE), 0);
  assert.equal(seenSeqOf(null, CODE), 0);
  assert.equal(seenSeqOf(undefined, CODE), 0);
  assert.equal(seenSeqOf('', CODE), 0);
  assert.equal(seenSeqOf('{', CODE), 0);
  assert.equal(seenSeqOf('null', CODE), 0);
  assert.equal(seenSeqOf('7', CODE), 0);
  assert.equal(seenSeqOf(JSON.stringify({ code: CODE, seq: '5' }), CODE), 0);
  assert.equal(seenSeqOf(JSON.stringify({ code: CODE, seq: 2.5 }), CODE), 0);
  assert.equal(seenSeqOf(JSON.stringify({ seq: 5 }), CODE), 0);
});

test('shownBroadcast：比收起的那一則新才顯示；知道了之後收起，新的一則（seq 變大）再出現，收回後拿掉', () => {
  // 第一次看到
  assert.deepEqual(shownBroadcast(cast(), 0), { text: '十分鐘後開始第 2 場', seq: 3 });
  // 按了「知道了」（記下 seq 3）：同一則不再出現
  assert.equal(shownBroadcast(cast(), 3), null);
  // 主持端送了新的一則
  assert.deepEqual(shownBroadcast(cast({ text: '請回到座位', seq: 4 }), 3), { text: '請回到座位', seq: 4 });
  // 沒按「知道了」、主持端收回：拿掉
  assert.equal(shownBroadcast(cast({ hidden: true, seq: 4 }), 0), null);
  // 收回之後又送新的一則：再出現
  assert.deepEqual(shownBroadcast(cast({ text: '五分鐘後日落', seq: 5 }), 3), { text: '五分鐘後日落', seq: 5 });
  // 存著的比較新（別的分頁已經收起更新的一則）：不顯示
  assert.equal(shownBroadcast(cast(), 9), null);
  // 舊房間
  assert.equal(shownBroadcast(undefined, 0), null);
});
