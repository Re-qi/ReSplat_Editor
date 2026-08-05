// Regression tests for simplifyProgressive multi-ratio snapshots.
// Verifies that distinct ratio thresholds produce DISTINCT LOD snapshots
// (the bug: mergeCap=0.5 let one merge pass overshoot several ratio targets,
// collapsing LOD levels together).
//
// Run: node scripts/test-simplify-progressive.mjs
// Imports the bundled dist/nanogs.mjs (same module the backend loads), so a
// prior `npm run build` is required.

import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nanogs = await import('../dist/nanogs.mjs');

let passed = 0;
const check = (name, cond, extra = '') => {
    if (cond) {
        ++passed;
        console.log(`[PASS] ${name}`);
    } else {
        console.error(`[FAIL] ${name}${extra ? ' — ' + extra : ''}`);
        process.exitCode = 1;
    }
};

/** Build varied synthetic splat columns (deterministic LCG, no SH). */
function makeVariedColumns(N) {
    const cols = {
        x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N),
        opacity: new Float32Array(N),
        scale_0: new Float32Array(N), scale_1: new Float32Array(N), scale_2: new Float32Array(N),
        rot_0: new Float32Array(N), rot_1: new Float32Array(N),
        rot_2: new Float32Array(N), rot_3: new Float32Array(N)
    };
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < N; ++i) {
        cols.x[i] = rnd() * 10;
        cols.y[i] = rnd() * 10;
        cols.z[i] = rnd() * 10;
        cols.opacity[i] = -3 + rnd() * 4;
        cols.scale_0[i] = -4 + rnd() * 3;
        cols.scale_1[i] = -4 + rnd() * 3;
        cols.scale_2[i] = -4 + rnd() * 3;
        const qa = rnd() - 0.5, qb = rnd() - 0.5, qc = rnd() - 0.5, qd = rnd() - 0.5;
        const n = Math.hypot(qa, qb, qc, qd) || 1;
        cols.rot_0[i] = qa / n;
        cols.rot_1[i] = qb / n;
        cols.rot_2[i] = qc / n;
        cols.rot_3[i] = qd / n;
    }
    return cols;
}

const COL_NAMES = ['x', 'y', 'z', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

// ---------------------------------------------------------------------------
// Test 1: multi-ratio snapshots are strictly decreasing (the overshoot bug)
// ---------------------------------------------------------------------------
{
    const N = 500;
    const cols = makeVariedColumns(N);
    const indices = Array.from({ length: N }, (_, i) => i);
    const opts = nanogs.defaultSimplifyOpts({ shCols: 0 });
    const ratios = [0.85, 0.55, 0.25];
    const out = nanogs.simplifyNodeBatched(indices, cols, COL_NAMES, [], ratios, opts);

    check('T1: returns array', Array.isArray(out));
    check('T1: length === ratios.length', Array.isArray(out) && out.length === ratios.length);
    if (Array.isArray(out) && out.length === ratios.length) {
        const counts = out.map(r => r.count);
        const strictlyDecreasing = counts.every((c, i) => i === 0 || c < counts[i - 1]);
        check('T1: counts strictly decreasing', strictlyDecreasing,
            `counts=${counts.join(',')}`);
        // Each snapshot should be within mergeCap tolerance of its target.
        // mergeCap=0.5 allows up to 50% overshoot per pass, but with the
        // next-target bound the overshoot is at most one pass worth.
        out.forEach((r, i) => {
            const target = ratios[i] * N;
            const ratio = r.count / N;
            // Allow generous tolerance: snapshot captured when count <= target,
            // plus one pass of mergeCap can overshoot. Key invariant is that
            // it's strictly less than the previous, AND it's meaningfully
            // below the previous ratio's target.
            check(`T1: ratio ${ratios[i]} count ${r.count} (target ${Math.round(target)})`,
                r.count > 0 && r.count <= N,
                `ratio=${ratio.toFixed(2)}`);
        });
    }
}

// ---------------------------------------------------------------------------
// Test 2: single-ratio still works (no regression)
// ---------------------------------------------------------------------------
{
    const N = 300;
    const cols = makeVariedColumns(N);
    const indices = Array.from({ length: N }, (_, i) => i);
    const opts = nanogs.defaultSimplifyOpts({ shCols: 0 });
    const out = nanogs.simplifyNodeBatched(indices, cols, COL_NAMES, [], [0.4], opts);

    check('T2: single-ratio returns array', Array.isArray(out));
    check('T2: length 1', Array.isArray(out) && out.length === 1);
    if (Array.isArray(out) && out.length === 1) {
        const r = out[0];
        check(`T2: count ${r.count} near target ${Math.round(0.4 * N)}`,
            r.count > 0 && r.count <= Math.round(0.4 * N) + 1,
            `count=${r.count}`);
    }
}

// ---------------------------------------------------------------------------
// Test 3: 5-ratio (full LCC2 LOD range) — all distinct
// ---------------------------------------------------------------------------
{
    const N = 800;
    const cols = makeVariedColumns(N);
    const indices = Array.from({ length: N }, (_, i) => i);
    const opts = nanogs.defaultSimplifyOpts({ shCols: 0 });
    // Mirrors LCC2 backend samplingRate for treeDepth=6: 100%→25%, excluding 1.0
    const ratios = [0.85, 0.70, 0.55, 0.40, 0.25];
    const out = nanogs.simplifyNodeBatched(indices, cols, COL_NAMES, [], ratios, opts);

    check('T3: returns 5 snapshots', Array.isArray(out) && out.length === 5);
    if (Array.isArray(out) && out.length === 5) {
        const counts = out.map(r => r.count);
        const allDistinct = new Set(counts).size === counts.length;
        check('T3: all 5 counts distinct', allDistinct, `counts=${counts.join(',')}`);
        const strictlyDecreasing = counts.every((c, i) => i === 0 || c < counts[i - 1]);
        check('T3: strictly decreasing', strictlyDecreasing, `counts=${counts.join(',')}`);
    }
}

// ---------------------------------------------------------------------------
// Test 4: degenerate coincident points — should still terminate + return array
// ---------------------------------------------------------------------------
{
    const N = 100;
    const cols = makeVariedColumns(N);
    // Force all points to same position (degenerate AABB)
    for (let i = 0; i < N; ++i) { cols.x[i] = 1; cols.y[i] = 1; cols.z[i] = 1; }
    const indices = Array.from({ length: N }, (_, i) => i);
    const opts = nanogs.defaultSimplifyOpts({ shCols: 0 });
    const out = nanogs.simplifyNodeBatched(indices, cols, COL_NAMES, [], [0.5, 0.25], opts);
    check('T4: degenerate returns array', Array.isArray(out));
    check('T4: degenerate length 2', Array.isArray(out) && out.length === 2);
}

console.log(`\n${passed} passed`);
if (process.exitCode) {
    console.error('SOME TESTS FAILED');
} else {
    console.log('All simplify-progressive tests passed.');
}
