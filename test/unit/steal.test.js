// 「偷」：試算表寫法與檢查、出牌與響應卡的結算（對方實際少多少、自己就拿多少；4 級加倍、2 級不加倍；響應卡偷出牌者；
// 被抵銷不偷；@指定 的響應卡照舊退回）（M7）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkData, formatIssue } from '../../play/js/data.js';
import { needsTarget, processRequest, responseSettleAt, seededRandom, settlePending } from '../../play/js/game.js';
import { loadGameData } from '../../play/js/gamedata.js';
import { convertSheet, parseEffects } from '../../scripts/lib/import.mjs';

const cardDir = new URL('../../play/data/', import.meta.url);
const { data } = await loadGameData(async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8')));

const card = (id, fields = {}) => ({
  id,
  name: id,
  kind: 'play',
  category: null,
  role: null,
  copies: 1,
  cost: { pounds: 0, influence: 0 },
  gear: null,
  effects: [],
  text: id,
  ...fields,
});
const response = (id, respondsTo, fields = {}) => card(id, { kind: 'response', respondsTo, ...fields });
const steal = (resource, target, amount) => ({ op: 'steal', resource, target, amount });
const testData = {
  settings: { ...data.settings, responseSeconds: 5 },
  actions: [
    card('stealPounds', { effects: [steal('pounds', 'chosen', 3)] }),
    card('stealInfluence', { effects: [steal('influence', 'chosen', 2)] }),
    // 齒輪 G：偷 3 英鎊、自己英鎊 +1（2 級時這一項加倍，偷不加倍）。
    card('gearSteal', { gear: 'G', effects: [steal('pounds', 'chosen', 3), { op: 'pounds', target: 'self', amount: 1 }] }),
    card('trade', { category: '交易', gear: 'T' }),
    response('stealBack', ['交易'], { effects: [steal('pounds', 'originalPlayer', 4)] }),
    response('stealChosen', null, { effects: [steal('pounds', 'chosen', 1)] }),
    response('cancel', null, { effects: [{ op: 'cancel' }] }),
  ],
};
const instant = { ...testData, settings: { ...testData.settings, responseSeconds: 0 } };

// 一桌三人：a（座位 0）、b（座位 1）、c（座位 2），英鎊 10、影響力 3；第 1 回合白晝。
function tableState({ hands = {}, seats = {}, ...rest } = {}) {
  const allHands = { a: [], b: [], c: [], ...hands };
  const allSeats = {};
  ['a', 'b', 'c'].forEach((uid, order) => {
    allSeats[uid] = { order, role: `r${order + 1}`, pounds: 10, influence: 3, handCount: allHands[uid].length, ...seats[uid] };
  });
  const deck = ['x1', 'x2', 'x3', 'x4', 'x5'];
  return { round: 1, phase: 'day', fog: 0, startOrder: 0, lastSeq: {}, deck, discard: [], pending: null, ...rest, seats: allSeats, hands: allHands };
}

const nextSeq = (state, uid) => (state.lastSeq?.[uid] ?? 0) + 1;
const send = (state, uid, request, cardData = instant) => processRequest(state, uid, { seq: nextSeq(state, uid), ...request }, cardData, seededRandom(1));
const money = (state, key) => Object.fromEntries(Object.entries(state.seats).map(([uid, seat]) => [uid, seat[key]]));
const total = (state, key) => Object.values(state.seats).reduce((sum, seat) => sum + seat[key], 0);

function played(state, uid, request, cardData) {
  const result = send(state, uid, { type: 'play', ...request }, cardData);
  assert.equal(result.kind, 'played', result.reason);
  return result.state;
}

// 出牌開窗口，再讓 requests 響應（沒有就等時間到）；回傳結算後的 state。
function answered(state, uid, request, requests = {}) {
  const opened = send(state, uid, { type: 'play', ...request }, testData);
  assert.equal(opened.kind, 'opened', opened.reason);
  const pending = { id: 'p1', ...opened.pending, openedAt: 1000, seconds: 5 };
  const window = { ...opened.state, pending };
  const asked = Object.fromEntries(
    Object.entries(requests).map(([who, cardId]) => [who, { seq: nextSeq(window, who), type: 'respond', card: cardId, pending: 'p1', at: 2000 }]),
  );
  const now = Object.keys(asked).length ? 2000 : responseSettleAt(pending);
  return settlePending(window, asked, testData, { now, random: seededRandom(1) });
}

test('stealing takes what the target has, up to the amount, and the total stays the same', () => {
  let state = played(tableState({ hands: { a: ['stealPounds'] } }), 'a', { card: 'stealPounds', target: 'b' });
  assert.deepEqual(money(state, 'pounds'), { a: 13, b: 7, c: 10 });
  state = played(tableState({ hands: { a: ['stealPounds'] }, seats: { b: { pounds: 2 } } }), 'a', { card: 'stealPounds', target: 'b' });
  assert.deepEqual(money(state, 'pounds'), { a: 12, b: 0, c: 10 }, 'b only had 2');
  assert.equal(total(state, 'pounds'), 22);
  state = played(tableState({ hands: { a: ['stealInfluence'] }, seats: { c: { influence: 0 } } }), 'a', { card: 'stealInfluence', target: 'c' });
  assert.deepEqual(money(state, 'influence'), { a: 3, b: 3, c: 0 }, 'nothing to take');
  assert.equal(needsTarget(instant.actions[0]), true);
  assert.equal(send(tableState({ hands: { a: ['stealPounds'] } }), 'a', { type: 'play', card: 'stealPounds' }).reason, 'need-target');
});

test('a level 4 chain doubles the amount stolen; level 2 does not (only what you give yourself doubles)', () => {
  let state = tableState({ hands: { a: Array(4).fill('gearSteal'), c: ['c1', 'c2'] }, seats: { b: { pounds: 30 } } });
  const steps = [];
  for (let level = 1; level <= 4; level += 1) {
    state = played(state, 'a', { card: 'gearSteal', target: 'b', chainTarget: level === 3 ? 'c' : undefined });
    steps.push([state.seats.a.pounds, state.seats.b.pounds]);
  }
  // 1 級：偷 3＋自己 1；2 級：偷 3＋自己 2；3 級：偷 3＋自己 1（另外抽 2、c 棄 1）；4 級：偷 6＋自己 2。
  assert.deepEqual(steps, [[14, 27], [19, 24], [23, 21], [31, 15]]);
  assert.equal(30 - state.seats.b.pounds, 15, 'b lost exactly what was stolen');
});

test('a response card steals from the player it answers, with no chain bonus', () => {
  let state = answered(tableState({ hands: { a: ['trade'], b: ['stealBack'] } }), 'a', { card: 'trade' }, { b: 'stealBack' }).state;
  assert.deepEqual(money(state, 'pounds'), { a: 6, b: 14, c: 10 });
  state = answered(tableState({ hands: { a: ['trade'], b: ['stealBack'] }, seats: { a: { pounds: 3 } } }), 'a', { card: 'trade' }, { b: 'stealBack' }).state;
  assert.deepEqual(money(state, 'pounds'), { a: 0, b: 13, c: 10 }, 'a only had 3');
  // 原牌是 4 級連鎖，響應卡照樣只偷 4。
  state = tableState({ hands: { a: Array(4).fill('trade'), b: ['stealBack'] } });
  for (let count = 0; count < 3; count += 1) {
    const result = answered(state, 'a', { card: 'trade', chainTarget: count === 2 ? 'c' : undefined });
    assert.equal(result.kind, 'resolved');
    state = { ...result.state, pending: null };
  }
  const result = answered(state, 'a', { card: 'trade' }, { b: 'stealBack' });
  assert.equal(result.log.level, 4);
  assert.deepEqual(money(result.state, 'pounds'), { a: 6, b: 14, c: 10 });
});

test('a canceled card steals nothing, and a response that steals from @指定 is still sent back', () => {
  const canceled = answered(tableState({ hands: { a: ['stealPounds'], c: ['cancel'] } }), 'a', { card: 'stealPounds', target: 'b' }, { c: 'cancel' });
  assert.equal(canceled.log.canceled, true);
  assert.deepEqual(money(canceled.state, 'pounds'), { a: 10, b: 10, c: 10 });
  const refused = answered(tableState({ hands: { a: ['trade'], b: ['stealChosen'] } }), 'a', { card: 'trade' }, { b: 'stealChosen' });
  assert.deepEqual(refused.notices, [{ uid: 'b', seq: 1, reason: 'response-needs-target' }]);
});

test('the four spreadsheet forms become steal effects', () => {
  assert.deepEqual(parseEffects('偷英鎊3@指定；偷影響力2@指定', 'self').effects, [steal('pounds', 'chosen', 3), steal('influence', 'chosen', 2)]);
  assert.deepEqual(parseEffects('偷英鎊１＠出牌者、偷 影響力 4 @出牌者', 'self'), { effects: [steal('pounds', 'originalPlayer', 1), steal('influence', 'originalPlayer', 4)], unknown: [] });
  assert.deepEqual(parseEffects('偷英鎊@指定；偷手牌1@指定', 'self').unknown, ['偷英鎊@指定', '偷手牌1@指定'], 'no number, or not pounds or influence: todo');
});

const ACTION_HEADER = '編號,名稱,類型,分類,可回應,所屬階層,張數,英鎊成本,影響力成本,齒輪,效果,牌面文字\n';
const issuesOf = (kind, csv) => checkData({ roles: data.roles, [kind]: convertSheet(kind, csv).data }).errors.map((issue) => formatIssue(issue));

test('the check takes steal only on action cards, only from @指定 or @出牌者, and only positive whole amounts', () => {
  const rows = [
    'a01,甲,一般,,,,1,,,,偷英鎊3@指定,牌面',
    'a02,乙,響應,,,,1,,,,偷影響力2@出牌者,牌面',
    'a03,丙,響應,,,,1,,,,偷英鎊1@指定,牌面',
    'a04,丁,一般,,,,1,,,,偷英鎊3@自己,牌面',
    'a05,戊,一般,,,,1,,,,偷英鎊2@出牌者,牌面',
    'a06,己,一般,,,,1,,,,偷英鎊0@指定,牌面',
    'a07,庚,一般,,,,1,,,,偷影響力-2@指定,牌面',
    'a08,辛,一般,,,,1,,,,偷英鎊1.5@指定,牌面',
    'a09,壬,一般,,,,1,,,,偷英鎊2,牌面',
    'a10,癸,一般,,,,1,,,,偷英鎊2@全體,牌面',
  ];
  assert.deepEqual(issuesOf('actions', `${ACTION_HEADER}${rows.join('\n')}\n`), [
    '錯誤｜actions.json｜a04｜effects（效果）｜第 1 個效果：偷只能對 @指定（一般牌）或 @出牌者（響應卡），現在是「self」',
    '錯誤｜actions.json｜a05｜effects（效果）｜第 1 個效果：@出牌者（originalPlayer）只能用在響應卡',
    '錯誤｜actions.json｜a06｜effects（效果）｜第 1 個效果：偷的 amount 要是 1 以上的整數，現在是 0',
    '錯誤｜actions.json｜a07｜effects（效果）｜第 1 個效果：偷的 amount 要是 1 以上的整數，現在是 -2',
    '錯誤｜actions.json｜a08｜effects（效果）｜第 1 個效果：偷的 amount 要是 1 以上的整數，現在是 1.5',
    '錯誤｜actions.json｜a09｜effects（效果）｜第 1 個效果：偷只能對 @指定（一般牌）或 @出牌者（響應卡），現在是「self」',
    '錯誤｜actions.json｜a10｜effects（效果）｜第 1 個效果：偷只能對 @指定（一般牌）或 @出牌者（響應卡），現在是「all」',
  ]);
  assert.deepEqual(issuesOf('bills', '編號,名稱,年代,通過時效果,不通過時效果,牌面文字\nb01,甲,,偷英鎊2@指定,,牌面\n'), [
    '錯誤｜bills.json｜b01｜onPass（通過時效果）｜第 1 個效果：偷（steal）只能用在行動牌',
  ]);
  assert.deepEqual(issuesOf('events', '編號,名稱,年代,類型,門檻,效果,牌面文字\ne01,甲,,一般,,偷英鎊2@指定,牌面\n'), [
    '錯誤｜events.json｜e01｜effects（效果）｜第 1 個效果：偷（steal）只能用在行動牌',
  ]);
  const handWritten = [card('a01', { effects: [{ op: 'steal', target: 'chosen', amount: 1 }] })];
  assert.deepEqual(checkData({ actions: handWritten }).errors.map((issue) => formatIssue(issue)), [
    '錯誤｜actions.json｜a01｜effects（效果）｜第 1 個效果：偷的 resource 只能是 pounds／influence（英鎊／影響力），現在沒有這一欄',
  ]);
});
