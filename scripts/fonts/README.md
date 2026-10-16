# 自行託管字型

`play/fonts/` 裡的四個 woff2 是從開源字型裁出來的子集：只收畫面上會用到的字，檔案才小得起來。字表、建置與檢查都在這個資料夾。

| 檔案 | 字型 | 字重 | 收哪些字 |
|---|---|---|---|
| `NotoSerifTC-Bold.woff2` | Noto Serif TC | 700 | 中文字表 |
| `NotoSerifTC-Black.woff2` | Noto Serif TC | 900 | 中文字表 |
| `Cinzel-Bold.woff2` | Cinzel | 700 | 拉丁字表 |
| `CormorantGaramond-SemiBold.woff2` | Cormorant Garamond（正體，不是斜體） | 600 | 拉丁字表 |

## 來源與授權

原始字型都取自 [google/fonts](https://github.com/google/fonts)，網址釘在固定版本 `1d0e46c7933245c8180fe83e47917961c913bbdb`，每個檔的 SHA-256 記在 `fetch-sources.sh`：

- Noto Serif TC：`ofl/notoseriftc/NotoSerifTC[wght].ttf`（可變字型，固定在 700、900 兩個字重）
- Cinzel：`ofl/cinzel/Cinzel[wght].ttf`（固定在 700）
- Cormorant Garamond：`ofl/cormorantgaramond/CormorantGaramond[wght].ttf`（固定在 600）

三套字型都是 SIL Open Font License 1.1。授權全文從同一個來源原封不動複製成 `play/fonts/OFL-NotoSerifTC.txt`、`OFL-Cinzel.txt`、`OFL-CormorantGaramond.txt`，要跟字型檔一起發佈。字型檔裡的版權（name 表 0 號）與授權說明（13、14 號）也都保留。

OFL 規定：授權檔若列出「保留字型名稱」（Reserved Font Name），改作的字型就不能沿用那個名稱。目前三份授權檔都沒有列出，所以字型保留原名。建置時會讀授權檔的版權聲明；之後換來源若出現保留字型名稱，Noto Serif TC 會自動把內部名稱改成 `ODB Serif TC`（PostScript 名稱 `ODBSerifTC-Bold`、`ODBSerifTC-Black`），其他字型則停下來要人處理。

## 字表

`charset.mjs` 是唯一的字表來源，建置與檢查都向它要字，兩邊不會不一致。

- 中文字表：`play/index.html`、`play/js/` 底下所有 `.js`（含子資料夾）、`play/data/*.json` 裡出現的每個字（控制字元除外；`×`、`&times;` 這類跳脫寫法也會換回字元），再加上常用全形標點、全形數字與可列印 ASCII。
- 拉丁字表：可列印 ASCII，加上 `§ ✶ · – — ‘ ’ “ ” … ×`。
- CSS 的 `content:` 不在掃描範圍。畫面文字請寫在 HTML 或 JS 裡。

字型原檔本來就沒有的字（例如表情符號），建置時記在 `fallback-chars.json`，畫面上由系統字型顯示；檢查時只印成提示，不算缺字。

```sh
node scripts/fonts/charset.mjs cjk     # 印出中文字表
node scripts/fonts/charset.mjs latin   # 印出拉丁字表
node scripts/fonts/charset.mjs stats   # 字數統計
```

## 重新產生字型

需要 Python 3 與 Node.js。以下指令都在專案根目錄執行；`.tools/` 不進版控。

第一次先建虛擬環境並下載原始字型（下載後會核對 SHA-256，不符就停下來）：

```sh
python3 -m venv .tools/fontenv
.tools/fontenv/bin/pip install fonttools brotli
sh scripts/fonts/fetch-sources.sh
```

之後每次重新產生、再檢查：

```sh
.tools/fontenv/bin/python scripts/fonts/build-fonts.py
npm run fonts:check
```

建置會覆寫 `play/fonts/` 的四個 woff2 與三份授權檔，以及 `scripts/fonts/fallback-chars.json`，這些都要一起 commit。同樣的輸入每次產生一模一樣的檔案，沒改字就不會有差異。子集只留橫排需要的 OpenType 功能（字距、連字、標點擠壓，拉丁字型另留等寬數字），不含直排與 hinting。

**企劃改了卡牌文字、`play/data/` 的 JSON，或是改了畫面上的文字，commit 之前都要先跑上面兩行：建置，再 `npm run fonts:check`。** 新字沒做進字型時，畫面會改用系統字型顯示那個字，字體會不一致。

## 檢查在看什麼

`npm run fonts:check` 只用 Node，不需要 Python：直接讀 `play/fonts/` 的 woff2，解開後讀出字型實際涵蓋的字，跟字表比對。有缺字就逐字列出碼位與出現在哪些檔，並以非 0 結束。

想確認檢查本身會抓到缺字，可以多要求一個字（只加進中文字表，不會改到任何檔案）：

```sh
npm run fonts:check -- --extra-text=龘
```
