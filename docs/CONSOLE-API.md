# 主持人控制台與投影畫面：資料、規則與函式介面

給控制台（主持端畫面）、投影畫面、玩家端接線用的介面說明。這一份只寫「資料長什麼樣子、誰能寫、能呼叫哪些函式、會回什麼、會丟什麼錯」；
畫面怎麼排不在這裡。做法與理由見 [`ARCHITECTURE.md`](ARCHITECTURE.md)「控制台與投影（資料與規則）」。

- 資料與規則：`database.rules.json` 在 `rooms/{code}` 底下多了 `display`、`clock`、`screens` 三個節點，現有的條件一字不動。
- 函式：`play/js/store.js`（碰資料庫的）、`play/js/game.js`（純函式：日落鐘、批次計畫、在等誰、暫停層、音效、排行）、
  `play/js/rules.js`（純函式：指令格式、`clockOf`）、`play/js/config.js`（`WEB_VERSION`）。
- 畫面只讀房間資料（`watchRoom` 已經包含這三個節點，不用另外訂閱）、呼叫下面的函式；不自己組寫入、不自己算日落鐘。

## 1. 資料形狀

```
/rooms/{code}/display                          主持端寫；房間裡登入的人都能讀（玩家、主持、投影）
  /scene      { id, page?, seq, at, by }       投影場景。id＝opening｜rules｜overview｜standings｜awards；page＝0–20（規則、頒獎換頁用）
  /broadcast  { text, hidden?, seq, at, by }   全場廣播。text＝1–40 字（前後空白已修剪）；收回＝同一則加 hidden: true
  /sfx        { id, seq, at, by }              一次性音效。id＝bell（日落大鐘）｜gavel（法槌）；同一間房一秒最多一次
  /music      { track, on, seq, at, by }       背景音樂。track＝opening；on＝播放（true）或停止（false）
  /pause      { on, clocks?, seq, at, by }     全場暫停。on＝true 是暫停中；clocks＝{ "1": true, "2": true }，暫停時順手停住的日落鐘（只有 on 時有）
/rooms/{code}/clock/{m}                        全場日落鐘，m＝1｜2（第幾場）；主持端寫；房間裡登入的人都能讀
  { startedAt, minutes, anchor, remain, pausedAt?, adjust, seq, by }
/rooms/{code}/screens/{uid}                    投影端狀態回報（可做）；投影端自己寫，斷線時伺服器代為刪除
  { audio, scene?, at }                        audio＝聲音已開；scene＝投影端已經照著畫的 display/scene 的 seq
```

- 每一筆 `display/*` 與 `clock/{m}` 都帶 `seq`（第一次是 1，之後每次剛好＋1）、`by`（寫的人的 uid）；`display/*` 另帶 `at`（伺服器時間）。
  `seq` 是「這是新指令」的判斷依據（投影端與玩家端記住看過的 `seq`），`by` 給控制台顯示「這台」或「別台（確認碼 K7Q2）」（`rules.js` 的 `confirmCode(by)`）。
- 日落鐘的欄位（全部是伺服器時間或毫秒整數）：
  - `startedAt` 開鐘的時間（之後不能改）；`minutes` 開鐘時的分鐘數（10–180 的整數，開鐘的那台從 `settings.sunsetMinutes` 帶入，之後不能改）；
  - `anchor`、`remain`：走著時，剩餘(t)＝`remain`－(t－`anchor`)；暫停中（有 `pausedAt`）剩餘＝`remain`－(`pausedAt`－`anchor`)；
  - `adjust`：累計加減（毫秒，±30 分以內）；「已進行」＝`minutes`×60000＋`adjust`－剩餘，暫停與加減都不會讓它倒退或跳。
  - 剩餘 ≤ 0 就是日落（剛好 0 算到）。暫停中剩餘不會變；暫停中被減到剛好 0 也算日落。
  - 這些算式只寫在 `game.js`（`clockRemaining` 等，見第 4 節），畫面一律呼叫，不自己算。
- **讀法注意（Firebase 的陣列）**：`clock` 只有 `1`、`2` 兩個鍵、`pause.clocks` 也是 `"1"`、`"2"`，讀回來可能是陣列也可能是物件。一律用
  `room.clock?.[1]`、`clockOf(room, 局號)`、`pause.clocks?.[1]` 讀，不用 `.length`、`.map`、`Object.keys` 判斷有幾個。
- 沒有某個節點＝還沒下過那種指令：`display` 不存在＝沒有場景（投影顯示開始投影頁或預設場景）、沒有廣播、沒有暫停；`clock/{m}` 不存在＝那一場各桌照舊從各自按「開始」起算。

## 2. 規則：誰能寫、什麼會被拒

- 主持端（開房的人＋`hosts` 名單上的人，同 `tables` 的寫入條件）能寫 `display/*` 與 `clock/{m}`；入座的玩家、只登入沒加入的人（投影端）、沒登入的人都被拒。
  房間裡登入的人都讀得到（沿用 `rooms/{code}` 的讀取權）。
- `display/*` 每一筆：必帶欄位、`seq` 剛好＋1、`at` 是伺服器時間、`by` 是自己；欄位格式（場景、頁數、音效、曲目、字數、`hidden` 只能是 `true`、`on` 是布林）；
  多的欄位拒絕；刪不掉（單一筆或整個 `display`）；音效離上一次不到 1 秒被拒；`pause` 在 `on: false` 時不能帶 `clocks`。
- `clock/{m}`：只能是第 1、2 場；刪不掉；建立時 `seq` 是 1、`startedAt`＝`anchor`＝伺服器時間、`remain`＝`minutes`×60000、`adjust` 是 0、沒有 `pausedAt`。
  之後每一筆 `seq` 剛好＋1、`startedAt` 與 `minutes` 不能改，而且只能是下面三種之一：
  - 暫停：原本沒暫停、當下剩餘＞0（日落後不能暫停），只多了 `pausedAt`＝伺服器時間，其他不動；
  - 繼續：原本暫停中，拿掉 `pausedAt`，`anchor`＝伺服器時間，`remain` 剛好等於舊 `remain`－(`pausedAt`－舊 `anchor`)；
  - 加減：`anchor`、`pausedAt` 不動，`remain` 與 `adjust` 改變的量一樣、單次 ±10 分以內，累計 ±30 分以內，調之前剩餘＞0（日落後不能調）、調之後剩餘 ≥ 0。
- 全場暫停是一筆寫入（`display/pause`＋被它停住或恢復的 `clock/{m}`）：其中鐘的部分不合法時整筆被拒，`display/pause` 也不會寫進去。
- `screens/{uid}`：只能寫自己那一筆（房間要存在），必有 `audio`（布林）與 `at`（伺服器時間），`scene` 是 0 以上的整數，多的欄位拒絕；可以刪。
- 規則還沒發布的資料庫（舊規則）：這三個節點一律被拒（舊規則的 `$other`），遊戲本身的寫入不受影響（這些指令一律單獨寫，不跟遊戲寫入放在同一筆）。

## 3. store.js 新函式

共通：

- 第一個參數是 `connect()` 回傳的 `session`，第二個是房號 `code`。
- 每個指令都先讀房間（有 `watchRoom` 時是本機快取），用讀到的 `seq`＋1 寫，`by` 是自己，`at` 是伺服器時間。兩台主持端同時寫，後到的被規則拒，回 `conflict`。
- `expectSeq`（選填）：呼叫端畫面上看到的那一筆的 `seq`（沒有那一筆時是 0）。給了而且資料庫已經不是這個 `seq`，就不寫、直接丟 `conflict`
  （「別台剛改過」）。控制台按鈕建議都帶：日落鐘的暫停／繼續／±（SPEC 2.5：兩台同時調，後到的要被拒；沒帶的話，別台的那一筆已經傳到這台之後才按，
  會接在它後面再調一次，＋1 加 ＋1 變 ＋2）、全場暫停與恢復、收回、復原。沒給就照目前的資料庫寫（場景、廣播、音效這種「最後一筆為準」的可以不帶）。
- 被拒之後只等約 0.5 秒就判斷的那條捷徑（房間裡還沒有任何控制台節點時），前提是控制台一直開著 `watchRoom`（別台的那一筆會在被拒的回覆之前傳到這台）。
- 錯誤一律是 `StoreError`（`error.code`、`error.message` 是給人看的中文），代碼見第 6 節；`conflict` 另外帶 `error.latest`（那一筆最新的內容，沒有是 `null`）。
- 寫入被拒時會等伺服器的現況再判斷原因，每等一次：這間房已經有控制台的節點時最多約 3 秒，還沒有任何控制台節點時（舊規則一定是這樣）約 0.5 秒，
  所以「規則還沒更新」約 0.5 秒就回來。大多數指令只等一次；`setPause` 例外：暫停被拒、伺服器上也沒變時不帶鐘再寫一次（再等一次，最壞約 6 秒；
  只有這台估的伺服器時間差了 10 秒以上才會走到這裡），鐘被別台改動時看到變化就重讀再試（不用等滿，一次指令最多試 5 次）。
- 「目前那一筆」讀的是這台的本機快取：別台剛寫的那一筆還沒傳到時，這台的指令會被規則拒、回 `conflict`（`latest` 已經是最新的），
  畫面照 `latest` 重畫、讓主持人再按一次即可，不用自動重試。

| 函式 | 做什麼 | 回傳 |
|---|---|---|
| `setScene(session, code, id, { page, expectSeq } = {})` | 切投影場景；`page` 是 0–20 的整數（規則、頒獎換頁），沒給就不帶。同一個場景再送一次也會寫（`seq`＋1，投影端可以用來重播開場影片） | `{ seq }` |
| `sendBroadcast(session, code, text)` | 全場廣播：`text` 前後空白修剪後 1–40 字（UTF-16 長度，同暱稱）；新的取代舊的 | `{ seq, text }`（修剪後的） |
| `hideBroadcast(session, code, { expectSeq } = {})` | 收回目前那一則（同一則加 `hidden: true`）；沒有廣播或已經收回就不寫 | `{ changed, seq }` |
| `playSfx(session, code, id)` | 投影端播一次音效：`id` 是 `bell` 或 `gavel`；離上一次不到 1 秒丟 `too-soon`（送出時就在 1 秒的邊界、被規則拒的也立刻回 `too-soon`，不等伺服器） | `{ seq }` |
| `setMusic(session, code, on, { track = 'opening', expectSeq } = {})` | 背景音樂播放／停止；已經是這個狀態就不寫 | `{ changed, seq }` |
| `setPause(session, code, on, { expectSeq } = {})` | 全場暫停／恢復，一筆寫入。暫停：同一筆停住正在走、離日落還有 10 秒以上（`PAUSE_NEAR_SUNSET_MS`，照這台估的伺服器時間）的鐘，記在 `pause.clocks`；離日落不到 10 秒的鐘第一次就不帶（照常日落；停了也沒有意義，帶了反而可能讓整筆被拒、要等好幾秒）。暫停那一筆一定要寫得進去：還是被拒、伺服器上也沒變時，一個鐘都不帶再寫一次。恢復：只恢復 `pause.clocks` 記的、而且還是被這一次暫停停住的鐘（`pausedAt` 等於 `pause.at`；原本就手動暫停的、暫停中被手動繼續又暫停的都不動）；恢復不放寬：被拒、伺服器上也沒變就丟 `rejected`，不會不帶鐘只寫 `pause.on = false`（那樣被暫停停住的鐘會一直停著）。已經是這個狀態就不寫 | `{ changed, seq, clocks }`（`clocks`＝這次一起停住或恢復的場次，例 `['1']`；正在走卻不在裡面的鐘就是沒停住的） |
| `startClock(session, code, match, minutes)` | 開第 `match` 場（1 或 2）的全場日落鐘，`minutes` 是 10–180 的整數（照 `settings.sunsetMinutes`）。已經開了就不寫；第 2 場還沒開（還沒有任何 `tables/{n}-2`）時開第 2 場的鐘丟 `invalid-command`（先開走的話，第 2 場各桌開局時已經被吃掉一段）；全場暫停中丟 `paused`（暫停中開的鐘會一路走、恢復時也不會被照顧到） | `{ started, clock }`（`clock` 是寫入後或原本的那一筆） |
| `pauseClock(session, code, match, { expectSeq } = {})` | 暫停這一場的鐘；已經暫停就不寫；日落後丟 `clock-passed` | `{ changed, clock }` |
| `resumeClock(session, code, match, { expectSeq } = {})` | 繼續；沒暫停就不寫 | `{ changed, clock }` |
| `adjustClock(session, code, match, deltaMs, { expectSeq } = {})` | 加減（毫秒，例 `5 * 60000`、`-60000`），自動夾在單次 ±10 分、累計 ±30 分、剩餘不小於 0。走著的鐘減到底時留約 1.5 秒的餘裕（主持端估的伺服器時間有誤差）。日落後（包括已經減到 0）丟 `clock-passed`；完全調不動（累計已到 ±30 分還要往同一邊調）丟 `clock-limit` | `{ delta, clock }`（`delta`＝實際調了多少毫秒；「復原」＝`adjustClock(…, -delta)`） |
| `watchSubmissions(session, code, onChange, onError)` | 主持端：逐人訂閱入座的人的票、黑夜選擇、挑的棄牌（`votes/{code}/{uid}`、`nights/{code}/{uid}`、`discards/{code}/{uid}`；不在整房掛訂閱，自動結算從伺服器重讀整房的保證不變）。有變就呼叫 `onChange({ votes, nights, discards })`（都是 `{ uid: 最新一筆 }`），交給 `game.js` 的 `waitingFor`、`missingDiscards` | 停止訂閱的函式 |
| `trackScreen(session, code, { audio, scene } = {})` | 投影端回報自己的狀態（可做）：寫 `screens/{uid}`，做法同上線狀態：每次連上都先登記「斷線時刪除」再寫，被同一個身分較早的連線晚一步刪掉時補回去 | `{ update({ audio, scene }), stop() }`：`update` 改內容並寫入（回傳 `Promise<寫進去了沒>`，舊規則下是 `false`），`stop` 停止並刪掉自己那一筆 |
| `startAll(session, code, plan, data, { random, clock = false, onProgress } = {})` | 「全部開始」「全部開始第 2 場」：照 `startPlan`／`startMatch2Plan` 的計畫逐桌呼叫 `startTable`（第 2 場帶各桌的 `include`），一桌失敗不影響別桌；全場暫停中的桌不開（`error.code` 是 `paused`）。`clock` 是 `true`、計畫說那一場的鐘還沒開、而且至少有一桌已經開局時，最後開全場日落鐘（全場暫停中、或計畫的 `clock.error` 有值時開不起來，`clock.error` 說原因）。`onProgress({ done, total, key, result })` 每做完一桌呼叫一次 | `{ results: [{ key, table, started, error }], clock: { started, error } \| null }`（`error` 是 `StoreError` 或 `null`；`started: false` 且沒有錯＝別台先開了；`clock` 是 `null`＝這次沒有要開鐘） |
| `advanceAll(session, code, plan, data, { random, onProgress } = {})` | 「能推的全推」：照 `advancePlan` 的計畫，逐桌用計畫裡的回合與階段呼叫 `advanceOrEnd`（只有計畫的 `includeEnding` 是 `true`、而且那一桌在計畫裡就是要算分的，才替它算分；其他到了執行時才該算分的桌回 `held`，例如確認框打開之後全場鐘才到點），推進到新回合日出的接著發牌（`processSunrise`）。每一桌之前重讀房間，全場暫停了就停下、其餘的桌回 `paused` | `{ results: [{ key, table, advanced, ended, held, dealt, reason, error }] }`：`advanced: false` 且沒有錯＝局面已經變了（別台先推了）；`held: true`＝這一回合要算分、這次沒推；推進成功但發牌失敗時 `advanced: true` 而 `error` 有值（照單桌的「補發」處理） |

`advanceOrEnd` 的改動：

- `advanceOrEnd(session, code, key, expected, data, { allowEnd = true } = {})`：黑夜要不要算分改成帶上那一場的全場日落鐘（`clockOf(room, key)`）；那一場沒有鐘時跟原本一樣看各桌的 `startedAt`。
- 多一個選填的 `allowEnd`：`false` 時該算分的桌不寫終局，回 `{ advanced: false, ended: false, held: true, reason, table }`（批次推進用，算分要主持人另外勾）。不給時跟原本一模一樣。

## 4. game.js、rules.js 新純函式

### 日落鐘（`game.js`）

`clock` 是 `clock/{m}` 讀回來的那一筆，`now` 是伺服器時間（`store.js` 的 `serverTime(session)`）。

| 函式 | 回傳 |
|---|---|
| `isClock(clock)` | 是不是一筆算得出剩餘的全場鐘（不是的話各函式都當作沒有鐘） |
| `clockPaused(clock)` | 暫停中（有 `pausedAt`） |
| `clockRemaining(clock, now)` | 剩餘毫秒（不小於 0） |
| `clockElapsed(clock, now)` | 已進行毫秒＝`clockLength`－剩餘 |
| `clockLength(clock)` | 目前的總長＝`minutes`×60000＋`adjust` |
| `clockPassed(clock, now)` | 日落了沒（剩餘 ≤ 0） |
| `clockSunsetAt(clock)` | 走著時的日落時刻（伺服器時間）；暫停中是 `null`（不會到） |
| `clockStartWrite(minutes, stamp)` | 開鐘要寫的欄位（`by` 由 store 補）；`stamp` 是伺服器時間的佔位（store 傳 `serverTimestamp()`，測試傳數字）。分鐘數不是 10–180 的整數丟 `RangeError` |
| `clockPauseWrite(clock, stamp)` | 暫停要寫的整筆；已經暫停回 `null` |
| `clockResumeWrite(clock, stamp)` | 繼續要寫的整筆（`remain` 照規則的式子）；沒暫停回 `null` |
| `clockAdjustWrite(clock, delta, now)` | 加減要寫的整筆，`delta` 已夾好（單次 ±10 分、累計 ±30 分、剩餘 ≥ 0）；日落後或夾完是 0 回 `null` |
| `shouldEnd({ round, startedAt, endAfterRound }, settings, now, clock = null)` | 原本的函式多一個 `clock`：有鐘時「日落」看 `clockPassed`，沒有照舊看 `startedAt`；順序照舊（`sunset` → `maxRounds` → `host`） |
| `endReasonAt(game, state, settings, now, clock = null)` | 這一回合是不是最後一回合（原因或 `null`）：給玩家端的「這是最後一回合」、主持端的「下一階段（算分）」用；終局或沒開局是 `null` |
| `sunsetStatus(game, settings, now, clock = null)` | 一桌的日落鐘狀態 `{ global, paused, elapsed, remaining, passed, sunsetAt, length }`：有全場鐘照鐘（`global: true`），沒有照該桌的 `startedAt`；沒開局又沒有鐘是 `null`。`sunsetAt` 用來排「到點重畫」 |

常數：`CLOCK_MINUTES_MIN`（10）、`CLOCK_MINUTES_MAX`（180）、`CLOCK_STEP_MAX_MS`（10 分）、`CLOCK_ADJUST_MAX_MS`（30 分）。

`rules.js` 的 `clockOf(room, key)`：局號 `key` 那一場的全場日落鐘（第 1 場的局號 → `clock/1`，`"3-2"` → `clock/2`），沒有是 `null`。

### 批次計畫（`game.js`）

都只讀房間資料、不寫入；畫面拿來畫確認框，確認後原封交給 `startAll`／`advanceAll`。`data` 是卡牌資料（`ctx.cardData.data`）。

- `startPlan(room, data)`：第 1 場還沒開局的桌。回傳 `{ match: 1, start, skip, started, clock }`：
  - `start: [{ key, table, uids, count, warning }]` 要開的桌（`warning` 是少於 3 人的提醒，沒有是 `null`）；
  - `skip: [{ key, table, count, reason }]` 跳過的桌與原因（0 人、超過上限；文字同單桌「開始」的停用原因）；
  - `started: [key…]` 已經開局的桌；
  - `clock: { match: 1, needed, minutes, error }`：`needed`＝第 1 場的全場鐘還沒開（確認框才出現「同時開始全場日落鐘」），`minutes` 是 `settings.sunsetMinutes`；
    `error`＝這個分鐘數開不了全場鐘（規則只收 10–180 的整數，資料檔的設定比較寬，例如排練用的 5 分），沒問題是 `null`。
- `startMatch2Plan(room, data, picks = {})`：已經開了第 2 場（第 ① 步）、還沒開局的桌。`picks` 是 `{ 局號: [uid…] }`（或 `Map`，值可以是 `Set`），
  是這台裝置的勾選；沒有那一桌就照預設（第 1 場有座位、而且現在還選這一桌的人，同 `startTable`）。回傳 `{ match: 2, start, skip, started, clock }`：
  - `start: [{ key, table, include, count, absent, warning }]`：`include` 是要入座的 uid（照第 1 場的座位號），`absent: [{ uid, why }]` 是第 1 場坐這一桌、
    這場沒參加的人，`why` 是 `left`（已離開房間）、`moved`（換到別桌）或 `unchecked`（被勾掉）；
  - `skip`、`started`、`clock` 同上（`clock.match` 是 2）。
- `advancePlan(room, settings, now, { includeEnding = false, discards = null } = {})`：「能推的全推」。`settings` 是 `data.settings`，`now` 是伺服器時間，
  `discards` 是 `watchSubmissions` 給的挑棄牌（給了才寫「沒挑棄牌的會被隨機棄」的提醒）。回傳 `{ paused, includeEnding, advance, skip }`
  （`includeEnding` 原樣帶著，`advanceAll` 照它決定要不要替要算分的桌算分）：
  - `advance: [{ key, table, match, round, phase, to: { round, phase }, ending, deal, note }]`：`round`、`phase` 是這一刻的回合與階段（執行時拿來比對），
    `to` 是推完之後（要算分的桌是 `phase: 'end'`），`ending` 是算分的原因或 `null`，`deal` 是推進到新回合日出（會發牌），`note` 是附帶的提醒或 `null`；
  - `skip: [{ key, table, match, round, phase, reason, text }]`：不推的桌。`reason`：`not-started`（沒開局、第 2 場未開局）、`ended`（已算分）、`paused`（全場暫停中）、
    `not-dealt`（日出還沒發牌）、`responding`（響應窗口中）、`playing`（白晝還有人沒出完）、`not-open`（黃昏或黑夜還沒開始）、`voting`（黃昏還沒揭曉）、
    `choosing`（黑夜還沒揭曉）、`ending`（這一回合要算分、沒勾 `includeEnding`；另帶 `ending`＝算分的原因）；`text` 是中文說明。
  - 全場暫停中（`display.pause.on`）時 `paused: true`，所有的桌都在 `skip`。

### 在等誰、挑棄牌（`game.js`）

- `waitingFor(room, key, { votes, nights })`：這一局在黃昏表決中或黑夜選擇中時回 `{ kind: 'dusk' | 'night', submitted: [uid…], missing: [uid…] }`（照座位順序），
  其他時候是 `null`。算法跟 `dusk.submitted`／`night.submitted` 用同一個（`countVotes`、`countChoices`：這一桌、這一回合、翻開之後到截止之前的合法票），
  所以名單與「已送出 x／n」一定對得上。只給主持端用；投影只顯示人數。
- `missingDiscards(key, game, state, settings, discards)`：黑夜時手牌超過上限、還沒挑好棄牌的人 `[uid…]`（判斷同主持端桌卡；這一回合要算分時傳進來的 `state` 照舊，呼叫端自己略過）。

### 投影端、玩家端（`game.js`）

- `sfxToPlay(sfx, lastSeq, now)`：這一筆音效要不要播：`seq` 比看過的大、`at` 離現在（伺服器時間）不超過 5 秒（`SFX_STALE_MS`），斷線重連後不補放舊的。
  投影端播了（或決定不播）之後把 `lastSeq` 記成這一筆的 `seq`。
- `pauseHold(pause, game, state, settings, now)`：玩家端的全場暫停層。回傳 `{ covered, until }`：`covered`＝現在要蓋上暫停層；
  `until`＝自己這一桌在暫停開始前就開著的響應窗口或揭曉倒數還在跑，倒數結束（伺服器時間）才蓋，這段時間先在最上面顯示「這個倒數結束後全場暫停」
  （`covered` 是 `false`）；沒有是 `null`。暫停之後才開的窗口與倒數（只可能來自還開著舊網頁的人）不算。
- `standingsOf(room, table)`：實體桌號 `table` 的排行 `{ table, match, status, basis, rows }`（`match` 是目前第幾場）：`status` 是 `idle`（沒開局）、`playing`（比賽中，`rows` 是空的）、`ended`；
  `basis` 是 `combined`（第 2 場結束，兩場合計，`combineScores`）或 `first`（只打完第 1 場、第 2 場還沒開局）；`rows: [{ uid, rank, total, first, second }]`
  照名次排（`first`、`second` 只有兩場合計才有）。桌號不存在是 `null`。
- `topScores(room)`：「全場最高分」趣味獎 `{ basis, total, winners: [{ table, uid }] }`：有桌打完第 2 場時只比打完兩場的桌的兩場合計（`combined`），
  不然比打完第 1 場的桌的第 1 場總分（`first`）；同分都列。沒有桌結束是 `null`。

### 指令格式（`rules.js`）

- 常數：`SCENE_IDS`（五個場景）、`SCENE_PAGE_MAX`（20）、`SFX_IDS`（`bell`、`gavel`）、`SFX_GAP_MS`（1000，音效的最短間隔）、`MUSIC_TRACKS`（`opening`）、
  `BROADCAST_MAX_LENGTH`（40）。
- `normalizeBroadcast(text)`（前後空白修剪）、`isValidBroadcast(text)`（修剪過、1–40 字，UTF-16 長度）：輸入框的「還剩幾字」用 `BROADCAST_MAX_LENGTH - normalizeBroadcast(text).length`。
- `isValidScene(id, page)`：場景 id 在清單裡、`page` 沒給或是 0–20 的整數。

## 5. config.js

- `WEB_VERSION`：網頁版本號（整數）。控制台頂列顯示，現場逐台核對；舊網頁沒有這個常數（沒顯示版本的就是舊網頁）。每次推網頁前＋1。

## 6. 錯誤碼（`StoreError.code`）

| 代碼 | 什麼時候 | 畫面建議 |
|---|---|---|
| `invalid-command` | 指令內容不合法：場景、頁數、音效、曲目不在清單，廣播 0 字或超過 40 字，場次不是 1、2，分鐘數不對，加減量不是數字；第 2 場還沒開就開第 2 場的鐘 | 照 `message` 寫 |
| `conflict` | 別台主持端剛改過（`expectSeq` 對不上，或同時寫、後到的被拒）。`error.latest` 是最新的那一筆 | 「別台剛改過」＋照 `latest` 重畫（例「現在剩 33:52」） |
| `rules-outdated` | 寫入被拒、自己是主持端、資料也沒變，而且這間房從來沒有寫進過控制台指令（舊規則下這些節點一定不存在）；約 0.5 秒後回 | 「要等規則更新」（日落鐘：「日落鐘控制要等規則更新，各桌照舊各自計時」） |
| `rejected` | 寫入被拒、原因不明（例如剛好卡在時間邊界）；全場恢復（`setPause(…, false)`）被拒也是這個 | 「沒有寫進去，請再按一次」 |
| `permission-denied` | 自己不是這間房的主持端 | 照 `message` 寫 |
| `room-not-found` | 房間不存在 | 照 `message` 寫 |
| `too-soon` | 音效離上一次不到 1 秒（含送出時剛好卡在 1 秒邊界被規則拒的） | 不用特別處理 |
| `no-clock` | 這一場的全場日落鐘還沒開（暫停、繼續、加減時） | 照 `message` 寫 |
| `clock-passed` | 已經日落，不能再暫停或加減 | 照 `message` 寫 |
| `clock-limit` | 加減調不動（累計已到 ±30 分還要往同一邊調）；已經減到 0 是 `clock-passed` | 照 `message` 寫 |
| `paused` | 全場暫停中：`startClock` 不開鐘；`startAll`、`advanceAll` 那一桌（以及 `advanceAll` 剩下的桌）沒做 | 結果條逐桌寫「全場暫停中」 |

原有的代碼（`cannot-start`、`night-not-revealed` 等）照舊，`startAll`、`advanceAll` 逐桌的 `error` 就是原本單桌函式丟的那個。

## 7. 接線注意

- **最後一回合與日落重畫**（`shared.js`）：`endReasonNow(game, state)` 改成呼叫 `endReasonAt(game, state, settings, serverTime(session), clockOf(room, 局號))`
  （呼叫端要多傳房間與局號，或直接傳那一場的鐘）；`wakeAtSunset(game)` 改用 `sunsetStatus(…).sunsetAt` 排重畫（暫停中是 `null`，不用排；鐘一變房間就會重畫）。
  主持端與玩家端用同一個函式，「最後一回合」的判斷各端一致；`advanceOrEnd` 也是同一個判斷。
- **日落鐘面板**：每桌與全場都用 `sunsetStatus`；那一場沒有鐘時寫「各桌各自計時（從各桌按『開始』起算）」。兩場同時在跑時兩個鐘各自 `clockOf`。
  減到 0 就是日落，之後不能加回來（規則擋），確認或提示要寫清楚。
- **暫停中**：`display.pause.on` 時，「開始」「下一階段」「全部…」「開第 2 場」停用（原因「全場暫停中」）；`advancePlan` 已經把所有桌放進 `skip`，
  `advanceAll` 每一桌之前也會再看一次，`startClock` 也不開鐘。自動結算照常跑，正在倒數的窗口與揭曉會正常收尾。手動的「▶ 繼續」日落鐘在暫停中沒有被擋
  （手動繼續又暫停的鐘，全場恢復時不會被帶著繼續），要不要停用由控制台決定。
- **離線**：`.info/connected` 是 `false` 時控制台整條停用（`watchConnection`），免得 Firebase 把離線時按的指令排隊、連回來才生效。
- **投影端**：只讀、不跑自動結算、不寫 `presence`；唯一會寫的是可做的 `trackScreen`。跟主持端同一個瀏覽器時建議加 `&slot=screen`，不然 `screens` 會記在主持端的 uid 底下。
  音效用 `sfxToPlay`，影片在 `display.scene.seq` 沒變時不重播，背景音樂看 `music.on`。日落自動敲鐘（可做）：用 `clockSunsetAt` 或 `sunsetStatus` 的 `sunsetAt` 在本機排時間，到點播 `bell`（不寫資料庫）。
- **「在等誰」**：主持端開 `watchSubmissions`（離開主持畫面時停止），每桌 `waitingFor(room, 局號, submissions)`；投影只顯示人數。
- **新規則還沒發布時**：每個控制台指令都會在約 0.5 秒後丟 `rules-outdated`；遊戲照常（開局、推進、結算不受影響），全場鐘開不起來時各桌照舊各自計時。
