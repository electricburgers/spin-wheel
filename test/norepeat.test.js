const { test } = require('node:test');
const assert = require('node:assert/strict');
const { removeFromPool, resetPool, getActiveOptions, canSpin, getSpinPool } = require('../app.js');

test('winner removed from pool via removeFromPool', () => {
  let removed = [];
  removed = removeFromPool(removed, 'a');
  assert.deepEqual(removed, ['a']);
  removed = removeFromPool(removed, 'b');
  assert.deepEqual(removed, ['a', 'b']);
});

test('removeFromPool is idempotent for an id already removed', () => {
  const removed = ['a'];
  assert.deepEqual(removeFromPool(removed, 'a'), ['a']);
});

test('resetPool clears removed ids, restoring all options', () => {
  const options = [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }];
  const removed = resetPool();
  assert.deepEqual(removed, []);
  assert.deepEqual(getActiveOptions(options, removed).map((o) => o.id), ['a', 'b', 'c']);
});

test('spin is blocked when the pool has fewer than 2 options', () => {
  const options = [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }];
  const removed = ['a', 'b'];
  const pool = getSpinPool(options, removed);
  assert.equal(pool.length, 1);
  assert.equal(canSpin(pool), false);
});

test('spin is blocked when the pool is fully exhausted', () => {
  const options = [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }];
  const removed = ['a', 'b'];
  const pool = getSpinPool(options, removed);
  assert.equal(pool.length, 0);
  assert.equal(canSpin(pool), false);
});

test('getSpinPool always excludes removedIds — the no-repeat toggle only gates automatic removal at the app layer, not pool math', () => {
  const options = [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }];
  const pool = getSpinPool(options, ['a', 'b']);
  assert.equal(pool.length, 1);
  assert.deepEqual(pool.map((o) => o.id), ['c']);
});

test('an empty removedIds list leaves the full option set in play', () => {
  const options = [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }];
  const pool = getSpinPool(options, []);
  assert.equal(pool.length, 3);
  assert.equal(canSpin(pool), true);
});
