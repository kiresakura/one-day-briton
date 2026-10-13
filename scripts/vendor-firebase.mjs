// 把官方 Firebase JS SDK 的瀏覽器用 ESM 檔複製到 play/vendor/firebase/，可重複執行。
// 原檔會從 https://www.gstatic.com/firebasejs/<版本>/ 匯入彼此，這裡改寫成相對路徑，
// 讓頁面只向自己的主機要檔案。用法：npm run vendor
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const MODULES = ['app', 'auth', 'database'];
const source = new URL('../node_modules/firebase/', import.meta.url);
const target = new URL('../play/vendor/firebase/', import.meta.url);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const { version, license } = JSON.parse(await readFile(new URL('package.json', source), 'utf8'));

// from"https://www.gstatic.com/firebasejs/x.y.z/firebase-app.js" 與 import("…") 兩種寫法都處理。
const cdnImport = /(\bfrom\s*|\bimport\s*\(\s*)(["'])https:\/\/www\.gstatic\.com\/firebasejs\/[^"'/]+\/(firebase-[a-z-]+\.js)\2/g;
const anyRemoteImport = /(\bfrom\s*|\bimport\s*\(\s*)(["'])https?:\/\//;
const sourceMapComment = /\n\/\/# sourceMappingURL=\S+\s*$/;

await mkdir(target, { recursive: true });

const files = [];
for (const name of MODULES) {
  const file = `firebase-${name}.js`;
  const original = await readFile(new URL(file, source), 'utf8');
  let rewrites = 0;
  const output = original
    .replace(cdnImport, (match, keyword, quote, imported) => {
      rewrites += 1;
      return `${keyword}${quote}./${imported}${quote}`;
    })
    .replace(sourceMapComment, '\n');
  if (anyRemoteImport.test(output)) {
    throw new Error(`${file} 改寫後仍有對外部主機的匯入，請檢查改寫規則`);
  }
  await writeFile(new URL(file, target), output);
  files.push({ file, rewrites, bytes: Buffer.byteLength(output), source: sha256(original), output: sha256(output) });
}

const lines = [
  `package: firebase (npm)`,
  `version: ${version}`,
  `license: ${license}（全文見同目錄 LICENSE）`,
  `origin:  node_modules/firebase/firebase-{${MODULES.join(',')}}.js`,
  `changes: 對 https://www.gstatic.com/firebasejs/${version}/ 的模組匯入改寫為相對路徑；`,
  `         移除檔尾的 sourceMappingURL 註解（未附 .map 檔）。其餘內容未更動。`,
  `regenerate: npm run vendor（scripts/vendor-firebase.mjs）`,
  '',
  ...files.flatMap(({ file, rewrites, bytes, source: before, output: after }) => [
    `${file}  ${bytes} bytes  改寫匯入 ${rewrites} 處`,
    `  sha256 原檔  ${before}`,
    `  sha256 本檔  ${after}`,
  ]),
  '',
];
await writeFile(new URL('VERSION.txt', target), lines.join('\n'));

// 授權全文取自同一批相依套件內的 Apache-2.0 標準條文。
await copyFile(new URL('../node_modules/google-auth-library/LICENSE', import.meta.url), new URL('LICENSE', target));

console.log(`firebase ${version} → play/vendor/firebase/`);
for (const { file, rewrites, bytes } of files) console.log(`  ${file}  ${bytes} bytes  rewrites: ${rewrites}`);
