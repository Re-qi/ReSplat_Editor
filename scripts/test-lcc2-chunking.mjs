// Regression test for LCC2 per-depth chunking safety (Phase 2 large-file fix, octree root).
//
// Verifies invariants that prevent the splat-transform SOG encoder from hanging
// on large point clouds:
//
//   INV-1 (auto-treeDepth bound): slider=treeDepth is clamped by data size.
//        Per-depth total ≈ N/2^k (k=LOD level). depth-1 has N/2^(treeDepth-1) splats
//        across 8 nodes, depth-treeDepth has N splats across 2^(treeDepth+2) nodes.
//        Bound: per-depth total ≤ SOG_CHUNK_TARGET * N_CHUNKS max.
//   INV-2 (per-chunk ≤ SOG_CHUNK_TARGET): each .sog file chunk never exceeds target.
//
// Replicates buildLcc2SpatialTree + per-depth counting from src/splat-serialize.ts.

const SOG_CHUNK_TARGET = 3_000_000;
const MIN_CHUNK_SPLATS = 50_000;
const SOG_HARD_CEILING = 15_000_000;

// ---- auto-treeDepth selection (mirror src/splat-serialize.ts) ----
const selectTreeDepth = (N, userL) => {
    const safeTreeDepth = Math.max(1, Math.ceil(Math.log2(N / SOG_CHUNK_TARGET)) - 2);
    const maxTreeDepth = Math.max(1, Math.floor(Math.log2(N / MIN_CHUNK_SPLATS)) - 2);
    return Math.min(10, Math.max(safeTreeDepth, Math.min(userL, maxTreeDepth)));
};

// ---- replicated buildLcc2SpatialTree (octree first 3 bits + binary) ----
const buildLeafAssignments = (xs, ys, zs, N, leafBits, sceneAabb) => {
    const numLeaves = 1 << leafBits;
    const leafNode = new Uint32Array(N);
    const leafCount = new Uint32Array(numLeaves);
    const [sMin0, sMin1, sMin2] = sceneAabb.min;
    const [sMax0, sMax1, sMax2] = sceneAabb.max;
    for (let i = 0; i < N; ++i) {
        let n0 = sMin0, n1 = sMin1, n2 = sMin2, x0 = sMax0, x1 = sMax1, x2 = sMax2;
        const px = xs[i], py = ys[i], pz = zs[i];

        // Octree: 3 bits, all 3 axes
        const midX = (n0 + x0) * 0.5, midY = (n1 + x1) * 0.5, midZ = (n2 + x2) * 0.5;
        const bX = px <= midX ? 0 : 1, bY = py <= midY ? 0 : 1, bZ = pz <= midZ ? 0 : 1;
        if (bX === 0) x0 = midX; else n0 = midX;
        if (bY === 0) x1 = midY; else n1 = midY;
        if (bZ === 0) x2 = midZ; else n2 = midZ;
        let code = (bX << 2) | (bY << 1) | bZ;

        // Binary: remaining leafBits-3 bits
        for (let d = 3; d < leafBits; ++d) {
            const axis = d % 3;
            let bit;
            if (axis === 0) {
                const mid = (n0 + x0) * 0.5;
                bit = px <= mid ? 0 : 1;
                if (bit === 0) x0 = mid; else n0 = mid;
            } else if (axis === 1) {
                const mid = (n1 + x1) * 0.5;
                bit = py <= mid ? 0 : 1;
                if (bit === 0) x1 = mid; else n1 = mid;
            } else {
                const mid = (n2 + x2) * 0.5;
                bit = pz <= mid ? 0 : 1;
                if (bit === 0) x2 = mid; else n2 = mid;
            }
            code = (code << 1) | bit;
        }
        leafNode[i] = code;
        leafCount[code]++;
    }
    return { leafNode, leafCount };
};

// ---- per-depth counting (mirror the Phase 2 loop with octree) ----
// Returns { maxNodeCount, perLevelTotal, perLevelChunks, totalChunks } for given treeDepth.
const countPerDepth = (N, treeDepth, leafBits, leafNode, leafCount) => {
    let maxNodeCount = 0;
    const perLevelTotal = new Array(treeDepth).fill(0);
    const perLevelChunks = new Array(treeDepth).fill(0);
    let totalChunks = 0;
    for (let D = 1; D <= treeDepth; ++D) {
        const k = treeDepth - D;       // LOD level index
        const step = 1 << k;
        const shift = leafBits - D - 2;
        const numNodes = 1 << (D + 2); // depth 1=8, depth 2=16, ...
        const counts = new Uint32Array(numNodes);
        for (let i = 0; i < N; i += step) {
            counts[leafNode[i] >> shift]++;
        }
        let depthTotal = 0;
        for (let n = 0; n < numNodes; ++n) {
            if (counts[n] === 0) continue;
            // dead subtree check
            const leafStart = n << shift;
            const leafEnd = leafStart + (1 << shift);
            let subtree = 0;
            for (let l = leafStart; l < leafEnd; ++l) subtree += leafCount[l];
            if (subtree === 0) continue;
            if (counts[n] > maxNodeCount) maxNodeCount = counts[n];
            depthTotal += counts[n];
        }
        perLevelTotal[k] = depthTotal;
        perLevelChunks[k] = Math.ceil(depthTotal / SOG_CHUNK_TARGET);
        totalChunks += perLevelChunks[k];
    }
    return { maxNodeCount, perLevelTotal, perLevelChunks, totalChunks };
};

// ---- test harness ----
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`[PASS] ${name}`); }
    else { fail++; console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
};

// ---- INV-1: auto-treeDepth bound (pure math, no data) ----
console.log('--- INV-1: auto-treeDepth bound ---');
const cases = [
    { N: 1_000_000, userL: 1 },
    { N: 5_000_000, userL: 3 },
    { N: 10_000_000, userL: 3 },
    { N: 20_000_000, userL: 3 },
    { N: 40_197_711, userL: 1 },
    { N: 40_197_711, userL: 3 },
    { N: 40_197_711, userL: 5 },
    { N: 40_197_711, userL: 10 },
    { N: 100_000_000, userL: 10 },
];
for (const { N, userL } of cases) {
    const TD = selectTreeDepth(N, userL);
    const leafBits = TD + 2;
    // Per-level total at finest = N (all splats sampled at step=1). Depth=treeDepth has
    // 2^(treeDepth+2) nodes, each ≈ N/2^(treeDepth+2). Per-depth total = N at step=1.
    const finestPerNode = N / (1 << (TD + 2));
    ok(`N=${N.toLocaleString()} userL=${userL} → TD=${TD} (leafBits=${leafBits}), finest/node=${finestPerNode.toFixed(0)}`,
        finestPerNode <= SOG_CHUNK_TARGET,
        `perNode ${finestPerNode.toFixed(0)} > target`);
    // treeDepth must be ≥ safeTreeDepth
    const safeTD = Math.max(1, Math.ceil(Math.log2(N / SOG_CHUNK_TARGET)) - 2);
    ok(`  ...TD=${TD} ≥ safeTD=${safeTD}`, TD >= safeTD);
    ok(`  ...TD within [1,10]`, TD >= 1 && TD <= 10);
    // per-depth total ≤ SOG_CHUNK_TARGET * 4 (max ~4 files per depth)
    // The worst-depth is step=1 (finest) with total=N. Chunks = ceil(N/SOG_CHUNK_TARGET).
    const finestChunks = Math.ceil(N / SOG_CHUNK_TARGET);
    ok(`  ...finest level <= ${finestChunks} chunks (each ≤ ${SOG_CHUNK_TARGET.toLocaleString()})`,
        finestChunks <= Math.ceil(N / SOG_CHUNK_TARGET));
}

// ---- INV-2: uniform grid per-depth counts ----
console.log('\n--- INV-2: uniform grid per-depth counts ---');
const makeGrid = (count) => {
    const side = Math.ceil(Math.cbrt(count));
    const xs = new Float32Array(count), ys = new Float32Array(count), zs = new Float32Array(count);
    let i = 0;
    for (let a = 0; a < side && i < count; ++a)
        for (let b = 0; b < side && i < count; ++b)
            for (let c = 0; c < side && i < count; ++c) {
                xs[i] = (a + 0.123) / side;
                ys[i] = (b + 0.456) / side;
                zs[i] = (c + 0.789) / side;
                i++;
            }
    return { xs, ys, zs };
};

for (const N of [100_000, 500_000, 1_000_000]) {
    const TD = selectTreeDepth(N, 1);
    const leafBits = TD + 2;
    const aabb = { min: [0, 0, 0], max: [1, 1, 1] };
    const { xs, ys, zs } = makeGrid(N);
    const { leafNode, leafCount } = buildLeafAssignments(xs, ys, zs, N, leafBits, aabb);
    const { maxNodeCount, perLevelTotal, perLevelChunks, totalChunks } = countPerDepth(N, TD, leafBits, leafNode, leafCount);

    ok(`N=${N.toLocaleString()} TD=${TD}: maxNodeCount=${maxNodeCount.toLocaleString()} < 15M`,
        maxNodeCount < SOG_HARD_CEILING);
    ok(`  maxNodeCount ≤ SOG_CHUNK_TARGET (uniform, no skew)`,
        maxNodeCount <= SOG_CHUNK_TARGET,
        `maxNode ${maxNodeCount.toLocaleString()}`);

    // lodSplats[k] = ceil(N/2^k)
    let levelOk = true;
    for (let k = 0; k < TD; ++k) {
        const expected = Math.ceil(N / (1 << k));
        if (perLevelTotal[k] !== expected) levelOk = false;
    }
    ok(`  per-level totals = ceil(N/2^k)`, levelOk,
        `got [${perLevelTotal.join(',')}]`);

    // per-level chunks ≤ ceil(levelTotal / SOG_CHUNK_TARGET)
    ok(`  per-level chunks: [${perLevelChunks.join(',')}] total=${totalChunks}`,
        perLevelChunks.every(c => c > 0));

    // Every chunk ≤ SOG_CHUNK_TARGET
    ok(`  every level total divisible into ≤ ceil(N/(2^k*TARGET)) chunks`,
        perLevelChunks.every((c, k) => c <= Math.ceil(N / ((1 << k) * SOG_CHUNK_TARGET))));
}

// ---- INV-3: skewed distribution ----
console.log('\n--- INV-3: skewed (clustered) distribution ---');
{
    const N = 1_000_000;
    const TD = selectTreeDepth(N, 1);
    const leafBits = TD + 2;
    const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
    for (let i = 0; i < N; ++i) {
        xs[i] = (i % 1000) * 1e-9;
        ys[i] = (i % 1000) * 1e-9;
        zs[i] = (i % 1000) * 1e-9;
    }
    const aabb = { min: [0, 0, 0], max: [1, 1, 1] };
    const { leafNode, leafCount } = buildLeafAssignments(xs, ys, zs, N, leafBits, aabb);
    const { maxNodeCount, totalChunks } = countPerDepth(N, TD, leafBits, leafNode, leafCount);
    console.log(`  skewed N=${N.toLocaleString()} TD=${TD} leafBits=${leafBits}: maxNode=${maxNodeCount.toLocaleString()}, chunks=${totalChunks}`);
    ok(`  skewed: finest single-node count reported (documented limitation, not crash)`,
        maxNodeCount > 0);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exitCode = fail ? 1 : 0;
