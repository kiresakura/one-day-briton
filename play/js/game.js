// 純函式：開局與日出的計算（牌庫、洗牌、座位與階層、隱藏天命、抽牌、領薪）。不碰網路、不碰畫面，
// 瀏覽器與 Node 測試共用同一份。輸入資料檔的內容與目前的局面，輸出要寫入的新局面。
// 亂數一律從注入的來源拿（預設是 crypto.getRandomValues），測試用固定種子。
//
// 一桌的局面：
//   seats      { uid: { order, role, pounds, influence, handCount } }  公開（同桌都看得到）
//   hands      { uid: [牌編號…] }、destinies { uid: 天命編號或 null }   本人與主持端
//   deck       [牌編號…]（陣列順序＝抽牌順序）、discard [牌編號…]      只有主持端
import { ROLE_COUNT } from './data.js';

// 一桌最多幾人：六個階層各一、不重複。少於 SUGGESTED_SEATS 人可以開，但畫面要提醒（企劃 10/15 回覆第 12 題）。
export const MAX_SEATS = ROLE_COUNT;
export const SUGGESTED_SEATS = 3;

// 第 1 回合日出也領薪抽牌：工程暫定，待企劃確認（MILESTONES「要問企劃的問題」第 5 題）。企劃說不算就改成 false。
export const FIRST_SUNRISE_PAYS = true;

// 預設的亂數來源：每次回傳一個 0 到 2^32−1 的均勻整數。
export function cryptoRandom() {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
}

// 0 到 n−1 的均勻整數。丟掉尾段的值，避免取餘數造成機率不均。
export function randomBelow(n, random = cryptoRandom) {
  if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new RangeError(`invalid range: ${n}`);
  const limit = 2 ** 32 - (2 ** 32 % n);
  for (;;) {
    const value = random();
    if (value < limit) return value % n;
  }
}

// Fisher–Yates 洗牌，回傳新的陣列，不改原本的。
export function shuffle(list, random = cryptoRandom) {
  const result = [...list];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = randomBelow(index + 1, random);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

// 牌庫：所有行動牌（一般牌與響應卡）依張數展開，照資料檔的順序，還沒洗。
export function buildDeck(actions) {
  return actions.flatMap((action) => Array(action.copies).fill(action.id));
}

// 開局前檢查人數。error 不是 null 就不能開；warning 是可以開但要提醒的事。
export function checkSeating(count, roleCount = MAX_SEATS) {
  const capacity = Math.min(MAX_SEATS, roleCount);
  if (count === 0) return { error: '這一桌還沒有玩家', warning: null };
  if (count > capacity) return { error: `一桌最多 ${capacity} 人，現在有 ${count} 人，請多的人改到別桌`, warning: null };
  if (count < SUGGESTED_SEATS) return { error: null, warning: `只有 ${count} 人，建議至少 ${SUGGESTED_SEATS} 人` };
  return { error: null, warning: null };
}

// 入座：座位順序隨機（之後用來決定順時針），階層從 roles 隨機分、不重複。回傳照座位排好的 [{ uid, order, role }]。
export function assignSeats(uids, roles, random = cryptoRandom) {
  const players = [...new Set(uids)].sort(); // 先排好，結果只取決於有哪些人與亂數
  const { error } = checkSeating(players.length, roles.length);
  if (error) throw new RangeError(error);
  const roleIds = shuffle(
    roles.map((role) => role.id),
    random,
  );
  return shuffle(players, random).map((uid, order) => ({ uid, order, role: roleIds[order] }));
}

// 隱藏天命：從自己階層的天命隨機挑；沒有就從不屬於任何階層的挑；再沒有就是 null。used 裡的（同桌已發出的）不再發。
export function pickDestiny(destinies, role, used = new Set(), random = cryptoRandom) {
  const free = destinies.filter((destiny) => !used.has(destiny.id));
  const own = free.filter((destiny) => destiny.role === role);
  const pool = own.length ? own : free.filter((destiny) => destiny.role === null);
  return pool.length ? pool[randomBelow(pool.length, random)].id : null;
}

// 從牌庫頂（陣列開頭）抽 count 張。牌庫不夠時先抽完剩下的，再把棄牌堆洗回成新牌庫接著抽；兩邊都空就不抽了。
// 回傳 { deck, discard, drawn }，不改傳進來的陣列。
export function draw({ deck, discard }, count, random = cryptoRandom) {
  let pile = [...deck];
  let used = [...discard];
  const drawn = [];
  while (drawn.length < count) {
    if (pile.length === 0) {
      if (used.length === 0) break;
      pile = shuffle(used, random);
      used = [];
    }
    drawn.push(pile.shift());
  }
  return { deck: pile, discard: used, drawn };
}

// 照座位順序排好的 [uid, seat]。
export function seatsInOrder(seats) {
  return Object.entries(seats ?? {}).sort(([, a], [, b]) => a.order - b.order);
}

// 日出：照座位順序，每人領自己階層的薪水、抽 drawPerSunrise 張。手牌上限這裡不管（黑夜結束時才棄）。
export function sunrise(state, data, random = cryptoRandom) {
  const salaries = new Map(data.roles.map((role) => [role.id, role.salary]));
  let { deck, discard } = state;
  const seats = {};
  const hands = {};
  for (const [uid, seat] of seatsInOrder(state.seats)) {
    if (!salaries.has(seat.role)) throw new RangeError(`找不到階層 ${seat.role}`);
    const result = draw({ deck, discard }, data.settings.drawPerSunrise, random);
    ({ deck, discard } = result);
    hands[uid] = [...(state.hands[uid] ?? []), ...result.drawn];
    seats[uid] = { ...seat, pounds: seat.pounds + salaries.get(seat.role), handCount: hands[uid].length };
  }
  return { ...state, seats, hands, deck, discard };
}

// 開局：入座、分階層、發天命、洗牌庫、發起始手牌與資源；firstSunrise 為 true 時接著做第 1 回合日出。
export function startGame(data, uids, { random = cryptoRandom, firstSunrise = FIRST_SUNRISE_PAYS } = {}) {
  const { settings } = data;
  let deck = shuffle(buildDeck(data.actions), random);
  let discard = [];
  const used = new Set();
  const state = { seats: {}, hands: {}, destinies: {}, deck, discard };
  for (const { uid, order, role } of assignSeats(uids, data.roles, random)) {
    const destiny = pickDestiny(data.destinies, role, used, random);
    if (destiny) used.add(destiny);
    const result = draw({ deck, discard }, settings.startingHand, random);
    ({ deck, discard } = result);
    state.destinies[uid] = destiny;
    state.hands[uid] = result.drawn;
    state.seats[uid] = {
      order,
      role,
      pounds: settings.startingPounds,
      influence: settings.startingInfluence,
      handCount: result.drawn.length,
    };
  }
  Object.assign(state, { deck, discard });
  return firstSunrise ? sunrise(state, data, random) : state;
}
