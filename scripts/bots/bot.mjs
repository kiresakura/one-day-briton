// 一個機器人玩家：照玩家端的流程入座、訂閱自己看得到的資料，輪到自己（或有事可做）時從規則允許的動作裡隨機挑一個送出。
// 只用 store.js 的玩家端函式（joinRoom、watch…、request…、trackPresence、serverTime、disconnect）；開局、推進、發牌、結算、
// 開第 2 場都是主持端的事，這裡一律不碰。被主持端退回或送不出去時記一行、改送別的或結束這一輪；同一個情況最多送幾次，
// 不會卡住，也不會一直送。
import {
  REJECT_REASONS,
  cryptoRandom,
  dayStatus,
  discardProblem,
  duskStage,
  nightStage,
  overLimit,
  responseDeadline,
  rotateSeats,
  shouldEnd,
} from '../../play/js/game.js';
import { MATCH_COUNT, activeKey, matchKey, parseKey } from '../../play/js/rules.js';
import {
  StoreError,
  disconnect,
  joinRoom,
  requestDiscard,
  requestNight,
  requestPass,
  requestPlay,
  requestRespond,
  requestVote,
  serverTime,
  trackPresence,
  watchDiscard,
  watchNight,
  watchPrivate,
  watchRequest,
  watchRoom,
  watchVote,
} from '../../play/js/store.js';
import { DEFAULT_POLICY, between, chance, chooseDiscard, chooseNight, chooseVote, pickOne, playOptions, responseOptions } from './brain.mjs';
import { CHOICE_TEXT, SIDE_TEXT, actionLine, nameOf } from './text.mjs';

export const DEFAULT_WAIT_MS = 20 * 60_000;
const TICK_MS = 1000; // 沒有新資料時多久重看一次（響應截止、揭曉時間、等太久都靠它）
const MAX_TRIES = 3; // 同一個情況（同一輪的同一個位置、同一回合的票…）最多送幾次
const NOTICE_WAIT_MS = 2000; // 請求處理了、輪次卻沒動（被退回）時，等退回原因多久
const RESEND_MS = 20_000; // 送出的請求這麼久主持端都沒處理，就再送一次
const RESENDS = 2; // 同一個請求最多再送幾次
const RETRY_MS = 2000; // 送不出去之後隔多久再試
const CLOSE_MS = 5000; // 結束時移除上線狀態、斷線各最多等多久

// promise 最多等 ms 毫秒（計時器不留住程式）。
function within(promise, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise).catch(() => {}), late]).finally(() => clearTimeout(timer));
}

// 放一個機器人進房間、開始玩。options：
//   session      connect(slot) 的結果（結束時由這裡斷線）
//   code         房號（整理過的）    name  暱稱    table  實體桌號
//   data         卡牌資料（gamedata.js 讀到、檢查過的；牌名、規則判斷用）
//   delay        [最少, 最多]：每個動作前隨機等多久（毫秒）
//   policy       DEFAULT_POLICY 的覆寫    random  亂數來源（同 game.js）
//   waitMs       房間這麼久沒有任何變動就結束
//   log(text)    印一行
//   onFinal(room, key)   看到一局終局（印結算摘要用；同一局每個機器人都會叫一次，由呼叫的一端去重）
// 先入座（joinRoom，失敗就丟出去），成功後回傳 { uid, done, stop }：done 在結束時 resolve 成 { reason, detail, stats }
// （reason：done 兩場都結束、no-seat 這一局沒有座位、idle 等太久、room-gone、left、stopped、error），stop() 叫它提早結束並等它收好。
export async function startBot(options) {
  const { session, code, name, table, data } = options;
  const policy = { ...DEFAULT_POLICY, ...options.policy };
  const random = options.random ?? cryptoRandom;
  const [minDelay, maxDelay] = options.delay ?? [1500, 4000];
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const print = options.log ?? (() => {});
  const onFinal = options.onFinal ?? (() => {});
  const { uid } = session;
  const actions = new Map(data.actions.map((action) => [action.id, action]));
  const roles = new Map(data.roles.map((role) => [role.id, role.name]));
  const cardName = (id) => actions.get(id)?.name ?? id;

  await joinRoom(session, code, name, table);

  // ---- 訂閱：房間、自己的私密資料、請求、票、黑夜選擇、挑的棄牌（同玩家端畫面） ----
  const seen = { room: undefined, mine: null, request: null, vote: null, night: null, discard: null };
  let version = 0; // 資料變動的次數
  let lastChange = Date.now();
  let failure = null;
  let stopping = false;
  const wakers = new Set(); // 等資料變動的
  const stoppers = new Set(); // 等 stop() 的
  const changed = () => {
    version += 1;
    lastChange = Date.now();
    for (const wake of [...wakers]) wake();
  };
  const watching = (watch, field) =>
    watch(
      session,
      code,
      (value) => {
        seen[field] = value;
        changed();
      },
      (error) => {
        failure ??= error;
        changed();
      },
    );
  const stops = [
    watching(watchRoom, 'room'),
    watching(watchPrivate, 'mine'),
    watching(watchRequest, 'request'),
    watching(watchVote, 'vote'),
    watching(watchNight, 'night'),
    watching(watchDiscard, 'discard'),
  ];
  const stopPresence = trackPresence(session, code);

  // since 之後資料變了、叫了 stop()、或過了 ms 就往下走。
  const nextChange = (since, ms) =>
    version !== since || stopping
      ? Promise.resolve()
      : new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            wakers.delete(done);
            stoppers.delete(done);
            resolve();
          };
          const timer = setTimeout(done, ms);
          wakers.add(done);
          stoppers.add(done);
        });
  // 等 ms（只有 stop() 會提早叫醒）。
  const sleep = (ms) =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        stoppers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      stoppers.add(done);
    });

  // ---- 這一刻的局面（同玩家端：目前這一局用 activeKey 找，第 2 場是 "{n}-2"） ----
  const model = () => {
    const { room } = seen;
    if (!room?.meta) return { room };
    const me = room.players?.[uid] ?? null;
    if (!me) return { room, me };
    const key = activeKey(room, me.table);
    const state = room.tables?.[key] ?? null;
    const game = room.games?.[key] ?? null;
    const seat = game?.seats?.[uid] ?? null;
    const hand = seen.mine?.hand ?? [];
    // 自己的手牌跟公開的張數對得上才算讀好了：開局、換第 2 場、結算時座位與手牌分兩個訂閱到，中間那一下不動作。
    const ready = Boolean(seat && seen.mine) && (seat.handCount ?? 0) === hand.length;
    return { room, me, key, match: parseKey(key).match, state, game, seat, hand, ready };
  };

  const stats = { plays: 0, passes: 0, responses: 0, votes: 0, nights: 0, discards: 0, rejected: 0, failed: 0 };
  const say = (m, text) => print(actionLine({ name, key: m?.key ?? null, round: m?.state?.round ?? null, phase: m?.state?.phase ?? null, text }));
  const said = new Set();
  const once = (tag, m, text) => {
    if (said.has(tag)) return;
    said.add(tag);
    say(m, text);
  };

  // 該結束了嗎：回傳 { reason, detail } 或 null。
  const ending = (m) => {
    if (failure) return { reason: 'error', detail: `讀不到房間的資料（${failure.message}）` };
    if (m.room === undefined) return null;
    if (!m.room?.meta) return { reason: 'room-gone', detail: '房間不見了' };
    if (!m.me) return { reason: 'left', detail: '已經不在這個房間的玩家名單上' };
    if (m.state && m.game && !m.seat) {
      return { reason: 'no-seat', detail: m.match === 1 ? '這一桌開局時沒有我的座位（開局之後才進來）' : '第 2 場沒有我的座位（主持端設為不參加）' };
    }
    if (m.state?.phase === 'end' && m.game?.final && m.match >= MATCH_COUNT) return { reason: 'done', detail: '兩場都結束了' };
    if (Date.now() - lastChange > waitMs) return { reason: 'idle', detail: `房間 ${Math.round(waitMs / 60_000)} 分鐘都沒有變動` };
    return null;
  };

  // 入座時印一行：座位、階層；第 2 場另外寫新階層是誰交過來的（同玩家端「把角色卡交給…」）。
  const seatText = (m) => {
    let text = `入座：座位 ${m.seat.order + 1}・${roles.get(m.seat.role) ?? m.seat.role}`;
    if (m.match === 1) return text;
    const first = m.room.games?.[matchKey(m.me.table)]?.seats;
    const mine = first ? rotateSeats(first, Object.keys(first)).find((row) => row.uid === uid) : null;
    if (mine && mine.from !== uid) text += `（第 2 場的新階層，由座位 ${first[mine.from].order + 1} 的 ${nameOf(m.room, mine.from)} 交過來）`;
    return text;
  };

  // 只印一次的事：等開局、入座、終局（交給 onFinal 印結算摘要）。
  const notes = (m) => {
    if (!m.state) return;
    if (!m.game) {
      once(`wait:${m.key}`, m, m.match === 1 ? '在玩家名單上了，等主持端開局…' : '等主持端開始第 2 場…');
      return;
    }
    if (!m.seat) return;
    once(`seat:${m.key}`, m, seatText(m));
    if (m.state.phase === 'end' && m.game.final && !said.has(`final:${m.key}`)) {
      said.add(`final:${m.key}`);
      onFinal(m.room, m.key);
      if (m.match < MATCH_COUNT) say(m, '這一場結束了。主持端開第 2 場的話會跟著玩；不開的話按 Ctrl-C 結束');
    }
  };

  // ---- 白晝：輪到自己就出一張出得了的牌（偶爾結束這一輪）；別人的牌在等響應時，有能響應的牌就以小機率響應 ----
  // turn：目前這一輪的位置（局號:回合:輪到第幾位:這一輪出了幾張）與它的狀況；位置一變就重來。
  let turn = { slot: null };
  const answered = new Map(); // pending 的 id → { seq, card, reported, seenAt }：送過的響應
  const rolls = new Map(); // pending 的 id → 這一張要不要響應（只擲一次）

  const dayView = (m) => ({
    round: m.state.round,
    phase: m.state.phase,
    seats: m.game.seats,
    startOrder: m.game.startOrder,
    turn: m.game.turn,
    pending: m.game.pending ?? null,
    hands: { [uid]: m.hand },
  });

  const rejected = (m, what, reason) => {
    stats.rejected += 1;
    say(m, `被退回（${what}）：${reason ? (REJECT_REASONS[reason] ?? reason) : '沒有收到原因'}，改做別的`);
  };

  const respondIntent = (view, now) => {
    const { pending } = view;
    if (pending.by === uid || answered.has(pending.id) || now >= responseDeadline(pending)) return null;
    const options = responseOptions(view, uid, data, now);
    if (options.length === 0) return null;
    if (!rolls.has(pending.id)) rolls.set(pending.id, chance(policy.respondChance, random));
    if (!rolls.get(pending.id)) return null;
    return { kind: 'respond', key: `respond:${pending.id}`, pending: pending.id, card: pickOne(options, random), by: pending.by, against: pending.card };
  };

  const dayIntent = (m) => {
    const view = dayView(m);
    const now = serverTime(session);
    if (view.pending) return respondIntent(view, now);
    const status = dayStatus(view, view.round);
    if (status.done || status.current !== uid) return null;
    const slot = `${m.key}:${view.round}:${status.turn.index}:${status.turn.plays}`;
    if (turn.slot !== slot) turn = { slot, skip: new Set(), tries: 0, pass: null, sent: null, handledAt: null, retryAt: 0, gaveUp: false };
    const handled = m.game.lastSeq?.[uid] ?? 0;
    const { sent } = turn;
    if (sent) {
      if (handled < sent.seq) {
        // 主持端還沒處理：等；太久沒動靜就再送一次同一個請求（主持端只看每個人最新的一筆，不會出兩次）。
        if (sent.resends < RESENDS && Date.now() - sent.at > RESEND_MS) return { kind: 'resend', key: `resend:${slot}:${sent.seq}` };
        return null;
      }
      // 處理了、輪次卻沒動（出牌被接下會有 pending 或換下一張，結束這一輪會換下一位）：被退回。原因在自己的私密資料，晚一點才到。
      const notice = seen.mine?.notice;
      const reason = notice?.seq === sent.seq ? notice.reason : null;
      if (reason === null) {
        turn.handledAt ??= Date.now();
        if (Date.now() - turn.handledAt < NOTICE_WAIT_MS) return null;
      }
      rejected(m, sent.type === 'play' ? `出牌 ${cardName(sent.card)}` : '結束這一輪', reason);
      if (sent.type === 'play') turn.skip.add(sent.card);
      else turn.gaveUp = true; // 連結束這一輪都被退回：主持端認為不是我，等局面變了再說
      turn.sent = null;
      turn.handledAt = null;
    }
    if (seen.request && seen.request.seq > handled) return null; // 還有一筆沒處理的請求（例如響應），等它
    if (turn.gaveUp || Date.now() < turn.retryAt) return null;
    turn.pass ??= chance(policy.passChance + policy.passStep * status.turn.plays, random);
    const options = turn.pass || turn.tries >= MAX_TRIES ? [] : playOptions(view, uid, data, { skip: turn.skip, random });
    if (options.length > 0) return { kind: 'play', key: `play:${slot}:${turn.tries}`, ...pickOne(options, random) };
    return { kind: 'pass', key: `pass:${slot}:${turn.tries}` };
  };

  // 送過的響應有結果了就印一行：被退回（自己的 notice）、成功（出牌紀錄裡響應的人是自己），或沒被採用。
  const reportAnswers = (m) => {
    for (const [id, answer] of answered) {
      if (answer.reported) continue;
      const notice = seen.mine?.notice;
      if (notice?.seq === answer.seq) {
        answer.reported = true;
        rejected(m, `響應 ${cardName(answer.card)}`, notice.reason);
        continue;
      }
      const entry = m.game?.log?.[id];
      if (!entry) continue;
      if (entry.response?.by === uid) {
        answer.reported = true;
        say(m, `響應成功：${cardName(answer.card)}${entry.canceled ? '（那張牌被抵銷了）' : ''}`);
        continue;
      }
      answer.seenAt ??= Date.now();
      if (Date.now() - answer.seenAt >= NOTICE_WAIT_MS) {
        answer.reported = true;
        say(m, `響應沒有被採用：${cardName(answer.card)}`);
      }
    }
  };

  // ---- 黃昏、黑夜：每回合送一次（送不出去最多試 MAX_TRIES 次，中間隔 RETRY_MS） ----
  const tries = new Map(); // 情況 → { count, retryAt }
  const attempt = (tag) => {
    const entry = tries.get(tag) ?? { count: 0, retryAt: 0 };
    return entry.count >= MAX_TRIES || Date.now() < entry.retryAt ? null : entry.count;
  };
  const tried = (tag, ok) => {
    const entry = tries.get(tag) ?? { count: 0, retryAt: 0 };
    tries.set(tag, { count: entry.count + 1, retryAt: ok ? 0 : Date.now() + RETRY_MS });
  };
  // 送出的票、黑夜選擇是不是這一局這一回合的（同玩家端）。
  const sentFor = (value, m) => Boolean(value) && String(value.table) === m.key && value.round === m.state.round;

  const duskIntent = (m) => {
    const { state, game, key } = m;
    const stage = duskStage(game.dusk, state.round);
    const now = serverTime(session);
    if (!(stage === 'voting' || (stage === 'closing' && now < game.dusk.revealAt)) || sentFor(seen.vote, m)) return null;
    const tag = `vote:${key}:${state.round}`;
    const count = attempt(tag);
    if (count === null) return null;
    const view = { table: key, round: state.round, phase: state.phase, seats: game.seats, dusk: game.dusk };
    const vote = chooseVote(view, uid, now, { policy, random });
    return vote ? { kind: 'vote', key: `${tag}:${count}`, tag, vote } : null;
  };

  const discardIntent = (m, now) => {
    const { state, game, key, hand } = m;
    if (overLimit(hand, data.settings) === 0) return null;
    // 這一回合結束就算分：終局不棄牌（同玩家端）。
    if (shouldEnd({ round: state.round, startedAt: game.startedAt, endAfterRound: game.endAfterRound }, data.settings, now) !== null) return null;
    const where = { table: key, round: state.round };
    if (seen.discard && discardProblem(hand, seen.discard, where, data.settings) === null) return null; // 已經挑好了
    const tag = `discard:${key}:${state.round}:${hand.join()}`;
    const count = attempt(tag);
    if (count === null) return null;
    const cards = chooseDiscard(hand, where, data.settings, { random });
    return cards ? { kind: 'discard', key: `${tag}:${count}`, tag, pick: { ...where, cards } } : null;
  };

  const nightIntent = (m) => {
    const { state, game, key } = m;
    const stage = nightStage(game.night, state.round);
    const now = serverTime(session);
    const open = stage === 'choosing' || (stage === 'closing' && now < game.night.revealAt);
    if (open && !sentFor(seen.night, m)) {
      const tag = `night:${key}:${state.round}`;
      const count = attempt(tag);
      const view = { table: key, round: state.round, phase: state.phase, seats: game.seats, night: game.night };
      const pick = count === null ? null : chooseNight(view, uid, now, { random });
      if (pick) return { kind: 'night', key: `${tag}:${count}`, tag, pick };
    }
    return discardIntent(m, now);
  };

  const decide = (m) => {
    if (!m.ready || !m.state || !m.game) return null;
    if (m.state.phase === 'day') return dayIntent(m);
    if (m.state.phase === 'dusk') return duskIntent(m);
    if (m.state.phase === 'night') return nightIntent(m);
    return null;
  };

  const playText = (m, intent) => {
    const action = actions.get(intent.card);
    const cost = [action?.cost?.pounds ? `${action.cost.pounds} 英鎊` : null, action?.cost?.influence ? `${action.cost.influence} 影響力` : null].filter(Boolean);
    let text = `出牌 ${cardName(intent.card)}${cost.length ? `（付 ${cost.join('、')}）` : ''}`;
    if (intent.target) text += `，指定 ${nameOf(m.room, intent.target)}`;
    if (intent.chainTarget) text += `，3 級連鎖要 ${nameOf(m.room, intent.chainTarget)} 棄 1 張`;
    return text;
  };

  const execute = async (intent, m) => {
    try {
      if (intent.kind === 'play') {
        const request = { card: intent.card, target: intent.target, chainTarget: intent.chainTarget };
        const seq = await requestPlay(session, code, request);
        turn.tries += 1;
        turn.sent = { type: 'play', seq, card: intent.card, request, at: Date.now(), resends: 0 };
        stats.plays += 1;
        say(m, playText(m, intent));
      } else if (intent.kind === 'pass') {
        const seq = await requestPass(session, code);
        turn.tries += 1;
        turn.sent = { type: 'pass', seq, at: Date.now(), resends: 0 };
        stats.passes += 1;
        say(m, '結束這一輪');
      } else if (intent.kind === 'resend') {
        const previous = turn.sent;
        const seq = previous.type === 'play' ? await requestPlay(session, code, previous.request) : await requestPass(session, code);
        turn.sent = { ...previous, seq, at: Date.now(), resends: previous.resends + 1 };
        say(m, `主持端 ${RESEND_MS / 1000} 秒都沒處理，再送一次（${previous.type === 'play' ? `出牌 ${cardName(previous.card)}` : '結束這一輪'}）`);
      } else if (intent.kind === 'respond') {
        const seq = await requestRespond(session, code, { card: intent.card, pending: intent.pending });
        answered.set(intent.pending, { seq, card: intent.card, reported: false, seenAt: null });
        stats.responses += 1;
        say(m, `響應 ${cardName(intent.card)}（回應 ${nameOf(m.room, intent.by)} 的 ${cardName(intent.against)}）`);
      } else if (intent.kind === 'vote') {
        await requestVote(session, code, intent.vote);
        tried(intent.tag, true);
        stats.votes += 1;
        say(m, `表決 ${intent.vote.side === 'abstain' ? '棄權' : `${SIDE_TEXT[intent.vote.side]}・出價 ${intent.vote.bid} 影響力`}`);
      } else if (intent.kind === 'night') {
        await requestNight(session, code, intent.pick);
        tried(intent.tag, true);
        stats.nights += 1;
        say(m, `黑夜 ${CHOICE_TEXT[intent.pick.choice]}${intent.pick.choice === 'gamble' ? `（賭到第 ${intent.pick.tiers} 層）` : ''}`);
      } else if (intent.kind === 'discard') {
        await requestDiscard(session, code, intent.pick);
        tried(intent.tag, true);
        stats.discards += 1;
        say(m, `手牌超過上限 ${data.settings.handLimit} 張，挑這幾張在天亮時棄掉：${intent.pick.cards.map(cardName).join('、')}`);
      }
    } catch (error) {
      // 送不出去：規則擋下（StoreError，例如剛好截止）或連線有問題。記一行，這個情況隔一下再試，最多 MAX_TRIES 次。
      stats.failed += 1;
      if (intent.tag) tried(intent.tag, false);
      else if (intent.kind === 'respond') answered.set(intent.pending, { reported: true });
      else if (intent.kind === 'resend') turn.sent = { ...turn.sent, at: Date.now(), resends: turn.sent.resends + 1 };
      else {
        turn.tries += 1;
        turn.retryAt = Date.now() + RETRY_MS;
        if (intent.kind === 'play') turn.skip.add(intent.card);
        if (turn.tries > MAX_TRIES) turn.gaveUp = true; // 出牌與結束這一輪都送不出去：等這一輪的局面變了再說
      }
      say(m, `送不出去：${error instanceof StoreError ? error.message : `連線有問題（${error.message}）`}`);
    }
  };

  // ---- 主迴圈：看局面 → 有事做就等一下（讓旁觀的人看得到）→ 局面沒變就送出 ----
  const run = async () => {
    for (;;) {
      const since = version;
      const m = model();
      notes(m);
      const outcome = stopping ? { reason: 'stopped', detail: '收到停止（Ctrl-C）' } : ending(m);
      if (outcome) return outcome;
      reportAnswers(m);
      const intent = decide(m);
      if (!intent) {
        await nextChange(since, TICK_MS);
        continue;
      }
      await sleep(between(minDelay, maxDelay, random));
      if (stopping) continue;
      const now = model();
      const again = decide(now);
      if (again?.key === intent.key) await execute(again, now);
    }
  };

  const finish = async (outcome) => {
    for (const stop of stops) stop();
    await within(stopPresence(), CLOSE_MS);
    await within(disconnect(session), CLOSE_MS);
    return { ...outcome, stats };
  };
  const done = run().then(finish, (error) => finish({ reason: 'error', detail: error.message }));
  const stop = () => {
    stopping = true;
    for (const wake of [...stoppers]) wake();
    return done;
  };
  return { uid, done, stop };
}
