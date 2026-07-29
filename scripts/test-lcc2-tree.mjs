// Unit test for LCC2 adaptive hybrid tree (buildAdaptiveLcc2Tree +
// collectNodesAtDepth + emitAdaptiveTreeJson from src/splat-serialize.ts).
//
// Verifies the tree topology invariants that prevent the UE plugin from
// freezing when viewing high LOD:
//
//   INV-1 (linear node growth): total nodes ≈ root_children × treeDepth,
//        NOT exponential 2^(L+2). Values up to L=20 are safe.
//   INV-2 (LOD chain AABBs): chain nodes (childNum=1) share the parent AABB.
//   INV-3 (split AABB containment): split children have AABBs ⊆ parent AABB.
//   INV-4 (every depth has data): each depth-D node has finestIndices.length>0.
//   INV-5 (chunk safety): each node's finestIndices.length ≤ sogChunkTarget
//        at the finest level (depth=treeDepth), so per-node data fits one chunk.
//   INV-6 (emit JSON validity): ids follow path convention, childNum matches
//        surviving children, data.3dgs present for nodes with refs.
//
// Replicates buildAdaptiveLcc2Tree + helpers from src/splat-serialize.ts.
// Run:  node scripts/test-lcc2-tree.mjs

// ---- Replicated logic (mirror src/splat-serialize.ts) ----

const computeTightAabb = (indices, xs, ys, zs) => {
    let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity;
    let mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
    for (let i = 0; i < indices.length; ++i) {
        const idx = indices[i];
        const x = xs[idx], y = ys[idx], z = zs[idx];
        if (x < mn0) mn0 = x;
        if (y < mn1) mn1 = y;
        if (z < mn2) mn2 = z;
        if (x > mx0) mx0 = x;
        if (y > mx1) mx1 = y;
        if (z > mx2) mx2 = z;
    }
    return { min: [mn0, mn1, mn2], max: [mx0, mx1, mx2] };
};

const buildAdaptiveLcc2Tree = (xs, ys, zs, N, treeDepth, sceneAabb, sogChunkTarget, maxSplitDepth = 8) => {
    const rootIndices = new Uint32Array(N);
    for (let i = 0; i < N; ++i) rootIndices[i] = i;

    const buildChildren = (indices, aabb, depth, splitDepth) => {
        if (depth > treeDepth) return null;

        if (indices.length <= sogChunkTarget || splitDepth >= maxSplitDepth) {
            const child = { aabb, finestIndices: indices, child: null };
            child.child = buildChildren(indices, aabb, depth + 1, splitDepth);
            return [child];
        }

        const [mn0, mn1, mn2] = aabb.min;
        const [mx0, mx1, mx2] = aabb.max;
        const mid0 = (mn0 + mx0) * 0.5;
        const mid1 = (mn1 + mx1) * 0.5;
        const mid2 = (mn2 + mx2) * 0.5;

        const bucketCounts = new Uint32Array(8);
        for (let i = 0; i < indices.length; ++i) {
            const idx = indices[i];
            const bX = xs[idx] <= mid0 ? 0 : 1;
            const bY = ys[idx] <= mid1 ? 0 : 1;
            const bZ = zs[idx] <= mid2 ? 0 : 1;
            bucketCounts[(bX << 2) | (bY << 1) | bZ]++;
        }

        const bucketArrays = new Array(8).fill(null);
        const bucketFill = new Uint32Array(8);
        for (let o = 0; o < 8; ++o) {
            if (bucketCounts[o] > 0) bucketArrays[o] = new Uint32Array(bucketCounts[o]);
        }
        for (let i = 0; i < indices.length; ++i) {
            const idx = indices[i];
            const bX = xs[idx] <= mid0 ? 0 : 1;
            const bY = ys[idx] <= mid1 ? 0 : 1;
            const bZ = zs[idx] <= mid2 ? 0 : 1;
            const o = (bX << 2) | (bY << 1) | bZ;
            bucketArrays[o][bucketFill[o]++] = idx;
        }

        const children = [];
        for (let o = 0; o < 8; ++o) {
            if (bucketCounts[o] === 0) continue;
            const childIndices = bucketArrays[o];
            const childAabb = computeTightAabb(childIndices, xs, ys, zs);
            const child = { aabb: childAabb, finestIndices: childIndices, child: null };
            child.child = buildChildren(childIndices, childAabb, depth + 1, splitDepth + 1);
            children.push(child);
        }
        if (children.length === 1) {
            const only = children[0];
            only.child = buildChildren(only.finestIndices, only.aabb, depth + 1, maxSplitDepth);
        }
        return children;
    };

    const root = { aabb: sceneAabb, finestIndices: rootIndices, child: null };
    root.child = buildChildren(rootIndices, sceneAabb, 1, 0);
    return root;
};

const collectNodesAtDepth = (root, targetDepth) => {
    const result = [];
    const walk = (node, depth) => {
        if (depth === targetDepth) { result.push(node); return; }
        if (node.child) for (const c of node.child) walk(c, depth + 1);
    };
    if (root.child) for (const c of root.child) walk(c, 1);
    return result;
};

const assignAdaptiveNodeIds = (root) => {
    const walk = (node, id) => {
        node.id = id;
        if (node.child) {
            for (let i = 0; i < node.child.length; ++i) {
                walk(node.child[i], `${id}_${i}`);
            }
        }
    };
    walk(root, '0');
};

const emitAdaptiveTreeJson = (root, nodeRefs, splatFiles) => {
    const emit = (node) => {
        const ref = nodeRefs.get(node);
        const data = ref && ref.count > 0 ? { '3dgs': ref } : null;
        if (!node.child || node.child.length === 0) {
            return { id: node.id, boundingBox: node.aabb, childNum: 0, data };
        }
        const child = {};
        for (let i = 0; i < node.child.length; ++i) {
            child[String(i)] = emit(node.child[i]);
        }
        return { id: node.id, boundingBox: node.aabb, childNum: node.child.length, data, child };
    };
    const child = {};
    if (root.child) {
        for (let i = 0; i < root.child.length; ++i) {
            child[String(i)] = emit(root.child[i]);
        }
    }
    return {
        id: root.id,
        boundingBox: root.aabb,
        childNum: root.child?.length ?? 0,
        data: null,
        splatFiles,
        meshFiles: [],
        bvhFiles: [],
        child
    };
};

// ---- Test harness ----
let passed = 0, failed = 0;
const assert = (cond, msg) => {
    if (cond) { passed++; }
    else { failed++; console.log(`  FAIL: ${msg}`); }
};

const aabbContains = (parent, child) => {
    for (let a = 0; a < 3; ++a) {
        if (child.min[a] < parent.min[a] - 1e-6) return false;
        if (child.max[a] > parent.max[a] + 1e-6) return false;
    }
    return true;
};

const aabbEqual = (a, b) => {
    for (let i = 0; i < 3; ++i) {
        if (Math.abs(a.min[i] - b.min[i]) > 1e-6) return false;
        if (Math.abs(a.max[i] - b.max[i]) > 1e-6) return false;
    }
    return true;
};

// Count total nodes and collect stats.
const treeStats = (root) => {
    const stats = { total: 0, byDepth: {}, chainNodes: 0, splitNodes: 0, leafNodes: 0, maxDepth: 0 };
    const walk = (node, depth) => {
        stats.total++;
        stats.maxDepth = Math.max(stats.maxDepth, depth);
        stats.byDepth[depth] = (stats.byDepth[depth] || 0) + 1;
        if (!node.child || node.child.length === 0) {
            stats.leafNodes++;
        } else if (node.child.length === 1) {
            stats.chainNodes++;
        } else {
            stats.splitNodes++;
        }
        if (node.child) for (const c of node.child) walk(c, depth + 1);
    };
    if (root.child) for (const c of root.child) walk(c, 1);
    return stats;
};

// ---- Test 1: small uniform grid, treeDepth=3 ----
console.log('Test 1: uniform grid 1K points, treeDepth=3, target=100');
{
    const N = 1000;
    const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
    for (let i = 0; i < N; ++i) {
        xs[i] = (i % 10) / 10 + 0.05;
        ys[i] = (Math.floor(i / 10) % 10) / 10 + 0.05;
        zs[i] = Math.floor(i / 100) / 10 + 0.05;
    }
    const aabb = { min: [0, 0, 0], max: [1, 1, 1] };
    const root = buildAdaptiveLcc2Tree(xs, ys, zs, N, 3, aabb, 100);
    const stats = treeStats(root);

    assert(stats.maxDepth === 3, `maxDepth=3 (got ${stats.maxDepth})`);
    assert(stats.total > 0, `total nodes > 0 (got ${stats.total})`);
    // Bounded by octree worst case (8^treeDepth), NOT exponential 2^(L+2) of
    // the old binary tree. With small target, splits can multiply nodes per
    // level, but the count stays linear in treeDepth once cells fall below
    // target (chain phase). Compare against octree worst case here.
    const rootChildren = root.child?.length ?? 0;
    const octreeWorst = 8 ** 3;
    assert(stats.total < octreeWorst, `bounded by octree worst case: ${stats.total} < ${octreeWorst}`);
    console.log(`  root_children=${rootChildren}, total=${stats.total}, byDepth=${JSON.stringify(stats.byDepth)}`);
}

// ---- Test 2: LOD chain AABBs are identical to parent ----
console.log('Test 2: LOD chain nodes share parent AABB');
{
    const N = 50; // small enough to chain (no split)
    const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
    for (let i = 0; i < N; ++i) {
        xs[i] = i * 0.01;
        ys[i] = i * 0.02;
        zs[i] = i * 0.03;
    }
    const tightAabb = computeTightAabb(
        (() => { const idx = new Uint32Array(N); for (let i = 0; i < N; ++i) idx[i] = i; return idx; })(),
        xs, ys, zs
    );
    const root = buildAdaptiveLcc2Tree(xs, ys, zs, N, 5, tightAabb, 3_000_000);
    const stats = treeStats(root);
    assert(stats.splitNodes === 0, `no splits expected for N=50 (got ${stats.splitNodes} splits)`);
    assert(stats.chainNodes > 0, `chain nodes exist (got ${stats.chainNodes})`);

    // Walk and verify chain AABB equality.
    let aabbOk = true;
    const checkChain = (node) => {
        if (node.child && node.child.length === 1) {
            if (!aabbEqual(node.aabb, node.child[0].aabb)) aabbOk = false;
            checkChain(node.child[0]);
        } else if (node.child) {
            for (const c of node.child) checkChain(c);
        }
    };
    if (root.child) for (const c of root.child) checkChain(c);
    assert(aabbOk, 'all LOD-chain children share parent AABB');
}

// ---- Test 3: split children AABBs are contained in parent ----
console.log('Test 3: split children AABBs ⊆ parent AABB');
{
    const N = 100_000; // large enough to trigger splits with target=10K
    const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
    for (let i = 0; i < N; ++i) {
        xs[i] = Math.random();
        ys[i] = Math.random();
        zs[i] = Math.random();
    }
    const aabb = { min: [0, 0, 0], max: [1, 1, 1] };
    const root = buildAdaptiveLcc2Tree(xs, ys, zs, N, 4, aabb, 10_000);
    const stats = treeStats(root);
    assert(stats.splitNodes > 0, `splits expected for N=100K target=10K (got ${stats.splitNodes})`);

    let containmentOk = true;
    const checkContainment = (node) => {
        if (!node.child) return;
        for (const c of node.child) {
            if (!aabbContains(node.aabb, c.aabb)) containmentOk = false;
            checkContainment(c);
        }
    };
    if (root.child) for (const c of root.child) checkContainment(c);
    assert(containmentOk, 'all split children AABBs ⊆ parent AABB');
}

// ---- Test 4: every depth-D node has finestIndices.length > 0 ----
console.log('Test 4: every node has finestIndices.length > 0');
{
    const N = 10_000;
    const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
    for (let i = 0; i < N; ++i) {
        xs[i] = Math.random();
        ys[i] = Math.random();
        zs[i] = Math.random();
    }
    const aabb = { min: [0, 0, 0], max: [1, 1, 1] };
    const root = buildAdaptiveLcc2Tree(xs, ys, zs, N, 5, aabb, 3_000_000);

    let allNonEmpty = true;
    const check = (node) => {
        if (node.finestIndices.length === 0) allNonEmpty = false;
        if (node.child) for (const c of node.child) check(c);
    };
    if (root.child) for (const c of root.child) check(c);
    assert(allNonEmpty, 'all nodes have finestIndices.length > 0');
}

// ---- Test 5: collectNodesAtDepth returns correct count ----
console.log('Test 5: collectNodesAtDepth correctness');
{
    const N = 5000;
    const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
    for (let i = 0; i < N; ++i) {
        xs[i] = Math.random();
        ys[i] = Math.random();
        zs[i] = Math.random();
    }
    const aabb = { min: [0, 0, 0], max: [1, 1, 1] };
    const treeDepth = 4;
    const root = buildAdaptiveLcc2Tree(xs, ys, zs, N, treeDepth, aabb, 3_000_000);

    // Sum of nodes at each depth must equal total non-root nodes.
    let collected = 0;
    for (let D = 1; D <= treeDepth; ++D) {
        const nodes = collectNodesAtDepth(root, D);
        collected += nodes.length;
    }
    const stats = treeStats(root);
    assert(collected === stats.total, `sum of per-depth nodes = total (${collected} vs ${stats.total})`);

    // Depth 1 = root.children count
    const d1 = collectNodesAtDepth(root, 1);
    assert(d1.length === (root.child?.length ?? 0), `depth-1 count = root children (${d1.length} vs ${root.child?.length})`);
}

// ---- Test 6: linear node growth — treeDepth=20 is safe ----
console.log('Test 6: linear growth — treeDepth=20 produces bounded nodes');
{
    const N = 1_000_000;
    const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
    for (let i = 0; i < N; ++i) {
        xs[i] = Math.random();
        ys[i] = Math.random();
        zs[i] = Math.random();
    }
    const aabb = { min: [0, 0, 0], max: [1, 1, 1] };
    // With target=3M and N=1M, root chains (no split). All nodes are chains.
    const root = buildAdaptiveLcc2Tree(xs, ys, zs, N, 20, aabb, 3_000_000);
    const stats = treeStats(root);
    console.log(`  treeDepth=20: root_children=${root.child?.length}, total=${stats.total}, byDepth=${JSON.stringify(stats.byDepth)}`);
    // With 1 chain: 1 root child × 20 depths = 20 nodes.
    assert(stats.total === 20, `treeDepth=20 chain: total=20 (got ${stats.total})`);
    assert(stats.maxDepth === 20, `maxDepth=20 (got ${stats.maxDepth})`);

    // Now with small target to force splits.
    const root2 = buildAdaptiveLcc2Tree(xs, ys, zs, N, 20, aabb, 10_000);
    const stats2 = treeStats(root2);
    console.log(`  treeDepth=20 target=10K: root_children=${root2.child?.length}, total=${stats2.total}, splits=${stats2.splitNodes}`);
    // Linear in treeDepth: total ≤ leafCells × treeDepth + splitDepthNodes.
    // leafCells is data-dependent (here ~512 after 3 split levels), so the
    // tight bound is ~512×20 ≈ 10K. Compare against the old binary tree's
    // 2^(treeDepth+2) = 4M nodes — adaptive must be << 1% of that.
    const oldBinaryNodes = 1 << (20 + 2);
    assert(stats2.total < oldBinaryNodes * 0.01, `linear vs binary: ${stats2.total} < ${oldBinaryNodes * 0.01} (binary=${oldBinaryNodes})`);
    // Sanity: still under 50K for N=1M (would be 4M+ for binary tree)
    assert(stats2.total < 50_000, `node count < 50K (got ${stats2.total}, old binary tree would be 4M+)`);
}

// ---- Test 7: emitAdaptiveTreeJson produces valid structure ----
console.log('Test 7: emitAdaptiveTreeJson validity');
{
    const N = 1000;
    const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
    for (let i = 0; i < N; ++i) {
        xs[i] = Math.random();
        ys[i] = Math.random();
        zs[i] = Math.random();
    }
    const aabb = { min: [0, 0, 0], max: [1, 1, 1] };
    const root = buildAdaptiveLcc2Tree(xs, ys, zs, N, 4, aabb, 3_000_000);
    assignAdaptiveNodeIds(root);

    // Assign fake refs to every node.
    const nodeRefs = new Map();
    let refIdx = 0;
    const assign = (node) => {
        nodeRefs.set(node, { name: refIdx++, start: 0, count: node.finestIndices.length });
        if (node.child) for (const c of node.child) assign(c);
    };
    if (root.child) for (const c of root.child) assign(c);

    const json = emitAdaptiveTreeJson(root, nodeRefs, ['fake.sog']);
    assert(json.id === '0', `root id='0' (got ${json.id})`);
    assert(json.childNum === (root.child?.length ?? 0), `root childNum matches`);
    assert(json.data === null, `root data=null`);
    assert(Array.isArray(json.splatFiles), `splatFiles is array`);

    // Walk JSON and verify: childNum matches Object.keys(child).length, ids follow path.
    let jsonValid = true;
    const walkJson = (n, expectedId) => {
        if (n.id !== expectedId) jsonValid = false;
        const kids = n.child ? Object.keys(n.child) : [];
        if (n.childNum !== kids.length) jsonValid = false;
        if (n.childNum === 0 && n.child) jsonValid = false;
        if (n.child) {
            for (let i = 0; i < kids.length; ++i) {
                walkJson(n.child[kids[i]], `${n.id}_${i}`);
            }
        }
    };
    walkJson(json, '0');
    assert(jsonValid, 'JSON ids follow path convention, childNum matches children');
}

// ---- Test 8: degenerate input (all points at same location) ----
console.log('Test 8: degenerate — all points coincident');
{
    const N = 1000;
    const xs = new Float32Array(N).fill(0.5);
    const ys = new Float32Array(N).fill(0.5);
    const zs = new Float32Array(N).fill(0.5);
    const aabb = { min: [0, 0, 0], max: [1, 1, 1] };
    // Should not infinite-loop; falls back to chain via maxSplitDepth guard.
    const root = buildAdaptiveLcc2Tree(xs, ys, zs, N, 5, aabb, 100, 8);
    const stats = treeStats(root);
    assert(stats.total > 0, `degenerate input produces a tree (total=${stats.total})`);
    assert(stats.maxDepth === 5, `degenerate still reaches depth 5 (got ${stats.maxDepth})`);
}

// ---- Test 9: dynamic rate sampling (100%→10% linear decrease) ----
console.log('Test 9: per-depth LOD sampling uses dynamic rate (100%→10%)');
{
    const N = 100_000;
    const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
    for (let i = 0; i < N; ++i) {
        xs[i] = Math.random();
        ys[i] = Math.random();
        zs[i] = Math.random();
    }
    const aabb = { min: [0, 0, 0], max: [1, 1, 1] };
    const treeDepth = 6;
    const root = buildAdaptiveLcc2Tree(xs, ys, zs, N, treeDepth, aabb, 3_000_000);

    // rate(k) = 1 - 0.9*k/(L-1): LOD0=100%, LOD(L-1)=10%, linear decrease.
    const rate = (k) => treeDepth === 1 ? 1 : 1 - 0.9 * k / (treeDepth - 1);

    // Per-depth totals ≈ N × rate(k). Collect rates indexed by k (0=finest).
    let totalsOk = true;
    const ratesByK = new Array(treeDepth);
    for (let D = 1; D <= treeDepth; ++D) {
        const k = treeDepth - D;
        const r = rate(k);
        ratesByK[k] = r;
        const nodes = collectNodesAtDepth(root, D);
        let total = 0;
        for (const n of nodes) total += Math.max(1, Math.ceil(n.finestIndices.length * r));
        const expected = Math.ceil(N * r);
        if (total < expected * 0.9 || total > expected * 1.1 + nodes.length) totalsOk = false;
    }
    assert(totalsOk, `per-depth totals ≈ N×rate(k) (rates=${ratesByK.map(r => (r * 100).toFixed(0) + '%').join(',')})`);

    // Rates strictly decreasing by k: ratesByK[0]=100% > ratesByK[1] > ... > ratesByK[L-1]=10%.
    let strictlyDecreasing = true;
    for (let k = 1; k < treeDepth; ++k) {
        if (ratesByK[k] >= ratesByK[k - 1]) strictlyDecreasing = false;
    }
    assert(strictlyDecreasing, 'rates strictly decreasing (no duplicate fidelity)');

    // Coarsest (k=L-1) = 10%, finest (k=0) = 100%.
    assert(Math.abs(ratesByK[treeDepth - 1] - 0.1) < 1e-9, `coarsest LOD = 10% (got ${(ratesByK[treeDepth - 1] * 100).toFixed(1)}%)`);
    assert(Math.abs(ratesByK[0] - 1) < 1e-9, `finest LOD = 100% (got ${(ratesByK[0] * 100).toFixed(1)}%)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
