// 連線設定兩組：本機模擬器與正式專案，依開啟頁面的網址選一組（規則見 selectEnv）。
// 正式專案的這幾個值是公開的識別碼，不是密碼，網頁本來就要帶著；誰能讀寫由 database.rules.json 決定。
// demo- 開頭的專案代號只存在於模擬器，不會連到任何雲端資源；apiKey 是佔位字串，不是金鑰。

// 沒帶 ?env= 時用模擬器的主機名稱。瀏覽器的 IPv6 位址帶方括號，兩種寫法都列；空字串是沒有 location 的 Node 測試。
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

// 網址帶 ?env=emu → 模擬器，?env=prod → 正式專案；都沒帶就看主機名稱：本機用模擬器，其他用正式專案。
// 回傳 'emu' 或 'prod'。
export function selectEnv({ hostname = '', search = '' } = {}) {
  const env = new URLSearchParams(search).get('env');
  if (env === 'emu' || env === 'prod') return env;
  return LOCAL_HOSTNAMES.has(hostname) ? 'emu' : 'prod';
}

// 網址帶 ?seed=<整數> 時，主持端用固定種子的亂數洗牌、隨機棄牌，畫面測試時手牌每次都一樣。
// 只有模擬器才認這個參數；正式專案一律回傳 null（照常用 crypto.getRandomValues）。
export function selectSeed({ search = '' } = {}, environment = 'prod') {
  if (environment !== 'emu') return null;
  const value = new URLSearchParams(search).get('seed');
  return value !== null && /^\d{1,9}$/.test(value) ? Number(value) : null;
}

const page = globalThis.location ?? {};

export const environments = {
  emu: {
    firebase: {
      apiKey: 'demo-placeholder',
      projectId: 'demo-one-day-briton',
    },
    // 瀏覽器連開啟頁面的那台主機，Node 測試就用本機位址。
    emulator: { host: page.hostname || '127.0.0.1', authPort: 9099, databasePort: 9000 },
  },
  prod: {
    firebase: {
      apiKey: 'AIzaSyBJQJeUOcZbldW9HBffzV-mx8evQ-ehM38',
      authDomain: 'one-day-briton.firebaseapp.com',
      databaseURL: 'https://one-day-briton-default-rtdb.asia-southeast1.firebasedatabase.app',
      projectId: 'one-day-briton',
      storageBucket: 'one-day-briton.firebasestorage.app',
      messagingSenderId: '1066447033443',
      appId: '1:1066447033443:web:6efc5a08d9e8929592d456',
    },
    emulator: null,
  },
};

export const env = selectEnv(page);
export const config = environments[env];
export const seed = selectSeed(page, env);
