// 唯一碰 Firebase 的檔案：登入、開房、加入、訂閱、推進、主持名單、連線與上線狀態、開局與日出發牌、白晝出牌與響應卡的
// 請求與結算、黃昏的投票與揭曉、伺服器時間。
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
  push,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  update,
} from 'firebase/database';
import { config } from './config.js';
import {
  checkSeating,
  duskSettleAt,
  duskStage,
  duskStep,
  processRequest,
  responseSettleAt,
  settlePending,
  startGame,
  submittedCount,
  sunrise,
} from './game.js';
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
// cannot-start（人數不對或這一桌已經推進過）、broken-game（局面缺資料）、
// cannot-set-start（已經有人出過牌，或第一張牌正在等響應，不能再指定起始玩家）
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

// 伺服器時間的估計：本機時間＋.info/serverTimeOffset（連上時量到的差，本機不連線時沿用上次的值）。每個連線只訂閱一次，
// 跟著 disconnect 一起結束。
const offsets = new WeakMap();

function serverClock(session) {
  let holder = offsets.get(session.db);
  if (!holder) {
    holder = { offset: 0 };
    offsets.set(session.db, holder);
    onValue(ref(session.db, '.info/serverTimeOffset'), (snapshot) => {
      holder.offset = snapshot.val() ?? 0;
    });
  }
  return () => Date.now() + holder.offset;
}

// 現在的伺服器時間（毫秒，估計值）。畫面的響應倒數用它換算 pending 的 openedAt。
export function serverTime(session) {
  return serverClock(session)();
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
// 防重複靠規則：deals 只能往上加、而且要等於該桌目前的回合，開局另外靠 startedAt 只能寫一次；局面的 version
// 每筆寫入要剛好＋1（開局寫 1）。兩台主持端同時寫，後到的那筆整筆被拒。被拒時看伺服器的現況：
// 已經有人寫過（settled）就回傳 false，否則報錯。
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

async function waitUntil(session, path, done, ms = SETTLE_MS) {
  return (await waitFor(session, path, done, ms)) !== undefined;
}

// 同上，但回傳讓 done 成立的那個值；等太久回傳 undefined。
function waitFor(session, path, done, ms = SETTLE_MS) {
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
    const timer = setTimeout(() => finish(undefined), ms);
    stop = onValue(
      ref(session.db, path),
      (snapshot) => {
        const value = snapshot.val();
        if (done(value)) finish(value);
      },
      () => finish(undefined),
    );
    if (finished) stop(); // 快取裡已經有答案時，回呼會在 onValue 回傳前就跑完
  });
}

async function readRoom(session, code) {
  const room = (await get(ref(session.db, `rooms/${code}`))).val();
  if (!room?.meta) throw new StoreError('room-not-found', `找不到房間 ${code}，請確認房號`);
  return room;
}

// 牌庫與棄牌堆分開寫（hostOnly/{code}/{n}/deck、discard），同一層的法案牌堆（billDeck）才不會被蓋掉。空陣列＝刪掉。
function pileWrites(code, table, { deck, discard }) {
  return { [`hostOnly/${code}/${table}/deck`]: deck, [`hostOnly/${code}/${table}/discard`]: discard };
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

// 入座的人的私密資料。回傳 { records: { uid: { table, hand, destiny, notice } }, hands: { uid: [牌編號…] } }。
async function readPrivates(session, code, uids) {
  const values = await Promise.all(uids.map(async (uid) => (await get(ref(session.db, `private/${code}/${uid}`))).val()));
  const records = {};
  const hands = {};
  uids.forEach((uid, index) => {
    if (!values[index]) throw new StoreError('broken-game', '有玩家的手牌資料不見了，請找工作人員');
    records[uid] = values[index];
    hands[uid] = values[index].hand ?? [];
  });
  return { records, hands };
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
      version: 1,
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
  const pile = await readPile(session, code, table, '只有主持端可以發牌');
  const { hands } = await readPrivates(session, code, Object.keys(game.seats));
  const next = sunrise({ seats: game.seats, hands, deck: pile.deck ?? [], discard: pile.discard ?? [] }, data, random);

  const writes = {
    [`rooms/${code}/games/${table}/seats`]: next.seats,
    [`rooms/${code}/games/${table}/deckCount`]: next.deck.length,
    [`rooms/${code}/games/${table}/discardCount`]: next.discard.length,
    [`rooms/${code}/games/${table}/version`]: (game.version ?? 0) + 1,
    [`rooms/${code}/deals/${table}`]: state.round,
    ...pileWrites(code, table, next),
  };
  for (const uid of Object.keys(game.seats)) writes[`private/${code}/${uid}/hand`] = next.hands[uid];
  const settled = { path: `rooms/${code}/deals/${table}`, done: (value) => (value ?? 0) >= state.round };
  return { dealt: await writeOnce(session, writes, settled, '發牌沒有成功，請按「補發」再試一次'), round: state.round };
}

// 自己的私密資料（{ table, hand, destiny }）一有變動就呼叫 onPrivate(資料)；還沒開局或沒有入座時是 null。
// 公開的局面（games、deals）在房間裡，跟著 watchRoom 一起來。回傳取消訂閱的函式。
export function watchPrivate(session, code, onPrivate, onError) {
  return onValue(ref(session.db, `private/${code}/${session.uid}`), (snapshot) => onPrivate(snapshot.val()), onError);
}

// ---- 白晝出牌（M5a）與響應卡（M5b） ----
// 玩家把「我要出這張牌」「結束這一輪」「我要響應」寫進自己的 requests/{code}/{uid}（本人與主持端讀得到），主持端讀到後
// 檢查、結算、一次寫回（game.js 的 processRequest、settlePending）；玩家的裝置不算任何結果。不合法的請求只寫 lastSeq 與本人的
// notice。一張一般牌先「接下」（付成本、牌離開手牌、寫 games/{n}/pending），響應窗口結束才「結算」（刪 pending、套效果）；
// responseSeconds 是 0 時兩步在同一筆寫入做完。

// 送出請求：序號是自己上一筆＋1（規則只收往上加的），at 是伺服器時間（規則要求剛好等於伺服器收到的時間）。
// 用交易讀寫，重新整理或換分頁後也接得上。回傳這一筆的序號。
async function sendRequest(session, code, fields) {
  let result;
  try {
    result = await runTransaction(ref(session.db, `requests/${code}/${session.uid}`), (current) => ({
      ...fields,
      seq: (current?.seq ?? 0) + 1,
      at: serverTimestamp(),
    }));
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '請求沒有送出，請重新整理後再試一次');
    throw error;
  }
  return result.snapshot.val().seq;
}

// 出牌：card 是手上的牌編號；target 是要指定對象的牌指定的人，chainTarget 是 3 級連鎖指定棄牌的人（都是 uid）。
export function requestPlay(session, code, { card, target = null, chainTarget = null }) {
  const fields = { type: 'play', card };
  if (target) fields.target = target;
  if (chainTarget) fields.chainTarget = chainTarget;
  return sendRequest(session, code, fields);
}

// 結束這一輪（一張都不出也可以）。
export function requestPass(session, code) {
  return sendRequest(session, code, { type: 'pass' });
}

// 響應：card 是手上的響應卡，pending 是要響應的那張牌（該桌 games/{n}/pending 的 id）。
export function requestRespond(session, code, { card, pending }) {
  return sendRequest(session, code, { type: 'respond', card, pending });
}

// 自己最新的一筆請求一有變動就呼叫 onRequest(請求或 null)。回傳取消訂閱的函式。
export function watchRequest(session, code, onRequest, onError) {
  return onValue(ref(session.db, `requests/${code}/${session.uid}`), (snapshot) => onRequest(snapshot.val()), onError);
}

async function readRequest(session, code, uid) {
  try {
    return (await get(ref(session.db, `requests/${code}/${uid}`))).val();
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '只有主持端可以結算出牌');
    throw error;
  }
}

// 整房的請求，一定從伺服器讀：get 遇到涵蓋這個路徑的訂閱會直接回快取，所以這個模組不在 requests/{code} 整房掛訂閱
// （自動結算是逐人訂閱 requests/{code}/{uid}），截止前已經送到伺服器的響應一定讀得到。
async function readRequests(session, code) {
  try {
    return (await get(ref(session.db, `requests/${code}`))).val() ?? {};
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '只有主持端可以結算響應');
    throw error;
  }
}

// 主持端讀成的一桌局面（game.js 的 state）。
function tableStateOf(table, game, hands, pile) {
  return {
    round: table.round,
    phase: table.phase,
    fog: table.fog,
    seats: game.seats,
    startOrder: game.startOrder ?? 0,
    turn: game.turn ?? null,
    fogMax: game.fogMax,
    fogFired: game.fogFired ?? [],
    fogPending: game.fogPending ?? [],
    lastSeq: game.lastSeq ?? {},
    pending: game.pending ?? null,
    hands,
    deck: pile.deck ?? [],
    discard: pile.discard ?? [],
  };
}

const withoutNulls = (record) => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== undefined));

// 一筆結算要寫的所有路徑。局面一律 version＋1；lastSeq 寫有變的；被退回的人寫 notice（{ seq, reason }）。
//   rejected   只有上面這些
//   opened     接下一般牌、開響應窗口：出牌者的座位與手牌、pending（主持端產生的 id、伺服器時間 openedAt、當下的秒數）；
//              輪次與棄牌堆不動
//   passed     輪次
//   played、resolved   結算一張牌：輪次、座位、張數、出牌紀錄、迷霧的紀錄、該桌的迷霧值、有變的手牌、牌庫與棄牌堆；
//              resolved 另外刪掉 pending，出牌紀錄用 pending 的 id 當編號
function settleWrites(session, code, table, before, result, version, data) {
  const game = `rooms/${code}/games/${table}`;
  const next = result.state;
  const writes = { [`${game}/version`]: version + 1 };
  for (const [uid, seq] of Object.entries(next.lastSeq ?? {})) {
    if (seq !== before.lastSeq?.[uid]) writes[`${game}/lastSeq/${uid}`] = seq;
  }
  for (const { uid, seq, reason } of result.notices ?? []) writes[`private/${code}/${uid}/notice`] = { seq, reason };
  if (result.kind === 'rejected') return writes;
  if (result.kind === 'opened') {
    const { by } = result.pending;
    writes[`${game}/seats/${by}`] = next.seats[by];
    writes[`private/${code}/${by}/hand`] = next.hands[by];
    writes[`${game}/pending`] = {
      ...withoutNulls(result.pending),
      id: push(ref(session.db, `${game}/log`)).key,
      openedAt: serverTimestamp(),
      seconds: data.settings.responseSeconds,
    };
    return writes;
  }
  writes[`${game}/turn`] = next.turn;
  if (result.kind === 'passed') return writes;
  if (result.kind === 'resolved') writes[`${game}/pending`] = null;
  writes[`${game}/seats`] = next.seats;
  writes[`${game}/deckCount`] = next.deck.length;
  writes[`${game}/discardCount`] = next.discard.length;
  const logId = before.pending?.id ?? push(ref(session.db, `${game}/log`)).key;
  writes[`${game}/log/${logId}`] = { ...result.log, at: serverTimestamp() };
  for (const key of ['fogMax', 'fogFired', 'fogPending']) {
    if (next[key] !== before[key]) writes[`${game}/${key}`] = next[key];
  }
  if (next.fog !== before.fog) writes[`rooms/${code}/tables/${table}/fog`] = next.fog;
  Object.assign(writes, pileWrites(code, table, next));
  for (const [seatUid, hand] of Object.entries(next.hands)) {
    if (hand.join() !== before.hands[seatUid].join()) writes[`private/${code}/${seatUid}/hand`] = hand;
  }
  return writes;
}

// 結算的寫入被拒、但局面被別的寫入改過時，最多重讀重算幾次。
const SETTLE_ATTEMPTS = 3;

// 主持端結算 uid 在第 table 桌的最新一筆請求。回傳 { outcome, reason }：outcome 是 played（出牌，不開窗口）、
// opened（接下出牌、開了響應窗口）、passed（結束這一輪）、rejected（不合法，寫了 lastSeq 與本人的 notice；reason 是原因）、
// deferred（這一桌有牌在等響應：出牌與結束這一輪等它結算完，響應交給 settleWindow），或 none（這次沒寫入：
// 沒有新請求、已經處理過、另一台主持端先處理了，或這個人的牌在別桌）。
// 每筆寫入帶 version＝讀到的＋1，規則只收剛好＋1 的：兩台主持端同時結算同一筆，後到的整筆被拒。被拒的一方等
// 伺服器的現況，看到這一筆已經處理過（lastSeq 到了）就放手；局面被別的寫入改過就重讀重算；都不是就報錯。
// 先讀局面（version）再讀手牌與牌庫：中間有別的寫入時，讀到的 version 已經舊了、寫入會被拒，
// 不會把新的手牌配上舊的局面寫回去。random 讓測試與 ?seed= 注入亂數來源，平常不給。
export async function settleRequest(session, code, table, uid, data, random) {
  const none = { outcome: 'none', reason: null };
  for (let attempt = 1; ; attempt += 1) {
    const room = await readRoom(session, code);
    const tableState = room.tables?.[table];
    const game = room.games?.[table];
    if (!tableState || !game?.seats?.[uid]) return none;
    if (game.pending) return { outcome: 'deferred', reason: null };
    const request = await readRequest(session, code, uid);
    if (!(request?.seq > (game.lastSeq?.[uid] ?? 0))) return none;
    const pile = await readPile(session, code, table, '只有主持端可以結算出牌');
    const { records, hands } = await readPrivates(session, code, Object.keys(game.seats));
    if (records[uid].table !== table) return none;
    const state = tableStateOf(tableState, game, hands, pile);
    const result = processRequest(state, uid, request, data, random);
    if (result.kind === 'ignored') return none;
    if (result.kind === 'deferred') return { outcome: 'deferred', reason: null };
    if (result.kind === 'rejected') result.notices = [{ uid, seq: request.seq, reason: result.reason }];
    const version = game.version ?? 0;
    try {
      await update(ref(session.db), settleWrites(session, code, table, state, result, version, data));
      return { outcome: result.kind, reason: result.reason ?? null };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const handled = (value) => (value?.lastSeq?.[uid] ?? 0) >= request.seq;
      const seen = await waitFor(session, `rooms/${code}/games/${table}`, (value) => handled(value) || (value?.version ?? 0) !== version);
      if (seen !== undefined && handled(seen)) return none;
      if (seen === undefined || attempt >= SETTLE_ATTEMPTS) throw new StoreError('permission-denied', '出牌沒有結算成功，請找工作人員');
    }
  }
}

// 主持端處理第 table 桌等著響應的那張牌（games/{n}/pending）：有合法的響應就照響應結算（伺服器時間最早的那筆），
// 只有不合法的響應就退回他們（pending 不動），過了截止＋緩衝（responseSettleAt）還沒人響應就照常結算。
// 每次都先記下伺服器時間、再從伺服器重讀整房的請求，所以「時間到」時讀到的一定包含截止前送到伺服器的響應。
// 回傳 { outcome, response }：outcome 是 resolved（結算了，response 是 { by, card } 或 null）、rejected、
// waiting（還沒到時間，也沒有新的響應）或 none（沒有待響應的牌，或另一台主持端先結算了）。
// 多台主持端同時做時靠 version 只成一筆，被拒的一方等局面變了再重讀重算（同 settleRequest）。
export async function settleWindow(session, code, table, data, random) {
  const none = { outcome: 'none', response: null };
  const clock = serverClock(session);
  for (let attempt = 1; ; attempt += 1) {
    const room = await readRoom(session, code);
    const tableState = room.tables?.[table];
    const game = room.games?.[table];
    if (!tableState || !game?.pending) return none;
    const now = clock();
    const requests = await readRequests(session, code);
    const pile = await readPile(session, code, table, '只有主持端可以結算響應');
    const { records, hands } = await readPrivates(session, code, Object.keys(game.seats));
    const here = Object.fromEntries(Object.entries(requests).filter(([uid]) => records[uid]?.table === table));
    const state = tableStateOf(tableState, game, hands, pile);
    const result = settlePending(state, here, data, { now, random });
    if (result.kind === 'waiting') return { outcome: 'waiting', response: null };
    const version = game.version ?? 0;
    try {
      await update(ref(session.db), settleWrites(session, code, table, state, result, version, data));
      const response = result.response ? { by: result.response.by, card: result.response.card } : null;
      return { outcome: result.kind, response };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const seen = await waitFor(session, `rooms/${code}/games/${table}`, (value) => (value?.version ?? 0) !== version);
      if (seen === undefined || attempt >= SETTLE_ATTEMPTS) throw new StoreError('permission-denied', '響應沒有結算成功，請找工作人員');
    }
  }
}

// ---- 黃昏：法案暗標投票（M6） ----
// 玩家把票寫進自己的 votes/{code}/{uid}（本人與主持端讀得到）：{ table, round, side, bid, seq, at }，at 由伺服器填，揭曉前可以
// 重送（蓋掉上一張）。主持端進黃昏時翻法案、盯著已送出的人數、全員送出後寫截止時間（revealAt）、到了截止＋緩衝從伺服器重讀
// 整房的票再揭曉（game.js 的 duskStep），每一筆都帶 version＋1。

// 送出（或改）自己的票：table 是桌號，round 是這一回合；side 是 yes、no 或 abstain，bid 是影響力出價（棄權一律是 0）。
// 序號是自己上一張＋1，at 是伺服器時間（規則都要求），用交易讀寫，同 sendRequest。回傳這一張的序號。
export async function requestVote(session, code, { table, round, side, bid }) {
  let result;
  try {
    result = await runTransaction(ref(session.db, `votes/${code}/${session.uid}`), (current) => ({
      table: String(table),
      round,
      side,
      bid: side === 'abstain' ? 0 : bid,
      seq: (current?.seq ?? 0) + 1,
      at: serverTimestamp(),
    }));
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '這張票沒有送出（可能已經截止，或出價超過影響力），請重新整理後再試一次');
    throw error;
  }
  return result.snapshot.val().seq;
}

// 自己的票一有變動就呼叫 onVote(票或 null)。回傳取消訂閱的函式。
export function watchVote(session, code, onVote, onError) {
  return onValue(ref(session.db, `votes/${code}/${session.uid}`), (snapshot) => onVote(snapshot.val()), onError);
}

// 整房的票，一定從伺服器讀：同 readRequests，這個模組不在 votes/{code} 整房掛訂閱（自動化是逐人訂閱），
// 截止前已經送到伺服器的票一定讀得到；斷線時會等連回來才讀到。
async function readVotes(session, code) {
  try {
    return (await get(ref(session.db, `votes/${code}`))).val() ?? {};
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '只有主持端可以揭曉法案');
    throw error;
  }
}

// 主持端讀成的一桌黃昏局面（game.js 的 state，多了桌號、黃昏、法案結果與法案牌堆）。
function duskStateOf(number, table, game, hands, pile) {
  return {
    ...tableStateOf(table, game, hands, pile),
    table: number,
    dusk: game.dusk ?? null,
    bills: game.bills ?? {},
    billDeck: pile.billDeck ?? [],
  };
}

// 黃昏的一筆寫入（duskStep 的結果）。局面一律 version＋1。
//   opened     dusk（伺服器時間 openedAt；休會沒有 bill）與剩下的法案牌堆
//   counted    已送出人數；全員送出時加上截止時間（倒數 0 秒時直接用伺服器時間）
//   revealed   結果、黃昏紀錄、法案結果、座位（出價、效果、aligned）、有變的張數與手牌、牌庫與棄牌堆、迷霧的紀錄與該桌的迷霧值
function duskWrites(code, table, before, result, version, data) {
  const game = `rooms/${code}/games/${table}`;
  const writes = { [`${game}/version`]: version + 1 };
  if (result.kind === 'opened') {
    writes[`${game}/dusk`] = { ...withoutNulls(result.dusk), openedAt: serverTimestamp() };
    writes[`hostOnly/${code}/${table}/billDeck`] = result.billDeck;
    return writes;
  }
  if (result.kind === 'counted') {
    writes[`${game}/dusk/submitted`] = result.submitted;
    if (result.revealAt !== null) {
      writes[`${game}/dusk/revealAt`] = data.settings.duskRevealSeconds > 0 ? Math.round(result.revealAt) : serverTimestamp();
    }
    return writes;
  }
  const next = result.state;
  writes[`${game}/dusk/result`] = result.result;
  writes[`${game}/duskLog/${before.round}`] = result.log;
  writes[`${game}/bills/${result.log.bill}`] = next.bills[result.log.bill];
  writes[`${game}/seats`] = next.seats;
  for (const key of ['fogMax', 'fogFired', 'fogPending']) {
    if (next[key] !== before[key]) writes[`${game}/${key}`] = next[key];
  }
  if (next.fog !== before.fog) writes[`rooms/${code}/tables/${table}/fog`] = next.fog;
  if (next.deck !== before.deck || next.discard !== before.discard) {
    writes[`${game}/deckCount`] = next.deck.length;
    writes[`${game}/discardCount`] = next.discard.length;
    Object.assign(writes, pileWrites(code, table, next));
  }
  for (const [uid, hand] of Object.entries(next.hands)) {
    if (hand !== before.hands[uid]) writes[`private/${code}/${uid}/hand`] = hand;
  }
  return writes;
}

// 主持端處理第 table 桌的黃昏，該做什麼由 duskStep 決定：進黃昏了還沒翻法案就翻（opened；牌堆抽完、全都通過時休會）、
// 已送出人數變了就更新（counted；全員送出時寫截止時間）、到了截止＋緩衝就揭曉（revealed）。每次都先記下伺服器時間、
// 再從伺服器重讀整房的票。回傳 { outcome, result }：outcome 是 opened、counted、revealed（result 是 { yes, no, passed, votes }）、
// waiting（投票中沒有新的變化，或還沒到揭曉的時間）或 none（不是黃昏、休會、已揭曉，或另一台主持端先做了）。
// 多台主持端同時做時靠 version 只成一筆。被拒的一方等局面變了再重讀重算；局面沒變（例如主持端估的伺服器時間比實際早，
// 揭曉被規則擋在截止之前）就等一下再試，最多 3 次。
export async function settleDusk(session, code, table, data, random) {
  const clock = serverClock(session);
  for (let attempt = 1; ; attempt += 1) {
    const room = await readRoom(session, code);
    const tableState = room.tables?.[table];
    const game = room.games?.[table];
    if (!tableState || !game?.seats) return { outcome: 'none', result: null };
    const stage = duskStage(game.dusk, tableState.round);
    if (stage === 'adjourned' || stage === 'revealed' || (stage === 'none' && tableState.phase !== 'dusk')) return { outcome: 'none', result: null };
    const now = clock();
    const revealing = stage === 'closing' && now >= duskSettleAt(game.dusk);
    const votes = stage === 'none' ? {} : await readVotes(session, code);
    const pile = await readPile(session, code, table, '只有主持端可以處理黃昏');
    const hands = revealing ? (await readPrivates(session, code, Object.keys(game.seats))).hands : {};
    const state = duskStateOf(table, tableState, game, hands, pile);
    const result = duskStep(state, votes, data, { now, random });
    if (result.kind === 'none' || result.kind === 'waiting') return { outcome: result.kind, result: null };
    const version = game.version ?? 0;
    try {
      await update(ref(session.db), duskWrites(code, table, state, result, version, data));
      return { outcome: result.kind, result: result.result ?? null };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      await waitFor(session, `rooms/${code}/games/${table}`, (value) => (value?.version ?? 0) !== version);
      if (attempt >= SETTLE_ATTEMPTS) throw new StoreError('permission-denied', '黃昏沒有結算成功，請找工作人員');
    }
  }
}

// 倒數只剩這麼一點（毫秒）時，提前揭曉不再改截止時間：快到了，也免得跟估計的伺服器時間差撞在一起被規則拒絕。
const EARLY_REVEAL_MARGIN_MS = 500;

// 提前揭曉：把第 table 桌的截止時間改成現在（伺服器時間），沒送出的人算棄權；主持端的自動化在截止＋緩衝後揭曉。
// 只在黃昏、投票中或倒數還沒到時有用。回傳 { closed }：false 表示這次沒有寫入（已經截止、已揭曉、休會或不是黃昏）。
export async function revealDusk(session, code, table) {
  const clock = serverClock(session);
  for (let attempt = 1; ; attempt += 1) {
    const room = await readRoom(session, code);
    const tableState = room.tables?.[table];
    const game = room.games?.[table];
    const stage = duskStage(game?.dusk, tableState?.round);
    const open = stage === 'voting' || (stage === 'closing' && game.dusk.revealAt > clock() + EARLY_REVEAL_MARGIN_MS);
    if (tableState?.phase !== 'dusk' || !open) return { closed: false };
    const version = game.version ?? 0;
    try {
      await update(ref(session.db), {
        [`rooms/${code}/games/${table}/version`]: version + 1,
        [`rooms/${code}/games/${table}/dusk/revealAt`]: serverTimestamp(),
      });
      return { closed: true };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const seen = await waitFor(session, `rooms/${code}/games/${table}`, (value) => (value?.version ?? 0) !== version);
      if (seen === undefined || attempt >= SETTLE_ATTEMPTS) throw new StoreError('permission-denied', '提前揭曉沒有成功，請再按一次');
    }
  }
}

// 主持端自動結算：盯著房間與入座玩家的請求，有還沒處理的請求就交給 settleRequest；有牌在等響應的桌，看到新的響應或
// 到了 responseSettleAt（伺服器時間，本機計時器叫醒）就整桌交給 settleWindow，那一桌的出牌與結束這一輪先等著。
// 黃昏（M6）：進黃昏還沒翻法案、看到已送出的人數變了、或到了截止＋緩衝（本機計時器叫醒），就整桌交給 settleDusk。
// 畫面不用按。多台主持端可以同時開著，同一筆請求只會套用一次。請求與票都是逐人訂閱（requests/{code}/{uid}、
// votes/{code}/{uid}），settleWindow 與 settleDusk 讀整房時才會真的問伺服器。onError(error) 在結算失敗時呼叫。回傳停止的函式。
export function startSettling(session, code, data, { random, onError = () => {} } = {}) {
  const clock = serverClock(session);
  let room = null;
  const requests = {};
  const votes = {};
  const listening = new Map(); // uid → 取消訂閱（請求）
  const listeningVotes = new Map(); // uid → 取消訂閱（票）
  let running = false;
  let stopped = false;
  let timer = null;
  // 「桌:uid」「桌:window」或「桌:dusk」→ 這台沒寫入或失敗時的狀況：同樣的狀況不再自動重試，請求、票、局面或到期與否變了再看。
  const skipped = new Map();
  // 這一桌的黃昏有沒有事要做：開黃昏、更新已送出人數（用逐人訂閱看到的票先算，settleDusk 再從伺服器重讀）、揭曉。
  const duskWork = (table, game) => {
    const tableState = room.tables?.[table];
    if (!tableState) return null;
    const stage = duskStage(game.dusk, tableState.round);
    const version = game.version ?? 0;
    let mark = null;
    if (stage === 'none' && tableState.phase === 'dusk') {
      mark = `${version}@open`;
    } else if (stage === 'closing' && clock() >= duskSettleAt(game.dusk)) {
      mark = `${version}@reveal`;
    } else if ((stage === 'voting' || stage === 'closing') && tableState.phase === 'dusk') {
      const view = { table, round: tableState.round, phase: tableState.phase, seats: game.seats, dusk: game.dusk };
      const count = submittedCount(view, votes);
      const everyone = count === Object.keys(game.seats).length;
      if (count !== (game.dusk.submitted ?? 0) || (everyone && stage === 'voting')) mark = `${version}@count@${count}`;
    }
    const key = `${table}:dusk`;
    return mark !== null && skipped.get(key) !== mark ? { table, key, mark, dusk: true } : null;
  };
  const waiting = () => {
    const work = [];
    for (let table = 1; table <= (room?.meta?.tableCount ?? 0); table += 1) {
      const game = room.games?.[table];
      if (!game?.seats) continue;
      const dusk = duskWork(table, game);
      if (dusk) work.push(dusk);
      const fresh = Object.keys(game.seats).filter((uid) => requests[uid]?.seq > (game.lastSeq?.[uid] ?? 0));
      if (game.pending) {
        const responses = fresh.filter((uid) => requests[uid].type === 'respond');
        const due = clock() >= responseSettleAt(game.pending);
        if (!due && responses.length === 0) continue;
        const key = `${table}:window`;
        const mark = `${game.version ?? 0}@${due}@${responses.map((uid) => `${uid}.${requests[uid].seq}`).join(',')}`;
        if (skipped.get(key) !== mark) work.push({ table, key, mark, window: true });
        continue;
      }
      for (const uid of fresh) {
        const key = `${table}:${uid}`;
        const mark = `${requests[uid].seq}@${game.version ?? 0}`;
        if (skipped.get(key) !== mark) work.push({ table, uid, key, mark });
      }
    }
    return work;
  };
  // 下一張還沒到期的待響應牌、下一個還沒到揭曉時間的黃昏到期時叫醒自己（伺服器時間換算成本機的計時器）。都沒有就不設計時器。
  const arm = () => {
    clearTimeout(timer);
    timer = null;
    if (stopped) return;
    const now = clock();
    const due = [];
    for (let table = 1; table <= (room?.meta?.tableCount ?? 0); table += 1) {
      const game = room.games?.[table];
      if (game?.pending) due.push(responseSettleAt(game.pending));
      if (game?.seats && duskStage(game.dusk, room.tables?.[table]?.round) === 'closing') due.push(duskSettleAt(game.dusk));
    }
    const later = due.filter((at) => Number.isFinite(at) && at > now);
    if (later.length) timer = setTimeout(pump, Math.min(...later) - now + 20);
  };
  const pump = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (let work = waiting(); work.length > 0 && !stopped; work = waiting()) {
        const { table, uid, key, mark, window, dusk } = work[0];
        try {
          let result;
          if (dusk) result = await settleDusk(session, code, table, data, random);
          else if (window) result = await settleWindow(session, code, table, data, random);
          else result = await settleRequest(session, code, table, uid, data, random);
          if (['none', 'waiting', 'deferred'].includes(result.outcome)) skipped.set(key, mark);
        } catch (error) {
          skipped.set(key, mark);
          onError(error);
        }
      }
    } finally {
      running = false;
      arm();
    }
  };
  // 每個入座的人訂閱一次自己那一筆請求、一次自己的票。
  const subscribe = (map, path, store, uid) => {
    if (map.has(uid) || stopped) return;
    const stop = onValue(
      ref(session.db, `${path}/${code}/${uid}`),
      (snapshot) => {
        store[uid] = snapshot.val();
        pump();
      },
      onError,
    );
    map.set(uid, stop);
  };
  const listen = () => {
    for (const game of Object.values(room?.games ?? {})) {
      for (const uid of Object.keys(game?.seats ?? {})) {
        subscribe(listening, 'requests', requests, uid);
        subscribe(listeningVotes, 'votes', votes, uid);
      }
    }
  };
  const stopRoom = onValue(
    ref(session.db, `rooms/${code}`),
    (snapshot) => {
      room = snapshot.val();
      listen();
      pump();
    },
    onError,
  );
  return () => {
    stopped = true;
    clearTimeout(timer);
    stopRoom();
    for (const stop of [...listening.values(), ...listeningVotes.values()]) stop();
  };
}

// 指定第 1 回合的起始座位（order＝座位 0–5）：只限第 1 回合、還沒有人出過牌或結束過一輪、第一張牌也不在等響應。
// 帶 version＋1；跟結算撞在一起時後到的被拒，再按一次就好。
export async function setStartOrder(session, code, table, order) {
  const room = await readRoom(session, code);
  const game = room.games?.[table];
  if (!game) throw new StoreError('invalid-table', `第 ${table} 桌還沒開局`);
  if (room.tables?.[table]?.round !== 1 || game.turn || game.pending) {
    throw new StoreError('cannot-set-start', '已經有人出過牌，不能再指定起始玩家');
  }
  try {
    await update(ref(session.db, `rooms/${code}/games/${table}`), { startOrder: order, version: (game.version ?? 0) + 1 });
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '起始玩家沒有改成，請再按一次');
    throw error;
  }
}
