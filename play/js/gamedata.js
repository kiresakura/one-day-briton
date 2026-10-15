// 讀卡牌資料檔（./data/*.json，與網頁同源的靜態檔）並用 data.js 檢查。
// 瀏覽器用 fetch；Node 測試注入自己的讀檔函式。
import { DATA_FILES, checkData, formatIssue } from './data.js';

async function fetchDataFile(kind) {
  const response = await fetch(new URL(`../data/${kind}.json`, import.meta.url));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// readFile(kind) 回傳那個檔解析後的內容。回傳 { data, errors, warnings }：
// errors 不是空的就不能用（讀不到、不是 JSON，或檢查有錯誤），每一筆是一行說明。
export async function loadGameData(readFile = fetchDataFile) {
  const data = {};
  const errors = [];
  await Promise.all(
    DATA_FILES.map(async (kind) => {
      try {
        data[kind] = await readFile(kind);
      } catch (error) {
        errors.push(`錯誤｜${kind}.json｜讀不到：${error.message}`);
      }
    }),
  );
  const result = checkData(data);
  return {
    data,
    errors: [...errors, ...result.errors.map((issue) => formatIssue(issue))],
    warnings: result.warnings.map((issue) => formatIssue(issue, '警告')),
  };
}

// 照編號查階層、行動牌、天命。
export function indexGameData(data) {
  const byId = (list) => new Map((list ?? []).map((record) => [record.id, record]));
  return { roles: byId(data.roles), actions: byId(data.actions), destinies: byId(data.destinies) };
}
