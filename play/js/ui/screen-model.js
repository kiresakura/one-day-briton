// 投影畫面的純函式：舞台大小與版面、場景與頁數、日落鐘的文字、每桌桌牌要寫什麼、排行與頒獎的頁、素材表與下載進度、
// 素材來源頁要列的內容，以及 screen.js 每秒照做的判斷（背景影片要不要重建、日落鐘聲要不要響）。
// 不碰畫面、不碰資料庫（screen.js 拿這些結果畫），Node 測試直接呼叫。
// cards 是卡牌資料 { data, index }（gamedata.js 讀到並檢查過的；還沒讀到時給 null，名稱就退回編號）。
import {
  clockPaused,
  dayStatus,
  duskStage,
  eventLogList,
  isClock,
  nightStage,
  responseDeadline,
  seatsInOrder,
  sfxToPlay,
  standingsOf,
  sunriseEventsOf,
  sunsetStatus,
  topScores,
} from '../game.js';
import { FOG_MAX, FOG_MIN, FOG_THRESHOLDS, MATCH_COUNT, PHASE_LABELS, SCENE_IDS, SCENE_PAGE_MAX, activeKey, clockOf, matchKey, parseKey } from '../rules.js';

// ---- 舞台與版面 ----

// 兩種舞台（設計時的大小，畫面用 transform: scale() 縮到視窗）：16:9 的 1920×1080，4:3 的 1440×1080（自己的版面，不是 16:9 加黑邊）。
export const STAGES = {
  '16x9': { width: 1920, height: 1080 },
  '4x3': { width: 1440, height: 1080 },
};
// 視窗的寬高比小於這個值就用 4:3 舞台，到這個值以上用 16:9：16:10（1.6）的投影機還是 16:9；800×600 的投影機在按開始投影前的
// 視窗模式（扣掉瀏覽器工具列約 1.56）也還是 4:3，不會縮成字太小的 16:9。
export const LAYOUT_SPLIT = 1.58;

// 視窗大小 → { layout, width, height, scale, left, top }：layout 是 '16x9' 或 '4x3'，width、height 是舞台設計時的大小，
// scale 是縮放比例（取寬、高比較小的那個），left、top 是置中之後舞台左上角的位置（多出來的地方填底色）。
export function stageLayout(viewWidth, viewHeight) {
  const width = Math.max(1, Number(viewWidth) || 0);
  const height = Math.max(1, Number(viewHeight) || 0);
  const layout = width / height < LAYOUT_SPLIT ? '4x3' : '16x9';
  const stage = STAGES[layout];
  const scale = Math.min(width / stage.width, height / stage.height);
  return { layout, width: stage.width, height: stage.height, scale, left: (width - stage.width * scale) / 2, top: (height - stage.height * scale) / 2 };
}

// ---- 網址 ----

// 投影網址的參數：{ code, valid, preview }。code 是整理過的房號（空白去掉、轉大寫），valid＝格式對。
export function projectorParams(search, isRoomCode, normalizeRoomCode) {
  const params = new URLSearchParams(search);
  const code = normalizeRoomCode(params.get('room') ?? '');
  return { code, valid: isRoomCode(code), preview: params.get('preview') === '1' };
}

// 標題頁的加入方式：網址拿掉 https:// 與參數（「kiresakura.github.io/one-day-briton/play/」）。QR 碼用 full；base 是不帶參數的
// 網址（素材來源頁接在後面）。參數只留 env=emu：在區網用模擬器（不是本機的位址）時手機才會連到同一個模擬器，不會跑去正式站。
export function joinAddress(location) {
  const path = String(location?.pathname ?? '/').replace(/index\.html$/, '');
  const host = String(location?.host ?? '');
  const base = `${host}${path}`;
  const query = new URLSearchParams(location?.search ?? '').get('env') === 'emu' ? '?env=emu' : '';
  return { text: `${base}${query}`, full: `${location?.protocol ?? 'https:'}//${base}${query}`, base };
}

// ---- 時間 ----

// 剩餘毫秒 → 「33:52」；一小時以上「1:15:00」。不到一秒的部分一律進位（剩 0.2 秒還寫 0:01，到 0 才寫 0:00）。
export function clockText(ms) {
  const total = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

// 伺服器時間 stamp → 本機的「18:44」。offset＝伺服器時間 − 本機時間。
export function wallClock(stamp, offset = 0) {
  if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return '';
  const date = new Date(stamp - offset);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// ---- 場景 ----

// display/scene → { id, page, seq }。沒有、或場景不認得時是標題頁（opening，seq 0）：還沒切過場景時投影先停在標題頁。
export function sceneOf(display) {
  const scene = display?.scene;
  if (!scene || !SCENE_IDS.includes(scene.id)) return { id: 'opening', page: 0, seq: 0 };
  const page = Number.isInteger(scene.page) ? Math.min(SCENE_PAGE_MAX, Math.max(0, scene.page)) : 0;
  return { id: scene.id, page, seq: Number.isInteger(scene.seq) ? scene.seq : 0 };
}

// 分頁場景的頁：page 夾在 0～total−1。
export function pageIndex(page, total) {
  if (total <= 0) return 0;
  return Math.min(total - 1, Math.max(0, Number.isInteger(page) ? page : 0));
}

// 「第 3／11 頁」：index 從 0 起算。
export function pageText(index, total) {
  return `第 ${index + 1}／${total} 頁`;
}

// 規則說明的頁：第 1 頁是「日出 → 白晝 → 黃昏 → 黑夜」的流程圖，之後一則教學提示一頁（tutorial.json 的順序）。
export function rulesPages(cards) {
  const tips = (cards?.data?.tutorial ?? []).filter((tip) => tip && typeof tip.text === 'string');
  return [{ kind: 'flow' }, ...tips.map((tip, index) => ({ kind: 'tip', id: tip.id, phase: tip.phase, text: tip.text, number: index + 1, count: tips.length }))];
}

// 頒獎的頁：第 0 頁「頒獎典禮」、已結束的桌每桌一頁冠軍（同分並列就一起）、「全場最高分」、最後是「素材來源」。
// 比賽中、沒開局的桌沒有頁（排行與頒獎只顯示已結束的桌）。
export function awardPages(room) {
  const pages = [{ kind: 'title' }];
  for (let table = 1; table <= tableCountOf(room); table += 1) {
    const standing = standingsOf(room, table);
    if (standing?.status !== 'ended') continue;
    const winners = standing.rows.filter((row) => row.rank === 1).map((row) => ({ ...row, name: nameOf(room, row.uid), role: championRole(room, table, row.uid, standing.basis) }));
    pages.push({ kind: 'champion', table, basis: standing.basis, winners });
  }
  const top = topScores(room);
  pages.push({ kind: 'top', top: top ? { ...top, winners: top.winners.map((winner) => ({ ...winner, name: nameOf(room, winner.uid) })) } : null });
  pages.push({ kind: 'credits' });
  return pages;
}

// 場景的總頁數（規則、頒獎；其他場景是 1）：控制台的上一頁、下一頁可以用這個決定到頭了沒。
export function scenePageCount(id, room, cards) {
  if (id === 'rules') return rulesPages(cards).length;
  if (id === 'awards') return awardPages(room).length;
  return 1;
}

// 冠軍的階層徽章：兩場合計看第 2 場的座位（沒有就第 1 場），只打完第 1 場看第 1 場。
function championRole(room, table, uid, basis) {
  const second = room?.games?.[matchKey(table, MATCH_COUNT)]?.seats?.[uid]?.role;
  const first = room?.games?.[matchKey(table)]?.seats?.[uid]?.role;
  return (basis === 'combined' ? (second ?? first) : first) ?? null;
}

// ---- 名稱 ----

const tableCountOf = (room) => room?.meta?.tableCount ?? 0;

// 投影上的暱稱：已經離開房間的人照樣有座位與分數。
export function nameOf(room, uid) {
  return room?.players?.[uid]?.name ?? '（已離開房間）';
}

function actionName(cards, id) {
  return cards?.index?.actions?.get(id)?.name ?? id;
}

function eventName(cards, id) {
  return cards?.index?.events?.get(id)?.name ?? (id ? `事件 ${id}` : '迷霧事件');
}

function billName(cards, id) {
  return cards?.data?.bills?.find((bill) => bill.id === id)?.name ?? `法案 ${id}`;
}

// 名字清單：「小明、小美」。
function names(room, uids) {
  return uids.map((uid) => nameOf(room, uid)).join('、');
}

// ---- 比賽中總覽 ----

const PHASE_LATIN = { sunrise: 'DAWN', day: 'DAY', dusk: 'DUSK', night: 'NIGHT', end: 'FINALE' };
const PHASE_TONE = { sunrise: 'dawn', day: 'day', dusk: 'dusk', night: 'night', end: 'end' };

// 總覽頂部的鐘照哪一場：有桌開打第 2 場（或第 2 場的全場鐘已經開了）就是第 2 場，不然第 1 場。
export function headerMatch(room) {
  if (isClock(room?.clock?.[MATCH_COUNT])) return MATCH_COUNT;
  for (let table = 1; table <= tableCountOf(room); table += 1) if (room?.games?.[matchKey(table, MATCH_COUNT)]) return MATCH_COUNT;
  return 1;
}

// 總覽頂部：{ match, global, status, startedAt }。那一場有全場鐘時 global＝true、status 是 sunsetStatus（剩餘、暫停、日落了沒…），
// startedAt 是開鐘的伺服器時間；沒有全場鐘時 global＝false、status＝null（改成每張桌牌各自顯示）。
export function headerClock(room, settings, now) {
  const match = headerMatch(room);
  const clock = room?.clock?.[match];
  if (!isClock(clock)) return { match, global: false, status: null, startedAt: null };
  return { match, global: true, status: sunsetStatus(null, settings, now, clock), startedAt: clock.startedAt ?? null };
}

// 頂部的鐘：{ big, label, sub }。big 是大字（剩餘或「暫停」「日落」），label 是上面一行。
export function headerClockText(header) {
  if (!header.global) return { label: '日落鐘', big: '各桌計時', sub: '每桌從按「開始」起算，時間寫在各桌桌牌上' };
  const { status } = header;
  if (status.passed) return { label: '日落鐘', big: '日落', sub: '這一回合結束後算分' };
  if (status.paused) return { label: '日落鐘・暫停', big: clockText(status.remaining), sub: '暫停中，時間不會走' };
  return { label: '距離日落', big: clockText(status.remaining), sub: '' };
}

// 地平線進度條的位置（0–1）：已進行／總長。
export function horizonProgress(status) {
  if (!status || !(status.length > 0)) return 0;
  return Math.min(1, Math.max(0, status.elapsed / status.length));
}

// 一桌桌牌的內容。room 是整個房間，table 是實體桌號，cards 是卡牌資料，now 是伺服器時間；header 是 headerClock 的結果
// （桌牌要不要自己顯示日落鐘：那一場沒有全場鐘、或這桌跟頂部不是同一場時才顯示）。回傳
// { key, table, match, tone, band, latin, art, kicker, name, status, seal, dots, countdown, fog, clock }：
//   band「第 3 回合・黃昏」、latin「DUSK」；art { kind: events｜bills｜roles, id } 或 null；kicker 是名稱上面那行小字，
//   name 是事件或法案的名稱；status 是狀態那一行；seal 是法案揭曉的封蠟章（'通過'／'否決'）；dots { sent, total } 是送出的人數點；
//   countdown 是響應倒數的截止（伺服器時間）與總秒數；fog { value, fired, thresholds }；clock 是這桌自己的日落鐘（sunsetStatus）或 null。
export function tableCard(room, table, cards, now, header = null) {
  const key = activeKey(room, table);
  const { match } = parseKey(key);
  const state = room?.tables?.[key] ?? null;
  const game = room?.games?.[key] ?? null;
  const settings = cards?.data?.settings ?? null;
  const base = { key, table, match, tone: 'idle', band: '', latin: '', art: null, kicker: '', name: '', status: '', seal: null, dots: null, countdown: null, fog: null, clock: null, flash: null };
  const thresholds = settings?.fogThresholds ?? FOG_THRESHOLDS;
  const seated = Object.values(room?.players ?? {})
    .filter((player) => player?.table === table)
    .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0));
  const players = seated.length;

  if (!game || !state) {
    if (match === MATCH_COUNT) {
      const first = room?.games?.[matchKey(table)];
      const leaders = first?.final ? Object.entries(first.final.scores ?? {}).filter(([, score]) => score.rank === 1).map(([uid]) => uid) : [];
      return {
        ...base,
        tone: 'end',
        band: `${matchLabel(2)}準備中`,
        latin: 'INTERVAL',
        kicker: `${matchLabel(1)}第 1 名`,
        name: leaders.length ? names(room, leaders) : '—',
        status: `${matchLabel(2)}準備中・交接角色卡`,
      };
    }
    const list = seated.map((player) => player.name).join('、');
    return { ...base, band: '等待開局', latin: 'WAITING', kicker: '入座名單', name: list || '還沒有人加入', status: `等玩家加入・已加入 ${players} 人` };
  }

  const tone = PHASE_TONE[state.phase] ?? 'day';
  const fog = { value: Math.min(FOG_MAX, Math.max(FOG_MIN, Number(state.fog) || 0)), fired: Array.isArray(game.fogFired) ? game.fogFired : Object.values(game.fogFired ?? {}), thresholds };
  const round = state.round;
  // 這桌跟頂部不是同一場時（有桌已經開打第 2 場、這桌還在第 1 場），色帶上多寫是第幾場。
  const otherMatch = header !== null && header.match !== match;
  const band = `${otherMatch ? `${matchLabel(match)}・` : ''}第 ${round} 回合・${PHASE_LABELS[state.phase] ?? ''}`;
  const card = { ...base, tone, latin: PHASE_LATIN[state.phase] ?? '', band, fog };
  const showClock = !header?.global || otherMatch;
  if (state.phase !== 'end' && showClock && settings) card.clock = sunsetStatus(game, settings, now, clockOf(room, key));

  if (state.phase === 'end') {
    const standing = standingsOf(room, table);
    const leaders = (standing?.rows ?? []).filter((row) => row.rank === 1).map((row) => row.uid);
    const firstRole = leaders.length === 1 ? (game.seats?.[leaders[0]]?.role ?? null) : null;
    const combined = match === MATCH_COUNT && standing?.basis === 'combined';
    // 名字只寫在名稱那一行（最多 3 行，兩個 12 字的並列冠軍也排得下）；狀態那一行寫第 1 名的分數，同分寫幾人並列。
    const top = (standing?.rows ?? []).find((row) => row.rank === 1) ?? null;
    const score = top ? `${top.total} 分${leaders.length > 1 ? `・${leaders.length} 人並列` : ''}` : '—';
    return {
      ...card,
      band: `${matchLabel(match)}結束`,
      art: firstRole ? { kind: 'roles', id: firstRole } : null,
      kicker: combined ? '兩場合計第 1 名' : `${matchLabel(match)}第 1 名`,
      name: leaders.length ? names(room, leaders) : '—',
      status: combined ? `兩場合計 ${score}` : `${matchLabel(match)}結束・第 1 名 ${score}`,
      fog: null,
    };
  }

  // 中間的圖與名稱：這一回合觸發過的迷霧事件優先（最新的一張），日出、白晝是今日事件，黃昏是法案，黑夜是這一回合的法案。
  const fogToday = eventLogList(game.eventLog).filter((entry) => entry.kind === 'fog' && entry.round === round);
  const deckToday = sunriseEventsOf(game.eventLog, round);
  const bill = game.dusk && game.dusk.round === round ? game.dusk.bill : null;
  const lastFog = fogToday[fogToday.length - 1] ?? null;
  if (state.phase === 'dusk' && bill) Object.assign(card, { art: { kind: 'bills', id: bill }, kicker: '本回合法案', name: `《${billName(cards, bill)}》` });
  else if (lastFog) Object.assign(card, { art: lastFog.event ? { kind: 'events', id: lastFog.event } : null, kicker: `迷霧事件・越過 ${lastFog.threshold}`, name: `〈${eventName(cards, lastFog.event)}〉` });
  else if ((state.phase === 'sunrise' || state.phase === 'day') && deckToday.length) {
    const entry = deckToday[deckToday.length - 1];
    Object.assign(card, { art: { kind: 'events', id: entry.event }, kicker: '今日事件', name: `〈${eventName(cards, entry.event)}〉` });
  } else if (bill) Object.assign(card, { art: { kind: 'bills', id: bill }, kicker: '本回合法案', name: `《${billName(cards, bill)}》` });
  else if (deckToday.length) {
    const entry = deckToday[deckToday.length - 1];
    Object.assign(card, { art: { kind: 'events', id: entry.event }, kicker: '今日事件', name: `〈${eventName(cards, entry.event)}〉` });
  } else Object.assign(card, { kicker: `第 ${round} 回合`, name: PHASE_LABELS[state.phase] ?? '' });

  const seats = Object.keys(game.seats ?? {}).length;
  if (state.phase === 'sunrise') {
    const dealt = (room?.deals?.[key] ?? 0) >= round;
    card.status = dealt ? '日出・薪水與抽牌已發' : '日出・發牌中…';
  } else if (state.phase === 'day') {
    if (game.pending) {
      card.status = `${nameOf(room, game.pending.by)} 打出〈${actionName(cards, game.pending.card)}〉・響應倒數`;
      card.countdown = { deadline: responseDeadline(game.pending), seconds: game.pending.seconds };
    } else {
      const day = dayStatus(game, round);
      card.status = day.done ? '白晝出完了・準備進入黃昏' : `▶ 輪到 ${nameOf(room, day.current)} 出牌・這一輪 ${day.turn.plays} 張`;
    }
  } else if (state.phase === 'dusk') {
    const stage = duskStage(game.dusk, round);
    const sent = game.dusk?.submitted ?? 0;
    if (stage === 'none') card.status = '翻開法案中…';
    else if (stage === 'adjourned') card.status = '今天議會休會・法案都通過了';
    else if (stage === 'revealed') {
      const { result } = game.dusk;
      card.status = `法案${result.passed ? '通過' : '沒有通過'}・贊成 ${result.yes}：反對 ${result.no}`;
      card.seal = result.passed ? '通過' : '否決';
    } else {
      card.status = stage === 'voting' ? `表決中・已送出 ${sent}／${seats}` : `已送出 ${sent}／${seats}・倒數揭曉`;
      card.dots = { sent, total: seats };
    }
  } else if (state.phase === 'night') {
    const stage = nightStage(game.night, round);
    const sent = game.night?.submitted ?? 0;
    if (stage === 'none') card.status = '黑夜開始中…';
    else if (stage === 'revealed') {
      const counts = nightCounts(game);
      card.status = `黑夜揭曉：${counts.gamble} 人豪賭・${counts.split} 人分贓・${counts.sleep} 人睡覺`;
    } else {
      card.status = stage === 'choosing' ? `選擇中・已送出 ${sent}／${seats}` : `已送出 ${sent}／${seats}・倒數揭曉`;
      card.dots = { sent, total: seats };
    }
  }
  return card;
}

function matchLabel(match) {
  return `第 ${match} 場`;
}

// 黑夜揭曉的人數：豪賭、分贓、睡覺（沒送出的算睡覺）。
export function nightCounts(game) {
  const counts = { gamble: 0, split: 0, sleep: 0 };
  const players = game?.night?.result?.players ?? {};
  for (const [uid] of seatsInOrder(game?.seats ?? {})) {
    const choice = players[uid]?.choice;
    counts[choice === 'gamble' || choice === 'split' ? choice : 'sleep'] += 1;
  }
  return counts;
}

// 這一桌的迷霧事件紀錄（照順序）：[{ index, threshold, event, round }]。投影端記住看過幾筆，多出來的就是剛越過門檻。
export function fogEntries(game) {
  return eventLogList(game?.eventLog)
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => entry.kind === 'fog')
    .map(({ index, threshold, event, round }) => ({ index, threshold, event: event ?? null, round }));
}

// 迷霧事件閃一下時桌牌上的那一句：「迷霧越過 60：〈黃霧籠城〉」。
export function fogFlashText(entry, cards) {
  return `迷霧越過 ${entry.threshold}：〈${eventName(cards, entry.event)}〉`;
}

// 投影上「第 1 場・比賽中」那一句：照頂部那一場；所有桌都結束時寫「已結束」，都沒開局寫「等待開局」。
export function matchLine(room, match) {
  let started = 0;
  let ended = 0;
  for (let table = 1; table <= tableCountOf(room); table += 1) {
    const key = match === 1 ? matchKey(table) : matchKey(table, MATCH_COUNT);
    if (!room?.games?.[key]) continue;
    started += 1;
    if (room.tables?.[key]?.phase === 'end') ended += 1;
  }
  if (started === 0) return `${matchLabel(match)}・等待開局`;
  return `${matchLabel(match)}・${ended === started ? '已結束' : '比賽中'}`;
}

// ---- 日落自動響鐘 ----

// 這一秒的日落鐘：{ ring, mark }。ring 是要響鐘的場次，mark 是要記成「響過」的鐘（bellKey）。走著的鐘（鐘本身不是暫停中）
// 已經日落、而且這一場還沒響過才算；seen 是這台已經處理過的鐘（Set）。paused＝全場暫停中（display/pause）：到點的先不響也不記，
// 恢復後第一秒補響一次（全場暫停不一定停鐘，快日落的鐘照走），每場只響一次。
// 投影端第一次讀到房間時已經日落的鐘不響（不補），由呼叫端先把它們放進 seen（passedClocks）。
export function bellsDue(room, now, seen, paused = false) {
  const ring = [];
  const mark = [];
  for (let match = 1; match <= MATCH_COUNT; match += 1) {
    const clock = room?.clock?.[match];
    if (!isClock(clock) || clockPaused(clock) || seen.has(bellKey(match, clock))) continue;
    if (clock.anchor + clock.remain > now || paused) continue;
    ring.push(match);
    mark.push(bellKey(match, clock));
  }
  return { ring, mark };
}

// 一個鐘的識別：同一間房同一場只會開一次鐘（開了之後不能刪、startedAt 不能改），所以場次＋開鐘時間就夠了。
export function bellKey(match, clock) {
  return `${match}:${clock?.startedAt ?? ''}`;
}

// 每秒的日落鐘聲（screen.js 的 tick 照做）：{ ring, mark }。seen 是這台的 { primed, bells }（bells 是響過的鐘，Set）：
// 第一次讀到房間（primed 還是 false）時已經日落的鐘先記成響過、不補；之後照 bellsDue，全場暫停（display/pause）中到點的
// 先不響，恢復後第一秒補響。audible＝聲音開著、不是預覽框：不能出聲時 ring 是空的，mark 照樣記（之後開了聲音也不補）。
export function bellTick(room, now, seen, audible) {
  const passed = seen.primed ? [] : passedClocks(room, now);
  const due = bellsDue(room, now, new Set([...seen.bells, ...passed]), room?.display?.pause?.on === true);
  return { ring: audible ? due.ring : [], mark: [...passed, ...due.mark] };
}

// 已經日落的鐘（第一次讀到房間時用：這些不補響）。
export function passedClocks(room, now) {
  const keys = [];
  for (let match = 1; match <= MATCH_COUNT; match += 1) {
    const clock = room?.clock?.[match];
    if (isClock(clock) && clock.remain - ((clockPaused(clock) ? clock.pausedAt : now) - clock.anchor) <= 0) keys.push(bellKey(match, clock));
  }
  return keys;
}

// ---- 房間變了：音效、開場影片 ----

// 主持端按的音效（display/sfx）這一次要不要播：{ seen, play }。seq 跟看過的不一樣才處理：播不播都把 seen 記成比較新的 seq
// （斷線重連、重新整理後不補放）；聲音開著（audible）、seq 比看過的新、而且是 5 秒內按的（sfxToPlay）才播，play 是音效 id，不播是 null。
export function sfxStep(sfx, seen, now, audible) {
  if (!sfx || !Number.isInteger(sfx.seq) || sfx.seq === seen) return { seen, play: null };
  return { seen: Math.max(seen ?? 0, sfx.seq), play: audible && sfxToPlay(sfx, seen, now) ? sfx.id : null };
}

// 開場影片這一次要不要播：{ seen, play }。seen 是看過的 display/scene seq（null＝還沒讀到過房間）。第一次讀到的場景只記下來、
// 不播（重新整理不重播）；之後 seq 變了、換成開場、而且這台可以播（canPlay：按過開始投影、不是預覽框）才播。不能播時也記下 seq，
// 之後才按開始投影不會補播。
export function openingStep(scene, seen, canPlay) {
  if (seen === null || seen === undefined) return { seen: scene.seq, play: false };
  if (scene.seq === seen) return { seen, play: false };
  return { seen: scene.seq, play: scene.id === 'opening' && canPlay };
}

// ---- 兩場合計排行 ----

// 每桌一欄：{ table, status, basis, rows }。rows 是前三名（同分並列時可能多於 3 人，最多列 5 人，其餘寫在 more），
// 每列 { rank, name, total, first, second }。status：ended、playing（比賽中）、idle（還沒開局）。
export function standingsView(room) {
  const columns = [];
  for (let table = 1; table <= tableCountOf(room); table += 1) {
    const standing = standingsOf(room, table);
    if (!standing) continue;
    const top = standing.rows.filter((row) => row.rank <= 3);
    const shown = top.slice(0, 5).map((row) => ({ rank: row.rank, name: nameOf(room, row.uid), total: row.total, first: row.first ?? null, second: row.second ?? null }));
    columns.push({ table, status: standing.status, basis: standing.basis, match: standing.match, rows: shown, more: top.length - shown.length });
  }
  return columns;
}

// ---- 素材 ----

// 投影端才會載的素材（play/media/，只有投影畫面引用；手機與主持端不會請求）。credits.json 是素材清單，也是來源，最先讀（見 mediaFilesIn）。
// 檔不存在或下載失敗就用佔位：
// 開場影片 → 終局場景圖慢慢放大；背景影片 → 場景圖；鐘聲、槌聲、開場音樂 → 網頁當場合成；底圖 → 場景圖。
// limit 是素材規格（SPEC 4.6）的大小上限（位元組），給素材檢查用；投影端不擋，超過的照樣下載、照樣用。
export const MEDIA = [
  { id: 'credits', file: 'credits.json', kind: 'json', use: '影音素材清單與來源', limit: 200_000 },
  { id: 'opening', file: 'opening.mp4', kind: 'video', use: '開場影片', limit: 20_000_000 },
  { id: 'loop-1', file: 'loop-1.mp4', kind: 'video', use: '背景影片 1', limit: 6_000_000 },
  { id: 'loop-2', file: 'loop-2.mp4', kind: 'video', use: '背景影片 2', limit: 6_000_000 },
  { id: 'loop-3', file: 'loop-3.mp4', kind: 'video', use: '背景影片 3', limit: 6_000_000 },
  { id: 'bell', file: 'bell.mp3', kind: 'audio', use: '日落大鐘', limit: 200_000 },
  { id: 'gavel', file: 'gavel.mp3', kind: 'audio', use: '法槌', limit: 100_000 },
  { id: 'music-opening', file: 'music-opening.mp3', kind: 'audio', use: '開場音樂', limit: 4_000_000 },
  { id: 'bg-title', file: 'bg-title.webp', kind: 'image', use: '標題頁底圖', limit: 400_000 },
  { id: 'bg-rules', file: 'bg-rules.webp', kind: 'image', use: '規則頁底圖', limit: 400_000 },
];

// 各場景的背景影片（MEDIA 的 id）：標題頁、規則說明、排行、頒獎有；總覽與其他沒有（null）。
const LOOPS = { opening: 'loop-1', rules: 'loop-2', standings: 'loop-3', awards: 'loop-3' };

export function loopFor(sceneId) {
  return LOOPS[sceneId] ?? null;
}

// 背景影片這一畫怎麼做（screen.js 的 updateLoop 照做）：{ key, rebuild }。sceneId 是目前的場景（還沒讀到房間、房號不對時 null），
// url 是這個場景背景影片的網址（場景沒有背景影片、素材沒下載好時 null），openingIsVideo＝開場影片正在播（蓋著時先不放背景影片）。
// key 是（場景, 網址），不放時是空字串；rebuild＝key 跟上一次（prevKey）不同：拆掉舊的，key 不是空的就建一支新的。
// key 一樣就照舊、不重建（重建會從頭重播，房間每次更新都重建的話背景影片一直重來）。
export function loopStep(prevKey, sceneId, url, openingIsVideo) {
  const key = sceneId && url && !openingIsVideo ? `${sceneId} ${url}` : '';
  return { key, rebuild: key !== prevKey };
}

// 影音素材的清單：play/media/credits.json（素材來源，每筆的 files 列出檔名與大小，格式同 play/assets/credits.json）。
// 投影端先讀它，只下載裡面列到、而且在 MEDIA 表上的檔，其他的直接用佔位（不去要不存在的檔）。回傳 Map(檔名 → 位元組數或 null)；
// 清單裡完全沒有檔名時回傳 null（呼叫端就逐一試 MEDIA 表上的檔）。
export function mediaFilesIn(list) {
  const files = new Map();
  const add = (path, bytes) => {
    if (typeof path !== 'string' || !path) return;
    const name = path.split('/').pop();
    files.set(name, Number.isFinite(bytes) ? bytes : null);
  };
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry !== 'object') continue;
    for (const file of Array.isArray(entry.files) ? entry.files : []) {
      if (typeof file === 'string') add(file, null);
      else if (file && typeof file === 'object') add(file.path ?? file.file, file.bytes);
    }
    add(entry.file, entry.bytes);
  }
  return files.size ? files : null;
}

// 下載的狀態分成幾堆（items 的子集）：loading（排隊或下載中）、ready、placeholder（其他，都用佔位），placeholder 裡下載失敗的
// 再分 retrying（retry 是 'pending'：等著重下）與 gaveUp（'gave-up'：重試也都失敗了）。
export function mediaStates(items) {
  const out = { loading: [], ready: [], placeholder: [], retrying: [], gaveUp: [] };
  for (const item of items) {
    const state = item?.status;
    if (state === 'waiting' || state === 'loading') out.loading.push(item);
    else if (state === 'ready') out.ready.push(item);
    else {
      out.placeholder.push(item);
      if (state === 'failed' && item.retry === 'pending') out.retrying.push(item);
      if (state === 'failed' && item.retry === 'gave-up') out.gaveUp.push(item);
    }
  }
  return out;
}

// 下載的狀態 → 開始投影頁與角落的那一行。items 是 [{ status: waiting｜loading｜ready｜missing｜failed, loaded, total, retry, list }]，
// list 為真的那一筆是素材清單（credits.json）。有下載失敗的（重試中或已放棄）時，下載中也寫「n 個用佔位（重試中）」。
// 素材清單下載失敗時其他素材都還沒開始（等清單重下）或不會下載（放棄了），整行只寫清單：「素材清單下載失敗・先用佔位（重試中）」。
export function mediaProgressText(items, started) {
  if (!started) return '按「開始投影」後才下載影片與音效';
  const list = items.find((item) => item?.list);
  if (list?.status === 'failed' && list.retry) return `素材清單下載失敗・先用佔位（${list.retry === 'gave-up' ? '已放棄' : '重試中'}）`;
  const { loading, ready, placeholder, retrying, gaveUp } = mediaStates(items);
  const loaded = items.reduce((sum, item) => sum + (item.loaded ?? 0), 0);
  const total = items.reduce((sum, item) => sum + (item.total ?? item.loaded ?? 0), 0);
  const failed = retrying.length + gaveUp.length > 0;
  const count = (n, text) => (n === placeholder.length ? text : `${n} 個${text}`);
  const why = [retrying.length ? count(retrying.length, '重試中') : '', gaveUp.length ? count(gaveUp.length, '已放棄') : ''].filter(Boolean).join('、');
  const note = placeholder.length ? `・${placeholder.length} 個用佔位${why ? `（${why}）` : ''}` : '';
  if (loading.length) return `素材下載中 ${megabytes(loaded)}／${megabytes(Math.max(total, loaded))} MB${failed ? note : ''}`;
  if (ready.length === 0 && !failed) return '還沒有影音素材，先用佔位（畫面與合成音效）';
  return `素材已下載 ${megabytes(loaded)} MB${note}`;
}

// 角落要不要一直寫素材的狀態：有下載失敗的（重試中或已放棄）就一直寫，不只下載完的那 10 秒。
export function mediaTrouble(items) {
  const { retrying, gaveUp } = mediaStates(items);
  return retrying.length + gaveUp.length > 0;
}

// 開場影片這次怎麼播：素材下載好了 'video'；已經開始下載、這個檔還在排隊或下載中 'wait'（先寫進度，下載完再播）；
// 沒有素材、下載失敗、或沒按「開始投影」（不下載）'placeholder'。entry 是 view.media 裡 opening 那一筆，list 是素材清單那一筆：
// 清單下載失敗、正在等重下（或已放棄）時也是 'placeholder'，不等清單重下（清單停住時照樣第 30 秒中止、退佔位）。
export function openingMode(entry, preloading, list = null) {
  if (entry?.status === 'ready' && entry.url) return 'video';
  if (preloading && list?.status !== 'failed' && (entry?.status === 'waiting' || entry?.status === 'loading')) return 'wait';
  return 'placeholder';
}

// 等開場影片下載時蓋在標題頁上的那一句：「開場影片下載中（3.2／18 MB）」；還不知道大小時只寫已下載的。
export function openingWaitText(entry) {
  const loaded = entry?.loaded ?? 0;
  const total = entry?.total ?? 0;
  return total > 0 ? `開場影片下載中（${megabytes(loaded)}／${megabytes(Math.max(total, loaded))} MB）` : `開場影片下載中（${megabytes(loaded)} MB）`;
}

// 下載素材時連續這麼久沒有收到新的位元組（含等伺服器回應）就中止，照下載失敗處理、改用佔位：連線停住但不出錯時，
// 「開場影片下載中」不會一直蓋在標題頁上。
export const MEDIA_STALL_MS = 30_000;

// 下載卡住的計時：建立時開始計時，每收到一段資料呼叫 progress() 重新計時；連續 ms 沒有 progress 就呼叫 onStall（只一次）。
// 下載結束（下完、失敗、不用下載）時呼叫 stop()。計時器用全域的 setTimeout／clearTimeout（測試裡換成 node:test 的 mock timers）。
export function stallWatch(ms, onStall) {
  let timer = null;
  let done = false;
  const arm = () => {
    clearTimeout(timer);
    if (done) return;
    timer = setTimeout(() => {
      done = true;
      onStall();
    }, ms);
  };
  arm();
  return {
    progress: arm,
    stop() {
      done = true;
      clearTimeout(timer);
    },
  };
}

// 下載一個素材（screen.js 的 fetchMedia）：fetchImpl(url, { signal }) 拿回應，check(response) 回 false 就不讀內容（不存在、格式不對），
// 讀的時候每收到一段呼叫 onChunk(chunk)。連續 stallMs 沒有新的位元組（含等回應）就中止：fetchImpl 或讀取丟出的錯照樣往外丟。
// 回傳讀到的所有段落（沒讀時 null）。
export async function download(fetchImpl, url, { check = () => true, onChunk = () => {}, stallMs = MEDIA_STALL_MS } = {}) {
  const abort = new AbortController();
  const watch = stallWatch(stallMs, () => abort.abort());
  try {
    const response = await fetchImpl(url, { signal: abort.signal });
    if (!check(response)) return null;
    return await readStream(response.body.getReader(), watch, onChunk);
  } finally {
    watch.stop();
  }
}

// 把串流讀完：每一段都讓卡住的計時重新開始（watch.progress）、交給 onChunk，最後回傳所有段落。
export async function readStream(reader, watch, onChunk) {
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    watch.progress();
    chunks.push(value);
    onChunk(value);
  }
}

// 下載失敗（含停住被中止、連線中斷）的素材隔多久再下（毫秒）：第 1、2、3 次失敗之後各等這麼久；重試 3 次都失敗就放棄，這一頁都用佔位。
export const MEDIA_RETRY_MS = [5_000, 15_000, 45_000];

// 第 tries 次失敗之後隔多久再下；不再試時回 null。
export function retryDelay(tries) {
  if (!(tries >= 1)) return null;
  if (tries > MEDIA_RETRY_MS.length) return null;
  return MEDIA_RETRY_MS[tries - 1];
}

// 下載到不再失敗為止（screen.js 的 preload 用來下素材清單：清單下好、確定沒有或放棄了才開始下載素材）。fetchOnce() 下載一次、
// 把結果寫進 entry（view.media 裡那一筆）；失敗（status 'failed'：停住被中止、連線中斷、格式不對）就 tries＋1，照 retryDelay
// 用 wait(ms) 等 5／15／45 秒再下，第 3 次重試也失敗就放棄（retry＝'gave-up'）。每次失敗之後呼叫 onFail()（重畫、等著的開場
// 影片退佔位）。沒失敗時清掉 retry。回傳最後的 status。
export async function fetchWithRetries(entry, fetchOnce, { wait, onFail = () => {} }) {
  for (;;) {
    await fetchOnce();
    if (entry.status !== 'failed') {
      entry.retry = null;
      return entry.status;
    }
    entry.tries += 1;
    const delay = retryDelay(entry.tries);
    entry.retry = delay === null ? 'gave-up' : 'pending';
    onFail();
    if (delay === null) return entry.status;
    await wait(delay);
  }
}

// 位元組 → MB（小於 10 留一位小數）。
export function megabytes(bytes) {
  const mb = (Number(bytes) || 0) / 1_000_000;
  return mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
}

// ---- 素材來源頁 ----

// credits.json（圖片；影音素材之後另一份）→ { full: [署名…], others, total }：要署名的（CC BY 等）列出完整署名，其他只算張數。
export function creditsSummary(...lists) {
  const entries = lists.flatMap((list) => (Array.isArray(list) ? list : [])).filter((entry) => entry && typeof entry === 'object');
  const full = entries.filter((entry) => entry.attribution_required === true && entry.attribution).map((entry) => ({ label: entry.label ?? entry.slot ?? '', text: String(entry.attribution) }));
  return { full, others: entries.length - full.length, total: entries.length };
}

// ---- 聲音 ----

// 背景音樂要不要播：display/music 的 on，而且是認得的那一首（opening）。
export function musicOn(display) {
  return display?.music?.on === true && (display.music.track ?? 'opening') === 'opening';
}
