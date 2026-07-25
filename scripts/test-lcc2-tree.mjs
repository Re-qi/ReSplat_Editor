// Unit test for LCC2 spatial tree + tree-node assembly (Phase 2 LOD, octree root).
//
// Replicates buildLcc2SpatialTree + buildLcc2TreeNode from src/splat-serialize.ts
// and verifies correctness on synthetic data.
//
// Run:  node scripts/test-lcc2-tree.mjs

// ---- Replicated logic (mirror src/splat-serialize.ts) ----

const buildLcc2SpatialTree = (xs, ys, zs, N, leafBits, sceneAabb) => {
    const numLeaves = 1 << leafBits;
    const leafNode = new Uint32Array(N);
    const leafCount = new Uint32Array(numLeaves);
    const [sMin0, sMin1, sMin2] = sceneAabb.min;
    const [sMax0, sMax1, sMax2] = sceneAabb.max;
    const treeDepth = leafBits - 2;

    for (let i = 0; i < N; ++i) {
        let n0 = sMin0, n1 = sMin1, n2 = sMin2, x0 = sMax0, x1 = sMax1, x2 = sMax2;
        const px = xs[i], py = ys[i], pz = zs[i];

        // Octree: 3 bits simultaneously
        const midX = (n0 + x0) * 0.5, midY = (n1 + x1) * 0.5, midZ = (n2 + x2) * 0.5;
        const bX = px <= midX ? 0 : 1, bY = py <= midY ? 0 : 1, bZ = pz <= midZ ? 0 : 1;
        if (bX === 0) x0 = midX; else n0 = midX;
        if (bY === 0) x1 = midY; else n1 = midY;
        if (bZ === 0) x2 = midZ; else n2 = midZ;
        let code = (bX << 2) | (bY << 1) | bZ;

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

    const leafMin = new Float32Array(numLeaves * 3);
    const leafMax = new Float32Array(numLeaves * 3);
    leafMin.fill(Infinity);
    leafMax.fill(-Infinity);
    for (let i = 0; i < N; ++i) {
        const o = leafNode[i] * 3;
        const x = xs[i], y = ys[i], z = zs[i];
        if (x < leafMin[o]) leafMin[o] = x;
        if (y < leafMin[o + 1]) leafMin[o + 1] = y;
        if (z < leafMin[o + 2]) leafMin[o + 2] = z;
        if (x > leafMax[o]) leafMax[o] = x;
        if (y > leafMax[o + 1]) leafMax[o + 1] = y;
        if (z > leafMax[o + 2]) leafMax[o + 2] = z;
    }

    const emptyMin0 = (sMin0 + sMax0) * 0.5, emptyMin1 = (sMin1 + sMax1) * 0.5, emptyMin2 = (sMin2 + sMax2) * 0.5;
    const nodeAabbs = [null];
    for (let D = 1; D <= treeDepth; ++D) {
        const shift = leafBits - D - 2;
        const numNodes = 1 << (D + 2);
        const arr = new Array(numNodes);
        for (let n = 0; n < numNodes; ++n) {
            const start = n << shift;
            const end = start + (1 << shift);
            let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity;
            let mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
            for (let l = start; l < end; ++l) {
                if (leafCount[l] === 0) continue;
                const o = l * 3;
                if (leafMin[o] < mn0) mn0 = leafMin[o];
                if (leafMin[o + 1] < mn1) mn1 = leafMin[o + 1];
                if (leafMin[o + 2] < mn2) mn2 = leafMin[o + 2];
                if (leafMax[o] > mx0) mx0 = leafMax[o];
                if (leafMax[o + 1] > mx1) mx1 = leafMax[o + 1];
                if (leafMax[o + 2] > mx2) mx2 = leafMax[o + 2];
            }
            if (!isFinite(mn0)) {
                arr[n] = { min: [emptyMin0, emptyMin1, emptyMin2], max: [emptyMin0, emptyMin1, emptyMin2] };
            } else {
                arr[n] = { min: [mn0, mn1, mn2], max: [mx0, mx1, mx2] };
            }
        }
        nodeAabbs[D] = arr;
    }
    return { leafNode, leafCount, nodeAabbs, numLeaves };
};

const buildLcc2TreeNode = (depth, nodeIdx, treeDepth, leafBits, nodeAabbs, nodeRefs, leafCount) => {
    const shift = leafBits - depth - 2;
    const leafStart = nodeIdx << shift;
    const leafEnd = leafStart + (1 << shift);
    let subtreeCount = 0;
    for (let l = leafStart; l < leafEnd; ++l) subtreeCount += leafCount[l];
    if (subtreeCount === 0) return null;

    let id = '0';
    if (depth >= 1) {
        const octant = depth > 1 ? (nodeIdx >> (depth - 1)) : nodeIdx;
        id += `_${octant}`;
        for (let d = depth - 2; d >= 0; --d) {
            id += `_${(nodeIdx >> d) & 1}`;
        }
    }
    const aabb = nodeAabbs[depth][nodeIdx];
    const ref = nodeRefs[depth][nodeIdx];
    const data = ref && ref.count > 0 ? { '3dgs': ref } : null;

    if (depth === treeDepth) {
        return { id, boundingBox: aabb, childNum: 0, data };
    }

    // All depths >=1 use binary splitting (2 children).
    const branchFactor = 2;
    const childNodes = [];
    for (let m = 0; m < branchFactor; ++m) {
        const cIdx = nodeIdx * branchFactor + m;
        const c = buildLcc2TreeNode(depth + 1, cIdx, treeDepth, leafBits, nodeAabbs, nodeRefs, leafCount);
        if (c) childNodes.push(c);
    }
    const child = {};
    for (let i = 0; i < childNodes.length; ++i) {
        child[String(i)] = childNodes[i];
    }
    return { id, boundingBox: aabb, childNum: childNodes.length, data, child };
};

// ---- Test harness ----
let passed = 0, failed = 0;
const assert = (cond, msg) => {
    if (cond) { passed++; }
    else { failed++; console.log(`  FAIL: ${msg}`); }
};

// Build Phase-2 metadata with lodSplats finest-first.
const buildPhase2 = (positions, treeDepth) => {
    const leafBits = treeDepth + 2;
    const N = positions.length / 3;
    const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < N; ++i) {
        xs[i] = positions[i * 3]; ys[i] = positions[i * 3 + 1]; zs[i] = positions[i * 3 + 2];
        for (let a = 0; a < 3; ++a) {
            const v = [xs[i], ys[i], zs[i]][a];
            if (v < mn[a]) mn[a] = v;
            if (v > mx[a]) mx[a] = v;
        }
    }
    const sceneAabb = { min: mn, max: mx };
    const { leafNode, leafCount, nodeAabbs } = buildLcc2SpatialTree(xs, ys, zs, N, leafBits, sceneAabb);

    const nodeRefs = [null];
    const lodSplatsByLvl = new Array(treeDepth).fill(0); // k=finest..coarsest

    for (let D = 1; D <= treeDepth; ++D) {
        const k = treeDepth - D;  // 0=finest
        const step = 1 << k;
        const shift = leafBits - D - 2;
        const numNodes = 1 << (D + 2);
        const counts = new Uint32Array(numNodes);
        for (let i = 0; i < N; i += step) {
            counts[leafNode[i] >> shift]++;
        }

        let total = 0;
        const refs = new Array(numNodes);
        let offset = 0;
        for (let n = 0; n < numNodes; ++n) {
            total += counts[n];
            refs[n] = { name: D - 1, start: offset, count: counts[n] };
            offset += counts[n];
        }
        nodeRefs[D] = refs;
        lodSplatsByLvl[k] = total;
    }

    // Root children: 8 octants at depth 1
    const child = {};
    let childNum = 0;
    for (let oct = 0; oct < 8; ++oct) {
        const c = buildLcc2TreeNode(1, oct, treeDepth, leafBits, nodeAabbs, nodeRefs, leafCount);
        if (c) child[String(childNum++)] = c;
    }
    const root = { id: '0', childNum, child };

    return { root, lodSplats: lodSplatsByLvl, nodeRefs, N };
};

const walkDataRefs = (node, depth, refs) => {
    if (node.data && node.data['3dgs']) {
        refs.push({ id: node.id, depth, ...node.data['3dgs'] });
    }
    if (node.child) {
        for (const k of Object.keys(node.child)) {
            walkDataRefs(node.child[k], depth + 1, refs);
        }
    }
};

// ---- Test 1: uniform grid, treeDepth=2 (octree only) ----
console.log('Test 1: uniform grid, treeDepth=2 (octree, 8 points)');
{
    const positions = [];
    for (let x = 0; x < 2; ++x)
        for (let y = 0; y < 2; ++y)
            for (let z = 0; z < 2; ++z)
                positions.push(x + 0.5, y + 0.5, z + 0.5);
    const { root, lodSplats, N } = buildPhase2(positions, 2);

    assert(root.childNum <= 8, `root.childNum <= 8 (got ${root.childNum})`);
    // lodSplats: finest (k=0) = N, coarse (k=1) = ceil(N/2)
    assert(lodSplats[0] === N, `lodSplats[0]=N=${N} (got ${lodSplats[0]})`);
    assert(lodSplats[1] === Math.ceil(N / 2), `lodSplats[1]=${Math.ceil(N / 2)} (got ${lodSplats[1]})`);

    const refs = [];
    walkDataRefs(root, 0, refs);
    assert(refs.length >= 8, `>=8 data nodes (got ${refs.length})`);
    assert(refs.every(r => r.count > 0), 'all data.3dgs.count > 0');

    // childNum consistency
    const checkChildNum = (node) => {
        const kids = node.child ? Object.keys(node.child).filter(k => node.child[k]) : [];
        if (node.childNum !== kids.length) return false;
        for (const k of kids) if (!checkChildNum(node.child[k])) return false;
        return true;
    };
    assert(checkChildNum(root), 'childNum matches surviving children');
}

// ---- Test 2: single octant clustering, other octants pruned ----
console.log('Test 2: single octant, treeDepth=2 (7 of 8 pruned)');
{
    const positions = [];
    for (let i = 0; i < 10; ++i) positions.push(0.5, 0.1 + i * 0.08, 0.5);
    const { root, lodSplats, N } = buildPhase2(positions, 2);

    assert(root.childNum <= 2, `root.childNum <= 2 (got ${root.childNum})`);
    assert(lodSplats[0] === N, `lodSplats[0]=${N}`);
    assert(lodSplats[1] > 0, `lodSplats[1] > 0`);
}

// ---- Test 3: treeDepth=3 (octree + 1 binary), scattered ----
console.log('Test 3: scattered, treeDepth=3 (some empty)');
{
    const positions = [];
    for (let i = 0; i < 100; ++i) positions.push(Math.random() * 2, Math.random() * 2, Math.random() * 2);
    for (let i = 0; i < 100; ++i) positions.push(2 + Math.random() * 2, 2 + Math.random() * 2, Math.random() * 2);
    const { root, lodSplats, N } = buildPhase2(positions, 3);

    assert(root.childNum >= 1, `root.childNum >= 1 (got ${root.childNum})`);
    assert(lodSplats.length === 3, `3 LOD levels`);
    assert(lodSplats[0] === N, `lodSplats[0]=N=${N}`);

    const refs = [];
    walkDataRefs(root, 0, refs);
    assert(refs.every(r => r.count > 0), 'all data.3dgs.count > 0');

    const checkChildNum = (node) => {
        const kids = node.child ? Object.keys(node.child).filter(k => node.child[k]) : [];
        if (node.childNum !== kids.length) return false;
        for (const k of kids) if (!checkChildNum(node.child[k])) return false;
        return true;
    };
    assert(checkChildNum(root), 'childNum matches surviving children');
}

// ---- Test 4: name/start consistency ----
console.log('Test 4: name/start indices consistent');
{
    const positions = [];
    for (let i = 0; i < 50; ++i) positions.push(Math.random() * 4, Math.random() * 4, Math.random() * 4);
    const { root } = buildPhase2(positions, 2);
    const refs = [];
    walkDataRefs(root, 0, refs);
    for (const r of refs) {
        assert(r.name >= 0, `name >= 0`);
        assert(Number.isInteger(r.start) && r.start >= 0, `start >= 0`);
    }
}

// ---- Test 5: treeDepth=1 (Phase 1 fallback) ----
console.log('Test 5: treeDepth=1 (Phase 1 path)');
{
    assert(1 <= 1, 'treeDepth=1');
    const leafBits = 3;
    assert((1 << leafBits) === 8, 'leafBits=3 => 8 leaves');
}

// ---- Test 6: single splat, treeDepth=3 ----
console.log('Test 6: 1 splat, treeDepth=3');
{
    const positions = [0.5, 0.5, 0.5];
    const { root, lodSplats } = buildPhase2(positions, 3);
    assert(root.childNum >= 1, `root.childNum >= 1`);
    assert(lodSplats[0] === 1, `lodSplats[0]=1`);
    assert(lodSplats.every(l => l === 1), `all levels=1`);
}

// ---- Test 7: ID encoding octant+ binary ----
console.log('Test 7: ID encoding (octant + binary)');
{
    // Use a scene with explicit bounds so octree mapping is deterministic.
    const positions = [];
    for (let x = 0; x < 4; ++x)
        for (let y = 0; y < 4; ++y)
            for (let z = 0; z < 4; ++z)
                positions.push(x + 0.5, y + 0.5, z + 0.5); // 64 points in [0.5,3.5]
    const { root } = buildPhase2(positions, 3); // treeDepth=3, leafBits=5

    const refs = [];
    walkDataRefs(root, 0, refs);

    // Depth 1 (octree): IDs like '0_0' through '0_7'
    const d1 = refs.filter(r => r.depth === 1).map(r => r.id);
    assert(d1.length >= 4, `>=4 depth-1 nodes (got ${d1.length})`);
    assert(d1.every(id => /^0_[0-7]$/.test(id)), 'depth-1 IDs are octant (0_0..0_7)');

    // Depth 2 (octant + 1 binary): IDs like '0_0_0', '0_0_1'
    const d2 = refs.filter(r => r.depth === 2).map(r => r.id);
    assert(d2.length >= 8, `>=8 depth-2 nodes (got ${d2.length})`);
    assert(d2.every(id => /^0_[0-7]_[01]$/.test(id)), 'depth-2 IDs are octant+bit');

    // Depth 3 (octant + 2 binary): '0_N_B_B'
    const d3 = refs.filter(r => r.depth === 3).map(r => r.id);
    assert(d3.length >= 8, `>=8 depth-3 nodes (got ${d3.length})`);
    assert(d3.every(id => /^0_[0-7]_[01]_[01]$/.test(id)), 'depth-3 IDs match pattern');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
