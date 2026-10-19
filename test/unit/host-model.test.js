// 主持人控制台的判斷（play/js/ui/host-model.js）：日落鐘會不會被減到 0、復原能不能按、全場暫停中每個鐘是哪一種、全場暫停／恢復之後
// 結果條的字、確認框打開後局面變了沒、全場動作與全場暫停中每桌按鈕的停用原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import { clockStartWrite } from '../../play/js/game.js';
import { CLOCK_MARGIN_MS, PAUSE_NEAR_SUNSET_MS } from '../../play/js/store.js';
import {
  OFFLINE_TEXT,
  PAUSED_TEXT,
  actionWhy,
  clockPauseState,
  heldByPause,
  leftAfter,
  manualPausedMatches,
  nearSunsetLine,
  nearSunsetMatches,
  nextWakeAt,
  pauseReport,
  pausedWhy,
  planSignature,
  stepPlan,
  toggleDialogLines,
  undoPlan,
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

test('減到快 0：走著的鐘減完照這台的時間剩不到 10 秒就確認（剩 40 秒復原、剩 60–70 秒 −1 分、剩 302–310 秒 −5 分都會）', () => {
  assert.equal(CLOCK_MARGIN_MS, 1500);
  assert.equal(PAUSE_NEAR_SUNSET_MS, 10_000);
  assert.equal(zeroAfter(clock(40_000), -MINUTE, NOW), true); // 「＋1」之後剩 40 秒按「復原」
  assert.equal(zeroAfter(clock(60_000), -MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(61_000), -MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(61_501), -MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(62_000), -MINUTE, NOW), true); // 減完剩 2 秒（以前不確認）
  assert.equal(zeroAfter(clock(65_000), -MINUTE, NOW), true); // 剩 5 秒
  assert.equal(zeroAfter(clock(70_000), -MINUTE, NOW), true); // 剛好剩 10 秒
  assert.equal(zeroAfter(clock(70_001), -MINUTE, NOW), false);
  assert.equal(zeroAfter(clock(71_000), -MINUTE, NOW), false);
  assert.equal(zeroAfter(clock(302_000), -5 * MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(310_000), -5 * MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(310_001), -5 * MINUTE, NOW), false);
});

test('減完剩多少：照這台的時間；走著的鐘減到底時 store 照「現在＋1.5 秒」夾，所以還剩約 1.5 秒；不是減、已經日落的是 null', () => {
  assert.equal(leftAfter(clock(62_000), -MINUTE, NOW), 2_000);
  assert.equal(leftAfter(clock(65_000), -MINUTE, NOW), 5_000);
  assert.equal(leftAfter(clock(70_000), -MINUTE, NOW), 10_000);
  assert.equal(leftAfter(clock(40_000), -MINUTE, NOW), CLOCK_MARGIN_MS);
  assert.equal(leftAfter(clock(40_000, { paused: true }), -MINUTE, NOW), 0);
  assert.equal(leftAfter(clock(65_000, { paused: true }), -MINUTE, NOW), 5_000);
  assert.equal(leftAfter(clock(65_000), MINUTE, NOW), null);
  assert.equal(leftAfter(clock(1_000), -MINUTE, NOW), null);
  assert.equal(leftAfter(null, -MINUTE, NOW), null);
});

test('減到 0：暫停中照現在算，剛好減到 0 才會（剩幾秒不算，暫停中還加得回來）；加的、沒有鐘的不會', () => {
  assert.equal(zeroAfter(clock(MINUTE, { paused: true }), -MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(MINUTE + 1, { paused: true }), -MINUTE, NOW), false);
  assert.equal(zeroAfter(clock(62_000, { paused: true }), -MINUTE, NOW), false);
  assert.equal(zeroAfter(clock(65_000, { paused: true }), -MINUTE, NOW), false);
  assert.equal(zeroAfter(clock(10_000, { paused: true }), -MINUTE, NOW), true);
  assert.equal(zeroAfter(clock(10_000), MINUTE, NOW), false);
  assert.equal(zeroAfter(null, -MINUTE, NOW), false);
});

test('減到 0：累計上限讓它減完還剩 10 秒以上時不算；已經日落（照 store 的餘裕）的不算，store 會拒絕', () => {
  // 累計已經 −29 分 30 秒：這一次最多再減 30 秒，剩 50 秒減完還剩 20 秒；剩 38 秒減完剩 8 秒。
  assert.equal(zeroAfter(clock(50_000, { adjust: -(29 * MINUTE + 30_000) }), -MINUTE, NOW), false);
  assert.equal(zeroAfter(clock(38_000, { adjust: -(29 * MINUTE + 30_000) }), -MINUTE, NOW), true);
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

test('「－1」等加減鈕怎麼做：會幾乎直接日落先確認、其他直接送；沒有鐘、已經日落不送', () => {
  assert.equal(stepPlan(clock(62_000), -MINUTE, NOW), 'confirm');
  assert.equal(stepPlan(clock(70_000), -MINUTE, NOW), 'confirm');
  assert.equal(stepPlan(clock(70_001), -MINUTE, NOW), 'send');
  assert.equal(stepPlan(clock(62_000, { paused: true }), -MINUTE, NOW), 'send'); // 暫停中還加得回來
  assert.equal(stepPlan(clock(MINUTE, { paused: true }), -MINUTE, NOW), 'confirm');
  assert.equal(stepPlan(clock(5_000), MINUTE, NOW), 'send');
  assert.equal(stepPlan(clock(1_000), -MINUTE, NOW), 'send'); // 照 store 的餘裕已經日落：送出去由 store 回 clock-passed
  assert.equal(stepPlan(clock(0), MINUTE, NOW), 'disabled');
  assert.equal(stepPlan(clock(0, { paused: true }), MINUTE, NOW), 'disabled');
  assert.equal(stepPlan(undefined, -MINUTE, NOW), 'disabled');
});

test('「復原」怎麼做：反方向那一下會幾乎直接日落先確認；已經日落、沒有可以復原的不送', () => {
  const undo = { match: 1, delta: -MINUTE, seq: 4 };
  assert.equal(undoPlan(undo, clock(40_000), NOW), 'confirm'); // 「＋1」之後剩 40 秒按「復原」
  assert.equal(undoPlan(undo, clock(65_000), NOW), 'confirm');
  assert.equal(undoPlan(undo, clock(71_000), NOW), 'send');
  assert.equal(undoPlan({ ...undo, delta: MINUTE }, clock(5_000), NOW), 'send'); // 復原「－1」＝加回來
  assert.equal(undoPlan(undo, clock(0), NOW), 'disabled');
  assert.equal(undoPlan(undo, clock(-1), NOW), 'disabled');
  assert.equal(undoPlan(undo, undefined, NOW), 'disabled');
  assert.equal(undoPlan(null, clock(40_000), NOW), 'disabled');
});

test('「暫停日落鐘？」確認框：全場暫停中沒停住的鐘多一行（恢復時不會自動繼續）；快日落、沒有全場暫停的不寫', () => {
  const pause = { on: true, seq: 3, at: NOW - 2_000 };
  const line = [{ text: '全場恢復時不會自動繼續，要記得手動繼續', problem: true }];
  assert.deepEqual(toggleDialogLines({ clock: { 1: clock(15_000) }, display: { pause } }, '1', NOW), line);
  assert.deepEqual(toggleDialogLines({ clock: { 1: clock(15_000) }, display: { pause } }, '1', NOW + 6_000), []);
  assert.deepEqual(toggleDialogLines({ clock: { 1: clock(15_000) }, display: {} }, '1', NOW), []);
  assert.deepEqual(toggleDialogLines({ clock: { 1: clock(15_000, { paused: true }) }, display: { pause } }, '1', NOW), []);
});

test('全場暫停中的鐘：被這次暫停停住、手動暫停的、快日落（不到 10 秒，照常日落）、沒被停住；沒有暫停或已經日落是 null', () => {
  assert.equal(PAUSE_NEAR_SUNSET_MS, 10_000);
  assert.equal(clockPauseState(room({ 1: held(30 * MINUTE) }, PAUSE), '1', NOW), 'held');
  assert.equal(heldByPause(held(30 * MINUTE), PAUSE, 1), true);
  // 第 2 場不在 pause.clocks；第 1 場在，但停住的時刻不是暫停那一筆（暫停中被手動繼續又暫停）：都是手動暫停的。
  assert.equal(clockPauseState(room({ 2: held(30 * MINUTE) }, PAUSE), '2', NOW), 'manual');
  assert.equal(clockPauseState(room({ 1: clock(30 * MINUTE, { paused: true }) }, PAUSE), '1', NOW), 'manual');
  assert.equal(clockPauseState(room({ 1: clock(PAUSE_NEAR_SUNSET_MS) }, PAUSE), '1', NOW), 'near');
  assert.equal(clockPauseState(room({ 1: clock(PAUSE_NEAR_SUNSET_MS + 1) }, PAUSE), '1', NOW), 'free');
  assert.equal(clockPauseState(room({ 1: clock(40 * MINUTE) }, PAUSE), 1, NOW), 'free');
  assert.equal(clockPauseState(room({ 1: clock(0) }, PAUSE), '1', NOW), null);
  assert.equal(clockPauseState(room({ 1: clock(40 * MINUTE) }, { ...PAUSE, on: false }), '1', NOW), null);
  assert.equal(clockPauseState(room({ 1: clock(40 * MINUTE) }), '1', NOW), null);
  assert.equal(clockPauseState(room({}, PAUSE), '1', NOW), null);
  assert.equal(clockPauseState(null, '1', NOW), null);
});

test('全場暫停中的鐘照房間資料分、每一台都一樣：changed: false 的那一台、別台主持端、重新整理後、暫停中走進最後 10 秒、手動暫停後再全場暫停', () => {
  // A 在第 1 場剩 8 秒時按全場暫停：store 不停它（nearSunset ['1']），pause 沒有 clocks。寫完的房間資料只有這一份。
  const nearPause = { on: true, seq: 2, at: NOW - 1_000, by: 'a' };
  const after = room({ 1: clock(8_000) }, nearPause);
  const a = pauseReport(true, { changed: true, clocks: [], nearSunset: ['1'] }, room({ 1: clock(9_000) }), after, NOW);
  assert.match(a.text, /第 1 場日落鐘快日落/);
  // B 同時按、後到：changed: false、兩欄都是空的。結果條只講本來就是全場暫停中，不從空陣列推論「沒停住、可以手動暫停」。
  const b = pauseReport(true, { changed: false, clocks: [], nearSunset: [] }, room({ 1: clock(9_000) }), after, NOW);
  assert.deepEqual(b, { ok: true, warn: false, text: '本來就是全場暫停中' });
  // 面板：按的那一台、後到的那一台、沒按的別台主持端、重新整理後讀到的都是同一份房間資料，都是快日落（不給手動暫停）。
  for (const seen of [after, structuredClone(after), JSON.parse(JSON.stringify(after))]) assert.equal(clockPauseState(seen, '1', NOW), 'near');
  // 暫停中才走進最後 10 秒：寫的時候剩 15 秒（被拒後不帶鐘重送，沒停住），6 秒後剩 9 秒就是快日落；結果條也不叫人按暫停。
  const resent = room({ 2: clock(15_000) }, nearPause);
  assert.equal(clockPauseState(resent, '2', NOW), 'free');
  assert.equal(clockPauseState(resent, '2', NOW + 6_000), 'near');
  const late = pauseReport(true, { changed: true, clocks: [], nearSunset: [] }, resent, resent, NOW + 6_000);
  assert.match(late.text, /第 2 場日落鐘快日落/);
  assert.doesNotMatch(late.text, /按暫停/);
  assert.match(pauseReport(true, { changed: true, clocks: [], nearSunset: [] }, resent, resent, NOW).text, /第 2 場日落鐘沒有停住：要停可以在日落鐘面板按暫停/);
  // 先手動暫停（一分鐘前）再全場暫停：store 不記已經停著的鐘；就算記了，停住的時刻不是暫停那一筆，也是手動暫停的。恢復後照房間資料提醒。
  const manual = { ...clock(30 * MINUTE, { paused: true }), pausedAt: NOW - 60_000 };
  assert.equal(clockPauseState(room({ 1: manual }, nearPause), '1', NOW), 'manual');
  assert.equal(clockPauseState(room({ 1: manual }, { ...nearPause, clocks: { 1: true } }), '1', NOW), 'manual');
  const resumed = room({ 1: manual }, { ...nearPause, on: false });
  assert.match(pauseReport(false, { changed: true, clocks: [], nearSunset: [] }, room({ 1: manual }, nearPause), resumed, NOW).text, /第 1 場日落鐘還在暫停（手動暫停的）/);
  assert.equal(clockPauseState(resumed, '1', NOW), null);
});

test('下一次重畫：正在走的鐘走進最後 10 秒的那一刻（取最早、還沒到的）；暫停中、已經走進去、沒有鐘是 null', () => {
  const room = (clocks, pause = null) => ({ clock: clocks, display: pause ? { pause } : {} });
  assert.equal(nextWakeAt(room({ 1: clock(15_000) }), NOW), NOW + 5_000);
  assert.equal(nextWakeAt(room({ 1: clock(10_001) }), NOW), NOW + 1);
  assert.equal(nextWakeAt(room({ 1: clock(10_000) }), NOW), null); // 這一刻已經是快日落
  assert.equal(nextWakeAt(room({ 1: clock(9_000) }), NOW), null);
  assert.equal(nextWakeAt(room({ 1: clock(15_000, { paused: true }) }), NOW), null);
  assert.equal(nextWakeAt(room({ 1: clock(75 * MINUTE), 2: clock(20_000) }), NOW), NOW + 10_000);
  assert.equal(nextWakeAt(room({ 1: clock(20_000), 2: clock(75 * MINUTE) }), NOW), NOW + 10_000);
  assert.equal(nextWakeAt(room({}), NOW), null);
  assert.equal(nextWakeAt(null, NOW), null);
  // 全場暫停中沒停住的鐘：排到的那一刻（rerenderAt 再晚 50 毫秒）面板就從「沒被停住」變成「快日落」。
  const free = room({ 1: clock(15_000) }, { on: true, seq: 3, at: NOW - 2_000 });
  const wake = nextWakeAt(free, NOW);
  assert.equal(clockPauseState(free, '1', wake - 1), 'free');
  assert.equal(clockPauseState(free, '1', wake + 50), 'near');
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
  // changed: false（別台先恢復了）：回傳是空的，但第 2 場還停著是房間資料說的，照樣提醒；房間裡沒有還停著的就只講本來就沒有。
  assert.deepEqual(pauseReport(false, { changed: false, clocks: [], nearSunset: [] }, before, after, later), { ok: true, warn: false, text: '本來就沒有全場暫停' });
  assert.deepEqual(pauseReport(false, { changed: false, clocks: [], nearSunset: [] }, before, room({ 1: clock(30 * MINUTE), 2: clock(20 * MINUTE, { paused: true }) }), later), {
    ok: true,
    warn: true,
    text: '本來就沒有全場暫停；第 2 場日落鐘還在暫停（手動暫停的），要繼續請在日落鐘面板按繼續',
  });
  // 手動暫停的鐘提不提醒只看房間資料：回傳就算把第 2 場也列進 clocks，寫完還停著就提醒。
  assert.match(pauseReport(false, { changed: true, clocks: ['1', '2'], nearSunset: [] }, before, before, later).text, /第 2 場日落鐘還在暫停（手動暫停的）/);
});

test('局面的指紋：「這回合結束後算分」、兩個全場鐘的序號、黑夜的桌該不該算分（鐘到了）變了都會變；不相干的不變', () => {
  const settings = { sunsetMinutes: 75, maxRounds: 12 };
  const seats = { a: { order: 0 }, b: { order: 1 } };
  const base = () => ({
    meta: { tableCount: 2 },
    players: { a: { table: 1 }, b: { table: 1 } },
    tables: { 1: { round: 3, phase: 'night' }, 2: { round: 2, phase: 'day' } },
    games: { 1: { seats, startedAt: NOW - 10 * MINUTE, endAfterRound: 3 }, 2: { seats, startedAt: NOW - 10 * MINUTE } },
    deals: { 1: 3, 2: 2 },
    clock: { 1: clock(40 * MINUTE, { seq: 4 }) },
    display: {},
  });
  const sign = (room, now = NOW) => planSignature('advance-all', room, settings, now);
  const room = base();
  assert.equal(sign(room), sign(base()));
  room.display.scene = { id: 'rules', seq: 2 };
  assert.equal(sign(room), sign(base()));
  // 別台取消了「這回合結束後算分」。
  const cancelled = base();
  delete cancelled.games[1].endAfterRound;
  assert.notEqual(sign(cancelled), sign(base()));
  // 鐘被調過（序號變了）、第 2 場開了鐘、全場暫停。
  const adjusted = base();
  adjusted.clock[1] = { ...adjusted.clock[1], seq: 5 };
  assert.notEqual(sign(adjusted), sign(base()));
  const second = base();
  second.clock[2] = clock(75 * MINUTE, { seq: 1 });
  assert.notEqual(sign(second), sign(base()));
  const paused = base();
  paused.display.pause = { on: true, seq: 1, at: NOW };
  assert.notEqual(sign(paused), sign(base()));
  // 鐘沒動但時間到了：黑夜的第 1 桌從不算分變成要算分（日落鐘到了）。
  const noHost = base();
  delete noHost.games[1].endAfterRound;
  noHost.clock[1] = clock(5_000, { seq: 4 });
  assert.notEqual(sign(noHost, NOW + 6_000), sign(noHost, NOW));
  // 白晝的桌不看該不該算分（推進那一步不受影響）。
  const day = base();
  day.tables[1] = { round: 3, phase: 'day' };
  day.clock[1] = clock(5_000, { seq: 4 });
  assert.equal(sign(day, NOW + 6_000), sign(day, NOW));
  // 「這回合結束後算分」本身也在指紋裡（不在黑夜的桌也是）。
  const dayPlain = base();
  dayPlain.tables[1] = { round: 3, phase: 'day' };
  const dayMarked = structuredClone(dayPlain);
  delete dayPlain.games[1].endAfterRound;
  assert.notEqual(sign(dayMarked), sign(dayPlain));
  assert.equal(planSignature('pause', base()), '');
  assert.equal(planSignature('advance-all', null), '');
});

test('全場暫停中每桌的按鈕：開始、下一階段、開第 2 場、提前揭曉停用（本來就停用的加前綴）；其他照原本', () => {
  assert.equal(PAUSED_TEXT, '全場暫停中');
  for (const act of ['start', 'next', 'open-match', 'reveal-dusk', 'reveal-night']) {
    assert.equal(pausedWhy(act, null, true), '全場暫停中');
    assert.equal(pausedWhy(act, undefined, false), null);
  }
  assert.equal(pausedWhy('redeal', null, true), null);
  assert.equal(pausedWhy('end-toggle', '只有黑夜之前能按', true), '只有黑夜之前能按');
  assert.equal(pausedWhy('next', '響應結算後才能按', false), '響應結算後才能按');
  // 本來就因別的原因停用的：前面加「全場暫停中・」。
  assert.equal(pausedWhy('next', '響應結算後才能按', true), '全場暫停中・響應結算後才能按');
  assert.equal(pausedWhy('start', '還沒有玩家', true), '全場暫停中・還沒有玩家');
});

test('全場動作的停用原因：離線、全場暫停、卡牌資料讀取中、處理中；只剩要算分的桌也能按「能推的全推」', () => {
  const plans = {
    advance: { advance: [{ table: 2 }, { table: 5 }], skip: [] },
    start: { start: [{ table: 1 }], started: [], skip: [] },
    second: { start: [], started: [], skip: [] },
    open: null,
  };
  const base = { off: false, paused: false, noData: null, working: false };
  assert.deepEqual(actionWhy(base, plans), {
    advance: null,
    advanceNote: '第 2、5 桌；按了會先列出來確認',
    start: null,
    open: '還沒有桌打完第 1 場',
    second: '還沒有桌開第 2 場',
    status: '可以一起開全場日落鐘',
  });
  for (const [flags, text] of [
    [{ off: true }, OFFLINE_TEXT],
    [{ paused: true }, PAUSED_TEXT],
    [{ off: true, paused: true }, OFFLINE_TEXT],
  ]) {
    const why = actionWhy({ ...base, ...flags }, plans);
    assert.deepEqual([why.advance, why.advanceNote, why.start, why.open, why.second, why.status], [text, text, text, text, text, text]);
  }
  const loading = actionWhy({ ...base, noData: '卡牌資料讀取中…' }, { open: null });
  assert.deepEqual([loading.advance, loading.start, loading.open, loading.second, loading.status], Array(5).fill('卡牌資料讀取中…'));
  const working = actionWhy({ ...base, working: true }, plans);
  assert.equal(working.advance, '處理中…');
  assert.equal(working.status, '處理中…');
  // 只剩這一回合要算分的桌：鈕可以按（在確認框另外勾）。
  const ending = actionWhy(base, { ...plans, advance: { advance: [], skip: [{ table: 3, reason: 'ending' }, { table: 4, reason: 'playing' }] } });
  assert.equal(ending.advance, null);
  assert.equal(ending.advanceNote, '第 3 桌這一回合要算分，在確認框另外勾');
  assert.equal(actionWhy(base, { ...plans, advance: { advance: [], skip: [{ table: 4, reason: 'playing' }] } }).advance, '沒有可以推的桌');
});

test('全場動作的停用原因：全部開始、全部開第 2 場（已經在第 2 場的桌不是「還沒打完」）、全部開始第 2 場', () => {
  const base = { off: false, paused: false, noData: null, working: false };
  const advance = { advance: [], skip: [] };
  const none = { start: [], started: [], skip: [] };
  assert.equal(actionWhy(base, { advance, start: { start: [], started: ['1', '2'], skip: [] }, second: none, open: null }).start, '2 桌都開始了');
  assert.equal(actionWhy(base, { advance, start: { start: [], started: ['1'], skip: [{ table: 2 }] }, second: none, open: null }).start, '沒有可以開的桌');
  assert.equal(actionWhy(base, { advance, start: none, second: none, open: null }).start, '第 1 場都結束了');
  // 有桌已經開了或打完第 2 場：沒有要開的桌了。
  const inSecond = actionWhy(base, { advance, start: none, second: { start: [], started: ['1-2'], skip: [] }, open: null });
  assert.equal(inSecond.open, '沒有打完第 1 場、還沒開第 2 場的桌');
  assert.equal(inSecond.second, '第 2 場都開始了');
  assert.equal(inSecond.status, '第 1 場都結束了');
  assert.equal(actionWhy(base, { advance, start: none, second: none, open: { ready: [] } }).open, '天命都要先判定完');
  const ready = actionWhy(base, { advance, start: none, second: none, open: { ready: [{ table: 1 }] } });
  assert.equal(ready.open, null);
  assert.equal(ready.status, '第 1 場結束的桌可以開第 2 場');
  const second = actionWhy(base, { advance, start: none, second: { start: [{ table: 1 }], started: [], skip: [] }, open: { ready: [] } });
  assert.equal(second.second, null);
  assert.equal(second.status, '可以一起開第 2 場的日落鐘');
  assert.equal(actionWhy(base, { advance, start: none, second: { start: [], started: [], skip: [{ table: 1 }] }, open: { ready: [] } }).second, '沒有可以開的桌');
});
