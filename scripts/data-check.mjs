// 檢查卡牌資料檔：必填欄位、編號、數字範圍、階層參照、效果的寫法、迷霧事件的門檻。
// 有錯誤就逐筆列出並以非 0 結束；只有警告（例如效果還沒換算）照樣通過。
// 用法：npm run data:check（預設檢查 play/data/），或 npm run data:check -- <資料夾>
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDataFolder, printReport } from './lib/datafiles.mjs';

const dir = resolve(process.argv[2] ?? fileURLToPath(new URL('../play/data/', import.meta.url)));
const result = await checkDataFolder(dir);
printReport(result, relative(process.cwd(), dir) || '.');
process.exitCode = result.errors.length ? 1 : 0;
