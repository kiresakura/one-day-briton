import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DATA_FILES } from '../../play/js/data.js';
import {
  FIRST_SUNRISE_PAYS,
  MAX_SEATS,
  SUGGESTED_SEATS,
  assignSeats,
  buildDeck,
  checkSeating,
  cryptoRandom,
  draw,
  pickDestiny,
  randomBelow,
  seatsInOrder,
  shuffle,
  startGame,
  sunrise,
} from '../../play/js/game.js';
import { indexGameData, loadGameData } from '../../play/js/gamedata.js';

const cardDir = new URL('../../play/data/', import.meta.url);
const readCardFile = async (kind) => JSON.parse(await readFile(new URL(`${kind}.json`, cardDir), 'utf8'));
const { data, errors: loadErrors } = await loadGameData(readCardFile);

// 固定種子的亂數來源（mulberry32），每次回傳 0 到 2^32−1 的整數。
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
}

const uidsOf = (count) => Array.from({ length: count }, (_, index) => `uid-${index + 1}`);
const sorted = (list) => [...list].sort();
const fullDeck = () => buildDeck(data.actions);

// 牌一張都沒有多、沒有少：所有人的手牌＋牌庫＋棄牌堆合起來，正好是展開後的整副牌。
function assertCardsConserved(state) {
  const cards = [...Object.values(state.hands).flat(), ...state.deck, ...state.discard];
  assert.deepEqual(sorted(cards), sorted(fullDeck()));
}

test('the card data loads through the injected reader with no errors', () => {
  assert.deepEqual(loadErrors, []);
  assert.deepEqual(Object.keys(data).sort(), [...DATA_FILES].sort());
});

test('a missing or broken data file is reported as an error', async () => {
  const missing = await loadGameData(async (kind) => {
    if (kind === 'actions') throw new Error('HTTP 404');
    return readCardFile(kind);
  });
  assert.equal(missing.errors.length, 1);
  assert.match(missing.errors[0], /actions\.json.*HTTP 404/);

  const broken = await loadGameData(async (kind) => {
    const content = await readCardFile(kind);
    if (kind === 'settings') content.startingHand = -1;
    return content;
  });
  assert.ok(broken.errors.some((line) => /settings\.json.*startingHand/.test(line)), broken.errors.join('\n'));
});

test('the deck holds every action card as many times as its copies', () => {
  const deck = fullDeck();
  const copies = data.actions.reduce((sum, action) => sum + action.copies, 0);
  assert.equal(deck.length, copies);
  assert.equal(deck.length, 61, 'the current card data adds up to 61 cards');
  for (const action of data.actions) {
    assert.equal(deck.filter((id) => id === action.id).length, action.copies, action.id);
  }
  assert.ok(deck.some((id) => data.actions.find((action) => action.id === id).kind === 'response'), 'response cards are in the deck');
});

test('random numbers stay in range and skip the uneven tail', () => {
  const random = seeded(1);
  for (let index = 0; index < 1000; index += 1) {
    const value = randomBelow(6, random);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 6);
  }
  // 2^32−1 落在尾段（取 6 的餘數會偏向前幾個數），要丟掉再拿下一個。
  const values = [2 ** 32 - 1, 13];
  assert.equal(randomBelow(6, () => values.shift()), 1);
  assert.equal(values.length, 0);
  assert.throws(() => randomBelow(0), RangeError);
  const value = cryptoRandom();
  assert.ok(Number.isInteger(value) && value >= 0 && value < 2 ** 32);
});

test('shuffling returns a permutation and leaves the input alone', () => {
  const deck = fullDeck();
  const before = [...deck];
  const shuffled = shuffle(deck, seeded(7));
  assert.deepEqual(deck, before);
  assert.equal(shuffled.length, deck.length);
  assert.deepEqual(sorted(shuffled), sorted(deck));
  assert.notDeepEqual(shuffled, deck);
  assert.deepEqual(shuffle(deck, seeded(7)), shuffled, 'the same seed gives the same order');
  assert.deepEqual(shuffle([], seeded(7)), []);
  // 預設來源也是排列。
  assert.deepEqual(sorted(shuffle(deck)), sorted(deck));
});

test('every ordering of a small list can come out of the shuffle', () => {
  const random = seeded(3);
  const seen = new Map();
  for (let index = 0; index < 6000; index += 1) {
    const key = shuffle(['a', 'b', 'c'], random).join('');
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  assert.equal(seen.size, 6);
  for (const count of seen.values()) assert.ok(count > 800 && count < 1200, `${count}`);
});

test('seating checks the head count', () => {
  assert.equal(MAX_SEATS, 6);
  assert.equal(SUGGESTED_SEATS, 3);
  assert.match(checkSeating(0).error, /還沒有玩家/);
  assert.match(checkSeating(7).error, /最多 6 人/);
  assert.deepEqual(checkSeating(3), { error: null, warning: null });
  assert.deepEqual(checkSeating(6), { error: null, warning: null });
  assert.equal(checkSeating(1).error, null);
  assert.match(checkSeating(2).warning, /建議至少 3 人/);
  assert.match(checkSeating(6, 5).error, /最多 5 人/, 'fewer roles in the data means fewer seats');
});

test('one to six players get distinct roles from the data and random seat order', () => {
  const roleIds = data.roles.map((role) => role.id);
  for (let count = 1; count <= 6; count += 1) {
    const uids = uidsOf(count);
    const seats = assignSeats(uids, data.roles, seeded(count));
    assert.equal(seats.length, count);
    assert.deepEqual(sorted(seats.map((seat) => seat.uid)), sorted(uids));
    assert.deepEqual(
      seats.map((seat) => seat.order),
      Array.from({ length: count }, (_, index) => index),
    );
    const roles = seats.map((seat) => seat.role);
    assert.equal(new Set(roles).size, count, 'no role twice');
    for (const role of roles) assert.ok(roleIds.includes(role), role);
  }
  // 種子不同，座位順序與階層會變；所有階層都可能被分到。
  const seen = new Set();
  const orders = new Set();
  for (let seed = 0; seed < 50; seed += 1) {
    const seats = assignSeats(uidsOf(3), data.roles, seeded(seed));
    seats.forEach((seat) => seen.add(seat.role));
    orders.add(seats.map((seat) => seat.uid).join());
  }
  assert.deepEqual(sorted(seen), sorted(roleIds));
  assert.ok(orders.size > 1);
});

test('seating rejects an empty table and more than six players', () => {
  assert.throws(() => assignSeats([], data.roles, seeded(1)), /還沒有玩家/);
  assert.throws(() => assignSeats(uidsOf(7), data.roles, seeded(1)), /最多 6 人/);
  assert.equal(assignSeats(['x', 'x', 'y'], data.roles, seeded(1)).length, 2, 'the same player is seated once');
});

test('a destiny comes from the player role, then from roleless ones, then none', () => {
  const destinies = [
    { id: 'd1', role: 'r1' },
    { id: 'd2', role: 'r1' },
    { id: 'd3', role: null },
    { id: 'd4', role: 'r2' },
  ];
  const random = seeded(5);
  for (let index = 0; index < 20; index += 1) assert.ok(['d1', 'd2'].includes(pickDestiny(destinies, 'r1', new Set(), random)));
  assert.equal(pickDestiny(destinies, 'r3', new Set(), random), 'd3', 'no destiny of that role: a roleless one');
  assert.equal(pickDestiny(destinies, 'r1', new Set(['d1', 'd2']), random), 'd3', 'own ones already dealt');
  assert.equal(pickDestiny(destinies, 'r3', new Set(['d3']), random), null, 'nothing left');
  assert.equal(pickDestiny([], 'r1', new Set(), random), null);

  // 目前的資料：每個階層都有自己的天命。
  for (const role of data.roles) {
    const id = pickDestiny(data.destinies, role.id, new Set(), seeded(9));
    assert.equal(data.destinies.find((destiny) => destiny.id === id).role, role.id);
  }
});

test('drawing takes from the top of the deck', () => {
  const result = draw({ deck: ['a', 'b', 'c'], discard: ['x'] }, 2, seeded(1));
  assert.deepEqual(result, { deck: ['c'], discard: ['x'], drawn: ['a', 'b'] });
  assert.deepEqual(draw({ deck: ['a'], discard: [] }, 0, seeded(1)), { deck: ['a'], discard: [], drawn: [] });
});

test('drawing past the end of the deck shuffles the discard pile back in', () => {
  const pile = { deck: ['a', 'b'], discard: ['x', 'y', 'z'] };
  const result = draw(pile, 4, seeded(2));
  assert.deepEqual(result.drawn.slice(0, 2), ['a', 'b'], 'the rest of the deck first');
  assert.equal(result.drawn.length, 4);
  assert.deepEqual(result.discard, []);
  assert.equal(result.deck.length, 1);
  assert.deepEqual(sorted([...result.drawn.slice(2), ...result.deck]), ['x', 'y', 'z']);
  assert.deepEqual(pile, { deck: ['a', 'b'], discard: ['x', 'y', 'z'] }, 'the input is not changed');
});

test('drawing stops when both the deck and the discard pile are empty', () => {
  assert.deepEqual(draw({ deck: ['a'], discard: ['b'] }, 5, seeded(1)), { deck: [], discard: [], drawn: ['a', 'b'] });
  assert.deepEqual(draw({ deck: [], discard: [] }, 2, seeded(1)), { deck: [], discard: [], drawn: [] });
});

test('sunrise pays each player the salary of their role and draws for them in seat order', () => {
  const roles = [
    { id: 'r1', salary: 5 },
    { id: 'r2', salary: 7 },
  ];
  const state = {
    seats: {
      later: { order: 1, role: 'r2', pounds: 1, influence: 2, handCount: 1 },
      first: { order: 0, role: 'r1', pounds: 0, influence: 3, handCount: 0 },
    },
    hands: { later: ['h'] },
    destinies: { later: 'd1', first: null },
    deck: ['a', 'b', 'c', 'd', 'e'],
    discard: [],
  };
  const next = sunrise(state, { roles, settings: { drawPerSunrise: 2 } }, seeded(1));
  assert.deepEqual(next.seats.first, { order: 0, role: 'r1', pounds: 5, influence: 3, handCount: 2 });
  assert.deepEqual(next.seats.later, { order: 1, role: 'r2', pounds: 8, influence: 2, handCount: 3 });
  assert.deepEqual(next.hands, { first: ['a', 'b'], later: ['h', 'c', 'd'] });
  assert.deepEqual(next.destinies, state.destinies);
  assert.deepEqual(next.deck, ['e']);
  assert.deepEqual(state.deck, ['a', 'b', 'c', 'd', 'e'], 'the input is not changed');

  // 牌庫與棄牌堆都空了：照樣領薪，不抽牌。
  const dry = sunrise({ ...next, deck: [], discard: [] }, { roles, settings: { drawPerSunrise: 2 } }, seeded(1));
  assert.deepEqual(dry.hands, next.hands);
  assert.equal(dry.seats.first.pounds, 10);
  assert.equal(dry.seats.later.pounds, 15);

  assert.throws(() => sunrise({ ...state, seats: { x: { order: 0, role: 'r9', pounds: 0, influence: 0, handCount: 0 } } }, { roles, settings: { drawPerSunrise: 2 } }), /r9/);
});

test('after the start every player has the starting values plus the first sunrise', () => {
  const { settings } = data;
  const salaryOf = (role) => data.roles.find((record) => record.id === role).salary;
  assert.equal(FIRST_SUNRISE_PAYS, true, 'confirmed: the first sunrise pays and draws too');
  for (let count = 1; count <= 6; count += 1) {
    const uids = uidsOf(count);
    const state = startGame(data, uids, { random: seeded(100 + count) });
    assert.deepEqual(sorted(Object.keys(state.seats)), sorted(uids));
    for (const uid of uids) {
      const seat = state.seats[uid];
      // 起始英鎊＋自己階層的薪水；起始影響力；起始手牌＋日出抽牌。
      assert.equal(seat.pounds, settings.startingPounds + salaryOf(seat.role));
      assert.equal(seat.influence, settings.startingInfluence);
      assert.equal(state.hands[uid].length, settings.startingHand + settings.drawPerSunrise);
      assert.equal(seat.handCount, state.hands[uid].length);
      assert.equal(data.destinies.find((destiny) => destiny.id === state.destinies[uid]).role, seat.role);
    }
    assert.equal(new Set(Object.values(state.destinies)).size, count, 'no destiny twice');
    assert.equal(state.deck.length, 61 - count * (settings.startingHand + settings.drawPerSunrise));
    assert.deepEqual(state.discard, []);
    assertCardsConserved(state);
  }
});

test('with the current data and settings a player starts with 15 pounds, 3 influence and 6 cards', () => {
  const state = startGame(data, uidsOf(6), { random: seeded(42) });
  for (const seat of Object.values(state.seats)) {
    assert.deepEqual({ pounds: seat.pounds, influence: seat.influence, handCount: seat.handCount }, { pounds: 15, influence: 3, handCount: 6 });
  }
  assert.equal(state.deck.length, 61 - 36);
});

test('without the first sunrise a player only has the starting values', () => {
  const state = startGame(data, uidsOf(2), { random: seeded(8), firstSunrise: false });
  for (const seat of Object.values(state.seats)) {
    assert.deepEqual({ pounds: seat.pounds, influence: seat.influence, handCount: seat.handCount }, { pounds: 10, influence: 3, handCount: 4 });
  }
  assert.equal(state.deck.length, 61 - 8);
  assertCardsConserved(state);
});

test('the same seed deals the same game, a different seed a different one', () => {
  const uids = uidsOf(4);
  assert.deepEqual(startGame(data, uids, { random: seeded(11) }), startGame(data, uids, { random: seeded(11) }));
  assert.notDeepEqual(startGame(data, uids, { random: seeded(11) }).deck, startGame(data, uids, { random: seeded(12) }).deck);
});

test('later sunrises keep paying and drawing until the cards run out', () => {
  let state = startGame(data, uidsOf(6), { random: seeded(21) });
  const random = seeded(22);
  state = sunrise(state, data, random); // 第 2 回合
  for (const seat of Object.values(state.seats)) assert.deepEqual([seat.pounds, seat.handCount], [20, 8]);
  assert.equal(state.deck.length, 13);
  state = sunrise(state, data, random); // 第 3 回合
  assert.equal(state.deck.length, 1);
  state = sunrise(state, data, random); // 第 4 回合：只剩 1 張，第一個座位抽到，其他人沒得抽
  const [[firstUid], ...rest] = seatsInOrder(state.seats);
  assert.equal(state.seats[firstUid].handCount, 11);
  for (const [uid] of rest) assert.equal(state.seats[uid].handCount, 10);
  assert.deepEqual([state.deck, state.discard], [[], []]);
  for (const seat of Object.values(state.seats)) assert.equal(seat.pounds, 30);
  assertCardsConserved(state);
});

test('card ids can be looked up for display', () => {
  const index = indexGameData(data);
  assert.equal(index.roles.get('r1').name, data.roles[0].name);
  assert.equal(index.actions.get(data.actions[0].id), data.actions[0]);
  assert.equal(index.destinies.size, data.destinies.length);
  assert.equal(indexGameData({}).roles.size, 0);
});
