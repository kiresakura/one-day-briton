// 主持端與玩家端共用：提示訊息、按鈕執行、倒數、事件／法案／黑夜／計分的文字，以及共用元件（狀態條、倒數圈、迷霧值、
// 齒輪連鎖、連線狀態、羊皮紙卡面）。文字與數字一律從卡牌資料與房間狀態算，不寫死示範內容。
import {
  DUSK_GRACE_MS,
  NIGHT_GRACE_MS,
  combineScores,
  duskSettleAt,
  eventLogList,
  nightSettings,
  nightSettleAt,
  rotateSeats,
  scoreSettings,
  shouldEnd,
  skippedEventEffects,
  sunriseEventsOf,
  seatsInOrder,
} from '../game.js';
import { FOG_THRESHOLDS, MATCH_COUNT, PHASE_LABELS, matchKey } from '../rules.js';
import { StoreError, serverTime, trackPresence } from '../store.js';
import { $, h } from './dom.js';
import { ctx, rerender } from './state.js';

// 場次標示「第 N 場」：畫面上的場次文字都從這裡來（match 是 rules.js 的 matchOf／parseKey 算出來的 1 或 2）。
export function matchText(match) {
  return `第 ${match} 場`;
}
export const MATCH_TEXT = matchText(1);
export const KIND_LABELS = { play: '一般', response: '響應' };
// 齒輪連鎖各級的加成（企劃 10/15 回覆第 10 題）。
export const CHAIN_BONUS = {
  2: '給自己的英鎊、影響力加倍',
  3: '另外抽 2 張，並指定一人隨機棄 1 張',
  4: '英鎊、影響力、抽牌、棄牌的數量全部加倍',
};
export const SIDE_LABELS = { yes: '贊成', no: '反對', abstain: '棄權' };
export const CHOICE_LABELS = { gamble: '豪賭', split: '分贓', sleep: '睡覺' };
export const PHASE_NAMES = { ...PHASE_LABELS, end: '終局' };
export const PHASE_LATIN = { sunrise: 'DAWN', day: 'DAY', dusk: 'DUSK', night: 'NIGHT', end: 'FINALE' };
// <body data-phase> 的色調名稱。
export const PHASE_TONES = { sunrise: 'dawn', day: 'day', dusk: 'dusk', night: 'night', end: 'end' };
export const END_REASON_TEXT = { sunset: '日落鐘到了', maxRounds: '到了回合上限', host: '主持端提早收場' };
export const ACHIEVEMENT_LABELS = { parliament: '議會之聲', gear: '齒輪大師' };
export const RESOURCE_LABELS = { pounds: '英鎊', influence: '影響力' };
const MINUTE_MS = 60_000;

export function notify(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

export function explain(error) {
  return error instanceof StoreError ? error.message : '連線有問題，請稍後再試一次';
}

// 按下去先停用按鈕，做完再恢復；失敗就把原因顯示出來。
export async function run(button, action) {
  button.disabled = true;
  notify();
  try {
    await action();
  } catch (error) {
    notify(explain(error));
  } finally {
    button.disabled = false;
  }
}

// 進到主持或玩家畫面後才標示自己在線上；回首頁時移除。
export function markPresent() {
  ctx.stopPresence ??= trackPresence(ctx.session, ctx.code);
}

export function isOnline(room, uid) {
  return uid === ctx.session.uid || room.presence?.[uid] === true;
}

export function playersAt(room, table) {
  return Object.entries(room.players ?? {})
    .filter(([, player]) => player.table === table)
    .sort(([, a], [, b]) => a.joinedAt - b.joinedAt);
}

// 入座的人的暱稱；已經離開房間的人也照樣有座位。
export function nameOf(room, uid) {
  const name = room?.players?.[uid]?.name ?? '（已離開房間）';
  return uid === ctx.session.uid ? `${name}（你）` : name;
}

export function roleName(roleId) {
  return ctx.cardData?.index.roles.get(roleId)?.name ?? roleId;
}

export function cardName(id) {
  return ctx.cardData?.index.actions.get(id)?.name ?? id;
}

// 這張牌的「偷」寫成「從 ○○ 偷走 3 英鎊」；from 是被偷的人。數量是牌上的數量（4 級連鎖加倍）：出牌紀錄沒有記實際拿到多少，
// 對方不夠時實際拿到的比較少（見座位上的數字）。
export function stealText(room, action, from, level = 1) {
  const steals = (action?.effects ?? []).filter((effect) => effect.op === 'steal');
  if (!from || steals.length === 0) return '';
  const parts = steals.map((effect) => `${effect.amount * (level >= 4 ? 2 : 1)} ${RESOURCE_LABELS[effect.resource] ?? effect.resource}`);
  return `・從 ${nameOf(room, from)} 偷走 ${parts.join('、')}`;
}

// 一筆出牌紀錄的文字（不含回合）：「○○ 打出「X」（2 級連鎖）→ △△・…・被 □□ 以「Y」響應」。
export function playText(room, entry) {
  const name = cardName(entry.card);
  const level = entry.level > 1 ? `（${entry.level} 級連鎖）` : '';
  const target = entry.target ? ` → ${nameOf(room, entry.target)}` : '';
  const chain = entry.chainTarget && !entry.canceled ? `・${nameOf(room, entry.chainTarget)} 隨機棄 1 張` : '';
  const stolen = entry.canceled ? '' : stealText(room, ctx.cardData?.index.actions.get(entry.card), entry.target, entry.level);
  const answer = entry.response ? `・被 ${nameOf(room, entry.response.by)} 以「${cardName(entry.response.card)}」響應${entry.canceled ? '，被抵銷' : ''}` : '';
  const answered = entry.response ? stealText(room, ctx.cardData?.index.actions.get(entry.response.card), entry.by) : '';
  return `${nameOf(room, entry.by)} 打出「${name}」${level}${target}${stolen}${chain}${answer}${answered}`;
}

// 出牌紀錄，舊的在前。
export function playEntries(game) {
  return Object.values(game?.log ?? {}).sort((a, b) => a.at - b.at);
}

// ---- 倒數 ----

const clocks = new Map(); // 局號 → { key: '回合:第幾位', since }：白晝每人的提醒倒數從這台裝置看到輪到他時算起
const wakeups = new Map(); // 黃昏與黑夜的截止時間 → 到時重畫一次的計時器（送出鈕、提前揭曉鈕要跟著停用）

export function resetTimers() {
  for (const { timer } of wakeups.values()) clearTimeout(timer);
  wakeups.clear();
  clocks.clear();
}

export function daySeconds() {
  return ctx.cardData?.data.settings.reminderSeconds.day ?? 60;
}

// 白晝每人的提醒倒數（只顯示，不會自動換人）：從這台裝置看到輪到這個人的那一刻算起。table 是局號（兩場的第 1 回合分開算）。
// 回傳開始的時間。
export function turnSince(table, round, index) {
  const key = `${round}:${index}`;
  if (clocks.get(table)?.key !== key) clocks.set(table, { key, since: Date.now() });
  return clocks.get(table).since;
}

// 照伺服器時間算到 deadline 還有幾秒（主持端判斷用的也是伺服器時間）；本機估的伺服器時間差個幾毫秒時，顯示的秒數不超過 seconds。
export function secondsLeft(deadline, seconds) {
  return Math.min(Number(seconds), Math.ceil((Number(deadline) - serverTime(ctx.session)) / 1000));
}

function showWindowLine(node) {
  const left = secondsLeft(node.dataset.deadline, node.dataset.seconds);
  node.textContent = left > 0 ? `${node.dataset.before}${left}${node.dataset.after}` : node.dataset.over;
}

// ---- 倒數圈：照伺服器時間（data-deadline）或從這台裝置開始算（data-since）；秒數與圈一起每 250 毫秒更新 ----

// deadline＝伺服器時間的截止；since＝本機開始時間（白晝提醒）。total 是總秒數，label 是圈裡的小字。big＝揭曉用的大數字倒數圈
// （數字每秒輕輕放大回彈一次；系統設了減少動態效果時不動）。
export function ring({ deadline = null, since = null, total, label, overText = '到', big = false }) {
  const node = h(
    'div',
    { class: `ring${big ? ' is-big' : ''}`, attrs: { role: 'img' }, data: { total, label, over: overText, ...(deadline !== null ? { deadline } : { since }) } },
    svgRing(),
    h('span', { class: 'ring-num' }),
    h('span', { class: 'ring-label', text: label }),
  );
  showRing(node);
  return node;
}

function svgRing() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('aria-hidden', 'true');
  for (const className of ['ring-track', 'ring-bar']) {
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('class', className);
    circle.setAttribute('cx', '20');
    circle.setAttribute('cy', '20');
    circle.setAttribute('r', '16');
    circle.setAttribute('pathLength', '100');
    svg.append(circle);
  }
  return svg;
}

function ringLeft(node) {
  const total = Number(node.dataset.total);
  if (node.dataset.deadline !== undefined) return secondsLeft(node.dataset.deadline, total);
  return total - Math.floor((Date.now() - Number(node.dataset.since)) / 1000);
}

function showRing(node) {
  const total = Number(node.dataset.total);
  const left = ringLeft(node);
  const over = left <= 0;
  node.classList.toggle('is-over', over);
  node.style.setProperty('--p', String(over ? 0 : Math.max(0, Math.min(1, left / total))));
  const num = node.querySelector('.ring-num');
  const text = over ? node.dataset.over : String(left);
  if (num.textContent !== text && num.textContent !== '' && node.classList.contains('is-big')) {
    num.classList.remove('is-tick');
    void num.offsetWidth; // 重新開始放大回彈的動畫
    num.classList.add('is-tick');
  }
  num.textContent = text;
  node.setAttribute('aria-label', over ? `${node.dataset.label}：時間到` : `${node.dataset.label}：剩 ${left} 秒`);
}

setInterval(() => {
  for (const node of document.querySelectorAll('.server-countdown[data-deadline]')) showWindowLine(node);
  for (const node of document.querySelectorAll('.ring[data-total]')) showRing(node);
}, 250);

// 到了伺服器時間 at 時重畫一次（同一個時間只排一次）。
export function rerenderAt(at) {
  if (wakeups.has(at)) return;
  const left = at - serverTime(ctx.session);
  wakeups.set(at, { timer: left > 0 ? setTimeout(rerender, left + 50) : null });
}

// ---- 事件（M7） ----

export function eventOf(id) {
  return ctx.cardData?.index.events?.get(id) ?? null;
}

const TARGET_TEXT = { all: '全體', chosen: '指定一人' };

// 一個效果寫成一句：「全體英鎊 +3」「蒸汽工業大亨抽 1 張」「迷霧 +3」。
export function effectText(effect) {
  if (effect.op === 'fog') return `迷霧 ${effect.amount > 0 ? '+' : ''}${effect.amount}`;
  const who = effect.target === 'role' ? roleName(effect.role) : (TARGET_TEXT[effect.target] ?? effect.target);
  if (effect.op === 'pounds' || effect.op === 'influence') return `${who}${RESOURCE_LABELS[effect.op]} ${effect.amount > 0 ? '+' : ''}${effect.amount}`;
  if (effect.op === 'draw') return `${who}抽 ${effect.amount} 張`;
  if (effect.op === 'discard') return `${who}隨機棄 ${effect.amount} 張`;
  return effect.op;
}

// 一筆事件紀錄的標題：一般事件是「《名稱》（年代）」，迷霧事件是「迷霧越過 30：《名稱》」。
export function eventTitle(entry) {
  const event = eventOf(entry.event);
  const name = event ? `《${event.name}》${event.year ? `（${event.year}）` : ''}` : entry.event ? `事件 ${entry.event}` : '資料裡沒有這個門檻的事件';
  return entry.kind === 'fog' ? `迷霧越過 ${entry.threshold}：${name}` : name;
}

// 一張事件的效果與沒結算的部分（不含標題與牌面文字）：{ effects, problems }。有沒有結算看紀錄的 skipped（結算當時的結果），
// 不看現在的卡牌資料：資料之後改了也不會寫錯。
export function eventOutcome(entry) {
  const event = eventOf(entry.event);
  if (entry.skipped) return { effects: '', problems: [entry.event ? '這張事件的效果還沒做好（todo），沒有結算' : '沒有效果'] };
  if (!event) return { effects: '', problems: ['卡牌資料裡找不到這張事件的內容'] };
  const problems = [];
  const skipped = skippedEventEffects(event);
  if (skipped.length) problems.push(`有 ${skipped.length} 個效果要指定一人，這一版不結算，已略過`);
  return { effects: event.effects.length ? `效果：${event.effects.map(effectText).join('、')}` : '', problems };
}

// 這一回合要一直顯示的事件：日出到白晝結束顯示今天翻到的一般事件；這一回合觸發過的迷霧事件（任何階段）。
export function todaysEvents(game, state) {
  const deck = state.phase === 'sunrise' || state.phase === 'day' ? sunriseEventsOf(game.eventLog, state.round) : [];
  const fog = eventLogList(game.eventLog).filter((entry) => entry.kind === 'fog' && entry.round === state.round);
  return [...deck, ...fog];
}

export const PHASE_SHORT = { sunrise: '日出', day: '白晝', dusk: '黃昏', night: '黑夜' };

// ---- 黃昏（M6） ----

export function billOf(id) {
  return ctx.cardData?.data.bills.find((bill) => bill.id === id) ?? null;
}

export function billTitle(id) {
  const bill = billOf(id);
  return bill ? `《${bill.name}》${bill.year ? `（${bill.year}）` : ''}` : `法案 ${id}`;
}

export function sideText(vote) {
  return vote.side === 'abstain' ? '棄權' : `${SIDE_LABELS[vote.side] ?? vote.side} ${vote.bid}`;
}

export function duskRevealSeconds() {
  return ctx.cardData?.data.settings.duskRevealSeconds ?? 3;
}

// 揭曉倒數照實際：截止時間（revealAt）之後主持端再等緩衝才揭曉（game.js 的 duskSettleAt／nightSettleAt），倒數到那一刻；
// 全員送出後的總秒數＝設定的揭曉秒數＋緩衝。kind 是 'dusk' 或 'night'；at 是 dusk 或 night（有 revealAt）。
export function revealDeadline(kind, at) {
  return kind === 'dusk' ? duskSettleAt(at) : nightSettleAt(at);
}

export function revealTotal(kind) {
  return kind === 'dusk' ? duskRevealSeconds() + DUSK_GRACE_MS / 1000 : nightRules().revealSeconds + NIGHT_GRACE_MS / 1000;
}

// 揭曉後玩家自己的兩句：付了多少（站在結果這一邊的加註）、照結果結算後現在的數字。
export function duskMineTexts(game, result, uid) {
  const vote = result.votes?.[uid];
  const paid = vote && vote.side !== 'abstain' ? vote.bid : 0;
  const seat = game.seats[uid];
  const sided = vote && ((vote.side === 'yes' && result.passed) || (vote.side === 'no' && !result.passed));
  return {
    paid: `你付了 ${paid} 影響力${sided ? '・站在結果這一邊（議會之聲 +1）' : ''}`,
    now: `照「${result.passed ? '通過' : '不通過'}」的效果結算後，你現在：英鎊 ${seat.pounds}・影響力 ${seat.influence}`,
  };
}

// 法案通過／不通過的效果，寫成一句（效果都寫在資料裡；沒有效果寫「沒有效果」）。
export function billEffectText(effects) {
  return effects?.length ? effects.map(effectText).join('、') : '沒有效果';
}

// ---- 黑夜（M8）：豪賭、分贓、睡覺 ----

// 黑夜的數值（資料檔沒寫時用預設值）。
export function nightRules() {
  return nightSettings(ctx.cardData?.data.settings);
}

export function choiceText(pick) {
  return pick.choice === 'gamble' ? `豪賭到第 ${pick.tiers} 層` : (CHOICE_LABELS[pick.choice] ?? pick.choice);
}

export const signed = (amount) => (amount > 0 ? `+${amount}` : `${amount}`);

export function gains(pounds, influence) {
  return [pounds && `${pounds} 英鎊`, influence && `${influence} 影響力`].filter(Boolean).join('＋') || '什麼都沒有';
}

// 豪賭每一層：爆的機率與過關時累積變成多少。{ tier, odds, gain, treasure }，tierTexts() 是同樣內容寫成一句。
export function tierRows() {
  const rules = nightRules();
  return rules.bust.map((bust, index) => ({
    tier: index + 1,
    odds: bust <= 0 ? '不會爆' : bust >= 6 ? '一定爆' : `擲到 ${bust} 以下就爆（${bust}/6）`,
    gain: gains(rules.pounds[index], rules.influence[index]),
    treasure: index === rules.bust.length - 1,
  }));
}

export function tierTexts() {
  return tierRows().map((row) => `第 ${row.tier} 層：${row.odds}，過關累積變成 ${row.gain}${row.treasure ? '（秘寶）' : ''}`);
}

// 一個人的結果：豪賭逐層的點數與過關／爆、拿到多少；分贓拿多少；睡覺。
export function outcomeText(outcome) {
  if (outcome.choice === 'gamble') {
    const rolls = outcome.rolls.map((roll, index) => `第 ${index + 1} 層擲 ${roll}${outcome.bust && index === outcome.rolls.length - 1 ? ' 爆了' : ' 過關'}`).join('、');
    const money = outcome.bust ? (outcome.pounds < 0 ? `付醫藥費 ${-outcome.pounds} 英鎊` : '沒有英鎊付醫藥費') : `拿到 ${gains(outcome.pounds, outcome.influence)}`;
    return `豪賭到第 ${outcome.tiers} 層——${rolls}——${money}`;
  }
  if (outcome.choice === 'split') return `分贓——拿到 ${outcome.pounds} 英鎊、罪孽 +${outcome.sin}`;
  return outcome.missed ? MISSED_TEXT : SLEEP_TEXT;
}

// 黑夜結果分「選了睡覺」與「沒送出」（M11 起結果多記 missed；舊資料沒有 missed 的照選了睡覺顯示）：文字＋符號，不只靠顏色。
export const SLEEP_TEXT = '☾ 選了睡覺';
export const MISSED_TEXT = '— 沒送出（算睡覺）';

// 主持端桌卡的短句：「豪賭 2 層 +20」「豪賭 1 層爆 −2」「分贓 +3・罪 +1」「☾ 選了睡覺」「— 沒送出」。
export function outcomeShort(outcome) {
  if (outcome.choice === 'gamble') {
    if (outcome.bust) return `豪賭 ${outcome.tiers} 層爆${outcome.pounds < 0 ? ` −${-outcome.pounds}` : ''}`;
    return `豪賭 ${outcome.tiers} 層 ${[outcome.pounds && `+${outcome.pounds}`, outcome.influence && `影 +${outcome.influence}`].filter(Boolean).join('・') || '+0'}`;
  }
  if (outcome.choice === 'split') return `分贓 +${outcome.pounds}${outcome.sin ? `・罪 +${outcome.sin}` : ''}`;
  return outcome.missed ? '— 沒送出' : SLEEP_TEXT;
}

// 揭曉後玩家自己的兩句：這一夜的變化、現在的數字。沒有座位或沒有結果是 null。
export function nightMineTexts(game, result, uid) {
  const outcome = result.players?.[uid];
  const seat = game.seats[uid];
  if (!outcome || !seat) return null;
  const sin = outcome.sin ? `・罪孽 +${outcome.sin}` : '';
  return {
    night: `你這一夜：英鎊 ${signed(outcome.pounds)}・影響力 ${signed(outcome.influence)}${sin}`,
    now: `你現在：英鎊 ${seat.pounds}・影響力 ${seat.influence}${seat.sin ? `・罪孽 ${seat.sin}` : ''}`,
  };
}

// ---- 紀錄：玩家端的「紀錄」分頁與主持端每桌的「紀錄」抽屜共用 ----

// 一桌的紀錄項目：出牌紀錄（響應寫在同一筆）、事件紀錄、黃昏與黑夜的結果。每項 { round, phase, at, kind, icon, title, detail }，
// 排序由畫面決定（照回合分段、新的在上）。
const PHASE_ORDER = { sunrise: 0, day: 1, dusk: 2, night: 3 };

export function logItems(room, game) {
  const items = [];
  for (const entry of playEntries(game)) {
    items.push({ round: entry.round, phase: 'day', at: entry.at ?? 0, kind: 'play', icon: entry.response ? '響' : '牌', title: playText(room, entry), detail: '' });
  }
  eventLogList(game.eventLog).forEach((entry, index) => {
    const { effects, problems } = eventOutcome(entry);
    items.push({ round: entry.round, phase: entry.phase ?? 'sunrise', at: index, kind: 'event', icon: entry.kind === 'fog' ? '霧' : '✶', title: entry.kind === 'fog' ? eventTitle(entry) : `今日事件${eventTitle(entry)}`, detail: [effects, ...problems].filter(Boolean).join('；') });
  });
  for (const [round, log] of Object.entries(game.duskLog ?? {})) {
    if (!log?.bill) continue;
    items.push({ round: Number(round), phase: 'dusk', at: 0, kind: 'result', icon: '§', title: `${billTitle(log.bill)}${log.passed ? '通過' : '沒有通過'}`, detail: `贊成 ${log.yes}：反對 ${log.no}` });
  }
  for (const [round, log] of Object.entries(game.nightLog ?? {})) {
    if (!log?.players) continue;
    const lines = seatsInOrder(game.seats).map(([uid]) => `${nameOf(room, uid)}：${log.players[uid] ? outcomeText(log.players[uid]) : SLEEP_TEXT}`);
    items.push({ round: Number(round), phase: 'night', at: 0, kind: 'result', icon: '☾', title: '黑夜揭曉', detail: lines.join('；') });
  }
  return items;
}

// 照回合分段（新的回合在上）、同一回合裡照階段與時間倒排。回傳 [{ round, items }]。
export function logRounds(items) {
  const rounds = [...new Set(items.map((item) => item.round))].sort((a, b) => b - a);
  return rounds.map((round) => ({
    round,
    items: items.filter((item) => item.round === round).sort((a, b) => (PHASE_ORDER[b.phase] ?? 0) - (PHASE_ORDER[a.phase] ?? 0) || b.at - a.at),
  }));
}

// ---- 終局與計分（M9） ----

export function scoreRules() {
  return scoreSettings(ctx.cardData?.data.settings);
}

// 這一回合是不是最後一回合（這一回合黑夜揭曉後按「下一階段」就算分）：原因或 null。玩家畫面的「這是最後一回合」、主持端的
// 「下一階段（算分）」都看它；日落鐘照伺服器時間算。
export function endReasonNow(game, state) {
  if (!game?.seats || !ctx.cardData || state.phase === 'end') return null;
  return shouldEnd({ round: state.round, startedAt: game.startedAt, endAfterRound: game.endAfterRound }, ctx.cardData.data.settings, serverTime(ctx.session));
}

// 日落鐘到點時重畫一次（「這是最後一回合」、按鈕跟著換）。
export function wakeAtSunset(game) {
  if (ctx.cardData && typeof game?.startedAt === 'number') rerenderAt(game.startedAt + scoreRules().sunsetMinutes * MINUTE_MS);
}

// 天命那一項：內容與是否達成（終局時公開）。
export function destinyText(destiny) {
  if (!destiny?.id) return '天命：這一局沒有天命（0 分）';
  const condition = ctx.cardData?.index.destinies.get(destiny.id)?.score.text;
  const state = destiny.done === true ? `達成 +${destiny.points}` : destiny.done === false ? '沒達成 0 分' : `待主持人判定（目前 0 分，達成 +${destiny.points}）`;
  return `天命「${destiny.text}」${condition ? `（${condition}）` : ''}：${state}`;
}

// 一個人的分數明細（每一項怎麼算的），分成 { label, detail, points } 五列。公共成就的分數從存下來的總分推回來（算分那一刻的設定），
// 算式一定對得上存下來的總分。scoreLines() 是同樣內容寫成五句。
export function scoreRows(score) {
  const rules = scoreRules();
  const { assets } = score;
  const earned = score.destiny?.done === true ? score.destiny.points : 0;
  const list = score.achievements ?? [];
  const bonus = score.total - earned - assets.points + score.sinPenalty;
  return [
    { label: '天命', detail: destinyText(score.destiny).replace(/^天命/, ''), points: `+${earned}`, line: destinyText(score.destiny) },
    {
      label: '資產',
      detail: `英鎊 ${assets.pounds} ÷ ${rules.poundsRate} → ${Math.floor(assets.pounds / rules.poundsRate)} 分、影響力 ${assets.influence} ÷ ${rules.influenceRate} → ${Math.floor(assets.influence / rules.influenceRate)} 分（各自捨去），共 ${assets.points} 分`,
      points: `+${assets.points}`,
    },
    { label: '公共成就', detail: list.length ? list.map((key) => `${ACHIEVEMENT_LABELS[key] ?? key} +${bonus / list.length}`).join('、') : '沒有', points: `+${bonus}` },
    { label: '罪孽', detail: `${score.sin} 點 ÷ ${rules.sinPerPenalty} → 扣 ${score.sinPenalty} 分（捨去）`, points: `−${score.sinPenalty}` },
    { label: '總分', detail: `${earned}＋${assets.points}＋${bonus}－${score.sinPenalty}＝${score.total}`, points: `${score.total}` },
  ];
}

// 照名次排好的 [uid, 分數]（同名次照座位）。
export function rankedScores(game) {
  return Object.entries(game.final?.scores ?? {}).sort(([a, x], [b, y]) => x.rank - y.rank || (game.seats[a]?.order ?? 0) - (game.seats[b]?.order ?? 0));
}

// ---- 兩場制（M9） ----

// 第 2 場的階層怎麼傳：第 1 場的整圈座位（包括之後離開、沒勾參加的人）照 game.js 的 rotateSeats 算，方向與空位的規則只在那裡。
// 回傳 uid → { order, role, from }：role 是這個座位第 2 場拿到的階層，from 是交給他的人；「我的角色卡交給誰」＝ from 是我的那一位。
export function handovers(seats1) {
  return new Map(rotateSeats(seats1 ?? {}, Object.keys(seats1 ?? {})).map(({ uid, ...seat }) => [uid, seat]));
}

// 第 table 桌（實體桌號）的兩場合計（game.js 的 combineScores，鍵的順序就是名次順序）；第 2 場還沒算分時是 null。
export function combinedOf(room, table) {
  const first = room?.games?.[matchKey(table)];
  const second = room?.games?.[matchKey(table, MATCH_COUNT)];
  if (!first?.final || !second?.final) return null;
  return combineScores(first.final, second.final, first.seats);
}

// 合計名次有沒有並列。
export function isTied(combined, row) {
  return Object.values(combined).filter((other) => other.rank === row.rank).length > 1;
}

// 兩場合計裡一個人的其中一場（match 是 1 或 2）：「23（第 2 名）」；第 1 場沒有分數、第 2 場沒參加的算 0，寫成文字；
// 第 2 場天命還待判定的加「+?」（判定後跟著變）。
export function matchScoreText(row, final, uid, match) {
  if (match === 1 && row.missingFirst) return '沒有分數（0）';
  if (match !== 1 && row.absent) return '沒參加（0）';
  const total = match === 1 ? row.first : row.second;
  return `${total}${match !== 1 && row.pending ? '+?' : ''}（第 ${final?.scores?.[uid]?.rank} 名）`;
}

export function combinedTotalText(row) {
  return `${row.total}${row.pending ? '+?' : ''}`;
}

// 等著響應的那張牌：「○○ 打出「X」（分類）」。
export function pendingText(room, pending) {
  const action = ctx.cardData?.index.actions.get(pending.card);
  const category = action?.category ? `（${action.category}）` : '';
  return `${nameOf(room, pending.by)} 打出「${cardName(pending.card)}」${category}`;
}

// ---- 共用元件 ----

// 狀態條：kind＝ready（可推進）／wait（等待中）／judge（待判定）／idle（未開始）；icon 是圖示裡的字（✓、…、?、數字）。
export function statusBar({ kind, icon, title, sub, key }) {
  return h(
    'div',
    { class: `status is-${kind}`, data: { key }, attrs: { role: 'status' } },
    h('span', { class: 'status-icon', text: icon, attrs: { 'aria-hidden': 'true' } }),
    h('div', { class: 'status-body' }, h('p', { class: 'status-title', text: title }), sub ? h('p', { class: 'status-sub', text: sub }) : null),
  );
}

// 迷霧值條：0–100、30／60／90 刻度（門檻照設定）；已觸發的刻度酒紅粗體；「34／100」。
export function fogMeter(fog, fired = []) {
  const thresholds = ctx.cardData?.data.settings.fogThresholds ?? FOG_THRESHOLDS;
  const hit = new Set(fired ?? []);
  const value = Math.max(0, Math.min(100, Number(fog) || 0));
  const firedText = [...hit].sort((a, b) => a - b).join('、');
  return h(
    'div',
    { class: 'fog', attrs: { role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': value, 'aria-label': `迷霧值 ${value}／100${firedText ? `，已觸發 ${firedText}` : ''}` } },
    h('div', { class: 'fog-row', attrs: { 'aria-hidden': 'true' } }, h('span', { text: '迷霧值' }), h('span', { class: 'fog-value' }, String(value), h('small', { text: '／100' }))),
    h(
      'div',
      { class: 'fog-track', attrs: { 'aria-hidden': 'true' } },
      h('div', { class: 'fog-fill', style: { width: `${value}%` } }),
      thresholds.map((threshold) => h('span', { class: `fog-mark${hit.has(threshold) ? ' is-hit' : ''}`, style: { left: `${threshold}%` } })),
    ),
    h(
      'div',
      { class: 'fog-labels', attrs: { 'aria-hidden': 'true' } },
      thresholds.map((threshold) => h('span', { class: hit.has(threshold) ? 'is-hit' : '', style: { left: `${threshold}%` }, text: threshold })),
    ),
  );
}

// 齒輪連鎖：4 格方塊＋「目前 N 級（齒輪）」。turn 是這一輪的狀態（plays、gear、level）。
export function chainMeter(turn) {
  const level = turn.plays === 0 || turn.gear === null ? 0 : Math.min(turn.level, 4);
  const text = turn.plays === 0 ? '沒有連鎖' : turn.gear === null ? '上一張沒有齒輪' : `目前 ${turn.level} 級（${turn.gear}）${turn.level >= 4 ? '・最高' : ''}`;
  return h(
    'span',
    { class: 'chain' },
    h('span', { class: 'chain-label', text: '齒輪連鎖' }),
    h('span', { class: 'chain-boxes', attrs: { 'aria-hidden': 'true' } }, [1, 2, 3, 4].map((step) => h('span', { class: `chain-box${step <= level ? ' is-on' : ''}` }))),
    h('span', { class: 'chain-text', text }),
  );
}

// 連線狀態（文字＋圖示）。
export function connPill(connected) {
  return h('span', { class: `conn${connected ? '' : ' is-off'}`, text: connected ? '已連線' : '斷線' });
}

// 羊皮紙卡面。action 是卡牌資料裡的一張牌（沒有就只寫編號）；state：selected（已選）、flag（右上角的字：已選／棄）、
// disabled（不能打）、why（不能打的原因）、tag（按鈕或 div）、data（data-* 屬性）、key。
export function parchmentCard(id, { selected = false, flag = '已選', disabled = false, why = '', tag = 'div', data = {}, key, label, pressed } = {}) {
  const action = ctx.cardData?.index.actions.get(id);
  const classes = ['pcard', selected ? 'is-selected' : '', disabled ? 'is-disabled' : '', action?.kind === 'response' ? 'is-response' : ''].filter(Boolean).join(' ');
  const attrs = tag === 'button' ? { 'aria-pressed': pressed === undefined ? undefined : String(pressed), 'aria-label': label } : {};
  if (!action) {
    return h(tag, { class: classes, data: { ...data, key }, attrs, type: tag === 'button' ? 'button' : undefined }, h('div', { class: 'pcard-frame' }, h('p', { class: 'pcard-name', text: id })));
  }
  const { pounds, influence } = action.cost;
  const cost = [pounds && `${pounds} 英鎊`, influence && `${influence} 影響力`].filter(Boolean).join('＋');
  const head = h(
    'div',
    { class: 'pcard-head' },
    action.kind === 'response' ? h('span', { class: 'pcard-seal', text: '響', attrs: { 'aria-hidden': 'true' } }) : null,
    h('span', { class: 'pcard-kind', text: KIND_LABELS[action.kind] ?? action.kind }),
    action.gear ? h('span', { class: 'pcard-gear', text: `齒輪 ${action.gear}` }) : h('span', { class: 'pcard-nogear', text: '無齒輪' }),
    action.category ? h('span', { class: 'pcard-category', text: action.category }) : null,
    selected ? h('span', { class: 'pcard-flag', text: flag }) : null,
  );
  return h(
    tag,
    { class: classes, data: { ...data, key }, attrs, type: tag === 'button' ? 'button' : undefined, disabled: tag === 'button' && disabled },
    h(
      'div',
      { class: 'pcard-frame' },
      head,
      h('p', { class: 'pcard-name', text: action.name }),
      h('div', { class: 'pcard-rule', attrs: { 'aria-hidden': 'true' } }, h('span')),
      h('p', { class: 'pcard-cost', text: cost ? `成本 ${cost}` : '不用成本' }),
      h('p', { class: 'pcard-text', text: action.text }),
      why ? h('p', { class: 'pcard-why', text: why }) : null,
    ),
  );
}
