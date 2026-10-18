// 進入點：連線、房間訂閱、畫面切換（首頁、主持端的開房／接手、等待核准、主持端、玩家端）。各畫面的內容在 js/ui/：
// shared.js（共用文字與元件）、home.js（首頁）、host.js（主持端）、player.js（玩家端）。資料一律從 store.js 的訂閱來，
// 牌名與牌面文字從卡牌資料檔（gamedata.js）來。
import { indexGameData, loadGameData } from './gamedata.js';
import { isHostOf, isRoomCode } from './rules.js';
import { cancelHostRequest, connect, createRoom, enterAsHost, joinRoom, leaveRoom, watchConnection, watchRoom } from './store.js';
import { $ } from './ui/dom.js';
import { joinValues, renderPending, setupHome, updateJoin } from './ui/home.js';
import { renderHost, renderHostEntry, resetHost } from './ui/host.js';
import { renderPlayer, resetPlayer, setConnected } from './ui/player.js';
import { explain, notify, resetTimers, run } from './ui/shared.js';
import { ctx, setRerender } from './ui/state.js';

// ?slot=xxx：同一個瀏覽器的不同分頁可以是不同玩家。不帶就是這個瀏覽器的預設身分。
const slotParam = new URLSearchParams(location.search).get('slot') ?? '';
const slot = /^[A-Za-z0-9_-]{1,20}$/.test(slotParam) ? slotParam : '';
// 記住目前在哪個房間，重新整理後回到同一個房。
const savedRoomKey = `one-day-briton:room:${slot || 'default'}`;
// ?view=screen：投影畫面（js/ui/screen.js，只在這個網址才載入）。在照身分切畫面之前分出去：只讀房間，
// 不寫上線狀態、不跑自動結算、不記房號。
const projector = new URLSearchParams(location.search).get('view') === 'screen';

let stopWatching = null;
let offlineTimer = null;

function show(screen) {
  for (const name of ['loading', 'home', 'host-entry', 'pending', 'host', 'player']) $(`screen-${name}`).hidden = name !== screen;
  // 玩家端照階段換色調；其他畫面用白晝的紙色。
  if (screen !== 'player') document.body.dataset.phase = 'day';
}

// 自己的連線：斷了超過一秒才提示，剛開頁面還沒連上或瞬間抖動時不閃。
function showConnection(connected) {
  clearTimeout(offlineTimer);
  if (connected) {
    $('connection').hidden = true;
    setConnected(true);
  } else {
    offlineTimer = setTimeout(() => {
      $('connection').hidden = false;
      setConnected(false);
    }, 1000);
  }
}

function goHome(message = '') {
  stopWatching?.();
  stopWatching = null;
  ctx.stopPresence?.().catch(() => {});
  ctx.stopPresence = null;
  resetHost();
  resetPlayer();
  resetTimers();
  ctx.latestRoom = null;
  ctx.code = null;
  ctx.requested = false;
  localStorage.removeItem(savedRoomKey);
  notify(message);
  show('home');
}

function enterRoom(roomCode) {
  ctx.code = roomCode;
  localStorage.setItem(savedRoomKey, roomCode);
  notify();
  const stop = watchRoom(ctx.session, roomCode, render, () => goHome('讀不到這個房間，請重新加入'));
  if (ctx.code === roomCode) stopWatching = stop;
  else stop(); // 第一筆資料就把人送回首頁了
}

function render(room) {
  if (!room?.meta) return goHome('房間不存在或已關閉');
  ctx.latestRoom = room;
  if (isHostOf(room, ctx.session.uid)) {
    show('host'); // 先顯示再畫：被截斷的名字要量得到寬度
    return renderHost(room);
  }
  if (room.hostRequests?.[ctx.session.uid]) {
    renderPending();
    return show('pending');
  }
  if (ctx.requested) return goHome('主持端沒有核准這次申請');
  const me = room.players?.[ctx.session.uid];
  if (me && room.tables?.[me.table]) {
    show('player');
    return renderPlayer(room, me);
  }
  return goHome('你還沒加入這個房間');
}

setRerender(() => {
  if (ctx.latestRoom) render(ctx.latestRoom);
});

$('host-entry-open').addEventListener('click', () => {
  notify();
  renderHostEntry();
  show('host-entry');
});

$('host-entry-back').addEventListener('click', () => {
  notify();
  show('home');
});

$('create-room').addEventListener('click', () => run($('create-room'), async () => enterRoom(await createRoom(ctx.session))));

// 已經是主持端就直接回到主持畫面；還不是就送出申請，在等待畫面等核准。
$('host-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.target.querySelector('button'), async () => {
    enterRoom((await enterAsHost(ctx.session, $('host-join-code').value)).code);
    event.target.reset();
  });
});

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const button = $('join-submit');
  if (button.disabled) return;
  const { code, name, table } = joinValues();
  run(button, async () => enterRoom(await joinRoom(ctx.session, code, name, table))).finally(updateJoin);
});

$('pending-cancel').addEventListener('click', () => {
  const leaving = ctx.code;
  goHome();
  cancelHostRequest(ctx.session, leaving).catch((error) => notify(explain(error)));
});

// 主持端的「離開」在主持畫面的頂列裡（重畫時會換），用事件委派。
document.addEventListener('host-leave', () => {
  if (confirm('離開後房間會保留，這台裝置之後可以在首頁按「開房／接手房間」，輸入房號回來。確定離開？')) goHome();
});

// 玩家端的「離開房間」在玩家畫面裡（重畫時會換），用事件委派。
document.addEventListener('player-leave', () => {
  const leaving = ctx.code;
  goHome();
  leaveRoom(ctx.session, leaving).catch((error) => notify(explain(error)));
});

setupHome();

// 卡牌資料與連線同時開始讀。讀不到或檢查有錯誤時，畫面頂端一直顯示提醒，開局與發牌都停用。
loadGameData()
  .then(({ data, errors }) => {
    if (errors.length) throw new Error(errors.join('\n'));
    ctx.cardData = { data, index: indexGameData(data) };
  })
  .catch((error) => {
    ctx.cardsFailed = true;
    $('data-problem').hidden = false;
    console.error(`卡牌資料有問題：\n${error.message}`);
  })
  .finally(() => {
    if (ctx.latestRoom) render(ctx.latestRoom);
    if (!$('screen-host-entry').hidden) renderHostEntry();
  });

try {
  ctx.session = await connect(slot);
  if (projector) {
    const { startProjector } = await import('./ui/screen.js');
    await startProjector(ctx.session);
  } else {
    watchConnection(ctx.session, showConnection);
    const saved = localStorage.getItem(savedRoomKey);
    if (isRoomCode(saved)) enterRoom(saved);
    else show('home');
  }
} catch {
  notify('連不上遊戲伺服器，請確認網路後重新整理頁面');
}
