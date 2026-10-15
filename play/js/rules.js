// 純函式：不碰網路、不碰畫面，瀏覽器與 Node 測試共用同一份。

export const PHASES = ['sunrise', 'day', 'dusk', 'night'];
export const PHASE_LABELS = { sunrise: '日出', day: '白晝', dusk: '黃昏', night: '黑夜' };

export const FOG_MIN = 0;
export const FOG_MAX = 100;
export const FOG_THRESHOLDS = [30, 60, 90];

export const MAX_TABLES = 6;
export const NAME_MAX_LENGTH = 12;

// 大寫英數去掉容易看錯的 0 O 1 I L，剩 31 個字元。
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const CONFIRM_CODE_LENGTH = 4;

export function isPhase(phase) {
  return PHASES.includes(phase);
}

export function initialTable() {
  return { round: 1, phase: PHASES[0], fog: FOG_MIN };
}

// 日出 → 白晝 → 黃昏 → 黑夜 → 下一回合的日出。
export function nextStep({ round, phase }) {
  const index = PHASES.indexOf(phase);
  if (index === -1) throw new RangeError(`unknown phase: ${phase}`);
  if (!Number.isInteger(round) || round < 1) throw new RangeError(`invalid round: ${round}`);
  const last = index === PHASES.length - 1;
  return { round: last ? round + 1 : round, phase: PHASES[last ? 0 : index + 1] };
}

export function clampFog(value) {
  if (!Number.isFinite(value)) return FOG_MIN;
  return Math.min(FOG_MAX, Math.max(FOG_MIN, value));
}

// 回傳新的迷霧值，以及這次由下往上「超過」的門檻（剛好等於門檻不算超過）。
export function applyFog(current, delta) {
  const before = clampFog(current);
  const fog = clampFog(before + delta);
  const crossed = FOG_THRESHOLDS.filter((threshold) => before <= threshold && fog > threshold);
  return { fog, crossed };
}

// 一場裡的迷霧變動（企劃 10/15 回覆）：state＝{ fog, fogMax, fired }，fired 是本場已觸發過的門檻；
// 缺的欄位當 0、0、[]。每個門檻每場只在第一次超過時觸發，降回再升上來不再觸發；fogMax 記本場最高值。
// 要這次變動由門檻以下（含剛好等於）升到門檻以上才算超過，缺 fired 的舊狀態不會因為本來就在門檻之上而觸發。
// crossed 是這次新觸發的門檻，由小到大，依序處理。
export function advanceFog(state, delta, thresholds = FOG_THRESHOLDS) {
  const before = clampFog(state?.fog ?? FOG_MIN);
  const fog = clampFog(before + delta);
  const fogMax = Math.max(clampFog(state?.fogMax ?? FOG_MIN), before, fog);
  const fired = Array.isArray(state?.fired) ? state.fired : [];
  const crossed = [...thresholds]
    .sort((a, b) => a - b)
    .filter((threshold) => !fired.includes(threshold) && before <= threshold && fog > threshold);
  return { fog, fogMax, fired: [...fired, ...crossed], crossed };
}

function randomBytes(count) {
  return globalThis.crypto.getRandomValues(new Uint8Array(count));
}

export function generateRoomCode(bytes = randomBytes) {
  const size = ROOM_CODE_ALPHABET.length;
  const limit = 256 - (256 % size); // 丟掉尾段的位元組，避免取餘數造成字元機率不均
  let code = '';
  while (code.length < ROOM_CODE_LENGTH) {
    for (const byte of bytes(ROOM_CODE_LENGTH)) {
      if (byte < limit && code.length < ROOM_CODE_LENGTH) code += ROOM_CODE_ALPHABET[byte % size];
    }
  }
  return code;
}

export function normalizeRoomCode(input) {
  return String(input ?? '').replace(/\s+/g, '').toUpperCase();
}

export function isRoomCode(code) {
  return (
    typeof code === 'string' &&
    code.length === ROOM_CODE_LENGTH &&
    [...code].every((char) => ROOM_CODE_ALPHABET.includes(char))
  );
}

export function normalizeName(input) {
  return String(input ?? '').trim();
}

// 長度與資料庫規則用同一種算法（UTF-16 長度）：中英文一字算 1，表情符號多半算 2。
export function isValidName(name) {
  return typeof name === 'string' && name === name.trim() && name.length >= 1 && name.length <= NAME_MAX_LENGTH;
}

export function isValidTable(table, tableCount = MAX_TABLES) {
  return Number.isInteger(table) && table >= 1 && table <= tableCount;
}

// 房間的主持端：開房的人，加上被核准進主持名單的人。
export function hostUids(room) {
  const uids = new Set();
  if (room?.meta?.hostUid) uids.add(room.meta.hostUid);
  for (const [uid, approved] of Object.entries(room?.hosts ?? {})) {
    if (approved === true) uids.add(uid);
  }
  return [...uids];
}

export function isHostOf(room, uid) {
  return hostUids(room).includes(uid);
}

// 由申請者的 uid 算出的確認碼：申請端與主持端各自算、顯示同一組，主持端核對後才核准。
// 只用來防認錯人，不是密碼（FNV-1a 雜湊後取 4 個字元，字元集與房號相同）。
export function confirmCode(uid) {
  const text = String(uid ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  const size = ROOM_CODE_ALPHABET.length;
  let code = '';
  for (let index = 0; index < CONFIRM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_ALPHABET[hash % size];
    hash = Math.floor(hash / size);
  }
  return code;
}
