// Test harness: port GLSL hsl2rgb / applyHslMixer to JS, compare with TS reference.
// This is the feedback loop for diagnosing the HSL mixer color rotation bug.
//
// Usage: node scripts/test-hsl-mixer.mjs

// HSL mixer constants (mirrored from src/color-grade.ts)
const HSL_CENTERS_DEG = [0, 30, 60, 120, 165, 220, 275, 315];
const HSL_HALF_WIDTHS_DEG = [20, 20, 20, 25, 20, 25, 20, 20];
const HSL_CENTERS_F32 = new Float32Array(HSL_CENTERS_DEG.map(d => d / 360));
const HSL_HALF_WIDTHS_F32 = new Float32Array(HSL_HALF_WIDTHS_DEG.map(d => d / 360));

// ─── TS reference (correct, from color-grade.ts) ───────────────────────────

const tsRgb2hsl = (r, g, b) => {
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    const l = (maxc + minc) * 0.5;
    const d = maxc - minc;
    let h = 0, s = 0;
    if (d > 1e-6) {
        s = (l < 0.5) ? d / (maxc + minc) : d / (2 - maxc - minc);
        if (maxc === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (maxc === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 0.16666667;
    }
    return [h, s, l];
};

const tsHue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 0.16666667) return p + (q - p) * 6 * t;
    if (t < 0.5) return q;
    if (t < 0.66666667) return p + (q - p) * (0.66666667 - t) * 6;
    return p;
};

const tsHsl2rgb = (h, s, l) => {
    if (s < 1e-6) return [l, l, l];
    const q = (l < 0.5) ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
        tsHue2rgb(p, q, h + 0.33333333),
        tsHue2rgb(p, q, h),
        tsHue2rgb(p, q, h - 0.33333333)
    ];
};

const tsRangeWeight = (hue, center, halfWidth) => {
    let d = Math.abs(hue - center);
    d = Math.min(d, 1 - d);
    if (d >= halfWidth) return 0;
    const t = 1 - d / halfWidth;
    return t * t * (3 - 2 * t);
};

// ─── GLSL port (current, potentially buggy) ────────────────────────────────

const glslRgb2hsl = (r, g, b) => {
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    const l = (maxc + minc) * 0.5;
    const d = maxc - minc;
    let h = 0, s = 0;
    if (d > 1e-6) {
        s = (l < 0.5) ? d / (maxc + minc) : d / (2 - maxc - minc);
        if (maxc === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (maxc === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 0.16666667;
    }
    return [h, s, l];
};

// Current GLSL hsl2rgb (from splat-shader.ts line 65-87) — BUGGY VERSION
const glslHsl2rgbBuggy = (hsl) => {
    const h = hsl[0], s = hsl[1], l = hsl[2];
    if (s < 1e-6) return [l, l, l];
    const q = (l < 0.5) ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    // BUGGY: hk offsets are h+2/3, h+1/3, h for r, g, b
    // Should be: h+1/3, h, h-1/3
    const hk = [h + 0.66666667, h + 0.33333333, h, h - 0.33333333, h - 0.66666667, h + 0.66666667];
    const rgb = [q, q, q];
    for (let i = 0; i < 3; i++) {
        let t = hk[i];
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 0.16666667) rgb[i] = p + (q - p) * 6 * t;
        else if (t < 0.5) rgb[i] = q;
        else if (t < 0.66666667) rgb[i] = p + (q - p) * (0.66666667 - t) * 6;
        else rgb[i] = p;
    }
    return [rgb[0], rgb[1], rgb[2]];
};

// Fixed GLSL hsl2rgb — corrected hk offsets
const glslHsl2rgbFixed = (hsl) => {
    const h = hsl[0], s = hsl[1], l = hsl[2];
    if (s < 1e-6) return [l, l, l];
    const q = (l < 0.5) ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    // FIXED: correct r/g/b offsets matching TS reference
    const hk = [h + 0.33333333, h, h - 0.33333333];
    const rgb = [q, q, q];
    for (let i = 0; i < 3; i++) {
        let t = hk[i];
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 0.16666667) rgb[i] = p + (q - p) * 6 * t;
        else if (t < 0.5) rgb[i] = q;
        else if (t < 0.66666667) rgb[i] = p + (q - p) * (0.66666667 - t) * 6;
        else rgb[i] = p;
    }
    return [rgb[0], rgb[1], rgb[2]];
};

// GLSL applyHslMixer port
const glslApplyHslMixer = (rgb, hueShifts, satShifts, lightShifts, hsl2rgbFn) => {
    const hsl = glslRgb2hsl(rgb[0], rgb[1], rgb[2]);
    let totalWeight = 0, sumHue = 0, sumSat = 0, sumLight = 0;
    for (let i = 0; i < 8; i++) {
        const w = tsRangeWeight(hsl[0], HSL_CENTERS_F32[i], HSL_HALF_WIDTHS_F32[i]);
        totalWeight += w;
        sumHue += w * hueShifts[i];
        sumSat += w * satShifts[i];
        sumLight += w * lightShifts[i];
    }
    if (totalWeight > 1e-4) {
        const invW = 1 / totalWeight;
        hsl[0] = ((hsl[0] + sumHue * invW) % 1 + 1) % 1;
        hsl[1] = Math.max(0, Math.min(1, hsl[1] + sumSat * invW));
        hsl[2] = Math.max(0, Math.min(1, hsl[2] + sumLight * invW));
        return hsl2rgbFn(hsl);
    }
    return rgb;
};

// ─── Test helpers ──────────────────────────────────────────────────────────

const approxEq = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;
const rgbEq = (a, b, eps = 1e-4) => approxEq(a[0], b[0], eps) && approxEq(a[1], b[1], eps) && approxEq(a[2], b[2], eps);

const fmt = (rgb) => `[${rgb.map(v => v.toFixed(4)).join(', ')}]`;

let pass = 0, fail = 0;
const assert = (name, cond, extra = '') => {
    if (cond) { pass++; }
    else { fail++; console.log(`  ✗ FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
};

// ─── Test colors ───────────────────────────────────────────────────────────

const testColors = [
    { name: 'red',       rgb: [1, 0, 0] },
    { name: 'green',     rgb: [0, 1, 0] },
    { name: 'blue',      rgb: [0, 0, 1] },
    { name: 'yellow',    rgb: [1, 1, 0] },
    { name: 'cyan',      rgb: [0, 1, 1] },
    { name: 'magenta',   rgb: [1, 0, 1] },
    { name: 'white',     rgb: [1, 1, 1] },
    { name: 'gray',      rgb: [0.5, 0.5, 0.5] },
    { name: 'orange',    rgb: [1, 0.5, 0] },
    { name: 'purple',    rgb: [0.5, 0, 0.5] },
    { name: 'teal',      rgb: [0, 0.5, 0.5] },
    { name: 'pink',      rgb: [1, 0.75, 0.75] },
];

// ─── Test 1: Round-trip rgb→hsl→rgb should be identity (TS reference) ──────

console.log('\n=== Test 1: TS reference round-trip (rgb→hsl→rgb identity) ===');
for (const { name, rgb } of testColors) {
    const hsl = tsRgb2hsl(rgb[0], rgb[1], rgb[2]);
    const result = tsHsl2rgb(hsl[0], hsl[1], hsl[2]);
    assert(`TS round-trip ${name}`, rgbEq(rgb, result), `${fmt(rgb)} → ${fmt(result)}`);
}

// ─── Test 2: Buggy GLSL hsl2rgb vs TS reference — should DIFFER ─────────────

console.log('\n=== Test 2: Buggy GLSL hsl2rgb vs TS reference (expect MISMATCH) ===');
let buggyMismatches = 0;
for (const { name, rgb } of testColors) {
    const hsl = tsRgb2hsl(rgb[0], rgb[1], rgb[2]);
    const tsResult = tsHsl2rgb(hsl[0], hsl[1], hsl[2]);
    const glslBuggy = glslHsl2rgbBuggy(hsl);
    const matches = rgbEq(tsResult, glslBuggy);
    // Colors with s=0 (white, gray) take the early-return path in hsl2rgb,
    // so the hue offset bug doesn't affect them — they WILL match.
    if (!matches) buggyMismatches++;
    if (hsl[1] < 1e-6) {
        assert(`Buggy GLSL = TS for ${name} (s=0, no hue)`, matches, `TS=${fmt(tsResult)} GLSL=${fmt(glslBuggy)}`);
    } else {
        assert(`Buggy GLSL ≠ TS for ${name} (s>0, hue rotated)`, !matches, `TS=${fmt(tsResult)} GLSL=${fmt(glslBuggy)}`);
    }
}
console.log(`  → ${buggyMismatches}/${testColors.length} colors mismatched (expected: all non-gray)`);

// ─── Test 3: Fixed GLSL hsl2rgb vs TS reference — should MATCH ──────────────

console.log('\n=== Test 3: Fixed GLSL hsl2rgb vs TS reference (expect MATCH) ===');
for (const { name, rgb } of testColors) {
    const hsl = tsRgb2hsl(rgb[0], rgb[1], rgb[2]);
    const tsResult = tsHsl2rgb(hsl[0], hsl[1], hsl[2]);
    const glslFixed = glslHsl2rgbFixed(hsl);
    assert(`Fixed GLSL = TS for ${name}`, rgbEq(tsResult, glslFixed), `TS=${fmt(tsResult)} GLSL=${fmt(glslFixed)}`);
}

// ─── Test 4: Buggy GLSL produces 120° hue rotation ─────────────────────────

console.log('\n=== Test 4: Buggy GLSL produces 120° hue rotation ===');
// Red (h=0) should become green (h=1/3) after 120° rotation
const redHsl = tsRgb2hsl(1, 0, 0);  // h=0, s=1, l=0.5
const buggyRed = glslHsl2rgbBuggy(redHsl);
const greenRgb = [0, 1, 0];
assert('Buggy red→green (120° rotation)', rgbEq(buggyRed, greenRgb, 0.01), `got ${fmt(buggyRed)}, expected ${fmt(greenRgb)}`);

// Green (h=1/3) should become blue (h=2/3) after 120° rotation
const greenHsl = tsRgb2hsl(0, 1, 0);
const buggyGreen = glslHsl2rgbBuggy(greenHsl);
const blueRgb = [0, 0, 1];
assert('Buggy green→blue (120° rotation)', rgbEq(buggyGreen, blueRgb, 0.01), `got ${fmt(buggyGreen)}, expected ${fmt(blueRgb)}`);

// Blue (h=2/3) should become red (h=0) after 120° rotation
const blueHsl = tsRgb2hsl(0, 0, 1);
const buggyBlue = glslHsl2rgbBuggy(blueHsl);
assert('Buggy blue→red (120° rotation)', rgbEq(buggyBlue, [1, 0, 0], 0.01), `got ${fmt(buggyBlue)}, expected [1, 0, 0]`);

// ─── Test 5: applyHslMixer with ALL shifts = 0 should return original ──────

console.log('\n=== Test 5: applyHslMixer with all shifts=0 (buggy vs fixed) ===');
const zeroShifts = new Float32Array(8);
for (const { name, rgb } of testColors) {
    const hsl = tsRgb2hsl(rgb[0], rgb[1], rgb[2]);
    // Buggy version: even with 0 shifts, hsl2rgb is called → 120° rotation (only if s>0)
    const buggyResult = glslApplyHslMixer([...rgb], zeroShifts, zeroShifts, zeroShifts, glslHsl2rgbBuggy);
    const buggyIsOriginal = rgbEq(buggyResult, rgb, 1e-4);

    // Fixed version: with 0 shifts, hsl2rgb returns original (correct round-trip)
    const fixedResult = glslApplyHslMixer([...rgb], zeroShifts, zeroShifts, zeroShifts, glslHsl2rgbFixed);
    const fixedIsOriginal = rgbEq(fixedResult, rgb, 1e-4);

    if (hsl[1] < 1e-6) {
        // s=0: no hue, early return in hsl2rgb → both buggy and fixed preserve original
        assert(`Buggy mixer(0) IS original for ${name} (s=0)`, buggyIsOriginal, `orig=${fmt(rgb)} result=${fmt(buggyResult)}`);
    } else {
        // s>0: buggy rotates 120°, fixed preserves original
        assert(`Buggy mixer(0) NOT original for ${name} (s>0)`, !buggyIsOriginal, `orig=${fmt(rgb)} result=${fmt(buggyResult)}`);
    }
    assert(`Fixed mixer(0) IS original for ${name}`, fixedIsOriginal, `orig=${fmt(rgb)} result=${fmt(fixedResult)}`);
}

// ─── Test 6: applyHslMixer with one non-zero shift — only that range changes ─

console.log('\n=== Test 6: Fixed mixer — red hue +180° shifts only red range ===');
const hueShifts = new Float32Array(8);
hueShifts[0] = 0.5;  // red range +180° (0.5 in normalized = 180°)
const zeroSat = new Float32Array(8);
const zeroLight = new Float32Array(8);

// Red color in red range → should shift to cyan (180° hue shift)
const redResult = glslApplyHslMixer([1, 0, 0], hueShifts, zeroSat, zeroLight, glslHsl2rgbFixed);
const redHslResult = tsRgb2hsl(redResult[0], redResult[1], redResult[2]);
assert('Red hue+180 → cyan-ish (h≈0.5)', approxEq(redHslResult[0], 0.5, 0.05), `h=${redHslResult[0].toFixed(4)}`);

// Blue color NOT in red range → should be unchanged
const blueResult = glslApplyHslMixer([0, 0, 1], hueShifts, zeroSat, zeroLight, glslHsl2rgbFixed);
assert('Blue unchanged (not in red range)', rgbEq(blueResult, [0, 0, 1], 1e-4), `got ${fmt(blueResult)}`);

// ─── Test 7: Buggy mixer — red hue +180° ALSO rotates blue (the bug) ────────

console.log('\n=== Test 7: Buggy mixer — red hue +180° ALSO corrupts blue (bug demo) ===');
const buggyBlueResult = glslApplyHslMixer([0, 0, 1], hueShifts, zeroSat, zeroLight, glslHsl2rgbBuggy);
assert('Buggy: blue gets corrupted by red hue shift', !rgbEq(buggyBlueResult, [0, 0, 1], 0.01), `got ${fmt(buggyBlueResult)}`);
console.log(`  → Blue was ${fmt([0,0,1])}, became ${fmt(buggyBlueResult)} — THIS IS THE BUG`);

// ─── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
console.log(`${'='.repeat(60)}`);
process.exit(fail > 0 ? 1 : 0);
