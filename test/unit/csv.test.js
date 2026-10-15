import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, readTable } from '../../scripts/lib/csv.mjs';

test('plain rows split on commas and line breaks', () => {
  assert.deepEqual(parseCsv('編號,名稱\na01,範例\n'), [['編號', '名稱'], ['a01', '範例']]);
  assert.deepEqual(parseCsv('a,,c\n,\n'), [['a', '', 'c'], ['', '']]);
  // 檔尾沒有換行也一樣；檔尾的換行不會多出一列。
  assert.deepEqual(parseCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseCsv(''), []);
});

test('quoted cells may hold commas, quotes and line breaks', () => {
  const text = 'id,text\na01,"拿 5 英鎊, 再抽 1 張"\na02,"他說：""出牌"""\na03,"第一行\n第二行"\n';
  assert.deepEqual(parseCsv(text), [
    ['id', 'text'],
    ['a01', '拿 5 英鎊, 再抽 1 張'],
    ['a02', '他說："出牌"'],
    ['a03', '第一行\n第二行'],
  ]);
  assert.deepEqual(parseCsv('"",x\n'), [['', 'x']]);
  assert.deepEqual(parseCsv('"a,b",c'), [['a,b', 'c']]);
});

test('CRLF and CR line endings work, also inside quoted cells', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseCsv('a,b\rc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseCsv('a,"x\r\ny"\r\n'), [['a', 'x\ny']]);
});

test('a leading byte order mark is dropped', () => {
  const text = '﻿編號,名稱\r\nr1,範例階層一\r\n';
  assert.deepEqual(parseCsv(text)[0], ['編號', '名稱']);
  assert.deepEqual(readTable(text).header, ['編號', '名稱']);
  // 只有開頭的 BOM 會拿掉。
  assert.deepEqual(parseCsv('a,﻿b'), [['a', '﻿b']]);
});

test('a quote in the middle of a cell is kept as is', () => {
  assert.deepEqual(parseCsv('5"x,b\n'), [['5"x', 'b']]);
});

test('an unclosed quote is an error that names the line', () => {
  assert.throws(() => parseCsv('a,b\nc,"沒有結尾\nd,e\n'), /引號沒有關閉：第 2 行/);
});

test('readTable gives spreadsheet row numbers and trimmed cells', () => {
  const table = readTable('﻿ 編號 ,名稱,,備註\nr1, 範例階層一 ,x,\n,,,\n\nr2,"範例\n階層二"\nr3\n');
  assert.deepEqual(table.header, ['編號', '名稱', '備註']);
  assert.deepEqual(table.rows, [
    { row: 2, values: { 編號: 'r1', 名稱: '範例階層一', 備註: '' } },
    { row: 5, values: { 編號: 'r2', 名稱: '範例\n階層二', 備註: '' } },
    { row: 6, values: { 編號: 'r3', 名稱: '', 備註: '' } },
  ]);
});

test('readTable normalises full-width header characters', () => {
  assert.deepEqual(readTable('特權１,使命１\n').header, ['特權1', '使命1']);
});

test('readTable rejects empty files and repeated column names', () => {
  assert.throws(() => readTable(''), /檔案是空的/);
  assert.throws(() => readTable('編號,名稱,編號\n'), /重複的欄名「編號」/);
});
