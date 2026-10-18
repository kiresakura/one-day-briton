// 投影畫面（play/?view=screen&room=房號，本機加 &env=emu；同一個瀏覽器開主持端時加 &slot=screen）。
// 只讀房間：不寫上線狀態、不跑自動結算、不記房號；唯一會寫的是投影端狀態回報（store.js 的 trackScreen，只在聲音解鎖與換場景時更新）。
// 畫面是固定大小的舞台（16:9 是 1920×1080，視窗接近 4:3 時換成 1440×1080 的 4:3 版面），用 transform: scale() 縮到視窗。
// 場景（開場影片、規則說明、比賽中總覽、兩場合計排行、頒獎）照 display/scene 換；底部廣播條、全場暫停、右上角連線狀態疊在所有場景上。
// 影片與音效只有這個畫面會載（play/media/，按「開始投影」後才下載），沒有或下載失敗就用佔位，畫面不壞。
// &preview=1：控制台的小預覽框用。不顯示開始投影頁、不出聲、不全螢幕、不防休眠、不回報狀態、不播影片，也不下載影片與音效。
import { sfxToPlay } from '../game.js';
import { isRoomCode, normalizeRoomCode } from '../rules.js';
import { serverTime, trackScreen, watchConnection, watchRoom } from '../store.js';
import { ART } from './art.js';
import { h, patchChildren } from './dom.js';
import { qrSvg } from './qr.js';
import { createAudio } from './screen-audio.js';
import {
  MEDIA,
  awardPages,
  bellsDue,
  clockText,
  creditsSummary,
  fogEntries,
  fogFlashText,
  headerClock,
  headerClockText,
  joinAddress,
  loopFor,
  matchLine,
  mediaFilesIn,
  mediaProgressText,
  musicOn,
  openingMode,
  openingWaitText,
  pageIndex,
  passedClocks,
  projectorParams,
  rulesPages,
  sceneOf,
  stageLayout,
  standingsView,
  tableCard,
  wallClock,
} from './screen-model.js';
import { awardsScene, broadcastBar, cornerLayer, messageScene, overviewScene, pauseLayer, rulesScene, standingsScene, startPage, titleScene } from './screen-scenes.js';
import { ctx } from './state.js';

const RETRY_MS = 10_000; // 找不到房間時多久再試一次
const FLASH_MS = 10_000; // 迷霧越過門檻時桌牌閃一下、顯示事件名稱多久
const OPENING_PLACEHOLDER_MS = 14_000; // 開場影片的佔位（終局圖慢慢放大＋標題）多長
const OPENING_MAX_MS = 180_000; // 開場影片最長播多久（影片卡住時照樣回到標題頁）
const WAKE_NOTE = '這台電腦請把螢幕休眠設成「永不」';
const MEDIA_NOTE_MS = 10_000; // 素材下載完（或確定沒有素材）之後，左下角的結果留多久
const SCENE_IMAGES = { sunrise: 'dawn', day: 'day', dusk: 'dusk', night: 'night' };

const sceneImage = (name) => `./assets/scenes/${name}-${ART.scene === 'b' ? 'b' : 'a'}.webp`;

const view = {
  session: null,
  code: '',
  valid: false,
  preview: false,
  room: null,
  roomState: 'loading', // loading｜found｜missing｜error
  stopRoom: null,
  retryTimer: null,
  connected: false,
  everConnected: false,
  started: false, // 開始投影頁已經收起來（按了開始，或先看畫面）
  audioOn: false, // 聲音已解鎖
  fullscreen: false,
  wake: { supported: 'wakeLock' in navigator, lock: null, noteUntil: 0 },
  seen: { sfx: null, scene: null, bells: new Set(), primed: false, fog: new Map() },
  flashes: new Map(), // 局號 → { text, until }
  opening: { until: 0, node: null, mode: null, seq: null }, // 正在播的開場：mode＝video｜wait（等下載）｜placeholder，seq 是那一次的場景 seq，until 是最晚收掉的時間
  loop: { key: '', node: null }, // 正在播的背景影片：key＝場景＋網址
  media: new Map(MEDIA.map((item) => [item.id, { status: 'waiting', loaded: 0, total: 0, url: null }])),
  preloading: false,
  mediaNoteUntil: 0,
  credits: { images: null, media: null, loading: false },
  screen: null, // trackScreen 的回傳
  reported: { scene: null },
  cards: null,
  layout: null,
  root: null,
  stage: null,
  layers: null,
};

const audio = createAudio();

// ---- 進入點 ----

// app.js 在照身分切畫面之前呼叫：網址是 view=screen 時，連線之後整頁交給這裡。
export async function startProjector(session) {
  view.session = session;
  const params = projectorParams(location.search, isRoomCode, normalizeRoomCode);
  Object.assign(view, { code: params.code, valid: params.valid, preview: params.preview });
  await loadStyles();
  buildRoot();
  window.addEventListener('resize', layout);
  document.addEventListener('fullscreenchange', () => {
    view.fullscreen = Boolean(document.fullscreenElement);
    render();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && view.wake.lock) requestWakeLock();
  });
  watchConnection(session, (connected) => {
    view.connected = connected;
    if (connected) view.everConnected = true;
    render();
  });
  if (view.valid) subscribe();
  else view.roomState = 'error';
  // 每秒重畫一次：日落鐘、響應倒數、迷霧閃動的 10 秒、日落自動響鐘都照時間走（斷線時鐘照走）。
  setInterval(tick, 1000);
  render();
}

// screen.css 只在投影畫面載入：等它載好再顯示，免得先閃一下沒有樣式的畫面。
function loadStyles() {
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../../css/screen.css', import.meta.url).href;
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
    document.head.append(link);
    setTimeout(resolve, 4000);
  });
}

function buildRoot() {
  document.getElementById('screen-loading')?.setAttribute('hidden', '');
  document.documentElement.classList.add('is-projector');
  const layer = (name) => h('div', { class: `projector-layer projector-${name}` });
  // 背景影片的層在場景底下（場景的底圖用 z-index 墊在它下面，遮罩與文字在它上面）。
  view.layers = { loop: layer('loop'), scene: layer('scene'), video: layer('video'), broadcast: layer('broadcast'), pause: layer('pause'), start: layer('start'), corner: layer('corner') };
  view.layers.video.hidden = true;
  view.stage = h('div', { class: 'projector-stage' }, Object.values(view.layers));
  view.root = h('section', { class: `projector${view.preview ? ' is-preview' : ''}`, attrs: { id: 'screen-projector', 'aria-label': '投影畫面' } }, view.stage);
  view.root.addEventListener('click', onClick);
  document.body.append(view.root);
  layout();
}

// 舞台照視窗大小縮放、置中；視窗比例接近 4:3 時換成 4:3 舞台與版面。
function layout() {
  const next = stageLayout(window.innerWidth, window.innerHeight);
  const changed = next.layout !== view.layout?.layout;
  view.layout = next;
  view.root.dataset.layout = next.layout;
  Object.assign(view.stage.style, { width: `${next.width}px`, height: `${next.height}px`, transform: `translate(${next.left}px, ${next.top}px) scale(${next.scale})` });
  if (changed) render();
}

// ---- 房間 ----

function subscribe() {
  clearTimeout(view.retryTimer);
  view.stopRoom?.();
  view.stopRoom = watchRoom(view.session, view.code, onRoom, () => {
    view.roomState = 'error';
    render();
    retryLater();
  });
}

// 找不到房間（或讀不到）時每 10 秒重新訂閱一次，不送回首頁。
function retryLater() {
  clearTimeout(view.retryTimer);
  view.retryTimer = setTimeout(subscribe, RETRY_MS);
}

function onRoom(room) {
  if (!room?.meta) {
    view.room = null;
    view.roomState = 'missing';
    render();
    retryLater();
    return;
  }
  clearTimeout(view.retryTimer);
  view.room = room;
  view.roomState = 'found';
  if (!view.preview && !view.screen) {
    const field = sceneField(room);
    view.reported.scene = field.scene ?? null;
    view.screen = trackScreen(view.session, view.code, { audio: view.audioOn, ...field });
  }
  react(room);
  render();
}

function sceneField(room) {
  const { seq } = sceneOf(room.display);
  return seq > 0 ? { scene: seq } : {};
}

// 房間一有變化：音效、開場影片、背景音樂、迷霧越過門檻、投影端回報的場景。
function react(room) {
  const now = serverTime(view.session);
  const display = room.display ?? {};
  // 音效：seq 比看過的新、5 秒內的才播；播不播都記下 seq（斷線重連後不補放）。
  const { sfx } = display;
  if (sfx && Number.isInteger(sfx.seq) && sfx.seq !== view.seen.sfx) {
    if (view.audioOn && !view.preview && sfxToPlay(sfx, view.seen.sfx, now)) audio.play(sfx.id);
    view.seen.sfx = Math.max(view.seen.sfx ?? 0, sfx.seq);
  }
  // 開場影片：只在 display/scene 的 seq 變了、而且是開場時播。第一次讀到的場景當作看過了（重新整理不重播）。
  const scene = sceneOf(display);
  if (view.seen.scene === null) view.seen.scene = scene.seq;
  else if (scene.seq !== view.seen.scene) {
    view.seen.scene = scene.seq;
    if (scene.id === 'opening' && view.started && !view.preview) playOpening(scene.seq);
  }
  if (scene.id !== 'opening') stopOpening();
  updateMusic();
  // 投影端回報：只在換場景時更新（規則沒有限制多久能寫一次，每寫一次都會推給全房的手機）。
  const field = sceneField(room);
  if (view.screen && field.scene !== undefined && field.scene !== view.reported.scene) {
    view.reported.scene = field.scene;
    view.screen.update(field).catch(() => false);
  }
  watchFog(room);
}

// 迷霧越過門檻：那張桌牌閃一下、顯示迷霧事件名稱 10 秒。第一次讀到的紀錄不閃。
function watchFog(room) {
  const tableCount = room.meta?.tableCount ?? 0;
  for (let table = 1; table <= tableCount; table += 1) {
    for (const key of [String(table), `${table}-2`]) {
      const game = room.games?.[key];
      if (!game) continue;
      const entries = fogEntries(game);
      const seen = view.seen.fog.get(key);
      view.seen.fog.set(key, entries.length);
      if (seen === undefined || entries.length <= seen) continue;
      const latest = entries[entries.length - 1];
      view.flashes.set(key, { text: fogFlashText(latest, ctx.cardData), until: Date.now() + FLASH_MS });
    }
  }
}

// ---- 每秒 ----

function tick() {
  const room = view.room;
  if (room) {
    const now = serverTime(view.session);
    // 日落自動響鐘：全場鐘到點時在本機播一次鐘聲（每場一次），不寫資料庫。第一次讀到時已經日落的鐘不補；
    // 全場暫停中到點的先不響、恢復後第一秒補響（bellsDue）。聲音沒開時照樣記下，之後開了聲音也不補。
    if (!view.seen.primed) {
      for (const key of passedClocks(room, now)) view.seen.bells.add(key);
      view.seen.primed = true;
    }
    const bells = bellsDue(room, now, view.seen.bells, room.display?.pause?.on === true);
    for (const key of bells.mark) view.seen.bells.add(key);
    if (view.audioOn && !view.preview) for (const match of bells.ring) audio.play('bell');
  }
  for (const [key, flash] of view.flashes) if (flash.until <= Date.now()) view.flashes.delete(key);
  if (view.opening.until && view.opening.until <= Date.now()) stopOpening();
  render();
}

// ---- 畫 ----

function render() {
  if (!view.root) return;
  view.cards = ctx.cardData;
  const now = view.session ? serverTime(view.session) : Date.now();
  const room = view.room;
  const display = room?.display ?? {};
  const scene = sceneOf(display);
  view.root.dataset.scene = room ? scene.id : 'message';
  patch(view.layers.scene, sceneNodes(room, scene, now));
  updateLoop(room && view.valid ? scene.id : null);
  if (view.opening.mode === 'wait') patch(view.opening.node, [waitNote(view.media.get('opening'))]);
  const broadcast = display.broadcast && display.broadcast.hidden !== true && typeof display.broadcast.text === 'string' ? display.broadcast : null;
  const paused = display.pause?.on === true;
  view.root.classList.toggle('has-broadcast', Boolean(broadcast && room && !paused));
  patch(view.layers.broadcast, broadcast && room && !paused ? [broadcastBar({ text: broadcast.text, time: wallClock(broadcast.at, now - Date.now()) })] : []);
  patch(view.layers.pause, room && paused ? [pauseLayer({ broadcast: broadcast?.text ?? '', clock: pauseClockText(room, now) })] : []);
  view.layers.pause.hidden = !(room && paused);
  patch(view.layers.start, !view.started && !view.preview ? [startPage(startModel())] : []);
  view.layers.start.hidden = view.started || view.preview;
  patch(view.layers.corner, cornerLayer(cornerModel()));
}

// 場景元件回傳的是一層包一層的陣列（可能有 null）：拉平後交給 patchChildren 就地更新，換場景以外不重建節點（動畫不會重來）。
// 場景樹裡不放 <video>／<audio>：每次重畫都會先建一整棵新的離線樹，媒體元素一設 src 就開始載入與播放，而且不會被回收。
function patch(layer, nodes) {
  patchChildren(layer, [nodes].flat(Infinity).filter(Boolean));
}

// 背景影片（標題、規則、排行、頒獎）由這裡管：（場景, 網址）變了才建一次 <video>。先用屬性設靜音、重複播、不全螢幕
// （setAttribute('muted') 不會真的靜音），再設 src、播放；換場景或拿掉時停掉、清掉 src、移除，不留在背景解碼。開場影片蓋著時先不播。
function updateLoop(sceneId) {
  const id = sceneId && view.opening.node?.tagName !== 'VIDEO' ? loopFor(sceneId) : null;
  const url = id ? mediaUrl(id) : null;
  const key = url ? `${sceneId} ${url}` : '';
  if (key === view.loop.key) return;
  stopLoop();
  if (!url) return;
  const node = document.createElement('video');
  node.className = 'projector-bg-video';
  node.setAttribute('aria-hidden', 'true');
  node.muted = true;
  node.loop = true;
  node.playsInline = true;
  node.src = url;
  view.loop = { key, node };
  view.layers.loop.append(node);
  node.play().catch(() => {});
}

function stopLoop() {
  const { node } = view.loop;
  view.loop = { key: '', node: null };
  if (!node) return;
  node.pause();
  node.removeAttribute('src');
  node.load();
  node.remove();
}

function sceneNodes(room, scene, now) {
  if (!view.valid) return messageScene({ title: '房號格式不對', text: `網址裡的房號是「${view.code || '（空白）'}」。房號是 6 碼英數字，例如 ?view=screen&room=QX7M4K` });
  if (!room) {
    if (view.roomState === 'missing') return messageScene({ title: `找不到房間 ${view.code}`, text: '每 10 秒自動再試一次；主持端開好房間後這裡就會出現' });
    if (view.roomState === 'error') return messageScene({ title: `讀不到房間 ${view.code}`, text: '每 10 秒自動再試一次' });
    return messageScene({ title: '讀取房間中…', text: '' });
  }
  if (scene.id === 'rules') {
    const pages = rulesPages(view.cards);
    const index = pageIndex(scene.page, pages.length);
    const page = pages[index];
    const tipImage = page?.kind === 'tip' ? sceneImage(SCENE_IMAGES[page.phase] ?? 'day') : sceneImage('dawn');
    return rulesScene({ pages, index, bg: mediaUrl('bg-rules') ?? tipImage });
  }
  if (scene.id === 'overview') return overviewScene(overviewModel(room, now));
  if (scene.id === 'standings') return standingsScene({ columns: standingsView(room) });
  if (scene.id === 'awards') {
    loadCredits();
    const pages = awardPages(room);
    const index = pageIndex(scene.page, pages.length);
    return awardsScene({
      pages,
      index,
      reveal: !view.preview,
      credits: creditsSummary(view.credits.images),
      mediaCredits: creditsSummary(view.credits.media),
      creditsUrl: `${joinAddress(location).text}credits.html`,
    });
  }
  const join = joinAddress(location);
  return titleScene({ code: view.code, join, qr: qrSvg(join.full), bg: mediaUrl('bg-title') ?? sceneImage('finale') });
}

function overviewModel(room, now) {
  const settings = view.cards?.data?.settings ?? null;
  const header = headerClock(room, settings, now);
  const offset = now - Date.now();
  const cards = [];
  for (let table = 1; table <= (room.meta?.tableCount ?? 0); table += 1) {
    const card = tableCard(room, table, view.cards, now, header);
    const flash = view.flashes.get(card.key);
    if (flash) card.flash = flash.text;
    cards.push(card);
  }
  const status = header.status;
  return {
    code: view.code,
    line: matchLine(room, header.match),
    header,
    headerText: headerClockText(header),
    startText: header.global ? `開始 ${wallClock(header.startedAt, offset)}` : '',
    sunsetText: header.global ? (status.sunsetAt ? `日落 ${wallClock(status.sunsetAt, offset)}` : '日落 暫停中') : '',
    cards,
    now,
  };
}

// 全場暫停時停住的日落鐘：「日落鐘停在 33:52」。那一場沒有全場鐘時不寫。
function pauseClockText(room, now) {
  const header = headerClock(room, view.cards?.data?.settings ?? null, now);
  if (!header.global) return '';
  if (header.status.passed) return '日落鐘：已經日落';
  return `日落鐘${header.status.paused ? '停在' : '剩'} ${clockText(header.status.remaining)}`;
}

function connectionModel() {
  if (view.connected) return { ok: true, text: '已連線' };
  return { ok: false, text: view.everConnected ? '連線中斷・重新連線中…' : '連線中…' };
}

function startModel() {
  const room = view.room;
  let problem = '';
  if (!view.valid) problem = '房號格式不對';
  else if (view.roomState === 'missing') problem = `找不到房間 ${view.code}（每 10 秒再試一次）`;
  else if (view.roomState === 'error') problem = `讀不到房間 ${view.code}（每 10 秒再試一次）`;
  return {
    code: view.code,
    valid: view.valid,
    connection: connectionModel(),
    room: room ? `找到房間・${room.meta?.tableCount ?? 0} 桌` : '',
    problem,
    media: mediaProgressText(mediaItems(), view.preloading),
    wakeNote: view.wake.supported ? '' : WAKE_NOTE,
    cardsNote: ctx.cardsFailed ? '卡牌資料有問題：事件與法案的名稱、日落鐘的設定讀不到，請找工作人員' : '',
  };
}

function cornerModel() {
  const items = mediaItems();
  const loading = items.some((item) => item.status === 'waiting' || item.status === 'loading');
  const music = audio.music;
  return {
    connection: connectionModel(),
    sound: view.started && !view.audioOn && !view.preview,
    media: view.preloading && (loading || view.mediaNoteUntil > Date.now()) ? mediaProgressText(items, true) : '',
    placeholder: music.playing && music.placeholder ? '開場音樂：佔位' : '',
    wakeNote: !view.preview && view.started && view.wake.noteUntil > Date.now() ? WAKE_NOTE : '',
    fullscreen: view.started && !view.preview && !view.fullscreen && Boolean(document.documentElement.requestFullscreen),
  };
}

// ---- 開始投影：聲音、全螢幕、防休眠、預載素材 ----

function onClick(event) {
  const act = event.target.closest?.('[data-act]')?.dataset.act;
  if (act === 'start') start(true);
  else if (act === 'skip') start(false);
  else if (act === 'unlock') start(true);
  else if (act === 'fullscreen') enterFullscreen();
}

// 一定在按下去的處理函式裡同步呼叫（瀏覽器只在使用者按了之後才准出聲、全螢幕）。sound＝false 是「先看畫面」：只收起開始投影頁。
function start(sound) {
  if (view.preview) return;
  view.started = true;
  if (sound) {
    enterFullscreen();
    requestWakeLock();
    audio.unlock().then((on) => {
      view.audioOn = on;
      if (on) view.screen?.update({ audio: true }).catch(() => false);
      updateMusic();
      render();
    });
    preload();
  }
  render();
}

function enterFullscreen() {
  if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  document.documentElement.requestFullscreen().catch(() => {});
}

// 防休眠只在分頁顯示時有效，切走時會被收回：visibilitychange 回來時再要一次。不支援時寫一行請把休眠設成「永不」。
async function requestWakeLock() {
  if (!view.wake.supported) {
    view.wake.noteUntil = Date.now() + 20_000;
    return;
  }
  if (view.wake.lock && !view.wake.lock.released) return;
  try {
    view.wake.lock = await navigator.wakeLock.request('screen');
  } catch {
    view.wake.noteUntil = Date.now() + 20_000;
  }
  render();
}

function mediaItems() {
  return MEDIA.map((item) => view.media.get(item.id));
}

function mediaUrl(id) {
  const entry = view.media.get(id);
  return entry?.status === 'ready' ? entry.url : null;
}

// 素材預載：按「開始投影」後才開始。先讀素材清單（media/credits.json），只下載清單上列到的檔，一次兩個；清單不在（素材還沒放進來）
// 就全部用佔位、不去要其他檔。清單裡沒寫檔名時逐一試素材表上的檔。檔不存在（404）或格式不對就記成佔位。
// 預覽框與手機、主持端都不會走到這裡。
async function preload() {
  if (view.preloading || view.preview) return;
  view.preloading = true;
  const list = MEDIA.find((item) => item.kind === 'json');
  await fetchMedia(list);
  const listed = view.media.get(list.id).status === 'ready' ? mediaFilesIn(view.credits.media) : new Map();
  const queue = [];
  for (const item of MEDIA) {
    if (item === list) continue;
    const entry = view.media.get(item.id);
    if (listed && !listed.has(item.file)) entry.status = 'missing';
    else {
      entry.total = listed?.get(item.file) ?? 0;
      queue.push(item);
    }
  }
  openingDownloaded(); // 清單上沒有開場影片：等著的那一次改用佔位
  render();
  const worker = async () => {
    while (queue.length) await fetchMedia(queue.shift());
  };
  await Promise.all([worker(), worker()]);
  view.mediaNoteUntil = Date.now() + MEDIA_NOTE_MS;
  updateMusic();
  render();
}

const EXPECTED_TYPE = { video: /^video\//, audio: /^audio\//, image: /^image\//, json: /json/ };

async function fetchMedia(item) {
  const entry = view.media.get(item.id);
  try {
    const response = await fetch(new URL(`../../media/${item.file}`, import.meta.url));
    if (!response.ok) {
      entry.status = 'missing';
      return;
    }
    const type = response.headers.get('content-type') ?? '';
    if (!EXPECTED_TYPE[item.kind].test(type)) {
      entry.status = 'failed';
      return;
    }
    entry.status = 'loading';
    entry.total = Number(response.headers.get('content-length')) || entry.total || 0;
    const reader = response.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      entry.loaded += value.length;
      scheduleRender();
    }
    const blob = new Blob(chunks, { type });
    if (item.kind === 'json') {
      view.credits.media = JSON.parse(await blob.text());
    } else if (item.id === 'bell' || item.id === 'gavel') {
      await audio.useSound(item.id, await blob.arrayBuffer());
    }
    entry.url = URL.createObjectURL(blob);
    entry.status = 'ready';
  } catch {
    entry.status = 'failed';
  } finally {
    if (item.id === 'opening') openingDownloaded();
    scheduleRender();
  }
}

// 下載中重畫：同一個動畫格只畫一次。
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// 素材來源頁的圖片清單（play/assets/credits.json）：第一次切到頒獎時才讀。
function loadCredits() {
  if (view.credits.images || view.credits.loading) return;
  view.credits.loading = true;
  fetch(new URL('../../assets/credits.json', import.meta.url))
    .then((response) => (response.ok ? response.json() : []))
    .then((list) => {
      view.credits.images = Array.isArray(list) ? list : [];
    })
    .catch(() => {
      view.credits.images = [];
    })
    .finally(() => render());
}

// ---- 開場影片與背景音樂 ----

// 播開場（display/scene 換成開場時；seq 是那一次的 seq）：有素材播影片（播完或出錯回到標題頁）。素材還在下載時先寫
// 「開場影片下載中（x／y MB）」，下載完時還是同一次開場就接著播（openingDownloaded）；下載失敗、沒有素材才用佔位
// （終局場景圖慢慢放大＋標題）。
function playOpening(seq) {
  stopOpening();
  const entry = view.media.get('opening');
  const mode = openingMode(entry, view.preloading);
  const layer = view.layers.video;
  let node;
  if (mode === 'video') {
    node = h('video', { class: 'projector-video-media', attrs: { playsinline: true, preload: 'auto' } });
    node.src = entry.url;
    // 播完或出錯回到標題頁（還是這一支的話）；重畫一次，標題頁的背景影片接著播。
    const end = () => {
      if (view.opening.node !== node) return;
      stopOpening();
      render();
    };
    node.addEventListener('ended', end, { once: true });
    node.addEventListener('error', end, { once: true });
    node.play().catch(() => {
      // 聲音還沒解鎖時改成靜音播（瀏覽器准靜音自動播放）。
      node.muted = true;
      node.play().catch(end);
    });
    view.opening.until = Date.now() + OPENING_MAX_MS;
  } else if (mode === 'wait') {
    // 等下載：標題頁照常顯示，上面蓋一層寫進度（render 每次更新數字）。不設最晚收掉的時間，換場景才收。
    node = h('div', { class: 'projector-opening-wait' }, waitNote(entry));
    view.opening.until = 0;
  } else {
    node = h(
      'div',
      { class: 'projector-opening' },
      h('div', { class: 'projector-opening-image', style: { 'background-image': `url("${sceneImage('finale')}")` } }),
      h('div', { class: 'projector-opening-veil' }),
      h('p', { class: 'projector-opening-title' }, h('span', { text: '一日英國人' }), h('small', { text: '女皇陛下萬歲！' })),
      h('p', { class: 'projector-opening-mark', text: '開場影片：佔位' }),
    );
    view.opening.until = Date.now() + OPENING_PLACEHOLDER_MS;
  }
  Object.assign(view.opening, { node, mode, seq });
  layer.classList.toggle('is-wait', mode === 'wait');
  layer.replaceChildren(node);
  layer.hidden = false;
}

function waitNote(entry) {
  return h('p', { class: 'projector-opening-wait-text', attrs: { role: 'status' }, text: openingWaitText(entry) });
}

// 開場影片下載完、失敗，或確定沒有這個檔：還在等的那一次開場（場景還是開場、seq 沒變）就接著播影片（或退回佔位）；已經換掉就收起來。
function openingDownloaded() {
  if (view.opening.mode !== 'wait') return;
  const entry = view.media.get('opening');
  if (openingMode(entry, view.preloading) === 'wait') return;
  const scene = sceneOf(view.room?.display);
  if (scene.id === 'opening' && scene.seq === view.opening.seq) playOpening(scene.seq);
  else stopOpening();
  render();
}

function stopOpening() {
  if (!view.opening.node) return;
  const node = view.opening.node;
  Object.assign(view.opening, { node: null, mode: null, seq: null, until: 0 });
  if (node.tagName === 'VIDEO') {
    node.pause();
    node.removeAttribute('src');
    node.load();
  }
  view.layers.video.replaceChildren();
  view.layers.video.classList.remove('is-wait');
  view.layers.video.hidden = true;
}

function updateMusic() {
  const want = view.room && musicOn(view.room.display) && view.audioOn && !view.preview;
  if (want) audio.startMusic(mediaUrl('music-opening'));
  else if (audio.music.playing) audio.stopMusic();
}
