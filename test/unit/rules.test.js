import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASES,
  PHASE_LABELS,
  ROOM_CODE_ALPHABET,
  applyFog,
  clampFog,
  generateRoomCode,
  initialTable,
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
