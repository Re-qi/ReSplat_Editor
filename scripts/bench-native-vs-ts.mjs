// Precise TS vs C++ simplifyNodeBatched comparison + timing.
// Usage: node scripts/bench-native-vs-ts.mjs [N] [shCols]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const N = parseInt(process.argv[2] ?? '100000', 10);
const SH = parseInt(process.argv[3] ?? '0', 10);

const nanogs = await import('../dist/nanogs.mjs');
const nativeAddon = require('../native/index.js');
console.log('native simplifyNodeProgressive available:', typeof nativeAddon.simplifyNodeProgressive === 'function');

const RATIOS = [0.85, 0.70, 0.55, 0.40, 0.25];

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
    return { cols, colNames: ['x','y','z','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3', ...shNames], shNames };
}

const { cols, colNames, shNames } = makeCols(N, SH);
const indices = Array.from({ length: N }, (_, i) => i);
const opts = nanogs.defaultSimplifyOpts({ shCols: SH });

// warmup
nanogs.simplifyNodeBatched(indices, cols, colNames, shNames, RATIOS, opts);

const t0 = performance.now();
const tsRes = nanogs.simplifyNodeBatched(indices, cols, colNames, shNames, RATIOS, opts);
const t1 = performance.now();

nanogs.setNativeImpl(nativeAddon.simplifyNodeProgressive);
const cppRes = nanogs.simplifyNodeBatched(indices, cols, colNames, shNames, RATIOS, opts);
const t2 = performance.now();
nanogs.setNativeImpl(null);

console.log(`\nN=${N.toLocaleString()} shCols=${SH}`);
console.log(`TS  : ${((t1 - t0) / 1000).toFixed(2)}s  counts=${tsRes ? tsRes.map(r => r.count).join(',') : 'null'}`);
console.log(`C++ : ${((t2 - t1) / 1000).toFixed(2)}s  counts=${cppRes ? cppRes.map(r => r.count).join(',') : 'null'}`);
console.log(`speedup: ${((t1 - t0) / Math.max(1, t2 - t1)).toFixed(1)}x`);

if (tsRes && cppRes) {
    const sameCounts = JSON.stringify(tsRes.map(r => r.count)) === JSON.stringify(cppRes.map(r => r.count));
    console.log('counts identical:', sameCounts);
    // compare per-ratio per-column means for a few columns
    for (let r = 0; r < RATIOS.length; ++r) {
        for (const cn of ['x', 'opacity', 'scale_0', 'rot_0']) {
            const ts = tsRes[r].cols[cn];
            const cp = cppRes[r].cols[cn];
            let tsM = 0, cpM = 0;
            for (let i = 0; i < ts.length; ++i) tsM += ts[i];
            for (let i = 0; i < cp.length; ++i) cpM += cp[i];
            tsM /= ts.length; cpM /= cp.length;
            console.log(`  r=${RATIOS[r]} ${cn}: TS=${tsM.toFixed(5)} C++=${cpM.toFixed(5)} d=${Math.abs(tsM-cpM).toExponential(2)}`);
        }
    }
}
