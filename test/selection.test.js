const { test } = require('node:test');
const assert = require('node:assert/strict');
const { weightedRandomPick, getActiveOptions, getSpinPool, canSpin } = require('../app.js');

function seededRng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

test('weighted selection roughly matches weights over many trials', () => {
  const options = [
    { id: 'a', text: 'A', weight: 1, color: '#000' },
    { id: 'b', text: 'B', weight: 3, color: '#000' },
    { id: 'c', text: 'C', weight: 6, color: '#000' },
  ];
  const counts = { a: 0, b: 0, c: 0 };
  const rng = seededRng(42);
  const trials = 20000;
  for (let i = 0; i < trials; i += 1) {
    const winner = weightedRandomPick(options, { rng });
    counts[winner] += 1;
  }
  assert.ok(Math.abs(counts.a / trials - 0.1) < 0.02, `a ratio was ${counts.a / trials}`);
  assert.ok(Math.abs(counts.b / trials - 0.3) < 0.02, `b ratio was ${counts.b / trials}`);
  assert.ok(Math.abs(counts.c / trials - 0.6) < 0.02, `c ratio was ${counts.c / trials}`);
});

test('never selects an option with weight 0', () => {
  const options = [
    { id: 'a', text: 'A', weight: 0, color: '#000' },
    { id: 'b', text: 'B', weight: 5, color: '#000' },
  ];
  for (let i = 0; i < 500; i += 1) {
    const winner = weightedRandomPick(options, { rng: Math.random });
    assert.equal(winner, 'b');
  }
});

test('never selects an option outside the active pool when no-repeat is active', () => {
  const options = [
    { id: 'a', text: 'A', weight: 1, color: '#000' },
    { id: 'b', text: 'B', weight: 1, color: '#000' },
    { id: 'c', text: 'C', weight: 1, color: '#000' },
  ];
  const removedIds = ['a', 'c'];
  const pool = getSpinPool(options, removedIds, true);
  assert.deepEqual(pool.map((o) => o.id), ['b']);
  for (let i = 0; i < 200; i += 1) {
    const winner = weightedRandomPick(pool, { rng: Math.random });
    assert.equal(winner, 'b');
  }
});

test('equal-odds mode ignores stored weights', () => {
  const options = [
    { id: 'a', text: 'A', weight: 1, color: '#000' },
    { id: 'b', text: 'B', weight: 99, color: '#000' },
  ];
  const counts = { a: 0, b: 0 };
  const rng = seededRng(7);
  const trials = 20000;
  for (let i = 0; i < trials; i += 1) {
    const winner = weightedRandomPick(options, { equalOdds: true, rng });
    counts[winner] += 1;
  }
  assert.ok(Math.abs(counts.a / trials - 0.5) < 0.02, `a ratio was ${counts.a / trials}`);
});

test('getActiveOptions excludes removed ids', () => {
  const options = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const active = getActiveOptions(options, ['b']);
  assert.deepEqual(active.map((o) => o.id), ['a', 'c']);
});

test('canSpin requires at least 2 positive-weight options', () => {
  assert.equal(canSpin([{ weight: 1 }, { weight: 1 }]), true);
  assert.equal(canSpin([{ weight: 1 }]), false);
  assert.equal(canSpin([{ weight: 1 }, { weight: 0 }]), false);
  assert.equal(canSpin([]), false);
});

test('weightedRandomPick returns null for an empty pool', () => {
  assert.equal(weightedRandomPick([], { rng: Math.random }), null);
});
