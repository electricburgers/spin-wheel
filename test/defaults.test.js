const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultOptions, createDefaultState, MIN_OPTIONS, MAX_OPTIONS } = require('../app.js');

test('createDefaultOptions pre-fills exactly five generic options', () => {
  const options = createDefaultOptions();
  assert.equal(options.length, 5);
  assert.deepEqual(options.map((o) => o.text), ['Option 1', 'Option 2', 'Option 3', 'Option 4', 'Option 5']);
});

test('default option count satisfies the min/max bounds', () => {
  const options = createDefaultOptions();
  assert.ok(options.length >= MIN_OPTIONS);
  assert.ok(options.length <= MAX_OPTIONS);
});

test('every default option has a unique id, a positive weight, and a hex color', () => {
  const options = createDefaultOptions();
  const ids = new Set(options.map((o) => o.id));
  assert.equal(ids.size, options.length);
  options.forEach((o) => {
    assert.ok(o.weight > 0);
    assert.match(o.color, /^#[0-9a-f]{6}$/i);
  });
});

test('createDefaultState uses createDefaultOptions for its options', () => {
  const state = createDefaultState();
  assert.equal(state.options.length, 5);
});
