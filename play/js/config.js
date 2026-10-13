// 連線設定。目前只有本機模擬器這一組；正式專案的設定之後加在這裡（見 docs/MILESTONES.md）。
// demo- 開頭的專案代號只存在於模擬器，不會連到任何雲端資源；apiKey 是佔位字串，不是金鑰。
// 瀏覽器用開啟頁面的主機名稱，Node 測試沒有 location，就用本機位址。
const host = globalThis.location?.hostname || '127.0.0.1';

export const config = {
  firebase: {
    apiKey: 'demo-placeholder',
    projectId: 'demo-one-day-briton',
  },
  emulator: { host, authPort: 9099, databasePort: 9000 },
};
