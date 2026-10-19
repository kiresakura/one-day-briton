// 唯一碰 Firebase 的檔案：登入、開房、加入、訂閱、推進、主持名單、連線與上線狀態、開局與日出發牌（含日出一般事件與手牌上限）、
// 白晝出牌與響應卡的請求與結算、黃昏的投票與揭曉、迷霧事件、黑夜的選擇與揭曉、挑棄牌、終局與計分、伺服器時間，以及主持人控制台的
// 投影與全場指令（display）、全場日落鐘（clock）、投影端回報（screens）與批次動作。
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
  CLOCK_ADJUST_MAX_MS,
  CLOCK_MINUTES_MAX,
  CLOCK_MINUTES_MIN,
  DUSK_GRACE_MS,
  END_PHASE,
  NIGHT_GRACE_MS,
  checkSeating,
  clockAdjustWrite,
  clockPassed,
  clockPauseWrite,
  clockPaused,
  clockResumeWrite,
  clockStartWrite,
  duskSettleAt,
  duskStage,
  duskStep,
  endGame,
  isClock,
  judgeScores,
  nextEventIndex,
  nightSettings,
  nightSettleAt,
  nightStage,
  nightStep,
  pendingDestinies,
  processRequest,
  responseSettleAt,
  rotateSeats,
  settlePending,
  settleSunrise,
  settleSunriseEvents,
  shouldEnd,
  startGame,
  submittedChoices,
  submittedCount,
  withFogEvents,
} from './game.js';
import {
  BROADCAST_MAX_LENGTH,
  MATCH_COUNT,
  MAX_TABLES,
  MUSIC_TRACKS,
  NAME_MAX_LENGTH,
  ROOM_CODE_LENGTH,
  SCENE_IDS,
  SCENE_PAGE_MAX,
  SFX_GAP_MS,
  SFX_IDS,
  activeKey,
  clockOf,
  generateRoomCode,
  initialTable,
  isHostOf,
  isRoomCode,
  isValidBroadcast,
  isValidName,
  isValidScene,
  isValidTable,
  matchKey,
  nextStep,
  normalizeBroadcast,
  normalizeName,
  normalizeRoomCode,
  parseKey,
} from './rules.js';

// code：invalid-code、invalid-name、invalid-table、room-not-found、permission-denied、
// cannot-start（人數不對或這一桌已經推進過）、broken-game（局面缺資料）、
// cannot-set-start（已經有人出過牌，或第一張牌正在等響應，不能再指定起始玩家）、
// night-not-revealed（該算分了，但黑夜還沒揭曉）、game-over（這一桌已經算分了）、no-final（這一桌還沒算分）、
// cannot-open（兩場制：第 1 場還沒結束、還沒算分，或還有天命待判定，不能開第 2 場）、match-locked（第 2 場開了之後第 1 場已鎖定）
// 主持人控制台：invalid-command（指令內容不合法）、conflict（別台主持端剛改過；error.latest 是最新的那一筆）、
// rules-outdated（資料庫規則還沒更新）、rejected（被拒、原因不明）、too-soon（音效一秒內第二次）、no-clock（那一場的全場日落鐘還沒開）、
// clock-passed（已經日落，不能再暫停或加減）、clock-limit（加減調不動）、paused（批次動作中途遇到全場暫停）
//
// 兩場制（M9）：吃「桌」的函式都吃局號（rules.js 的 matchKey）：1、"1" 是第 1 場，"1-2" 是第 2 場；路徑直接用局號，
// 需要實體桌號（players、private 的 table）的地方才 parseKey。
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

// 錯誤訊息裡的桌：「第 1 桌」「第 1 桌第 2 場」。
function tableLabel(key) {
  const parsed = parseKey(key);
  if (!parsed) return `第 ${key} 桌`;
  return parsed.match === 1 ? `第 ${parsed.table} 桌` : `第 ${parsed.table} 桌第 ${parsed.match} 場`;
}

// key 是第 1 場、同一桌的第 2 場已經開了（tables/{n}-2 在）：第 1 場的局面被規則鎖住，任何寫入都被拒。
function isLocked(room, key) {
  const parsed = parseKey(key);
  return parsed?.match === 1 && Boolean(room?.tables?.[matchKey(parsed.table, MATCH_COUNT)]);
}

const lockedError = () => new StoreError('match-locked', '第 1 場已鎖定（第 2 場已經開了），不能再改');

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

// 把某一局（key 是局號）往前推一步。expected 是呼叫端以為的現況 { round, phase }：
// 資料庫現況不一樣就不動，所以連點兩下或兩台裝置同時按，都只會前進一步。
// 回傳 { advanced, table }：advanced 表示這次有沒有推進，table 是該局的最新狀態。
export async function advanceTable(session, code, key, expected) {
  let result;
  try {
    result = await runTransaction(
      ref(session.db, `rooms/${code}/tables/${key}`),
      (current) => {
        if (current === null) return null; // 本機還沒有這一桌的資料：照原樣送出，伺服器比對後會帶最新資料重跑
        if (current.round !== expected.round || current.phase !== expected.phase) return undefined; // 放棄
        if (current.phase === END_PHASE) return undefined; // 終局後不再推進（規則也擋）
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

// 牌庫與棄牌堆分開寫（hostOnly/{code}/{n}/deck、discard），同一層的法案牌堆（billDeck）與一般事件牌堆（eventDeck）才不會被
// 蓋掉。空陣列＝刪掉。
function pileWrites(code, table, { deck, discard }) {
  return { [`hostOnly/${code}/${table}/deck`]: deck, [`hostOnly/${code}/${table}/discard`]: discard };
}

// 這次結算的事件紀錄（game.js 的 events）接在 games/{n}/eventLog 現有的後面，編號連號。
function eventWrites(code, table, game, events) {
  const writes = {};
  const first = nextEventIndex(game?.eventLog);
  (events ?? []).forEach((entry, index) => {
    writes[`rooms/${code}/games/${table}/eventLog/${first + index}`] = entry;
  });
  return writes;
}

// 迷霧的紀錄（fogMax、fogFired、fogPending）與該桌的迷霧值，有變的才寫。空陣列＝刪掉（例如處理完的 fogPending）。
function fogWrites(code, table, before, next) {
  const writes = {};
  for (const key of ['fogMax', 'fogFired', 'fogPending']) {
    if (next[key] !== before[key]) writes[`rooms/${code}/games/${table}/${key}`] = next[key];
  }
  if (next.fog !== before.fog) writes[`rooms/${code}/tables/${table}/fog`] = next.fog;
  return writes;
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

// 開局：players 裡 table＝這一桌的人隨機入座、分階層、發天命與起始手牌，接著做第 1 回合日出（領薪抽牌、翻一般事件、處理它引發的
// 迷霧事件），一次寫入。data 是 gamedata.js 讀到、檢查過的卡牌資料；random 讓測試注入亂數來源，平常不給。
// key 是局號：第 1 場（1、"1"）照上面做，include 不看。第 2 場（"{n}-2"，openMatch 建好的桌）的座位由這裡用 rotateSeats 從第 1 場的
// 座位算（不收畫面算好的座位）：include 是要入座的 uid，沒給就是第 1 場在這一桌有座位、而且 players/{uid}.table 還是這一桌的人；
// include 裡有第 1 場沒坐這一桌的人就報錯。其餘照第 1 場：第 2 場有座位的人的私密資料整筆覆寫（notice、randomDiscard 一起清掉，
// table 是實體桌號），同一筆把 lastSeq 填成每人目前的請求序號（第 1 場最後一筆請求不會在第 2 場被當成新請求結算）。
// 回傳 { started }：false 表示這一局已經開過（例如另一台主持端先開了），這次沒有寫入。
export async function startTable(session, code, key, data, random, { include } = {}) {
  const room = await readRoom(session, code);
  const parsed = parseKey(key);
  if (!parsed) throw new StoreError('invalid-table', `沒有第 ${key} 桌`);
  const { table, match } = parsed;
  if (room.games?.[key]) return { started: false };
  const state = room.tables?.[key];
  if (!state && match === 1) throw new StoreError('invalid-table', `沒有第 ${table} 桌`);
  if (!state) throw new StoreError('cannot-start', `第 ${table} 桌還沒開第 2 場`);
  if (state.round !== 1 || state.phase !== 'sunrise') throw new StoreError('cannot-start', '這一桌已經推進過，不能開局');
  let uids;
  let seating = null;
  if (match === 1) {
    uids = Object.keys(room.players ?? {}).filter((uid) => room.players[uid].table === table);
  } else {
    const first = room.games?.[matchKey(table)]?.seats;
    if (!first) throw new StoreError('broken-game', `第 ${table} 桌第 1 場的座位資料不見了，請找工作人員`);
    const chosen = include == null ? Object.keys(first).filter((uid) => room.players?.[uid]?.table === table) : [...new Set(include)];
    const stranger = chosen.find((uid) => !first[uid]);
    if (stranger !== undefined) {
      throw new StoreError('cannot-start', `${room.players?.[stranger]?.name ?? stranger} 第 1 場沒有坐第 ${table} 桌，第 2 場不能入座`);
    }
    if (chosen.length === 0) throw new StoreError('cannot-start', '第 2 場至少要有 1 人入座');
    seating = rotateSeats(first, chosen);
    uids = seating.map(({ uid }) => uid);
  }
  const { error } = checkSeating(uids.length, data.roles.length);
  if (error) throw new StoreError('cannot-start', error);
  await readPile(session, code, key, '只有主持端可以開局');

  const before = { round: 1, phase: 'sunrise', fog: state.fog ?? 0, fogFired: [], fogPending: [], eventDeck: [] };
  const dealt = startGame(data, uids, seating ? { random, seating } : { random });
  const { state: game, events } = settleSunriseEvents({ ...dealt, ...before }, data, random);
  const opened = {
    startedAt: serverTimestamp(),
    seats: game.seats,
    deckCount: game.deck.length,
    discardCount: game.discard.length,
    version: 1,
  };
  if (events.length > 0) opened.eventLog = events;
  for (const field of ['fogMax', 'fogFired']) {
    if (game[field] !== before[field] && game[field] !== undefined) opened[field] = game[field];
  }
  if (match !== 1) {
    // 第 1 場最後一筆請求（seq）在第 2 場已經算處理過（規則：不超過他自己請求的 seq、而且同一筆有他的座位）。
    const requests = await readRequests(session, code);
    const lastSeq = Object.fromEntries(uids.map((uid) => [uid, requests[uid]?.seq]).filter(([, seq]) => Number.isInteger(seq) && seq >= 1));
    if (Object.keys(lastSeq).length > 0) opened.lastSeq = lastSeq;
  }
  const writes = {
    [`rooms/${code}/games/${key}`]: opened,
    [`rooms/${code}/deals/${key}`]: 1,
    ...pileWrites(code, key, game),
    [`hostOnly/${code}/${key}/eventDeck`]: game.eventDeck,
  };
  if (game.fog !== before.fog) writes[`rooms/${code}/tables/${key}/fog`] = game.fog;
  for (const uid of Object.keys(game.seats)) {
    writes[`private/${code}/${uid}`] = { table, hand: game.hands[uid], destiny: game.destinies[uid] };
  }
  const settled = { path: `rooms/${code}/games/${key}`, done: (value) => value !== null };
  return { started: await writeOnce(session, writes, settled, '開局沒有成功，請再按一次') };
}

// 兩場制第 ① 步「開第 2 場」：第 table 桌（實體桌號）建立第 2 場的桌 tables/{n}-2（第 1 回合日出、迷霧 0、還沒開局），從這一刻起
// 第 1 場的局面（games/{n}）被規則鎖住，不能再改。第 ② 步是 startTable(…, "{n}-2", …)。要第 1 場已經 end、有 final、而且沒有待主持人
// 判定的天命（前兩項規則也擋，第三項只有這裡與畫面擋）；不成立就報 cannot-open，訊息寫出原因。用交易寫，已經有了就不寫：
// 回傳 { opened, key }：opened 是 false 表示另一台主持端先開了（或連點兩下），key 是第 2 場的局號。
export async function openMatch(session, code, table) {
  const parsed = parseKey(table);
  if (!parsed || parsed.match !== 1) throw new StoreError('invalid-table', `沒有第 ${table} 桌`);
  const first = matchKey(parsed.table);
  const key = matchKey(parsed.table, MATCH_COUNT);
  const why = (room) => {
    if (room.tables?.[first]?.phase !== END_PHASE) return `第 ${parsed.table} 桌的第 1 場還沒結束，結束後才能開第 2 場`;
    const final = room.games?.[first]?.final;
    if (!final) return `第 ${parsed.table} 桌的第 1 場還沒有結算分數，不能開第 2 場`;
    const waiting = pendingDestinies(final.scores).length;
    if (waiting > 0) return `第 ${parsed.table} 桌第 1 場還有 ${waiting} 張天命待判定（在結算明細勾），判定完才能開第 2 場`;
    return null;
  };
  const room = await readRoom(session, code);
  if (!room.tables?.[first]) throw new StoreError('invalid-table', `沒有第 ${parsed.table} 桌`);
  if (room.tables?.[key]) return { opened: false, key };
  const reason = why(room);
  if (reason) throw new StoreError('cannot-open', reason);
  let result;
  try {
    result = await runTransaction(
      ref(session.db, `rooms/${code}/tables/${key}`),
      (current) => (current === null ? { ...initialTable(), updatedAt: serverTimestamp() } : undefined),
      { applyLocally: false },
    );
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    const latest = await readRoom(session, code);
    if (latest.tables?.[key]) return { opened: false, key };
    const later = why(latest);
    if (later) throw new StoreError('cannot-open', later);
    throw new StoreError('permission-denied', '只有主持端可以開第 2 場');
  }
  return { opened: result.committed, key };
}

// 日出發牌：這一桌在日出、已經開局、這一回合還沒發過時，先套手牌上限（上一回合黑夜挑的棄牌，從伺服器重讀；沒挑或不合法的
// 亂數棄到上限），再讓每人領自己階層的薪水、抽牌，接著翻這一回合的一般事件（與它引發的迷霧事件），一次寫入（game.js 的
// settleSunrise）。被亂數棄牌的人，同一筆寫入另記 private/{code}/{uid}/randomDiscard＝{ round: 這次日出的回合, cards: [牌編號…] }
// （照手牌原本的順序；只有本人與主持端讀得到）。回傳 { dealt, round }：dealt 是 false 表示這次沒有寫入（已經發過、還沒開局或不是日出）。
export async function processSunrise(session, code, key, data, random) {
  const room = await readRoom(session, code);
  const state = room.tables?.[key];
  const game = room.games?.[key];
  if (!state || !game || state.phase !== 'sunrise' || (room.deals?.[key] ?? 0) >= state.round) {
    return { dealt: false, round: state?.round ?? null };
  }
  const pile = await readPile(session, code, key, '只有主持端可以發牌');
  const { hands } = await readPrivates(session, code, Object.keys(game.seats));
  const picks = await readDiscards(session, code);
  const before = {
    round: state.round,
    phase: 'sunrise',
    fog: state.fog,
    fogMax: game.fogMax,
    fogFired: game.fogFired ?? [],
    fogPending: game.fogPending ?? [],
    eventDeck: pile.eventDeck ?? [],
  };
  const dealing = { table: key, seats: game.seats, hands, deck: pile.deck ?? [], discard: pile.discard ?? [], ...before };
  const { state: next, events, randomDiscards } = settleSunrise(dealing, picks, data, random);

  const writes = {
    [`rooms/${code}/games/${key}/seats`]: next.seats,
    [`rooms/${code}/games/${key}/deckCount`]: next.deck.length,
    [`rooms/${code}/games/${key}/discardCount`]: next.discard.length,
    [`rooms/${code}/games/${key}/version`]: (game.version ?? 0) + 1,
    [`rooms/${code}/deals/${key}`]: state.round,
    ...pileWrites(code, key, next),
    ...fogWrites(code, key, before, next),
    ...eventWrites(code, key, game, events),
  };
  if (next.eventDeck.join() !== before.eventDeck.join()) writes[`hostOnly/${code}/${key}/eventDeck`] = next.eventDeck;
  for (const uid of Object.keys(game.seats)) writes[`private/${code}/${uid}/hand`] = next.hands[uid];
  for (const [uid, cards] of Object.entries(randomDiscards)) writes[`private/${code}/${uid}/randomDiscard`] = { round: state.round, cards };
  const settled = { path: `rooms/${code}/deals/${key}`, done: (value) => (value ?? 0) >= state.round };
  return { dealt: await writeOnce(session, writes, settled, '發牌沒有成功，請按「補發」再試一次'), round: state.round };
}

// 自己的私密資料（{ table, hand, destiny, notice, randomDiscard }）一有變動就呼叫 onPrivate(資料)；還沒開局或沒有入座時是 null。
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
//              resolved 另外刪掉 pending，出牌紀錄用 pending 的 id 當編號。這張牌引發的迷霧事件已在 result.state 裡結算完
//              （withFogEvents，fogPending 清空），事件紀錄由呼叫的一端用 eventWrites 接在同一筆
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

// 主持端結算 uid 在 key 這一局的最新一筆請求。回傳 { outcome, reason }：outcome 是 played（出牌，不開窗口）、
// opened（接下出牌、開了響應窗口）、passed（結束這一輪）、rejected（不合法，寫了 lastSeq 與本人的 notice；reason 是原因）、
// deferred（這一桌有牌在等響應：出牌與結束這一輪等它結算完，響應交給 settleWindow），或 none（這次沒寫入：
// 沒有新請求、已經處理過、另一台主持端先處理了，或這個人的牌在別桌）。
// 每筆寫入帶 version＝讀到的＋1，規則只收剛好＋1 的：兩台主持端同時結算同一筆，後到的整筆被拒。被拒的一方等
// 伺服器的現況，看到這一筆已經處理過（lastSeq 到了）就放手；局面被別的寫入改過就重讀重算；都不是就報錯。
// 先讀局面（version）再讀手牌與牌庫：中間有別的寫入時，讀到的 version 已經舊了、寫入會被拒，
// 不會把新的手牌配上舊的局面寫回去。random 讓測試與 ?seed= 注入亂數來源，平常不給。
export async function settleRequest(session, code, key, uid, data, random) {
  const none = { outcome: 'none', reason: null };
  for (let attempt = 1; ; attempt += 1) {
    const room = await readRoom(session, code);
    const tableState = room.tables?.[key];
    const game = room.games?.[key];
    if (!tableState || tableState.phase === END_PHASE || !game?.seats?.[uid]) return none;
    if (game.pending) return { outcome: 'deferred', reason: null };
    const request = await readRequest(session, code, uid);
    if (!(request?.seq > (game.lastSeq?.[uid] ?? 0))) return none;
    const pile = await readPile(session, code, key, '只有主持端可以結算出牌');
    const { records, hands } = await readPrivates(session, code, Object.keys(game.seats));
    if (activeKey(room, records[uid].table) !== String(key)) return none; // 這個人目前不在這一局（例如牌在別桌）
    const state = tableStateOf(tableState, game, hands, pile);
    const result = withFogEvents(processRequest(state, uid, request, data, random), data, random);
    if (result.kind === 'ignored') return none;
    if (result.kind === 'deferred') return { outcome: 'deferred', reason: null };
    if (result.kind === 'rejected') result.notices = [{ uid, seq: request.seq, reason: result.reason }];
    const version = game.version ?? 0;
    try {
      await update(ref(session.db), { ...settleWrites(session, code, key, state, result, version, data), ...eventWrites(code, key, game, result.events) });
      return { outcome: result.kind, reason: result.reason ?? null };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const handled = (value) => (value?.lastSeq?.[uid] ?? 0) >= request.seq;
      const seen = await waitFor(session, `rooms/${code}/games/${key}`, (value) => handled(value) || (value?.version ?? 0) !== version);
      if (seen !== undefined && handled(seen)) return none;
      if (seen === undefined || attempt >= SETTLE_ATTEMPTS) throw new StoreError('permission-denied', '出牌沒有結算成功，請找工作人員');
    }
  }
}

// 主持端處理 key 這一局等著響應的那張牌（games/{n}/pending）：有合法的響應就照響應結算（伺服器時間最早的那筆），
// 只有不合法的響應就退回他們（pending 不動），過了截止＋緩衝（responseSettleAt）還沒人響應就照常結算。
// 每次都先記下伺服器時間、再從伺服器重讀整房的請求，所以「時間到」時讀到的一定包含截止前送到伺服器的響應。
// 回傳 { outcome, response }：outcome 是 resolved（結算了，response 是 { by, card } 或 null）、rejected、
// waiting（還沒到時間，也沒有新的響應）或 none（沒有待響應的牌，或另一台主持端先結算了）。
// 多台主持端同時做時靠 version 只成一筆，被拒的一方等局面變了再重讀重算（同 settleRequest）。
export async function settleWindow(session, code, key, data, random) {
  const none = { outcome: 'none', response: null };
  const clock = serverClock(session);
  for (let attempt = 1; ; attempt += 1) {
    const room = await readRoom(session, code);
    const tableState = room.tables?.[key];
    const game = room.games?.[key];
    if (!tableState || tableState.phase === END_PHASE || !game?.pending) return none;
    const now = clock();
    const requests = await readRequests(session, code);
    const pile = await readPile(session, code, key, '只有主持端可以結算響應');
    const { records, hands } = await readPrivates(session, code, Object.keys(game.seats));
    const here = Object.fromEntries(Object.entries(requests).filter(([uid]) => records[uid] && activeKey(room, records[uid].table) === String(key)));
    const state = tableStateOf(tableState, game, hands, pile);
    const result = withFogEvents(settlePending(state, here, data, { now, random }), data, random);
    if (result.kind === 'waiting') return { outcome: 'waiting', response: null };
    const version = game.version ?? 0;
    try {
      await update(ref(session.db), { ...settleWrites(session, code, key, state, result, version, data), ...eventWrites(code, key, game, result.events) });
      const response = result.response ? { by: result.response.by, card: result.response.card } : null;
      return { outcome: result.kind, response };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const seen = await waitFor(session, `rooms/${code}/games/${key}`, (value) => (value?.version ?? 0) !== version);
      if (seen === undefined || attempt >= SETTLE_ATTEMPTS) throw new StoreError('permission-denied', '響應沒有結算成功，請找工作人員');
    }
  }
}

// ---- 黃昏：法案暗標投票（M6） ----
// 玩家把票寫進自己的 votes/{code}/{uid}（本人與主持端讀得到）：{ table, round, side, bid, seq, at }，at 由伺服器填，揭曉前可以
// 重送（蓋掉上一張）。主持端進黃昏時翻法案、盯著已送出的人數、全員送出後寫截止時間（revealAt）、到了截止＋緩衝從伺服器重讀
// 整房的票再揭曉（game.js 的 duskStep），每一筆都帶 version＋1。

// 送出（或改）自己的票：table 是局號（第 2 場是 "1-2" 這種），round 是這一回合；side 是 yes、no 或 abstain，bid 是影響力出價（棄權一律是 0）。
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
//   revealed   結果、黃昏紀錄、法案結果、座位（出價、效果、aligned）、有變的張數與手牌、牌庫與棄牌堆、迷霧的紀錄與該桌的迷霧值；
//              法案引發的迷霧事件已在 result.state 裡結算完（withFogEvents），事件紀錄由呼叫的一端用 eventWrites 接在同一筆
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

// 主持端處理 key 這一局的黃昏，該做什麼由 duskStep 決定：進黃昏了還沒翻法案就翻（opened；牌堆抽完、全都通過時休會）、
// 已送出人數變了就更新（counted；全員送出時寫截止時間）、到了截止＋緩衝就揭曉（revealed）。每次都先記下伺服器時間、
// 再從伺服器重讀整房的票。回傳 { outcome, result }：outcome 是 opened、counted、revealed（result 是 { yes, no, passed, votes }）、
// waiting（投票中沒有新的變化，或還沒到揭曉的時間）或 none（不是黃昏、休會、已揭曉，或另一台主持端先做了）。
// 多台主持端同時做時靠 version 只成一筆。被拒的一方等局面變了再重讀重算：票接連進來時，兩台主持端會一步接一步地搶，
// 局面一直在變就一直重算（最多 DUSK_ATTEMPTS 次）。揭曉被拒而局面沒變（主持端估的伺服器時間比實際早，被規則擋在截止之前）
// 就等 1 秒再試（最多 3 次）；其他被拒而局面沒變的就報錯（同 settleWindow），不讓自動化卡太久。
const DUSK_ATTEMPTS = 10;

export async function settleDusk(session, code, key, data, random) {
  const clock = serverClock(session);
  let stalls = 0; // 被拒而局面沒變的次數
  for (let attempt = 1; ; attempt += 1) {
    const room = await readRoom(session, code);
    const tableState = room.tables?.[key];
    const game = room.games?.[key];
    if (!tableState || tableState.phase === END_PHASE || !game?.seats) return { outcome: 'none', result: null };
    const stage = duskStage(game.dusk, tableState.round);
    if (stage === 'adjourned' || stage === 'revealed' || (stage === 'none' && tableState.phase !== 'dusk')) return { outcome: 'none', result: null };
    const now = clock();
    const revealing = stage === 'closing' && now >= duskSettleAt(game.dusk);
    const votes = stage === 'none' ? {} : await readVotes(session, code);
    const pile = await readPile(session, code, key, '只有主持端可以處理黃昏');
    const hands = revealing ? (await readPrivates(session, code, Object.keys(game.seats))).hands : {};
    const state = duskStateOf(key, tableState, game, hands, pile);
    const result = withFogEvents(duskStep(state, votes, data, { now, random }), data, random);
    if (result.kind === 'none' || result.kind === 'waiting') return { outcome: result.kind, result: null };
    const version = game.version ?? 0;
    try {
      await update(ref(session.db), { ...duskWrites(code, key, state, result, version, data), ...eventWrites(code, key, game, result.events) });
      return { outcome: result.kind, result: result.result ?? null };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const revealing = result.kind === 'revealed';
      const changed = (value) => (value?.version ?? 0) !== version;
      const seen = await waitFor(session, `rooms/${code}/games/${key}`, changed, revealing ? DUSK_GRACE_MS : SETTLE_MS);
      if (seen === undefined) stalls += 1;
      const stuck = seen === undefined && (!revealing || stalls >= SETTLE_ATTEMPTS);
      if (stuck || attempt >= DUSK_ATTEMPTS) throw new StoreError('permission-denied', '黃昏沒有結算成功，請找工作人員');
    }
  }
}

// 倒數只剩這麼一點（毫秒）時，提前揭曉不再改截止時間：快到了，也免得跟估計的伺服器時間差撞在一起被規則拒絕。
const EARLY_REVEAL_MARGIN_MS = 500;

// 提前揭曉：把 key 這一局的截止時間改成現在（伺服器時間），沒送出的人算棄權；主持端的自動化在截止＋緩衝後揭曉。
// 只在黃昏、投票中或倒數還沒到時有用。回傳 { closed }：false 表示這次沒有寫入（已經截止、已揭曉、休會或不是黃昏）。
export async function revealDusk(session, code, key) {
  const clock = serverClock(session);
  for (let attempt = 1; ; attempt += 1) {
    const room = await readRoom(session, code);
    const tableState = room.tables?.[key];
    const game = room.games?.[key];
    const stage = duskStage(game?.dusk, tableState?.round);
    const open = stage === 'voting' || (stage === 'closing' && game.dusk.revealAt > clock() + EARLY_REVEAL_MARGIN_MS);
    if (tableState?.phase !== 'dusk' || !open) return { closed: false };
    const version = game.version ?? 0;
    try {
      await update(ref(session.db), {
        [`rooms/${code}/games/${key}/version`]: version + 1,
        [`rooms/${code}/games/${key}/dusk/revealAt`]: serverTimestamp(),
      });
      return { closed: true };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const seen = await waitFor(session, `rooms/${code}/games/${key}`, (value) => (value?.version ?? 0) !== version);
      if (seen === undefined || attempt >= SETTLE_ATTEMPTS) throw new StoreError('permission-denied', '提前揭曉沒有成功，請再按一次');
    }
  }
}

// ---- 黑夜：豪賭、分贓、睡覺（M8）與挑棄牌 ----
// 玩家把選擇寫進自己的 nights/{code}/{uid}（本人與主持端讀得到）：{ table, round, choice, tiers, seq, at }，at 由伺服器填，揭曉前可以
// 重送（蓋掉上一筆）。主持端進黑夜時開黑夜、盯著已送出的人數、全員送出後寫截止時間（revealAt）、到了截止＋緩衝從伺服器重讀整房
// 的選擇再揭曉（game.js 的 nightStep），每一筆都帶 version＋1，做法同黃昏。手牌超過上限的人把要棄的牌寫進自己的
// discards/{code}/{uid}：{ table, round, cards, seq, at }，主持端在下一回合日出那一筆最前面套用（processSunrise）。

// 送出（或改）自己的黑夜選擇：table 是局號（同 requestVote），choice 是 gamble、split 或 sleep，tiers 是豪賭最多賭到第幾層（只有豪賭帶）。序號是自己上一筆＋1，
// at 是伺服器時間，用交易讀寫，同 requestVote。回傳這一筆的序號。
export async function requestNight(session, code, { table, round, choice, tiers = null }) {
  let result;
  try {
    result = await runTransaction(ref(session.db, `nights/${code}/${session.uid}`), (current) => {
      const next = { table: String(table), round, choice, seq: (current?.seq ?? 0) + 1, at: serverTimestamp() };
      if (choice === 'gamble') next.tiers = tiers;
      return next;
    });
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '這個選擇沒有送出（可能已經截止），請重新整理後再試一次');
    throw error;
  }
  return result.snapshot.val().seq;
}

// 挑要棄的牌（黑夜期間，揭曉前後都可以；重挑蓋掉上一次）：table 是局號（同 requestVote），cards 是手上的牌編號。序號與時間同 requestNight。回傳這一筆的序號。
export async function requestDiscard(session, code, { table, round, cards }) {
  let result;
  try {
    result = await runTransaction(ref(session.db, `discards/${code}/${session.uid}`), (current) => ({
      table: String(table),
      round,
      cards: [...cards],
      seq: (current?.seq ?? 0) + 1,
      at: serverTimestamp(),
    }));
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '挑的牌沒有送出（可能已經不是黑夜），請重新整理後再試一次');
    throw error;
  }
  return result.snapshot.val().seq;
}

// 自己的黑夜選擇一有變動就呼叫 onNight(選擇或 null)。回傳取消訂閱的函式。
export function watchNight(session, code, onNight, onError) {
  return onValue(ref(session.db, `nights/${code}/${session.uid}`), (snapshot) => onNight(snapshot.val()), onError);
}

// uid（沒給就是自己）挑的棄牌一有變動就呼叫 onDiscard(挑的棄牌或 null)；主持端用它列出還沒挑的人。回傳取消訂閱的函式。
export function watchDiscard(session, code, onDiscard, onError, uid = session.uid) {
  return onValue(ref(session.db, `discards/${code}/${uid}`), (snapshot) => onDiscard(snapshot.val()), onError);
}

// 整房的黑夜選擇與挑的棄牌，一定從伺服器讀：同 readVotes，這個模組不在 nights/{code}、discards/{code} 整房掛訂閱
// （自動化與畫面都是逐人訂閱），截止前已經送到伺服器的選擇一定讀得到；斷線時會等連回來才讀到。
async function readNights(session, code) {
  try {
    return (await get(ref(session.db, `nights/${code}`))).val() ?? {};
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '只有主持端可以處理黑夜');
    throw error;
  }
}

async function readDiscards(session, code) {
  try {
    return (await get(ref(session.db, `discards/${code}`))).val() ?? {};
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '只有主持端可以發牌');
    throw error;
  }
}

// 主持端讀成的一桌黑夜局面（game.js 的 state：回合、階段、座位、桌號、黑夜）。黑夜不碰手牌與牌庫。
function nightStateOf(number, table, game) {
  return { round: table.round, phase: table.phase, fog: table.fog, seats: game.seats, table: number, night: game.night ?? null };
}

// 黑夜的一筆寫入（nightStep 的結果）。局面一律 version＋1。
//   opened     night（伺服器時間 openedAt），蓋掉上一回合的黑夜
//   counted    已送出人數；全員送出時加上截止時間（倒數 0 秒時直接用伺服器時間）
//   revealed   結果、黑夜紀錄、座位（英鎊、影響力、罪孽）；黑夜不動迷霧、手牌與牌庫
function nightWrites(code, table, before, result, version, data) {
  const game = `rooms/${code}/games/${table}`;
  const writes = { [`${game}/version`]: version + 1 };
  if (result.kind === 'opened') {
    writes[`${game}/night`] = { ...result.night, openedAt: serverTimestamp() };
    return writes;
  }
  if (result.kind === 'counted') {
    writes[`${game}/night/submitted`] = result.submitted;
    if (result.revealAt !== null) {
      writes[`${game}/night/revealAt`] = nightSettings(data.settings).revealSeconds > 0 ? Math.round(result.revealAt) : serverTimestamp();
    }
    return writes;
  }
  writes[`${game}/night/result`] = result.result;
  writes[`${game}/nightLog/${before.round}`] = result.log;
  writes[`${game}/seats`] = result.state.seats;
  return writes;
}

// 主持端處理 key 這一局的黑夜，該做什麼由 nightStep 決定：進黑夜了還沒開就開（opened）、已送出人數變了就更新（counted；全員送出時
// 寫截止時間）、到了截止＋緩衝就揭曉（revealed，骰子在這一次擲）。每次都先記下伺服器時間、再從伺服器重讀整房的選擇。
// 回傳 { outcome, result }：outcome 是 opened、counted、revealed（result 是 { players }）、waiting 或 none（不是黑夜、已揭曉，
// 或另一台主持端先做了）。多台主持端同時做時靠 version 只成一筆，被拒的處理同 settleDusk（局面變了就重讀重算；揭曉被擋在截止之前
// 就等 1 秒再試，最多 3 次；其他被拒而局面沒變的就報錯）。「局面變了」另外包括該桌的回合或階段變了：讀到的房間是本機快取，
// 剛被推進到下一個階段時，照舊階段算的寫入會被規則擋下，這時重讀就好，不用等。
export async function settleNight(session, code, key, data, random) {
  const clock = serverClock(session);
  let stalls = 0; // 被拒而局面沒變的次數
  for (let attempt = 1; ; attempt += 1) {
    const room = await readRoom(session, code);
    const tableState = room.tables?.[key];
    const game = room.games?.[key];
    if (!tableState || tableState.phase === END_PHASE || !game?.seats) return { outcome: 'none', result: null };
    const stage = nightStage(game.night, tableState.round);
    if (stage === 'revealed' || (stage === 'none' && tableState.phase !== 'night')) return { outcome: 'none', result: null };
    const now = clock();
    const picks = await readNights(session, code);
    const state = nightStateOf(key, tableState, game);
    const result = nightStep(state, picks, data, { now, random });
    if (result.kind === 'none' || result.kind === 'waiting') return { outcome: result.kind, result: null };
    // 倒數的截止時間從寫入前一刻的伺服器時間算：讀整房的選擇要一來一回，網路慢時「讀之前的時間＋3 秒」到寫入時可能已經過了。
    if (result.kind === 'counted' && result.revealAt !== null) result.revealAt = clock() + (result.revealAt - now);
    const version = game.version ?? 0;
    try {
      await update(ref(session.db), nightWrites(code, key, state, result, version, data));
      return { outcome: result.kind, result: result.result ?? null };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const revealing = result.kind === 'revealed';
      const changed = (value) =>
        (value?.games?.[key]?.version ?? 0) !== version || value?.tables?.[key]?.round !== tableState.round || value?.tables?.[key]?.phase !== tableState.phase;
      const seen = await waitFor(session, `rooms/${code}`, changed, revealing ? NIGHT_GRACE_MS : SETTLE_MS);
      if (seen === undefined) stalls += 1;
      const stuck = seen === undefined && (!revealing || stalls >= SETTLE_ATTEMPTS);
      if (stuck || attempt >= DUSK_ATTEMPTS) throw new StoreError('permission-denied', '黑夜沒有結算成功，請找工作人員');
    }
  }
}

// 黑夜的揭曉沒成功（例如主持端估的伺服器時間比實際快好幾秒，規則一直擋在截止之前）時，自動化隔多久再試一次（毫秒）。
// 黑夜揭曉前畫面擋住「下一階段」，不再試的話那一桌就卡在黑夜，要重新整理主持畫面才會再試。
const NIGHT_RETRY_MS = 5000;

// 提前揭曉黑夜：把 key 這一局的截止時間改成現在（伺服器時間），沒送出的人算睡覺；主持端的自動化在截止＋緩衝後揭曉。
// 只在黑夜、選擇中或倒數還沒到時有用。回傳 { closed }：false 表示這次沒有寫入（已經截止、已揭曉或不是黑夜）。
export async function revealNight(session, code, key) {
  const clock = serverClock(session);
  for (let attempt = 1; ; attempt += 1) {
    const room = await readRoom(session, code);
    const tableState = room.tables?.[key];
    const game = room.games?.[key];
    const stage = nightStage(game?.night, tableState?.round);
    const open = stage === 'choosing' || (stage === 'closing' && game.night.revealAt > clock() + EARLY_REVEAL_MARGIN_MS);
    if (tableState?.phase !== 'night' || !open) return { closed: false };
    const version = game.version ?? 0;
    try {
      await update(ref(session.db), {
        [`rooms/${code}/games/${key}/version`]: version + 1,
        [`rooms/${code}/games/${key}/night/revealAt`]: serverTimestamp(),
      });
      return { closed: true };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const seen = await waitFor(session, `rooms/${code}/games/${key}`, (value) => (value?.version ?? 0) !== version);
      if (seen === undefined || attempt >= SETTLE_ATTEMPTS) throw new StoreError('permission-denied', '提前揭曉沒有成功，請再按一次');
    }
  }
}

// ---- 終局與計分（M9） ----
// 主持端在黑夜（揭曉後）按「下一階段」時，該終局（game.js 的 shouldEnd：日落鐘到了、到了回合上限、主持端按了「這回合結束後算分」）
// 就不推進到下一回合日出，改成一筆寫入：該桌 phase＝end、games/{n}/final（分數、名次、每個人的天命與是否達成，天命這時才公開）、
// version＋1；這一筆不做日出棄牌、不領薪抽牌、不翻事件，挑好的棄牌不用。英鎊、影響力、罪孽讀座位的現值，天命從私密資料讀（伺服器），
// 判定照天命的 check。「判定」空白的天命由主持端勾（judgeDestiny）。各桌各自結束。

// 資料庫不存 null 與空的陣列、物件：寫入前拿掉（final 裡沒有天命的 id、text，待判定的 done，沒有成就的 achievements）。
const compact = (value) =>
  JSON.parse(JSON.stringify(value), (key, item) => {
    if (item === null) return undefined;
    if (Array.isArray(item) && item.length === 0) return undefined;
    if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) return undefined;
    return item;
  });

// 主持端讀成的終局局面（game.js 的 endGame）：回合、座位、各人的天命編號、迷霧值與本場最高、法案結果、出牌紀錄（齒輪大師）。
function endStateOf(table, game, records) {
  return {
    round: table.round,
    seats: game.seats,
    destinies: Object.fromEntries(Object.entries(records).map(([uid, record]) => [uid, record.destiny ?? null])),
    fog: table.fog,
    fogMax: game.fogMax,
    bills: game.bills ?? {},
    log: game.log ?? {},
  };
}

// 主持端的「下一階段」。expected 是畫面上這一刻的 { round, phase }（同 advanceTable）。黑夜以外照舊推進；黑夜時先看要不要終局，
// 要的話寫終局那一筆，不要就照舊推進（推進到新回合日出後由呼叫的一端接著發牌）。data 是卡牌資料（設定、天命）。
// 回傳 { advanced, ended, reason, table }：ended 是 true＝這次寫了終局（reason 是 sunset、maxRounds 或 host），advanced 是 false＝這次
// 沒有寫入（資料庫已經不是 expected，例如另一台主持端先推進或先算分了）。黑夜還沒揭曉卻該算分時報錯（畫面已經擋住「下一階段」）。
// 兩台主持端同時算分只成一筆（version 只收＋1；規則另外擋已經終局的桌），被拒的一方等局面變了重讀，看到已經終局就回 advanced: false。
// 日落鐘：那一場有全場日落鐘（rooms/{code}/clock/{場次}）時照它，沒有時照舊從該桌的 startedAt 算（game.js 的 shouldEnd）。
// allowEnd 是 false 時，該算分的桌不寫終局，回 { advanced: false, ended: false, held: true, reason, table }（批次推進用：算分要主持人另外勾）。
export async function advanceOrEnd(session, code, key, expected, data, { allowEnd = true } = {}) {
  const advance = async () => ({ ...(await advanceTable(session, code, key, expected)), ended: false, reason: null });
  if (expected.phase !== 'night') return advance();
  const clock = serverClock(session);
  for (let attempt = 1; ; attempt += 1) {
    const room = await readRoom(session, code);
    const tableState = room.tables?.[key];
    const game = room.games?.[key];
    if (!tableState || tableState.round !== expected.round || tableState.phase !== expected.phase) {
      return { advanced: false, ended: false, reason: null, table: tableState ?? null };
    }
    const state = { round: tableState.round, startedAt: game?.startedAt, endAfterRound: game?.endAfterRound };
    const reason = game?.seats ? shouldEnd(state, data.settings, clock(), clockOf(room, key)) : null;
    if (!reason) return advance();
    if (!allowEnd) return { advanced: false, ended: false, held: true, reason, table: tableState };
    if (nightStage(game.night, tableState.round) !== 'revealed') throw new StoreError('night-not-revealed', '黑夜還沒揭曉，揭曉後才能算分');
    await readPile(session, code, key, '只有主持端可以算分');
    const { records } = await readPrivates(session, code, Object.keys(game.seats));
    const final = endGame(endStateOf(tableState, game, records), data, reason);
    const version = game.version ?? 0;
    try {
      await update(ref(session.db), {
        [`rooms/${code}/tables/${key}/phase`]: END_PHASE,
        [`rooms/${code}/tables/${key}/updatedAt`]: serverTimestamp(),
        [`rooms/${code}/games/${key}/version`]: version + 1,
        [`rooms/${code}/games/${key}/final`]: { ...compact(final), endedAt: serverTimestamp() },
      });
      return { advanced: true, ended: true, reason, table: { ...tableState, phase: END_PHASE } };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const changed = (value) =>
        (value?.games?.[key]?.version ?? 0) !== version || value?.tables?.[key]?.round !== tableState.round || value?.tables?.[key]?.phase !== tableState.phase;
      const seen = await waitFor(session, `rooms/${code}`, changed);
      if (seen === undefined || attempt >= SETTLE_ATTEMPTS) throw new StoreError('permission-denied', '算分沒有成功，請再按一次');
    }
  }
}

// 寫第 1 場被拒時（例如本機快取還沒看到另一台主持端剛開了第 2 場）：等伺服器的現況，看到第 1 場已鎖定就報 match-locked，
// 看到局面變了回傳那份房間（呼叫的一端重讀重算），都沒有回傳 undefined。
async function waitAfterDenied(session, code, key, version) {
  const seen = await waitFor(session, `rooms/${code}`, (room) => isLocked(room, key) || (room?.games?.[key]?.version ?? 0) !== version);
  if (seen !== undefined && isLocked(seen, key)) throw lockedError();
  return seen;
}

// 「這回合結束後算分」：on 是 true 時在 games/{n}/endAfterRound 寫下目前的回合（這一回合黑夜揭曉後按「下一階段」就算分），
// false 時刪掉（取消）。帶 version＋1；跟自動化的寫入撞在一起時等局面變了再試。回傳 { endAfterRound }：寫入後的值（取消是 null）。
// 第 1 場已鎖定（第 2 場開了）時報 match-locked。
export async function setEndAfterRound(session, code, key, on) {
  for (let attempt = 1; ; attempt += 1) {
    const room = await readRoom(session, code);
    const tableState = room.tables?.[key];
    const game = room.games?.[key];
    if (!tableState || !game) throw new StoreError('invalid-table', `${tableLabel(key)}還沒開局`);
    if (isLocked(room, key)) throw lockedError();
    if (tableState.phase === END_PHASE) throw new StoreError('game-over', '這一桌已經算分了');
    const value = on ? tableState.round : null;
    if ((game.endAfterRound ?? null) === value) return { endAfterRound: value };
    const version = game.version ?? 0;
    try {
      await update(ref(session.db, `rooms/${code}/games/${key}`), { endAfterRound: value, version: version + 1 });
      return { endAfterRound: value };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const seen = await waitAfterDenied(session, code, key, version);
      if (seen === undefined || attempt >= SETTLE_ATTEMPTS) throw new StoreError('permission-denied', '沒有改成，請再按一次');
    }
  }
}

// 主持端勾天命（「判定」空白的那幾張）：uid 的 final/scores/{uid}/destiny/done 改成 done（true＝達成、false＝沒達成、null＝改回待判定），
// 總分與全桌的名次跟著改（game.js 的 judgeScores），只寫 done 與有變的 total、rank，帶 version＋1。回傳 { changed }。
// 第 1 場已鎖定（第 2 場開了）時報 match-locked：第 1 場的判定要在開第 2 場之前勾完。
export async function judgeDestiny(session, code, key, uid, done) {
  for (let attempt = 1; ; attempt += 1) {
    const room = await readRoom(session, code);
    if (isLocked(room, key)) throw lockedError();
    const game = room.games?.[key];
    const scores = game?.final?.scores;
    if (!scores?.[uid]) throw new StoreError('no-final', '這一桌還沒算分');
    if ((scores[uid].destiny?.done ?? null) === done) return { changed: false };
    const next = judgeScores(scores, uid, done);
    const version = game.version ?? 0;
    const path = `rooms/${code}/games/${key}/final/scores`;
    const writes = { [`rooms/${code}/games/${key}/version`]: version + 1, [`${path}/${uid}/destiny/done`]: done };
    for (const [other, score] of Object.entries(next)) {
      if (score.total !== scores[other].total) writes[`${path}/${other}/total`] = score.total;
      if (score.rank !== scores[other].rank) writes[`${path}/${other}/rank`] = score.rank;
    }
    try {
      await update(ref(session.db), writes);
      return { changed: true };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const seen = await waitAfterDenied(session, code, key, version);
      if (seen === undefined || attempt >= SETTLE_ATTEMPTS) throw new StoreError('permission-denied', '天命的判定沒有寫成，請再按一次');
    }
  }
}

// 主持端自動結算：盯著房間與入座玩家的請求，有還沒處理的請求就交給 settleRequest；有牌在等響應的桌，看到新的響應或
// 到了 responseSettleAt（伺服器時間，本機計時器叫醒）就整桌交給 settleWindow，那一桌的出牌與結束這一輪先等著。
// 黃昏（M6）：進黃昏還沒翻法案、看到已送出的人數變了、或到了截止＋緩衝（本機計時器叫醒），就整桌交給 settleDusk。
// 黑夜（M8）：進黑夜還沒開、看到已送出的人數變了、或到了截止＋緩衝，就整桌交給 settleNight（同黃昏）。
// 終局（階段 end）的桌什麼都不做：不開黑夜、不重試、不報錯（M9）。兩場制：每桌只處理目前這一局（activeKey），第 2 場開了之後第 1 場不再看。畫面不用按。多台主持端可以同時開著，同一筆請求只會套用一次。請求、票與黑夜的選擇都是逐人訂閱（requests/{code}/{uid}、
// votes/{code}/{uid}、nights/{code}/{uid}），settleWindow、settleDusk 與 settleNight 讀整房時才會真的問伺服器。
// onError(error) 在結算失敗時呼叫。回傳停止的函式。
export function startSettling(session, code, data, { random, onError = () => {} } = {}) {
  const clock = serverClock(session);
  let room = null;
  const requests = {};
  const votes = {};
  const nights = {};
  const listening = new Map(); // uid → 取消訂閱（請求）
  const listeningVotes = new Map(); // uid → 取消訂閱（票）
  const listeningNights = new Map(); // uid → 取消訂閱（黑夜的選擇）
  let running = false;
  let stopped = false;
  let timer = null;
  // 「桌:uid」「桌:window」「桌:dusk」或「桌:night」→ 這台沒寫入或失敗時的狀況：同樣的狀況不再自動重試，請求、票、選擇、局面或到期
  // 與否變了再看。
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
  // 這一桌的黑夜有沒有事要做：開黑夜、更新已送出人數（用逐人訂閱看到的選擇先算，settleNight 再從伺服器重讀）、揭曉。
  const nightWork = (table, game) => {
    const tableState = room.tables?.[table];
    if (!tableState) return null;
    const stage = nightStage(game.night, tableState.round);
    const version = game.version ?? 0;
    let mark = null;
    if (stage === 'none' && tableState.phase === 'night') {
      mark = `${version}@open`;
    } else if (stage === 'closing' && clock() >= nightSettleAt(game.night)) {
      // 揭曉沒成功時，每過 NIGHT_RETRY_MS 換一個標記，就會再試（arm 會在那時叫醒自己）。
      mark = `${version}@reveal@${Math.floor((clock() - nightSettleAt(game.night)) / NIGHT_RETRY_MS)}`;
    } else if ((stage === 'choosing' || stage === 'closing') && tableState.phase === 'night') {
      const view = { table, round: tableState.round, phase: tableState.phase, seats: game.seats, night: game.night };
      const count = submittedChoices(view, nights);
      const everyone = count === Object.keys(game.seats).length;
      if (count !== (game.night.submitted ?? 0) || (everyone && stage === 'choosing')) mark = `${version}@count@${count}`;
    }
    const key = `${table}:night`;
    return mark !== null && skipped.get(key) !== mark ? { table, key, mark, night: true } : null;
  };
  const waiting = () => {
    const work = [];
    for (let number = 1; number <= (room?.meta?.tableCount ?? 0); number += 1) {
      const table = activeKey(room, number); // 每桌只處理目前這一局（兩場制：第 2 場開了就是 "{n}-2"）
      const game = room.games?.[table];
      if (!game?.seats || room.tables?.[table]?.phase === END_PHASE) continue; // 終局的桌什麼都不做
      const dusk = duskWork(table, game);
      if (dusk) work.push(dusk);
      const night = nightWork(table, game);
      if (night) work.push(night);
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
  // 下一張還沒到期的待響應牌、下一個還沒到揭曉時間的黃昏或黑夜到期時叫醒自己（伺服器時間換算成本機的計時器）；
  // 已經過了揭曉時間、還沒揭曉的黑夜，在下一次再試的時間叫醒。都沒有就不設計時器。
  const arm = () => {
    clearTimeout(timer);
    timer = null;
    if (stopped) return;
    const now = clock();
    const due = [];
    for (let number = 1; number <= (room?.meta?.tableCount ?? 0); number += 1) {
      const table = activeKey(room, number);
      const game = room.games?.[table];
      if (room.tables?.[table]?.phase === END_PHASE) continue;
      if (game?.pending) due.push(responseSettleAt(game.pending));
      if (game?.seats && duskStage(game.dusk, room.tables?.[table]?.round) === 'closing') due.push(duskSettleAt(game.dusk));
      if (game?.seats && nightStage(game.night, room.tables?.[table]?.round) === 'closing') {
        const at = nightSettleAt(game.night);
        due.push(at > now ? at : at + (Math.floor((now - at) / NIGHT_RETRY_MS) + 1) * NIGHT_RETRY_MS);
      }
    }
    const later = due.filter((at) => Number.isFinite(at) && at > now);
    if (later.length) timer = setTimeout(pump, Math.min(...later) - now + 20);
  };
  const pump = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (let work = waiting(); work.length > 0 && !stopped; work = waiting()) {
        const { table, uid, key, mark, window, dusk, night } = work[0];
        try {
          let result;
          if (dusk) result = await settleDusk(session, code, table, data, random);
          else if (night) result = await settleNight(session, code, table, data, random);
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
  // 每個入座的人訂閱一次自己那一筆請求、一次自己的票、一次自己的黑夜選擇。
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
        subscribe(listeningNights, 'nights', nights, uid);
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
    for (const stop of [...listening.values(), ...listeningVotes.values(), ...listeningNights.values()]) stop();
  };
}

// 指定第 1 回合的起始座位（order＝座位 0–5）：只限第 1 回合、還沒有人出過牌或結束過一輪、第一張牌也不在等響應。
// 帶 version＋1；跟結算撞在一起時後到的被拒，再按一次就好。第 1 場已鎖定（第 2 場開了）時報 match-locked。
export async function setStartOrder(session, code, key, order) {
  const room = await readRoom(session, code);
  const game = room.games?.[key];
  if (!game) throw new StoreError('invalid-table', `${tableLabel(key)}還沒開局`);
  if (isLocked(room, key)) throw lockedError();
  if (room.tables?.[key]?.phase === END_PHASE) throw new StoreError('game-over', '這一桌已經算分了');
  if (room.tables?.[key]?.round !== 1 || game.turn || game.pending) {
    throw new StoreError('cannot-set-start', '已經有人出過牌，不能再指定起始玩家');
  }
  try {
    await update(ref(session.db, `rooms/${code}/games/${key}`), { startOrder: order, version: (game.version ?? 0) + 1 });
  } catch (error) {
    if (isPermissionDenied(error)) throw new StoreError('permission-denied', '起始玩家沒有改成，請再按一次');
    throw error;
  }
}

// ---- 主持人控制台：投影與全場指令（display）、全場日落鐘（clock）、投影端回報（screens）、批次動作 ----
// display/{scene,broadcast,sfx,music,pause} 與 clock/{場次} 只有主持端能寫：每一筆帶 seq（第一次 1，之後剛好＋1）與 by（自己的 uid），
// display 另帶 at（伺服器時間）。每個指令先讀房間（有 watchRoom 時是本機快取），接在讀到的那一筆後面寫；兩台主持端同時寫，後到的
// 被規則拒，回報 conflict。這些寫入一律單獨寫（全場暫停是 display 與 clock 一起寫），不跟遊戲的寫入放在同一筆：資料庫規則還沒發布時
// 只有這些指令失敗（rules-outdated），開局、推進、結算都不受影響。日落鐘的欄位一律由 game.js 的 clock*Write 算（規則用同樣的式子驗算）。

// 走著的日落鐘：主持端估的伺服器時間可能比實際慢一點，判斷「日落了沒」與「減到 0」時把現在當作再晚這麼多（毫秒），
// 寫進去的剩餘才不會在伺服器那邊變成負的被規則擋下（減到底時會剩約這麼多秒）。匯出給控制台照同一個餘裕先判斷（host-model.js）。
export const CLOCK_MARGIN_MS = 1500;

function conflictError(latest) {
  const error = new StoreError('conflict', '別台主持端剛改過，請看最新的狀態再操作');
  error.latest = latest ?? null;
  return error;
}

// 寫入被拒、伺服器上那一筆也沒變時的原因：不是主持端 → permission-denied；這間房從來沒有寫進過控制台的節點（舊規則下一定不存在）
// → rules-outdated；其他（例如剛好卡在時間的邊界）→ rejected。what 是「切換投影場景」這種動作名稱。
async function deniedReason(session, code, what) {
  const room = await readRoom(session, code);
  if (!isHostOf(room, session.uid)) return new StoreError('permission-denied', `只有主持端可以${what}`);
  if (!room.display && !room.clock && !room.screens) return new StoreError('rules-outdated', `${what}要等規則更新`);
  return new StoreError('rejected', `${what}沒有寫進去，請再按一次`);
}

// 這間房還沒有任何控制台的節點（舊規則下一定是這樣）時，寫入被拒後只等這麼久（毫秒）就判斷原因：別台主持端同時寫的第一筆，
// 伺服器會在回覆「被拒」之前先傳過來（同一條連線照順序），不用等滿 SETTLE_MS；「要等規則更新」也不會讓主持人等好幾秒。
const FIRST_WRITE_WAIT_MS = 500;

async function deniedWait(session, code) {
  const room = await readRoom(session, code).catch(() => null);
  return room && !room.display && !room.clock && !room.screens ? FIRST_WRITE_WAIT_MS : SETTLE_MS;
}

// 寫 path（rooms/{code} 底下）被拒之後：等伺服器的現況，那一筆的 seq 變了＝別台剛改過（conflict，帶最新的那一筆），沒變再看 deniedReason。
async function commandDenied(session, code, path, seq, what) {
  const seen = await waitFor(session, `rooms/${code}/${path}`, (value) => (value?.seq ?? 0) !== seq, await deniedWait(session, code));
  if (seen !== undefined) return conflictError(seen);
  return deniedReason(session, code, what);
}

// 這次指令要接在哪一筆後面：{ room, current（path 那一筆，沒有是 null）, seq（沒有是 0） }。expectSeq 給了而且對不上就丟 conflict、不寫。
async function commandBase(session, code, path, expectSeq) {
  const room = await readRoom(session, code);
  const current = path.split('/').reduce((node, part) => node?.[part] ?? null, room);
  const seq = current?.seq ?? 0;
  if (expectSeq !== undefined && expectSeq !== null && expectSeq !== seq) throw conflictError(current);
  return { room, current, seq };
}

// display/{part} 的一筆指令：fields 是內容，seq（＋1）、at（伺服器時間）、by 由這裡補。回傳寫入的 seq。
async function writeDisplay(session, code, part, fields, seq, what) {
  const next = seq + 1;
  try {
    await set(ref(session.db, `rooms/${code}/display/${part}`), { ...fields, seq: next, at: serverTimestamp(), by: session.uid });
    return next;
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    throw await commandDenied(session, code, `display/${part}`, seq, what);
  }
}

// 切投影場景：id 是 SCENE_IDS 之一，page 是 0–SCENE_PAGE_MAX 的整數（規則、頒獎換頁；沒給就不帶）。同一個場景再送一次也會寫
// （seq＋1，投影端可以用來重播開場影片）。expectSeq 見 commandBase。回傳 { seq }。
export async function setScene(session, code, id, { page, expectSeq } = {}) {
  if (!isValidScene(id, page)) throw new StoreError('invalid-command', `投影場景要是 ${SCENE_IDS.join('、')} 之一，頁數 0–${SCENE_PAGE_MAX}`);
  const { seq } = await commandBase(session, code, 'display/scene', expectSeq);
  const fields = page === undefined || page === null ? { id } : { id, page };
  return { seq: await writeDisplay(session, code, 'scene', fields, seq, '切換投影場景') };
}

// 全場廣播：前後空白修剪後 1–BROADCAST_MAX_LENGTH 字（UTF-16 長度，同暱稱），新的取代舊的。回傳 { seq, text }（修剪後的）。
export async function sendBroadcast(session, code, input) {
  const text = normalizeBroadcast(input);
  if (!isValidBroadcast(text)) throw new StoreError('invalid-command', `廣播請輸入 1–${BROADCAST_MAX_LENGTH} 個字`);
  const { seq } = await commandBase(session, code, 'display/broadcast');
  return { seq: await writeDisplay(session, code, 'broadcast', { text }, seq, '送出廣播'), text };
}

// 收回目前那一則廣播（同一則加 hidden: true）。沒有廣播或已經收回就不寫。回傳 { changed, seq }。
export async function hideBroadcast(session, code, { expectSeq } = {}) {
  const { current, seq } = await commandBase(session, code, 'display/broadcast', expectSeq);
  if (!current?.text || current.hidden === true) return { changed: false, seq };
  return { changed: true, seq: await writeDisplay(session, code, 'broadcast', { text: current.text, hidden: true }, seq, '收回廣播') };
}

// 投影端播一次音效：id 是 SFX_IDS 之一。離上一次不到 SFX_GAP_MS 丟 too-soon（規則也擋）。回傳 { seq }。
export async function playSfx(session, code, id) {
  if (!SFX_IDS.includes(id)) throw new StoreError('invalid-command', `音效要是 ${SFX_IDS.join('、')} 之一`);
  const { current, seq } = await commandBase(session, code, 'display/sfx');
  const soon = () => new StoreError('too-soon', '音效一秒只能放一次，請等一下再按');
  const last = typeof current?.at === 'number' ? current.at : null;
  const sentAt = serverTime(session);
  if (last !== null && sentAt < last + SFX_GAP_MS) throw soon();
  try {
    await set(ref(session.db, `rooms/${code}/display/sfx`), { id, seq: seq + 1, at: serverTimestamp(), by: session.uid });
    return { seq: seq + 1 };
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    // 送出時離上一次還在「1 秒＋估時誤差」之內：多半是伺服器那邊還不到 1 秒（這台估的時間快了一點），不用等現況就回 too-soon。
    if (last !== null && sentAt < last + SFX_GAP_MS + CLOCK_MARGIN_MS) throw soon();
    throw await commandDenied(session, code, 'display/sfx', seq, '播放音效');
  }
}

// 背景音樂播放（on: true）或停止（false）。已經是這個狀態就不寫。回傳 { changed, seq }。
export async function setMusic(session, code, on, { track = MUSIC_TRACKS[0], expectSeq } = {}) {
  if (typeof on !== 'boolean' || !MUSIC_TRACKS.includes(track)) throw new StoreError('invalid-command', `音樂要是 ${MUSIC_TRACKS.join('、')}，播放或停止`);
  const { current, seq } = await commandBase(session, code, 'display/music', expectSeq);
  if ((current?.on === true) === on && (!on || current.track === track)) return { changed: false, seq };
  return { changed: true, seq: await writeDisplay(session, code, 'music', { track, on }, seq, on ? '播放音樂' : '停止音樂') };
}

// 全場暫停（on: true）或恢復（false），一筆寫入 display/pause 與被它停住或恢復的全場日落鐘：暫停時同一筆停住正在走、離日落超過
// PAUSE_NEAR_SUNSET_MS 的鐘（照這台估的伺服器時間），記在 pause.clocks；恢復時只恢復 pause.clocks 記的、而且還是被這一次暫停停住的鐘
// （pausedAt 等於 pause.at：同一筆寫入的伺服器時間；原本就手動暫停的，或暫停中被手動繼續又暫停的，都不動）。已經是這個狀態就不寫。
// 被拒時：暫停那一筆被別台改了，已經是要的狀態就當作不用寫，不然丟 conflict；鐘被別台改了就重讀再試；伺服器上什麼都沒變時照
// deniedReason 丟錯，只有原因不明（rejected）的暫停先一個鐘都不帶再試一次，讓暫停那一筆一定寫得進去（安全優先；沒停住的鐘照 clocks
// 看得出來）。恢復不放寬：不帶鐘只寫 pause.on = false 的話，被暫停停住的鐘會一直停著，也不會再有人自動恢復它。
// 回傳 { changed, seq, clocks, nearSunset }：clocks 是這次一起停住或恢復的場次（例 ['1']）；nearSunset 是這次暫停時因為離日落只剩
// PAUSE_NEAR_SUNSET_MS 以內（含 10 秒整）而故意不停的場次（還沒日落、正在走的鐘）。兩個都只是這一次按下去的結果：恢復、沒有寫（changed: false）的時候都是 []，
// 別台主持端與重新整理後也沒有。全場暫停中每個鐘是哪一種，任何一台主持端都照房間資料分（host-model.js 的 clockPauseState）：停住了＝
// pause.clocks[m] === true 而且 clock.pausedAt === pause.at；快日落＝正在走、還沒日落、剩 PAUSE_NEAR_SUNSET_MS 以內（含 10 秒整；不給手動暫停）；
// 沒停住＝其他正在走的（可以手動暫停，恢復時不會自動繼續）。
// 離日落只剩這麼久（毫秒）以內（含剛好這麼久）的鐘，全場暫停不停它（照常日落）：停了也沒有意義，而且這台估的時間慢一點就會讓整筆被拒，要等好幾秒才能不帶鐘重送。
export const PAUSE_NEAR_SUNSET_MS = 10_000;

export async function setPause(session, code, on, { expectSeq } = {}) {
  if (typeof on !== 'boolean') throw new StoreError('invalid-command', '暫停要給 true 或 false');
  const what = on ? '全場暫停' : '恢復全場';
  let bare = false; // 暫停被拒、伺服器上也沒變之後：一個鐘都不帶
  for (let attempt = 1; ; attempt += 1) {
    const { room, current, seq } = await commandBase(session, code, 'display/pause', attempt === 1 ? expectSeq : undefined);
    if ((current?.on === true) === on) return { changed: false, seq, clocks: [], nearSunset: [] };
    const now = serverTime(session);
    const writes = {};
    const clocks = [];
    const nearSunset = [];
    for (const match of ['1', String(MATCH_COUNT)]) {
      const clock = room.clock?.[match];
      if (!isClock(clock)) continue;
      let next = null;
      if (on) {
        const near = clockPassed(clock, now + PAUSE_NEAR_SUNSET_MS);
        if (near && !clockPassed(clock, now)) nearSunset.push(match); // 已經日落的不算
        next = bare || near ? null : clockPauseWrite(clock, serverTimestamp());
      } else if (current?.clocks?.[match] === true && clock.pausedAt === current.at) next = clockResumeWrite(clock, serverTimestamp());
      if (!next) continue;
      writes[`rooms/${code}/clock/${match}`] = { ...next, by: session.uid };
      clocks.push(match);
    }
    const pause = { on, seq: seq + 1, at: serverTimestamp(), by: session.uid };
    if (on && clocks.length > 0) pause.clocks = Object.fromEntries(clocks.map((match) => [match, true]));
    writes[`rooms/${code}/display/pause`] = pause;
    try {
      await update(ref(session.db), writes);
      return { changed: true, seq: seq + 1, clocks, nearSunset };
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const pauseSeq = (value) => value?.display?.pause?.seq ?? 0;
      const moved = (value) => pauseSeq(value) !== seq || clocks.some((match) => (value?.clock?.[match]?.seq ?? 0) !== room.clock[match].seq);
      const seen = await waitFor(session, `rooms/${code}`, moved, await deniedWait(session, code));
      if (seen !== undefined && pauseSeq(seen) !== seq) {
        if ((seen.display.pause.on === true) === on) return { changed: false, seq: pauseSeq(seen), clocks: [], nearSunset: [] };
        throw conflictError(seen.display.pause);
      }
      if (seen === undefined) {
        const reason = await deniedReason(session, code, what);
        if (on && reason.code === 'rejected' && clocks.length > 0 && !bare) {
          bare = true;
          continue;
        }
        throw reason;
      }
      if (attempt >= SETTLE_ATTEMPTS + 2) throw new StoreError('rejected', `${what}沒有寫進去，請再按一次`);
    }
  }
}

// 全場日落鐘的場次：1 或 2（數字或字串）→ '1'、'2'；不對丟 invalid-command。
function clockMatch(match) {
  const number = Number(match);
  if (number !== 1 && number !== MATCH_COUNT) throw new StoreError('invalid-command', `全場日落鐘只有第 1、${MATCH_COUNT} 場`);
  return String(number);
}

const noClockError = (match) => new StoreError('no-clock', `第 ${match} 場的全場日落鐘還沒開始`);
const passedError = () => new StoreError('clock-passed', '已經日落了，不能再暫停或加減');

// 寫 clock/{match} 的整筆（record 已經帶好 seq、by），回傳寫入後的那一筆（伺服器時間已經換成真的值）。被拒：別台剛改過 → conflict；
// 照這台估的時間（多算一點餘裕）已經日落 → clock-passed；其他見 deniedReason。
async function writeClock(session, code, match, record, seq, current, what) {
  const path = `clock/${match}`;
  try {
    await set(ref(session.db, `rooms/${code}/${path}`), record);
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    const seen = await waitFor(session, `rooms/${code}/${path}`, (value) => (value?.seq ?? 0) !== seq);
    if (seen !== undefined) throw conflictError(seen);
    if (current && clockPassed(current, serverTime(session) + CLOCK_MARGIN_MS)) throw passedError();
    throw await deniedReason(session, code, what);
  }
  return (await get(ref(session.db, `rooms/${code}/${path}`))).val();
}

// 開第 match 場（1 或 2）的全場日落鐘，minutes 是 CLOCK_MINUTES_MIN–CLOCK_MINUTES_MAX 的整數（照 settings.sunsetMinutes）。
// 開了之後那一場所有桌的日落都照它。已經開了就不寫（兩台同時開只成一筆）；第 2 場還沒有任何一桌開局（沒有任何 games/{n}-2，同 startAll
// 的 anyStarted；只開了 tables/{n}-2 還不算）丟 invalid-command（先開走的話，第 2 場各桌開局時已經被吃掉一段）；全場暫停中丟 paused。
// 回傳 { started, clock }：clock 是寫入後或原本的那一筆。
export async function startClock(session, code, match, minutes) {
  const key = clockMatch(match);
  if (!Number.isInteger(minutes) || minutes < CLOCK_MINUTES_MIN || minutes > CLOCK_MINUTES_MAX) {
    throw new StoreError('invalid-command', `全場日落鐘要是 ${CLOCK_MINUTES_MIN}–${CLOCK_MINUTES_MAX} 分的整數`);
  }
  const { room, current } = await commandBase(session, code, `clock/${key}`);
  if (current) return { started: false, clock: current };
  if (key === String(MATCH_COUNT) && !Object.keys(room.games ?? {}).some((game) => parseKey(game)?.match === MATCH_COUNT)) {
    throw new StoreError('invalid-command', `第 ${MATCH_COUNT} 場還沒有桌開局，有一桌開局之後才能開第 ${MATCH_COUNT} 場的全場日落鐘`);
  }
  // 全場暫停中開的鐘會一路走、也不在 pause.clocks 裡（恢復時不會被照顧到）：恢復之後再開。
  if (room.display?.pause?.on === true) throw new StoreError('paused', '全場暫停中，恢復之後再開全場日落鐘');
  const path = `rooms/${code}/clock/${key}`;
  try {
    await set(ref(session.db, path), { ...clockStartWrite(minutes, serverTimestamp()), by: session.uid });
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    const seen = await waitFor(session, path, (value) => value !== null, await deniedWait(session, code));
    if (seen !== undefined) return { started: false, clock: seen };
    throw await deniedReason(session, code, '開始全場日落鐘');
  }
  return { started: true, clock: (await get(ref(session.db, path))).val() };
}

// 暫停第 match 場的全場日落鐘：已經暫停就不寫；已經日落丟 clock-passed。回傳 { changed, clock }。
export async function pauseClock(session, code, match, { expectSeq } = {}) {
  const key = clockMatch(match);
  const { current, seq } = await commandBase(session, code, `clock/${key}`, expectSeq);
  if (!isClock(current)) throw noClockError(key);
  if (clockPaused(current)) return { changed: false, clock: current };
  if (clockPassed(current, serverTime(session) + CLOCK_MARGIN_MS)) throw passedError();
  const record = { ...clockPauseWrite(current, serverTimestamp()), by: session.uid };
  return { changed: true, clock: await writeClock(session, code, key, record, seq, current, '暫停日落鐘') };
}

// 繼續：沒暫停就不寫。回傳 { changed, clock }。
export async function resumeClock(session, code, match, { expectSeq } = {}) {
  const key = clockMatch(match);
  const { current, seq } = await commandBase(session, code, `clock/${key}`, expectSeq);
  if (!isClock(current)) throw noClockError(key);
  if (!clockPaused(current)) return { changed: false, clock: current };
  const record = { ...clockResumeWrite(current, serverTimestamp()), by: session.uid };
  return { changed: true, clock: await writeClock(session, code, key, record, seq, null, '繼續日落鐘') };
}

// 加減 deltaMs 毫秒（例 5 * 60000、-60000），夾在單次 ±10 分、累計 ±30 分、剩餘不小於 0（game.js 的 clockAdjustWrite；走著的鐘
// 照「現在＋CLOCK_MARGIN_MS」算，減到底時會剩約 1.5 秒）。已經日落丟 clock-passed；完全調不動丟 clock-limit。
// 回傳 { delta, clock }：delta 是實際調了多少毫秒（「復原」＝再調 -delta）。
export async function adjustClock(session, code, match, deltaMs, { expectSeq } = {}) {
  const key = clockMatch(match);
  if (!Number.isFinite(deltaMs) || Math.round(deltaMs) === 0) throw new StoreError('invalid-command', '加減要給不是 0 的毫秒數');
  const { current, seq } = await commandBase(session, code, `clock/${key}`, expectSeq);
  if (!isClock(current)) throw noClockError(key);
  const now = serverTime(session) + (clockPaused(current) ? 0 : CLOCK_MARGIN_MS);
  if (clockPassed(current, now)) throw passedError();
  const next = clockAdjustWrite(current, deltaMs, now);
  if (!next) {
    const adjust = current.adjust ?? 0;
    const capped = deltaMs > 0 ? adjust >= CLOCK_ADJUST_MAX_MS : adjust <= -CLOCK_ADJUST_MAX_MS;
    throw new StoreError('clock-limit', capped ? `累計加減已經到 ${CLOCK_ADJUST_MAX_MS / 60000} 分的上限` : '剩下的時間不到 1 毫秒，不能再減');
  }
  const clock = await writeClock(session, code, key, { ...next, by: session.uid }, seq, current, '調整日落鐘');
  return { delta: next.adjust - (current.adjust ?? 0), clock };
}

// 主持端「在等誰」：逐人訂閱入座的人（各局 games/{局號}/seats 的人）的票、黑夜的選擇與挑的棄牌（votes/{code}/{uid}、
// nights/{code}/{uid}、discards/{code}/{uid}；不在整房掛訂閱，自動結算從伺服器重讀整房的保證不變）。有變就呼叫
// onChange({ votes, nights, discards })（都是 { uid: 最新一筆 }），交給 game.js 的 waitingFor、missingDiscards、advancePlan。回傳停止的函式。
export function watchSubmissions(session, code, onChange, onError = () => {}) {
  const records = { votes: {}, nights: {}, discards: {} };
  const listening = new Map(); // 「votes:uid」→ 取消訂閱
  let stopped = false;
  const emit = () => {
    if (!stopped) onChange({ votes: { ...records.votes }, nights: { ...records.nights }, discards: { ...records.discards } });
  };
  const subscribe = (path, uid) => {
    const id = `${path}:${uid}`;
    if (listening.has(id) || stopped) return;
    const stop = onValue(
      ref(session.db, `${path}/${code}/${uid}`),
      (snapshot) => {
        records[path][uid] = snapshot.val();
        emit();
      },
      onError,
    );
    listening.set(id, stop);
  };
  const stopRoom = onValue(
    ref(session.db, `rooms/${code}`),
    (snapshot) => {
      for (const game of Object.values(snapshot.val()?.games ?? {})) {
        for (const uid of Object.keys(game?.seats ?? {})) for (const path of ['votes', 'nights', 'discards']) subscribe(path, uid);
      }
    },
    onError,
  );
  return () => {
    stopped = true;
    stopRoom();
    for (const stop of listening.values()) stop();
    listening.clear();
  };
}

// 投影端狀態回報（可做）：寫 rooms/{code}/screens/{uid}＝{ audio, scene, at }（audio＝聲音已開，scene＝已經照著畫的 display/scene 的 seq，
// at 是伺服器時間）。做法同 trackPresence：每次連上（包括斷線後重連）都先請伺服器在斷線時代為刪除，再寫入；同一個身分較早的連線
// （換網路後殘留的）晚一步斷開、伺服器把這一筆刪掉時補回去。投影端只寫這一筆。
// 回傳 { update(fields), stop() }：update 改內容並寫入（回傳 Promise<寫進去了沒>；規則還沒更新時是 false），stop 停止並刪掉自己那一筆。
export function trackScreen(session, code, initial = {}) {
  const mine = ref(session.db, `rooms/${code}/screens/${session.uid}`);
  let fields = { audio: false, ...initial };
  let tracking = true;
  let armed = false; // 這一條連線已經向伺服器登記「斷線時代為刪除」
  let present = false; // 這台看到的自己那一筆在不在
  let writing = false;
  let refused = false; // 寫入被拒（房間不見了或規則還沒更新）就不再自動補，等下次連上或 update
  const record = () => {
    const next = { audio: fields.audio === true, at: serverTimestamp() };
    if (Number.isInteger(fields.scene) && fields.scene >= 0) next.scene = fields.scene;
    return next;
  };
  const write = async () => {
    if (!tracking) return false;
    try {
      await set(mine, record());
      refused = false;
      return true;
    } catch {
      refused = true;
      return false;
    }
  };
  // 該在而不在就補寫。
  const sync = async () => {
    if (!tracking || !armed || present || writing || refused) return;
    writing = true;
    await write();
    writing = false;
    sync();
  };
  const stopConnection = watchConnection(session, (connected) => {
    armed = false;
    if (!connected || !tracking) return;
    refused = false;
    onDisconnect(mine)
      .remove()
      .then(() => {
        armed = true;
        return write(); // 連上就寫一次（at 換成這次連上的時間）
      })
      .catch(() => {}); // 房間不見了（或規則還沒更新）才會被拒
  });
  const stopMine = onValue(
    mine,
    (snapshot) => {
      present = snapshot.exists();
      sync();
    },
    () => {},
  );
  return {
    update(next = {}) {
      fields = { ...fields, ...next };
      return write();
    },
    async stop() {
      tracking = false;
      stopConnection();
      stopMine();
      await Promise.all([onDisconnect(mine).cancel(), remove(mine)]).catch(() => {});
    },
  };
}

// 批次動作的進度回呼（畫面給的）：不會被等待（不 await 它回傳的 Promise）；丟錯、或 async 回呼回傳被拒的 Promise，都不影響批次，
// 剩下的桌照做、做完的桌照樣回傳。
function reportProgress(onProgress, step) {
  try {
    const back = onProgress(step);
    if (typeof back?.catch === 'function') back.catch(() => {}); // 被拒的 Promise 也接住，不留給沒有人處理
  } catch {
    // 畫面自己的錯，這裡不處理
  }
}

// 「全部開始」「全部開始第 2 場」：照 game.js 的 startPlan／startMatch2Plan 逐桌呼叫 startTable（等同單桌「開始」，每桌各自洗牌；
// 第 2 場帶各桌的 include），一桌失敗不影響別桌；中途斷掉時已開的保留，再照新的計畫做一次只會開剩下的。clock 是 true、計畫說那一場的
// 全場鐘還沒開、而且至少有一桌已經開局時，最後開全場日落鐘（startClock）。全場暫停中的桌不開（回 paused）。
// onProgress({ done, total, key, result }) 每做完一桌呼叫一次（見 reportProgress）。回傳 { results: [{ key, table, started, error }], clock: { started, error } | null }。
export async function startAll(session, code, plan, data, { random, clock = false, onProgress = () => {} } = {}) {
  const results = [];
  for (const item of plan.start) {
    let result = { key: item.key, table: item.table, started: false, error: null };
    try {
      const room = await readRoom(session, code);
      if (room.display?.pause?.on === true) throw new StoreError('paused', '全場暫停中，沒有開局');
      const { started } = await startTable(session, code, item.key, data, random, plan.match === 1 ? {} : { include: item.include });
      result = { ...result, started };
    } catch (error) {
      result = { ...result, error };
    }
    results.push(result);
    reportProgress(onProgress, { done: results.length, total: plan.start.length, key: item.key, result });
  }
  let clockResult = null;
  const anyStarted = plan.started.length > 0 || results.some((result) => result.started);
  if (clock && plan.clock?.needed && anyStarted) {
    try {
      clockResult = { started: (await startClock(session, code, plan.clock.match, plan.clock.minutes)).started, error: null };
    } catch (error) {
      clockResult = { started: false, error };
    }
  }
  return { results, clock: clockResult };
}

// 「能推的全推」：照 game.js 的 advancePlan 逐桌用計畫裡的回合與階段呼叫 advanceOrEnd（等同單桌「下一階段」；只有計畫的 includeEnding 是
// true、而且那一桌在計畫裡就是要算分的，才替它算分），推進到新回合日出的接著發牌（processSunrise）。每一桌之前重讀房間，全場暫停了就停下、剩下的桌回 paused。
// 別台先推了（局面跟計畫不一樣）時那一桌不動：advanced 是 false、沒有錯。onProgress 同 startAll。
// 回傳 { results: [{ key, table, advanced, ended, held, dealt, reason, error }] }：held＝這一回合要算分、這次沒推；dealt＝接著發了牌。
export async function advanceAll(session, code, plan, data, { random, onProgress = () => {} } = {}) {
  const results = [];
  let paused = false;
  for (const item of plan.advance) {
    let result = { key: item.key, table: item.table, advanced: false, ended: false, held: false, dealt: false, reason: null, error: null };
    try {
      if (!paused) paused = (await readRoom(session, code)).display?.pause?.on === true;
      if (paused) throw new StoreError('paused', '全場暫停中，沒有推');
      // 只有確認框上寫著「算分」的桌可以算分：計畫之後才到點（例如全場鐘剛好日落）的桌不替它算，回 held。
      const allowEnd = plan.includeEnding === true && item.ending !== null && item.ending !== undefined;
      const moved = await advanceOrEnd(session, code, item.key, { round: item.round, phase: item.phase }, data, { allowEnd });
      result = { ...result, advanced: moved.advanced, ended: moved.ended, held: moved.held === true, reason: moved.reason };
      if (moved.advanced && !moved.ended && moved.table?.phase === 'sunrise') result.dealt = (await processSunrise(session, code, item.key, data, random)).dealt;
    } catch (error) {
      result = { ...result, error };
    }
    results.push(result);
    reportProgress(onProgress, { done: results.length, total: plan.advance.length, key: item.key, result });
  }
  return { results };
}
