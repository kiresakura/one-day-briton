// 唯一碰 Firebase 的檔案：登入、開房、加入、訂閱、推進、主持名單、連線與上線狀態、開局與日出發牌。
// 瀏覽器靠 index.html 的 import map 把 firebase/* 對到 ./vendor/firebase/，Node 測試靠 node_modules。
import { deleteApp, initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  connectAuthEmulator,
  indexedDBLocalPersistence,
  initializeAuth,
  signInAnonymously,
} from 'firebase/auth';
import {
  connectDatabaseEmulator,
  get,
  getDatabase,
  onDisconnect,
  onValue,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  update,
} from 'firebase/database';
import { config } from './config.js';
import { checkSeating, startGame, sunrise } from './game.js';
import {
  MAX_TABLES,
  NAME_MAX_LENGTH,
  ROOM_CODE_LENGTH,
  generateRoomCode,
  initialTable,
  isRoomCode,
  isValidName,
  isValidTable,
  nextStep,
  normalizeName,
  normalizeRoomCode,
} from './rules.js';

// code：invalid-code、invalid-name、invalid-table、room-not-found、permission-denied、
// cannot-start（人數不對或這一桌已經推進過）、broken-game（局面缺資料）
export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function isPermissionDenied(error) {
  return /permission[_ ]denied/i.test(`${error?.code} ${error?.message}`);
}

// 匿名登入。slot 會變成 Firebase app 名稱，登入狀態依名稱分開保存，
// 所以同一個瀏覽器的不同分頁帶不同 slot 就是不同玩家；不帶就是預設身分。
export async function connect(slot = '') {
  const app = slot ? initializeApp(config.firebase, `slot-${slot}`) : initializeApp(config.firebase);
  // 只給儲存方式、不給彈出視窗登入用的元件，匿名登入用不到，也避免它在手機上預先載入外部指令碼。
  const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  const db = getDatabase(app);
  if (config.emulator) {
    const { host, authPort, databasePort } = config.emulator;
    connectAuthEmulator(auth, `http://${host}:${authPort}`, { disableWarnings: true });
    connectDatabaseEmulator(db, host, databasePort);
  }
  await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  return { app, db, uid: auth.currentUser.uid };
}

export function disconnect(session) {
  return deleteApp(session.app);
}

// 房間資料與各桌初始狀態一次寫入。房號撞到既有房間時規則會拒絕（meta 只能建立、不能覆寫）。
export async function createRoom(session, tableCount = MAX_TABLES) {
  if (!isValidTable(tableCount)) throw new StoreError('invalid-table', `桌數請設 1–${MAX_TABLES}`);
  const code = generateRoomCode();
  const tables = {};
  for (let table = 1; table <= tableCount; table += 1) {
    tables[table] = { ...initialTable(), updatedAt: serverTimestamp() };
  }
  await update(ref(session.db, `rooms/${code}`), {
    meta: { hostUid: session.uid, createdAt: serverTimestamp(), tableCount },
    tables,
  });
  return code;
}

function parseRoomCode(codeInput) {
  const code = normalizeRoomCode(codeInput);
  if (!isRoomCode(code)) throw new StoreError('invalid-code', `房號是 ${ROOM_CODE_LENGTH} 碼英數字`);
  return code;
}

async function readMeta(session, code) {
  const meta = (await get(ref(session.db, `rooms/${code}/meta`))).val();
  if (!meta) throw new StoreError('room-not-found', `找不到房間 ${code}，請確認房號`);
  return meta;
}

// 回傳整理過的房號。同一個人再加入一次會覆寫自己那一筆（可用來換桌或改暱稱）。
export async function joinRoom(session, codeInput, nameInput, table) {
  const code = parseRoomCode(codeInput);
  const name = normalizeName(nameInput);
  if (!isValidName(name)) throw new StoreError('invalid-name', `暱稱請輸入 1–${NAME_MAX_LENGTH} 個字`);
  const meta = await readMeta(session, code);
  if (!isValidTable(table, meta.tableCount)) {
    throw new StoreError('invalid-table', `桌號請選 1–${meta.tableCount}`);
  }
  await set(ref(session.db, `rooms/${code}/players/${session.uid}`), { name, table, joinedAt: serverTimestamp() });
  return code;
}

export function leaveRoom(session, code) {
  return remove(ref(session.db, `rooms/${code}/players/${session.uid}`));
}

// 以主持端身分進房，回傳 { code, host }。已經是主持端（開房的人，或主持名單上的人）就是 host: true；
// 還不是就留下一筆申請，等現任主持端核對確認碼後核准，這時 host 是 false。
export async function enterAsHost(session, codeInput) {
  const code = parseRoomCode(codeInput);
  const [meta, listed] = await Promise.all([
    readMeta(session, code),
    get(ref(session.db, `rooms/${code}/hosts/${session.uid}`)),
  ]);
  if (meta.hostUid === session.uid || listed.val() === true) return { code, host: true };
  await set(ref(session.db, `rooms/${code}/hostRequests/${session.uid}`), { requestedAt: serverTimestamp() });
  return { code, host: false };
}

export function cancelHostRequest(session, code) {
  return remove(ref(session.db, `rooms/${code}/hostRequests/${session.uid}`));
}

// 核准：加進主持名單、清掉申請，一次寫入。名單上的人之後也能核准別人。
export async function approveHost(session, code, uid) {
  try {
    await update(ref(session.db, `rooms/${code}`), { [`hosts/${uid}`]: true, [`hostRequests/${uid}`]: null });
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '只有主持端可以核准申請');
    throw error;
  }
}

export async function rejectHost(session, code, uid) {
  try {
    await remove(ref(session.db, `rooms/${code}/hostRequests/${uid}`));
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '只有主持端可以拒絕申請');
    throw error;
  }
}

// 房間有任何變動就呼叫 onRoom(整個房間的資料)；房間不存在時是 null。回傳取消訂閱的函式。
export function watchRoom(session, code, onRoom, onError) {
  return onValue(ref(session.db, `rooms/${code}`), (snapshot) => onRoom(snapshot.val()), onError);
}

// 這台裝置與資料庫的連線一有變化就呼叫 onChange(連上了沒)。回傳取消訂閱的函式。
export function watchConnection(session, onChange) {
  return onValue(ref(session.db, '.info/connected'), (snapshot) => onChange(snapshot.val() === true));
}

// 在房間裡標示「這台裝置在線上」。每次連上（包含斷線後重連）都先請伺服器在斷線時代為移除，再寫入；
// 不定時回報、不寫時間戳。回傳的函式在離開房間時呼叫：取消代為移除的登記，並立刻移除。
export function trackPresence(session, code) {
  const mine = ref(session.db, `rooms/${code}/presence/${session.uid}`);
  let tracking = true;
  let armed = false; // 這一條連線已經向伺服器登記「斷線時代為移除」
  let present = false; // 這台裝置看到的自己那一筆在不在
  let writing = false;
  let refused = false; // 寫入被拒絕（房間不見了）就不再試，等下次連上
  // 該在而不在就寫入。同一個身分較早的連線（換網路後殘留的，或另一個分頁）晚一步斷開時，
  // 伺服器會把這一筆移掉，這裡會補回去。
  const sync = async () => {
    if (!tracking || !armed || present || writing || refused) return;
    writing = true;
    try {
      await set(mine, true);
    } catch {
      refused = true;
    }
    writing = false;
    sync();
  };
  const stopConnection = watchConnection(session, (connected) => {
    armed = false;
    if (!connected) return;
    refused = false;
    onDisconnect(mine)
      .remove()
      .then(() => {
        armed = true;
        sync();
      })
      .catch(() => {}); // 房間不見了才會被拒絕，這時畫面會由房間的訂閱帶回首頁
  });
  const stopMine = onValue(
    mine,
    (snapshot) => {
      present = snapshot.exists();
      sync();
    },
    () => {},
  );
  return async () => {
    tracking = false;
    stopConnection();
    stopMine();
    await Promise.all([onDisconnect(mine).cancel(), remove(mine)]);
  };
}

// 把某一桌往前推一步。expected 是呼叫端以為的現況 { round, phase }：
// 資料庫現況不一樣就不動，所以連點兩下或兩台裝置同時按，都只會前進一步。
// 回傳 { advanced, table }：advanced 表示這次有沒有推進，table 是該桌的最新狀態。
export async function advanceTable(session, code, table, expected) {
  let result;
  try {
    result = await runTransaction(
      ref(session.db, `rooms/${code}/tables/${table}`),
      (current) => {
        if (current === null) return null; // 本機還沒有這一桌的資料：照原樣送出，伺服器比對後會帶最新資料重跑
        if (current.round !== expected.round || current.phase !== expected.phase) return undefined; // 放棄
        return { ...current, ...nextStep(current), updatedAt: serverTimestamp() };
      },
      { applyLocally: false },
    );
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '只有主持端可以推進階段');
    throw error;
  }
  return { advanced: result.committed && result.snapshot.exists(), table: result.snapshot.val() };
}

// 開局與日出發牌都是一筆多路徑寫入：公開的局面（rooms/{code}/games）、處理過日出的回合（rooms/{code}/deals）、
// 各人的私密資料（private）與只有主持端讀得到的牌庫（hostOnly）一起寫，由主持端算好再送出。
// 防重複靠規則：deals 只能往上加、而且要等於該桌目前的回合，開局另外靠 startedAt 只能寫一次；
// 兩台主持端同時寫，後到的那筆整筆被拒。被拒時看伺服器的現況：已經有人寫過（settled）就回傳 false，否則報錯。
async function writeOnce(session, writes, settled, failure) {
  try {
    await update(ref(session.db), writes);
    return true;
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    if (await waitUntil(session, settled.path, settled.done)) return false;
    throw new StoreError('permission-denied', failure);
  }
}

// 等到 path 的值讓 done(值) 成立就回傳 true，等太久回傳 false。寫入剛被拒時，本機有訂閱的話
// 快取可能還沒收到另一台主持端的那筆寫入，直接讀會看到舊的值，所以等伺服器傳來。
const SETTLE_MS = 3000;

function waitUntil(session, path, done, ms = SETTLE_MS) {
  return new Promise((resolve) => {
    let finished = false;
    let stop = null;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stop?.();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), ms);
    stop = onValue(
      ref(session.db, path),
      (snapshot) => done(snapshot.val()) && finish(true),
      () => finish(false),
    );
    if (finished) stop(); // 快取裡已經有答案時，回呼會在 onValue 回傳前就跑完
  });
}

async function readRoom(session, code) {
  const room = (await get(ref(session.db, `rooms/${code}`))).val();
  if (!room?.meta) throw new StoreError('room-not-found', `找不到房間 ${code}，請確認房號`);
  return room;
}

// 牌庫只有主持端讀得到，順便用來確認這台裝置是主持端。
async function readPile(session, code, table, deniedMessage) {
  try {
    return (await get(ref(session.db, `hostOnly/${code}/${table}`))).val() ?? {};
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', deniedMessage);
    throw error;
  }
}

// 開局：players 裡 table＝這一桌的人隨機入座、分階層、發天命與起始手牌，接著做第 1 回合日出，一次寫入。
// data 是 gamedata.js 讀到、檢查過的卡牌資料；random 讓測試注入亂數來源，平常不給。
// 回傳 { started }：false 表示這一桌已經開過局（例如另一台主持端先開了），這次沒有寫入。
export async function startTable(session, code, table, data, random) {
  const room = await readRoom(session, code);
  if (room.games?.[table]) return { started: false };
  const state = room.tables?.[table];
  if (!state) throw new StoreError('invalid-table', `沒有第 ${table} 桌`);
  if (state.round !== 1 || state.phase !== 'sunrise') throw new StoreError('cannot-start', '這一桌已經推進過，不能開局');
  const uids = Object.keys(room.players ?? {}).filter((uid) => room.players[uid].table === table);
  const { error } = checkSeating(uids.length, data.roles.length);
  if (error) throw new StoreError('cannot-start', error);
  await readPile(session, code, table, '只有主持端可以開局');

  const game = startGame(data, uids, { random });
  const writes = {
    [`rooms/${code}/games/${table}`]: {
      startedAt: serverTimestamp(),
      seats: game.seats,
      deckCount: game.deck.length,
      discardCount: game.discard.length,
    },
    [`rooms/${code}/deals/${table}`]: 1,
    [`hostOnly/${code}/${table}`]: { deck: game.deck, discard: game.discard },
  };
  for (const uid of Object.keys(game.seats)) {
    writes[`private/${code}/${uid}`] = { table, hand: game.hands[uid], destiny: game.destinies[uid] };
  }
  const settled = { path: `rooms/${code}/games/${table}`, done: (value) => value !== null };
  return { started: await writeOnce(session, writes, settled, '開局沒有成功，請再按一次') };
}

// 日出發牌：這一桌在日出、已經開局、這一回合還沒發過時，每人領自己階層的薪水、抽牌，一次寫入。
// 回傳 { dealt, round }：dealt 是 false 表示這次沒有寫入（已經發過、還沒開局或不是日出）。
export async function processSunrise(session, code, table, data, random) {
  const room = await readRoom(session, code);
  const state = room.tables?.[table];
  const game = room.games?.[table];
  if (!state || !game || state.phase !== 'sunrise' || (room.deals?.[table] ?? 0) >= state.round) {
    return { dealt: false, round: state?.round ?? null };
  }
  const uids = Object.keys(game.seats);
  const pile = await readPile(session, code, table, '只有主持端可以發牌');
  const privates = await Promise.all(uids.map(async (uid) => (await get(ref(session.db, `private/${code}/${uid}`))).val()));
  const hands = {};
  uids.forEach((uid, index) => {
    if (!privates[index]) throw new StoreError('broken-game', '有玩家的手牌資料不見了，請找工作人員');
    hands[uid] = privates[index].hand ?? [];
  });
  const next = sunrise({ seats: game.seats, hands, deck: pile.deck ?? [], discard: pile.discard ?? [] }, data, random);

  const writes = {
    [`rooms/${code}/games/${table}/seats`]: next.seats,
    [`rooms/${code}/games/${table}/deckCount`]: next.deck.length,
    [`rooms/${code}/games/${table}/discardCount`]: next.discard.length,
    [`rooms/${code}/deals/${table}`]: state.round,
    [`hostOnly/${code}/${table}`]: { deck: next.deck, discard: next.discard },
  };
  for (const uid of uids) writes[`private/${code}/${uid}/hand`] = next.hands[uid];
  const settled = { path: `rooms/${code}/deals/${table}`, done: (value) => (value ?? 0) >= state.round };
  return { dealt: await writeOnce(session, writes, settled, '發牌沒有成功，請按「補發」再試一次'), round: state.round };
}

// 自己的私密資料（{ table, hand, destiny }）一有變動就呼叫 onPrivate(資料)；還沒開局或沒有入座時是 null。
// 公開的局面（games、deals）在房間裡，跟著 watchRoom 一起來。回傳取消訂閱的函式。
export function watchPrivate(session, code, onPrivate, onError) {
  return onValue(ref(session.db, `private/${code}/${session.uid}`), (snapshot) => onPrivate(snapshot.val()), onError);
}
