// 純函式：開局與日出的計算（牌庫、洗牌、座位與階層、隱藏天命、抽牌、領薪），以及白晝的輪流出牌與結算。
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
// 一張一般牌分兩步：acceptPlay（檢查、付成本、牌離開手牌、算級數）與 resolvePlay（套效果、牌進棄牌堆、記罪孽與紀錄、
// 更新輪次）。M5a 兩步在同一筆寫入完成；M5b 會在兩步之間插入響應窗口，所以兩步之間的 state 與 pending 都是純資料，可以單獨存。

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

// 出牌第一步：檢查、付成本、牌離開手牌、算級數、記下處理過的序號。
// 合法回傳 { ok: true, state, pending }：pending＝{ by, seq, card, level, target, chainTarget }，是等著 resolvePlay 結算的那張牌
// （這時牌不在手上、也還沒進棄牌堆）。不合法回傳 { ok: false, reason }，reason 是 REJECT_REASONS 的鍵，state 不動。
export function acceptPlay(state, uid, request, data) {
  const check = checkPlay(state, uid, request, data);
  if (check.reason) return { ok: false, reason: check.reason };
  const { action, level, target, chainTarget } = check;
  const seat = state.seats[uid];
  const hand = [...state.hands[uid]];
  hand.splice(hand.indexOf(action.id), 1);
  return {
    ok: true,
    state: {
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
      lastSeq: { ...state.lastSeq, [uid]: request.seq },
    },
    pending: { by: uid, seq: request.seq, card: action.id, level, target, chainTarget },
  };
}

// 效果打到誰（照座位順序）。originalPlayer 只有響應卡會用，響應卡這一版不能當一般牌出，走不到這裡。
function recipients(state, effect, pending) {
  const seated = seatsInOrder(state.seats).map(([uid]) => uid);
  switch (effect.target) {
    case 'self':
      return [pending.by];
    case 'all':
      return seated;
    case 'others':
      return seated.filter((uid) => uid !== pending.by);
    case 'chosen':
      return pending.target ? [pending.target] : [];
    case 'role':
      return seated.filter((uid) => state.seats[uid].role === effect.role); // 沒人坐這個階層就打空
    default:
      throw new RangeError(`這一版不結算這種對象：${effect.target}`);
  }
}

// 齒輪級數的加成。2 級：給出牌者自己的英鎊、影響力（正數）加倍，@全體 裡自己那一份也算；
// 4 級（含以上）：英鎊、影響力、抽牌、棄牌的數量都加倍，對別人的扣減也加倍。成本與迷霧不受影響。
function scaledAmount(effect, uid, pending) {
  if (pending.level >= 4) return effect.amount * 2;
  const money = effect.op === 'pounds' || effect.op === 'influence';
  if (pending.level === 2 && money && uid === pending.by && effect.amount > 0) return effect.amount * 2;
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
// 新越過的門檻依序放進 fogPending，事件本身留給 M7。
function applyEffect(state, effect, pending, settings, random) {
  if (effect.op === 'fog') {
    const fog = advanceFog({ fog: state.fog, fogMax: state.fogMax, fired: state.fogFired }, effect.amount, settings.fogThresholds);
    return { ...state, fog: fog.fog, fogMax: fog.fogMax, fogFired: fog.fired, fogPending: [...(state.fogPending ?? []), ...fog.crossed] };
  }
  let next = state;
  for (const uid of recipients(state, effect, pending)) {
    const amount = scaledAmount(effect, uid, pending);
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
// { round, by, card, level, target }（target 只有要指定對象的牌才有；時間由寫入的那一端補上伺服器時間）。
export function resolvePlay(state, pending, data, random = cryptoRandom) {
  const action = findAction(data, pending.card);
  if (!action) throw new RangeError(`找不到行動牌 ${pending.card}`);
  let next = state;
  for (const effect of action.effects) next = applyEffect(next, effect, pending, data.settings, random);
  if (pending.level === 3) {
    next = drawFor(next, pending.by, CHAIN_DRAW, random);
    next = discardFor(next, pending.chainTarget, CHAIN_DISCARD, random);
  }
  next = { ...next, discard: [...next.discard, pending.card] };
  if (SIN_CATEGORIES.includes(action.category)) {
    const seat = next.seats[pending.by];
    next = { ...next, seats: { ...next.seats, [pending.by]: { ...seat, sin: (seat.sin ?? 0) + 1 } } };
  }
  const turn = currentTurn(state.turn, state.round);
  const plays = turn.plays + 1;
  next.turn =
    plays >= data.settings.maxPlaysPerTurn
      ? { round: state.round, ...TURN_START, index: turn.index + 1 }
      : { round: state.round, index: turn.index, plays, gear: action.gear ?? null, level: pending.level };
  const log = { round: state.round, by: pending.by, card: pending.card, level: pending.level };
  if (pending.target) log.target = pending.target;
  return { state: next, log };
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

// 主持端處理 uid 的一筆請求 { seq, type, card, target, chainTarget }。回傳：
//   { kind: 'ignored' }                           已經處理過（seq 不大於 lastSeq）或沒有序號，什麼都不寫
//   { kind: 'rejected', reason, state }           不合法：只有 lastSeq 往前，要另外告訴本人原因
//   { kind: 'passed', state }                     結束這一輪
//   { kind: 'played', state, log, pending }       出牌，acceptPlay 與 resolvePlay 一起做完
export function processRequest(state, uid, request, data, random = cryptoRandom) {
  if (!Number.isInteger(request?.seq) || request.seq <= (state.lastSeq?.[uid] ?? 0)) return { kind: 'ignored' };
  const reject = (reason) => ({ kind: 'rejected', reason, state: { ...state, lastSeq: { ...state.lastSeq, [uid]: request.seq } } });
  if (request.type === 'pass') {
    const result = pass(state, uid, request);
    return result.ok ? { kind: 'passed', state: result.state } : reject(result.reason);
  }
  if (request.type !== 'play') return reject('bad-request');
  const accepted = acceptPlay(state, uid, request, data);
  if (!accepted.ok) return reject(accepted.reason);
  const { state: next, log } = resolvePlay(accepted.state, accepted.pending, data, random);
  return { kind: 'played', state: next, log, pending: accepted.pending };
}
