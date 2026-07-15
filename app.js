// Spin Wheel — vanilla JS, plain classic script (deliberately *not* an ES module: Safari
// refuses to execute <script type="module"> at all when the page is opened directly via
// file://, since module loading is subject to CORS checks that a null/file origin always
// fails — a plain script has no such restriction and works identically over file:// and
// http(s)://). Pure logic (testable from Node, no DOM) lives in the first half and is exposed
// via the SpinWheel namespace at the bottom (module.exports for `node --test`, globalThis for
// the browser); DOM/canvas/audio glue lives in the second half and only runs when `document`
// exists.
(function () {
'use strict';

/* ======================================================================
 * CONSTANTS
 * ==================================================================== */

// Okabe-Ito colorblind-safe qualitative palette, cycled for >8 options.
const DEFAULT_PALETTE = [
  '#E69F00', '#56B4E9', '#009E73', '#F0E442',
  '#0072B2', '#D55E00', '#CC79A7', '#000000',
];

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 50;
const MAX_HISTORY = 500;
const DEFAULT_WEIGHT = 1;
const MIN_WEIGHT = 0.01;

const DURATION_PRESETS = {
  quick: { label: 'Quick', seconds: 2.5, spins: 4 },
  standard: { label: 'Standard', seconds: 5.5, spins: 7 },
  dramatic: { label: 'Dramatic', seconds: 10.5, spins: 12 },
};
const REDUCED_MOTION_SECONDS = 0.9;
const REDUCED_MOTION_SPINS = 1;

const STORAGE_KEYS = {
  state: 'spinwheel:state:v1',
  history: 'spinwheel:history:v1',
  presets: 'spinwheel:presets:v1',
};

/* ======================================================================
 * GENERIC HELPERS
 * ==================================================================== */

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

let idCounter = 0;
function genId(prefix = 'id') {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ======================================================================
 * COLOR / CONTRAST MATH (WCAG)
 * ==================================================================== */

function hexToRgb(hex) {
  const m = String(hex).trim().replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const int = parseInt(full, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function rgbToHex(r, g, b) {
  const toHex = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) { h = 0; s = 0; } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      default: h = ((r - g) / d + 4); break;
    }
    h /= 6;
  }
  return { h: h * 360, s, l };
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  let r, g, b;
  if (s === 0) { r = g = b = l; } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}

function relativeLuminance({ r, g, b }) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexToRgb(hexA));
  const lb = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(la, lb), darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// Picks whichever of black/white text passes best against bgHex; reports pass/fail vs target.
function pickTextColor(bgHex, target = 7) {
  const white = contrastRatio(bgHex, '#ffffff');
  const black = contrastRatio(bgHex, '#000000');
  const useWhite = white >= black;
  const ratio = useWhite ? white : black;
  return { color: useWhite ? '#ffffff' : '#000000', ratio, passes: ratio >= target };
}

// If neither black nor white text passes `target` against bgHex, walk the background's
// lightness toward the extreme (darker or lighter) until one does, and return that shade.
function nearestCompliantShade(bgHex, target = 7) {
  const initial = pickTextColor(bgHex, target);
  if (initial.passes) return { hex: bgHex, ...initial };
  const rgb = hexToRgb(bgHex);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  // Try darkening (favors white text) and lightening (favors black text); pick whichever
  // reaches the target in fewer steps.
  const step = 0.02;
  let darkHex = bgHex, lightHex = bgHex;
  let l = hsl.l;
  for (let i = 0; i < 50 && l > 0; i += 1) {
    l = clamp(l - step, 0, 1);
    const rgb2 = hslToRgb(hsl.h, hsl.s, l);
    darkHex = rgbToHex(rgb2.r, rgb2.g, rgb2.b);
    if (pickTextColor(darkHex, target).passes) break;
  }
  l = hsl.l;
  for (let i = 0; i < 50 && l < 1; i += 1) {
    l = clamp(l + step, 0, 1);
    const rgb2 = hslToRgb(hsl.h, hsl.s, l);
    lightHex = rgbToHex(rgb2.r, rgb2.g, rgb2.b);
    if (pickTextColor(lightHex, target).passes) break;
  }
  const darkResult = pickTextColor(darkHex, target);
  const lightResult = pickTextColor(lightHex, target);
  if (darkResult.passes && (!lightResult.passes || Math.abs(hsl.l - (rgbToHsl(hexToRgb(darkHex).r, hexToRgb(darkHex).g, hexToRgb(darkHex).b).l)) <= Math.abs(hsl.l - (rgbToHsl(hexToRgb(lightHex).r, hexToRgb(lightHex).g, hexToRgb(lightHex).b).l)))) {
    return { hex: darkHex, ...darkResult };
  }
  if (lightResult.passes) return { hex: lightHex, ...lightResult };
  return { hex: darkHex, ...darkResult };
}

// Approximate dichromacy simulation (Machado/Coblis-style linear RGB transforms). Good enough
// for a "sanity check preview", not a color-science-grade simulation.
const CB_MATRICES = {
  protanopia: [
    [0.56667, 0.43333, 0],
    [0.55833, 0.44167, 0],
    [0, 0.24167, 0.75833],
  ],
  deuteranopia: [
    [0.625, 0.375, 0],
    [0.70, 0.30, 0],
    [0, 0.30, 0.70],
  ],
  tritanopia: [
    [0.95, 0.05, 0],
    [0, 0.43333, 0.56667],
    [0, 0.475, 0.525],
  ],
};

function simulateColorBlindness(hex, type) {
  const m = CB_MATRICES[type];
  if (!m) return hex;
  const { r, g, b } = hexToRgb(hex);
  const nr = m[0][0] * r + m[0][1] * g + m[0][2] * b;
  const ng = m[1][0] * r + m[1][1] * g + m[1][2] * b;
  const nb = m[2][0] * r + m[2][1] * g + m[2][2] * b;
  return rgbToHex(nr, ng, nb);
}

function paletteColor(index) {
  return DEFAULT_PALETTE[index % DEFAULT_PALETTE.length];
}

/* ======================================================================
 * WHEEL / SELECTION MATH
 * ==================================================================== */

// Options still in play: everything, minus removed ids when no-repeat mode has knocked
// winners out of the pool.
function getActiveOptions(options, removedIds = []) {
  const removed = new Set(removedIds);
  return options.filter((o) => !removed.has(o.id));
}

// Slice geometry for a set of *already-active* options. Angles are in radians and the last
// slice's width is computed as the remainder (2π - accumulated) so the set always sums to
// exactly 2π regardless of floating-point drift in the earlier divisions.
function computeSliceAngles(activeOptions, { equalOdds = false } = {}) {
  const n = activeOptions.length;
  if (n === 0) return [];
  const weights = activeOptions.map((o) => (equalOdds ? 1 : Math.max(0, o.weight)));
  const total = weights.reduce((a, b) => a + b, 0);
  const result = [];
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    let angle;
    if (i === n - 1) {
      angle = 2 * Math.PI - acc;
    } else {
      angle = total > 0 ? (weights[i] / total) * 2 * Math.PI : (2 * Math.PI) / n;
    }
    angle = Math.max(0, angle);
    result.push({
      id: activeOptions[i].id,
      startAngle: acc,
      endAngle: acc + angle,
      angle,
      midAngle: acc + angle / 2,
    });
    acc += angle;
  }
  return result;
}

// Fair weighted-random pick. `activeOptions` must already be the caller-filtered pool (no
// removed/no-repeat ids, no-repeat exclusions applied upstream) — this function only additionally
// excludes non-positive weights, which can never be legitimately selected.
function weightedRandomPick(activeOptions, { equalOdds = false, rng = Math.random } = {}) {
  const pool = activeOptions.filter((o) => o.weight > 0);
  if (pool.length === 0) return null;
  const weights = pool.map((o) => (equalOdds ? 1 : o.weight));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < pool.length; i += 1) {
    if (r < weights[i]) return pool[i].id;
    r -= weights[i];
  }
  return pool[pool.length - 1].id; // floating-point fallback
}

function findSliceMidAngle(sliceAngles, id) {
  const slice = sliceAngles.find((s) => s.id === id);
  return slice ? slice.midAngle : 0;
}

// Rotation *delta* (radians) to animate, starting from the wheel's current accumulated
// rotation, so it ends with `midAngle` sitting under a pointer fixed at 12 o'clock. Slices are
// drawn with local angle 0 placed at 12 o'clock and increasing clockwise (see renderWheel), so
// the wheel's final absolute orientation must satisfy (currentRotation + delta) ≡ -midAngle
// (mod 2π) — critically, that's -midAngle *minus whatever rotation the wheel already has*, not
// just -midAngle on its own. Ignoring currentRotation (as an earlier version of this function
// did) only lands correctly on the very first spin, when the wheel starts at 0: every spin
// after that leaves the wheel pre-rotated by the previous spin's landing angle, and computing
// the delta as if from zero again lands on the wrong slice by exactly that leftover amount.
function computeWinningRotation(midAngle, spins = 6, currentRotation = 0) {
  const target = -midAngle - currentRotation;
  const normalized = ((target % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return spins * 2 * Math.PI + normalized;
}

function normalizeAngle(angle) {
  const twoPi = 2 * Math.PI;
  return ((angle % twoPi) + twoPi) % twoPi;
}

function easeOutQuart(t) {
  return 1 - Math.pow(1 - clamp(t, 0, 1), 4);
}

/* ======================================================================
 * NO-REPEAT POOL LOGIC
 * ==================================================================== */

function removeFromPool(removedIds, id) {
  return removedIds.includes(id) ? removedIds : [...removedIds, id];
}

function resetPool() {
  return [];
}

// Whether a spin can currently happen: needs >=2 candidates with positive weight.
function canSpin(pool) {
  return pool.filter((o) => o.weight > 0).length >= 2;
}

// The pool a spin actually draws from: always excludes removedIds. The no-repeat *toggle*
// doesn't gate this — it only controls (at the app-glue layer) whether a win automatically
// gets added to removedIds. Manual exclusion (the winner modal's "remove & spin again") uses
// the same removedIds list regardless of whether no-repeat mode is on, so this stays a single
// unconditional rule instead of two different pool semantics to reason about.
function getSpinPool(options, removedIds) {
  return getActiveOptions(options, removedIds);
}

/* ======================================================================
 * STATE / DEFAULTS
 * ==================================================================== */

function createDefaultOptions() {
  const labels = ['Option 1', 'Option 2', 'Option 3', 'Option 4', 'Option 5'];
  return labels.map((text, i) => ({
    id: genId('opt'),
    text,
    weight: DEFAULT_WEIGHT,
    color: paletteColor(i),
  }));
}

function createDefaultState() {
  return {
    title: 'Spin Wheel',
    options: createDefaultOptions(),
    equalOdds: false,
    noRepeat: false,
    removedIds: [],
    durationPreset: 'standard',
    highDistinction: false,
    colorblindSim: 'none',
    volume: 0.8,
    muted: false,
    theme: 'system',
  };
}

/* ======================================================================
 * HISTORY
 * ==================================================================== */

function buildHistoryEntry({ title, winner, noRepeat, equalOdds, durationPreset, timestamp }) {
  return {
    id: genId('hist'),
    timestamp: timestamp || new Date().toISOString(),
    title,
    winner,
    noRepeat: !!noRepeat,
    equalOdds: !!equalOdds,
    durationPreset,
  };
}

// New entries go to the front (most-recent-first); oldest entries are dropped once the list
// exceeds `cap`.
function pushHistoryEntry(history, entry, cap = MAX_HISTORY) {
  const next = [entry, ...history];
  if (next.length > cap) next.length = cap;
  return next;
}

function csvField(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function historyToCSV(history) {
  const header = ['timestamp', 'title', 'winner', 'noRepeat', 'equalOdds', 'durationPreset'];
  const lines = [header.join(',')];
  for (const h of history) {
    lines.push(header.map((k) => csvField(h[k])).join(','));
  }
  return lines.join('\r\n');
}

/* ======================================================================
 * SERIALIZATION (config + presets)
 * ==================================================================== */

const CONFIG_REQUIRED_FIELDS = ['title', 'options', 'equalOdds', 'noRepeat', 'durationPreset'];

function isValidOption(o) {
  return o && typeof o.id === 'string' && typeof o.text === 'string'
    && typeof o.weight === 'number' && Number.isFinite(o.weight)
    && typeof o.color === 'string';
}

function validateConfigShape(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'Config must be an object.' };
  for (const field of CONFIG_REQUIRED_FIELDS) {
    if (!(field in obj)) return { ok: false, error: `Missing field: ${field}` };
  }
  if (!Array.isArray(obj.options) || obj.options.length === 0) {
    return { ok: false, error: 'Config must include a non-empty options array.' };
  }
  if (!obj.options.every(isValidOption)) {
    return { ok: false, error: 'One or more options is malformed.' };
  }
  return { ok: true };
}

function serializeConfig(state) {
  const { title, options, equalOdds, noRepeat, removedIds, durationPreset, highDistinction, colorblindSim, volume, muted, theme } = state;
  return JSON.stringify({
    version: 1,
    title, options, equalOdds, noRepeat, removedIds: removedIds || [],
    durationPreset, highDistinction, colorblindSim, volume, muted, theme,
  }, null, 2);
}

function deserializeConfig(json) {
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Invalid JSON.' };
  }
  const check = validateConfigShape(obj);
  if (!check.ok) return check;
  return {
    ok: true,
    data: {
      title: obj.title,
      options: obj.options.map((o) => ({ id: o.id, text: o.text, weight: o.weight, color: o.color })),
      equalOdds: !!obj.equalOdds,
      noRepeat: !!obj.noRepeat,
      removedIds: Array.isArray(obj.removedIds) ? obj.removedIds : [],
      durationPreset: obj.durationPreset in DURATION_PRESETS ? obj.durationPreset : 'standard',
      highDistinction: !!obj.highDistinction,
      colorblindSim: obj.colorblindSim || 'none',
      volume: typeof obj.volume === 'number' ? clamp(obj.volume, 0, 1) : 0.8,
      muted: !!obj.muted,
      theme: obj.theme || 'system',
    },
  };
}

function serializePreset(state, name) {
  return JSON.stringify({
    version: 1,
    kind: 'spinwheel-preset',
    id: genId('preset'),
    name,
    createdAt: new Date().toISOString(),
    state: JSON.parse(serializeConfig(state)),
  }, null, 2);
}

function validatePresetShape(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'Preset must be an object.' };
  if (typeof obj.name !== 'string' || !obj.name.trim()) return { ok: false, error: 'Preset needs a name.' };
  if (!obj.state) return { ok: false, error: 'Preset is missing state.' };
  const check = validateConfigShape(obj.state);
  if (!check.ok) return check;
  return { ok: true };
}

function deserializePreset(json) {
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Invalid JSON.' };
  }
  const check = validatePresetShape(obj);
  if (!check.ok) return check;
  const cfg = deserializeConfig(JSON.stringify(obj.state));
  if (!cfg.ok) return cfg;
  return {
    ok: true,
    data: {
      id: typeof obj.id === 'string' ? obj.id : genId('preset'),
      name: obj.name,
      createdAt: obj.createdAt || new Date().toISOString(),
      updatedAt: obj.updatedAt || obj.createdAt || new Date().toISOString(),
      state: cfg.data,
    },
  };
}

function deserializePresetLibrary(json) {
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Invalid JSON.' };
  }
  const arr = Array.isArray(obj) ? obj : obj.presets;
  if (!Array.isArray(arr)) return { ok: false, error: 'Expected an array of presets.' };
  const results = [];
  for (const item of arr) {
    const check = validatePresetShape(item);
    if (!check.ok) return { ok: false, error: check.error };
    const cfg = deserializeConfig(JSON.stringify(item.state));
    if (!cfg.ok) return cfg;
    results.push({
      id: typeof item.id === 'string' ? item.id : genId('preset'),
      name: item.name,
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
      state: cfg.data,
    });
  }
  return { ok: true, data: results };
}

/* ======================================================================
 * MINIMAL HAND-ROLLED PDF WRITER
 * ------------------------------------------------------------------
 * Trade-off: a vendored PDF library would give richer typography, but pulling one in means
 * either a CDN (banned — GitHub Pages must work offline) or committing a third-party bundle
 * whose provenance/security we'd then own. The slice table is one page of plain text + filled
 * rectangles, well within reach of the raw PDF object model, so we write the bytes directly:
 * zero dependencies, a few hundred lines instead of a few hundred KB.
 * ==================================================================== */

function pdfEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function pdfHexToUnit(hex) {
  const { r, g, b } = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

// rows: [{ text, weight, percent, color }]
function buildSimplePdf({ title, rows, generatedAt }) {
  const pageW = 612, pageH = 792;
  const marginX = 56;
  let y = pageH - 72;
  const lines = [];
  const font = (size) => `/F1 ${size} Tf`;

  lines.push('BT', font(20), `${marginX} ${y} Td`, `(${pdfEscape(title || 'Spin Wheel')}) Tj`, 'ET');
  y -= 22;
  lines.push('BT', font(9), `${marginX} ${y} Td`, `(${pdfEscape(generatedAt || new Date().toISOString())}) Tj`, 'ET');
  y -= 28;

  const colOption = marginX + 24, colWeight = 300, colPercent = 380, colSwatch = 470;
  lines.push('BT', font(11), `${marginX} ${y} Td`, `(Color) Tj`, 'ET');
  lines.push('BT', font(11), `${colOption} ${y} Td`, `(Option) Tj`, 'ET');
  lines.push('BT', font(11), `${colWeight} ${y} Td`, `(Weight) Tj`, 'ET');
  lines.push('BT', font(11), `${colPercent} ${y} Td`, `(Odds) Tj`, 'ET');
  y -= 6;
  lines.push('0.6 0.6 0.6 RG', `${marginX} ${y} m ${pageW - marginX} ${y} l S`);
  y -= 16;

  for (const row of rows) {
    if (y < 60) break; // single page; extra rows are silently dropped (documented limitation)
    const [r, g, b] = pdfHexToUnit(row.color);
    lines.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
    lines.push(`${marginX} ${y - 8} 14 10 re f`);
    lines.push('0 0 0 rg');
    const label = row.text.length > 34 ? `${row.text.slice(0, 33)}…` : row.text;
    lines.push('BT', font(10), `${colOption} ${y} Td`, `(${pdfEscape(label)}) Tj`, 'ET');
    lines.push('BT', font(10), `${colWeight} ${y} Td`, `(${pdfEscape(row.weight)}) Tj`, 'ET');
    lines.push('BT', font(10), `${colPercent} ${y} Td`, `(${pdfEscape(row.percent)}%) Tj`, 'ET');
    y -= 20;
  }

  const content = lines.join('\n');
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`);
  objects.push(null); // placeholder for stream object (built below)
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const encoder = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const push = (str) => {
    const bytes = encoder.encode(str);
    chunks.push(bytes);
    offset += bytes.length;
  };

  push('%PDF-1.4\n');
  objects.forEach((body, i) => {
    offsets.push(offset);
    const num = i + 1;
    if (body === null) {
      const streamBody = content;
      const streamBytes = encoder.encode(streamBody);
      push(`${num} 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n`);
      chunks.push(streamBytes);
      offset += streamBytes.length;
      push('\nendstream\nendobj\n');
    } else {
      push(`${num} 0 obj\n${body}\nendobj\n`);
    }
  });

  const xrefStart = offset;
  push(`xref\n0 ${objects.length + 1}\n`);
  push('0000000000 65535 f \n');
  for (const off of offsets) {
    push(`${String(off).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

/* ======================================================================
 * MISC PURE FORMATTERS
 * ==================================================================== */

function weightToPercent(weight, totalWeight) {
  if (!totalWeight) return 0;
  return (weight / totalWeight) * 100;
}

function slugify(str) {
  return String(str).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'spin-wheel';
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ======================================================================
 * PUBLIC NAMESPACE (Node test access)
 * ------------------------------------------------------------------
 * `node --test` reaches these via require('../app.js'); the browser doesn't need this at
 * all (the DOM glue below calls the functions above directly, same scope) but gets it anyway
 * in case a future script wants it.
 * ==================================================================== */

const SpinWheel = {
  DEFAULT_PALETTE, MIN_OPTIONS, MAX_OPTIONS, MAX_HISTORY, DEFAULT_WEIGHT, MIN_WEIGHT,
  DURATION_PRESETS, REDUCED_MOTION_SECONDS, REDUCED_MOTION_SPINS, STORAGE_KEYS,
  clamp, genId, escapeHtml,
  hexToRgb, rgbToHex, rgbToHsl, hslToRgb, relativeLuminance, contrastRatio, pickTextColor,
  nearestCompliantShade, simulateColorBlindness, paletteColor,
  getActiveOptions, computeSliceAngles, weightedRandomPick, findSliceMidAngle,
  computeWinningRotation, normalizeAngle, easeOutQuart,
  removeFromPool, resetPool, canSpin, getSpinPool,
  createDefaultOptions, createDefaultState,
  buildHistoryEntry, pushHistoryEntry, historyToCSV,
  isValidOption, validateConfigShape, serializeConfig, deserializeConfig,
  serializePreset, validatePresetShape, deserializePreset, deserializePresetLibrary,
  buildSimplePdf, weightToPercent, slugify, prefersReducedMotion,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SpinWheel;
}
if (typeof globalThis !== 'undefined') {
  globalThis.SpinWheel = SpinWheel;
}

/* ======================================================================
 * DOM / CANVAS / AUDIO GLUE
 * ------------------------------------------------------------------
 * Everything below only runs in a browser (`document` present). The functions/constants
 * above are called directly by name (not via SpinWheel.x) since this is all one classic-
 * script scope.
 * ==================================================================== */

function main() {
  const $ = (id) => document.getElementById(id);

  const titleInput = $('titleInput');
  const pageTitle = $('pageTitle');
  const canvas = $('wheelCanvas');
  const ctx = canvas.getContext('2d');
  const wheelWrap = $('wheelWrap');
  const wheelTooltip = $('wheelTooltip');
  const spinBtn = $('spinBtn');
  const spinHelp = $('spinHelp');
  const liveRegion = $('liveRegion');
  const srOptionsList = $('srOptionsList');

  const optionsList = $('optionsList');
  const optionCount = $('optionCount');
  const optionWarning = $('optionWarning');
  const addOptionBtn = $('addOptionBtn');

  const equalOddsToggle = $('equalOddsToggle');
  const noRepeatToggle = $('noRepeatToggle');
  const resetPoolRow = $('resetPoolRow');
  const resetPoolBtn = $('resetPoolBtn');
  const poolStatus = $('poolStatus');
  const durationInputs = Array.from(document.querySelectorAll('input[name="durationPreset"]'));
  const highDistinctionToggle = $('highDistinctionToggle');
  const colorblindSelect = $('colorblindSelect');
  const fixAllContrastBtn = $('fixAllContrastBtn');
  const themeSelect = $('themeSelect');
  const volumeSlider = $('volumeSlider');
  const muteBtn = $('muteBtn');

  const clearHistoryBtn = $('clearHistoryBtn');
  const exportHistoryCsvBtn = $('exportHistoryCsvBtn');
  const historyList = $('historyList');
  const historyEmpty = $('historyEmpty');

  const presetNameInput = $('presetNameInput');
  const savePresetBtn = $('savePresetBtn');
  const presetsList = $('presetsList');
  const presetsEmpty = $('presetsEmpty');
  const exportPresetBtn = $('exportPresetBtn');
  const importPresetInput = $('importPresetInput');
  const exportAllPresetsBtn = $('exportAllPresetsBtn');
  const importLibraryInput = $('importLibraryInput');

  const exportConfigBtn = $('exportConfigBtn');
  const importConfigInput = $('importConfigInput');
  const resetDefaultsBtn = $('resetDefaultsBtn');
  const clearAllBtn = $('clearAllBtn');

  const exportPngBtn = $('exportPngBtn');
  const exportPdfBtn = $('exportPdfBtn');
  const printBtn = $('printBtn');

  const winnerModal = $('winnerModal');
  const winnerNameDisplay = $('winnerNameDisplay');
  const removeAndSpinAgainBtn = $('removeAndSpinAgainBtn');
  const respinBtn = $('respinBtn');
  const closeWinnerModalBtn = $('closeWinnerModalBtn');

  const printTitle = $('printTitle');
  const printSliceTableBody = $('printSliceTableBody');

  const settingsGearBtn = $('settingsGearBtn');
  const settingsBackdrop = $('settingsBackdrop');
  const settingsDrawer = $('settingsDrawer');
  const settingsCloseBtn = $('settingsCloseBtn');

  /* ---- mutable app state ---- */
  let state = loadState();
  let history = loadHistory();
  let presets = loadPresets();
  let dirty = false;
  let isSpinning = false;
  let lastWinnerId = null;
  let wheelRotation = 0;
  let currentSliceAngles = [];
  const truncatedSlices = new Set();
  const percentEls = new Map();
  let lastFocusBeforeModal = null;
  let lastFocusBeforeSettings = null;
  let dragCtx = null;

  /* ---- audio ---- */
  let audioCtx = null;
  let masterGain = null;
  const buffers = { start: null, loop: null, end: null };
  let audioLoadPromise = null;
  let audioAvailable = true;

  /* ==================== persistence ==================== */

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.state);
      if (!raw) return createDefaultState();
      const result = deserializeConfig(raw);
      return result.ok ? result.data : createDefaultState();
    } catch {
      return createDefaultState();
    }
  }
  function loadHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.history) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function loadPresets() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.presets) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function persistState() {
    try { localStorage.setItem(STORAGE_KEYS.state, serializeConfig(state)); } catch { /* storage unavailable */ }
  }
  function persistHistory() {
    try { localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(history)); } catch { /* storage unavailable */ }
  }
  function persistPresets() {
    try { localStorage.setItem(STORAGE_KEYS.presets, JSON.stringify(presets)); } catch { /* storage unavailable */ }
  }
  function markDirty() { dirty = true; }
  function confirmIfDirty(message) { return !dirty || window.confirm(message); }

  function announce(message) {
    liveRegion.textContent = '';
    requestAnimationFrame(() => { liveRegion.textContent = message; });
  }

  function getComputedColor(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || '#000000';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadText(text, filename, mime = 'application/json') {
    downloadBlob(new Blob([text], { type: mime }), filename);
  }
  function handleFileImport(input, onText) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { onText(String(reader.result)); input.value = ''; };
    reader.onerror = () => { window.alert('Could not read that file.'); input.value = ''; };
    reader.readAsText(file);
  }

  function applyTheme() {
    if (state.theme === 'light' || state.theme === 'dark') {
      document.documentElement.setAttribute('data-theme', state.theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    resizeAndRenderWheel();
  }

  /* ==================== options list ==================== */

  function createOptionRow(option) {
    const li = document.createElement('li');
    li.className = 'option-row';
    li.dataset.id = option.id;
    const removed = state.removedIds.includes(option.id);
    if (removed) li.classList.add('removed');

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'drag-handle';
    handle.setAttribute('aria-label', `Drag to reorder ${option.text || 'option'}`);
    handle.textContent = '⠿';
    handle.addEventListener('pointerdown', (e) => startDrag(e, li));

    const reorderWrap = document.createElement('div');
    reorderWrap.className = 'reorder-btns';
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.textContent = '▲';
    upBtn.setAttribute('aria-label', `Move ${option.text || 'option'} up`);
    upBtn.addEventListener('click', () => moveOption(option.id, -1));
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.textContent = '▼';
    downBtn.setAttribute('aria-label', `Move ${option.text || 'option'} down`);
    downBtn.addEventListener('click', () => moveOption(option.id, 1));
    reorderWrap.append(upBtn, downBtn);

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.className = 'option-text';
    textInput.value = option.text;
    textInput.maxLength = 60;
    textInput.setAttribute('aria-label', 'Option label');
    textInput.addEventListener('input', () => {
      option.text = textInput.value;
      handle.setAttribute('aria-label', `Drag to reorder ${option.text || 'option'}`);
      upBtn.setAttribute('aria-label', `Move ${option.text || 'option'} up`);
      downBtn.setAttribute('aria-label', `Move ${option.text || 'option'} down`);
      deleteBtn.setAttribute('aria-label', `Delete ${option.text || 'option'}`);
      colorInput.setAttribute('aria-label', `Color for ${option.text || 'option'}`);
      markDirty();
      persistState();
      renderSrOptionsList();
      resizeAndRenderWheel();
    });

    const weightInput = document.createElement('input');
    weightInput.type = 'number';
    weightInput.className = 'option-weight';
    weightInput.min = String(MIN_WEIGHT);
    weightInput.step = '0.1';
    weightInput.value = String(option.weight);
    weightInput.setAttribute('aria-label', `Weight for ${option.text || 'option'}`);
    weightInput.addEventListener('input', () => {
      const v = parseFloat(weightInput.value);
      option.weight = Number.isFinite(v) && v > 0 ? v : MIN_WEIGHT;
      markDirty();
      persistState();
      updateOptionPercents();
      renderSrOptionsList();
      resizeAndRenderWheel();
      renderSpinState();
    });

    const percentEl = document.createElement('span');
    percentEl.className = 'option-percent';
    percentEls.set(option.id, percentEl);

    const colorWrap = document.createElement('div');
    colorWrap.className = 'option-color-wrap';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'option-color';
    colorInput.value = option.color;
    colorInput.setAttribute('aria-label', `Color for ${option.text || 'option'}`);
    const badge = document.createElement('span');
    badge.className = 'contrast-badge';
    // Fixing a failing color lives in Settings > Appearance ("Fix all contrast issues") so it
    // can act on every option at once, instead of a button on every single row — that button
    // only appearing on some rows (whichever currently fail) was also the main reason the
    // delete button's position varied row to row.
    function refreshBadge() {
      const check = pickTextColor(option.color, 7);
      badge.textContent = check.passes ? `AAA ${check.ratio.toFixed(1)}:1` : `${check.ratio.toFixed(1)}:1`;
      badge.className = `contrast-badge ${check.passes ? 'pass' : 'fail'}`;
      badge.title = check.passes
        ? `${check.ratio.toFixed(2)}:1 against ${check.color} text — passes AAA (7:1)`
        : `${check.ratio.toFixed(2)}:1 against ${check.color} text — fails AAA (7:1). Fix from Settings > Appearance.`;
    }
    refreshBadge();
    colorInput.addEventListener('input', () => {
      option.color = colorInput.value;
      markDirty();
      persistState();
      refreshBadge();
      resizeAndRenderWheel();
    });
    colorWrap.append(colorInput, badge);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'option-delete';
    deleteBtn.textContent = '×';
    deleteBtn.setAttribute('aria-label', `Delete ${option.text || 'option'}`);
    deleteBtn.disabled = state.options.length <= MIN_OPTIONS;
    deleteBtn.addEventListener('click', () => deleteOption(option.id));

    li.append(handle, reorderWrap, textInput, weightInput, percentEl, colorWrap, deleteBtn);
    return li;
  }

  function renderOptionsList() {
    optionsList.innerHTML = '';
    percentEls.clear();
    state.options.forEach((option) => optionsList.appendChild(createOptionRow(option)));
    optionCount.textContent = `${state.options.length} / ${MAX_OPTIONS} options`;
    optionWarning.textContent = state.options.length < MIN_OPTIONS
      ? `Add at least ${MIN_OPTIONS} options to spin.` : '';
    addOptionBtn.disabled = state.options.length >= MAX_OPTIONS;
    updateOptionPercents();
  }

  function updateOptionPercents() {
    const pool = getSpinPool(state.options, state.removedIds);
    const weights = pool.map((o) => (state.equalOdds ? 1 : Math.max(0, o.weight)));
    const total = weights.reduce((a, b) => a + b, 0);
    state.options.forEach((o) => {
      const el = percentEls.get(o.id);
      if (!el) return;
      const poolIdx = pool.findIndex((p) => p.id === o.id);
      if (poolIdx === -1 || o.weight <= 0 || total <= 0) { el.textContent = '0%'; return; }
      el.textContent = `${weightToPercent(weights[poolIdx], total).toFixed(1)}%`;
    });
  }

  function renderSrOptionsList() {
    srOptionsList.innerHTML = '';
    const pool = getSpinPool(state.options, state.removedIds);
    const weights = pool.map((o) => (state.equalOdds ? 1 : Math.max(0, o.weight)));
    const total = weights.reduce((a, b) => a + b, 0);
    state.options.forEach((o) => {
      const li = document.createElement('li');
      const removed = state.removedIds.includes(o.id);
      const poolIdx = pool.findIndex((p) => p.id === o.id);
      const pct = (!removed && poolIdx !== -1 && total > 0) ? weightToPercent(weights[poolIdx], total).toFixed(1) : '0';
      li.textContent = `${o.text || '(untitled)'} — weight ${o.weight}, ${pct}% odds${removed ? ' (removed from pool)' : ''}`;
      srOptionsList.appendChild(li);
    });
  }

  function addOption() {
    if (state.options.length >= MAX_OPTIONS) return;
    const option = {
      id: genId('opt'),
      text: `Option ${state.options.length + 1}`,
      weight: DEFAULT_WEIGHT,
      color: paletteColor(state.options.length),
    };
    state.options.push(option);
    markDirty();
    persistState();
    renderOptionsList();
    renderSrOptionsList();
    resizeAndRenderWheel();
    renderSpinState();
    const row = optionsList.querySelector(`li[data-id="${option.id}"] .option-text`);
    if (row) row.focus();
  }

  function deleteOption(id) {
    if (state.options.length <= MIN_OPTIONS) return;
    state.options = state.options.filter((o) => o.id !== id);
    state.removedIds = state.removedIds.filter((rid) => rid !== id);
    markDirty();
    persistState();
    renderOptionsList();
    renderSrOptionsList();
    resizeAndRenderWheel();
    renderSpinState();
  }

  function moveOption(id, delta) {
    const idx = state.options.findIndex((o) => o.id === id);
    const newIdx = idx + delta;
    if (idx === -1 || newIdx < 0 || newIdx >= state.options.length) return;
    const [item] = state.options.splice(idx, 1);
    state.options.splice(newIdx, 0, item);
    markDirty();
    persistState();
    renderOptionsList();
    renderSrOptionsList();
    resizeAndRenderWheel();
  }

  function startDrag(e, li) {
    e.preventDefault();
    li.classList.add('dragging');
    dragCtx = { li, list: optionsList };
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd, { once: true });
  }
  function onDragMove(e) {
    if (!dragCtx) return;
    const { li, list } = dragCtx;
    const rows = Array.from(list.children).filter((r) => r !== li);
    let inserted = false;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) { list.insertBefore(li, row); inserted = true; break; }
    }
    if (!inserted) list.appendChild(li);
  }
  function onDragEnd() {
    document.removeEventListener('pointermove', onDragMove);
    if (!dragCtx) return;
    dragCtx.li.classList.remove('dragging');
    const newOrder = Array.from(dragCtx.list.children).map((li) => li.dataset.id);
    const byId = new Map(state.options.map((o) => [o.id, o]));
    state.options = newOrder.map((id) => byId.get(id)).filter(Boolean);
    dragCtx = null;
    markDirty();
    persistState();
    renderSrOptionsList();
    resizeAndRenderWheel();
  }

  /* ==================== wheel canvas ==================== */

  function resizeCanvas() {
    const rect = wheelWrap.getBoundingClientRect();
    const size = Math.max(80, Math.min(rect.width || 300, rect.height || rect.width || 300));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
  }

  function resizeAndRenderWheel() {
    resizeCanvas();
    renderWheel(0);
  }

  function fitLabel(targetCtx, text, maxWidth) {
    if (targetCtx.measureText(text).width <= maxWidth) return { text, wasTruncated: false };
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = `${text.slice(0, mid)}…`;
      if (targetCtx.measureText(candidate).width <= maxWidth) lo = mid; else hi = mid - 1;
    }
    return { text: `${text.slice(0, lo)}…`, wasTruncated: true };
  }

  function drawPattern(targetCtx, radius, slice, index, baseColor) {
    const kinds = ['stripes', 'dots', 'crosshatch'];
    const kind = kinds[index % kinds.length];
    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.moveTo(0, 0);
    targetCtx.arc(0, 0, radius, slice.startAngle, slice.endAngle);
    targetCtx.closePath();
    targetCtx.clip();
    const overlay = pickTextColor(baseColor, 3).color === '#ffffff' ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.25)';
    targetCtx.strokeStyle = overlay;
    targetCtx.fillStyle = overlay;
    const step = Math.max(6, radius * 0.05);
    if (kind === 'stripes') {
      targetCtx.lineWidth = step * 0.35;
      for (let x = -radius; x < radius; x += step) {
        targetCtx.beginPath(); targetCtx.moveTo(x, -radius); targetCtx.lineTo(x, radius); targetCtx.stroke();
      }
    } else if (kind === 'dots') {
      for (let x = -radius; x < radius; x += step) {
        for (let y = -radius; y < radius; y += step) {
          targetCtx.beginPath(); targetCtx.arc(x, y, step * 0.15, 0, Math.PI * 2); targetCtx.fill();
        }
      }
    } else {
      targetCtx.lineWidth = step * 0.22;
      for (let x = -radius * 2; x < radius * 2; x += step) {
        targetCtx.beginPath(); targetCtx.moveTo(x, -radius); targetCtx.lineTo(x + radius * 2, radius); targetCtx.stroke();
        targetCtx.beginPath(); targetCtx.moveTo(x, radius); targetCtx.lineTo(x + radius * 2, -radius); targetCtx.stroke();
      }
    }
    targetCtx.restore();
  }

  function drawWheel(targetCtx, w, h, extraRotation, trackTruncation) {
    const pool = getSpinPool(state.options, state.removedIds);
    const sliceAngles = computeSliceAngles(pool, { equalOdds: state.equalOdds });
    if (trackTruncation) { currentSliceAngles = sliceAngles; truncatedSlices.clear(); }

    const cx = w / 2, cy = h / 2;
    const radius = Math.min(w, h) / 2 - Math.max(4, w * 0.012);
    targetCtx.clearRect(0, 0, w, h);

    if (sliceAngles.length === 0) {
      targetCtx.save();
      targetCtx.fillStyle = getComputedColor('--bg-input');
      targetCtx.beginPath();
      targetCtx.arc(cx, cy, radius, 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.fillStyle = getComputedColor('--text-muted');
      targetCtx.font = `${Math.round(radius * 0.09)}px system-ui, sans-serif`;
      targetCtx.textAlign = 'center';
      targetCtx.textBaseline = 'middle';
      targetCtx.fillText('Add options to build the wheel', cx, cy, radius * 1.7);
      targetCtx.restore();
      return;
    }

    const rotation = normalizeAngle(wheelRotation + extraRotation);
    targetCtx.save();
    targetCtx.translate(cx, cy);
    targetCtx.rotate(-Math.PI / 2 + rotation);

    const n = sliceAngles.length;
    const fontSize = clamp(radius * (n > 24 ? 0.045 : n > 12 ? 0.06 : 0.08), radius * 0.035, radius * 0.09);

    sliceAngles.forEach((slice, i) => {
      const opt = pool.find((o) => o.id === slice.id);
      const displayColor = state.colorblindSim !== 'none' ? simulateColorBlindness(opt.color, state.colorblindSim) : opt.color;

      targetCtx.beginPath();
      targetCtx.moveTo(0, 0);
      targetCtx.arc(0, 0, radius, slice.startAngle, slice.endAngle);
      targetCtx.closePath();
      targetCtx.fillStyle = displayColor;
      targetCtx.fill();

      if (state.highDistinction) drawPattern(targetCtx, radius, slice, i, displayColor);

      targetCtx.lineWidth = Math.max(1.5, radius * 0.006);
      targetCtx.strokeStyle = pickTextColor(displayColor, 3).color === '#ffffff' ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.75)';
      targetCtx.stroke();

      const textColor = pickTextColor(displayColor, 4.5).color;
      targetCtx.save();
      targetCtx.rotate(slice.midAngle);
      targetCtx.textBaseline = 'middle';
      targetCtx.fillStyle = textColor;
      targetCtx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
      const flip = slice.midAngle > Math.PI / 2 && slice.midAngle < (3 * Math.PI) / 2;
      const labelRadius = radius * 0.62;
      const maxWidth = radius * (n > 20 ? 0.4 : 0.6);
      const fitted = fitLabel(targetCtx, opt.text || '', maxWidth);
      if (trackTruncation && fitted.wasTruncated) truncatedSlices.add(slice.id);
      // Always translate outward by a *positive* radius first (this alone correctly places
      // the point at the slice's mid-angle regardless of which half of the wheel it's on).
      // Only then, for the left half, rotate the frame 180° in place so the glyphs read
      // upright instead of upside-down — rotating before the translate (or negating the
      // radius) instead moves the point to the mirror-image slice on the opposite side.
      targetCtx.translate(labelRadius, 0);
      if (flip) targetCtx.rotate(Math.PI);
      targetCtx.textAlign = flip ? 'right' : 'left';
      targetCtx.fillText(fitted.text, 0, 0);
      targetCtx.restore();
    });

    targetCtx.restore();
  }

  function renderWheel(extraRotation) {
    drawWheel(ctx, canvas.width, canvas.height, extraRotation, true);
  }

  canvas.addEventListener('pointermove', (e) => {
    if (!currentSliceAngles.length) { wheelTooltip.hidden = true; return; }
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    if (Math.hypot(x, y) > rect.width / 2) { wheelTooltip.hidden = true; return; }
    const theta = normalizeAngle(Math.atan2(y, x) + Math.PI / 2 - normalizeAngle(wheelRotation));
    const slice = currentSliceAngles.find((s) => theta >= s.startAngle && theta < s.endAngle);
    if (slice && truncatedSlices.has(slice.id)) {
      const opt = state.options.find((o) => o.id === slice.id);
      wheelTooltip.textContent = opt ? opt.text : '';
      wheelTooltip.style.left = `${e.clientX + 12}px`;
      wheelTooltip.style.top = `${e.clientY + 12}px`;
      wheelTooltip.hidden = false;
    } else {
      wheelTooltip.hidden = true;
    }
  });
  canvas.addEventListener('pointerleave', () => { wheelTooltip.hidden = true; });

  if (window.ResizeObserver) {
    new ResizeObserver(() => resizeAndRenderWheel()).observe(wheelWrap);
  } else {
    window.addEventListener('resize', () => resizeAndRenderWheel());
  }

  /* ==================== audio (drumroll) ==================== */

  function ensureAudioContext() {
    if (audioCtx) return audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { audioAvailable = false; return null; }
    audioCtx = new AC();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = state.muted ? 0 : state.volume;
    masterGain.connect(audioCtx.destination);
    return audioCtx;
  }

  async function loadBuffer(ac, url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    const arr = await res.arrayBuffer();
    return ac.decodeAudioData(arr);
  }

  function ensureBuffersLoaded() {
    if (audioLoadPromise) return audioLoadPromise;
    const ac = ensureAudioContext();
    if (!ac) { audioLoadPromise = Promise.resolve(false); return audioLoadPromise; }
    audioLoadPromise = Promise.all([
      loadBuffer(ac, 'audio/start.wav').then((b) => { buffers.start = b; }),
      loadBuffer(ac, 'audio/loop.wav').then((b) => { buffers.loop = b; }),
      loadBuffer(ac, 'audio/end.wav').then((b) => { buffers.end = b; }),
    ]).then(() => true).catch((err) => {
      console.warn('Spin Wheel: drumroll audio failed to load — spinning silently.', err);
      audioAvailable = false;
      return false;
    });
    return audioLoadPromise;
  }

  // Lead time given to the Web Audio scheduler before the first sample actually plays. Both
  // the drumroll and the wheel animation get delayed by exactly this long (see handleSpin),
  // so the two clocks share one synchronous start instant instead of racing — a real gap here
  // (e.g. from buffer-decode time varying) is what previously let the drumroll finish before,
  // or well after, the wheel had actually stopped.
  const AUDIO_SCHEDULE_LATENCY_MS = 150;

  // Resolves all async setup (context resume + buffer decode) and returns the ready
  // AudioContext, or null if audio isn't available — does no scheduling itself, so the caller
  // can capture a single shared timing reference right after this resolves.
  async function prepareAudio() {
    if (!audioAvailable) return null;
    const ac = ensureAudioContext();
    if (!ac) return null;
    if (ac.state === 'suspended') {
      try { await ac.resume(); } catch { /* ignore */ }
    }
    const ok = await ensureBuffersLoaded();
    if (!ok || !buffers.start || !buffers.loop || !buffers.end) return null;
    return ac;
  }

  // Purely synchronous: schedules start -> (loop fill) -> end back-to-back so they span
  // exactly totalSeconds from t0. start/end always play in full (never truncated) — callers
  // are responsible for ensuring totalSeconds >= start.duration + end.duration.
  function scheduleDrumroll(ac, totalSeconds, delaySeconds) {
    const t0 = ac.currentTime + delaySeconds;
    const startDur = buffers.start.duration;
    const endDur = buffers.end.duration;
    const loopFill = Math.max(0, totalSeconds - startDur - endDur);

    const startSrc = ac.createBufferSource();
    startSrc.buffer = buffers.start;
    startSrc.connect(masterGain);
    startSrc.start(t0);

    if (loopFill > 0) {
      const loopSrc = ac.createBufferSource();
      loopSrc.buffer = buffers.loop;
      loopSrc.loop = true;
      loopSrc.connect(masterGain);
      loopSrc.start(t0 + startDur);
      loopSrc.stop(t0 + startDur + loopFill);
    }

    const endSrc = ac.createBufferSource();
    endSrc.buffer = buffers.end;
    endSrc.connect(masterGain);
    endSrc.start(t0 + startDur + loopFill);
  }

  volumeSlider.addEventListener('input', () => {
    state.volume = clamp(parseFloat(volumeSlider.value) || 0, 0, 1);
    if (masterGain && !state.muted) masterGain.gain.value = state.volume;
    persistState();
  });
  muteBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    muteBtn.textContent = state.muted ? '🔇' : '🔊';
    muteBtn.setAttribute('aria-pressed', String(state.muted));
    if (masterGain) masterGain.gain.value = state.muted ? 0 : state.volume;
    persistState();
  });

  /* ==================== spin flow ==================== */

  // startDelayMs (shared with scheduleDrumroll's t0) is what keeps this locked to the audio
  // clock: both wait the same lead time before their respective "now", so a spin with audio
  // starts moving and sounding together, and — since both then run for the same `seconds` —
  // finish together too.
  function animateSpin(totalRotation, seconds, startDelayMs = 0) {
    return new Promise((resolve) => {
      const durationMs = Math.max(1, seconds * 1000);
      function begin() {
        const start = performance.now();
        function frame(now) {
          const t = clamp((now - start) / durationMs, 0, 1);
          renderWheel(totalRotation * easeOutQuart(t));
          if (t < 1) requestAnimationFrame(frame); else resolve();
        }
        requestAnimationFrame(frame);
      }
      if (startDelayMs > 0) setTimeout(begin, startDelayMs); else begin();
    });
  }

  async function handleSpin() {
    if (isSpinning) return;
    const pool = getSpinPool(state.options, state.removedIds).filter((o) => o.weight > 0);
    if (!canSpin(pool) || state.options.length < MIN_OPTIONS) return;

    isSpinning = true;
    spinBtn.disabled = true;
    winnerModal.hidden = true;

    const winnerId = weightedRandomPick(pool, { equalOdds: state.equalOdds });
    const sliceAngles = computeSliceAngles(pool, { equalOdds: state.equalOdds });
    const midAngle = findSliceMidAngle(sliceAngles, winnerId);
    const reduced = prefersReducedMotion();
    const preset = DURATION_PRESETS[state.durationPreset] || DURATION_PRESETS.standard;
    const nominalSeconds = reduced ? REDUCED_MOTION_SECONDS : preset.seconds;
    const spins = reduced ? REDUCED_MOTION_SPINS : preset.spins;
    const winnerOption = state.options.find((o) => o.id === winnerId);

    announce(`Spinning ${state.title || 'the wheel'}…`);

    // Resolve all async audio setup (context resume + buffer decode) *before* picking a
    // final duration or starting anything — that keeps the audio schedule and the animation
    // start anchored to the same synchronous instant instead of racing.
    const ac = await prepareAudio();

    // The start/end clips have a fixed combined length and always play in full (never
    // truncated), so — outside the reduced-motion fallback, where minimizing motion matters
    // more than hitting the nominal preset length — the spin can't be shorter than that
    // combined length without the drumroll either getting cut off or running past the wheel's
    // stop. Stretching the spin to fit is what guarantees "finishes exactly as the wheel
    // stops" holds for every preset, not just the longer ones.
    const minAudioSeconds = (!reduced && ac) ? (buffers.start.duration + buffers.end.duration) : 0;
    const seconds = Math.max(nominalSeconds, minAudioSeconds);
    const totalRotation = computeWinningRotation(midAngle, spins, wheelRotation);

    const startDelayMs = ac ? AUDIO_SCHEDULE_LATENCY_MS : 0;
    if (ac) scheduleDrumroll(ac, seconds, startDelayMs / 1000);

    await animateSpin(totalRotation, seconds, startDelayMs);
    wheelRotation = normalizeAngle(wheelRotation + totalRotation);
    isSpinning = false;
    onSpinComplete(winnerOption);
  }

  function onSpinComplete(winnerOption) {
    const entry = buildHistoryEntry({
      title: state.title,
      winner: winnerOption.text,
      noRepeat: state.noRepeat,
      equalOdds: state.equalOdds,
      durationPreset: state.durationPreset,
    });
    history = pushHistoryEntry(history, entry, MAX_HISTORY);
    persistHistory();
    renderHistory();

    lastWinnerId = winnerOption.id;
    if (state.noRepeat) {
      state.removedIds = removeFromPool(state.removedIds, winnerOption.id);
      persistState();
      renderOptionsList();
      renderSrOptionsList();
      resizeAndRenderWheel();
    }
    renderSpinState();
    announce(`Winner: ${winnerOption.text}`);
    openWinnerModal(winnerOption.text);
  }

  /* ==================== winner modal ==================== */

  function onModalKeydown(e) {
    if (e.key === 'Escape') { closeWinnerModal(); return; }
    if (e.key !== 'Tab') return;
    const focusables = Array.from(winnerModal.querySelectorAll('button'));
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function openWinnerModal(winnerText) {
    lastFocusBeforeModal = document.activeElement;
    winnerNameDisplay.textContent = winnerText;
    winnerModal.hidden = false;
    closeWinnerModalBtn.focus();
    document.addEventListener('keydown', onModalKeydown);
  }
  function closeWinnerModal() {
    winnerModal.hidden = true;
    document.removeEventListener('keydown', onModalKeydown);
    if (lastFocusBeforeModal && typeof lastFocusBeforeModal.focus === 'function') lastFocusBeforeModal.focus();
  }

  removeAndSpinAgainBtn.addEventListener('click', () => {
    if (lastWinnerId) {
      state.removedIds = removeFromPool(state.removedIds, lastWinnerId);
      persistState();
      renderOptionsList();
      renderSrOptionsList();
      resizeAndRenderWheel();
    }
    closeWinnerModal();
    const pool = getSpinPool(state.options, state.removedIds).filter((o) => o.weight > 0);
    if (canSpin(pool)) handleSpin(); else renderSpinState();
  });
  respinBtn.addEventListener('click', () => {
    closeWinnerModal();
    const pool = getSpinPool(state.options, state.removedIds).filter((o) => o.weight > 0);
    if (canSpin(pool)) handleSpin();
  });
  closeWinnerModalBtn.addEventListener('click', closeWinnerModal);

  /* ==================== settings drawer (gear icon) ==================== */

  function settingsFocusables() {
    return Array.from(settingsDrawer.querySelectorAll('button, input, select, a[href]'))
      .filter((el) => !el.disabled && el.offsetParent !== null);
  }
  function onSettingsKeydown(e) {
    if (e.key === 'Escape') { closeSettingsDrawer(); return; }
    if (e.key !== 'Tab') return;
    const focusables = settingsFocusables();
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function openSettingsDrawer() {
    lastFocusBeforeSettings = document.activeElement;
    settingsGearBtn.setAttribute('aria-expanded', 'true');
    settingsBackdrop.classList.add('show');
    settingsDrawer.classList.add('open');
    document.addEventListener('keydown', onSettingsKeydown);
    settingsCloseBtn.focus();
  }
  function closeSettingsDrawer() {
    settingsGearBtn.setAttribute('aria-expanded', 'false');
    settingsBackdrop.classList.remove('show');
    settingsDrawer.classList.remove('open');
    document.removeEventListener('keydown', onSettingsKeydown);
    if (lastFocusBeforeSettings && typeof lastFocusBeforeSettings.focus === 'function') lastFocusBeforeSettings.focus();
  }

  settingsGearBtn.addEventListener('click', openSettingsDrawer);
  settingsCloseBtn.addEventListener('click', closeSettingsDrawer);
  settingsBackdrop.addEventListener('click', closeSettingsDrawer);

  /* ==================== spin state / help text ==================== */

  function renderSpinState() {
    const pool = getSpinPool(state.options, state.removedIds).filter((o) => o.weight > 0);
    const canSpinNow = canSpin(pool) && state.options.length >= MIN_OPTIONS;
    spinBtn.disabled = isSpinning || !canSpinNow;

    if (state.options.length < MIN_OPTIONS) {
      spinHelp.textContent = `Add at least ${MIN_OPTIONS} options to spin.`;
    } else if (pool.length === 0) {
      spinHelp.textContent = 'No options left in the pool — reset the pool to spin again.';
    } else if (pool.length === 1) {
      spinHelp.textContent = 'Only one option left — reset the pool to spin again.';
    } else {
      spinHelp.textContent = '';
    }

    const showReset = state.noRepeat || state.removedIds.length > 0;
    resetPoolRow.hidden = !showReset;
    if (showReset) {
      const activeCount = getActiveOptions(state.options, state.removedIds).length;
      poolStatus.textContent = `${activeCount} of ${state.options.length} options remain in the pool.`;
    }
  }

  /* ==================== settings wiring ==================== */

  titleInput.addEventListener('input', () => {
    state.title = titleInput.value;
    markDirty();
    persistState();
    pageTitle.textContent = state.title || 'Spin Wheel';
    document.title = state.title || 'Spin Wheel';
  });

  addOptionBtn.addEventListener('click', addOption);

  equalOddsToggle.addEventListener('change', () => {
    state.equalOdds = equalOddsToggle.checked;
    markDirty();
    persistState();
    updateOptionPercents();
    renderSrOptionsList();
    resizeAndRenderWheel();
  });
  noRepeatToggle.addEventListener('change', () => {
    state.noRepeat = noRepeatToggle.checked;
    markDirty();
    persistState();
    renderSpinState();
  });
  resetPoolBtn.addEventListener('click', () => {
    state.removedIds = resetPool();
    markDirty();
    persistState();
    renderOptionsList();
    renderSrOptionsList();
    resizeAndRenderWheel();
    renderSpinState();
    announce('Pool reset — all options are back in play.');
  });
  durationInputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      state.durationPreset = input.value;
      markDirty();
      persistState();
    });
  });
  highDistinctionToggle.addEventListener('change', () => {
    state.highDistinction = highDistinctionToggle.checked;
    markDirty();
    persistState();
    resizeAndRenderWheel();
  });
  colorblindSelect.addEventListener('change', () => {
    state.colorblindSim = colorblindSelect.value;
    markDirty();
    persistState();
    resizeAndRenderWheel();
  });
  fixAllContrastBtn.addEventListener('click', () => {
    let fixedCount = 0;
    state.options.forEach((option) => {
      if (!pickTextColor(option.color, 7).passes) {
        option.color = nearestCompliantShade(option.color, 7).hex;
        fixedCount += 1;
      }
    });
    if (fixedCount === 0) {
      announce('All option colors already meet AAA contrast.');
      return;
    }
    markDirty();
    persistState();
    renderOptionsList();
    resizeAndRenderWheel();
    announce(`Fixed contrast for ${fixedCount} option${fixedCount === 1 ? '' : 's'}.`);
  });
  themeSelect.addEventListener('change', () => {
    state.theme = themeSelect.value;
    persistState();
    applyTheme();
  });

  /* ==================== history ==================== */

  function renderHistory() {
    historyList.innerHTML = '';
    historyEmpty.hidden = history.length > 0;
    history.forEach((h) => {
      const li = document.createElement('li');
      li.className = 'history-item';
      const winnerEl = document.createElement('div');
      winnerEl.className = 'h-winner';
      winnerEl.textContent = h.winner;
      const metaEl = document.createElement('div');
      metaEl.className = 'h-meta';
      const time = document.createElement('span');
      time.textContent = new Date(h.timestamp).toLocaleString();
      const titleBadge = document.createElement('span');
      titleBadge.className = 'badge';
      titleBadge.textContent = h.title || 'Spin Wheel';
      const durBadge = document.createElement('span');
      durBadge.className = 'badge';
      durBadge.textContent = (DURATION_PRESETS[h.durationPreset] || {}).label || h.durationPreset;
      metaEl.append(time, titleBadge, durBadge);
      if (h.noRepeat) {
        const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'No-repeat'; metaEl.appendChild(b);
      }
      if (h.equalOdds) {
        const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'Equal odds'; metaEl.appendChild(b);
      }
      li.append(winnerEl, metaEl);
      historyList.appendChild(li);
    });
  }

  clearHistoryBtn.addEventListener('click', () => {
    if (!history.length) return;
    if (!window.confirm('Clear all spin history? This cannot be undone.')) return;
    history = [];
    persistHistory();
    renderHistory();
  });
  exportHistoryCsvBtn.addEventListener('click', () => {
    downloadText(historyToCSV(history), 'spin-wheel-history.csv', 'text/csv');
  });

  /* ==================== presets ==================== */

  function renderPresets() {
    presetsList.innerHTML = '';
    presetsEmpty.hidden = presets.length > 0;
    presets.forEach((preset) => {
      const li = document.createElement('li');
      li.className = 'preset-item';
      const name = document.createElement('span');
      name.className = 'preset-name';
      name.textContent = preset.name;
      const loadBtn = document.createElement('button');
      loadBtn.type = 'button'; loadBtn.className = 'btn'; loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', () => loadPreset(preset.id));
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button'; renameBtn.className = 'btn'; renameBtn.textContent = 'Rename';
      renameBtn.addEventListener('click', () => renamePreset(preset.id));
      const dupBtn = document.createElement('button');
      dupBtn.type = 'button'; dupBtn.className = 'btn'; dupBtn.textContent = 'Duplicate';
      dupBtn.addEventListener('click', () => duplicatePreset(preset.id));
      const delBtn = document.createElement('button');
      delBtn.type = 'button'; delBtn.className = 'btn btn-danger'; delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deletePreset(preset.id));
      li.append(name, loadBtn, renameBtn, dupBtn, delBtn);
      presetsList.appendChild(li);
    });
  }

  function loadPreset(id) {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    if (!confirmIfDirty('You have unsaved changes to the current wheel. Load this preset anyway?')) return;
    state = JSON.parse(JSON.stringify(preset.state));
    dirty = false;
    persistState();
    renderAll();
    announce(`Loaded preset ${preset.name}`);
  }
  function renamePreset(id) {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const name = window.prompt('Rename preset', preset.name);
    if (!name || !name.trim()) return;
    preset.name = name.trim();
    preset.updatedAt = new Date().toISOString();
    persistPresets();
    renderPresets();
  }
  function duplicatePreset(id) {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    presets = [...presets, {
      id: genId('preset'),
      name: `${preset.name} (copy)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: JSON.parse(JSON.stringify(preset.state)),
    }];
    persistPresets();
    renderPresets();
  }
  function deletePreset(id) {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    if (!window.confirm(`Delete preset "${preset.name}"? This cannot be undone.`)) return;
    presets = presets.filter((p) => p.id !== id);
    persistPresets();
    renderPresets();
  }

  savePresetBtn.addEventListener('click', () => {
    const name = presetNameInput.value.trim();
    if (!name) { presetNameInput.focus(); return; }
    const obj = JSON.parse(serializePreset(state, name));
    presets = [...presets, { id: obj.id, name: obj.name, createdAt: obj.createdAt, updatedAt: obj.createdAt, state: obj.state }];
    persistPresets();
    presetNameInput.value = '';
    renderPresets();
    announce(`Saved preset ${name}`);
  });
  exportPresetBtn.addEventListener('click', () => {
    const name = state.title || 'Untitled';
    downloadText(serializePreset(state, name), `${slugify(name)}-preset.json`);
  });
  exportAllPresetsBtn.addEventListener('click', () => {
    downloadText(JSON.stringify({ presets }, null, 2), 'spin-wheel-presets.json');
  });
  importPresetInput.addEventListener('change', () => handleFileImport(importPresetInput, (text) => {
    const result = deserializePreset(text);
    if (!result.ok) { window.alert(`Could not import preset: ${result.error}`); return; }
    presets = [...presets, result.data];
    persistPresets();
    renderPresets();
  }));
  importLibraryInput.addEventListener('change', () => handleFileImport(importLibraryInput, (text) => {
    const result = deserializePresetLibrary(text);
    if (!result.ok) { window.alert(`Could not import presets: ${result.error}`); return; }
    presets = [...presets, ...result.data];
    persistPresets();
    renderPresets();
  }));

  /* ==================== data (config) import/export/reset ==================== */

  exportConfigBtn.addEventListener('click', () => {
    downloadText(serializeConfig(state), `${slugify(state.title)}-config.json`);
  });
  importConfigInput.addEventListener('change', () => handleFileImport(importConfigInput, (text) => {
    const result = deserializeConfig(text);
    if (!result.ok) { window.alert(`Could not import config: ${result.error}`); return; }
    if (!confirmIfDirty('Importing will replace your current wheel. Continue?')) return;
    state = result.data;
    dirty = false;
    persistState();
    renderAll();
    announce('Config imported.');
  }));
  resetDefaultsBtn.addEventListener('click', () => {
    if (!window.confirm('Reset the current wheel to defaults? History and presets are kept.')) return;
    state = createDefaultState();
    dirty = false;
    persistState();
    renderAll();
  });
  clearAllBtn.addEventListener('click', () => {
    if (!window.confirm('Clear ALL data — options, history, and presets? This cannot be undone.')) return;
    state = createDefaultState();
    history = [];
    presets = [];
    dirty = false;
    persistState();
    persistHistory();
    persistPresets();
    renderAll();
  });

  /* ==================== export (PNG / PDF / print) ==================== */

  function exportWheelPng() {
    const size = 900;
    const out = document.createElement('canvas');
    out.width = size;
    out.height = size + 90;
    const octx = out.getContext('2d');
    octx.fillStyle = getComputedColor('--bg');
    octx.fillRect(0, 0, out.width, out.height);
    octx.fillStyle = getComputedColor('--text-primary');
    octx.font = 'bold 36px system-ui, sans-serif';
    octx.textAlign = 'center';
    octx.fillText(state.title || 'Spin Wheel', out.width / 2, 54, out.width - 40);

    const tmp = document.createElement('canvas');
    tmp.width = size;
    tmp.height = size;
    drawWheel(tmp.getContext('2d'), size, size, 0, false);
    octx.drawImage(tmp, 0, 80);

    out.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, `${slugify(state.title)}-wheel.png`);
    });
  }

  function exportSliceListPdf() {
    const pool = getSpinPool(state.options, state.removedIds);
    const weights = pool.map((o) => (state.equalOdds ? 1 : Math.max(0, o.weight)));
    const total = weights.reduce((a, b) => a + b, 0);
    const rows = pool.map((o, i) => ({
      text: o.text || '(untitled)',
      weight: state.equalOdds ? '1 (equal odds)' : String(o.weight),
      percent: total > 0 ? weightToPercent(weights[i], total).toFixed(1) : '0.0',
      color: o.color,
    }));
    const bytes = buildSimplePdf({ title: state.title, rows, generatedAt: new Date().toLocaleString() });
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${slugify(state.title)}-slices.pdf`);
  }

  function renderPrintTable() {
    printTitle.textContent = state.title || 'Spin Wheel';
    printSliceTableBody.innerHTML = '';
    const pool = getSpinPool(state.options, state.removedIds);
    const weights = pool.map((o) => (state.equalOdds ? 1 : Math.max(0, o.weight)));
    const total = weights.reduce((a, b) => a + b, 0);
    pool.forEach((o, i) => {
      const tr = document.createElement('tr');
      const swatchTd = document.createElement('td');
      const swatch = document.createElement('span');
      swatch.className = 'swatch-cell';
      swatch.style.background = o.color;
      swatchTd.appendChild(swatch);
      const nameTd = document.createElement('td');
      nameTd.textContent = o.text;
      const weightTd = document.createElement('td');
      weightTd.textContent = state.equalOdds ? '1 (equal odds)' : String(o.weight);
      const pctTd = document.createElement('td');
      pctTd.textContent = total > 0 ? `${weightToPercent(weights[i], total).toFixed(1)}%` : '0%';
      tr.append(swatchTd, nameTd, weightTd, pctTd);
      printSliceTableBody.appendChild(tr);
    });
  }

  exportPngBtn.addEventListener('click', exportWheelPng);
  exportPdfBtn.addEventListener('click', exportSliceListPdf);
  printBtn.addEventListener('click', () => { renderPrintTable(); window.print(); });
  window.addEventListener('beforeprint', renderPrintTable);

  /* ==================== boot ==================== */

  function renderModesUI() {
    equalOddsToggle.checked = state.equalOdds;
    noRepeatToggle.checked = state.noRepeat;
    highDistinctionToggle.checked = state.highDistinction;
    colorblindSelect.value = state.colorblindSim;
    themeSelect.value = state.theme;
    volumeSlider.value = String(state.volume);
    muteBtn.textContent = state.muted ? '🔇' : '🔊';
    muteBtn.setAttribute('aria-pressed', String(state.muted));
    durationInputs.forEach((input) => { input.checked = input.value === state.durationPreset; });
  }

  function renderAll() {
    titleInput.value = state.title;
    pageTitle.textContent = state.title || 'Spin Wheel';
    document.title = state.title || 'Spin Wheel';
    applyTheme();
    renderModesUI();
    renderOptionsList();
    renderSrOptionsList();
    resizeAndRenderWheel();
    renderSpinState();
    renderHistory();
    renderPresets();
  }

  spinBtn.addEventListener('click', handleSpin);
  window.addEventListener('beforeunload', persistState);
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', () => resizeAndRenderWheel());
  }

  renderAll();
}

if (typeof document !== 'undefined') {
  main();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('Spin Wheel: service worker registration failed — offline support unavailable.', err);
      });
    });
  }
}

})();
