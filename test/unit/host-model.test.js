// 主持人控制台的判斷（play/js/ui/host-model.js）：日落鐘會不會被減到 0、復原能不能按。
import test from 'node:test';
import assert from 'node:assert/strict';
import { clockStartWrite } from '../../play/js/game.js';
import { CLOCK_MARGIN_MS, undoWhy, zeroAfter } from '../../play/js/ui/host-model.js';

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

// 全場鐘：剩 left 毫秒（照 NOW 算）；paused 時在 NOW 暫停；adjust 是累計加減。
function clock(left, { paused = false, adjust = 0, seq = 3 } = {}) {
  const anchor = NOW - 20 * MINUTE;
  const record = { ...clockStartWrite(75, NOW - 50 * MINUTE), anchor, remain: left + (NOW - anchor), adjust, seq };
  if (paused) record.pausedAt = NOW;
  return record;
}

test('減到 0：走著的鐘照 store 的 1.5 秒餘裕算（剩 40 秒復原 −1 分、剩 61 秒 −1 分、剩 60–61.5 秒都會）', () => {
  assert.equal(CLOCK_MARGIN_MS, 1500);
  assert.equal(zeroAfter(clock(40_000), -MINUTE, NOW), true); // 「＋1」之後剩 40 秒按「復原」
  assert.equal(zeroAfter(clock(61_000), -MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(60_000), -MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(61_500), -MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(61_501), -MINUTE, NOW), false);
  assert.equal(zeroAfter(clock(62_000), -MINUTE, NOW), false);
  assert.equal(zeroAfter(clock(301_000), -5 * MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(302_000), -5 * MINUTE, NOW), false);
});

test('減到 0：暫停中照現在算，剛好等於也會；加的、沒有鐘的不會', () => {
  assert.equal(zeroAfter(clock(MINUTE, { paused: true }), -MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(MINUTE + 1, { paused: true }), -MINUTE, NOW), false);
  assert.equal(zeroAfter(clock(10_000, { paused: true }), -MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(10_000), MINUTE, NOW), false);
  assert.equal(zeroAfter(null, -MINUTE, NOW), false);
});

test('減到 0：累計上限讓它減不到 0 時不算；已經日落（照 store 的餘裕）的不算，store 會拒絕', () => {
  // 累計已經 −29 分 30 秒：這一次最多再減 30 秒，剩 50 秒減不到 0。
  assert.equal(zeroAfter(clock(50_000, { adjust: -(29 * MINUTE + 30_000) }), -MINUTE, NOW), false);
  assert.equal(zeroAfter(clock(20_000, { adjust: -(29 * MINUTE + 30_000) }), -MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(-1_000), -MINUTE, NOW), false);
  assert.equal(zeroAfter(clock(1_000), -MINUTE, NOW), false);
  assert.equal(zeroAfter(clock(0, { paused: true }), -MINUTE, NOW), false);
});

test('復原：已經日落就停用並寫原因；沒有鐘也停用；其他可以按', () => {
  assert.equal(undoWhy(clock(40_000), NOW), null);
  assert.equal(undoWhy(clock(40_000, { paused: true }), NOW), null);
  assert.equal(undoWhy(clock(-1), NOW), '已經日落了，不能復原');
  assert.equal(undoWhy(clock(0), NOW), '已經日落了，不能復原');
  assert.equal(undoWhy(clock(0, { paused: true }), NOW), '已經日落了，不能復原');
  assert.equal(undoWhy(undefined, NOW), '這一場沒有全場日落鐘');
});
