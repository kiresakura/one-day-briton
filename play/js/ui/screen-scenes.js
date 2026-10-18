// 投影畫面各場景與疊層的元件：標題頁、規則說明、比賽中總覽、兩場合計排行、頒獎，以及廣播條、全場暫停、開始投影頁、角落的狀態。
// 只把 screen.js 算好的資料畫成節點（dom.js 的 h），不讀房間、不碰計時器；按鈕一律用 data-act，由 screen.js 委派處理。
// 狀態不只靠顏色：每一種都有字或記號（design-spec 原則 1）。
import { h } from './dom.js';
import { clockText, horizonProgress, pageText } from './screen-model.js';

const PHASE_TEXT = { sunrise: '日出', day: '白晝', dusk: '黃昏', night: '黑夜' };
const PHASE_LATIN = { sunrise: 'DAWN', day: 'DAY', dusk: 'DUSK', night: 'NIGHT' };
const PHASE_TONE = { sunrise: 'dawn', day: 'day', dusk: 'dusk', night: 'night' };
// 規則說明第 1 頁的流程圖：每個階段一句。
const FLOW = [
  { phase: 'sunrise', text: '領薪水、抽 2 張牌，翻開今日事件' },
  { phase: 'day', text: '照座位輪流出牌，別人可以響應' },
  { phase: 'dusk', text: '議會表決法案，押影響力' },
  { phase: 'night', text: '豪賭、分贓，或回家睡覺' },
];

function art(kind, id, extra = '') {
  return h(
    'span',
    { class: `projector-art projector-art-${kind}${extra}`, attrs: { 'aria-hidden': 'true' } },
    id ? h('span', { class: 'projector-art-img', style: { 'background-image': `url("./assets/${kind}/${id}.webp")` } }) : null,
  );
}

// 場景底圖。背景影片不在這裡：screen.js 另外放在場景底下的一層（場景樹每秒重建，媒體元素不能放進來）。
function backdrop(url, key) {
  return h('div', { class: 'projector-bg', data: { key: `bg-${key}` }, style: url ? { 'background-image': `url("${url}")` } : {} });
}

function pageNumber(index, total) {
  return h('p', { class: 'projector-page', text: pageText(index, total) });
}

// ---- 標題頁（開場影片播完停在這裡） ----

// m：{ code, join: { text }, qr（SVG 節點或 null）, bg }
export function titleScene(m) {
  return [
    backdrop(m.bg, 'title'),
    h('div', { class: 'projector-veil projector-veil-title', data: { key: 'veil' } }),
    h(
      'div',
      { class: 'projector-safe projector-title', data: { key: 'title' } },
      h('p', { class: 'projector-latin', text: 'LONDON · MDCCCLXXXVIII', attrs: { lang: 'en' } }),
      h('h1', { class: 'projector-title-main' }, h('span', { class: 'projector-title-name', text: '一日英國人' }), h('span', { class: 'projector-title-sub', text: '女皇陛下萬歲！' })),
      h(
        'div',
        { class: `projector-join${m.qr ? ' has-qr' : ''}` },
        h(
          'div',
          { class: 'projector-join-body' },
          h('p', { class: 'projector-join-label', text: '房號' }),
          h('p', { class: 'projector-join-code', text: m.code }),
          h('p', { class: 'projector-join-how' }, '手機打開 ', h('span', { class: 'projector-join-url', text: m.join.text }), '，輸入房號加入'),
        ),
        m.qr ? h('div', { class: 'projector-qr', attrs: { role: 'img', 'aria-label': `加入網址的 QR 碼：${m.join.text}` } }, m.qr) : null,
      ),
    ),
  ];
}

// ---- 規則說明 ----

// m：{ pages, index, bg }
export function rulesScene(m) {
  const page = m.pages[m.index];
  const key = `rules-${m.index}`;
  if (!page) return [];
  if (page.kind === 'flow') {
    return [
      backdrop(m.bg, 'rules'),
      h('div', { class: 'projector-veil', data: { key: 'veil' } }),
      h(
        'div',
        { class: 'projector-safe projector-rules projector-reveal', data: { key } },
        h('p', { class: 'projector-eyebrow', text: '規則說明' }),
        h('h2', { class: 'projector-rules-title', text: '一回合怎麼進行' }),
        h(
          'ol',
          { class: 'projector-flow' },
          FLOW.map((step, index) => [
            index > 0 ? h('li', { class: 'projector-flow-arrow', text: '→', attrs: { 'aria-hidden': 'true' } }) : null,
            h(
              'li',
              { class: `projector-flow-step is-${PHASE_TONE[step.phase]}` },
              h('span', { class: 'projector-flow-latin', text: PHASE_LATIN[step.phase], attrs: { lang: 'en' } }),
              h('span', { class: 'projector-flow-name', text: PHASE_TEXT[step.phase] }),
              h('span', { class: 'projector-flow-text', text: step.text }),
            ),
          ]),
        ),
        h('p', { class: 'projector-rules-foot', text: '黑夜結束就是下一回合的日出；日落鐘到了，那一回合結束後算分。' }),
        pageNumber(m.index, m.pages.length),
      ),
    ];
  }
  return [
    backdrop(m.bg, 'rules'),
    h('div', { class: 'projector-veil', data: { key: 'veil' } }),
    h(
      'div',
      { class: 'projector-safe projector-rules projector-reveal', data: { key } },
      h('p', { class: 'projector-eyebrow', text: `規則說明・第 ${page.number}／${page.count} 則` }),
      h(
        'p',
        { class: `projector-tip-phase is-${PHASE_TONE[page.phase] ?? 'day'}` },
        h('span', { class: 'projector-flow-latin', text: PHASE_LATIN[page.phase] ?? '', attrs: { lang: 'en' } }),
        h('span', { text: PHASE_TEXT[page.phase] ?? '' }),
      ),
      h('p', { class: 'projector-tip-text', text: page.text }),
      pageNumber(m.index, m.pages.length),
    ),
  ];
}

// ---- 比賽中總覽 ----

// m：{ code, line, header, headerText, startText, sunsetText, cards, now }
export function overviewScene(m) {
  const { header, headerText } = m;
  const progress = header.global ? horizonProgress(header.status) : 0;
  const clockState = !header.global ? 'is-local' : header.status.passed ? 'is-passed' : header.status.paused ? 'is-paused' : '';
  return [
    h('div', { class: 'projector-night', data: { key: 'bg-night' } }),
    h(
      'div',
      { class: 'projector-safe projector-overview', data: { key: 'overview' } },
      h(
        'header',
        { class: 'projector-head' },
        h('div', { class: 'projector-brand' }, h('p', { class: 'projector-brand-title', text: '一日英國人' }), h('p', { class: 'projector-brand-sub' }, h('span', { text: '女皇陛下萬歲！' }), h('span', { text: m.line }))),
        h(
          'div',
          { class: `projector-clock ${clockState}`, attrs: { role: 'timer', 'aria-live': 'off' } },
          h('p', { class: 'projector-clock-label', text: headerText.label }),
          h('p', { class: `projector-clock-big${header.global && !header.status.passed ? '' : ' is-text'}`, text: headerText.big }),
          header.global
            ? h(
                'div',
                { class: 'projector-horizon' },
                h('span', { text: m.startText }),
                h(
                  'span',
                  { class: 'projector-horizon-bar', attrs: { 'aria-hidden': 'true' } },
                  h('i', { class: 'projector-horizon-done', style: { width: `${(progress * 100).toFixed(2)}%` } }),
                  h('i', { class: 'projector-horizon-sun', style: { left: `${(progress * 100).toFixed(2)}%` } }),
                ),
                h('span', { text: m.sunsetText }),
              )
            : h('p', { class: 'projector-clock-sub', text: headerText.sub }),
        ),
        h(
          'div',
          { class: 'projector-room' },
          h('p', { class: 'projector-room-row' }, h('span', { class: 'projector-room-label', text: '房號' }), h('span', { class: 'projector-room-code', text: m.code })),
          h('p', { class: 'projector-room-note', text: '斷線重開，會回到原來的座位' }),
        ),
      ),
      h(
        'section',
        { class: 'projector-grid', attrs: { 'aria-label': '各桌' } },
        m.cards.map((card) => tableCard(card, m.now)),
      ),
    ),
  ];
}

function tableCard(card, now) {
  const flash = card.flash;
  return h(
    'article',
    { class: `projector-card is-${card.tone}${flash ? ' is-flash' : ''}`, data: { key: `card-${card.table}`, table: card.table } },
    h(
      'div',
      { class: `projector-band is-${card.tone}` },
      h('p', { class: 'projector-band-title' }, h('span', { class: 'projector-band-no', text: `第 ${card.table} 桌` }), h('span', { class: 'projector-band-sub', text: card.band })),
      card.clock ? cardClock(card.clock) : h('span', { class: 'projector-band-latin', text: card.latin, attrs: { lang: 'en' } }),
    ),
    h(
      'div',
      { class: 'projector-card-body' },
      h(
        'div',
        { class: 'projector-card-row' },
        // 響應倒數圈放在圖的右上角，不跟狀態那一行搶位置。
        h(
          'div',
          { class: 'projector-card-art' },
          art(card.art?.kind ?? 'none', card.art?.id ?? null),
          card.seal ? h('span', { class: `projector-seal${card.seal === '否決' ? ' is-failed' : ''}`, text: card.seal }) : null,
          card.countdown ? countdown(card.countdown, now) : null,
        ),
        // 有響應窗口時名稱只留 1 行；狀態那一行最多 2 行（長的縮字，再長就截掉）。
        h(
          'div',
          { class: 'projector-card-text' },
          h('p', { class: 'projector-card-kicker', text: card.kicker }),
          h('p', { class: `projector-card-name${card.countdown ? ' is-one-line' : ''}`, text: card.name }),
          h('p', { class: `projector-card-status${String(card.status).length > STATUS_LONG ? ' is-long' : ''}` }, statusParts(card.status), card.dots ? dots(card.dots) : null),
        ),
      ),
      // 迷霧剛越過門檻的 10 秒：底部那一行換成迷霧事件的名稱（只排 1 行，不蓋住狀態那一行；全名在上面的名稱）。
      flash
        ? h('div', { class: 'projector-flash', attrs: { role: 'status' } }, h('span', { class: 'projector-flash-mark', text: '霧', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'projector-flash-text', text: flash }))
        : card.fog
          ? fogRow(card.fog)
          : null,
    ),
  );
}

// 狀態那一行超過這麼多字就縮小一號（最長的暱稱＋牌名在 16:9 的桌牌上也排得進 2 行）。
const STATUS_LONG = 24;
// 短的一段不從中間斷開（「黑夜揭曉：2 人豪賭・」「2 人分贓・」「2 人睡覺」各自是一段，在「・」之後換行）；
// 比一行還長的段落照常換行，接在後面的字可以排在同一行，不會多佔一行。
const PART_KEEP = 12;

function statusParts(text) {
  return String(text)
    .split(/(?<=・)/)
    .map((part) => h('span', { class: `projector-card-part${part.length <= PART_KEEP ? ' is-keep' : ''}`, text: part }));
}

function cardClock(status) {
  const text = status.passed ? '日落' : `${status.paused ? '暫停 ' : ''}${clockText(status.remaining)}`;
  return h('span', { class: `projector-band-clock${status.passed ? ' is-passed' : status.paused ? ' is-paused' : ''}` }, h('span', { class: 'projector-band-clock-label', text: '日落' }), h('span', { text: status.passed ? '到了' : text }));
}

function countdown({ deadline, seconds }, now) {
  const left = Math.max(0, Math.min(seconds, Math.ceil((deadline - now) / 1000)));
  const turn = seconds > 0 ? left / seconds : 0;
  return h('span', { class: 'projector-count', style: { '--turn': turn.toFixed(3) } }, h('b', { text: left }));
}

function dots({ sent, total }) {
  if (total > 6) return null;
  return h(
    'span',
    { class: 'projector-dots', attrs: { 'aria-hidden': 'true' } },
    Array.from({ length: total }, (_, index) => h('i', { class: index < sent ? 'is-on' : '' })),
  );
}

function fogRow({ value, fired, thresholds }) {
  const hit = new Set(fired);
  const firedText = [...hit].sort((a, b) => a - b).join('、');
  return h(
    'div',
    { class: 'projector-fog', attrs: { role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': value, 'aria-label': `迷霧 ${value}／100${firedText ? `，已觸發 ${firedText}` : ''}` } },
    h('span', { class: 'projector-fog-label', text: '迷霧' }),
    h(
      'span',
      { class: 'projector-fog-bar', attrs: { 'aria-hidden': 'true' } },
      h('i', { class: 'projector-fog-fill', style: { width: `${value}%` } }),
      thresholds.map((threshold) => h('i', { class: `projector-fog-mark${hit.has(threshold) ? ' is-hit' : ''}`, style: { left: `${threshold}%` } })),
    ),
    h('span', { class: 'projector-fog-value' }, String(value), h('small', { text: '／100' })),
  );
}

// ---- 兩場合計排行 ----

const STATUS_TEXT = { playing: '比賽中', idle: '還沒開局' };
const BASIS_TEXT = { combined: '兩場合計', first: '第 1 場' };
const RANK_MARK = { 1: 'Ⅰ', 2: 'Ⅱ', 3: 'Ⅲ' };

// m：{ columns }
export function standingsScene(m) {
  return [
    h('div', { class: 'projector-night', data: { key: 'bg-night' } }),
    h(
      'div',
      { class: 'projector-safe projector-standings projector-reveal', data: { key: 'standings' } },
      h('header', { class: 'projector-scene-head' }, h('h2', { class: 'projector-scene-title', text: '兩場合計排行' }), h('p', { class: 'projector-scene-note', text: '每桌各自排名・比賽中的桌結束後才列出' })),
      h(
        'section',
        { class: 'projector-standing-grid' },
        m.columns.map((column) =>
          h(
            'article',
            { class: `projector-standing is-${column.status}`, data: { key: `standing-${column.table}` } },
            h(
              'header',
              { class: 'projector-standing-head' },
              h('p', { class: 'projector-standing-table', text: `第 ${column.table} 桌` }),
              h('p', { class: 'projector-standing-basis', text: column.status === 'ended' ? BASIS_TEXT[column.basis] : STATUS_TEXT[column.status] }),
            ),
            column.status === 'ended'
              ? h(
                  'ol',
                  { class: 'projector-standing-rows' },
                  column.rows.map((row) =>
                    h(
                      'li',
                      { class: `projector-standing-row is-rank-${row.rank}` },
                      h('span', { class: 'projector-rank', text: RANK_MARK[row.rank] ?? row.rank, attrs: { 'aria-label': `第 ${row.rank} 名` } }),
                      h('span', { class: 'projector-standing-name', text: row.name }),
                      h('span', { class: 'projector-standing-total' }, String(row.total), h('small', { text: ' 分' })),
                      row.first !== null && row.second !== null ? h('span', { class: 'projector-standing-split', text: `第 1 場 ${row.first}・第 2 場 ${row.second}` }) : null,
                    ),
                  ),
                  column.more > 0 ? h('li', { class: 'projector-standing-more', text: `另有 ${column.more} 人同分` }) : null,
                )
              : h('p', { class: 'projector-standing-wait', text: column.status === 'playing' ? '比賽中' : '還沒開局' }),
          ),
        ),
      ),
    ),
  ];
}

// ---- 頒獎 ----

// m：{ pages, index, credits: { full, others, total }, mediaCredits, creditsUrl, reveal }
export function awardsScene(m) {
  const page = m.pages[m.index];
  const key = `awards-${m.index}-${page?.kind}`;
  const body = page ? awardPage(page, m) : [];
  return [
    h('div', { class: 'projector-night projector-night-awards', data: { key: 'bg-awards' } }),
    h('div', { class: `projector-safe projector-awards is-${page?.kind ?? 'none'}${m.reveal ? ' projector-reveal' : ''}`, data: { key } }, body, pageNumber(m.index, m.pages.length)),
  ];
}

function awardPage(page, m) {
  if (page.kind === 'title') {
    return [
      h('p', { class: 'projector-latin', text: 'AWARDS CEREMONY', attrs: { lang: 'en' } }),
      h('h2', { class: 'projector-award-title', text: '頒獎典禮' }),
      h('p', { class: 'projector-award-sub', text: '每桌冠軍・全場最高分' }),
    ];
  }
  if (page.kind === 'champion') {
    const combined = page.basis === 'combined';
    return [
      h('p', { class: 'projector-eyebrow', text: `第 ${page.table} 桌` }),
      h('h2', { class: 'projector-award-title is-small', text: page.winners.length > 1 ? '冠軍（並列）' : '冠軍' }),
      h(
        'div',
        { class: `projector-winners is-${Math.min(page.winners.length, 3)}` },
        page.winners.map((winner) =>
          h(
            'div',
            { class: 'projector-winner' },
            h('span', { class: 'projector-badge' }, winner.role ? h('span', { class: 'projector-badge-img', style: { 'background-image': `url("./assets/roles/${winner.role}.webp")` } }) : null),
            h('p', { class: 'projector-winner-name', text: winner.name }),
            h('p', { class: 'projector-winner-total' }, h('span', { text: combined ? '兩場合計 ' : '第 1 場 ' }), h('b', { text: winner.total }), h('span', { text: ' 分' })),
            combined ? h('p', { class: 'projector-winner-split', text: `第 1 場 ${winner.first} 分・第 2 場 ${winner.second} 分` }) : null,
          ),
        ),
      ),
      h('span', { class: 'projector-award-seal', text: '冠', attrs: { 'aria-hidden': 'true' } }),
    ];
  }
  if (page.kind === 'top') {
    const { top } = page;
    return [
      h('p', { class: 'projector-eyebrow', text: '趣味獎' }),
      h('h2', { class: 'projector-award-title is-small', text: '全場最高分' }),
      top
        ? [
            h('p', { class: 'projector-award-sub', text: top.basis === 'combined' ? '比的是打完兩場的桌的兩場合計（各桌對手不同，只是好玩）' : '比的是第 1 場的總分（各桌對手不同，只是好玩）' }),
            h(
              'div',
              { class: `projector-winners is-${Math.min(top.winners.length, 3)}` },
              top.winners.map((winner) =>
                h('div', { class: 'projector-winner' }, h('p', { class: 'projector-winner-table', text: `第 ${winner.table} 桌` }), h('p', { class: 'projector-winner-name', text: winner.name })),
              ),
            ),
            h('p', { class: 'projector-top-total' }, h('b', { text: top.total }), h('span', { text: ' 分' })),
          ]
        : h('p', { class: 'projector-award-sub', text: '還沒有桌結束' }),
    ];
  }
  return [
    h('h2', { class: 'projector-award-title is-small', text: '素材來源' }),
    h(
      'ul',
      { class: 'projector-credits' },
      [...m.credits.full, ...m.mediaCredits.full].map((entry) => h('li', { class: 'projector-credit', attrs: { lang: 'en' }, text: entry.text })),
    ),
    h('p', { class: 'projector-credits-more', text: `其他 ${m.credits.others} 張圖片（公有領域、CC0 等）的出處與授權：${m.creditsUrl}` }),
    m.mediaCredits.total ? h('p', { class: 'projector-credits-more', text: `影片與音效 ${m.mediaCredits.total} 項，需要署名的已列在上面` }) : null,
  ];
}

// ---- 疊層 ----

// 底部廣播條。m：{ text, time }
export function broadcastBar(m) {
  return h(
    'div',
    { class: `projector-broadcast-bar${m.text.length > 26 ? ' is-long' : ''}`, data: { key: 'broadcast' }, attrs: { role: 'status' } },
    h('span', { class: 'projector-broadcast-tag', text: '主持人廣播' }),
    h('span', { class: 'projector-broadcast-text', text: m.text }),
    h('span', { class: 'projector-broadcast-time', text: m.time }),
  );
}

// 全場暫停。m：{ broadcast, clock（「日落鐘停在 33:52」或空字串） }
export function pauseLayer(m) {
  return h(
    'div',
    { class: 'projector-pause-panel', data: { key: 'pause' }, attrs: { role: 'alert' } },
    h('span', { class: 'projector-pause-icon', attrs: { 'aria-hidden': 'true' } }, h('i'), h('i')),
    h('p', { class: 'projector-pause-title', text: '全場暫停' }),
    h('p', { class: 'projector-pause-sub', text: '請聽主持人說明' }),
    m.broadcast ? h('p', { class: 'projector-pause-broadcast', text: m.broadcast }) : null,
    m.clock ? h('p', { class: 'projector-pause-clock', text: m.clock }) : null,
  );
}

// 開始投影頁。m：{ code, valid, room（找到房間時的說明）, problem, connection, media, wakeNote, cardsNote }
export function startPage(m) {
  return h(
    'div',
    { class: 'projector-start-panel', data: { key: 'start' } },
    h('p', { class: 'projector-eyebrow', text: '投影畫面' }),
    h('p', { class: 'projector-start-code' }, h('span', { class: 'projector-start-label', text: '房號' }), h('span', { class: 'projector-start-value', text: m.code || '—' })),
    h(
      'ul',
      { class: 'projector-start-list' },
      h('li', { class: m.connection.ok ? 'is-ok' : 'is-wait' }, h('span', { class: 'projector-start-mark', text: m.connection.ok ? '✓' : '…', attrs: { 'aria-hidden': 'true' } }), h('span', { text: m.connection.text })),
      h('li', { class: m.problem ? 'is-bad' : m.room ? 'is-ok' : 'is-wait' }, h('span', { class: 'projector-start-mark', text: m.problem ? '!' : m.room ? '✓' : '…', attrs: { 'aria-hidden': 'true' } }), h('span', { text: m.problem || m.room || '讀取房間中…' })),
      h('li', { class: 'is-info' }, h('span', { class: 'projector-start-mark', text: '↓', attrs: { 'aria-hidden': 'true' } }), h('span', { text: m.media })),
      m.cardsNote ? h('li', { class: 'is-bad' }, h('span', { class: 'projector-start-mark', text: '!', attrs: { 'aria-hidden': 'true' } }), h('span', { text: m.cardsNote })) : null,
    ),
    h('button', { class: 'projector-start-button', type: 'button', data: { act: 'start' }, disabled: !m.valid, text: '開始投影' }),
    h('p', { class: 'projector-start-hint', text: '按一下：開聲音、全螢幕、防止螢幕休眠，並開始下載影片與音效。重新整理後要再按一次。' }),
    m.wakeNote ? h('p', { class: 'projector-start-hint is-warn', text: m.wakeNote }) : null,
    h('button', { class: 'projector-start-skip', type: 'button', data: { act: 'skip' }, disabled: !m.valid, text: '先看畫面（不開聲音）' }),
  );
}

// 角落：右上連線狀態、左下聲音與素材、右下回到全螢幕。m：{ connection, sound, media, placeholder, wakeNote, fullscreen }
export function cornerLayer(m) {
  return [
    h('p', { class: `projector-conn${m.connection.ok ? '' : ' is-off'}`, data: { key: 'conn' }, attrs: { role: 'status' } }, h('i', { attrs: { 'aria-hidden': 'true' } }), h('span', { text: m.connection.text })),
    h(
      'div',
      { class: 'projector-notes', data: { key: 'notes' } },
      m.sound ? h('button', { class: 'projector-chip is-sound', type: 'button', data: { act: 'unlock' }, text: '聲音未開，點一下' }) : null,
      m.media ? h('p', { class: 'projector-chip', text: m.media }) : null,
      m.placeholder ? h('p', { class: 'projector-chip is-dim', text: m.placeholder }) : null,
      m.wakeNote ? h('p', { class: 'projector-chip is-warn', text: m.wakeNote }) : null,
    ),
    m.fullscreen ? h('button', { class: 'projector-chip projector-fullscreen', type: 'button', data: { key: 'fullscreen', act: 'fullscreen' }, text: '回到全螢幕' }) : null,
  ];
}

// 房號不對、找不到房間時整個舞台只寫這一段。m：{ title, text }
export function messageScene(m) {
  return [
    h('div', { class: 'projector-night', data: { key: 'bg-night' } }),
    h('div', { class: 'projector-safe projector-message', data: { key: 'message' } }, h('p', { class: 'projector-message-title', text: m.title }), m.text ? h('p', { class: 'projector-message-text', text: m.text }) : null),
  ];
}
