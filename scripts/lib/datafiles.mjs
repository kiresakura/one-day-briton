// 讀寫 play/data/ 的資料檔，並把檢查結果印成一行一筆。data-check 與 data-import 共用。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_FILES, DATA_LABELS, checkData, formatIssue } from '../../play/js/data.js';

// 寫出的格式固定（兩格縮排、檔尾換行），同樣的資料匯入兩次會得到一模一樣的檔。
export function serializeData(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// 回傳 { data, errors }：data 只放讀得到、解析得了的檔；找不到或不是 JSON 的記在 errors。
export async function loadDataFolder(dir) {
  const data = {};
  const errors = [];
  const fail = (file, message) => errors.push({ file, index: null, id: null, field: null, label: null, message });
  for (const kind of DATA_FILES) {
    const file = `${kind}.json`;
    let text;
    try {
      text = await readFile(join(dir, file), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fail(file, '找不到這個檔');
      continue;
    }
    try {
      data[kind] = JSON.parse(text.replace(/^﻿/, ''));
    } catch (error) {
      fail(file, `不是正確的 JSON：${error.message}`);
    }
  }
  return { data, errors };
}

export async function checkDataFolder(dir) {
  const { data, errors: loadErrors } = await loadDataFolder(dir);
  const { errors, warnings } = checkData(data);
  return { data, errors: [...loadErrors, ...errors], warnings };
}

// source(issue) 可回傳額外的出處（例如試算表的第幾列），印在編號後面。
export function printReport({ data, errors, warnings }, dirLabel, { source = () => null, log = console.log } = {}) {
  const counts = DATA_FILES.slice(1)
    .filter((kind) => Array.isArray(data[kind]))
    .map((kind) => `${DATA_LABELS[kind]} ${data[kind].length} 筆`);
  log(`檢查 ${dirLabel}：${counts.join('、') || '沒有可讀的資料'}`);
  for (const issue of errors) log(formatIssue(issue, '錯誤', source(issue)));
  for (const issue of warnings) log(formatIssue(issue, '警告', source(issue)));
  log(`錯誤 ${errors.length} 筆、警告 ${warnings.length} 筆${errors.length ? '：請照上面逐筆修正' : ''}`);
}
