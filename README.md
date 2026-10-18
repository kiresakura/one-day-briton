# 一日英國人：女皇陛下萬歲！

成大歷史系學會活動部（企劃中）策略遊戲體驗日的前導宣傳互動網頁。

- 網站：https://kiresakura.github.io/one-day-briton/
- 生成式AI 第五週作業凍結版：https://kiresakura.github.io/one-day-briton/hw5/

單一 `index.html`：CSS、JavaScript、字型、圖片都包在同一個檔案裡，下載後直接開就能操作。版面與互動用 Claude Design 製作，兩張角色插畫、倫敦天際線與卡背由 GPT 圖像模型生成。

活動日期、地點與報名方式尚未公布，以系學會公告為準。

## 多人連線版的湊人數機器人

測試多人連線版（`play/`）時人不夠，可以用 `npm run bots -- --room <房號>` 放幾個機器人玩家進主持端開好的房間，主持端照常主持就能看完整場流程。用法、正式站與本機模擬器的差別、常見訊息見 [`docs/BOTS.md`](docs/BOTS.md)。
