const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createDefaultState, serializeConfig, deserializeConfig,
  serializePreset, deserializePreset, deserializePresetLibrary,
} = require('../app.js');

test('config round-trips through serialize/deserialize', () => {
  const state = createDefaultState();
  state.title = 'Movie Night';
  state.options[0].weight = 3.5;
  const json = serializeConfig(state);
  const result = deserializeConfig(json);
  assert.ok(result.ok);
  assert.equal(result.data.title, 'Movie Night');
  assert.equal(result.data.options[0].weight, 3.5);
  assert.equal(result.data.options.length, state.options.length);
  assert.equal(result.data.durationPreset, state.durationPreset);
});

test('deserializeConfig rejects malformed JSON', () => {
  const result = deserializeConfig('{not valid json');
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('deserializeConfig rejects JSON missing required fields', () => {
  const result = deserializeConfig(JSON.stringify({ title: 'x' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /options/);
});

test('deserializeConfig rejects malformed option entries', () => {
  const bad = { title: 't', options: [{ id: 'a' }], equalOdds: false, noRepeat: false, durationPreset: 'quick' };
  const result = deserializeConfig(JSON.stringify(bad));
  assert.equal(result.ok, false);
});

test('preset round-trips through serialize/deserialize', () => {
  const state = createDefaultState();
  state.title = 'Raffle';
  const json = serializePreset(state, 'My Raffle Preset');
  const result = deserializePreset(json);
  assert.ok(result.ok);
  assert.equal(result.data.name, 'My Raffle Preset');
  assert.equal(result.data.state.title, 'Raffle');
  assert.equal(result.data.state.options.length, state.options.length);
});

test('deserializePreset rejects a preset with no name', () => {
  const state = createDefaultState();
  const obj = JSON.parse(serializePreset(state, 'x'));
  obj.name = '';
  const result = deserializePreset(JSON.stringify(obj));
  assert.equal(result.ok, false);
});

test('deserializePresetLibrary round-trips an array of presets', () => {
  const stateA = createDefaultState();
  stateA.title = 'A';
  const stateB = createDefaultState();
  stateB.title = 'B';
  const library = [
    JSON.parse(serializePreset(stateA, 'Preset A')),
    JSON.parse(serializePreset(stateB, 'Preset B')),
  ];
  const result = deserializePresetLibrary(JSON.stringify(library));
  assert.ok(result.ok);
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].name, 'Preset A');
  assert.equal(result.data[1].state.title, 'B');
});

test('deserializePresetLibrary rejects non-array input', () => {
  const result = deserializePresetLibrary(JSON.stringify({ foo: 'bar' }));
  assert.equal(result.ok, false);
});

test('deserializePresetLibrary rejects a library containing a malformed preset', () => {
  const stateA = createDefaultState();
  const good = JSON.parse(serializePreset(stateA, 'Good'));
  const bad = { name: 'Bad' }; // missing state
  const result = deserializePresetLibrary(JSON.stringify([good, bad]));
  assert.equal(result.ok, false);
});
