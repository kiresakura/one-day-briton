# 多人連線版（開發中）

「一日英國人：女皇陛下萬歲！」的多人連線網頁。這個資料夾就是之後要部署的靜態內容，全部用相對路徑，不引用任何外部資源。

目前是骨架：主持端開房 → 玩家用房號加入 → 主持端按「下一階段」，同桌所有人的畫面一起更新。備援裝置可以申請成為主持端，畫面會顯示自己的連線狀態與誰在線上。架構說明見 [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)，接下來要做的事見 [`docs/MILESTONES.md`](../docs/MILESTONES.md)。

## 需要什麼

- Node.js 22 以上（開發時用 24）。
- Java 21 以上：只有資料庫模擬器需要，跑單元測試不需要。
- 第一次啟動模擬器時會下載資料庫模擬器（約 35 MB）到使用者快取目錄，需要網路；之後可離線。

不想把 Java 裝進系統的話，可以放一份在專案裡（`.tools/` 不進版控）：到 <https://adoptium.net/temurin/releases/?version=21> 下載對應作業系統的 JRE 壓縮檔，核對頁面上的 SHA-256 後解壓：

```sh
mkdir -p .tools/jre
tar -xzf OpenJDK21U-jre_*.tar.gz -C .tools/jre --strip-components=1
```

`scripts/with-java.sh` 會依序找 `$JAVA_HOME`、PATH 上的 `java`、`.tools/jre`，都沒有就停下來說明。

## 本機跑起來

以下指令都在專案根目錄執行。

```sh
npm install
npm run dev
```

看到 `All emulators ready` 後開 <http://127.0.0.1:5050/>。按 Ctrl+C 結束；模擬器的資料只在記憶體裡，關掉就清空。

在本機開啟時只連本機的模擬器，專案代號是 `demo-one-day-briton`（`demo-` 開頭代表不對應任何雲端專案），不需要帳號、不需要登入。連正式專案見下方「正式環境」。

## 用幾個分頁扮不同的人

同一個瀏覽器的分頁預設共用同一個身分。網址加上 `?slot=名稱` 就是另一個人：

| 分頁 | 網址 |
|---|---|
| 主持端 | `http://127.0.0.1:5050/` |
| 玩家一 | `http://127.0.0.1:5050/?slot=p1` |
| 玩家二 | `http://127.0.0.1:5050/?slot=p2` |

主持端按「開新房」拿到房號，兩個玩家分頁輸入房號、暱稱、桌號加入，再回主持端按那一桌的「下一階段」。重新整理任何一個分頁，都會回到同一個房間、同一個身分。

### 試備援主持

再開一個分頁當備援裝置：`http://127.0.0.1:5050/?slot=b`。

1. 在備援分頁的「主持端」卡片輸入房號，按「以主持端進入」。畫面會顯示 4 碼確認碼與「等待主持端核准」。
2. 回主持端分頁，「主持端」卡片會列出這筆申請與同一組確認碼；核對相同後按「核准」（或「拒絕」）。
3. 備援分頁自動切到主持畫面，之後兩個分頁都能按「下一階段」；同時按也只會前進一步。
4. 主持端分頁按「離開」回首頁，再用同一個房號「以主持端進入」，會直接回到主持畫面。

關掉玩家分頁，主持畫面會把那位玩家標成「離線」；兩個主持分頁都關掉時，玩家畫面會顯示「主持端目前離線」。

## 正式環境

`js/config.js` 有本機模擬器與正式專案兩組設定，依開啟頁面的網址選一組：

| 網址 | 連到 |
|---|---|
| 帶 `?env=emu` | 本機模擬器 |
| 帶 `?env=prod` | 正式專案 |
| 都沒帶，主機是 `localhost`、`127.0.0.1` 或 `::1` | 本機模擬器 |
| 都沒帶，其他主機 | 正式專案 |

推上 GitHub Pages 後的網址是 <https://kiresakura.github.io/one-day-briton/play/>，不用加參數就連正式專案。

本機加 `?env=prod`（例如 `http://localhost:5050/?env=prod`，可以再加 `&slot=p1`）也會連正式專案，開的房、加入的玩家都**寫進正式資料庫**，而且房間不會自動刪除，只在驗收時用。請用 `localhost` 開：正式專案的已授權網域有 `localhost`，沒有 `127.0.0.1`。

設定裡的 `apiKey` 等值是公開的識別碼，不是密碼；誰能讀寫由根目錄的 `database.rules.json` 決定，發布方式見 [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) 的「環境」。

## 測試

```sh
npm test            # 卡牌資料檢查＋純函式（階段、迷霧值、房號、暱稱、確認碼、環境選擇、資料格式、CSV 匯入），不需要 Java
npm run test:sync   # 啟動模擬器，用 js/store.js 測同步與安全規則
npm run test:all    # 兩者都跑
npm run data:check  # 只檢查 play/data/ 的卡牌資料檔
npm run data:import -- <CSV 資料夾>   # 試算表匯出的 CSV 轉成 play/data/，寫完自動檢查
```

`test:sync` 會印出許多 `permission_denied` 警告，那是「被拒絕才算通過」的測試留下的，以最後的統計為準。

## 連接埠

全部只綁 `127.0.0.1`，設定在根目錄的 `firebase.json`。

| 用途 | 連接埠 |
|---|---|
| 網頁（hosting） | 5050 |
| 匿名登入（auth） | 9099 |
| 資料庫（database） | 9000 |
| 模擬器控制（hub） | 4400 |
| 模擬器記錄（logging） | 4500 |

網頁不用預設的 5000，因為 macOS 的 AirPlay 接收器會佔用它。改了 9099 或 9000 的話，`js/config.js` 要跟著改。

## 檔案

| 檔案 | 內容 |
|---|---|
| `index.html` | 單頁：首頁、等待核准、主持端、玩家端幾個畫面 |
| `js/rules.js` | 純函式：階段順序、迷霧值、房號、暱稱、主持端判斷、確認碼 |
| `js/store.js` | 唯一碰 Firebase 的檔案：登入、開房、加入、訂閱、推進、主持名單、連線與上線狀態 |
| `js/app.js` | 畫面與事件 |
| `js/config.js` | 連線設定：模擬器與正式專案兩組，依網址選一組 |
| `js/data.js` | 純函式：卡牌資料檔的格式定義與檢查 |
| `data/` | 卡牌資料檔（企劃第一版，遊戲還沒讀；格式見 [`docs/DATA-FORMAT.md`](../docs/DATA-FORMAT.md)；範例資料在 `test/fixtures/data-example/`） |
| `vendor/firebase/` | 自行託管的官方 Firebase JS SDK |

## 自行託管的 SDK

`vendor/firebase/` 裡的三個檔案來自 npm 的 `firebase` 套件（版本與雜湊見 `vendor/firebase/VERSION.txt`，授權為 Apache-2.0）。官方檔案彼此之間是用 `https://www.gstatic.com/…` 的網址互相匯入，複製時已改寫成相對路徑，所以頁面只會向自己的主機要檔案。`firebase-app.js` 裡還留有兩處該網址的字串，那是 SDK 用來標示自己名稱的常數，不會發出請求。

`js/store.js` 寫的是 `firebase/app` 這種模組名稱：瀏覽器靠 `index.html` 裡的 import map 對到 `vendor/firebase/`，Node 測試則用 `node_modules` 裡的同一版套件。

升級 SDK 時改 `package.json` 的版本、`npm install`，再重新產生：

```sh
npm run vendor
```
