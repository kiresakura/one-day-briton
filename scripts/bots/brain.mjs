// 機器人的選擇（純函式）：從規則允許的動作裡隨機挑一個。能不能做一律用 game.js 的檢查（playProblem、responseProblem、
// voteProblem、choiceProblem、discardProblem），跟玩家端畫面送出前查的是同一套；主持端結算時照樣再查一次。
// random 是亂數來源，同 game.js：每次回傳 0 到 2^32−1 的整數（平常是 cryptoRandom，測試給 seededRandom）。
import {
  GAMBLE_TIERS,
  NIGHT_CHOICES,
  chainLevel,
  choiceProblem,
  currentTurn,
  discardProblem,
  needsTarget,
  overLimit,
  playProblem,
  randomBelow,
  responseProblem,
  seatsInOrder,
  voteProblem,
} from '../../play/js/game.js';

// 「隨機」的機率。
export const DEFAULT_POLICY = {
  passChance: 0.12, // 輪到自己、這一輪還沒出牌時，直接結束這一輪
  passStep: 0.22, // 這一輪每多出一張，結束這一輪的機率再加這麼多
  respondChance: 0.25, // 手上有能響應的牌時，響應
  abstainChance: 0.2, // 黃昏棄權（其餘贊成、反對各半）
};

// 機率 probability（0–1）成立嗎。
export function chance(probability, random) {
  return randomBelow(1_000_000, random) < probability * 1_000_000;
}

export function pickOne(list, random) {
  return list[randomBelow(list.length, random)];
}

// min 到 max（含）的整數。
export function between(min, max, random) {
  return min + randomBelow(max - min + 1, random);
}

// 同桌的其他人（照座位順序）。
function othersOf(seats, uid) {
  return seatsInOrder(seats)
    .map(([id]) => id)
    .filter((id) => id !== uid);
}

// 輪到自己時出得了的牌：手上每一種牌照 playProblem 查。要指定對象的牌從同桌其他人隨機挑一位，3 級連鎖另外隨機挑棄牌的人
// （同玩家端：只有要的時候才帶）。view 是 { round, phase, seats, startOrder, turn, pending, hands: { [uid]: 手牌 } }（同玩家端畫面
// 給 playProblem 的局面），skip 是這一輪被主持端退回過的牌。回傳 [{ card, target, chainTarget }]，一種牌一筆。
export function playOptions(view, uid, data, { skip = new Set(), random }) {
  const others = othersOf(view.seats, uid);
  const turn = currentTurn(view.turn, view.round);
  const options = [];
  for (const card of new Set(view.hands?.[uid] ?? [])) {
    const action = data.actions.find((item) => item.id === card);
    if (!action || skip.has(card)) continue;
    const target = needsTarget(action) && others.length > 0 ? pickOne(others, random) : null;
    const chainTarget = chainLevel(turn, action) === 3 && others.length > 0 ? pickOne(others, random) : null;
    const request = { card, target, chainTarget };
    if (playProblem(view, uid, request, data) === null) options.push(request);
  }
  return options;
}

// 響應窗口裡打得出去的響應卡（不重複的牌編號）：照 responseProblem 查，時間用估計的伺服器時間 now（同玩家端）。
export function responseOptions(view, uid, data, now) {
  const { pending } = view;
  if (!pending) return [];
  return [...new Set(view.hands?.[uid] ?? [])].filter((card) => responseProblem(view, uid, { card, pending: pending.id, at: now }, data) === null);
}

// 黃昏的票：棄權，或隨機選贊成／反對、出價 0 到自己目前的影響力。view 是 { table（局號）, round, phase, seats, dusk }（同玩家端）。
// 照 voteProblem 查，不合法就改棄權；棄權也不行（例如已經截止）是 null。回傳 { table, round, side, bid }。
export function chooseVote(view, uid, now, { policy = DEFAULT_POLICY, random }) {
  const influence = Math.max(0, view.seats?.[uid]?.influence ?? 0);
  const side = chance(policy.abstainChance, random) ? 'abstain' : pickOne(['yes', 'no'], random);
  const base = { table: view.table, round: view.round };
  const wanted = { ...base, side, bid: side === 'abstain' ? 0 : randomBelow(influence + 1, random) };
  for (const vote of [wanted, { ...base, side: 'abstain', bid: 0 }]) {
    if (voteProblem(view, uid, { ...vote, at: now }) === null) return vote;
  }
  return null;
}

// 黑夜的選擇：豪賭（隨機賭到第 1–3 層）、分贓、睡覺三選一。view 是 { table（局號）, round, phase, seats, night }（同玩家端）。
// 照 choiceProblem 查，不合法就改睡覺；都不行是 null。回傳 { table, round, choice, tiers }（tiers 只有豪賭有，其他是 null）。
export function chooseNight(view, uid, now, { random }) {
  const choice = pickOne(NIGHT_CHOICES, random);
  const base = { table: view.table, round: view.round };
  const wanted = { ...base, choice, tiers: choice === 'gamble' ? between(1, GAMBLE_TIERS, random) : null };
  for (const pick of [wanted, { ...base, choice: 'sleep', tiers: null }]) {
    if (choiceProblem(view, uid, { ...pick, at: now }) === null) return pick;
  }
  return null;
}

// 手牌超過上限時要棄的牌：照手牌的位置隨機挑剛好超過的張數（同一張牌有好幾張時也對得上），照手牌原本的順序排。
// where 是 { table（局號）, round }。不用棄、或挑的過不了 discardProblem 是 null。
export function chooseDiscard(hand, where, settings, { random }) {
  const over = overLimit(hand, settings);
  if (over === 0) return null;
  const left = hand.map((_, index) => index);
  const picked = [];
  while (picked.length < over) picked.push(...left.splice(randomBelow(left.length, random), 1));
  const cards = picked.sort((a, b) => a - b).map((index) => hand[index]);
  return discardProblem(hand, { ...where, cards }, where, settings) === null ? cards : null;
}
