// 入座前的安排（只看房間資料，不寫入）：房間在不在、坐哪一桌、放幾個、叫什麼名字。
// 有一項不成立就丟 PlanError，呼叫的一端印出原因就結束，資料庫裡什麼都沒寫。
import { MAX_SEATS, SUGGESTED_SEATS } from '../../play/js/game.js';
import { activeKey, isValidName, isValidTable } from '../../play/js/rules.js';

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
  }
}

// 一桌最多幾人：六個階層各一、不重複（同 game.js 的 checkSeating）。
export function capacityOf(data) {
  return Math.min(MAX_SEATS, data.roles.length);
}

// 加入時選了第 table 桌（實體桌號）的人。
export function playersAt(room, table) {
  return Object.entries(room?.players ?? {}).filter(([, player]) => player?.table === table);
}

// 第 table 桌現在收不收新玩家：這一桌目前這一局還沒開局才收。第 2 場（tables/{n}-2 在）只給第 1 場同桌的人，新來的拿不到座位。
// 回傳不收的原因，收是 null。
export function tableClosed(room, table) {
  const key = activeKey(room, table);
  if (key !== String(table)) return `第 ${table} 桌已經開了第 2 場，第 2 場不收新玩家`;
  if (room?.games?.[key]) return `第 ${table} 桌已經開局，開局後不收新玩家`;
  return null;
}

// 名字：前綴＋編號，跳過房間裡已經有人用的（例如上一次放進來的機器人），要過 joinRoom 的名字檢查（1–12 個字）。
export function pickNames(room, prefix, count) {
  const used = new Set(Object.values(room?.players ?? {}).map((player) => player?.name));
  const names = [];
  for (let number = 1; names.length < count; number += 1) {
    const name = `${prefix}${number}`;
    if (!isValidName(name)) throw new PlanError(`名字「${name}」超過 12 個字，請用短一點的 --name-prefix`);
    if (!used.has(name)) names.push(name);
  }
  return names;
}

// room 是整個房間的資料（watchRoom 讀到的，房間不存在是 null），table、count 是指令列給的（沒給是 null）。
// 回傳 { table, names, notes }：notes 是要印給使用者看的說明（自動選了哪一桌、補幾個、放不下幾個）。
export function planSeats(room, data, { table = null, count = null, prefix }) {
  if (!room?.meta) throw new PlanError('找不到這個房間：房號打錯了，或房間已經不在了');
  const tableCount = room.meta.tableCount;
  const capacity = capacityOf(data);
  const notes = [];
  let chosen = table;
  if (chosen !== null) {
    if (!isValidTable(chosen, tableCount)) throw new PlanError(`這個房間只有 ${tableCount} 桌，--table 請給 1–${tableCount}`);
    const closed = tableClosed(room, chosen);
    if (closed) throw new PlanError(closed);
    if (playersAt(room, chosen).length >= capacity) throw new PlanError(`第 ${chosen} 桌已經坐滿 ${capacity} 人`);
  } else {
    const open = [];
    for (let number = 1; number <= tableCount; number += 1) {
      const seated = playersAt(room, number).length;
      if (!tableClosed(room, number) && seated < capacity) open.push({ number, seated });
    }
    if (open.length === 0) throw new PlanError('這個房間沒有可以加入的桌：每一桌都已經開局或坐滿了');
    open.sort((a, b) => a.seated - b.seated || a.number - b.number);
    chosen = open[0].number;
    notes.push(`沒有指定桌號，選第 ${chosen} 桌（還沒開局、人最少的一桌）`);
  }
  const seated = playersAt(room, chosen).length;
  const free = capacity - seated;
  let wanted = count;
  if (wanted === null) {
    wanted = SUGGESTED_SEATS - seated;
    if (wanted <= 0) throw new PlanError(`第 ${chosen} 桌已經有 ${seated} 人，到了建議的開局人數（${SUGGESTED_SEATS} 人），不用補；要多放請加 --count`);
    notes.push(`第 ${chosen} 桌現在 ${seated} 人，補 ${wanted} 個機器人到建議的開局人數（${SUGGESTED_SEATS} 人）`);
  }
  if (wanted > free) {
    notes.push(`第 ${chosen} 桌已經有 ${seated} 人、一桌最多 ${capacity} 人，只放得下 ${free} 個（要放 ${wanted} 個）`);
    wanted = free;
  }
  return { table: chosen, names: pickNames(room, prefix, wanted), notes };
}
