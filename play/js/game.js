// 純函式：開局與日出的計算（牌庫、洗牌、座位與階層、隱藏天命、抽牌、領薪），白晝的輪流出牌、響應卡與結算，黃昏的法案投票，
// 事件（日出一般事件、迷霧事件），黑夜（豪賭、分贓、睡覺）與手牌上限，以及終局（日落鐘）與計分。
// 不碰網路、不碰畫面，瀏覽器與 Node 測試共用同一份。輸入資料檔的內容與目前的局面，輸出要寫入的新局面。
// 亂數一律從注入的來源拿（預設是 crypto.getRandomValues），測試用固定種子。
//
// 一桌的局面：
//   seats      { uid: { order, role, pounds, influence, handCount, sin, aligned } }  公開（同桌都看得到）；sin、aligned 沒有＝0
//   hands      { uid: [牌編號…] }、destinies { uid: 天命編號或 null }   本人與主持端
//   deck       [牌編號…]（陣列順序＝抽牌順序）、discard [牌編號…]      只有主持端
import { ROLE_COUNT, SETTINGS } from './data.js';
import { advanceFog } from './rules.js';

// 一桌最多幾人：六個階層各一、不重複。少於 SUGGESTED_SEATS 人可以開，但畫面要提醒（企劃 10/15 回覆第 12 題）。
export const MAX_SEATS = ROLE_COUNT;
export const SUGGESTED_SEATS = 3;

// 第 1 回合日出也領薪抽牌：企劃 10/15 確認（MILESTONES「要問企劃的問題」第 5 題）。
export const FIRST_SUNRISE_PAYS = true;

// 預設的亂數來源：每次回傳一個 0 到 2^32−1 的均勻整數。
export function cryptoRandom() {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
}

// 固定種子的亂數來源（mulberry32）：同一個種子每次給同一串數。給測試與模擬器的 ?seed= 用。
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
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
// seatedRoles（這一桌有人坐的階層）有給時，「判定」提到這桌沒人坐的階層的（目前只有「多於 rN」）先不發，從其他張挑；
// 這樣過濾後沒得挑，就照原本的挑法（企劃 10/15）。沒有判定的資料不會被過濾，挑的結果與亂數用量都跟沒給 seatedRoles 一樣。
export function pickDestiny(destinies, role, used = new Set(), random = cryptoRandom, seatedRoles = null) {
  const free = destinies.filter((destiny) => !used.has(destiny.id));
  const own = free.filter((destiny) => destiny.role === role);
  const pool = own.length ? own : free.filter((destiny) => destiny.role === null);
  const fits = seatedRoles ? pool.filter((destiny) => checkRoles(destiny.check).every((id) => seatedRoles.has(id))) : pool;
  const choices = fits.length ? fits : pool;
  return choices.length ? choices[randomBelow(choices.length, random)].id : null;
}

// 判定裡提到的階層（目前只有「多於 rN」）。
export function checkRoles(check) {
  return check?.kind === 'moreThan' ? [check.role] : [];
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

// 日出：照座位順序，每人領自己階層的薪水、抽 drawPerSunrise 張。手牌上限這裡不管（黑夜結束時才棄，在這之前由 applyHandLimits 做）。
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
// 座位先排好，再照座位發天命（避開判定提到這桌沒人坐的階層的天命，見 pickDestiny）。
export function startGame(data, uids, { random = cryptoRandom, firstSunrise = FIRST_SUNRISE_PAYS } = {}) {
  const { settings } = data;
  let deck = shuffle(buildDeck(data.actions), random);
  let discard = [];
  const used = new Set();
  const state = { seats: {}, hands: {}, destinies: {}, deck, discard };
  const seating = assignSeats(uids, data.roles, random);
  const seatedRoles = new Set(seating.map(({ role }) => role));
  for (const { uid, order, role } of seating) {
    const destiny = pickDestiny(data.destinies, role, used, random, seatedRoles);
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

// ---- 白晝：輪流出牌、成本與效果、齒輪連鎖（M5a） ----
// 主持端把一桌讀成 state 交給這裡算，再整筆寫回。state 除了上面的 seats、hands、deck、discard，還有：
//   round、phase、fog   該桌目前的回合、階段、迷霧值（rooms/{code}/tables/{n}）
//   startOrder          第 1 回合的起始座位，沒設是 0
//   turn                { round, index, plays, gear, level }：輪到出牌順序裡的第幾位、他這一輪出了幾張、
//                       上一張的齒輪與級數；round 不是目前的回合＝這一回合的白晝還沒開始
//   fogMax、fogFired、fogPending   本場迷霧最高值、已觸發的門檻、新越過還沒處理的門檻（同一筆結算的最後由 settleFog 處理）
//   lastSeq             { uid: 已處理過的請求序號 }
//   pending             等著響應的那張一般牌（見下方「響應卡」），沒有是 null
// 一張一般牌分兩步：acceptPlay（檢查、付成本、牌離開手牌、算級數）與 resolvePlay（套效果、牌進棄牌堆、記罪孽與紀錄、
// 更新輪次）。兩步之間是響應窗口（M5b），兩步之間的 state 與 pending 都是純資料，可以單獨存。

// 罪孽：出了這兩類的牌，出牌者記 1 點（企劃 10/15 回覆第 9 題，M9 計分用）。
export const SIN_CATEGORIES = ['犯罪', '破壞'];
// 齒輪連鎖 3 級：出牌者另外抽幾張、被他指定的人隨機棄幾張（企劃 10/15 回覆第 10 題）。
export const CHAIN_DRAW = 2;
export const CHAIN_DISCARD = 1;

// 請求被退回的原因：鍵寫進 private/{code}/{uid}/notice，畫面顯示後面的說明。
export const REJECT_REASONS = {
  'not-day': '現在不是白晝',
  'not-seated': '你不在這一桌的座位上',
  'day-over': '這一回合的白晝大家都出完了',
  'not-your-turn': '還沒輪到你',
  'no-plays-left': '這一輪已經出滿了',
  'not-in-hand': '這張牌不在你手上',
  'unknown-card': '卡牌資料裡沒有這張牌',
  'response-card': '響應卡要在別人出牌時打出',
  'todo-card': '這張牌的效果還沒做好，先不能出',
  'cannot-afford': '英鎊或影響力不夠付這張牌的成本',
  'need-target': '這張牌要指定同桌的一個人',
  'bad-target': '只能指定同桌的另一位玩家',
  'need-chain-target': '3 級連鎖要指定同桌的一個人棄牌',
  'bad-chain-target': '連鎖棄牌只能指定同桌的另一位玩家',
  'bad-request': '看不懂這次的請求',
  // 響應卡（M5b）
  'no-pending': '現在沒有等著響應的牌',
  'wrong-pending': '要響應的那張牌已經結算了',
  'too-late': '響應的時間已經過了',
  'own-card': '不能響應自己出的牌',
  'not-response-card': '只有響應卡可以響應別人出的牌',
  'wrong-category': '這張響應卡不能回應這一類的牌',
  'response-needs-target': '要指定對象的響應卡這一版還不能打',
  beaten: '別人先響應了這張牌',
};

const TURN_START = { index: 0, plays: 0, gear: null, level: 0 };

// 這一回合白晝的出牌順序（uid）：座位順時針，從起始座位開始。第 1 回合從 startOrder 開始，之後每回合換下一位。
export function turnOrder(seats, startOrder, round) {
  const ordered = seatsInOrder(seats);
  if (ordered.length === 0) return [];
  const first = Math.max(0, ordered.findIndex(([, seat]) => seat.order === (startOrder ?? 0)));
  const offset = (first + round - 1) % ordered.length;
  return [...ordered.slice(offset), ...ordered.slice(0, offset)].map(([uid]) => uid);
}

// 這一回合的輪次；turn 是別的回合留下的（或還沒有）就從第一位、0 張開始。
export function currentTurn(turn, round) {
  if (!turn || turn.round !== round) return { round, ...TURN_START };
  return { round, index: turn.index ?? 0, plays: turn.plays ?? 0, gear: turn.gear ?? null, level: turn.level ?? 0 };
}

// 白晝進度：出牌順序、目前輪次、輪到誰（都輪完了是 null）、還有幾人沒出完（含正在出的人）、是不是都輪完了。
export function dayStatus({ seats, startOrder, turn }, round) {
  const order = turnOrder(seats, startOrder, round);
  const now = currentTurn(turn, round);
  const done = now.index >= order.length;
  return { order, turn: now, current: done ? null : order[now.index], remaining: Math.max(0, order.length - now.index), done };
}

// 齒輪級數：同一人同一輪內接著上一張打出、齒輪相同，就是上一張的級數＋1；沒有齒輪或不同就從 1 級算。
export function chainLevel(turn, action) {
  const gear = action.gear ?? null;
  return gear !== null && turn.plays > 0 && turn.gear === gear ? turn.level + 1 : 1;
}

function findAction(data, id) {
  return data.actions.find((action) => action.id === id) ?? null;
}

// 這張牌有沒有要指定對象的效果。
export function needsTarget(action) {
  return action.effects.some((effect) => effect.target === 'chosen');
}

// 輪到 uid 了嗎：白晝、有座位、還沒輪完、而且是他。是就回傳 null，不是就回傳退回原因。
function turnProblem(state, uid) {
  if (state.phase !== 'day') return 'not-day';
  if (!state.seats?.[uid]) return 'not-seated';
  const status = dayStatus(state, state.round);
  if (status.done) return 'day-over';
  return status.current === uid ? null : 'not-your-turn';
}

// 出牌前的檢查，照順序：白晝、輪到他、出牌數未滿、牌在手上、不是響應卡、不是 todo、付得起成本、要的對象有給且合法。
// 回傳 { reason }（不合法）或 { action, level, target, chainTarget }。被指定的人要是同桌另一位入座的人（工程暫定：不能指定自己）。
function checkPlay(state, uid, request, data) {
  const turnReason = turnProblem(state, uid);
  if (turnReason) return { reason: turnReason };
  const turn = currentTurn(state.turn, state.round);
  if (turn.plays >= data.settings.maxPlaysPerTurn) return { reason: 'no-plays-left' };
  if (typeof request.card !== 'string' || !(state.hands?.[uid] ?? []).includes(request.card)) return { reason: 'not-in-hand' };
  const action = findAction(data, request.card);
  if (!action) return { reason: 'unknown-card' };
  if (action.kind !== 'play') return { reason: 'response-card' };
  if (action.todo === true) return { reason: 'todo-card' };
  const seat = state.seats[uid];
  if (seat.pounds < action.cost.pounds || seat.influence < action.cost.influence) return { reason: 'cannot-afford' };
  const others = Object.keys(state.seats).filter((other) => other !== uid);
  let target = null;
  if (needsTarget(action)) {
    if (!request.target) return { reason: 'need-target' };
    if (!others.includes(request.target)) return { reason: 'bad-target' };
    target = request.target;
  }
  const level = chainLevel(turn, action);
  let chainTarget = null;
  if (level === 3) {
    if (!request.chainTarget) return { reason: 'need-chain-target' };
    if (!others.includes(request.chainTarget)) return { reason: 'bad-chain-target' };
    chainTarget = request.chainTarget;
  }
  return { reason: null, action, level, target, chainTarget };
}

// 畫面送出前先查一次（主持端結算時照樣再查）：這張牌現在出得出去嗎。state 只要有 round、phase、seats、startOrder、
// turn 與自己的手牌 hands[uid]。回傳退回原因（REJECT_REASONS 的鍵），出得出去是 null。
export function playProblem(state, uid, request, data) {
  return checkPlay(state, uid, request, data).reason;
}

// 出牌第一步：檢查、付成本、牌離開手牌、算級數、記下處理過的序號。
// 合法回傳 { ok: true, state, pending }：pending＝{ by, seq, card, level, target, chainTarget }，是等著 resolvePlay 結算的那張牌
// （這時牌不在手上、也還沒進棄牌堆）。不合法回傳 { ok: false, reason }，reason 是 REJECT_REASONS 的鍵，state 不動。
export function acceptPlay(state, uid, request, data) {
  const check = checkPlay(state, uid, request, data);
  if (check.reason) return { ok: false, reason: check.reason };
  const { action, level, target, chainTarget } = check;
  return {
    ok: true,
    state: payAndTake(state, uid, action, request.seq),
    pending: { by: uid, seq: request.seq, card: action.id, level, target, chainTarget },
  };
}

// 付這張牌的成本、從手牌拿掉（第一張相同編號），記下處理過的序號。出牌與響應共用。
function payAndTake(state, uid, action, seq) {
  const seat = state.seats[uid];
  const hand = [...state.hands[uid]];
  hand.splice(hand.indexOf(action.id), 1);
  return {
    ...state,
    seats: {
      ...state.seats,
      [uid]: {
        ...seat,
        pounds: seat.pounds - action.cost.pounds,
        influence: seat.influence - action.cost.influence,
        handCount: hand.length,
      },
    },
    hands: { ...state.hands, [uid]: hand },
    lastSeq: { ...state.lastSeq, [uid]: seq },
  };
}

// 效果打到誰（照座位順序）。source 是打出這張牌的情況 { by, level, target, originalPlayer }：一般牌就是 pending；
// 響應卡的 by 是響應者、originalPlayer 是被響應的那張牌的出牌者。
function recipients(state, effect, source) {
  const seated = seatsInOrder(state.seats).map(([uid]) => uid);
  switch (effect.target) {
    case 'self':
      return [source.by];
    case 'all':
      return seated;
    case 'others':
      return seated.filter((uid) => uid !== source.by);
    case 'chosen':
      return source.target ? [source.target] : [];
    case 'role':
      return seated.filter((uid) => state.seats[uid].role === effect.role); // 沒人坐這個階層就打空
    case 'originalPlayer':
      return source.originalPlayer ? [source.originalPlayer] : [];
    default:
      throw new RangeError(`這一版不結算這種對象：${effect.target}`);
  }
}

// 齒輪級數的加成。2 級：給出牌者自己的英鎊、影響力（正數）加倍，@全體 裡自己那一份也算；
// 4 級（含以上）：英鎊、影響力、抽牌、棄牌的數量都加倍，對別人的扣減也加倍。成本與迷霧不受影響。
// 響應卡的 source.level 是 1，不吃加成。
function scaledAmount(effect, uid, source) {
  if (source.level >= 4) return effect.amount * 2;
  const money = effect.op === 'pounds' || effect.op === 'influence';
  if (source.level === 2 && money && uid === source.by && effect.amount > 0) return effect.amount * 2;
  return effect.amount;
}

function withHand(state, uid, hand) {
  return {
    ...state,
    hands: { ...state.hands, [uid]: hand },
    seats: { ...state.seats, [uid]: { ...state.seats[uid], handCount: hand.length } },
  };
}

function drawFor(state, uid, count, random) {
  const result = draw({ deck: state.deck, discard: state.discard }, count, random);
  return { ...withHand(state, uid, [...(state.hands[uid] ?? []), ...result.drawn]), deck: result.deck, discard: result.discard };
}

// 從手牌隨機挑 count 張棄掉（主持端的亂數，被棄的人不能自己選）；不夠就全棄。回傳 { hand, discarded }，不改傳進來的陣列。
export function discardRandom(hand, count, random = cryptoRandom) {
  const kept = [...hand];
  const discarded = [];
  while (discarded.length < count && kept.length > 0) discarded.push(...kept.splice(randomBelow(kept.length, random), 1));
  return { hand: kept, discarded };
}

function discardFor(state, uid, count, random) {
  const { hand, discarded } = discardRandom(state.hands[uid] ?? [], count, random);
  return { ...withHand(state, uid, hand), discard: [...state.discard, ...discarded] };
}

// 偷（企劃 10/15）：拿走的量＝min(數量 × 倍數, 對方目前的數量)，對方減這麼多、偷的人（source.by；響應卡是打出響應卡的人）
// 加這麼多，總量不變。倍數（工程暫定）：4 級連鎖加倍（「所有數量加倍、對別人的扣減也加倍」）；2 級的「給自己的加倍」不套在偷上，
// 否則會憑空生錢；響應卡的 source.level 是 1，不吃加成。對象是 @指定（一般牌）或 @出牌者（響應卡）。
function stealFrom(state, effect, source) {
  let next = state;
  for (const uid of recipients(state, effect, source)) {
    if (uid === source.by || !next.seats[uid] || !next.seats[source.by]) continue;
    const wanted = source.level >= 4 ? effect.amount * 2 : effect.amount;
    const taken = Math.max(0, Math.min(wanted, next.seats[uid][effect.resource]));
    const victim = next.seats[uid];
    const thief = next.seats[source.by];
    next = {
      ...next,
      seats: {
        ...next.seats,
        [uid]: { ...victim, [effect.resource]: victim[effect.resource] - taken },
        [source.by]: { ...thief, [effect.resource]: thief[effect.resource] + taken },
      },
    };
  }
  return next;
}

// 一個效果。英鎊與影響力夾在 0 以上（資料庫規則要求不小於 0）。迷霧用 settings.fogThresholds 的門檻，
// 新越過的門檻依序放進 fogPending，由 settleFog 在這一筆結算的最後處理（迷霧事件）。source 見 recipients。
function applyEffect(state, effect, source, settings, random) {
  if (effect.op === 'fog') {
    const fog = advanceFog({ fog: state.fog, fogMax: state.fogMax, fired: state.fogFired }, effect.amount, settings.fogThresholds);
    return { ...state, fog: fog.fog, fogMax: fog.fogMax, fogFired: fog.fired, fogPending: [...(state.fogPending ?? []), ...fog.crossed] };
  }
  if (effect.op === 'steal') return stealFrom(state, effect, source);
  let next = state;
  for (const uid of recipients(state, effect, source)) {
    const amount = scaledAmount(effect, uid, source);
    if (effect.op === 'pounds' || effect.op === 'influence') {
      const seat = next.seats[uid];
      next = { ...next, seats: { ...next.seats, [uid]: { ...seat, [effect.op]: Math.max(0, seat[effect.op] + amount) } } };
    } else if (effect.op === 'draw') {
      next = drawFor(next, uid, amount, random);
    } else if (effect.op === 'discard') {
      next = discardFor(next, uid, amount, random);
    } else {
      throw new RangeError(`這一版不結算這種效果：${effect.op}`);
    }
  }
  return next;
}

// 出牌第二步：依序套用效果（含齒輪級數的加成；3 級另外抽 2 張、指定的人隨機棄 1 張）、牌進棄牌堆、記罪孽、
// 更新輪次（出滿 maxPlaysPerTurn 張自動換下一位）。回傳 { state, log }；log 是公開的出牌紀錄
// { round, by, card, level, target, chainTarget }（target 只有要指定對象的牌才有、chainTarget 只有 3 級連鎖才有；
// 時間由寫入的那一端補上伺服器時間）。
export function resolvePlay(state, pending, data, random = cryptoRandom) {
  const action = actionOf(data, pending.card);
  let next = state;
  for (const effect of action.effects) next = applyEffect(next, effect, pending, data.settings, random);
  if (pending.level === 3) {
    next = drawFor(next, pending.by, CHAIN_DRAW, random);
    next = discardFor(next, pending.chainTarget, CHAIN_DISCARD, random);
  }
  next = addSin({ ...next, discard: [...next.discard, pending.card] }, pending.by, action);
  next.turn = nextTurn(state, data, action.gear ?? null, pending.level);
  return { state: next, log: playLog(state, pending) };
}

function actionOf(data, id) {
  const action = findAction(data, id);
  if (!action) throw new RangeError(`找不到行動牌 ${id}`);
  return action;
}

// 罪孽：分類是「犯罪」或「破壞」的牌（一般牌與響應卡都算），打出的人記 1 點。
function addSin(state, uid, action) {
  if (!SIN_CATEGORIES.includes(action.category)) return state;
  const seat = state.seats[uid];
  return { ...state, seats: { ...state.seats, [uid]: { ...seat, sin: (seat.sin ?? 0) + 1 } } };
}

// 出了一張之後的輪次：這一輪多一張、記下這張的齒輪與級數；出滿 maxPlaysPerTurn 張就換下一位。
function nextTurn(state, data, gear, level) {
  const turn = currentTurn(state.turn, state.round);
  const plays = turn.plays + 1;
  return plays >= data.settings.maxPlaysPerTurn
    ? { round: state.round, ...TURN_START, index: turn.index + 1 }
    : { round: state.round, index: turn.index, plays, gear, level };
}

function playLog(state, pending) {
  const log = { round: state.round, by: pending.by, card: pending.card, level: pending.level };
  if (pending.target) log.target = pending.target;
  if (pending.chainTarget) log.chainTarget = pending.chainTarget;
  return log;
}

// ---- 響應卡（M5b） ----
// 別人每打出一張一般牌，同桌其他入座的人有 settings.responseSeconds 秒可以打出一張響應卡：先到先算（以伺服器收到的時間
// 為準），一張牌最多被響應一次，時間到沒人響應就照常結算。responseSeconds 是 0＝不開窗口，出牌當下就結算。
// 窗口開著時，那張牌在局面的 pending：{ id, by, seq, card, level, target, chainTarget, openedAt, seconds }
// （acceptPlay 的 pending 加上主持端產生的 id、伺服器時間 openedAt、當下的 responseSeconds）。窗口一律開，
// 不看有沒有人拿著用得上的響應卡（看了等於洩漏「沒人有」）。

// 截止之後主持端再等多久才當作沒人響應（毫秒）：截止前送出、還在路上的響應趕得上。
export const RESPONSE_GRACE_MS = 1000;

// 響應的截止時間（伺服器時間，毫秒）：請求的 at 不大於這個值才算數。
export function responseDeadline(pending) {
  return pending.openedAt + pending.seconds * 1000;
}

// 主持端從這個時間（伺服器時間）起可以當作沒人響應，照常結算。
export function responseSettleAt(pending) {
  return responseDeadline(pending) + RESPONSE_GRACE_MS;
}

// 響應前的檢查，照順序：有待響應的牌、是同一張、截止前送出（at 是伺服器時間）、有座位、不是自己出的、牌在手上、
// 是響應卡、不是 todo、分類對得上（respondsTo 是 null＝任何一般牌）、不用指定對象（這一版請求不帶對象）、付得起成本。
// 回傳 { reason }（不合法）或 { reason: null, action }。
function checkResponse(state, uid, request, data) {
  const { pending } = state;
  if (!pending) return { reason: 'no-pending' };
  if (request.pending !== pending.id) return { reason: 'wrong-pending' };
  if (!(request.at <= responseDeadline(pending))) return { reason: 'too-late' };
  if (!state.seats?.[uid]) return { reason: 'not-seated' };
  if (uid === pending.by) return { reason: 'own-card' };
  if (typeof request.card !== 'string' || !(state.hands?.[uid] ?? []).includes(request.card)) return { reason: 'not-in-hand' };
  const action = findAction(data, request.card);
  if (!action) return { reason: 'unknown-card' };
  if (action.kind !== 'response') return { reason: 'not-response-card' };
  if (action.todo === true) return { reason: 'todo-card' };
  const answers = action.respondsTo ?? null;
  if (answers !== null && !answers.includes(findAction(data, pending.card)?.category)) return { reason: 'wrong-category' };
  if (needsTarget(action)) return { reason: 'response-needs-target' };
  const seat = state.seats[uid];
  if (seat.pounds < action.cost.pounds || seat.influence < action.cost.influence) return { reason: 'cannot-afford' };
  return { reason: null, action };
}

// 畫面送出前先查一次：這張響應卡現在打得出去嗎。state 要有 seats、pending 與自己的手牌；request 是
// { card, pending: pending.id, at: 估計的伺服器時間 }。回傳退回原因（REJECT_REASONS 的鍵），打得出去是 null。
export function responseProblem(state, uid, request, data) {
  return checkResponse(state, uid, request, data).reason;
}

// 接下一張響應：檢查、付成本、牌離開手牌、記下處理過的序號。合法回傳 { ok: true, state, response }，
// response＝{ by, seq, card, at }；不合法回傳 { ok: false, reason }，state 不動。
export function acceptResponse(state, uid, request, data) {
  const check = checkResponse(state, uid, request, data);
  if (check.reason) return { ok: false, reason: check.reason };
  return {
    ok: true,
    state: payAndTake(state, uid, check.action, request.seq),
    response: { by: uid, seq: request.seq, card: check.action.id, at: request.at },
  };
}

// 被抵銷的牌（工程暫定）：效果與級數加成（含 3 級的抽 2、指定棄 1）都不結算；成本已在 acceptPlay 付過、
// 照樣算出了一張、犯罪或破壞照記罪孽、進棄牌堆；連鎖斷在這裡（turn 不留齒輪、級數 0，下一張從 1 級重算）。
function cancelPlay(state, pending, data) {
  const action = actionOf(data, pending.card);
  const next = addSin({ ...state, discard: [...state.discard, pending.card] }, pending.by, action);
  next.turn = nextTurn(state, data, null, 0);
  return { state: next, log: playLog(state, pending) };
}

// 結算待響應的牌。response 是 null（沒人響應，等於 resolvePlay）或 acceptResponse 接下的 { by, seq, card }
// （成本已付、牌已離開手牌）。響應卡有「抵銷」就走 cancelPlay，否則原牌照常結算（含級數加成）；之後才結算響應卡
// 其餘的效果：@出牌者＝原出牌者、@自己＝響應者，不吃級數加成（工程暫定的結算順序）。響應卡最後進棄牌堆，
// 分類是犯罪或破壞時響應者記罪孽；響應卡不算出牌數，也不碰輪次與連鎖。回傳 { state, log }，
// log 另外記 response { by, card }，抵銷時記 canceled: true。
export function resolveResponse(state, pending, response, data, random = cryptoRandom) {
  if (!response) return resolvePlay(state, pending, data, random);
  const answer = actionOf(data, response.card);
  const canceled = answer.effects.some((effect) => effect.op === 'cancel');
  const resolved = canceled ? cancelPlay(state, pending, data) : resolvePlay(state, pending, data, random);
  let next = resolved.state;
  const source = { by: response.by, level: 1, target: null, originalPlayer: pending.by };
  for (const effect of answer.effects) {
    if (effect.op !== 'cancel') next = applyEffect(next, effect, source, data.settings, random);
  }
  next = addSin({ ...next, discard: [...next.discard, answer.id] }, response.by, answer);
  const log = { ...resolved.log, response: { by: response.by, card: answer.id } };
  if (canceled) log.canceled = true;
  return { state: next, log };
}

const withSeq = (state, uid, seq) => ({ ...state, lastSeq: { ...state.lastSeq, [uid]: seq } });

// 主持端處理一桌待響應的牌（state.pending）。requests 是 { uid: 最新一筆請求 }（剛從伺服器讀到的請求），
// now 是伺服器時間。只看入座的人還沒處理過的響應；窗口中的出牌與結束這一輪先不處理，等這張牌結算完。回傳：
//   { kind: 'waiting' }                                還沒到 responseSettleAt，也沒有新的響應
//   { kind: 'rejected', state, notices }               只有不合法的響應：寫他們的 lastSeq 與 notice，pending 不動
//   { kind: 'resolved', state, log, response, notices }
//       有合法的響應（伺服器時間 at 最早的那筆，同時間比 uid），或到了 responseSettleAt 還沒人響應（response 是 null）；
//       state.pending 是 null。同一批裡其他的響應一起退回：合法但晚一步的原因是 beaten
// notices 是 [{ uid, seq, reason }]。
export function settlePending(state, requests, data, { now, random = cryptoRandom } = {}) {
  if (!state.pending) throw new RangeError('這一桌沒有待響應的牌');
  const fresh = Object.entries(requests ?? {})
    .filter(([uid, request]) => state.seats?.[uid] && request?.type === 'respond' && Number.isInteger(request.seq))
    .filter(([uid, request]) => request.seq > (state.lastSeq?.[uid] ?? 0))
    .sort(([a, x], [b, y]) => (x.at ?? Infinity) - (y.at ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0));
  let next = state;
  let response = null;
  const notices = [];
  for (const [uid, request] of fresh) {
    const accepted = response ? null : acceptResponse(next, uid, request, data);
    if (accepted?.ok) {
      next = accepted.state;
      response = accepted.response;
      continue;
    }
    const reason = accepted ? accepted.reason : (checkResponse(state, uid, request, data).reason ?? 'beaten');
    notices.push({ uid, seq: request.seq, reason });
    next = withSeq(next, uid, request.seq);
  }
  if (response || now >= responseSettleAt(state.pending)) {
    const resolved = resolveResponse(next, state.pending, response, data, random);
    return { kind: 'resolved', state: { ...resolved.state, pending: null }, log: resolved.log, response, notices };
  }
  return notices.length ? { kind: 'rejected', state: next, notices } : { kind: 'waiting' };
}

// ---- 黃昏：法案暗標投票（M6） ----
// 每回合進黃昏時，主持端替已開局的桌翻開一張法案（openDusk）。每位入座的人暗中送出「贊成或反對＋影響力出價」（0 到自己目前的
// 影響力），或棄權（出價 0、不選邊）；沒送出算棄權。揭曉前可以改，以最後一次為準。全員送出後倒數 settings.duskRevealSeconds 秒
// 揭曉，主持端也可以提前揭曉。揭曉（resolveDusk）：贊成與反對各自加總出價，贊成大於反對才通過，平手不通過；選邊的人照出價付
// 影響力、不論輸贏（夾 0）；先付出價，再套法案效果（通過 onPass、不通過 onFail；工程暫定的順序）；選邊與結果一致的人
// aligned＋1（議會之聲，M9 計分用）。state 除了白晝用的欄位，還有：
//   table      桌號（票的 table 是字串，比對時一律轉成字串）
//   dusk       這一回合的黃昏 { round, bill, openedAt, submitted, revealAt, result }：bill 是 null＝議會休會；openedAt、revealAt 是
//              伺服器時間（revealAt＝票的截止時間，全員送出後是「當時＋秒數」，提前揭曉是「當時」）；submitted 是已送出的人數；
//              result＝{ yes, no, passed, votes: { uid: { side, bid } } }，揭曉後才有。dusk.round 不是目前的回合＝這一回合還沒開
//   bills      { 法案編號: 'passed' | 'failed' }：每張法案最後一次的結果（天命判定用）
//   billDeck   [法案編號…]：還沒抽的法案（只有主持端看得到），陣列開頭是下一張
// 票（玩家自己寫的 votes/{code}/{uid}）：{ table, round, side: 'yes' | 'no' | 'abstain', bid, seq, at }，at 是伺服器收到的時間。

export const VOTE_SIDES = ['yes', 'no', 'abstain'];
// revealAt 之後主持端再等多久才揭曉（毫秒）：截止前送出、還在路上的票趕得上，主持端估的伺服器時間差一點也沒關係。
export const DUSK_GRACE_MS = 1000;
// 全員送出後的倒數最多幾秒：規則只收「伺服器時間到之後 60 秒之間」的截止時間，設定再長也照 60 秒。
export const DUSK_MAX_REVEAL_SECONDS = 60;

// 票為什麼不算（畫面送出前也用這張表顯示原因）。
export const VOTE_REASONS = {
  'not-dusk': '現在不是黃昏',
  'not-open': '這一回合的法案還沒翻開',
  adjourned: '今天議會休會，不用投票',
  revealed: '這張法案已經揭曉了',
  'not-seated': '你不在這一桌的座位上',
  'wrong-table': '這張票不是這一桌的',
  'wrong-round': '這張票不是這一回合的',
  'too-late': '投票已經截止了',
  'too-early': '這張票比這一回合的法案還早',
  'bad-vote': '看不懂這張票',
  'bad-side': '要選贊成、反對或棄權',
  'bad-bid': '出價要是 0 以上的整數',
  'abstain-bid': '棄權不能出價',
  'over-bid': '出價不能超過你目前的影響力',
};

// 這一回合的黃昏進行到哪：none（這一回合還沒開黃昏）、adjourned（議會休會）、voting（投票中，還沒有截止時間）、
// closing（有截止時間、還沒揭曉）、revealed（已揭曉）。
export function duskStage(dusk, round) {
  if (!dusk || dusk.round !== round) return 'none';
  if (!dusk.bill) return 'adjourned';
  if (dusk.result) return 'revealed';
  return dusk.revealAt === null || dusk.revealAt === undefined ? 'voting' : 'closing';
}

// 主持端從這個時間（伺服器時間）起揭曉。
export function duskSettleAt(dusk) {
  return dusk.revealAt + DUSK_GRACE_MS;
}

function findBill(data, id) {
  return data.bills.find((bill) => bill.id === id) ?? null;
}

// 抽一張法案（工程暫定的牌堆）：牌堆有牌就抽最上面一張；抽完了就把還沒通過的法案（不通過的、抽過但沒揭曉的）洗回去再抽，
// 第一次進黃昏時牌堆是空的、也沒有任何結果，等於把全部法案洗成一疊；一張都不剩（全都通過）就是 null（議會休會）。
// 回傳 { bill, billDeck }，不改傳進來的陣列。資料檔裡已經沒有的編號略過。
export function drawBill({ billDeck, bills }, data, random = cryptoRandom) {
  let deck = (billDeck ?? []).filter((id) => findBill(data, id));
  if (deck.length === 0) deck = shuffle(data.bills.map((bill) => bill.id).filter((id) => bills?.[id] !== 'passed'), random);
  return { bill: deck[0] ?? null, billDeck: deck.slice(1) };
}

// 開黃昏：抽一張法案，dusk＝{ round, bill, submitted: 0 }（openedAt 由寫入的那一端補上伺服器時間）。
export function openDusk(state, data, random = cryptoRandom) {
  if (Object.keys(state.seats ?? {}).length === 0) throw new RangeError('這一桌沒有人入座，不開黃昏');
  const { bill, billDeck } = drawBill(state, data, random);
  return { dusk: { round: state.round, bill, submitted: 0 }, billDeck };
}

// 一張票的檢查，照順序：黃昏、這一回合已翻開法案、不是休會、還沒揭曉、有座位、是這一桌這一回合的票、截止前送出（有 revealAt 時）、
// 選邊、出價是 0 以上的整數、棄權不出價、出價不超過目前的影響力。回傳原因（VOTE_REASONS 的鍵），合法是 null。
// 計票時（sending: false）不查階段與最後一項：揭曉在同一回合的黑夜也照做；規則在票寫入時已經查過當時的影響力，
// 之後影響力少了，付的時候夾 0。計票時另外只收法案翻開之後（at ≥ openedAt）送到的票：規則要求每次寫入都帶伺服器時間，
// 合法的票一定在翻開之後，這是多一道保險。
function checkVote(state, uid, vote, { sending = true } = {}) {
  if (sending && state.phase !== 'dusk') return 'not-dusk';
  const stage = duskStage(state.dusk, state.round);
  if (stage === 'none') return 'not-open';
  if (stage === 'adjourned') return 'adjourned';
  if (stage === 'revealed') return 'revealed';
  if (!state.seats?.[uid]) return 'not-seated';
  if (!vote || typeof vote !== 'object') return 'bad-vote';
  if (String(vote.table) !== String(state.table)) return 'wrong-table';
  if (vote.round !== state.round) return 'wrong-round';
  const { revealAt, openedAt } = state.dusk;
  if (revealAt !== null && revealAt !== undefined && !(typeof vote.at === 'number' && vote.at <= revealAt)) return 'too-late';
  if (!sending && !(typeof vote.at === 'number' && (typeof openedAt !== 'number' || vote.at >= openedAt))) return 'too-early';
  if (!VOTE_SIDES.includes(vote.side)) return 'bad-side';
  if (!Number.isInteger(vote.bid) || vote.bid < 0) return 'bad-bid';
  if (vote.side === 'abstain' && vote.bid !== 0) return 'abstain-bid';
  if (sending && vote.bid > state.seats[uid].influence) return 'over-bid';
  return null;
}

// 畫面送出前先查一次：這張票現在送得出去嗎。state 要有 table、round、phase、seats、dusk；vote 是
// { table, round, side, bid, at: 估計的伺服器時間 }。回傳原因（VOTE_REASONS 的鍵），送得出去是 null。
export function voteProblem(state, uid, vote) {
  return checkVote(state, uid, vote);
}

// 算數的票：votes 是 { uid: 最新的一張票 }（每人只有一張，重送會蓋掉，所以就是最後一次），只留入座的人、這一桌這一回合、
// 截止前送出的合法票。回傳照座位排好的 { uid: { side, bid } }；沒有的人＝沒送出，算棄權。
export function countVotes(state, votes) {
  const counted = {};
  for (const [uid] of seatsInOrder(state.seats)) {
    const vote = votes?.[uid];
    if (vote && checkVote(state, uid, vote, { sending: false }) === null) counted[uid] = { side: vote.side, bid: vote.bid };
  }
  return counted;
}

// 已送出的人數（公開在 dusk.submitted，畫面顯示「已送出 n／m 人」）。
export function submittedCount(state, votes) {
  return Object.keys(countVotes(state, votes)).length;
}

// 這張法案這次有哪些效果不結算：todo 的法案全部；@指定（chosen）這一版不結算（還沒定由誰指定）。
// 法案只會有 @全體、@階層編號 與迷霧（資料檢查擋掉其他對象），其他的也一律略過。資料裡找不到的法案（bill 是 null）沒有效果可算。
export function skippedEffects(bill, passed) {
  const effects = (passed ? bill?.onPass : bill?.onFail) ?? [];
  if (bill?.todo === true) return effects;
  return effects.filter((effect) => !tableEffectApplies(effect));
}

// 法案與事件（沒有出牌的人）結算得了的效果：迷霧，以及對 @全體、@階層編號 的英鎊、影響力、抽牌、棄牌。
function tableEffectApplies(effect) {
  if (effect.op === 'fog') return true;
  return ['pounds', 'influence', 'draw', 'discard'].includes(effect.op) && ['all', 'role'].includes(effect.target);
}

// 法案與事件的效果對這一桌結算（tableEffectApplies 以外的略過）。
function applyTableEffects(state, effects, data, random) {
  const source = { by: null, level: 1, target: null };
  let next = state;
  for (const effect of effects ?? []) {
    if (tableEffectApplies(effect)) next = applyEffect(next, effect, source, data.settings, random);
  }
  return next;
}

// 揭曉：計票、付出價、套法案效果、記 aligned 與結果。votes 是剛從伺服器讀到的 { uid: 票 }。
// 回傳 { state, result, log }：state 的 dusk 多了 result、bills 記下這張的結果；result＝{ yes, no, passed, votes }；
// log 是公開的黃昏紀錄（duskLog/{round}）{ bill, yes, no, passed, votes }。翻開後資料檔才拿掉的法案照樣揭曉（計票、付出價、
// 記結果），只是沒有效果可算，免得那一桌卡在黃昏。
export function resolveDusk(state, votes, data, random = cryptoRandom) {
  const stage = duskStage(state.dusk, state.round);
  if (stage !== 'voting' && stage !== 'closing') throw new RangeError('這一桌沒有在等揭曉的法案');
  const id = state.dusk.bill;
  const bill = findBill(data, id);
  const counted = countVotes(state, votes);
  let yes = 0;
  let no = 0;
  for (const { side, bid } of Object.values(counted)) {
    if (side === 'yes') yes += bid;
    if (side === 'no') no += bid;
  }
  const passed = yes > no;
  // 先付出價（選邊的人，不論輸贏；夾 0）。
  let next = { ...state, seats: { ...state.seats } };
  for (const [uid, { side, bid }] of Object.entries(counted)) {
    if (side === 'abstain') continue;
    const seat = next.seats[uid];
    next.seats[uid] = { ...seat, influence: Math.max(0, seat.influence - bid) };
  }
  // 再套法案效果。
  if (bill && bill.todo !== true) next = applyTableEffects(next, passed ? bill.onPass : bill.onFail, data, random);
  // 議會之聲：贊成且通過、反對且沒通過的人＋1；棄權不算。
  const seats = { ...next.seats };
  for (const [uid, { side }] of Object.entries(counted)) {
    if ((side === 'yes' && passed) || (side === 'no' && !passed)) seats[uid] = { ...seats[uid], aligned: (seats[uid].aligned ?? 0) + 1 };
  }
  const result = { yes, no, passed, votes: counted };
  next = {
    ...next,
    seats,
    dusk: { ...state.dusk, result },
    bills: { ...state.bills, [id]: passed ? 'passed' : 'failed' },
  };
  return { state: next, result, log: { bill: id, ...result } };
}

// 主持端處理一桌的黃昏。votes 是剛從伺服器讀到的 { uid: 票 }，now 是伺服器時間。回傳：
//   { kind: 'none' }                                  沒事可做：不是黃昏、休會、已揭曉，或沒有座位
//   { kind: 'opened', dusk, billDeck }                進黃昏了、這一回合還沒翻法案：抽一張（bill 是 null＝休會）
//   { kind: 'counted', submitted, revealAt }          已送出人數變了（寫 submitted）；全員送出、還沒有截止時間時
//                                                     revealAt＝now＋duskRevealSeconds 秒（最多 60 秒；否則是 null）
//   { kind: 'revealed', state, result, log }          到了 revealAt＋緩衝：揭曉（resolveDusk）
//   { kind: 'waiting' }                               投票中，沒有新的變化，或還沒到揭曉的時間
// 揭曉在同一回合的黑夜也照做（截止時間已定、票已經不能改）；開黃昏與計人數只在黃昏。
export function duskStep(state, votes, data, { now, random = cryptoRandom } = {}) {
  if (Object.keys(state.seats ?? {}).length === 0) return { kind: 'none' };
  const stage = duskStage(state.dusk, state.round);
  if (stage === 'none') return state.phase === 'dusk' ? { kind: 'opened', ...openDusk(state, data, random) } : { kind: 'none' };
  if (stage === 'adjourned' || stage === 'revealed') return { kind: 'none' };
  if (stage === 'closing' && now >= duskSettleAt(state.dusk)) return { kind: 'revealed', ...resolveDusk(state, votes, data, random) };
  if (state.phase !== 'dusk') return { kind: 'waiting' };
  const submitted = submittedCount(state, votes);
  const countdown = stage === 'voting' && submitted === Object.keys(state.seats).length;
  if (submitted === (state.dusk.submitted ?? 0) && !countdown) return { kind: 'waiting' };
  const seconds = Math.min(data.settings.duskRevealSeconds, DUSK_MAX_REVEAL_SECONDS);
  return { kind: 'counted', submitted, revealAt: countdown ? now + seconds * 1000 : null };
}

// 結束這一輪：輪到的人不出（或不再出）牌，換下一位。回傳 { ok: true, state } 或 { ok: false, reason }。
export function pass(state, uid, request) {
  const reason = turnProblem(state, uid);
  if (reason) return { ok: false, reason };
  const turn = currentTurn(state.turn, state.round);
  return {
    ok: true,
    state: { ...state, turn: { round: state.round, ...TURN_START, index: turn.index + 1 }, lastSeq: { ...state.lastSeq, [uid]: request.seq } },
  };
}

// 主持端處理 uid 的一筆請求 { seq, type, card, target, chainTarget, pending, at }。回傳：
//   { kind: 'ignored' }                           已經處理過（seq 不大於 lastSeq）或沒有序號，什麼都不寫
//   { kind: 'deferred' }                          這一桌有待響應的牌：先不處理（響應交給 settlePending，出牌與結束這一輪
//                                                 等那張牌結算完再來），什麼都不寫
//   { kind: 'rejected', reason, state }           不合法：只有 lastSeq 往前，要另外告訴本人原因（沒有待響應的牌時的響應也是）
//   { kind: 'passed', state }                     結束這一輪
//   { kind: 'opened', state, pending }            出牌、開響應窗口：只做 acceptPlay（成本已付、牌離開手牌），等 settlePending
//   { kind: 'played', state, log, pending }       出牌、不開窗口（responseSeconds 是 0）：acceptPlay 與 resolvePlay 一起做完
export function processRequest(state, uid, request, data, random = cryptoRandom) {
  if (!Number.isInteger(request?.seq) || request.seq <= (state.lastSeq?.[uid] ?? 0)) return { kind: 'ignored' };
  if (state.pending) return { kind: 'deferred' };
  const reject = (reason) => ({ kind: 'rejected', reason, state: withSeq(state, uid, request.seq) });
  if (request.type === 'respond') return reject('no-pending');
  if (request.type === 'pass') {
    const result = pass(state, uid, request);
    return result.ok ? { kind: 'passed', state: result.state } : reject(result.reason);
  }
  if (request.type !== 'play') return reject('bad-request');
  const accepted = acceptPlay(state, uid, request, data);
  if (!accepted.ok) return reject(accepted.reason);
  if ((data.settings.responseSeconds ?? 0) > 0) return { kind: 'opened', state: accepted.state, pending: accepted.pending };
  const { state: next, log } = resolvePlay(accepted.state, accepted.pending, data, random);
  return { kind: 'played', state: next, log, pending: accepted.pending };
}

// ---- 事件（M7）：日出一般事件與迷霧事件 ----
// 迷霧事件（企劃 10/15 第 1、2 題）：迷霧值「大於」門檻才算越過（剛好 30 不算）；每個門檻每場只在第一次越過時觸發，降回門檻以下
// 再升上來不再觸發；一次越過好幾個門檻由小到大處理；本場最高值記在 fogMax。任何結算讓迷霧新越過門檻時，門檻先進 fogPending，
// 在這一筆結算的最後由 settleFog 逐一處理：找 kind: fog、threshold 相同的事件，對這一桌結算效果。「造成越過的那個效果結算完」
// 的口徑（工程暫定）：一張牌（含齒輪加成與響應）、一張法案、一張一般事件整個結算完，才處理迷霧事件。
// 日出一般事件（企劃 10/15 回「照建議」，暫定）：每回合日出領薪、抽牌之後，每桌從自己的一般事件牌堆翻 settings.sunriseEvents 張
// （預設 1，0＝不翻），對這一桌結算效果並公開；第 1 回合也翻（跟開局同一筆寫入）。牌堆第一次用時把 kind: deck 的事件隨機洗成一疊
// （不照年代排），翻完就把全部一般事件重洗再用。
// 事件的對象：all＝該桌入座的人、role＝坐那個階層的人（沒人坐就打空）；chosen 這一版不結算（略過那一項，畫面寫一行提示，同法案）；
// todo 的事件只記紀錄、效果不結算。英鎊、影響力夾 0；抽牌、棄牌照白晝的做法（棄牌由主持端亂數挑）。
// state 除了白晝用的欄位，還有 eventDeck [事件編號…]（還沒翻的一般事件，只有主持端看得到，陣列開頭是下一張）。
// 公開的事件紀錄（games/{n}/eventLog/{i}，i 從 0 連號）一筆是 { round, phase, event, kind: 'deck' | 'fog', threshold, skipped }：
// threshold 只有迷霧事件才有；skipped: true＝這一筆的效果都沒結算（事件是 todo，或資料裡找不到這個門檻的事件，這時沒有 event）。

// 資料檔沒有 sunriseEvents 時的張數（data.js 的選填設定）。
export const SUNRISE_EVENTS_DEFAULT = SETTINGS.find(({ key }) => key === 'sunriseEvents').default;

function findEvent(data, id) {
  return (data.events ?? []).find((event) => event.id === id) ?? null;
}

// 這個門檻的迷霧事件（資料裡有好幾張時用第一張）；沒有是 null。
export function fogEventFor(data, threshold) {
  return (data.events ?? []).find((event) => event.kind === 'fog' && event.threshold === threshold) ?? null;
}

// 這張事件有哪些效果不結算：todo 的事件全部；@指定（chosen）這一版不結算。事件只會有 @全體、@指定、@階層編號 與迷霧
// （資料檢查擋掉其他對象），其他的也一律略過。
export function skippedEventEffects(event) {
  if (!event) return [];
  if (event.todo === true) return event.effects ?? [];
  return (event.effects ?? []).filter((effect) => !tableEffectApplies(effect));
}

// 一張事件對這一桌結算，回傳 { state, entry }；entry 是要寫進 eventLog 的那一筆。
function applyEvent(state, event, entry, data, random) {
  if (!event || event.todo === true) return { state, entry: { ...entry, skipped: true } };
  return { state: applyTableEffects(state, event.effects, data, random), entry };
}

// 處理 fogPending：由小到大一個一個來，每個門檻找它的迷霧事件結算；結算中又越過新的門檻就接著排、接著處理（每個門檻每場只觸發
// 一次，所以一定會停）。處理完 fogPending 清空；資料裡找不到那個門檻的事件就只記紀錄（skipped）、不結算。線上舊局面留下的
// fogPending（M5a–M6 只記不處理）在下一次結算時一併處理。phase 是寫進紀錄的階段（預設是 state.phase）。
// 回傳 { state, events }：events 是要寫進 eventLog 的紀錄，照處理順序；沒有要處理的門檻時 state 原樣回傳。
export function settleFog(state, data, { phase = state.phase, random = cryptoRandom } = {}) {
  let next = state;
  const events = [];
  while ((next.fogPending ?? []).length > 0) {
    const [threshold, ...rest] = [...next.fogPending].sort((a, b) => a - b);
    next = { ...next, fogPending: rest };
    const event = fogEventFor(data, threshold);
    const entry = { round: state.round, phase };
    if (event) entry.event = event.id;
    const applied = applyEvent(next, event, { ...entry, kind: 'fog', threshold }, data, random);
    next = applied.state;
    events.push(applied.entry);
  }
  return { state: next, events };
}

// 從一般事件牌堆翻 count 張：牌堆有牌就翻最上面的；翻完（或第一次用、牌堆是空的）就把全部一般事件（kind: deck）隨機洗成新的一疊
// 接著翻。資料檔裡已經沒有的編號略過；資料裡沒有任何一般事件就不翻。回傳 { drawn, eventDeck }，不改傳進來的陣列。
export function drawEvents(eventDeck, data, count, random = cryptoRandom) {
  const all = (data.events ?? []).filter((event) => event.kind === 'deck').map((event) => event.id);
  let pile = (eventDeck ?? []).filter((id) => all.includes(id));
  const drawn = [];
  while (drawn.length < count && all.length > 0) {
    if (pile.length === 0) pile = shuffle(all, random);
    drawn.push(pile.shift());
  }
  return { drawn, eventDeck: pile };
}

// 日出一般事件：領薪、抽牌之後（sunrise、startGame 之後）翻 settings.sunriseEvents 張，一張一張對這一桌結算；每張結算完就處理它
// 引發的迷霧事件（settleFog），最後再處理一次（0 張時也會處理線上舊局面留下的 fogPending）。state 要有 round、seats、hands、
// deck、discard、fog、fogMax、fogFired、fogPending、eventDeck。回傳 { state, events }：events 是要寫進 eventLog 的紀錄
// （一般事件、它引發的迷霧事件），照結算順序，phase 都是 sunrise。
export function settleSunriseEvents(state, data, random = cryptoRandom) {
  const count = data.settings.sunriseEvents ?? SUNRISE_EVENTS_DEFAULT;
  const { drawn, eventDeck } = drawEvents(state.eventDeck, data, count, random);
  let next = { ...state, eventDeck };
  const events = [];
  const fog = () => {
    const settled = settleFog(next, data, { phase: 'sunrise', random });
    next = settled.state;
    events.push(...settled.events);
  };
  for (const id of drawn) {
    const applied = applyEvent(next, findEvent(data, id), { round: state.round, phase: 'sunrise', event: id, kind: 'deck' }, data, random);
    next = applied.state;
    events.push(applied.entry);
    fog();
  }
  fog();
  return { state: next, events };
}

// 一筆結算（出牌 played、響應窗口結算 resolved、法案揭曉 revealed）的最後處理迷霧事件：結果的 state 換成處理完的，多一個 events
// （要寫進 eventLog 的紀錄）。其他種類（退回、接下、結束這一輪、開黃昏、計人數…）不是結算，原樣回傳。
export function withFogEvents(result, data, random = cryptoRandom) {
  if (!['played', 'resolved', 'revealed'].includes(result?.kind)) return result;
  const settled = settleFog(result.state, data, { random });
  return { ...result, state: settled.state, events: settled.events };
}

// Firebase 的陣列（數字鍵）讀回來可能是陣列，也可能是物件（中間有洞時）。照編號排好的 [紀錄…]，沒有是 []。
export function eventLogList(eventLog) {
  if (!eventLog) return [];
  return Object.entries(eventLog)
    .filter(([, entry]) => entry && typeof entry === 'object')
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, entry]) => entry);
}

// 下一筆事件紀錄的編號（現有最大的編號＋1；沒有紀錄是 0）。
export function nextEventIndex(eventLog) {
  return Object.keys(eventLog ?? {}).reduce((next, key) => Math.max(next, Number(key) + 1), 0);
}

// 這一回合日出翻到的一般事件（畫面從日出到白晝結束一直顯示）。
export function sunriseEventsOf(eventLog, round) {
  return eventLogList(eventLog).filter((entry) => entry.round === round && entry.phase === 'sunrise' && entry.kind === 'deck');
}

// ---- 黑夜：豪賭、分贓、睡覺（M8） ----
// 口徑（企劃 10/15 第 8 題雛形，數值都是選填設定；10/15 確認四點）：進黑夜時，主持端替已開局的桌開黑夜（openNight）；每位入座的人
// 暗中送出一個選擇：豪賭（同時選最多賭到第幾層，1–3）、分贓或睡覺。揭曉前可以改，以最後一次為準；沒送出＝睡覺。全員送出後倒數
// settings.nightRevealSeconds 秒揭曉，主持端也可以提前揭曉（時間的做法同黃昏）。揭曉（resolveNight）：
//   豪賭：從第 1 層開始，每層主持端擲一顆六面骰，擲到 gambleBust[層] 以下（含）就爆；過關時累積變成 gamblePounds[層] 英鎊＋
//         gambleInfluence[層] 影響力，到選的層數就收手拿走累積。爆了累積歸零，另付 gambleMedicalFee 英鎊醫藥費（夾 0）。
//   分贓：選分贓的人平分 splitPounds 英鎊（捨去），每人記 splitSin 點罪孽（沿用白晝的 sin）；只有 1 人就拿全部，分到 0 也照記罪孽。
//   睡覺：什麼都不發生。黑夜不動迷霧（照雛形），也不處理迷霧事件。
// state 除了白晝用的欄位，還有：
//   table      桌號（選擇的 table 是字串，比對時一律轉成字串）
//   night      這一回合的黑夜 { round, openedAt, submitted, revealAt, result }：openedAt、revealAt 是伺服器時間（revealAt＝選擇的截止時間，
//              全員送出後是「當時＋秒數」，提前揭曉是「當時」）；submitted 是已送出的人數；result 揭曉後才有，見 resolveNight。
//              night.round 不是目前的回合＝這一回合還沒開黑夜
// 選擇（玩家自己寫的 nights/{code}/{uid}）：{ table, round, choice: 'gamble' | 'split' | 'sleep', tiers（只有豪賭）, seq, at }，
// at 是伺服器收到的時間。

export const NIGHT_CHOICES = ['gamble', 'split', 'sleep'];
// 豪賭最多幾層、骰子幾面。
export const GAMBLE_TIERS = 3;
export const DIE_SIDES = 6;
// revealAt 之後主持端再等多久才揭曉（毫秒），全員送出後的倒數最多幾秒：同黃昏（規則只收伺服器時間到之後 60 秒之間的截止時間）。
export const NIGHT_GRACE_MS = DUSK_GRACE_MS;
export const NIGHT_MAX_REVEAL_SECONDS = DUSK_MAX_REVEAL_SECONDS;

// 選擇為什麼不算（畫面送出前也用這張表顯示原因）。
export const NIGHT_REASONS = {
  'not-night': '現在不是黑夜',
  'not-open': '這一回合的黑夜還沒開始',
  revealed: '黑夜已經揭曉了',
  'not-seated': '你不在這一桌的座位上',
  'wrong-table': '這個選擇不是這一桌的',
  'wrong-round': '這個選擇不是這一回合的',
  'too-late': '黑夜的選擇已經截止了',
  'too-early': '這個選擇比這一回合的黑夜還早',
  'bad-choice': '要選豪賭、分贓或睡覺',
  'bad-tiers': '豪賭要選賭到第 1、2 或 3 層',
  'tiers-not-gamble': '只有豪賭要選層數',
};

// 黑夜的數值（資料檔沒寫時用 data.js 的預設值）：{ revealSeconds, bust, pounds, influence, medicalFee, splitPounds, splitSin }；
// bust、pounds、influence 是第 1–3 層各一個數的陣列。畫面用它顯示每層爆的機率與獎勵。
export function nightSettings(settings) {
  const value = (key) => settings?.[key] ?? SETTINGS.find((setting) => setting.key === key).default;
  return {
    revealSeconds: value('nightRevealSeconds'),
    bust: value('gambleBust'),
    pounds: value('gamblePounds'),
    influence: value('gambleInfluence'),
    medicalFee: value('gambleMedicalFee'),
    splitPounds: value('splitPounds'),
    splitSin: value('splitSin'),
  };
}

// 這一回合的黑夜進行到哪：none（這一回合還沒開黑夜）、choosing（選擇中，還沒有截止時間）、closing（有截止時間、還沒揭曉）、
// revealed（已揭曉）。
export function nightStage(night, round) {
  if (!night || night.round !== round) return 'none';
  if (night.result) return 'revealed';
  return night.revealAt === null || night.revealAt === undefined ? 'choosing' : 'closing';
}

// 主持端從這個時間（伺服器時間）起揭曉。
export function nightSettleAt(night) {
  return night.revealAt + NIGHT_GRACE_MS;
}

// 開黑夜：night＝{ round, submitted: 0 }（openedAt 由寫入的那一端補上伺服器時間）。
export function openNight(state) {
  if (Object.keys(state.seats ?? {}).length === 0) throw new RangeError('這一桌沒有人入座，不開黑夜');
  return { night: { round: state.round, submitted: 0 } };
}

// 一個選擇的檢查，照順序：黑夜、這一回合已開黑夜、還沒揭曉、有座位、是這一桌這一回合的選擇、截止前送出（有 revealAt 時）、
// 選項、層數（只有豪賭有，1–3 的整數）。回傳原因（NIGHT_REASONS 的鍵），合法是 null。計票時（sending: false）不查階段，
// 另外只收黑夜開始之後（at ≥ openedAt）送到的選擇（同黃昏，多一道保險）。
function checkChoice(state, uid, pick, { sending = true } = {}) {
  if (sending && state.phase !== 'night') return 'not-night';
  const stage = nightStage(state.night, state.round);
  if (stage === 'none') return 'not-open';
  if (stage === 'revealed') return 'revealed';
  if (!state.seats?.[uid]) return 'not-seated';
  if (!pick || typeof pick !== 'object') return 'bad-choice';
  if (String(pick.table) !== String(state.table)) return 'wrong-table';
  if (pick.round !== state.round) return 'wrong-round';
  const { revealAt, openedAt } = state.night;
  if (revealAt !== null && revealAt !== undefined && !(typeof pick.at === 'number' && pick.at <= revealAt)) return 'too-late';
  if (!sending && !(typeof pick.at === 'number' && (typeof openedAt !== 'number' || pick.at >= openedAt))) return 'too-early';
  if (!NIGHT_CHOICES.includes(pick.choice)) return 'bad-choice';
  if (pick.choice === 'gamble') {
    if (!Number.isInteger(pick.tiers) || pick.tiers < 1 || pick.tiers > GAMBLE_TIERS) return 'bad-tiers';
  } else if (pick.tiers !== null && pick.tiers !== undefined) {
    return 'tiers-not-gamble';
  }
  return null;
}

// 畫面送出前先查一次：這個選擇現在送得出去嗎。state 要有 table、round、phase、seats、night；pick 是
// { table, round, choice, tiers, at: 估計的伺服器時間 }。回傳原因（NIGHT_REASONS 的鍵），送得出去是 null。
export function choiceProblem(state, uid, pick) {
  return checkChoice(state, uid, pick);
}

// 算數的選擇：picks 是 { uid: 最新的選擇 }（每人只有一筆，重送會蓋掉，所以就是最後一次），只留入座的人、這一桌這一回合、
// 黑夜開始之後到截止之前送出的合法選擇。回傳照座位排好的 { uid: { choice, tiers? } }；沒有的人＝沒送出，算睡覺。
export function countChoices(state, picks) {
  const counted = {};
  for (const [uid] of seatsInOrder(state.seats)) {
    const pick = picks?.[uid];
    if (!pick || checkChoice(state, uid, pick, { sending: false }) !== null) continue;
    counted[uid] = pick.choice === 'gamble' ? { choice: 'gamble', tiers: pick.tiers } : { choice: pick.choice };
  }
  return counted;
}

// 已送出的人數（公開在 night.submitted，畫面顯示「已送出 n／m 人」）。
export function submittedChoices(state, picks) {
  return Object.keys(countChoices(state, picks)).length;
}

// 豪賭一個人：從第 1 層擲到第 tiers 層（每層一顆六面骰，主持端的亂數），回傳 { rolls, bust, pounds, influence }：
// rolls 是每一擲的點數；爆了 bust 是 true、累積歸零；沒爆就是最後一層的累積。
export function gamble(tiers, settings, random = cryptoRandom) {
  const rules = nightSettings(settings);
  const rolls = [];
  let pounds = 0;
  let influence = 0;
  for (let tier = 0; tier < tiers; tier += 1) {
    const roll = randomBelow(DIE_SIDES, random) + 1;
    rolls.push(roll);
    if (roll <= rules.bust[tier]) return { rolls, bust: true, pounds: 0, influence: 0 };
    pounds = rules.pounds[tier];
    influence = rules.influence[tier];
  }
  return { rolls, bust: false, pounds, influence };
}

// 揭曉：照座位順序，每人照自己的選擇結算（沒送出＝睡覺；骰子照座位順序、一層一層擲）。picks 是剛從伺服器讀到的 { uid: 選擇 }。
// 回傳 { state, result, log }：result＝{ players: { uid: { choice, tiers, rolls, bust, pounds, influence, sin } } }，每位入座的人都有一筆
// （tiers、rolls、bust 只有豪賭有）；pounds、influence、sin 是這一夜實際的變化（爆了的醫藥費是負數，付不起時只付到 0）。
// state 的座位加上這些變化，night 多了 result；log 是公開的黑夜紀錄（nightLog/{round}），內容同 result。
export function resolveNight(state, picks, data, random = cryptoRandom) {
  const stage = nightStage(state.night, state.round);
  if (stage !== 'choosing' && stage !== 'closing') throw new RangeError('這一桌沒有在等揭曉的黑夜');
  const rules = nightSettings(data.settings);
  const counted = countChoices(state, picks);
  const order = seatsInOrder(state.seats).map(([uid]) => uid);
  const splitters = order.filter((uid) => counted[uid]?.choice === 'split').length;
  const share = splitters > 0 ? Math.floor(rules.splitPounds / splitters) : 0;
  const seats = { ...state.seats };
  const players = {};
  for (const uid of order) {
    const seat = seats[uid];
    const pick = counted[uid] ?? { choice: 'sleep' };
    let outcome = { choice: 'sleep', pounds: 0, influence: 0, sin: 0 };
    if (pick.choice === 'gamble') {
      const played = gamble(pick.tiers, data.settings, random);
      const fee = Math.min(rules.medicalFee, seat.pounds);
      outcome = { choice: 'gamble', tiers: pick.tiers, ...played, pounds: played.bust ? 0 - fee : played.pounds, sin: 0 };
    } else if (pick.choice === 'split') {
      outcome = { choice: 'split', pounds: share, influence: 0, sin: rules.splitSin };
    }
    players[uid] = outcome;
    seats[uid] = { ...seat, pounds: seat.pounds + outcome.pounds, influence: seat.influence + outcome.influence };
    if (outcome.sin > 0) seats[uid].sin = (seat.sin ?? 0) + outcome.sin;
  }
  const result = { players };
  return { state: { ...state, seats, night: { ...state.night, result } }, result, log: result };
}

// 主持端處理一桌的黑夜。picks 是剛從伺服器讀到的 { uid: 選擇 }，now 是伺服器時間。回傳：
//   { kind: 'none' }                       沒事可做：不是黑夜、已揭曉，或沒有座位
//   { kind: 'opened', night }              進黑夜了、這一回合還沒開：開黑夜
//   { kind: 'counted', submitted, revealAt }   已送出人數變了（寫 submitted）；全員送出、還沒有截止時間時
//                                          revealAt＝now＋nightRevealSeconds 秒（最多 60 秒；否則是 null）
//   { kind: 'revealed', state, result, log }   到了 revealAt＋緩衝：揭曉（resolveNight）
//   { kind: 'waiting' }                    選擇中沒有新的變化，或還沒到揭曉的時間
// 揭曉一定在同一回合的黑夜：推進到下一回合日出時回合變了，這一夜就不再揭曉（畫面在揭曉前擋住「下一階段」）。
export function nightStep(state, picks, data, { now, random = cryptoRandom } = {}) {
  if (Object.keys(state.seats ?? {}).length === 0) return { kind: 'none' };
  const stage = nightStage(state.night, state.round);
  if (stage === 'none') return state.phase === 'night' ? { kind: 'opened', ...openNight(state) } : { kind: 'none' };
  if (stage === 'revealed') return { kind: 'none' };
  if (stage === 'closing' && now >= nightSettleAt(state.night)) return { kind: 'revealed', ...resolveNight(state, picks, data, random) };
  if (state.phase !== 'night') return { kind: 'waiting' };
  const submitted = submittedChoices(state, picks);
  const countdown = stage === 'choosing' && submitted === Object.keys(state.seats).length;
  if (submitted === (state.night.submitted ?? 0) && !countdown) return { kind: 'waiting' };
  const seconds = Math.min(nightSettings(data.settings).revealSeconds, NIGHT_MAX_REVEAL_SECONDS);
  return { kind: 'counted', submitted, revealAt: countdown ? now + seconds * 1000 : null };
}

// ---- 手牌上限（M8；企劃 10/13 第 5 題、10/15 確認） ----
// 黑夜結束時手牌超過 settings.handLimit 就棄到上限。黑夜期間（揭曉前後都可以）超過的人自己挑要棄哪幾張，寫進
// discards/{code}/{uid}：{ table, round, cards: [牌編號…], seq, at }。主持端推進到下一回合日出時，在同一筆日出寫入的最前面先套用
// （applyHandLimits）：挑的合法（這一桌、剛結束的那一回合、張數剛好、都是自己手上的牌）就照挑的棄，沒挑或不合法就由主持端亂數
// 棄到上限；棄的牌進棄牌堆。接著才領薪、抽牌、翻一般事件（settleSunrise）。

// 挑的棄牌為什麼不照用（畫面也用這張表顯示原因）。
export const DISCARD_REASONS = {
  'not-over': '手牌沒有超過上限，不用棄',
  'no-pick': '還沒挑要棄的牌',
  'bad-pick': '看不懂挑的牌',
  'wrong-table': '挑的牌不是這一桌的',
  'wrong-round': '挑的牌不是這一回合黑夜的',
  'wrong-count': '張數不對',
  'not-in-hand': '有的牌不在手上',
};

// 要棄幾張：手牌超過 handLimit 的張數（沒超過是 0）。
export function overLimit(hand, settings) {
  return Math.max(0, (hand?.length ?? 0) - settings.handLimit);
}

// 挑的牌（Firebase 的陣列讀回來可能是陣列或數字鍵的物件），照編號排好的 [牌編號…]；不是牌編號的陣列是 null。
function pickedCards(cards) {
  if (!cards || typeof cards !== 'object') return null;
  const list = Object.entries(cards)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, card]) => card);
  return list.every((card) => typeof card === 'string') ? list : null;
}

// 挑的棄牌能不能照用：hand 是他現在的手牌，where 是 { table, round }（round＝剛結束的那一回合）。回傳原因（DISCARD_REASONS 的鍵），
// 能照用是 null。同一張牌有好幾張時，挑幾張就要手上有幾張。
export function discardProblem(hand, pick, { table, round }, settings) {
  const over = overLimit(hand, settings);
  if (over === 0) return 'not-over';
  if (!pick) return 'no-pick';
  const cards = typeof pick === 'object' ? pickedCards(pick.cards) : null;
  if (!cards) return 'bad-pick';
  if (String(pick.table) !== String(table)) return 'wrong-table';
  if (pick.round !== round) return 'wrong-round';
  if (cards.length !== over) return 'wrong-count';
  const left = [...hand];
  for (const card of cards) {
    const index = left.indexOf(card);
    if (index === -1) return 'not-in-hand';
    left.splice(index, 1);
  }
  return null;
}

// 套用手牌上限：照座位順序，手牌超過上限的人照挑的棄（discardProblem 是 null），不然由主持端亂數棄到上限；棄的牌照順序進棄牌堆。
// picks 是剛從伺服器讀到的 { uid: 挑的棄牌 }，round 是剛結束的那一回合。回傳 { state, discards }：discards＝{ uid: { cards, picked } }
// （只有棄了牌的人；picked 是不是照他挑的）。沒有人超過時 state 原樣回傳、不用亂數。
export function applyHandLimits(state, picks, data, { round, random = cryptoRandom } = {}) {
  let next = state;
  const discards = {};
  for (const [uid] of seatsInOrder(state.seats)) {
    const hand = next.hands?.[uid] ?? [];
    const over = overLimit(hand, data.settings);
    if (over === 0) continue;
    const pick = picks?.[uid];
    const picked = discardProblem(hand, pick, { table: state.table, round }, data.settings) === null;
    let kept;
    let cards;
    if (picked) {
      kept = [...hand];
      cards = pickedCards(pick.cards);
      for (const card of cards) kept.splice(kept.indexOf(card), 1);
    } else {
      ({ hand: kept, discarded: cards } = discardRandom(hand, over, random));
    }
    next = { ...withHand(next, uid, kept), discard: [...(next.discard ?? []), ...cards] };
    discards[uid] = { cards, picked };
  }
  return { state: next, discards };
}

// 下一回合日出的整筆計算（processSunrise 用）：先套手牌上限（上一回合黑夜挑的棄牌，applyHandLimits），再領薪、抽牌（sunrise），
// 最後翻一般事件與它引發的迷霧事件（settleSunriseEvents）。state 要有 table、round（新的回合）與 settleSunriseEvents 要的欄位。
// 回傳 { state, events, discards }。
export function settleSunrise(state, picks, data, random = cryptoRandom) {
  const limited = applyHandLimits(state, picks, data, { round: state.round - 1, random });
  const paid = sunrise(limited.state, data, random);
  const { state: next, events } = settleSunriseEvents(paid, data, random);
  return { state: next, events, discards: limited.discards };
}

// ---- 終局與計分（M9） ----
// 日落鐘（企劃 10/15 第 10 題暫定）：從該桌主持端按「開始」（games/{n}/startedAt，伺服器時間）起算 settings.sunsetMinutes 分鐘。
// 主持端在黑夜（揭曉後）按「下一階段」時，日落鐘到了、已經是第 maxRounds 回合（安全上限），或主持端先前按了「這回合結束後算分」
// （endAfterRound 等於目前回合），就不進下一回合日出，改進終局（shouldEnd）：同一筆寫入把該桌的階段改成 end、寫下 final（endGame），
// 不做日出棄牌、不領薪抽牌、不翻事件。各桌各自結束。
// 計分（企劃 10/15 第 9 題，計分值 10/15 定案），每人：
//   天命      達成得天命的 score.points，沒達成 0。判定照天命的 check（destinyDone）；check 是 null（「判定」空白）的由主持端勾
//             「達成／沒達成」（judgeScores），勾之前算 0 分
//   資產      英鎊每 scoreRates.pounds 點 1 分、影響力每 scoreRates.influence 點 1 分，各自捨去
//   公共成就  各 achievementPoints 分，同分都給：議會之聲（parliament）＝ aligned 最多的人（最多是 0 就沒人拿）；齒輪大師（gear）＝
//             本場打出過最高級連鎖的人（至少 2 級；被抵銷的那張不算），從全場保留的出牌紀錄 log 算
//   罪孽      每 sinPerPenalty 點扣 1 分（捨去）
//   總分＝天命＋資產＋公共成就－罪孽扣分；名次：總分高的在前，同分比英鎊，再同就並列（例如 1、1、3）。
// final＝{ round, endedAt, reason: 'sunset' | 'maxRounds' | 'host', scores: { uid: 分數 } }，endedAt 由寫入的一端補上伺服器時間。
// 分數＝{ destiny: { id, text, done, points }, assets: { pounds, influence, points }, achievements: ['parliament' | 'gear'], sin, sinPenalty,
//        total, rank }：destiny.points 是這張天命值幾分（done 是 true 才算進 total），done 是 true／false／null（待主持人判定）；
//        沒有天命的人 id、text 是 null、done 是 false。assets.points、sinPenalty 是換算出來的分數。英鎊、影響力、罪孽讀座位的現值
//        （黑夜的變化與分贓的罪孽已經加進座位）。

export const END_PHASE = 'end';
export const END_REASONS = ['sunset', 'maxRounds', 'host'];
export const ACHIEVEMENTS = ['parliament', 'gear'];
// 齒輪大師至少要打出過幾級的連鎖。
export const GEAR_MASTER_LEVEL = 2;
const MINUTE_MS = 60_000;

function settingOf(settings, key) {
  const value = key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), settings);
  return value ?? SETTINGS.find((setting) => setting.key === key).default;
}

// 終局與計分的數值（資料檔沒寫的選填設定用 data.js 的預設值；sunsetMinutes 是必填）。
export function scoreSettings(settings) {
  return {
    sunsetMinutes: settings?.sunsetMinutes,
    maxRounds: settingOf(settings, 'maxRounds'),
    poundsRate: settingOf(settings, 'scoreRates.pounds'),
    influenceRate: settingOf(settings, 'scoreRates.influence'),
    achievementPoints: settingOf(settings, 'achievementPoints'),
    sinPerPenalty: settingOf(settings, 'sinPerPenalty'),
  };
}

// 日落鐘：從 startedAt 到 now（都是伺服器時間）過了多久、還剩多久（毫秒），到了沒（剛好 sunsetMinutes 分鐘算到了）。
export function sunsetClock(startedAt, settings, now) {
  const length = scoreSettings(settings).sunsetMinutes * MINUTE_MS;
  const elapsed = Math.max(0, now - startedAt);
  return { elapsed, remaining: Math.max(0, length - elapsed), passed: elapsed >= length };
}

// 這一回合結束時（黑夜揭曉後按「下一階段」）要不要終局：回傳原因 sunset（日落鐘到了）、maxRounds（已經是第 maxRounds 回合）、
// host（主持端按了「這回合結束後算分」），不用就是 null；同時成立時照這個順序取第一個。state＝{ round, startedAt, endAfterRound }
// （startedAt、endAfterRound 在 games/{n}），now 是伺服器時間。玩家畫面也用它顯示「這是最後一回合」。
export function shouldEnd({ round, startedAt, endAfterRound }, settings, now) {
  if (typeof startedAt === 'number' && sunsetClock(startedAt, settings, now).passed) return 'sunset';
  if (round >= scoreSettings(settings).maxRounds) return 'maxRounds';
  if (endAfterRound === round) return 'host';
  return null;
}

function compareBy(left, op, right) {
  switch (op) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    default:
      throw new RangeError(`這一版不認得這個比較符號：${op}`);
  }
}

function seatValue(seat, what) {
  return (what === 'hand' ? seat?.handCount : seat?.[what]) ?? 0;
}

// 天命的判定（check 的寫法見 data.js）對 uid 在終局時成不成立：true／false；check 是 null（「判定」空白）時是 null，待主持人判定。
// state 要有 seats、fog（該桌終局時的迷霧值）、fogMax（本場最高）、bills（每張法案最後一次的結果；沒被表決的沒有，算沒通過）。
export function destinyDone(check, uid, state) {
  if (!check) return null;
  const seats = state.seats ?? {};
  switch (check.kind) {
    case 'bills':
      return check.bills.filter((id) => (state.bills?.[id] === 'passed') === check.passed).length >= check.atLeast;
    case 'compare': {
      const fog = state.fog ?? 0;
      const value = check.what === 'fog' ? fog : check.what === 'fogMax' ? Math.max(state.fogMax ?? 0, fog) : seatValue(seats[uid], check.what);
      return compareBy(value, check.op, check.value);
    }
    case 'most': {
      const mine = seatValue(seats[uid], check.what);
      return Object.values(seats).every((seat) => seatValue(seat, check.what) <= mine);
    }
    case 'moreThan': {
      const mine = seatValue(seats[uid], check.what);
      return Object.values(seats)
        .filter((seat) => seat.role === check.role)
        .every((seat) => mine > seatValue(seat, check.what));
    }
    default:
      throw new RangeError(`這一版不認得這種判定：${check.kind}`);
  }
}

// 每人本場打出過的最高連鎖級數，從出牌紀錄（games/{n}/log，全場保留）算；被抵銷的那張不算。回傳 { uid: 級數 }，沒出過牌的人沒有。
export function maxChains(log) {
  const best = {};
  for (const entry of Object.values(log ?? {})) {
    if (!entry || typeof entry !== 'object' || entry.canceled === true || !Number.isInteger(entry.level)) continue;
    best[entry.by] = Math.max(best[entry.by] ?? 0, entry.level);
  }
  return best;
}

// 公共成就，同分都給：議會之聲＝ aligned 最多的人（至少 1）；齒輪大師＝最高連鎖的人（至少 GEAR_MASTER_LEVEL 級）。
// 回傳 { uid: [成就…] }（照 ACHIEVEMENTS 的順序，沒有是 []）。
export function achievementsOf(seats, log) {
  const uids = Object.keys(seats ?? {});
  const chains = maxChains(log);
  const winners = (value, minimum) => {
    const best = Math.max(0, ...uids.map(value));
    return new Set(best >= minimum ? uids.filter((uid) => value(uid) === best) : []);
  };
  const parliament = winners((uid) => seats[uid].aligned ?? 0, 1);
  const gear = winners((uid) => chains[uid] ?? 0, GEAR_MASTER_LEVEL);
  return Object.fromEntries(uids.map((uid) => [uid, ACHIEVEMENTS.filter((key) => (key === 'parliament' ? parliament : gear).has(uid))]));
}

// 天命那一項算進總分的分數：達成（done 是 true）才算。
export function destinyPoints(destiny) {
  return destiny?.done === true ? (destiny.points ?? 0) : 0;
}

// 名次：總分高的在前，同分比英鎊（assets.pounds），再同就並列。回傳新的 scores，每人的 rank 換成算好的。
export function rankScores(scores) {
  const entries = Object.entries(scores ?? {});
  const ahead = (score, other) => other.total > score.total || (other.total === score.total && (other.assets?.pounds ?? 0) > (score.assets?.pounds ?? 0));
  return Object.fromEntries(entries.map(([uid, score]) => [uid, { ...score, rank: 1 + entries.filter(([, other]) => ahead(score, other)).length }]));
}

// 終局的分數（見上方說明），照座位順序。state 要有 seats、destinies（{ uid: 天命編號或 null }，從私密資料讀的）、fog、fogMax、bills、log。
export function scoreGame(state, data) {
  const rules = scoreSettings(data.settings);
  const awards = achievementsOf(state.seats, state.log);
  const scores = {};
  for (const [uid, seat] of seatsInOrder(state.seats)) {
    const id = state.destinies?.[uid] ?? null;
    const card = id === null ? null : ((data.destinies ?? []).find((destiny) => destiny.id === id) ?? null);
    const destiny = { id, text: card?.text ?? null, done: card ? destinyDone(card.check ?? null, uid, state) : false, points: card?.score?.points ?? 0 };
    const pounds = seat.pounds ?? 0;
    const influence = seat.influence ?? 0;
    const assets = { pounds, influence, points: Math.floor(pounds / rules.poundsRate) + Math.floor(influence / rules.influenceRate) };
    const achievements = awards[uid];
    const sin = seat.sin ?? 0;
    const sinPenalty = Math.floor(sin / rules.sinPerPenalty);
    const total = destinyPoints(destiny) + assets.points + achievements.length * rules.achievementPoints - sinPenalty;
    scores[uid] = { destiny, assets, achievements, sin, sinPenalty, total, rank: 0 };
  }
  return rankScores(scores);
}

// 終局那一筆的 final（endedAt 以外）：{ round, reason, scores }。state 是 scoreGame 要的局面加上 round。
export function endGame(state, data, reason) {
  if (!END_REASONS.includes(reason)) throw new RangeError(`不認得的終局原因：${reason}`);
  return { round: state.round, reason, scores: scoreGame(state, data) };
}

// 主持端勾天命：uid 的 destiny.done 改成 done（true／false；null＝改回待判定），總分只換天命那一項，名次全桌重排。
// 回傳新的 scores，不改傳進來的。scores 可以是從資料庫讀回來的（null 與空陣列已經不見）。
export function judgeScores(scores, uid, done) {
  const score = scores?.[uid];
  if (!score) throw new RangeError(`沒有這個人的分數：${uid}`);
  const destiny = { ...score.destiny, done };
  const total = score.total - destinyPoints(score.destiny) + destinyPoints(destiny);
  return rankScores({ ...scores, [uid]: { ...score, destiny, total } });
}
