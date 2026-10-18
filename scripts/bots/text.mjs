// 機器人印出來的文字：每個動作一行（時間、機器人、桌／場、回合與階段、動作），以及終局的結算摘要、兩場合計。
import { combineScores, pendingDestinies } from '../../play/js/game.js';
import { MATCH_COUNT, PHASE_LABELS, matchKey, parseKey } from '../../play/js/rules.js';

export const PHASE_TEXT = { ...PHASE_LABELS, end: '終局' };
export const SIDE_TEXT = { yes: '贊成', no: '反對', abstain: '棄權' };
export const CHOICE_TEXT = { gamble: '豪賭', split: '分贓', sleep: '睡覺' };
export const END_REASON_TEXT = { sunset: '日落鐘到了', maxRounds: '到了回合上限', host: '主持端提早收場' };
export const ACHIEVEMENT_TEXT = { parliament: '議會之聲', gear: '齒輪大師' };

const two = (value) => String(value).padStart(2, '0');

export function clockText(date = new Date()) {
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

// 局號 → 「第 1 桌第 1 場」。
export function matchLabel(key) {
  const parsed = parseKey(key);
  return parsed ? `第 ${parsed.table} 桌第 ${parsed.match} 場` : `第 ${key} 桌`;
}

// 一行：「20:31:05 機器人2｜第 1 桌第 1 場｜第 3 回合・白晝｜出牌 紡織廠加班」。不知道局號、回合或階段時省略那一段。
export function actionLine({ at = new Date(), name, key = null, round = null, phase = null, text }) {
  const parts = [`${clockText(at)} ${name}`];
  if (key !== null) parts.push(matchLabel(key));
  if (phase === 'end') parts.push(PHASE_TEXT.end);
  else if (round !== null && phase !== null) parts.push(`第 ${round} 回合・${PHASE_TEXT[phase] ?? phase}`);
  parts.push(text);
  return parts.join('｜');
}

export function nameOf(room, uid) {
  return room?.players?.[uid]?.name ?? '（已離開房間）';
}

// 資料庫讀回來的陣列可能是數字鍵的物件。
const listOf = (value) => (Array.isArray(value) ? value : Object.values(value ?? {}));

// 有天命還待主持人判定時加在標題後面：那些人的天命分數還沒算進去，總分（與兩場合計）之後會變。
export const PENDING_TEXT = '（天命待判定，總分未定）';

// 一局終局的結算摘要（好幾行）：結束的回合與原因、每個人的名次、總分與組成（照名次排）。
export function finalSummary(room, key, data) {
  const game = room?.games?.[key];
  const final = game?.final;
  if (!final) return [];
  const roleName = new Map(data.roles.map((role) => [role.id, role.name]));
  const pending = pendingDestinies(final.scores).length > 0 ? PENDING_TEXT : '';
  const lines = [`—— ${matchLabel(key)}結算：第 ${final.round} 回合結束（${END_REASON_TEXT[final.reason] ?? final.reason}）——${pending}`];
  const rows = Object.entries(final.scores ?? {}).sort(([, a], [, b]) => a.rank - b.rank);
  for (const [uid, score] of rows) {
    const destiny = score.destiny?.done === true ? `天命達成 +${score.destiny.points ?? 0}` : score.destiny?.done === false ? '天命沒達成' : '天命待判定';
    const parts = [destiny, `資產 ${score.assets?.points ?? 0} 分（英鎊 ${score.assets?.pounds ?? 0}、影響力 ${score.assets?.influence ?? 0}）`];
    const achievements = listOf(score.achievements).map((item) => ACHIEVEMENT_TEXT[item] ?? item);
    if (achievements.length > 0) parts.push(`成就 ${achievements.join('、')}`);
    if (score.sinPenalty) parts.push(`罪孽扣 ${score.sinPenalty}`);
    const role = roleName.get(game.seats?.[uid]?.role);
    lines.push(`  第 ${score.rank} 名 ${nameOf(room, uid)}${role ? `（${role}）` : ''}：${score.total} 分｜${parts.join('、')}`);
  }
  return lines;
}

// 兩場合計（第 2 場終局後）：用 combineScores 算，跟主持端、玩家端畫面同一個結果。table 是實體桌號。
export function combinedSummary(room, table) {
  const first = room?.games?.[matchKey(table)];
  const second = room?.games?.[matchKey(table, MATCH_COUNT)];
  if (!first?.final) return [];
  const combined = combineScores(first.final, second?.final, first.seats);
  const pending = [first.final, second?.final].some((final) => pendingDestinies(final?.scores).length > 0) ? PENDING_TEXT : '';
  const lines = [`—— 第 ${table} 桌兩場合計 ——${pending}`];
  for (const [uid, row] of Object.entries(combined)) {
    const later = row.absent ? '第 2 場沒參加' : `第 2 場 ${row.second}`;
    lines.push(`  第 ${row.rank} 名 ${nameOf(room, uid)}：${row.total} 分（第 1 場 ${row.first}、${later}）`);
  }
  return lines;
}
