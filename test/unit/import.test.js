import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkData, formatIssue } from '../../play/js/data.js';
import { loadDataFolder } from '../../scripts/lib/datafiles.mjs';
import { convertSheet, importFolder, parseEffects, sheetKind, sourceOf } from '../../scripts/lib/import.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const templateDir = join(root, 'docs/data-templates');
const sampleDir = join(root, 'play/data');
const importScript = join(root, 'scripts/data-import.mjs');

test('effect text becomes structured effects', () => {
  assert.deepEqual(parseEffects('英鎊+5@自己; 迷霧+3', 'self'), {
    effects: [{ op: 'pounds', target: 'self', amount: 5 }, { op: 'fog', amount: 3 }],
    unknown: [],
  });
  assert.deepEqual(parseEffects('影響力-2@其他人；抽牌2@指定；棄牌1@全體', 'self').effects, [
    { op: 'influence', target: 'others', amount: -2 },
    { op: 'draw', target: 'chosen', amount: 2 },
    { op: 'discard', target: 'all', amount: 1 },
  ]);
});

test('effect text without a target uses the default for the kind of card', () => {
  assert.deepEqual(parseEffects('英鎊+5', 'self').effects, [{ op: 'pounds', target: 'self', amount: 5 }]);
  assert.deepEqual(parseEffects('英鎊+5', 'all').effects, [{ op: 'pounds', target: 'all', amount: 5 }]);
});

test('effect text tolerates full-width characters, spaces and other separators', () => {
  const expected = [
    { op: 'pounds', target: 'all', amount: 5 },
    { op: 'fog', amount: -3 },
    { op: 'draw', target: 'self', amount: 2 },
    { op: 'discard', target: 'chosen', amount: 1 },
  ];
  for (const text of [
    '英鎊＋５＠全體；迷霧－３；抽２張@自己；棄牌1張@指定',
    ' 英鎊 +5 @ 全體 , 迷霧 −3 、 抽牌+2@自己\n棄1@指定。',
  ]) {
    assert.deepEqual(parseEffects(text, 'self'), { effects: expected, unknown: [] }, text);
  }
  assert.deepEqual(parseEffects('', 'self'), { effects: [], unknown: [] });
  assert.deepEqual(parseEffects('；；', 'self'), { effects: [], unknown: [] });
});

test('effect text that cannot be read is returned as unknown', () => {
  for (const text of ['偷看一張手牌', '英鎊5@自己', '英鎊+5@大家', '英鎊+5@', '迷霧+3@全體', '抽牌-1', '英鎊+1.5', '英鎊+5@自己@全體', '英鎊+5@constructor']) {
    const { effects, unknown } = parseEffects(text, 'self');
    assert.deepEqual(effects, [], text);
    assert.equal(unknown.length, 1, text);
  }
  assert.deepEqual(parseEffects('英鎊+5@自己；偷看一張手牌', 'self'), {
    effects: [{ op: 'pounds', target: 'self', amount: 5 }],
    unknown: ['偷看一張手牌'],
  });
});

test('a cell with any unreadable effect becomes todo and keeps the original text', () => {
  const csv = '編號,名稱,所屬階層,張數,英鎊成本,影響力成本,齒輪,效果,牌面文字\n'
    + 'a01,甲,,1,,,,英鎊+5@自己；偷看一張手牌,牌面\n'
    + 'a02,乙,r1,2,1,0,齒,抽牌1,牌面\n';
  const sheet = convertSheet('actions', csv);
  assert.deepEqual(sheet.errors, []);
  assert.deepEqual(sheet.data, [
    {
      id: 'a01', name: '甲', role: null, copies: 1, cost: { pounds: 0, influence: 0 }, gear: null,
      effects: [], text: '牌面', todo: true, todoText: '英鎊+5@自己；偷看一張手牌',
    },
    {
      id: 'a02', name: '乙', role: 'r1', copies: 2, cost: { pounds: 1, influence: 0 }, gear: '齒',
      effects: [{ op: 'draw', target: 'self', amount: 1 }], text: '牌面',
    },
  ]);
  assert.deepEqual(sheet.rows, [2, 3]);
  assert.deepEqual(sheet.unknownEffects, [{ row: 2, id: 'a01', column: '效果', parts: ['偷看一張手牌'] }]);
  const { errors, warnings } = checkData({ actions: sheet.data });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].id, 'a01');
});

test('bills default to everyone and label which side is todo', () => {
  const csv = '編號,名稱,年代,通過時效果,不通過時效果,牌面文字\nb01,甲,1847,英鎊-2,全場休戰一回合,牌面\n';
  const [bill] = convertSheet('bills', csv).data;
  assert.deepEqual(bill, {
    id: 'b01', name: '甲', year: '1847',
    onPass: [{ op: 'pounds', target: 'all', amount: -2 }], onFail: [],
    text: '牌面', todo: true, todoText: '不通過時效果：全場休戰一回合',
  });
});

test('event kinds and thresholds', () => {
  const csv = '編號,名稱,年代,類型,門檻,效果,牌面文字\n'
    + 'e01,甲,,一般,,迷霧+5,牌面\n'
    + 'e02,乙,1873,迷霧,60,英鎊-1,牌面\n'
    + 'e03,丙,,迷霧,,迷霧+1,牌面\n'
    + 'e04,丁,,一般,30,迷霧+1,牌面\n'
    + 'e05,戊,,法案,,迷霧+1,牌面\n';
  const events = convertSheet('events', csv).data;
  assert.deepEqual(events[0], { id: 'e01', name: '甲', year: null, kind: 'deck', effects: [{ op: 'fog', amount: 5 }], text: '牌面' });
  assert.deepEqual(events[1], {
    id: 'e02', name: '乙', year: '1873', kind: 'fog', threshold: 60,
    effects: [{ op: 'pounds', target: 'all', amount: -1 }], text: '牌面',
  });
  assert.equal(events[2].threshold, null);
  assert.equal(events[3].threshold, 30);
  assert.equal(events[4].kind, '法案');
  const messages = checkData({ events }).errors.map((issue) => formatIssue(issue));
  assert.deepEqual(messages, [
    '錯誤｜events.json｜e03｜threshold（門檻）｜迷霧事件一定要有門檻',
    '錯誤｜events.json｜e04｜threshold（門檻）｜一般事件不填門檻，現在是 30',
    '錯誤｜events.json｜e05｜kind（類型）｜只能是 deck（一般事件）或 fog（迷霧門檻事件），現在是「法案」',
  ]);
});

test('values that are not numbers are kept so the check can point at them', () => {
  const csv = '編號,名稱,所屬階層,張數,英鎊成本,影響力成本,齒輪,效果,牌面文字\na01,甲,,兩,,,,,牌面\n,乙,,１,,,,英鎊+1,牌面\n';
  const imported = { sources: { actions: { file: '卡表 - 行動牌.csv', rows: [2, 3], fieldRows: {} } } };
  const sheet = convertSheet('actions', csv, '卡表 - 行動牌.csv');
  assert.equal(sheet.data[0].copies, '兩');
  assert.equal(sheet.data[1].copies, 1);
  const messages = checkData({ actions: sheet.data }).errors.map((issue) => formatIssue(issue, '錯誤', sourceOf(imported, issue)));
  assert.deepEqual(messages, [
    '錯誤｜actions.json｜第 2 筆（卡表 - 行動牌.csv 第 3 列）｜id（編號）｜必填，只能用英文字母、數字、- 和 _，最多 32 個字，現在是「」',
    '錯誤｜actions.json｜a01（卡表 - 行動牌.csv 第 2 列）｜copies（張數）｜要是 1 以上的整數，現在是「兩」',
  ]);
});

test('roles collect numbered privilege and mission columns', () => {
  const csv = '編號,名稱,薪水,特權1,特權2,使命1,使命2,使命3,使命4,備註,自己的欄\nr1,甲,5,特一,,使一,使二,,使四,隨便寫,x\n';
  const sheet = convertSheet('roles', csv);
  assert.deepEqual(sheet.data, [{ id: 'r1', name: '甲', salary: 5, privileges: ['特一'], missions: ['使一', '使二', '使四'] }]);
  assert.deepEqual(sheet.notes, ['roles.csv：這幾欄不會匯入「自己的欄」']);
});

test('destinies keep the score text and an optional number', () => {
  const csv = '編號,所屬階層,天命文字,計分條件,分數\nd01,r2,天命,條件,4\nd02,,天命,條件,\n';
  assert.deepEqual(convertSheet('destinies', csv).data, [
    { id: 'd01', role: 'r2', text: '天命', score: { text: '條件', points: 4 } },
    { id: 'd02', role: null, text: '天命', score: { text: '條件', points: null } },
  ]);
});

test('settings rows become one object in a fixed order', () => {
  const csv = '項目,值,說明\n迷霧門檻,30/60/90,\n起始手牌,４,\n白晝每人提醒秒數,45,\n不知道的項目,1,\n';
  const sheet = convertSheet('settings', csv);
  assert.deepEqual(sheet.errors, []);
  assert.deepEqual(sheet.data, { startingHand: 4, reminderSeconds: { day: 45 }, fogThresholds: [30, 60, 90] });
  assert.deepEqual(Object.keys(sheet.data), ['startingHand', 'reminderSeconds', 'fogThresholds']);
  assert.deepEqual(sheet.fieldRows, { startingHand: 3, 'reminderSeconds.day': 4, fogThresholds: 2 });
  assert.deepEqual(sheet.notes, ['settings.csv 第 5 列：不認得的設定項目「不知道的項目」，略過']);
  assert.deepEqual(convertSheet('settings', '項目,值\n迷霧門檻,"30, 60、90"\n').data.fogThresholds, [30, 60, 90]);
  assert.match(convertSheet('settings', '項目,值\n起始手牌,4\n起始手牌,5\n').errors[0], /第 3 列：設定項目「起始手牌」和第 2 列重複/);
  // 沒填到的項目由檢查報出來。
  const missing = checkData({ settings: sheet.data }).errors.find((issue) => issue.field === 'handLimit');
  assert.equal(formatIssue(missing), '錯誤｜settings.json｜handLimit（手牌上限）｜要是 1 以上的整數，現在沒有這一欄');
});

test('a sheet without the template columns is rejected', () => {
  const sheet = convertSheet('events', '編號,名稱,效果\ne01,甲,迷霧+1\n', 'events.csv');
  assert.deepEqual(sheet.errors, ['events.csv：少了欄位「年代」「類型」「門檻」「牌面文字」（第一列的欄名要和樣板一樣）']);
  assert.match(convertSheet('events', '編號,"名稱\n').errors[0], /^events\.csv：引號沒有關閉/);
});

test('file names are matched to the kind of data', () => {
  assert.equal(sheetKind('events.csv'), 'events');
  assert.equal(sheetKind('EVENTS.CSV'), 'events');
  assert.equal(sheetKind('事件.csv'), 'events');
  assert.equal(sheetKind('一日英國人卡表 - 行動牌.csv'), 'actions');
  assert.equal(sheetKind('folder/隱藏天命.csv'), 'destinies');
  assert.equal(sheetKind('settings.csv'), 'settings');
  assert.equal(sheetKind('events-prefilled.csv'), null);
  assert.equal(sheetKind('筆記.csv'), null);
});

test('importing the templates reproduces the sample data exactly', async () => {
  const imported = await importFolder(templateDir);
  assert.deepEqual(imported.errors, []);
  assert.deepEqual(imported.skipped, []);
  assert.deepEqual(imported.notes, []);
  const { data: sample, errors } = await loadDataFolder(sampleDir);
  assert.deepEqual(errors, []);
  assert.deepEqual(imported.data, sample);
  const check = checkData(imported.data);
  assert.deepEqual([check.errors, check.warnings], [[], []]);
});

test('every template starts with a byte order mark', async () => {
  const names = (await readdir(templateDir)).filter((name) => name.endsWith('.csv')).sort();
  assert.deepEqual(names, ['actions.csv', 'bills.csv', 'destinies.csv', 'events.csv', 'roles.csv', 'settings.csv']);
  for (const name of names) {
    const bytes = await readFile(join(templateDir, name));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], name);
  }
});

function runImport(...args) {
  const run = spawnSync(process.execPath, [importScript, ...args], { cwd: root, encoding: 'utf8' });
  return { status: run.status, output: run.stdout + run.stderr };
}

test('the import command writes the files and checks them', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'card-data-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const out = join(work, 'out');

  const ok = runImport(templateDir, '--out', out);
  assert.equal(ok.status, 0, ok.output);
  assert.match(ok.output, /錯誤 0 筆、警告 0 筆/);
  for (const name of await readdir(sampleDir)) {
    assert.equal(await readFile(join(out, name), 'utf8'), await readFile(join(sampleDir, name), 'utf8'), name);
  }

  // 檢查錯誤：檔照寫，訊息對回試算表的列號，結束碼非 0。
  const broken = join(work, 'broken');
  await copyTemplates(broken);
  const actions = await readFile(join(broken, 'actions.csv'), 'utf8');
  await writeFile(join(broken, 'actions.csv'), actions.replace('a01,範例行動牌一,,2,', 'a01,範例行動牌一,r9,0,').replace('英鎊+5@自己', '英鎊+5@自己；偷看手牌'));
  const failed = runImport(broken, '--out', join(work, 'out2'));
  assert.equal(failed.status, 1, failed.output);
  assert.match(failed.output, /錯誤｜actions\.json｜a01（actions\.csv 第 2 列）｜role（所屬階層）｜找不到階層編號「r9」/);
  assert.match(failed.output, /錯誤｜actions\.json｜a01（actions\.csv 第 2 列）｜copies（張數）｜要是 1 以上的整數，現在是 0/);
  assert.match(failed.output, /actions\.csv 第 2 列（a01）效果：「偷看手牌」/);
  assert.match(failed.output, /警告｜actions\.json｜a01（actions\.csv 第 2 列）｜todo（效果）/);
  assert.match(failed.output, /錯誤 2 筆、警告 1 筆/);
});

test('the import command writes nothing when a sheet cannot be read', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'card-data-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const source = join(work, 'source');
  await copyTemplates(source);
  await writeFile(join(source, 'events.csv'), '編號,名稱\ne01,甲\n');
  await writeFile(join(source, 'bills.csv'), Buffer.from([0xbd, 0xe6, 0xae, 0xd7, 0x0a]));
  await writeFile(join(source, 'notes.csv'), 'x\n');
  const out = join(work, 'out');
  const run = runImport(source, '--out', out);
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /略過 notes\.csv/);
  assert.match(run.output, /錯誤｜bills\.csv：不是 UTF-8 編碼/);
  assert.match(run.output, /錯誤｜events\.csv：少了欄位/);
  assert.match(run.output, /沒有寫入任何檔案/);
  await assert.rejects(readdir(out), { code: 'ENOENT' });

  const usage = runImport();
  assert.equal(usage.status, 2);
  assert.match(usage.output, /用法：npm run data:import -- <CSV 資料夾>/);
});

async function copyTemplates(target) {
  await mkdir(target, { recursive: true });
  for (const name of await readdir(templateDir)) await copyFile(join(templateDir, name), join(target, name));
}
