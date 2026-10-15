import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRM_CODE_LENGTH,
  PHASES,
  PHASE_LABELS,
  ROOM_CODE_ALPHABET,
  advanceFog,
  applyFog,
  clampFog,
  confirmCode,
  generateRoomCode,
  hostUids,
  initialTable,
  isHostOf,
  isRoomCode,
  isValidName,
  isValidTable,
  nextStep,
  normalizeName,
  normalizeRoomCode,
} from '../../play/js/rules.js';

test('a table starts at round 1, sunrise, with no fog', () => {
  assert.deepEqual(initialTable(), { round: 1, phase: 'sunrise', fog: 0 });
});

test('the four phases advance in order within a round', () => {
  let state = { round: 1, phase: 'sunrise' };
  const seen = [state.phase];
  for (let i = 0; i < 3; i += 1) {
    state = nextStep(state);
    seen.push(state.phase);
    assert.equal(state.round, 1);
  }
  assert.deepEqual(seen, ['sunrise', 'day', 'dusk', 'night']);
  assert.deepEqual(seen, PHASES);
});

test('night is followed by sunrise of the next round', () => {
  assert.deepEqual(nextStep({ round: 1, phase: 'night' }), { round: 2, phase: 'sunrise' });
  assert.deepEqual(nextStep({ round: 7, phase: 'night' }), { round: 8, phase: 'sunrise' });
});

test('nextStep rejects unknown phases and invalid rounds', () => {
  assert.throws(() => nextStep({ round: 1, phase: 'noon' }), RangeError);
  assert.throws(() => nextStep({ round: 0, phase: 'day' }), RangeError);
  assert.throws(() => nextStep({ round: 1.5, phase: 'day' }), RangeError);
});

test('every phase has a display label', () => {
  assert.deepEqual(PHASES.map((phase) => PHASE_LABELS[phase]), ['日出', '白晝', '黃昏', '黑夜']);
});

test('fog is clamped to 0–100', () => {
  assert.equal(clampFog(-5), 0);
  assert.equal(clampFog(0), 0);
  assert.equal(clampFog(42), 42);
  assert.equal(clampFog(100), 100);
  assert.equal(clampFog(250), 100);
  assert.equal(clampFog(Number.NaN), 0);
  assert.equal(applyFog(95, 20).fog, 100);
  assert.equal(applyFog(10, -40).fog, 0);
});

test('crossing several thresholds at once reports all of them', () => {
  assert.deepEqual(applyFog(25, 70), { fog: 95, crossed: [30, 60, 90] });
  assert.deepEqual(applyFog(25, 10), { fog: 35, crossed: [30] });
  assert.deepEqual(applyFog(61, 500), { fog: 100, crossed: [90] });
});

test('a threshold is crossed only when fog goes above it', () => {
  assert.deepEqual(applyFog(25, 5), { fog: 30, crossed: [] });
  assert.deepEqual(applyFog(30, 1), { fog: 31, crossed: [30] });
  assert.deepEqual(applyFog(40, 5), { fog: 45, crossed: [] });
});

test('falling fog reports no thresholds', () => {
  assert.deepEqual(applyFog(95, -70), { fog: 25, crossed: [] });
  assert.deepEqual(applyFog(61, -1), { fog: 60, crossed: [] });
  assert.deepEqual(applyFog(50, 0), { fog: 50, crossed: [] });
});

test('advanceFog: landing exactly on a threshold does not fire it', () => {
  assert.deepEqual(advanceFog({ fog: 25, fogMax: 25, fired: [] }, 5), { fog: 30, fogMax: 30, fired: [], crossed: [] });
  assert.deepEqual(advanceFog({ fog: 30, fogMax: 30, fired: [] }, 1), { fog: 31, fogMax: 31, fired: [30], crossed: [30] });
});

test('advanceFog: crossing several thresholds at once fires them from low to high', () => {
  assert.deepEqual(advanceFog({ fog: 25, fogMax: 25, fired: [] }, 70), { fog: 95, fogMax: 95, fired: [30, 60, 90], crossed: [30, 60, 90] });
  assert.deepEqual(advanceFog({ fog: 0, fogMax: 0, fired: [] }, 50, [40, 20, 80]).crossed, [20, 40]);
});

test('advanceFog: each threshold fires once per game, even after fog falls and rises again', () => {
  let state = { fog: 25, fogMax: 25, fired: [] };
  const steps = [10, -10, 10, 40, -60, 80];
  const crossed = steps.map((delta) => {
    state = advanceFog(state, delta);
    return state.crossed;
  });
  assert.deepEqual(crossed, [[30], [], [], [60], [], [90]]);
  assert.deepEqual(state, { fog: 95, fogMax: 95, fired: [30, 60, 90], crossed: [90] });
});

test('advanceFog keeps the highest fog of the game', () => {
  const high = advanceFog({ fog: 50, fogMax: 50, fired: [30] }, 45);
  assert.equal(high.fogMax, 95);
  const low = advanceFog(high, -80);
  assert.deepEqual(low, { fog: 15, fogMax: 95, fired: [30, 60, 90], crossed: [] });
  assert.equal(advanceFog(low, 10).fogMax, 95);
});

test('advanceFog clamps fog to 0–100', () => {
  assert.deepEqual(advanceFog({ fog: 61, fogMax: 61, fired: [30, 60] }, 500), { fog: 100, fogMax: 100, fired: [30, 60, 90], crossed: [90] });
  assert.deepEqual(advanceFog({ fog: 10, fogMax: 40, fired: [30] }, -500), { fog: 0, fogMax: 40, fired: [30], crossed: [] });
  assert.equal(advanceFog({ fog: 10, fogMax: 10, fired: [] }, Number.NaN).fog, 0);
});

test('advanceFog accepts older states that miss fogMax or fired', () => {
  assert.deepEqual(advanceFog(initialTable(), 31), { fog: 31, fogMax: 31, fired: [30], crossed: [30] });
  assert.deepEqual(advanceFog({ fog: 10 }, 5), { fog: 15, fogMax: 15, fired: [], crossed: [] });
  assert.deepEqual(advanceFog({}, 65), { fog: 65, fogMax: 65, fired: [30, 60], crossed: [30, 60] });
  assert.deepEqual(advanceFog(undefined, 0), { fog: 0, fogMax: 0, fired: [], crossed: [] });
  // 傳進來的狀態不會被改到。
  const state = { fog: 25, fogMax: 25, fired: [] };
  advanceFog(state, 70);
  assert.deepEqual(state, { fog: 25, fogMax: 25, fired: [] });
});

test('room codes are 6 characters from the unambiguous alphabet', () => {
  assert.equal(ROOM_CODE_ALPHABET.length, 31);
  for (const confusing of '0O1IL') assert.ok(!ROOM_CODE_ALPHABET.includes(confusing));
  assert.match(ROOM_CODE_ALPHABET, /^[A-Z2-9]+$/);
  for (let i = 0; i < 500; i += 1) {
    const code = generateRoomCode();
    assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
    assert.ok(isRoomCode(code));
  }
});

test('room code generation skips bytes that would bias the alphabet', () => {
  const batches = [[255, 250, 248, 0, 1, 2], [3, 4, 5, 6, 7, 8]];
  const code = generateRoomCode(() => batches.shift());
  assert.equal(code, 'ABCDEF');
});

test('room code input is normalised and checked', () => {
  assert.equal(normalizeRoomCode(' ab c2 34 '), 'ABC234');
  assert.equal(normalizeRoomCode(undefined), '');
  assert.ok(isRoomCode('ABC234'));
  assert.ok(!isRoomCode('ABC23'));
  assert.ok(!isRoomCode('ABC2345'));
  assert.ok(!isRoomCode('ABCD10'));
  assert.ok(!isRoomCode('ABCDOL'));
  assert.ok(!isRoomCode('abc234'));
  assert.ok(!isRoomCode(123456));
});

test('names are trimmed and must be 1–12 characters', () => {
  assert.equal(normalizeName('  小明  '), '小明');
  assert.equal(normalizeName(null), '');
  assert.ok(isValidName(normalizeName('  小明  ')));
  assert.ok(isValidName('a'));
  assert.ok(isValidName('一二三四五六七八九十十一'.slice(0, 12)));
  assert.ok(isValidName('abcdefghijkl'));
  assert.ok(!isValidName('abcdefghijklm'));
  assert.ok(!isValidName(normalizeName('   ')));
  assert.ok(!isValidName(' 小明'));
  assert.ok(!isValidName(42));
});

test('table numbers are integers within the table count', () => {
  assert.ok(isValidTable(1));
  assert.ok(isValidTable(6));
  assert.ok(!isValidTable(0));
  assert.ok(!isValidTable(7));
  assert.ok(!isValidTable(2.5));
  assert.ok(!isValidTable('3'));
  assert.ok(isValidTable(3, 3));
  assert.ok(!isValidTable(4, 3));
});

test('the room creator and approved devices are hosts', () => {
  const room = { meta: { hostUid: 'creator' }, hosts: { backup: true, creator: true, odd: false } };
  assert.deepEqual(hostUids(room), ['creator', 'backup']);
  assert.ok(isHostOf(room, 'creator'));
  assert.ok(isHostOf(room, 'backup'));
  assert.ok(!isHostOf(room, 'odd'));
  assert.ok(!isHostOf(room, 'player'));
  assert.deepEqual(hostUids({ meta: { hostUid: 'creator' } }), ['creator']);
  assert.deepEqual(hostUids(null), []);
  assert.ok(!isHostOf(null, 'creator'));
});

test('confirmation codes are 4 characters from the room code alphabet', () => {
  assert.equal(CONFIRM_CODE_LENGTH, 4);
  for (const uid of ['a', 'uid-1', 'Zk3vQ9xT1mYb7LpR2sWd8uNc4eHf', '', '測試']) {
    const code = confirmCode(uid);
    assert.equal(code.length, 4);
    assert.ok([...code].every((char) => ROOM_CODE_ALPHABET.includes(char)), code);
  }
});

test('the same uid always gives the same confirmation code', () => {
  const uid = 'Zk3vQ9xT1mYb7LpR2sWd8uNc4eHf';
  assert.equal(confirmCode(uid), confirmCode(uid));
  assert.equal(confirmCode(uid), confirmCode(`${uid}`));
  assert.equal(confirmCode('uid-1'), 'M6BJ');
});

test('different uids mostly give different confirmation codes', () => {
  const codes = new Set();
  for (let i = 0; i < 1000; i += 1) codes.add(confirmCode(`uid-${i}`));
  assert.ok(codes.size >= 990, `only ${codes.size} distinct codes for 1000 uids`);
  assert.notEqual(confirmCode('Zk3vQ9xT1mYb7LpR2sWd8uNc4eHf'), confirmCode('Zk3vQ9xT1mYb7LpR2sWd8uNc4eHg'));
});
