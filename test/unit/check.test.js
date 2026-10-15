// 天命的「判定」欄（M9）：每一種寫法轉成的結構、看不懂的寫法與錯誤訊息、檢查對到法案與階層編號，以及匯入指令報出試算表的列號。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkData, formatIssue, parseCheck } from '../../play/js/data.js';
import { loadDataFolder } from '../../scripts/lib/datafiles.mjs';
import { convertSheet } from '../../scripts/lib/import.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sampleDir = join(root, 'test/fixtures/data-example');
const templateDir = join(root, 'docs/data-templates');
const { data: sample } = await loadDataFolder(sampleDir);
const HINT = '寫法見 DATA-FORMAT「隱藏天命」的判定，例如 法案通過 b06、迷霧 < 60、英鎊最多、英鎊 >= 40、英鎊多於 r5';

test('every form of 判定 becomes a check', () => {
  const cases = [
    ['法案通過 b06', { kind: 'bills', passed: true, bills: ['b06'], atLeast: 1 }],
    ['法案沒通過 b05', { kind: 'bills', passed: false, bills: ['b05'], atLeast: 1 }],
    ['法案都沒通過 b01、b06', { kind: 'bills', passed: false, bills: ['b01', 'b06'], atLeast: 2 }],
    ['法案都通過 b01、b02、b03', { kind: 'bills', passed: true, bills: ['b01', 'b02', 'b03'], atLeast: 3 }],
    ['法案通過至少 2：b01、b06、b02、b03', { kind: 'bills', passed: true, bills: ['b01', 'b06', 'b02', 'b03'], atLeast: 2 }],
    ['法案沒通過至少 1：b01、b02', { kind: 'bills', passed: false, bills: ['b01', 'b02'], atLeast: 1 }],
    ['迷霧 < 60', { kind: 'compare', what: 'fog', op: '<', value: 60 }],
    ['迷霧 >= 60', { kind: 'compare', what: 'fog', op: '>=', value: 60 }],
    ['迷霧最高 > 90', { kind: 'compare', what: 'fogMax', op: '>', value: 90 }],
    ['迷霧 <= 10', { kind: 'compare', what: 'fog', op: '<=', value: 10 }],
    ['英鎊最多', { kind: 'most', what: 'pounds' }],
    ['影響力最多', { kind: 'most', what: 'influence' }],
    ['手牌最多', { kind: 'most', what: 'hand' }],
    ['英鎊 >= 40', { kind: 'compare', what: 'pounds', op: '>=', value: 40 }],
    ['影響力 > 5', { kind: 'compare', what: 'influence', op: '>', value: 5 }],
    ['手牌 < 3', { kind: 'compare', what: 'hand', op: '<', value: 3 }],
    ['英鎊多於 r5', { kind: 'moreThan', what: 'pounds', role: 'r5' }],
    ['影響力多於 r1', { kind: 'moreThan', what: 'influence', role: 'r1' }],
    // 全形字、空白多寡、逗號都可以。
    ['英鎊＞＝４０', { kind: 'compare', what: 'pounds', op: '>=', value: 40 }],
    ['  迷霧最高>90 ', { kind: 'compare', what: 'fogMax', op: '>', value: 90 }],
    ['法案 都 沒通過 b01,b06', { kind: 'bills', passed: false, bills: ['b01', 'b06'], atLeast: 2 }],
    ['法案通過至少２:b01，b06', { kind: 'bills', passed: true, bills: ['b01', 'b06'], atLeast: 2 }],
    ['英鎊 多於  r5', { kind: 'moreThan', what: 'pounds', role: 'r5' }],
  ];
  for (const [text, check] of cases) assert.deepEqual(parseCheck(text), { check }, text);
  for (const blank of ['', '   ', null, undefined]) assert.deepEqual(parseCheck(blank), { check: null });
});

test('unreadable 判定 says why', () => {
  const cases = [
    ['英鎊 = 40', `看不懂這個寫法；${HINT}`],
    ['英鎊比較多', `看不懂這個寫法；${HINT}`],
    ['迷霧最高 90', `看不懂這個寫法；${HINT}`],
    ['英鎊 >= -1', `看不懂這個寫法；${HINT}`],
    ['法案通過 b01、b06', '好幾張法案要寫「法案都通過」「法案都沒通過」或「法案通過至少 N：」'],
    ['法案都通過至少 2：b01、b06', '「都」和「至少 N：」只能擇一'],
    ['法案通過 十小時工作法案', '法案編號只能用英文字母、數字、- 和 _，用頓號隔開，現在是「十小時工作法案」'],
    ['英鎊多於 東區黑幫', '「多於」後面要寫階層編號（例如 r5），現在是「東區黑幫」'],
  ];
  for (const [text, error] of cases) assert.deepEqual(parseCheck(text), { error }, text);
});

test('the destiny sheet writes check only when it has the 判定 column; unreadable text is kept for the check', () => {
  const without = convertSheet('destinies', '編號,所屬階層,天命文字,計分條件,分數\nd01,r1,天命,條件,10\n');
  assert.equal('check' in without.data[0], false, 'an older sheet without the column');
  const sheet = convertSheet('destinies', '編號,所屬階層,天命文字,計分條件,判定,分數,備註\nd01,r1,天命,條件,英鎊最多,10,\nd02,r2,天命,條件,,10,\nd03,r3,天命,條件,英鎊 = 4,10,\n');
  assert.deepEqual([sheet.errors, sheet.notes], [[], []], 'the 判定 column is known');
  assert.deepEqual(sheet.data.map((record) => record.check), [{ kind: 'most', what: 'pounds' }, null, '英鎊 = 4']);
  const issues = checkData({ roles: sample.roles, bills: sample.bills, destinies: sheet.data }).errors.map((issue) => formatIssue(issue));
  assert.deepEqual(issues, [`錯誤｜destinies.json｜d03｜check（判定）｜看不懂「英鎊 = 4」：看不懂這個寫法；${HINT}`]);
});

test('the check needs known bills and roles and a well-formed structure', () => {
  const destiny = (check) => ({ id: 'd09', role: 'r1', text: '天命', score: { text: '條件', points: 10 }, check });
  const problems = (check) =>
    checkData({ roles: sample.roles, bills: sample.bills, destinies: [destiny(check)] }).errors.map((issue) => issue.message);
  const warnings = (check) =>
    checkData({ roles: sample.roles, bills: sample.bills, destinies: [destiny(check)] }).warnings.map((issue) => formatIssue(issue, '警告'));
  // 範例資料的法案只有 b01、b02。
  assert.deepEqual(problems({ kind: 'bills', passed: true, bills: ['b01', 'b02'], atLeast: 2 }), []);
  assert.deepEqual(problems(null), []);
  assert.deepEqual(problems(undefined), []);
  assert.deepEqual(problems({ kind: 'bills', passed: true, bills: ['b01', 'b99'], atLeast: 1 }), ['找不到法案編號「b99」']);
  assert.deepEqual(problems({ kind: 'bills', passed: true, bills: ['b01', 'b02'], atLeast: 3 }), ['判定的「至少」要是 1–2 的整數（列了 2 張法案），現在是 3']);
  assert.deepEqual(problems({ kind: 'bills', passed: true, bills: ['b01', 'b01'], atLeast: 1 }), ['判定的法案重複了，現在是 ["b01","b01"]']);
  assert.deepEqual(problems({ kind: 'bills', passed: 'yes', bills: [], atLeast: 1 }), ['判定的 passed 要是 true 或 false，現在是「yes」', '判定的 bills 要是法案編號的陣列，現在是 []']);
  assert.deepEqual(problems({ kind: 'moreThan', what: 'pounds', role: 'r9' }), ['找不到階層編號「r9」']);
  assert.deepEqual(problems({ kind: 'moreThan', what: 'fog', role: 'r1' }), ['判定的 what 只能是 pounds／influence／hand，現在是「fog」']);
  assert.deepEqual(problems({ kind: 'most', what: 'fogMax' }), ['判定的 what 只能是 pounds／influence／hand，現在是「fogMax」']);
  assert.deepEqual(problems({ kind: 'compare', what: 'fame', op: '=', value: -1 }), [
    '判定的 what 只能是 fog／fogMax／pounds／influence／hand，現在是「fame」',
    '判定的比較符號只能是 > >= < <=，現在是「=」',
    '判定的數值要是 0 以上的整數，現在是 -1',
  ]);
  assert.deepEqual(problems({ kind: 'luck' }), ['判定的 kind 不認得：「luck」，只能是 bills／compare／most／moreThan']);
  assert.deepEqual(problems('迷霧 < 60'), ['要用匯入工具轉成結構，現在是「迷霧 < 60」']);
  assert.deepEqual(problems(5), ['要是判定的結構，空白就填 null，現在是 5']);
  assert.deepEqual(warnings({ kind: 'most', what: 'hand', note: 'x' }), ['警告｜destinies.json｜d09｜check.note｜不認得的欄位，遊戲不會用到']);
  // 「多於」自己的階層：拿到的人就坐那個階層，一定算達成，提醒一聲。
  const own = { id: 'd10', role: 'r1', text: '天命', score: { text: '條件', points: 10 }, check: { kind: 'moreThan', what: 'pounds', role: 'r1' } };
  assert.deepEqual(checkData({ roles: sample.roles, destinies: [own] }).warnings.map((issue) => formatIssue(issue, '警告')), [
    '警告｜destinies.json｜d10｜check（判定）｜「多於 r1」比的是這張天命自己的階層：拿到的人就坐 r1，沒有別人可以比，終局時一定算達成',
  ]);
  // 天命文字最多 500 字（終局時寫進公開的結算，規則只收這麼長）。
  const long = (length) => checkData({ destinies: [{ ...destiny(null), text: '字'.repeat(length) }] }).errors.map((issue) => formatIssue(issue));
  assert.deepEqual(long(500), []);
  assert.deepEqual(long(501), ['錯誤｜destinies.json｜d09｜text（天命文字）｜最多 500 個字（終局時會寫進公開的結算），現在有 501 個字']);
  // 沒有法案或階層的資料只檢查格式，不對編號。
  assert.deepEqual(checkData({ destinies: [destiny({ kind: 'bills', passed: false, bills: ['b77'], atLeast: 1 })] }).errors, []);
});

test('the import command reports an unreadable 判定 on its spreadsheet row', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'card-data-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const source = join(work, 'source');
  await mkdir(source);
  for (const name of await readdir(templateDir)) await copyFile(join(templateDir, name), join(source, name));
  const destinies = await readFile(join(source, 'destinies.csv'), 'utf8');
  await writeFile(join(source, 'destinies.csv'), destinies.replace(',英鎊最多,', ',法案通過 b09,').replace('範例條件（待定）,,', '範例條件（待定）,手牌 ≥ 3,'));
  const run = spawnSync(process.execPath, [join(root, 'scripts/data-import.mjs'), source, '--out', join(work, 'out')], { cwd: root, encoding: 'utf8' });
  const output = run.stdout + run.stderr;
  assert.equal(run.status, 1, output);
  assert.match(output, /錯誤｜destinies\.json｜d01（destinies\.csv 第 2 列）｜check（判定）｜找不到法案編號「b09」/);
  assert.match(output, /錯誤｜destinies\.json｜d02（destinies\.csv 第 3 列）｜check（判定）｜看不懂「手牌 ≥ 3」/);
  assert.match(output, /錯誤 2 筆、警告 0 筆/);
});
