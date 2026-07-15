const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contrastRatio, pickTextColor, nearestCompliantShade, hexToRgb, rgbToHex, simulateColorBlindness } = require('../app.js');

test('black vs white is 21:1', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 0.01);
});

test('same color is 1:1', () => {
  assert.ok(Math.abs(contrastRatio('#336699', '#336699') - 1) < 0.001);
});

test('known WCAG example: #767676 on white is ~4.5:1', () => {
  assert.ok(Math.abs(contrastRatio('#767676', '#ffffff') - 4.54) < 0.05);
});

test('pickTextColor picks whichever of black/white passes 7:1', () => {
  const onWhite = pickTextColor('#ffffff', 7);
  assert.equal(onWhite.color, '#000000');
  assert.ok(onWhite.passes);

  const onBlack = pickTextColor('#000000', 7);
  assert.equal(onBlack.color, '#ffffff');
  assert.ok(onBlack.passes);
});

test('pickTextColor reports failure when neither passes the target', () => {
  // Mid-gray: neither black nor white reaches 7:1 against it.
  const result = pickTextColor('#808080', 7);
  assert.equal(result.passes, false);
});

test('nearestCompliantShade returns a shade where a text color passes', () => {
  const result = nearestCompliantShade('#808080', 7);
  const check = pickTextColor(result.hex, 7);
  assert.ok(check.passes, `adjusted shade ${result.hex} should pass 7:1, got ratio ${check.ratio}`);
});

test('nearestCompliantShade is a no-op when the input already passes', () => {
  const result = nearestCompliantShade('#000000', 7);
  assert.equal(result.hex, '#000000');
});

test('hexToRgb / rgbToHex round-trip', () => {
  assert.deepEqual(hexToRgb('#ff8800'), { r: 255, g: 136, b: 0 });
  assert.equal(rgbToHex(255, 136, 0), '#ff8800');
});

test('simulateColorBlindness returns a valid hex color for each type', () => {
  for (const type of ['protanopia', 'deuteranopia', 'tritanopia']) {
    const out = simulateColorBlindness('#E69F00', type);
    assert.match(out, /^#[0-9a-f]{6}$/);
  }
});

test('simulateColorBlindness is a no-op for an unknown type', () => {
  assert.equal(simulateColorBlindness('#123456', 'none'), '#123456');
});
