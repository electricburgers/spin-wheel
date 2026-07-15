const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildHistoryEntry, pushHistoryEntry, historyToCSV, MAX_HISTORY } = require('../app.js');

test('buildHistoryEntry captures mode flags and a timestamp', () => {
  const entry = buildHistoryEntry({
    title: 'Lunch Picker', winner: 'Tacos', noRepeat: true, equalOdds: false, durationPreset: 'quick',
  });
  assert.equal(entry.title, 'Lunch Picker');
  assert.equal(entry.winner, 'Tacos');
  assert.equal(entry.noRepeat, true);
  assert.equal(entry.equalOdds, false);
  assert.equal(entry.durationPreset, 'quick');
  assert.ok(entry.id);
  assert.ok(entry.timestamp);
});

test('pushHistoryEntry prepends (most recent first)', () => {
  let history = [];
  history = pushHistoryEntry(history, { id: '1', winner: 'A' });
  history = pushHistoryEntry(history, { id: '2', winner: 'B' });
  assert.deepEqual(history.map((h) => h.id), ['2', '1']);
});

test('pushHistoryEntry drops the oldest entries once over the cap', () => {
  let history = [];
  for (let i = 0; i < 10; i += 1) {
    history = pushHistoryEntry(history, { id: `e${i}` }, 5);
  }
  assert.equal(history.length, 5);
  // most recent (e9) first, oldest surviving (e5) last — e0..e4 were dropped.
  assert.deepEqual(history.map((h) => h.id), ['e9', 'e8', 'e7', 'e6', 'e5']);
});

test('history cap defaults to MAX_HISTORY', () => {
  let history = [];
  for (let i = 0; i < MAX_HISTORY + 20; i += 1) {
    history = pushHistoryEntry(history, { id: `e${i}` });
  }
  assert.equal(history.length, MAX_HISTORY);
});

test('historyToCSV produces a header row and one row per entry', () => {
  const history = [
    { timestamp: '2026-07-15T10:00:00.000Z', title: 'Lunch', winner: 'Tacos', noRepeat: true, equalOdds: false, durationPreset: 'quick' },
  ];
  const csv = historyToCSV(history);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'timestamp,title,winner,noRepeat,equalOdds,durationPreset');
  assert.equal(lines[1], '2026-07-15T10:00:00.000Z,Lunch,Tacos,true,false,quick');
});

test('historyToCSV quotes fields containing commas', () => {
  const history = [
    { timestamp: 't', title: 'Team A, Team B', winner: 'X', noRepeat: false, equalOdds: false, durationPreset: 'standard' },
  ];
  const csv = historyToCSV(history);
  assert.match(csv, /"Team A, Team B"/);
});
