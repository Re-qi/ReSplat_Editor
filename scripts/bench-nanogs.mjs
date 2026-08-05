// Micro-benchmark: where does simplifyNodeBatched time go?
// Runs on synthetic data sized like a real LCC2 node batch (up to 100K splats).
// Usage: node scripts/bench-nanogs.mjs [N] [shCols]
// Requires a prior `npm run build` (imports dist/nanogs.mjs).

import { performance } from 'node:perf_hooks';

const N = parseInt(process.argv[2] ?? '100000', 10);
const SH = parseInt(process.argv[3] ?? '0', 10);
console.log(`\n=== bench: N=${N.toLocaleString()} splats, shCols=${SH} ===`);

const nanogs = await import('../dist/nanogs.mjs');
const { knnIndices, simplifyNodeBatched, defaultSimplifyOpts, simplifyProgressive } = nanogs;

// Deterministic pseudo-random spatial data (clustered-ish, like a real cell)
let seed = 777;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const colNames = ['x','y','z','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
const cols = {
    x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N),
    opacity: new Float32Array(N),
    scale_0: new Float32Array(N), scale_1: new Float32Array(N), scale_2: new Float32Array(N),
    rot_0: new Float32Array(N), rot_1: new Float32Array(N),
    rot_2: new Float32Array(N), rot_3: new Float32Array(N)
};
for (let i = 0; i < N; ++i) {
    // cluster center + jitter: 40 clusters × 2500 points (uniform 1..10)
    const cx = Math.floor(rnd() * 10), cy = Math.floor(rnd() * 10), cz = Math.floor(rnd() * 10);
    cols.x[i] = cx + rnd() * 0.3;
    cols.y[i] = cy + rnd() * 0.3;
    cols.z[i] = cz + rnd() * 0.3;
    cols.opacity[i] = -3 + rnd() * 4;
    cols.scale_0[i] = -4 + rnd() * 3;
    cols.scale_1[i] = -4 + rnd() * 3;
    cols.scale_2[i] = -4 + rnd() * 3;
    const qa = rnd()-0.5, qb = rnd()-0.5, qc = rnd()-0.5, qd = rnd()-0.5;
    const n = Math.hypot(qa, qb, qc, qd) || 1;
    cols.rot_0[i] = qa/n; cols.rot_1[i] = qb/n; cols.rot_2[i] = qc/n; cols.rot_3[i] = qd/n;
}
const indices = Array.from({ length: N }, (_, i) => i);

// --- 1. Single KNN pass timing (k=16) ---
{
    const means = new Float32Array(N * 3);
    for (let i = 0; i < N; ++i) {
        means[i*3] = cols.x[i]; means[i*3+1] = cols.y[i]; means[i*3+2] = cols.z[i];
    }
    const t0 = performance.now();
    const nbr = knnIndices(means, N, 16);
    const t1 = performance.now();
    console.log(`[1] knnIndices N=${N.toLocaleString()} k=16: ${(t1-t0).toFixed(1)} ms`);
    // how many neighbors are spatially close (sanity)
    let close = 0;
    for (let i = 0; i < N; ++i) {
        const x = means[i*3], y = means[i*3+1], z = means[i*3+2];
        for (let j = 0; j < 16; ++j) {
            const idx = nbr[i*16+j];
            const dx = means[idx*3]-x, dy = means[idx*3+1]-y, dz = means[idx*3+2]-z;
            if (dx*dx+dy*dy+dz*dz < 0.5) close++;
        }
    }
    console.log(`    (${(close/(N*16)*100).toFixed(1)}% neighbors within r=0.7)`);
}

// --- 2. Full simplifyNodeBatched, 5 LOD ratios (the real export cost) ---
{
    const opts = defaultSimplifyOpts({ shCols: SH });
    const ratios = [0.85, 0.70, 0.55, 0.40, 0.25];
    const t0 = performance.now();
    const out = simplifyNodeBatched(indices, cols, colNames, [], ratios, opts);
    const t1 = performance.now();
    console.log(`[2] simplifyNodeBatched 5 ratios: ${((t1-t0)/1000).toFixed(2)} s`);
    if (Array.isArray(out)) {
        out.forEach((r, i) => console.log(`    ratio ${ratios[i]} -> count ${r.count} (${(r.count/N*100).toFixed(1)}%)`));
    } else {
        console.log('    -> null (fell back)');
    }
}

// --- 3. Rough iteration-count proxy: count how many KNN passes simplifyProgressive needs ---
{
    // Build activated attrs directly via nodeAttrsFromColumns
    const attrs = nanogs.nodeAttrsFromColumns(indices, cols, []);
    const opts = defaultSimplifyOpts({ shCols: SH });
    const ratios = [0.85, 0.70, 0.55, 0.40, 0.25];
    // instrument: wrap knnIndices to count calls
    let calls = 0;
    const orig = nanogs.knnIndices;
    // can't monkeypatch ESM import easily; just time the whole thing again
    const t0 = performance.now();
    const snaps = simplifyProgressive(attrs, ratios, opts);
    const t1 = performance.now();
    console.log(`[3] simplifyProgressive (attrs path): ${((t1-t0)/1000).toFixed(2)} s, snaps=${snaps.length}`);
    if (snaps.length) console.log(`    counts: ${snaps.map(s => s.mu.length/3).join(', ')}`);
}
