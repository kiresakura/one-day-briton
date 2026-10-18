// 主持人控制台的判斷（play/js/ui/host-model.js）：日落鐘會不會被減到 0、復原能不能按、全場暫停中每個鐘是哪一種、全場暫停／恢復之後
// 結果條的字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { clockStartWrite } from '../../play/js/game.js';
import { PAUSE_NEAR_SUNSET_MS } from '../../play/js/store.js';
import {
  CLOCK_MARGIN_MS,
  clockUnderPause,
  heldByPause,
  manualPausedMatches,
  nearSunsetLine,
  nearSunsetMatches,
  pauseReport,
  undoWhy,
  zeroAfter,
} from '../../play/js/ui/host-model.js';

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

// 全場暫停：at 是暫停那一筆的時刻；clocks 是被它停住的場次。
const PAUSE = { on: true, seq: 1, at: NOW - 5_000, by: 'a', clocks: { 1: true } };
const held = (left) => ({ ...clock(left, { paused: true }), pausedAt: PAUSE.at });
const room = (clocks, pause = null) => ({ clock: clocks, display: pause ? { pause } : {} });

test('全場暫停中的鐘：被這次暫停停住、手動暫停的、快日落（不到 10 秒，照常日落）、沒被停住；沒有暫停或已經日落是 null', () => {
  assert.equal(PAUSE_NEAR_SUNSET_MS, 10_000);
  assert.equal(clockUnderPause(held(30 * MINUTE), PAUSE, '1', NOW), 'held');
  assert.equal(heldByPause(held(30 * MINUTE), PAUSE, 1), true);
  // 第 2 場不在 pause.clocks；第 1 場在，但停住的時刻不是暫停那一筆（暫停中被手動繼續又暫停）：都是手動暫停的。
  assert.equal(clockUnderPause(held(30 * MINUTE), PAUSE, '2', NOW), 'manual');
  assert.equal(clockUnderPause(clock(30 * MINUTE, { paused: true }), PAUSE, '1', NOW), 'manual');
  assert.equal(clockUnderPause(clock(PAUSE_NEAR_SUNSET_MS), PAUSE, '1', NOW), 'near');
  assert.equal(clockUnderPause(clock(PAUSE_NEAR_SUNSET_MS + 1), PAUSE, '1', NOW), 'free');
  assert.equal(clockUnderPause(clock(40 * MINUTE), PAUSE, '1', NOW), 'free');
  assert.equal(clockUnderPause(clock(0), PAUSE, '1', NOW), null);
  assert.equal(clockUnderPause(clock(40 * MINUTE), { ...PAUSE, on: false }, '1', NOW), null);
  assert.equal(clockUnderPause(clock(40 * MINUTE), null, '1', NOW), null);
  assert.equal(clockUnderPause(null, PAUSE, '1', NOW), null);
});

test('快日落的場次（全場暫停確認框先講）與手動暫停的場次（恢復確認框先講）', () => {
  assert.deepEqual(nearSunsetMatches(room({ 1: clock(8_000), 2: clock(30 * MINUTE) }), NOW), ['1']);
  assert.deepEqual(nearSunsetMatches(room({ 1: clock(8_000, { paused: true }), 2: clock(-1) }), NOW), []);
  assert.deepEqual(nearSunsetMatches(room({ 2: clock(10_000) }), NOW), ['2']);
  assert.equal(nearSunsetLine(['1']), '第 1 場日落鐘剩不到 10 秒：快日落・照常日落、不停（各桌這一回合結束後算分）');
  assert.deepEqual(manualPausedMatches(room({ 1: held(30 * MINUTE), 2: clock(20 * MINUTE, { paused: true }) }, PAUSE)), ['2']);
  assert.deepEqual(manualPausedMatches(room({ 1: clock(30 * MINUTE, { paused: true }) })), ['1']);
  assert.deepEqual(manualPausedMatches(room({ 1: clock(30 * MINUTE) })), []);
});

test('全場暫停之後的結果條：停住的、快日落照常日落（不叫人手動暫停）、沒停住的（可以手動暫停，恢復時不會自動繼續）', () => {
  const later = NOW + 300;
  assert.deepEqual(pauseReport(true, { changed: true, clocks: ['1'], nearSunset: [] }, room({ 1: clock(30 * MINUTE) }), null, later), {
    ok: true,
    warn: false,
    text: '全場暫停了；第 1 場日落鐘一起停住',
  });
  const near = pauseReport(true, { changed: true, clocks: [], nearSunset: ['1'] }, room({ 1: clock(8_000) }), null, later);
  assert.deepEqual(near, { ok: true, warn: true, text: '全場暫停了；第 1 場日落鐘快日落（不到 10 秒）・照常日落、不停：各桌這一回合結束後算分' });
  assert.doesNotMatch(near.text, /按暫停/);
  // 被拒後不帶鐘重送：遠的鐘沒停住。
  assert.deepEqual(pauseReport(true, { changed: true, clocks: [], nearSunset: [] }, room({ 1: clock(40 * MINUTE) }), null, later), {
    ok: true,
    warn: true,
    text: '全場暫停了；第 1 場日落鐘沒有停住：要停可以在日落鐘面板按暫停（全場恢復時不會自動繼續，要記得手動繼續）',
  });
  // 兩場：第 1 場快日落、第 2 場停住；本來就手動暫停的、寫完時已經日落的都不算沒停住。
  assert.equal(
    pauseReport(true, { changed: true, clocks: ['2'], nearSunset: ['1'] }, room({ 1: clock(8_000), 2: clock(50 * MINUTE) }), null, later).text,
    '全場暫停了；第 2 場日落鐘一起停住；第 1 場日落鐘快日落（不到 10 秒）・照常日落、不停：各桌這一回合結束後算分',
  );
  assert.deepEqual(pauseReport(true, { changed: true, clocks: [], nearSunset: [] }, room({ 1: clock(30 * MINUTE, { paused: true }), 2: clock(200) }), null, later), {
    ok: true,
    warn: false,
    text: '全場暫停了',
  });
  assert.deepEqual(pauseReport(true, { changed: false, clocks: [], nearSunset: [] }, room({}), null, later), { ok: true, warn: false, text: '本來就是全場暫停中' });
});

test('恢復全場之後的結果條：接著走的、沒跟著繼續的、還停著的手動暫停鐘要提醒', () => {
  const later = NOW + 300;
  const before = room({ 1: held(30 * MINUTE), 2: clock(20 * MINUTE, { paused: true }) }, PAUSE);
  assert.deepEqual(pauseReport(false, { changed: true, clocks: ['1'], nearSunset: [] }, before, before, later), {
    ok: true,
    warn: true,
    text: '恢復全場了；第 1 場日落鐘接著走；第 2 場日落鐘還在暫停（手動暫停的），要繼續請在日落鐘面板按繼續',
  });
  // 寫完之後別台已經把第 2 場按了繼續：不用提醒。
  const after = room({ 1: clock(30 * MINUTE), 2: clock(20 * MINUTE) });
  assert.deepEqual(pauseReport(false, { changed: true, clocks: ['1'], nearSunset: [] }, before, after, later), { ok: true, warn: false, text: '恢復全場了；第 1 場日落鐘接著走' });
  assert.deepEqual(pauseReport(false, { changed: true, clocks: [], nearSunset: [] }, room({ 1: held(30 * MINUTE) }, PAUSE), null, later), {
    ok: true,
    warn: true,
    text: '恢復全場了；第 1 場日落鐘沒有跟著繼續（暫停中被動過），要的話在日落鐘面板按繼續',
  });
  assert.deepEqual(pauseReport(false, { changed: false, clocks: [], nearSunset: [] }, before, before, later), { ok: true, warn: false, text: '本來就沒有全場暫停' });
});
