// 各畫面模組共用的狀態：連線、房號、最近一次的房間資料、卡牌資料、自己的私密資料與請求。只放資料，不碰畫面。
import { seed } from '../config.js';
import { seededRandom } from '../game.js';

export const ctx = {
  session: null,
  code: null,
  stopPresence: null,
  requested: false, // 這台裝置送過主持端申請、還在等核准
  latestRoom: null, // 最近一次收到的房間資料，私密資料或卡牌資料晚到時拿來重畫
  cardData: null, // 卡牌資料 { data, index }：讀到而且檢查沒有錯誤才有
  cardsFailed: false, // 卡牌資料讀不到或有錯誤
  mine: null, // 自己的私密資料 { table, hand, destiny }；還沒收到或沒有入座時是 null
  myRequest: null, // 自己最新的一筆請求 { seq, type, card, … }（出牌、結束這一輪或響應）
  myVote: null, // 自己最新的一張票 { table, round, side, bid, seq, at }
  myNight: null, // 自己最新的黑夜選擇 { table, round, choice, tiers, seq, at }
  myDiscard: null, // 自己最新挑的棄牌 { table, round, cards, seq, at }
};

// ?seed=<整數>（只有模擬器認）：主持端洗牌、隨機棄牌用固定種子，畫面測試時手牌每次都一樣。
export const random = seed === null ? undefined : seededRandom(seed);

// 重畫：app.js 接上 render(latestRoom)。
const hooks = { rerender: () => {} };

export function setRerender(fn) {
  hooks.rerender = fn;
}

export function rerender() {
  hooks.rerender();
}
