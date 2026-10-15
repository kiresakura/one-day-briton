// 把試算表匯出的 CSV 轉成卡牌資料檔（JSON），寫完自動檢查。
// 用法：npm run data:import -- <CSV 資料夾> [--out <輸出資料夾>]（預設寫到 play/data/）
// 有讀不下去的問題（缺欄位、引號沒關、不是 UTF-8）時一個檔都不寫；
// 寫完後檢查出的錯誤逐筆列出（附試算表的列號），並以非 0 結束。
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DATA_FILES, DATA_LABELS } from '../play/js/data.js';
import { checkDataFolder, printReport, serializeData } from './lib/datafiles.mjs';
import { importFolder, sourceOf } from './lib/import.mjs';

const USAGE = '用法：npm run data:import -- <CSV 資料夾> [--out <輸出資料夾>]';
const shown = (dir) => relative(process.cwd(), dir) || '.';

async function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (args.positionals.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  const sourceDir = resolve(args.positionals[0]);
  const outDir = resolve(args.values.out ?? fileURLToPath(new URL('../play/data/', import.meta.url)));

  const imported = await importFolder(sourceDir);
  console.log(`匯入 ${shown(sourceDir)} → ${shown(outDir)}`);
  for (const name of imported.skipped) console.log(`  略過 ${name}：認不出是哪一種資料（檔名見 docs/DATA-FORMAT.md）`);
  for (const note of imported.notes) console.log(`  提醒：${note}`);
  if (imported.errors.length === 0 && Object.keys(imported.data).length === 0) {
    imported.errors.push('資料夾裡沒有認得的 CSV');
  }
  if (imported.errors.length > 0) {
    for (const message of imported.errors) console.log(`錯誤｜${message}`);
    console.log('沒有寫入任何檔案。');
    return 1;
  }

  await mkdir(outDir, { recursive: true });
  for (const kind of DATA_FILES.filter((name) => name in imported.data)) {
    const value = imported.data[kind];
    await writeFile(join(outDir, `${kind}.json`), serializeData(value));
    const { file, fieldRows } = imported.sources[kind];
    const size = Array.isArray(value) ? `${value.length} 筆` : `${Object.keys(fieldRows).length} 項`;
    console.log(`  ${kind}.json ← ${file}（${DATA_LABELS[kind]} ${size}）`);
  }
  if (imported.unknownEffects.length > 0) {
    console.log('看不懂、先標成 todo 的效果：');
    for (const { file, row, id, column, parts } of imported.unknownEffects) {
      console.log(`  ${file} 第 ${row} 列（${id || '沒有編號'}）${column}：${parts.map((part) => `「${part}」`).join('、')}`);
    }
  }

  const result = await checkDataFolder(outDir);
  printReport(result, shown(outDir), { source: (issue) => sourceOf(imported, issue) });
  return result.errors.length > 0 ? 1 : 0;
}

process.exitCode = await main();
