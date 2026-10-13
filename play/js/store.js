// 唯一碰 Firebase 的檔案：登入、開房、加入、訂閱、推進、主持名單、連線與上線狀態。
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

// code：invalid-code、invalid-name、invalid-table、room-not-found、permission-denied
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
