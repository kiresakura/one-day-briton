// 純函式：開局與日出的計算（牌庫、洗牌、座位與階層、隱藏天命、抽牌、領薪），以及白晝的輪流出牌、響應卡與結算。
// 不碰網路、不碰畫面，瀏覽器與 Node 測試共用同一份。輸入資料檔的內容與目前的局面，輸出要寫入的新局面。
// 亂數一律從注入的來源拿（預設是 crypto.getRandomValues），測試用固定種子。
//
// 一桌的局面：
//   seats      { uid: { order, role, pounds, influence, handCount, sin } }  公開（同桌都看得到）；sin 沒有＝0
//   hands      { uid: [牌編號…] }、destinies { uid: 天命編號或 null }   本人與主持端
//   deck       [牌編號…]（陣列順序＝抽牌順序）、discard [牌編號…]      只有主持端
import { ROLE_COUNT } from './data.js';
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

// ---- 白晝：輪流出牌、成本與效果、齒輪連鎖（M5a） ----
// 主持端把一桌讀成 state 交給這裡算，再整筆寫回。state 除了上面的 seats、hands、deck、discard，還有：
//   round、phase、fog   該桌目前的回合、階段、迷霧值（rooms/{code}/tables/{n}）
//   startOrder          第 1 回合的起始座位，沒設是 0
//   turn                { round, index, plays, gear, level }：輪到出牌順序裡的第幾位、他這一輪出了幾張、
//                       上一張的齒輪與級數；round 不是目前的回合＝這一回合的白晝還沒開始
//   fogMax、fogFired、fogPending   本場迷霧最高值、已觸發的門檻、新越過還沒處理的門檻（事件留給 M7）
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

// 一個效果。英鎊與影響力夾在 0 以上（資料庫規則要求不小於 0）。迷霧用 settings.fogThresholds 的門檻，
// 新越過的門檻依序放進 fogPending，事件本身留給 M7。source 見 recipients。
function applyEffect(state, effect, source, settings, random) {
  if (effect.op === 'fog') {
    const fog = advanceFog({ fog: state.fog, fogMax: state.fogMax, fired: state.fogFired }, effect.amount, settings.fogThresholds);
    return { ...state, fog: fog.fog, fogMax: fog.fogMax, fogFired: fog.fired, fogPending: [...(state.fogPending ?? []), ...fog.crossed] };
  }
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
