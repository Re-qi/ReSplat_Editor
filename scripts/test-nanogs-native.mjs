// Numeric parity test: TS simplifyNodeBatched vs C++ simplifyNodeProgressive.
// Verifies that the native path produces near-identical snapshot counts (within
// 1 splat — greedy pair selection differs slightly between the unstable C++
// sort and the stable JS sort) and statistically identical columns (mean per
// column within tolerance).
//
// Usage: node scripts/test-nanogs-native.mjs
// Requires: `npm run build` (dist/nanogs.mjs with setNativeImpl) + compiled
// native/ply_reader.node (node-gyp rebuild).

import { createRequire } from 'node:module';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const nanogs = await import('../dist/nanogs.mjs');
const nativeAddon = require('../native/index.js');

let passed = 0;
const check = (name, cond, extra = '') => {
    if (cond) { ++passed; console.log(`[PASS] ${name}`); }
    else { console.error(`[FAIL] ${name}${extra ? ' — ' + extra : ''}`); process.exitCode = 1; }
};

if (!nativeAddon || typeof nativeAddon.simplifyNodeProgressive !== 'function') {
    console.error('native simplifyNodeProgressive NOT available — rebuild native first');
    process.exit(1);
}

// Deterministic clustered synthetic data (like a real cell batch)
function makeCols(N, shCols = 0) {
    const cols = {
        x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N),
        opacity: new Float32Array(N),
        scale_0: new Float32Array(N), scale_1: new Float32Array(N), scale_2: new Float32Array(N),
        rot_0: new Float32Array(N), rot_1: new Float32Array(N),
        rot_2: new Float32Array(N), rot_3: new Float32Array(N)
    };
    const shNames = [];
    for (let c = 0; c < shCols; ++c) {
        const cn = c < 3 ? `f_dc_${c}` : `f_rest_${c - 3}`;
        cols[cn] = new Float32Array(N);
        shNames.push(cn);
    }
    let seed = 20260804;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < N; ++i) {
        const cx = Math.floor(rnd() * 8), cy = Math.floor(rnd() * 8), cz = Math.floor(rnd() * 8);
        cols.x[i] = cx + rnd() * 0.25;
        cols.y[i] = cy + rnd() * 0.25;
        cols.z[i] = cz + rnd() * 0.25;
        cols.opacity[i] = -3 + rnd() * 4;
        cols.scale_0[i] = -4 + rnd() * 3;
        cols.scale_1[i] = -4 + rnd() * 3;
        cols.scale_2[i] = -4 + rnd() * 3;
        const qa = rnd()-0.5, qb = rnd()-0.5, qc = rnd()-0.5, qd = rnd()-0.5;
        const n = Math.hypot(qa, qb, qc, qd) || 1;
        cols.rot_0[i] = qa/n; cols.rot_1[i] = qb/n; cols.rot_2[i] = qc/n; cols.rot_3[i] = qd/n;
        for (let c = 0; c < shCols; ++c) cols[shNames[c]][i] = (rnd() - 0.5) * 2;
    }
    const colNames = ['x','y','z','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3', ...shNames];
    return { cols, colNames, shNames };
}

function stats(arr) {
    let s = 0, ss = 0;
    for (let i = 0; i < arr.length; ++i) { s += arr[i]; ss += arr[i] * arr[i]; }
    const n = arr.length;
    const mean = s / n;
    const sd = Math.sqrt(Math.max(0, ss / n - mean * mean));
    return { mean, sd };
}

// Counts may differ by ≤1 splat (greedy tie-break between unstable C++ sort
// and stable JS sort). Column means: loose tolerance — the merged splat SET
// differs slightly, so means are close but not bit-identical.
const countClose = (a, b) => Math.abs(a - b) <= 1;
const meanClose = (a, b) => Math.abs(a - b) <= Math.max(0.15, Math.abs(a) * 0.1);

const RATIOS = [0.85, 0.70, 0.55, 0.40, 0.25];

// ---- Test 1: SH=0, small node (single batch) ----
{
    const N = 600;
    const { cols, colNames, shNames } = makeCols(N, 0);
    const indices = Array.from({ length: N }, (_, i) => i);
    const opts = nanogs.defaultSimplifyOpts({ shCols: 0 });

    const tsRes = nanogs.simplifyNodeBatched(indices, cols, colNames, shNames, RATIOS, opts);
    check('T1(TS): returns m snapshots', Array.isArray(tsRes) && tsRes.length === RATIOS.length);

    nanogs.setNativeImpl(nativeAddon.simplifyNodeProgressive);
    const cppRes = nanogs.simplifyNodeBatched(indices, cols, colNames, shNames, RATIOS, opts);
    nanogs.setNativeImpl(null);

    check('T1(C++): returns m snapshots', Array.isArray(cppRes) && cppRes.length === RATIOS.length);

    if (Array.isArray(tsRes) && Array.isArray(cppRes)) {
        const tsCounts = tsRes.map(r => r.count);
        const cppCounts = cppRes.map(r => r.count);
        const countsClose = tsCounts.every((c, i) => countClose(c, cppCounts[i]));
        check('T1: counts within 1', countsClose,
            `TS=${tsCounts} C++=${cppCounts}`);
        // column stats parity per snapshot
        for (let r = 0; r < RATIOS.length; ++r) {
            for (const cn of colNames) {
                const tsS = stats(tsRes[r].cols[cn]);
                const cppS = stats(cppRes[r].cols[cn]);
                check(`T1: r=${RATIOS[r]} col=${cn} mean parity`,
                    meanClose(tsS.mean, cppS.mean),
                    `TS=${tsS.mean.toFixed(6)} C++=${cppS.mean.toFixed(6)}`);
            }
        }
    }
}

// ---- Test 2: SH=6, node with SH columns (single batch) ----
{
    const N = 500;
    const { cols, colNames, shNames } = makeCols(N, 6);
    const indices = Array.from({ length: N }, (_, i) => i);
    const opts = nanogs.defaultSimplifyOpts({ shCols: 6 });

    const tsRes = nanogs.simplifyNodeBatched(indices, cols, colNames, shNames, RATIOS, opts);
    nanogs.setNativeImpl(nativeAddon.simplifyNodeProgressive);
    const cppRes = nanogs.simplifyNodeBatched(indices, cols, colNames, shNames, RATIOS, opts);
    nanogs.setNativeImpl(null);

    check('T2: counts within 1',
        Array.isArray(tsRes) && Array.isArray(cppRes) &&
        tsRes.every((r, i) => countClose(r.count, cppRes[i].count)),
        Array.isArray(tsRes) && Array.isArray(cppRes)
            ? `TS=${tsRes.map(r=>r.count)} C++=${cppRes.map(r=>r.count)}` : 'null');
    if (Array.isArray(tsRes) && Array.isArray(cppRes)) {
        for (let r = 0; r < RATIOS.length; ++r) {
            for (const cn of colNames) {
                const tsS = stats(tsRes[r].cols[cn]);
                const cppS = stats(cppRes[r].cols[cn]);
                check(`T2: r=${RATIOS[r]} col=${cn} mean parity`,
                    meanClose(tsS.mean, cppS.mean),
                    `TS=${tsS.mean.toFixed(6)} C++=${cppS.mean.toFixed(6)}`);
            }
        }
    }
}

// ---- Test 3: large node > cap → sub-batched, SH=0 ----
{
    const N = 250000; // 2.5 batches of ≤100K
    const { cols, colNames, shNames } = makeCols(N, 0);
    const indices = Array.from({ length: N }, (_, i) => i);
    const opts = nanogs.defaultSimplifyOpts({ shCols: 0 });

    const tsRes = nanogs.simplifyNodeBatched(indices, cols, colNames, shNames, RATIOS, opts);
    nanogs.setNativeImpl(nativeAddon.simplifyNodeProgressive);
    const cppRes = nanogs.simplifyNodeBatched(indices, cols, colNames, shNames, RATIOS, opts);
    nanogs.setNativeImpl(null);

    check('T3: counts within 1 (sub-batched)',
        Array.isArray(tsRes) && Array.isArray(cppRes) &&
        tsRes.every((r, i) => countClose(r.count, cppRes[i].count)),
        Array.isArray(tsRes) && Array.isArray(cppRes)
            ? `TS=${tsRes.map(r=>r.count)} C++=${cppRes.map(r=>r.count)}` : 'null');
    if (Array.isArray(tsRes) && Array.isArray(cppRes)) {
        for (let r = 0; r < RATIOS.length; ++r) {
            for (const cn of ['x', 'opacity', 'scale_0', 'rot_0']) {
                const tsS = stats(tsRes[r].cols[cn]);
                const cppS = stats(cppRes[r].cols[cn]);
                check(`T3: r=${RATIOS[r]} col=${cn} mean parity`,
                    meanClose(tsS.mean, cppS.mean),
                    `TS=${tsS.mean.toFixed(6)} C++=${cppS.mean.toFixed(6)}`);
            }
        }
    }
}

// ---- Test 4: native speedup on 100K ----
{
    const N = 100000;
    const { cols, colNames, shNames } = makeCols(N, 0);
    const indices = Array.from({ length: N }, (_, i) => i);
    const opts = nanogs.defaultSimplifyOpts({ shCols: 0 });

    const t0 = performance.now();
    const tsRes = nanogs.simplifyNodeBatched(indices, cols, colNames, shNames, RATIOS, opts);
    const t1 = performance.now();
    nanogs.setNativeImpl(nativeAddon.simplifyNodeProgressive);
    const cppRes = nanogs.simplifyNodeBatched(indices, cols, colNames, shNames, RATIOS, opts);
    const t2 = performance.now();
    nanogs.setNativeImpl(null);

    const tsMs = t1 - t0;
    const cppMs = t2 - t1;
    console.log(`[T4] 100K: TS=${(tsMs/1000).toFixed(2)}s C++=${(cppMs/1000).toFixed(2)}s speedup=${(tsMs/Math.max(1,cppMs)).toFixed(1)}x`);
    check('T4: C++ faster than TS', cppMs < tsMs, `${cppMs.toFixed(0)}ms vs ${tsMs.toFixed(0)}ms`);
    check('T4: counts within 1',
        tsRes.every((r, i) => countClose(r.count, cppRes[i].count)),
        `TS=${tsRes.map(r=>r.count)} C++=${cppRes.map(r=>r.count)}`);
}

console.log(`\n${passed} passed`);
if (process.exitCode) console.error('SOME TESTS FAILED');
else console.log('All native parity tests passed.');
