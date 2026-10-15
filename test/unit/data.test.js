import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DATA_FILES, checkData, formatIssue } from '../../play/js/data.js';
import { checkDataFolder, loadDataFolder } from '../../scripts/lib/datafiles.mjs';

const sampleDir = fileURLToPath(new URL('../../play/data/', import.meta.url));
const { data: sample } = await loadDataFolder(sampleDir);

// 每個測試拿一份可以隨便改的範例資料。
const fresh = () => structuredClone(sample);

function errorsOf(data) {
  return checkData(data).errors;
}

function assertError(data, expected) {
  const errors = errorsOf(data);
  const found = errors.find((issue) => Object.entries(expected).every(([key, value]) =>
    value instanceof RegExp ? value.test(issue[key]) : issue[key] === value));
  assert.ok(found, `沒有找到 ${JSON.stringify(expected, (key, value) => (value instanceof RegExp ? String(value) : value))}；實際：${JSON.stringify(errors)}`);
  return found;
}

test('the sample data in play/data has no errors and no warnings', async () => {
  const result = await checkDataFolder(sampleDir);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(Object.keys(result.data), DATA_FILES);
});

test('the sample data is clearly marked as sample', () => {
  for (const kind of ['roles', 'actions', 'bills', 'events']) {
    for (const record of sample[kind]) assert.match(record.name, /^範例/, `${kind} ${record.id}`);
  }
  for (const record of sample.destinies) assert.match(record.text, /^範例/);
});

test('settings hold the agreed provisional values', () => {
  assert.deepEqual(sample.settings, {
    startingHand: 4,
    startingPounds: 10,
    startingInfluence: 3,
    handLimit: 7,
    drawPerSunrise: 2,
    maxPlaysPerTurn: 4,
    reminderSeconds: { sunrise: 60, day: 60, dusk: 120, night: 120 },
    duskRevealSeconds: 3,
    fogThresholds: [30, 60, 90],
    sunsetMinutes: 75,
  });
  assert.equal(sample.roles.length, 6);
  for (const role of sample.roles) assert.equal(role.salary, 5);
});

test('missing required fields are errors', () => {
  const data = fresh();
  delete data.actions[0].name;
  data.events[0].text = '  ';
  delete data.roles[1].salary;
  delete data.actions[1].gear;
  delete data.settings.handLimit;
  assertError(data, { file: 'actions.json', id: 'a01', field: 'name', label: '名稱', message: /必填/ });
  assertError(data, { file: 'events.json', id: 'e01', field: 'text', message: /必填/ });
  assertError(data, { file: 'roles.json', id: 'r2', field: 'salary', message: /沒有這一欄/ });
  assertError(data, { file: 'actions.json', id: 'a02', field: 'gear', message: /沒有就填 null/ });
  assertError(data, { file: 'settings.json', field: 'handLimit', label: '手牌上限' });
});

test('ids must be present, well formed and unique within a file', () => {
  const data = fresh();
  data.actions[1].id = 'a01';
  data.bills[0].id = '法案一';
  delete data.destinies[1].id;
  const duplicate = assertError(data, { file: 'actions.json', index: 1, id: 'a01', field: 'id', message: /和第 1 筆重複/ });
  assert.equal(formatIssue(duplicate), '錯誤｜actions.json｜a01｜id（編號）｜和第 1 筆重複');
  assertError(data, { file: 'bills.json', index: 0, field: 'id', message: /英文字母/ });
  const missing = assertError(data, { file: 'destinies.json', index: 1, id: null, field: 'id' });
  assert.match(formatIssue(missing), /^錯誤｜destinies\.json｜第 2 筆｜id（編號）｜/);
  // 不同檔可以用同一個編號。
  const shared = fresh();
  shared.events[0].id = 'a01';
  assert.deepEqual(errorsOf(shared), []);
});

test('numbers must be integers within range', () => {
  const data = fresh();
  data.actions[0].copies = 0;
  data.actions[1].cost.pounds = -1;
  data.actions[1].cost.influence = 1.5;
  data.roles[0].salary = '5';
  data.events[1].threshold = 101;
  data.settings.fogThresholds = [60, 30];
  data.settings.reminderSeconds.dusk = 0;
  assertError(data, { id: 'a01', field: 'copies', label: '張數', message: /1 以上的整數，現在是 0/ });
  assertError(data, { id: 'a02', field: 'cost.pounds', label: '英鎊成本', message: /0 以上/ });
  assertError(data, { id: 'a02', field: 'cost.influence', message: /現在是 1\.5/ });
  assertError(data, { id: 'r1', field: 'salary', message: /現在是「5」/ });
  assertError(data, { id: 'e02', field: 'threshold', message: /0–100/ });
  assertError(data, { file: 'settings.json', field: 'fogThresholds', message: /由小到大/ });
  assertError(data, { file: 'settings.json', field: 'reminderSeconds.dusk', label: '黃昏提醒秒數' });

  const edges = fresh();
  edges.events[1].threshold = 0;
  edges.settings.fogThresholds = [0, 30, 60, 90];
  edges.actions[0].cost = { pounds: 0, influence: 0 };
  assert.deepEqual(errorsOf(edges), []);
  edges.events[1].threshold = 100;
  edges.settings.fogThresholds = [30, 60, 90, 100];
  assert.deepEqual(errorsOf(edges), []);
});

test('role references must point at an existing role', () => {
  const data = fresh();
  data.actions[1].role = 'r9';
  data.destinies[0].role = '';
  assertError(data, { file: 'actions.json', id: 'a02', field: 'role', label: '所屬階層', message: /找不到階層編號「r9」/ });
  assertError(data, { file: 'destinies.json', id: 'd01', field: 'role' });
  const unassigned = fresh();
  unassigned.actions[1].role = null;
  assert.deepEqual(errorsOf(unassigned), []);
});

test('effect ops and targets must be known, and fit the kind of card', () => {
  const data = fresh();
  data.actions[0].effects = [{ op: 'steal', target: 'self', amount: 1 }];
  data.actions[1].effects = [
    { op: 'pounds', target: 'me', amount: 1 },
    { op: 'draw', target: 'self', amount: 0 },
    { op: 'fog', target: 'all', amount: 3 },
    { op: 'influence', target: 'others', amount: 0 },
  ];
  data.events[0].effects = [{ op: 'pounds', target: 'self', amount: 1 }];
  data.bills[0].onFail = [{ op: 'pounds', target: 'others', amount: 1 }];
  data.bills[1].onPass = [{ op: 'fog', amount: 101 }];
  assertError(data, { id: 'a01', field: 'effects', message: /第 1 個效果的 op 不認得：「steal」/ });
  assertError(data, { id: 'a02', field: 'effects', message: /第 1 個效果的 target 不認得：「me」/ });
  assertError(data, { id: 'a02', field: 'effects', message: /第 2 個效果：draw 的 amount 要是 1 以上/ });
  assertError(data, { id: 'a02', field: 'effects', message: /第 3 個效果：迷霧是全桌一個值，不寫 target/ });
  assertError(data, { id: 'a02', field: 'effects', message: /第 4 個效果：influence 的 amount/ });
  assertError(data, { id: 'e01', field: 'effects', message: /事件沒有出牌的人/ });
  assertError(data, { id: 'b01', field: 'onFail', label: '不通過時效果', message: /法案沒有出牌的人/ });
  assertError(data, { id: 'b02', field: 'onPass', message: /-100～100/ });
});

test('role targets need a known role, and cancel takes no target or amount', () => {
  const data = fresh();
  data.events[0].effects = [{ op: 'pounds', target: 'role', amount: 1 }];
  data.bills[0].onPass = [{ op: 'influence', target: 'role', role: 'r9', amount: 1 }];
  data.actions[2].effects = [{ op: 'cancel', amount: 1 }, { op: 'cancel', target: 'originalPlayer' }];
  data.actions[1].effects = [{ op: 'draw', target: 'role', role: 'r6', amount: 1 }];
  assertError(data, { id: 'e01', field: 'effects', message: '第 1 個效果：target 是 role 時要在 role 寫階層編號，現在沒有這一欄' });
  assertError(data, { id: 'b01', field: 'onPass', message: '第 1 個效果：找不到階層編號「r9」' });
  assertError(data, { id: 'a03', field: 'effects', message: '第 1 個效果：抵銷不寫 target 和 amount' });
  assertError(data, { id: 'a03', field: 'effects', message: '第 2 個效果：抵銷不寫 target 和 amount' });
  assert.equal(errorsOf(data).filter((issue) => issue.id === 'a02').length, 0);

  // role 只跟著 target: role；其他對象多寫了 role 是不認得的欄位。
  const extra = fresh();
  extra.actions[0].effects = [{ op: 'pounds', target: 'self', role: 'r1', amount: 1 }];
  const { errors, warnings } = checkData(extra);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.map((issue) => formatIssue(issue, '警告')), ['警告｜actions.json｜a01｜effects（效果）｜第 1 個效果有不認得的欄位 role']);
});

test('fog events need a threshold and deck events must not have one', () => {
  const data = fresh();
  delete data.events[1].threshold;
  data.events[0].threshold = 30;
  assertError(data, { id: 'e02', field: 'threshold', label: '門檻', message: '迷霧事件一定要有門檻' });
  assertError(data, { id: 'e01', field: 'threshold', message: /一般事件不填門檻/ });

  const kinds = fresh();
  kinds.events[0].kind = '法案';
  assertError(kinds, { id: 'e01', field: 'kind', message: /deck（一般事件）或 fog/ });
});

test('action cards are normal or response cards, and only response cards say what they answer', () => {
  assert.deepEqual(sample.actions.map((card) => [card.kind, card.respondsTo]), [
    ['play', undefined],
    ['play', undefined],
    ['response', null],
    ['response', ['範例分類甲']],
  ]);
  const data = fresh();
  data.actions[0].kind = '響應';
  data.actions[1].respondsTo = ['範例分類甲'];
  data.actions[1].category = '';
  delete data.actions[2].respondsTo;
  data.actions[3].respondsTo = [];
  assertError(data, { id: 'a01', field: 'kind', label: '類型', message: /只能是 play（一般牌）或 response（響應卡），現在是「響應」/ });
  assertError(data, { id: 'a02', field: 'respondsTo', label: '可回應', message: /一般牌不填可回應，現在是 \["範例分類甲"\]/ });
  assertError(data, { id: 'a02', field: 'category', label: '分類', message: /沒有就填 null/ });
  assertError(data, { id: 'a03', field: 'respondsTo', message: '響應卡要寫可回應哪些分類，任何牌都能回應就填 null' });
  assertError(data, { id: 'a04', field: 'respondsTo', message: /任何牌都能回應就填 null，現在是 \[\]/ });

  const blank = fresh();
  blank.actions[3].respondsTo = ['範例分類甲', ' '];
  assertError(blank, { id: 'a04', field: 'respondsTo', message: /第 2 項要是不空白的文字/ });

  // 一般牌寫 respondsTo: null 也可以，和一般事件的 threshold 一樣。
  const fine = fresh();
  fine.actions[0].respondsTo = null;
  assert.deepEqual(errorsOf(fine), []);
});

test('a response card naming a category no card has is a warning', () => {
  const data = fresh();
  data.actions[3].respondsTo = ['範例分類甲', '範例分類乙'];
  const { errors, warnings } = checkData(data);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.map((issue) => formatIssue(issue, '警告')), [
    '警告｜actions.json｜a04｜respondsTo（可回應）｜沒有任何行動牌的分類是「範例分類乙」，這一項回應不到任何牌',
  ]);
  // 分類改名之後，原本對得上的那一項也會被提醒。
  data.actions[1].category = '範例分類丙';
  assert.equal(checkData(data).warnings.length, 2);
});

test('todo effects are warnings only', () => {
  const data = fresh();
  Object.assign(data.actions[0], { effects: [], todo: true, todoText: '偷看指定玩家的一張手牌' });
  Object.assign(data.bills[0], { onPass: [], todo: true });
  const { errors, warnings } = checkData(data);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 2);
  assert.equal(
    formatIssue(warnings[0], '警告'),
    '警告｜actions.json｜a01｜todo（效果）｜效果還沒換算成結構（todo）：「偷看指定玩家的一張手牌」',
  );
  assert.equal(warnings[1].id, 'b01');

  data.actions[0].todo = 'yes';
  assertError(data, { id: 'a01', field: 'todo', message: /true 或 false/ });
});

test('other warnings: no effects, unknown fields, fog threshold not in settings, role count', () => {
  const data = fresh();
  data.events[0].effects = [];
  data.actions[0].copys = 3;
  data.events[1].threshold = 45;
  data.roles.pop();
  const { errors, warnings } = checkData(data);
  assert.deepEqual(errors, []);
  const messages = warnings.map((issue) => formatIssue(issue, '警告'));
  assert.deepEqual(messages, [
    '警告｜actions.json｜a01｜copys｜不認得的欄位，遊戲不會用到',
    '警告｜events.json｜e01｜effects（效果）｜沒有任何效果；如果是故意的可以不管',
    '警告｜events.json｜e02｜threshold（門檻）｜設定的迷霧門檻（30／60／90）裡沒有 45，這張不會被觸發',
    '警告｜roles.json｜規則是 6 個階層，現在有 5 個',
  ]);
  // 法案只要通過或不通過其中一邊有效果就不提醒。
  assert.equal(sample.bills[1].onFail.length, 0);
});

test('files with the wrong shape are reported, missing ones are skipped', () => {
  assertError({ actions: {} }, { file: 'actions.json', field: null, message: /最外層要是陣列/ });
  assertError({ settings: [] }, { file: 'settings.json', message: /最外層要是物件/ });
  assertError({ roles: ['r1'] }, { file: 'roles.json', index: 0, message: /每一筆要是物件/ });
  // 沒有階層檔時不檢查參照（讀檔時會另外報「找不到」）。
  const { roles, ...withoutRoles } = fresh();
  assert.equal(roles.length, 6);
  assert.deepEqual(errorsOf(withoutRoles), []);
});
