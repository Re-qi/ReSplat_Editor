// Ported from NanoGS (https://github.com/RongLiu-Leo/NanoGS) — CC BY-NC 4.0.
// Original: replaces scipy.spatial.cKDTree usage in src/nanogs/simplification.py
// (knn_indices). The KNN semantics mirror `cKDTree.query(means, k=k+1)[:, 1:]`.
// See src/nanogs/README.md for attribution and license. This file is NOT
// released under the project CC BY 4.0 license; it remains under CC BY-NC 4.0
// (NonCommercial). Commercial use requires a separate license from NanoGS authors.

interface KdTree {
    idxArr: Int32Array;   // point index stored at each node
    axisArr: Int8Array;   // split axis (0/1/2) at each node
    leftArr: Int32Array;  // left child node id (-1 if none)
    rightArr: Int32Array; // right child node id (-1 if none)
    count: number;        // number of nodes
}

/**
 * 3D KD-tree k-NN. For each point in `means` (N*3), returns the k nearest
 * neighbor indices EXCLUDING the point itself — matching the reference
 * `cKDTree.query(means, k=k+1)[:, 1:]`. Caller must guarantee k <= N-1.
 *
 * Uses a child-array KD-tree (no per-node object allocation) built with
 * quickselect median partitioning, and an iterative k-NN query with a
 * bounded max-heap + plane-distance pruning.
 */
export function knnIndices(means: Float32Array, N: number, k: number): Int32Array {
    if (N <= 0) return new Int32Array(0);
    const kk = Math.min(k + 1, N); // query kk nearest, drop self → k

    const tree = buildKdTree(means, N);
    const out = new Int32Array(N * k);

    for (let q = 0; q < N; ++q) {
        const qx = means[q * 3];
        const qy = means[q * 3 + 1];
        const qz = means[q * 3 + 2];
        const neighbors = knnQuery(means, tree, qx, qy, qz, kk);

        let written = 0;
        for (let i = 0; i < neighbors.length && written < k; ++i) {
            if (neighbors[i] !== q) {
                out[q * k + written] = neighbors[i];
                ++written;
            }
        }
        // Degenerate fallback (only if duplicates of self exhausted results).
        while (written < k) {
            out[q * k + written] = q;
            ++written;
        }
    }
    return out;
}

/** Build a child-array KD-tree from N points. */
function buildKdTree(means: Float32Array, N: number): KdTree {
    // buf is partitioned in-place; each node records its point index (the
    // median of its range) into a node-indexed array as it is created.
    const buf = new Int32Array(N);
    for (let i = 0; i < N; ++i) buf[i] = i;
    const idxArr = new Int32Array(N);
    const axisArr = new Int8Array(N);
    const leftArr = new Int32Array(N).fill(-1);
    const rightArr = new Int32Array(N).fill(-1);
    let count = 0;

    const buildRec = (lo: number, hi: number, depth: number): number => {
        if (lo >= hi) return -1;
        const axis = depth % 3;
        const mid = (lo + hi) >> 1;
        nthElement(means, buf, lo, mid, hi - 1, axis);
        const nodeId = count++;
        idxArr[nodeId] = buf[mid];
        axisArr[nodeId] = axis;
        // Children partition [lo, mid) and [mid+1, hi); buf[mid] is untouched.
        leftArr[nodeId] = buildRec(lo, mid, depth + 1);
        rightArr[nodeId] = buildRec(mid + 1, hi, depth + 1);
        return nodeId;
    };
    buildRec(0, N, 0);
    return { idxArr, axisArr, leftArr, rightArr, count };
}

/**
 * Quickselect: rearrange buf[lo..hi] so that the element that would be at
 * position `k` in sorted order (by means[buf[i]][axis]) is at buf[k], with
 * elements before ≤ and after ≥. Lomuto partition with median-of-three pivot.
 */
function nthElement(
    means: Float32Array,
    buf: Int32Array,
    lo: number,
    k: number,
    hi: number,
    axis: number
): void {
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (coord(means, buf, mid, axis) < coord(means, buf, lo, axis)) swap(buf, lo, mid);
        if (coord(means, buf, hi, axis) < coord(means, buf, lo, axis)) swap(buf, lo, hi);
        if (coord(means, buf, mid, axis) < coord(means, buf, hi, axis)) swap(buf, mid, hi);
        const pivot = coord(means, buf, hi, axis);
        let i = lo - 1;
        for (let j = lo; j < hi; ++j) {
            if (coord(means, buf, j, axis) <= pivot) {
                ++i;
                swap(buf, i, j);
            }
        }
        swap(buf, i + 1, hi);
        const p = i + 1;
        if (p === k) return;
        else if (k < p) hi = p - 1;
        else lo = p + 1;
    }
}

function coord(means: Float32Array, buf: Int32Array, i: number, axis: number): number {
    return means[buf[i] * 3 + axis];
}

function swap(buf: Int32Array, a: number, b: number): void {
    const t = buf[a]; buf[a] = buf[b]; buf[b] = t;
}

/**
 * k-NN query: returns the kk nearest point indices (ascending by squared
 * distance). Bounded max-heap (root = farthest of current kk nearest) with
 * splitting-plane pruning.
 */
function knnQuery(
    means: Float32Array,
    tree: KdTree,
    qx: number, qy: number, qz: number,
    kk: number
): number[] {
    const { idxArr, axisArr, leftArr, rightArr } = tree;
    const heapIdx = new Int32Array(kk);
    const heapDist = new Float64Array(kk); // squared distances
    let size = 0;

    const swapHeap = (a: number, b: number) => {
        const ti = heapIdx[a]; heapIdx[a] = heapIdx[b]; heapIdx[b] = ti;
        const td = heapDist[a]; heapDist[a] = heapDist[b]; heapDist[b] = td;
    };
    const siftUp = (i: number) => {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heapDist[parent] < heapDist[i]) {
                swapHeap(parent, i); i = parent;
            } else break;
        }
    };
    const siftDown = (i: number) => {
        while (true) {
            const l = 2 * i + 1, r = 2 * i + 2;
            let largest = i;
            if (l < size && heapDist[l] > heapDist[largest]) largest = l;
            if (r < size && heapDist[r] > heapDist[largest]) largest = r;
            if (largest !== i) {
                swapHeap(i, largest); i = largest;
            } else break;
        }
    };
    const pushHeap = (idx: number, d: number) => {
        if (size < kk) {
            heapIdx[size] = idx; heapDist[size] = d; ++size; siftUp(size - 1);
        } else if (d < heapDist[0]) {
            heapIdx[0] = idx; heapDist[0] = d; siftDown(0);
        }
    };

    // Iterative DFS over the child-array tree. A plain array auto-grows, which
    // is safer than a fixed typed-array stack (worst-case stack depth can reach
    // O(N) for degenerate inputs; balanced trees stay near O(log N)).
    const stack: number[] = [0];
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (node < 0) continue;
        const axis = axisArr[node];
        const pIdx = idxArr[node];
        const px = means[pIdx * 3];
        const py = means[pIdx * 3 + 1];
        const pz = means[pIdx * 3 + 2];
        const dx = qx - px, dy = qy - py, dz = qz - pz;
        pushHeap(pIdx, dx * dx + dy * dy + dz * dz);

        const diff = axis === 0 ? qx - px : (axis === 1 ? qy - py : qz - pz);
        const planeDist2 = diff * diff;
        const left = leftArr[node];
        const right = rightArr[node];
        const near = diff <= 0 ? left : right;
        const far = diff <= 0 ? right : left;

        // Push far first so near is processed first; prune far when the closest
        // point on the splitting plane is already farther than the current kk-th.
        if (far >= 0 && (size < kk || planeDist2 < heapDist[0])) stack.push(far);
        if (near >= 0) stack.push(near);
    }

    // Extract ascending (pop max repeatedly).
    const result = new Array<number>(size);
    for (let i = size - 1; i >= 0; --i) {
        result[i] = heapIdx[0];
        heapIdx[0] = heapIdx[size - 1];
        heapDist[0] = heapDist[size - 1];
        --size;
        if (size > 0) siftDown(0);
    }
    return result;
}
