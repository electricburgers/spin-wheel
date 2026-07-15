const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeSliceAngles, findSliceMidAngle, computeWinningRotation, normalizeAngle } = require('../app.js');

const TWO_PI = 2 * Math.PI;

function sumAngles(slices) {
  return slices.reduce((a, s) => a + s.angle, 0);
}

test('angles sum to exactly 2π for a single option', () => {
  const slices = computeSliceAngles([{ id: 'a', weight: 1 }]);
  assert.equal(slices.length, 1);
  assert.ok(Math.abs(sumAngles(slices) - TWO_PI) < 1e-9);
  assert.ok(Math.abs(slices[0].endAngle - TWO_PI) < 1e-9);
});

test('angles sum to exactly 2π for 50 equal-weight options', () => {
  const options = Array.from({ length: 50 }, (_, i) => ({ id: `o${i}`, weight: 1 }));
  const slices = computeSliceAngles(options);
  assert.equal(slices.length, 50);
  assert.ok(Math.abs(sumAngles(slices) - TWO_PI) < 1e-9);
  slices.forEach((s) => {
    assert.ok(s.angle > 0);
    assert.ok(!Number.isNaN(s.angle));
    assert.ok(Math.abs(s.angle - TWO_PI / 50) < 1e-6);
  });
});

test('angles sum to exactly 2π for highly skewed weights', () => {
  const options = [
    { id: 'a', weight: 0.01 },
    { id: 'b', weight: 500 },
    { id: 'c', weight: 1 },
  ];
  const slices = computeSliceAngles(options);
  assert.ok(Math.abs(sumAngles(slices) - TWO_PI) < 1e-9);
  slices.forEach((s) => {
    assert.ok(s.angle >= 0);
    assert.ok(!Number.isNaN(s.angle));
  });
});

test('no negative or NaN angles across many random weight sets', () => {
  for (let trial = 0; trial < 200; trial += 1) {
    const n = 1 + Math.floor(Math.random() * 50);
    const options = Array.from({ length: n }, (_, i) => ({ id: `o${i}`, weight: Math.random() * 100 + 0.001 }));
    const slices = computeSliceAngles(options);
    let total = 0;
    for (const s of slices) {
      assert.ok(s.angle >= 0, `negative angle for n=${n}`);
      assert.ok(!Number.isNaN(s.angle), `NaN angle for n=${n}`);
      total += s.angle;
    }
    assert.ok(Math.abs(total - TWO_PI) < 1e-6);
  }
});

test('equal-odds mode ignores weights for slice sizing', () => {
  const options = [{ id: 'a', weight: 1 }, { id: 'b', weight: 99 }];
  const slices = computeSliceAngles(options, { equalOdds: true });
  assert.ok(Math.abs(slices[0].angle - slices[1].angle) < 1e-9);
});

test('findSliceMidAngle locates the right slice', () => {
  const options = [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }];
  const slices = computeSliceAngles(options);
  assert.ok(Math.abs(findSliceMidAngle(slices, 'a') - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(findSliceMidAngle(slices, 'b') - (Math.PI + Math.PI / 2)) < 1e-9);
});

test('computeWinningRotation lands the target mid-angle at the pointer from a standing start (rotation 0)', () => {
  const midAngle = 1.234;
  const rotation = computeWinningRotation(midAngle, 5, 0);
  const landed = normalizeAngle(midAngle + rotation);
  assert.ok(Math.abs(landed) < 1e-6 || Math.abs(landed - TWO_PI) < 1e-6);
  assert.ok(rotation >= 5 * TWO_PI);
});

test('computeWinningRotation still lands correctly when the wheel already has a nonzero rotation', () => {
  // Regression test: an earlier version of computeWinningRotation ignored the wheel's current
  // rotation entirely, computing the delta as if spinning from a standing start every time.
  // That only happened to land correctly on the very first spin of a session (when rotation
  // really was 0) — every spin after that left the wheel pre-rotated by the previous spin's
  // landing angle, and recomputing "as if from zero" landed on the wrong slice by exactly that
  // leftover amount. This fixes a fresh, arbitrary current rotation each time.
  const cases = [0.5, 3.0, 5.9, Math.PI, 0.001, 6.28];
  for (const currentRotation of cases) {
    const midAngle = 2.7;
    const rotation = computeWinningRotation(midAngle, 4, currentRotation);
    const finalRotation = normalizeAngle(currentRotation + rotation);
    const landed = normalizeAngle(midAngle + finalRotation);
    assert.ok(
      Math.abs(landed) < 1e-6 || Math.abs(landed - TWO_PI) < 1e-6,
      `currentRotation=${currentRotation}: expected landed≈0, got ${landed}`,
    );
  }
});

test('a sequence of spins each lands on its own winner, with rotation accumulating exactly like the app does', () => {
  // Mirrors app.js's real usage: wheelRotation persists and accumulates across spins, and each
  // spin's rotation delta is computed from whatever wheelRotation currently is (not from 0).
  let wheelRotation = 0;
  const rng = (() => { let s = 99; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
  for (let i = 0; i < 30; i += 1) {
    const midAngle = rng() * TWO_PI;
    const spins = 3 + Math.floor(rng() * 8);
    const rotation = computeWinningRotation(midAngle, spins, wheelRotation);
    wheelRotation = normalizeAngle(wheelRotation + rotation);
    const landed = normalizeAngle(midAngle + wheelRotation);
    assert.ok(
      Math.abs(landed) < 1e-6 || Math.abs(landed - TWO_PI) < 1e-6,
      `spin ${i}: expected landed≈0, got ${landed}`,
    );
  }
});
