// 投影畫面的純函式（play/js/ui/screen-model.js）：舞台與 4:3 版面、網址參數、日落鐘的文字、場景與頁數、每桌桌牌的狀態句、
// 頂部的全場鐘、日落自動敲鐘、迷霧事件、排行與頒獎的頁、素材表與下載進度、素材來源頁。房間與卡牌資料都是這裡手寫的小範例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayStatus } from '../../play/js/game.js';
import { isRoomCode, normalizeRoomCode } from '../../play/js/rules.js';
import {
  MEDIA,
  MEDIA_STALL_MS,
  STAGES,
  awardPages,
  bellKey,
  bellTick,
  bellsDue,
  clockText,
  creditsSummary,
  fogEntries,
  fogFlashText,
  headerClock,
  headerClockText,
  headerMatch,
  horizonProgress,
  joinAddress,
  loopFor,
  loopStep,
  matchLine,
  mediaFilesIn,
  mediaProgressText,
  megabytes,
  musicOn,
  nightCounts,
  openingMode,
  openingStep,
  openingWaitText,
  pageIndex,
  pageText,
  passedClocks,
  projectorParams,
  rulesPages,
  sceneOf,
  scenePageCount,
  sfxStep,
  stageLayout,
  stallWatch,
  standingsView,
  stepPage,
  tableCard,
  wallClock,
} from '../../play/js/ui/screen-model.js';
import { formatBits, qrMatrix, qrSvgOrNull } from '../../play/js/ui/qr.js';

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;
const SETTINGS = { sunsetMinutes: 75, maxRounds: 12, fogThresholds: [30, 60, 90], scoreRates: { pounds: 5, influence: 3 }, achievementPoints: 3, sinPerPenalty: 2 };

const cards = {
  data: {
    settings: SETTINGS,
    bills: [
      { id: 'b01', name: '十小時工作法案' },
      { id: 'b02', name: '第二次改革法案' },
    ],
    tutorial: [
      { id: 't01', phase: 'sunrise', text: '天亮了。' },
      { id: 't02', phase: 'day', text: '輪流出牌。' },
      { id: 't03', phase: 'night', text: '天黑了。' },
    ],
  },
  index: {
    events: new Map([
      ['e05', { id: 'e05', name: '倫敦碼頭工人大罷工' }],
      ['e25', { id: 'e25', name: '正午點燈' }],
    ]),
    actions: new Map([['a05', { id: 'a05', name: '紳士俱樂部晚宴' }]]),
  },
};

function seats(uids) {
  return Object.fromEntries(uids.map((uid, index) => [uid, { order: index + 1, role: `r${index + 1}`, pounds: 10, influence: 3, handCount: 5 }]));
}

// 一間 6 桌的房：每桌三個人 t{桌}a、t{桌}b、t{桌}c。
function room(extra = {}) {
  const players = {};
  for (let table = 1; table <= 6; table += 1) {
    for (const [index, suffix] of ['a', 'b', 'c'].entries()) players[`t${table}${suffix}`] = { name: `第${table}桌${suffix}`, table, joinedAt: index };
  }
  // 開房時六桌的 tables 都已經寫好（initialTable），還沒開局的桌沒有 games。
  const tables = Object.fromEntries([1, 2, 3, 4, 5, 6].map((table) => [table, { round: 1, phase: 'sunrise', fog: 0 }]));
  return { meta: { hostUid: 'host', createdAt: NOW - 60 * MINUTE, tableCount: 6 }, players, tables, games: {}, ...extra };
}

const uids = (table) => [`t${table}a`, `t${table}b`, `t${table}c`];
const game = (table, extra = {}) => ({ seats: seats(uids(table)), startedAt: NOW - 30 * MINUTE, startOrder: 0, ...extra });
const final = (table, totals) => {
  const sorted = [...totals].sort((a, b) => b - a);
  return { scores: Object.fromEntries(uids(table).map((uid, index) => [uid, { total: totals[index], rank: 1 + sorted.indexOf(totals[index]), destiny: { done: true } }])) };
};
const clock = (extra = {}) => ({ startedAt: NOW - 30 * MINUTE, minutes: 75, anchor: NOW - 30 * MINUTE, remain: 75 * MINUTE, adjust: 0, seq: 1, by: 'host', ...extra });

test('the stage is 1920×1080 for 16:9 and 16:10 windows and 1440×1080 near 4:3, scaled to fit and centred', () => {
  assert.deepEqual(stageLayout(1920, 1080), { layout: '16x9', width: 1920, height: 1080, scale: 1, left: 0, top: 0 });
  const small = stageLayout(1280, 720);
  assert.equal(small.layout, '16x9');
  assert.equal(small.scale, 2 / 3);
  const wxga = stageLayout(1280, 800);
  assert.equal(wxga.layout, '16x9', 'a 16:10 projector keeps the 16:9 layout');
  assert.equal(wxga.left, 0);
  assert.equal(wxga.top, (800 - 1080 * (1280 / 1920)) / 2);
  for (const [width, height] of [
    [1024, 768],
    [1400, 1050],
    [800, 600],
    [1280, 1024],
  ]) {
    const layout = stageLayout(width, height);
    assert.equal(layout.layout, '4x3', `${width}×${height}`);
    assert.equal(layout.width, STAGES['4x3'].width);
    assert.ok(layout.left >= 0 && layout.top >= 0);
  }
  // 4:3 版最小字 23px：1024×768 時仍約 16px。
  assert.ok(23 * stageLayout(1024, 768).scale >= 16);
  assert.ok(Number.isFinite(stageLayout(0, 0).scale), 'a zero-sized window does not divide by zero');
});

test('the projector address takes the room code like the join page and knows the preview mode', () => {
  assert.deepEqual(projectorParams('?view=screen&room=qx7m4k', isRoomCode, normalizeRoomCode), { code: 'QX7M4K', valid: true, preview: false });
  assert.deepEqual(projectorParams('?view=screen&room=%20QX7%20M4K%20&preview=1', isRoomCode, normalizeRoomCode), { code: 'QX7M4K', valid: true, preview: true });
  assert.equal(projectorParams('?view=screen&room=QX7M4', isRoomCode, normalizeRoomCode).valid, false);
  assert.equal(projectorParams('?view=screen&room=QX7M40', isRoomCode, normalizeRoomCode).valid, false, '0 is not in the alphabet');
  assert.equal(projectorParams('?view=screen', isRoomCode, normalizeRoomCode).valid, false);
  // 控制台開的兩種網址：小預覽框（preview=1、slot=preview）與「開投影畫面」的新視窗（slot=screen），env 照帶。
  assert.deepEqual(projectorParams('?view=screen&room=QX7M4K&preview=1&slot=preview&env=emu', isRoomCode, normalizeRoomCode), { code: 'QX7M4K', valid: true, preview: true });
  assert.deepEqual(projectorParams('?view=screen&room=QX7M4K&slot=screen&env=emu', isRoomCode, normalizeRoomCode), { code: 'QX7M4K', valid: true, preview: false });
  assert.deepEqual(joinAddress({ protocol: 'https:', host: 'kiresakura.github.io', pathname: '/one-day-briton/play/index.html', search: '?view=screen&room=QX7M4K&slot=screen' }), {
    text: 'kiresakura.github.io/one-day-briton/play/',
    full: 'https://kiresakura.github.io/one-day-briton/play/',
    base: 'kiresakura.github.io/one-day-briton/play/',
  });
});

test('the join address keeps only env=emu, so phones at a LAN rehearsal reach the same emulator', () => {
  const lan = joinAddress({ protocol: 'http:', host: '192.168.1.20:5050', pathname: '/play/', search: '?view=screen&room=QX7M4K&slot=screen&env=emu&preview=1' });
  assert.deepEqual(lan, { text: '192.168.1.20:5050/play/?env=emu', full: 'http://192.168.1.20:5050/play/?env=emu', base: '192.168.1.20:5050/play/' });
  assert.equal(joinAddress({ protocol: 'http:', host: '127.0.0.1:5050', pathname: '/play/index.html', search: '?env=emu&view=screen' }).full, 'http://127.0.0.1:5050/play/?env=emu');
  for (const search of ['?view=screen&room=QX7M4K&env=prod', '?view=screen&room=QX7M4K&preview=1&slot=preview', '', '?env=EMU']) {
    assert.equal(joinAddress({ protocol: 'https:', host: 'kiresakura.github.io', pathname: '/one-day-briton/play/', search }).full, 'https://kiresakura.github.io/one-day-briton/play/', search);
  }
});

test('clock texts round the remaining time up to the second and show hours past 60 minutes', () => {
  assert.equal(clockText(0), '00:00');
  assert.equal(clockText(-5000), '00:00');
  assert.equal(clockText(200), '00:01');
  assert.equal(clockText(33 * MINUTE + 52_000), '33:52');
  assert.equal(clockText(59 * MINUTE + 59_001), '1:00:00');
  assert.equal(clockText(75 * MINUTE), '1:15:00');
  const stamp = new Date(2026, 9, 19, 18, 44, 30).getTime();
  assert.equal(wallClock(stamp), '18:44');
  assert.equal(wallClock(stamp + 5 * MINUTE, 5 * MINUTE), '18:44', 'server time is shifted back to this device');
  assert.equal(wallClock(undefined), '');
});

test('a missing or unknown scene is the title page; pages are clamped and written as 第 n／m 頁', () => {
  assert.deepEqual(sceneOf(undefined), { id: 'opening', page: 0, seq: 0 });
  assert.deepEqual(sceneOf({ scene: { id: 'credits', seq: 4 } }), { id: 'opening', page: 0, seq: 0 });
  assert.deepEqual(sceneOf({ scene: { id: 'rules', page: 3, seq: 7 } }), { id: 'rules', page: 3, seq: 7 });
  assert.deepEqual(sceneOf({ scene: { id: 'awards', page: 99, seq: 2 } }).page, 20);
  assert.equal(pageIndex(15, 11), 10);
  assert.equal(pageIndex(-1, 11), 0);
  assert.equal(pageIndex(undefined, 11), 0);
  assert.equal(pageText(2, 11), '第 3／11 頁');
});

test('the console pager steps from the page the projector shows and stops at the first and the last page', () => {
  assert.equal(stepPage(0, 1, 3), 1);
  assert.equal(stepPage(1, -1, 3), 0);
  assert.equal(stepPage(2, 1, 3), 2, 'the last page stays the last page');
  assert.equal(stepPage(0, -1, 3), 0, 'the first page stays the first page');
  // 存的頁碼超過最後一頁（投影停在最後一頁）：上一頁直接到倒數第 2 頁，下一頁還是最後一頁。
  assert.equal(stepPage(14, -1, 3), 1);
  assert.equal(stepPage(14, 1, 3), 2);
  assert.equal(stepPage(20, -1, 11), 9);
  assert.equal(stepPage(-3, 1, 3), 1, 'a negative page is the first page');
  // 頁碼不是整數時投影顯示第 1 頁，從那裡走；step 不是整數就不動。
  assert.equal(stepPage(undefined, 1, 11), 1);
  assert.equal(stepPage(2.5, 1, 11), 1);
  assert.equal(stepPage('3', 1, 11), 1);
  assert.equal(stepPage(3, 0.5, 11), 3);
  assert.equal(stepPage(3, Number('next'), 11), 3);
  assert.equal(stepPage(3, Number('-1'), 11), 2, 'the step read from the button data');
  // 沒有頁（total 0）或只有一頁都是第 0 頁。
  assert.equal(stepPage(0, 1, 0), 0);
  assert.equal(stepPage(5, -1, 0), 0);
  assert.equal(stepPage(0, 1, 1), 0);
  assert.equal(stepPage(0, -1, 1), 0);
});

test('the rules pages are the flow chart and then one tip each, in the order of the tutorial file', () => {
  const pages = rulesPages(cards);
  assert.equal(pages.length, 4);
  assert.deepEqual(pages[0], { kind: 'flow' });
  assert.deepEqual(
    pages.slice(1).map((page) => [page.id, page.phase, page.number, page.count]),
    [
      ['t01', 'sunrise', 1, 3],
      ['t02', 'day', 2, 3],
      ['t03', 'night', 3, 3],
    ],
  );
  assert.equal(rulesPages(null).length, 1, 'without card data there is still the flow chart');
  assert.equal(scenePageCount('rules', room(), cards), 4);
  assert.equal(scenePageCount('overview', room(), cards), 1);
});

test('table cards say what each table is doing with public data only', () => {
  const r = room({ deals: { 2: 1 } });
  r.tables[1] = { round: 1, phase: 'sunrise', fog: 0 };
  r.games[1] = game(1);
  r.tables[2] = { round: 1, phase: 'sunrise', fog: 3 };
  r.games[2] = game(2, { eventLog: [{ round: 1, phase: 'sunrise', event: 'e05', kind: 'deck' }] });
  r.tables[3] = { round: 2, phase: 'day', fog: 12 };
  r.games[3] = game(3, { turn: { round: 2, index: 1, plays: 2 } });
  r.tables[4] = { round: 2, phase: 'day', fog: 40 };
  r.games[4] = game(4, { pending: { by: 't4a', card: 'a05', openedAt: NOW - 2000, seconds: 5 }, fogFired: { 0: 30 } });
  r.tables[5] = { round: 3, phase: 'dusk', fog: 34 };
  r.games[5] = game(5, { dusk: { round: 3, bill: 'b01', submitted: 2 } });
  r.tables[6] = { round: 3, phase: 'dusk', fog: 27 };
  r.games[6] = game(6, { dusk: { round: 3, bill: 'b02', submitted: 3, result: { passed: true, yes: 7, no: 3 } } });
  const at = (table) => tableCard(r, table, cards, NOW);

  assert.equal(at(1).status, '日出・發牌中…');
  assert.equal(at(2).status, '日出・薪水與抽牌已發');
  assert.deepEqual([at(2).kicker, at(2).name, at(2).art], ['今日事件', '〈倫敦碼頭工人大罷工〉', { kind: 'events', id: 'e05' }]);
  const current = dayStatus(r.games[3], 2).current;
  assert.equal(at(3).status, `▶ 輪到 ${r.players[current].name} 出牌・這一輪 2 張`);
  assert.equal(at(3).band, '第 2 回合・白晝');
  assert.equal(at(4).status, '第4桌a 打出〈紳士俱樂部晚宴〉・響應倒數');
  assert.deepEqual(at(4).countdown, { deadline: NOW + 3000, seconds: 5 });
  assert.deepEqual(at(4).fog.fired, [30], 'fired thresholds read back as an object still work');
  assert.equal(at(5).status, '表決中・已送出 2／3');
  assert.deepEqual(at(5).dots, { sent: 2, total: 3 });
  assert.deepEqual([at(5).kicker, at(5).name], ['本回合法案', '《十小時工作法案》']);
  assert.equal(at(6).status, '法案通過・贊成 7：反對 3');
  assert.equal(at(6).seal, '通過');
  assert.equal(at(6).dots, null, 'nobody is listed as missing once it is revealed');

  r.games[6].dusk.result.passed = false;
  assert.equal(at(6).status, '法案沒有通過・贊成 7：反對 3');
  assert.equal(at(6).seal, '否決');
  r.games[5].dusk.revealAt = NOW + 2000;
  assert.equal(at(5).status, '已送出 2／3・倒數揭曉');
  r.tables[3] = { round: 2, phase: 'day', fog: 12 };
  r.games[3].turn = { round: 2, index: 3, plays: 0 };
  assert.equal(at(3).status, '白晝出完了・準備進入黃昏');
});

test('night cards count gamblers, splitters and sleepers, and a fog event this round takes the picture', () => {
  const r = room();
  r.tables[1] = { round: 4, phase: 'night', fog: 61 };
  r.games[1] = game(1, {
    night: { round: 4, submitted: 1 },
    eventLog: [
      { round: 4, phase: 'sunrise', event: 'e05', kind: 'deck' },
      { round: 4, phase: 'day', event: 'e25', kind: 'fog', threshold: 60 },
    ],
  });
  assert.equal(tableCard(r, 1, cards, NOW).status, '選擇中・已送出 1／3');
  assert.deepEqual(tableCard(r, 1, cards, NOW).art, { kind: 'events', id: 'e25' });
  assert.equal(tableCard(r, 1, cards, NOW).kicker, '迷霧事件・越過 60');
  r.games[1].night.result = { players: { t1a: { choice: 'gamble' }, t1b: { choice: 'split' }, t1c: { choice: 'sleep', missed: true } } };
  assert.deepEqual(nightCounts(r.games[1]), { gamble: 1, split: 1, sleep: 1 });
  assert.equal(tableCard(r, 1, cards, NOW).status, '黑夜揭曉：1 人豪賭・1 人分贓・1 人睡覺');
  delete r.games[1].night.result.players.t1c;
  assert.deepEqual(nightCounts(r.games[1]), { gamble: 1, split: 1, sleep: 1 }, 'a seat without a result sleeps');
  assert.deepEqual(fogEntries(r.games[1]), [{ index: 1, threshold: 60, event: 'e25', round: 4 }]);
  assert.equal(fogFlashText(fogEntries(r.games[1])[0], cards), '迷霧越過 60：〈正午點燈〉');
  assert.equal(fogFlashText({ threshold: 90, event: null }, cards), '迷霧越過 90：〈迷霧事件〉');
});

test('tables waiting, between matches and finished say so', () => {
  const r = room();
  assert.equal(tableCard(r, 1, cards, NOW).status, '等玩家加入・已加入 3 人');
  assert.deepEqual([tableCard(r, 1, cards, NOW).kicker, tableCard(r, 1, cards, NOW).name], ['入座名單', '第1桌a、第1桌b、第1桌c']);
  assert.equal(tableCard(room({ players: {} }), 1, cards, NOW).name, '還沒有人加入');
  r.tables[1] = { round: 6, phase: 'end', fog: 50 };
  r.games[1] = game(1, { final: final(1, [20, 31, 18]) });
  const ended = tableCard(r, 1, cards, NOW);
  assert.equal(ended.status, '第 1 場結束・第 1 名 31 分');
  assert.deepEqual([ended.kicker, ended.name], ['第 1 場第 1 名', '第1桌b']);
  assert.deepEqual(ended.art, { kind: 'roles', id: 'r2' });
  assert.equal(ended.fog, null);
  r.tables['1-2'] = { round: 1, phase: 'sunrise', fog: 0 };
  assert.equal(tableCard(r, 1, cards, NOW).status, '第 2 場準備中・交接角色卡');
  r.games['1-2'] = game(1, { final: final(1, [20, 10, 30]) });
  r.tables['1-2'] = { round: 5, phase: 'end', fog: 30 };
  assert.equal(tableCard(r, 1, cards, NOW).status, '兩場合計 48 分', '20+20=40, 31+10=41, 18+30=48');
  // 兩場合計同分並列：名字只在名稱那一行（不在狀態再寫一次「兩場合計第 1 名」與名字），狀態寫分數與幾人並列。
  r.players.t1a.name = '維多利亞時代倫敦的忠實臣';
  r.players.t1c.name = 'ＷＷＷＷＷＷＷＷＷＷＷＷ';
  r.games['1-2'] = game(1, { final: final(1, [28, 10, 30]) });
  const tied = tableCard(r, 1, cards, NOW);
  assert.deepEqual([tied.kicker, tied.name, tied.status], ['兩場合計第 1 名', '維多利亞時代倫敦的忠實臣、ＷＷＷＷＷＷＷＷＷＷＷＷ', '兩場合計 48 分・2 人並列'], '20+28=48, 31+10=41, 18+30=48');
  assert.equal(tied.art, null, 'no single role badge for a tie');
  // 第 1 場同分並列也一樣
  r.tables = { 1: { round: 6, phase: 'end', fog: 50 } };
  r.games = { 1: game(1, { final: final(1, [31, 31, 18]) }) };
  assert.deepEqual([tableCard(r, 1, cards, NOW).name, tableCard(r, 1, cards, NOW).status], ['維多利亞時代倫敦的忠實臣、第1桌b', '第 1 場結束・第 1 名 31 分・2 人並列']);
});

test('the header clock follows the match being played; without a room clock each card shows its own', () => {
  const r = room();
  r.tables[1] = { round: 2, phase: 'day', fog: 0 };
  r.games[1] = game(1);
  let header = headerClock(r, SETTINGS, NOW);
  assert.deepEqual([header.match, header.global, header.status], [1, false, null]);
  assert.equal(headerClockText(header).big, '各桌計時');
  const own = tableCard(r, 1, cards, NOW, header).clock;
  assert.equal(own.global, false);
  assert.equal(own.remaining, 45 * MINUTE);

  r.clock = { 1: clock() };
  header = headerClock(r, SETTINGS, NOW);
  assert.equal(header.global, true);
  assert.equal(header.status.remaining, 45 * MINUTE);
  assert.equal(horizonProgress(header.status), 0.4);
  assert.deepEqual(headerClockText(header), { label: '距離日落', big: '45:00', sub: '' });
  assert.equal(tableCard(r, 1, cards, NOW, header).clock, null, 'the card does not repeat the room clock');

  r.clock[1].pausedAt = NOW - 5 * MINUTE;
  header = headerClock(r, SETTINGS, NOW);
  assert.deepEqual(headerClockText(header), { label: '日落鐘・暫停', big: '50:00', sub: '暫停中，時間不會走' });
  r.clock[1] = clock({ remain: 30 * MINUTE });
  assert.equal(headerClockText(headerClock(r, SETTINGS, NOW)).big, '日落');

  r.tables['2-2'] = { round: 1, phase: 'sunrise', fog: 0 };
  assert.equal(headerMatch(r), 1, 'opening the second match without starting it keeps the first clock');
  r.games['2-2'] = game(2);
  assert.equal(headerMatch(r), 2);
  header = headerClock(r, SETTINGS, NOW);
  assert.equal(header.global, false, 'the second match has no room clock yet');
  assert.ok(tableCard(r, 1, cards, NOW, header).clock, 'tables still in the first match show their own clock');
  assert.equal(tableCard(r, 1, cards, NOW, header).band, '第 1 場・第 2 回合・白晝', 'and say which match they are in');
  assert.equal(tableCard(r, 2, cards, NOW, header).band, '第 1 回合・日出');
  assert.equal(matchLine(r, 2), '第 2 場・比賽中');
  assert.equal(matchLine(room(), 1), '第 1 場・等待開局');
});

test('the sunset bell rings once per match when a running room clock reaches sunset, never for a paused one or one already past', () => {
  const r = room({ clock: { 1: clock() } });
  const seen = new Set(passedClocks(r, NOW));
  const none = { ring: [], mark: [] };
  assert.deepEqual([...seen], []);
  assert.deepEqual(bellsDue(r, NOW, seen), none);
  const sunset = r.clock[1].anchor + r.clock[1].remain;
  assert.deepEqual(bellsDue(r, sunset - 1, seen), none);
  assert.deepEqual(bellsDue(r, sunset, seen), { ring: [1], mark: [bellKey(1, r.clock[1])] });
  seen.add(bellKey(1, r.clock[1]));
  assert.deepEqual(bellsDue(r, sunset + 1000, seen), none, 'only once');
  const paused = room({ clock: { 1: clock({ pausedAt: NOW - MINUTE, remain: 0 }) } });
  assert.deepEqual(bellsDue(paused, NOW, new Set()), none, 'a clock cut to 0 while paused does not ring until it runs');
  const late = room({ clock: { 2: clock({ remain: MINUTE }) } });
  assert.deepEqual(passedClocks(late, NOW), [bellKey(2, late.clock[2])], 'a clock already past when the screen opens is not rung late');
  assert.deepEqual(bellsDue(late, NOW, new Set(passedClocks(late, NOW))), none);
});

test('a sunset reached during a room pause rings once on the first second after the pause, once per match', () => {
  // 全場暫停不停快日落的鐘：鐘照走、在暫停中日落。暫停中不響也不記，恢復後第一秒補響一次。
  const r = room({ clock: { 1: clock({ remain: 30 * MINUTE + 8000 }) }, display: { pause: { on: true } } });
  const seen = new Set(passedClocks(r, NOW));
  assert.deepEqual([...seen], [], 'not past yet when the screen opens');
  const sunset = r.clock[1].anchor + r.clock[1].remain;
  for (const at of [sunset, sunset + 1000, sunset + 60_000]) assert.deepEqual(bellsDue(r, at, seen, true), { ring: [], mark: [] }, 'silent while paused');
  const resumed = bellsDue(r, sunset + 61_000, seen, false);
  assert.deepEqual(resumed, { ring: [1], mark: [bellKey(1, r.clock[1])] }, 'rings on the first second after the pause');
  for (const key of resumed.mark) seen.add(key);
  assert.deepEqual(bellsDue(r, sunset + 62_000, seen, false), { ring: [], mark: [] }, 'exactly once');

  // 暫停中把鐘減到日落：投影開著時全場暫停、鐘也停住，主持人把鐘減到 0；恢復時從 0 起走 → 恢復後響一次。
  const cut = room({ clock: { 1: clock() } });
  const cutSeen = new Set(passedClocks(cut, NOW));
  cut.display = { pause: { on: true } };
  cut.clock[1] = clock({ pausedAt: NOW + MINUTE, anchor: NOW + MINUTE, remain: 0 });
  assert.deepEqual(bellsDue(cut, NOW + 2 * MINUTE, cutSeen, true), { ring: [], mark: [] });
  cut.clock[1] = clock({ anchor: NOW + 3 * MINUTE, remain: 0 });
  assert.deepEqual(bellsDue(cut, NOW + 3 * MINUTE, cutSeen, false).ring, [1]);

  // 開頁時已經日落：不補，暫停結束後也不補。
  const past = room({ clock: { 1: clock({ remain: MINUTE }) }, display: { pause: { on: true } } });
  const pastSeen = new Set(passedClocks(past, NOW));
  assert.deepEqual(bellsDue(past, NOW + 1000, pastSeen, false), { ring: [], mark: [] });

  // 兩場各響一次。
  const two = room({ clock: { 1: clock({ remain: 30 * MINUTE + 1000 }), 2: clock({ startedAt: NOW, anchor: NOW, remain: 2000 }) } });
  const twoSeen = new Set(passedClocks(two, NOW));
  const rings = [];
  for (let at = NOW; at <= NOW + 5000; at += 1000) {
    const step = bellsDue(two, at, twoSeen, at === NOW + 1000);
    rings.push(...step.ring);
    for (const key of step.mark) twoSeen.add(key);
  }
  assert.deepEqual(rings, [1, 2], 'match 1 waits out the paused second, then each match rings once');
});

test('every second the projector does what bellTick says: clocks past at first read stay silent, a room pause holds the bell, no sound still marks', () => {
  // 第一次讀到房間：第 2 場的鐘早就日落 → 記成響過、不響；第 1 場還有 2 秒。seen 不會被改，由呼叫端記。
  const r = room({ clock: { 1: clock({ remain: 30 * MINUTE + 2000 }), 2: clock({ remain: MINUTE }) } });
  const seen = { primed: false, bells: new Set() };
  const step = (at, audible = true) => {
    const result = bellTick(r, at, seen, audible);
    for (const key of result.mark) seen.bells.add(key);
    seen.primed = true;
    return result;
  };
  assert.deepEqual(bellTick(r, NOW, seen, true), { ring: [], mark: [bellKey(2, r.clock[2])] });
  assert.equal(seen.bells.size, 0, 'bellTick does not write into seen');
  assert.deepEqual(step(NOW), { ring: [], mark: [bellKey(2, r.clock[2])] });
  assert.deepEqual(step(NOW + 1000), { ring: [], mark: [] });
  // 第 1 場在全場暫停中日落（暫停不停快日落的鐘）：暫停中不響也不記，恢復後第一秒補響一次。
  r.display = { pause: { on: true } };
  assert.deepEqual(step(NOW + 2000), { ring: [], mark: [] }, 'held while the room is paused');
  assert.deepEqual(step(NOW + 3000), { ring: [], mark: [] });
  r.display = { pause: { on: false } };
  assert.deepEqual(step(NOW + 4000), { ring: [1], mark: [bellKey(1, r.clock[1])] }, 'rings on the first second after the pause');
  assert.deepEqual(step(NOW + 5000), { ring: [], mark: [] }, 'exactly once');

  // 聲音沒開（或預覽框）：日落那一秒不響但照樣記下，之後開了聲音也不補響。
  const quiet = room({ clock: { 1: clock({ remain: 30 * MINUTE + 1000 }) } });
  const quietSeen = { primed: true, bells: new Set() };
  const muted = bellTick(quiet, NOW + 1000, quietSeen, false);
  assert.deepEqual(muted, { ring: [], mark: [bellKey(1, quiet.clock[1])] });
  for (const key of muted.mark) quietSeen.bells.add(key);
  assert.deepEqual(bellTick(quiet, NOW + 2000, quietSeen, true), { ring: [], mark: [] });
  // 已經讀過房間（primed）之後才日落的鐘照樣響，不會被當成「開頁時已經日落」。
  assert.deepEqual(bellTick(quiet, NOW + 2000, { primed: true, bells: new Set() }, true).ring, [1]);
  assert.deepEqual(bellTick(quiet, NOW + 2000, { primed: false, bells: new Set() }, true).ring, []);
});

// 突變測試抓不到的地方各補一條：版面門檻的邊界、開頁時暫停中的鐘、剛好日落、第 2 場的全場鐘、排行最多 5 人、排隊中的素材。
test('layout boundaries: 1.50 and 1.559 windows are 4:3, from 1.58 on (16:10, 16:9) it is 16:9', () => {
  assert.equal(stageLayout(1024, 683).layout, '4x3', '1.50');
  assert.equal(stageLayout(1500, 1000).layout, '4x3', '1.50 exactly');
  assert.equal(stageLayout(1280, 800).layout, '16x9', '1.6');
  assert.equal(stageLayout(1920, 1080).layout, '16x9', '1.778');
  assert.equal(stageLayout(800, 513).layout, '4x3', '1.559: an 800×600 projector in a window');
  assert.equal(stageLayout(1579, 1000).layout, '4x3', 'just under 1.58');
  assert.equal(stageLayout(1580, 1000).layout, '16x9', '1.58 and up is 16:9');
});

test('a clock paused before sunset is not taken as past when the screen opens, one exactly at sunset is', () => {
  const stopped = room({ clock: { 1: clock({ anchor: NOW - 60 * MINUTE, remain: 30 * MINUTE, pausedAt: NOW - 50 * MINUTE }) } });
  assert.deepEqual(passedClocks(stopped, NOW), [], 'it stopped with 20 minutes left; the time since does not count');
  const exact = room({ clock: { 1: clock({ anchor: NOW - 30 * MINUTE, remain: 30 * MINUTE }) } });
  assert.deepEqual(passedClocks(exact, NOW), [bellKey(1, exact.clock[1])], 'remaining 0 counts as past');
  const exactPaused = room({ clock: { 1: clock({ anchor: NOW - 30 * MINUTE, remain: 10 * MINUTE, pausedAt: NOW - 20 * MINUTE }) } });
  assert.deepEqual(passedClocks(exactPaused, NOW), [bellKey(1, exactPaused.clock[1])], 'paused at exactly 0');
});

test('the header follows the second match as soon as its room clock exists, even before any table starts it', () => {
  const r = room({ clock: { 1: clock({ remain: 10 * MINUTE }), 2: clock({ startedAt: NOW, anchor: NOW }) } });
  r.tables[1] = { round: 6, phase: 'end', fog: 0 };
  r.games[1] = game(1, { final: final(1, [10, 20, 30]) });
  assert.equal(headerMatch(r), 2);
  assert.equal(headerClock(r, SETTINGS, NOW).status.remaining, 75 * MINUTE);
});

test('standings show at most five tied names and count the rest', () => {
  const r = room();
  const six = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
  r.tables[1] = { round: 6, phase: 'end', fog: 0 };
  r.games[1] = { seats: seats(six), startedAt: NOW, startOrder: 0, final: { scores: Object.fromEntries(six.map((uid) => [uid, { total: 10, rank: 1, destiny: { done: true } }])) } };
  const [column] = standingsView(r);
  assert.equal(column.rows.length, 5);
  assert.equal(column.more, 1);
});

test('files still queued count as downloading in the progress line', () => {
  assert.equal(
    mediaProgressText(
      [
        { status: 'waiting', loaded: 0, total: 0 },
        { status: 'ready', loaded: 1_000_000, total: 1_000_000 },
      ],
      true,
    ),
    '素材下載中 1.0／1.0 MB',
  );
});

test('a sound effect plays once if it is new, recent and the sound is on; its seq is kept either way', () => {
  const gavel = (seq, at = NOW - 1000) => ({ id: 'gavel', seq, at });
  assert.deepEqual(sfxStep(gavel(3), null, NOW, true), { seen: 3, play: 'gavel' }, 'pressed a second ago');
  assert.deepEqual(sfxStep(gavel(3), 3, NOW, true), { seen: 3, play: null }, 'already handled');
  assert.deepEqual(sfxStep(gavel(4), 3, NOW, false), { seen: 4, play: null }, 'sound off: kept, not played later');
  assert.deepEqual(sfxStep(gavel(5, NOW - 6000), 4, NOW, true), { seen: 5, play: null }, 'more than 5 seconds old: not played late');
  assert.deepEqual(sfxStep(gavel(2), 5, NOW, true), { seen: 5, play: null }, 'an older seq does not move back');
  assert.deepEqual(sfxStep(undefined, 5, NOW, true), { seen: 5, play: null });
  assert.deepEqual(sfxStep({ id: 'bell', seq: 'x', at: NOW }, 5, NOW, true), { seen: 5, play: null });
});

test('the opening video plays when the scene seq changes to the opening on a started projector, not on the first read', () => {
  const opening = (seq) => ({ id: 'opening', page: 0, seq });
  assert.deepEqual(openingStep(opening(7), null, true), { seen: 7, play: false }, 'first read after a reload: no replay');
  assert.deepEqual(openingStep(opening(7), 7, true), { seen: 7, play: false });
  assert.deepEqual(openingStep(opening(8), 7, true), { seen: 8, play: true });
  assert.deepEqual(openingStep({ id: 'rules', page: 0, seq: 9 }, 8, true), { seen: 9, play: false });
  assert.deepEqual(openingStep(opening(10), 9, false), { seen: 10, play: false }, 'not started or a preview: kept, not played later');
});

test('standings list the top three of each finished table and say which tables are still playing', () => {
  const r = room();
  r.tables[1] = { round: 6, phase: 'end', fog: 0 };
  r.games[1] = game(1, { final: final(1, [12, 30, 30]) });
  r.tables[2] = { round: 6, phase: 'end', fog: 0 };
  r.games[2] = game(2, { final: final(2, [10, 20, 30]) });
  r.tables['2-2'] = { round: 6, phase: 'end', fog: 0 };
  r.games['2-2'] = game(2, { final: final(2, [25, 5, 1]) });
  r.tables[3] = { round: 2, phase: 'day', fog: 0 };
  r.games[3] = game(3);
  const columns = standingsView(r);
  assert.equal(columns.length, 6);
  assert.deepEqual(
    columns[0].rows.map((row) => [row.rank, row.name, row.total]),
    [
      [1, '第1桌b', 30],
      [1, '第1桌c', 30],
      [3, '第1桌a', 12],
    ],
  );
  assert.equal(columns[0].basis, 'first');
  assert.deepEqual(columns[1].rows[0], { rank: 1, name: '第2桌a', total: 35, first: 10, second: 25 });
  assert.equal(columns[1].basis, 'combined');
  assert.deepEqual([columns[2].status, columns[2].rows], ['playing', []]);
  assert.equal(columns[3].status, 'idle');
});

test('award pages: the ceremony, one champion page per finished table, the top score and the credits last', () => {
  const r = room();
  r.tables[1] = { round: 6, phase: 'end', fog: 0 };
  r.games[1] = game(1, { final: final(1, [12, 30, 30]) });
  r.tables[2] = { round: 6, phase: 'end', fog: 0 };
  r.games[2] = game(2, { final: final(2, [10, 20, 30]) });
  r.tables['2-2'] = { round: 6, phase: 'end', fog: 0 };
  r.games['2-2'] = game(2, { seats: { t2a: { order: 1, role: 'r6' }, t2b: { order: 2, role: 'r1' }, t2c: { order: 3, role: 'r2' } }, final: final(2, [25, 5, 1]) });
  r.tables[3] = { round: 2, phase: 'day', fog: 0 };
  r.games[3] = game(3);
  const pages = awardPages(r);
  assert.deepEqual(
    pages.map((page) => page.kind),
    ['title', 'champion', 'champion', 'top', 'credits'],
  );
  assert.deepEqual(
    pages[1].winners.map((winner) => [winner.name, winner.role, winner.total]),
    [
      ['第1桌b', 'r2', 30],
      ['第1桌c', 'r3', 30],
    ],
  );
  assert.deepEqual([pages[2].table, pages[2].basis, pages[2].winners[0].role], [2, 'combined', 'r6'], 'the badge is the second-match role');
  assert.deepEqual(pages[3].top, { basis: 'combined', total: 35, winners: [{ table: 2, uid: 't2a', name: '第2桌a' }] });
  assert.equal(scenePageCount('awards', r, cards), 5);
  assert.deepEqual(
    awardPages(room()).map((page) => page.kind),
    ['title', 'top', 'credits'],
  );
  assert.equal(awardPages(room())[1].top, null);
});

test('the media table lists the expected files under play/media only, and the download line counts megabytes', () => {
  const files = MEDIA.map((item) => item.file);
  for (const file of ['opening.mp4', 'loop-1.mp4', 'bell.mp3', 'gavel.mp3', 'music-opening.mp3', 'bg-title.webp', 'bg-rules.webp']) assert.ok(files.includes(file), file);
  assert.ok(files.every((file) => /^[a-z0-9-]+\.[a-z0-9]+$/.test(file)), 'plain file names, no folders');
  assert.equal(new Set(MEDIA.map((item) => item.id)).size, MEDIA.length);
  assert.equal(mediaProgressText([], false), '按「開始投影」後才下載影片與音效');
  assert.equal(
    mediaProgressText(
      [
        { status: 'loading', loaded: 3_200_000, total: 20_000_000 },
        { status: 'waiting', loaded: 0, total: 0 },
        { status: 'ready', loaded: 150_000, total: 150_000 },
      ],
      true,
    ),
    '素材下載中 3.4／20 MB',
  );
  assert.equal(mediaProgressText([{ status: 'missing', loaded: 0, total: 0 }], true), '還沒有影音素材，先用佔位（畫面與合成音效）');
  assert.equal(
    mediaProgressText(
      [
        { status: 'ready', loaded: 1_000_000, total: 1_000_000 },
        { status: 'failed', loaded: 0, total: 0 },
      ],
      true,
    ),
    '素材已下載 1.0 MB・1 個用佔位',
  );
  assert.equal(megabytes(12_600_000), '13');
});

test('the opening video waits for its download with a progress line, and falls back to the placeholder only without the file', () => {
  const ready = { status: 'ready', loaded: 18_000_000, total: 18_000_000, url: 'blob:x' };
  assert.equal(openingMode(ready, true), 'video');
  assert.equal(openingMode({ status: 'loading', loaded: 3_200_000, total: 18_000_000, url: null }, true), 'wait');
  assert.equal(openingMode({ status: 'waiting', loaded: 0, total: 0, url: null }, true), 'wait', 'queued behind the other files');
  assert.equal(openingMode({ status: 'waiting', loaded: 0, total: 0, url: null }, false), 'placeholder', 'nothing is downloading (先看畫面)');
  for (const status of ['missing', 'failed']) assert.equal(openingMode({ status, loaded: 0, total: 0, url: null }, true), 'placeholder', status);
  assert.equal(openingWaitText({ status: 'loading', loaded: 3_240_000, total: 18_000_000 }), '開場影片下載中（3.2／18 MB）');
  assert.equal(openingWaitText({ status: 'loading', loaded: 3_240_000, total: 0 }), '開場影片下載中（3.2 MB）');
  assert.equal(openingWaitText({ status: 'waiting', loaded: 0, total: 0 }), '開場影片下載中（0.0 MB）');
});

test('a media download that gets no new bytes for 30 s is stopped once and then falls back like a failed one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(MEDIA_STALL_MS, 30_000);
  let stalls = 0;
  const watch = stallWatch(MEDIA_STALL_MS, () => {
    stalls += 1;
  });
  // 等伺服器回應也算：29.999 秒還沒有回應不算卡住
  t.mock.timers.tick(29_999);
  assert.equal(stalls, 0);
  // 位元組一直進來（每段間隔不到 30 秒）就一直等
  watch.progress();
  t.mock.timers.tick(20_000);
  watch.progress();
  t.mock.timers.tick(29_999);
  assert.equal(stalls, 0, 'bytes keep coming');
  t.mock.timers.tick(1);
  assert.equal(stalls, 1, '30 s since the last byte');
  // 已經中止：晚到的一段不再重新計時，只中止一次
  watch.progress();
  t.mock.timers.tick(60_000);
  assert.equal(stalls, 1, 'only once');
  // 下完、失敗、不用下載時 stop()：之後不會再中止
  const finished = stallWatch(MEDIA_STALL_MS, () => {
    stalls += 1;
  });
  t.mock.timers.tick(10_000);
  finished.progress();
  finished.stop();
  t.mock.timers.tick(120_000);
  assert.equal(stalls, 1);
  // 中止的下載記成 failed：等著的那一次開場改用佔位，不再寫「下載中」
  assert.equal(openingMode({ status: 'failed', loaded: 3_200_000, total: 18_000_000 }, true), 'placeholder');
});

test('background loops belong to the title, rules, standings and awards scenes and are media files', () => {
  assert.deepEqual(
    ['opening', 'rules', 'standings', 'awards', 'overview', 'nope'].map(loopFor),
    ['loop-1', 'loop-2', 'loop-3', 'loop-3', null, null],
  );
  for (const id of ['loop-1', 'loop-2', 'loop-3']) assert.equal(MEDIA.find((item) => item.id === id)?.kind, 'video', id);
});

test('a background loop is built once per scene and file, not on every render, and not while the opening video plays', () => {
  const url = 'blob:loop-1';
  const title = loopStep('', 'opening', url, false);
  assert.deepEqual(title, { key: `opening ${url}`, rebuild: true });
  // 標題頁停 60 秒（每秒重畫、房間也一直更新）：只建一次。
  let key = '';
  let built = 0;
  for (let second = 0; second < 60; second += 1) {
    const next = loopStep(key, 'opening', url, false);
    if (next.rebuild && next.key) built += 1;
    key = next.key;
  }
  assert.equal(built, 1);
  assert.deepEqual(loopStep(title.key, 'opening', url, false), { key: title.key, rebuild: false });
  // 開場影片開始播：拆掉背景影片；播放中重畫也不放；播完再建一次。
  assert.deepEqual(loopStep(title.key, 'opening', url, true), { key: '', rebuild: true });
  assert.deepEqual(loopStep('', 'opening', url, true), { key: '', rebuild: false });
  assert.deepEqual(loopStep('', 'rules', 'blob:loop-2', true), { key: '', rebuild: false }, 'the opening video covers every scene');
  assert.deepEqual(loopStep('', 'opening', url, false), title);
  // 換場景（同一支檔也重建）、換網址也重建；總覽沒有背景影片、素材還沒好、還沒讀到房間：拆掉，之後不再動。
  const standings = loopStep('', 'standings', 'blob:loop-3', false);
  assert.deepEqual(loopStep(standings.key, 'awards', 'blob:loop-3', false), { key: 'awards blob:loop-3', rebuild: true });
  assert.equal(loopStep(title.key, 'opening', 'blob:loop-1-again', false).rebuild, true);
  assert.deepEqual(loopStep(standings.key, 'overview', null, false), { key: '', rebuild: true });
  assert.deepEqual(loopStep('', 'overview', null, false), { key: '', rebuild: false });
  assert.deepEqual(loopStep(title.key, null, url, false), { key: '', rebuild: true });
});

test('the media list in media/credits.json names the files to download, with or without sizes', () => {
  assert.equal(mediaFilesIn(null), null);
  assert.equal(mediaFilesIn([{ slot: 'bell', title: 'Bell' }]), null, 'no file names: try every file in the table');
  assert.deepEqual(
    [
      ...mediaFilesIn([
        { slot: 'opening', files: [{ path: 'media/opening.mp4', bytes: 18_000_000 }] },
        { slot: 'bell', files: ['bell.mp3'] },
        { slot: 'gavel', file: 'gavel.mp3', bytes: 40_000 },
      ]),
    ],
    [
      ['opening.mp4', 18_000_000],
      ['bell.mp3', null],
      ['gavel.mp3', 40_000],
    ],
  );
});

test('credits list the full attribution only where it is required and count the rest', () => {
  const images = [
    { slot: 'b03', attribution_required: true, attribution: '“Children” by Unknown, CC BY 4.0' },
    { slot: 'r1', attribution_required: false, attribution: '“Sisters”, CC0' },
    { slot: 'e01', attribution_required: true, attribution: '“Crystal Palace”, CC BY 4.0' },
  ];
  assert.deepEqual(creditsSummary(images), {
    full: [
      { label: 'b03', text: '“Children” by Unknown, CC BY 4.0' },
      { label: 'e01', text: '“Crystal Palace”, CC BY 4.0' },
    ],
    others: 1,
    total: 3,
  });
  assert.deepEqual(creditsSummary(null), { full: [], others: 0, total: 0 });
  assert.equal(creditsSummary(images, [{ attribution_required: true, attribution: 'bell, CC BY' }]).full.length, 3);
});

test('the opening music plays only while display/music is on', () => {
  assert.equal(musicOn(undefined), false);
  assert.equal(musicOn({ music: { track: 'opening', on: true, seq: 1 } }), true);
  assert.equal(musicOn({ music: { track: 'opening', on: false, seq: 2 } }), false);
  assert.equal(musicOn({ music: { track: 'other', on: true, seq: 1 } }), false);
});

// QR 碼：版本照長度挑、功能圖案在規格的位置、格式資訊對得上遮罩（BCH 檢查）。實際掃描另外在瀏覽器驗過。
test('the QR code picks the smallest version, draws the function patterns and carries a valid format word', () => {
  const url = 'https://kiresakura.github.io/one-day-briton/play/';
  const qr = qrMatrix(url);
  assert.deepEqual([qr.version, qr.size], [4, 33], '49 bytes fit version 4-M');
  assert.equal(qrMatrix('x'.repeat(14)).version, 1);
  assert.equal(qrMatrix('x'.repeat(15)).version, 2);
  assert.throws(() => qrMatrix('x'.repeat(214)), RangeError);
  const { modules, size } = qr;
  const finder = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######'];
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    assert.deepEqual(
      finder.map((_, row) => modules[top + row].slice(left, left + 7).map((dark) => (dark ? '#' : '.')).join('')),
      finder,
    );
  }
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(modules[6][i], i % 2 === 0, `timing row ${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `timing column ${i}`);
  }
  assert.equal(modules[size - 8][8], true, 'dark module');
  // 讀回兩份格式資訊（同一個 15 位元），解開遮罩後是等級 M（00）＋這次的遮罩。
  const first = [0, 1, 2, 3, 4, 5].map((i) => modules[i][8]).concat([modules[7][8], modules[8][8], modules[8][7]], [9, 10, 11, 12, 13, 14].map((i) => modules[8][14 - i]));
  const second = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => modules[8][size - 1 - i]).concat([8, 9, 10, 11, 12, 13, 14].map((i) => modules[size - 15 + i][8]));
  const word = (bits) => bits.reduce((value, dark, i) => value | ((dark ? 1 : 0) << i), 0);
  assert.equal(word(first), formatBits(qr.mask));
  assert.equal(word(second), formatBits(qr.mask));
  assert.equal((formatBits(qr.mask) ^ 0x5412) >>> 10, qr.mask);
  assert.deepEqual(qrMatrix(url, { mask: qr.mask }).modules, modules, 'deterministic');
  assert.equal(qrMatrix('x'.repeat(150)).version, 8, 'version info area is used from version 7');
});

test('a join address too long for a QR code leaves the title page with the text address instead of throwing every second', () => {
  assert.equal(qrSvgOrNull(`https://example.test/${'x'.repeat(300)}`), null);
  // 放得進的網址照樣畫（Node 沒有 DOM：借一個只記呼叫的 document）。
  const made = [];
  const node = (tag) => ({ tag, attrs: {}, kids: [], setAttribute(key, value) { this.attrs[key] = value; }, append(...kids) { this.kids.push(...kids); } });
  globalThis.document = { createElementNS: (ns, tag) => (made.push(tag), node(tag)) };
  try {
    const svg = qrSvgOrNull('https://kiresakura.github.io/one-day-briton/play/');
    assert.equal(svg.tag, 'svg');
    assert.equal(svg.attrs.viewBox, '0 0 41 41', 'version 4 (33 modules) plus the quiet zone');
    assert.deepEqual(made, ['svg', 'rect', 'path']);
  } finally {
    delete globalThis.document;
  }
});
