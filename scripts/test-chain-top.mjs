// Smoke test for chain-top identification (cell-major NanoGS reuse).
// Builds a small adaptive tree, walks chain tops, verifies:
//   1. Every node maps to a chain top.
//   2. Chain continuations share the chain top with their parent.
//   3. Split children are new chain tops.
//   4. chainTopEndDepth is correct (chain extends to treeDepth for small cells,
//      ends early if the cell splits).

// collectNodesAtDepth — copied from src/splat-serialize.ts (tree walk helper).
const collectNodesAtDepth = (root, targetDepth) => {
    const result = [];
    const walk = (node, depth) => {
        if (depth === targetDepth) { result.push(node); return; }
        if (node.child) { for (const c of node.child) walk(c, depth + 1); }
    };
    if (root.child) { for (const c of root.child) walk(c, 1); }
    return result;
};

// Minimal tree builder matching lcc2-export.mjs buildAdaptiveLcc2Tree.
const buildTree = (xs, ys, zs, N, treeDepth, sceneAabb, sogChunkTarget) => {
    const rootIndices = new Uint32Array(N);
    for (let i = 0; i < N; ++i) rootIndices[i] = i;

    const computeTightAabb = (indices) => {
        let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity;
        let mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
        for (let i = 0; i < indices.length; ++i) {
            const idx = indices[i];
            const x = xs[idx], y = ys[idx], z = zs[idx];
            if (x < mn0) mn0 = x; if (x > mx0) mx0 = x;
            if (y < mn1) mn1 = y; if (y > mx1) mx1 = y;
            if (z < mn2) mn2 = z; if (z > mx2) mx2 = z;
        }
        return { min: [mn0, mn1, mn2], max: [mx0, mx1, mx2] };
    };

    const buildChildren = (indices, aabb, depth, splitDepth, maxSplitDepth = 8) => {
        if (depth > treeDepth) return null;
        if (indices.length <= sogChunkTarget || splitDepth >= maxSplitDepth) {
            const child = { aabb, finestIndices: indices, child: null };
            child.child = buildChildren(indices, aabb, depth + 1, splitDepth, maxSplitDepth);
            return [child];
        }
        const [mn0, mn1, mn2] = aabb.min;
        const [mx0, mx1, mx2] = aabb.max;
        const mid0 = (mn0 + mx0) * 0.5, mid1 = (mn1 + mx1) * 0.5, mid2 = (mn2 + mx2) * 0.5;
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
        for (let o = 0; o < 8; ++o) if (bucketCounts[o] > 0) bucketArrays[o] = new Uint32Array(bucketCounts[o]);
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
            const childAabb = computeTightAabb(childIndices);
            const child = { aabb: childAabb, finestIndices: childIndices, child: null };
            child.child = buildChildren(childIndices, childAabb, depth + 1, splitDepth + 1, maxSplitDepth);
            children.push(child);
        }
        if (children.length === 1) {
            const only = children[0];
            only.child = buildChildren(only.finestIndices, only.aabb, depth + 1, maxSplitDepth, maxSplitDepth);
        }
        return children;
    };

    const root = { aabb: sceneAabb, finestIndices: rootIndices, child: null };
    root.child = buildChildren(rootIndices, sceneAabb, 1, 0);
    return root;
};

const walkChainTop = (root, treeDepth) => {
    const nodeToChainTop = new Map();
    const chainTopDepth = new Map();
    const chainTopEndDepth = new Map();
    const walk = (node, parent, parentChainTop, depth) => {
        const isRootChild = parent === root;
        const isChainTop = isRootChild || (node.finestIndices !== parent.finestIndices);
        const chainTop = isChainTop ? node : parentChainTop;
        nodeToChainTop.set(node, chainTop);
        if (isChainTop) {
            chainTopDepth.set(chainTop, depth);
            chainTopEndDepth.set(chainTop, depth);
        } else {
            chainTopEndDepth.set(chainTop, depth);
        }
        if (node.child) for (const c of node.child) walk(c, node, chainTop, depth + 1);
    };
    if (root.child) for (const c of root.child) walk(c, root, null, 1);
    return { nodeToChainTop, chainTopDepth, chainTopEndDepth };
};

// Test 1: small scene (N < sogChunkTarget) — root chains to treeDepth.
{
    const N = 100;
    const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
    for (let i = 0; i < N; ++i) { xs[i] = i; ys[i] = i * 2; zs[i] = i * 3; }
    const treeDepth = 4;
    const aabb = { min: [0, 0, 0], max: [99, 198, 297] };
    const root = buildTree(xs, ys, zs, N, treeDepth, aabb, 1_000_000);
    const { nodeToChainTop, chainTopDepth, chainTopEndDepth } = walkChainTop(root, treeDepth);

    // Root has 1 child (chain, since N < target).
    const rootChild = root.child[0];
    // Chain top = rootChild (root's direct child).
    const ct = nodeToChainTop.get(rootChild);
    if (ct !== rootChild) throw new Error('Test 1 FAIL: root child should be chain top');
    // Chain extends to treeDepth.
    const endD = chainTopEndDepth.get(ct);
    if (endD !== treeDepth) throw new Error(`Test 1 FAIL: chain end ${endD} !== treeDepth ${treeDepth}`);
    // All depths map to the same chain top.
    for (let D = 1; D <= treeDepth; ++D) {
        const nodes = collectNodesAtDepth(root, D);
        for (const n of nodes) {
            if (nodeToChainTop.get(n) !== rootChild) throw new Error(`Test 1 FAIL: depth ${D} node not mapped to root child`);
        }
    }
    console.log('Test 1 PASS: small scene chains to treeDepth');
}

// Test 2: large scene with splits — root splits, children may split again.
{
    const N = 1000;
    const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
    for (let i = 0; i < N; ++i) { xs[i] = (i * 37) % 100; ys[i] = (i * 53) % 100; zs[i] = (i * 71) % 100; }
    const treeDepth = 4;
    const aabb = { min: [0, 0, 0], max: [99, 99, 99] };
    const root = buildTree(xs, ys, zs, N, treeDepth, aabb, 100); // target=100
    const { nodeToChainTop, chainTopDepth, chainTopEndDepth } = walkChainTop(root, treeDepth);

    // Root's children are chain tops (split children with different finestIndices).
    // Children with > target indices SPLIT at depth 2 (chain ends at 1);
    // children with ≤ target indices CHAIN to treeDepth.
    for (const c of root.child) {
        const ct = nodeToChainTop.get(c);
        if (ct !== c) throw new Error('Test 2 FAIL: root split child should be its own chain top');
        if (chainTopDepth.get(c) !== 1) throw new Error('Test 2 FAIL: chain top depth should be 1');
        const endD = chainTopEndDepth.get(c);
        if (c.finestIndices.length > 100) {
            if (endD !== 1) throw new Error(`Test 2 FAIL: child with ${c.finestIndices.length} > 100 should chain-end at 1, got ${endD}`);
        } else {
            if (endD !== treeDepth) throw new Error(`Test 2 FAIL: child with ${c.finestIndices.length} ≤ 100 should chain to treeDepth ${treeDepth}, got ${endD}`);
        }
    }
    console.log('Test 2 PASS: splits produce short chains at depth 1, long chains at depth 2+');
}

// Test 3: chain ends early when cell splits mid-tree.
// Simulate by having a large cell that splits at depth 2.
{
    // N=200, target=100: root splits into ~8 children of ~25 each.
    // Each child (25 ≤ 100) chains to treeDepth.
    // But if we set target=10: root splits into 8 of ~25, each 25 > 10, splits again.
    const N = 200;
    const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
    for (let i = 0; i < N; ++i) { xs[i] = (i * 37) % 50; ys[i] = (i * 53) % 50; zs[i] = (i * 71) % 50; }
    const treeDepth = 4;
    const aabb = { min: [0, 0, 0], max: [49, 49, 49] };
    const root = buildTree(xs, ys, zs, N, treeDepth, aabb, 10);
    const { nodeToChainTop, chainTopDepth, chainTopEndDepth } = walkChainTop(root, treeDepth);

    // Walk all nodes, verify chainTopEndDepth >= chainTopDepth.
    const allNodes = [];
    const collect = (n) => { allNodes.push(n); if (n.child) for (const c of n.child) collect(c); };
    if (root.child) for (const c of root.child) collect(c);

    let chainTops = 0;
    for (const n of allNodes) {
        if (nodeToChainTop.get(n) === n) {
            chainTops++;
            const td = chainTopDepth.get(n);
            const ed = chainTopEndDepth.get(n);
            if (ed < td) throw new Error(`Test 3 FAIL: chain end ${ed} < top ${td}`);
            if (ed > treeDepth) throw new Error(`Test 3 FAIL: chain end ${ed} > treeDepth ${treeDepth}`);
        }
    }
    console.log(`Test 3 PASS: ${chainTops} chain tops, all end depths valid`);
}

console.log('\nAll chain-top tests passed.');
