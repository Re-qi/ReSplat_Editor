// Ported from NanoGS (https://github.com/RongLiu-Leo/NanoGS) — CC BY-NC 4.0.
// Original: src/nanogs/utils/ply_utils.py (read_ply activation + store_ply
// deactivation). See src/nanogs/README.md for attribution and license. This
// file is NOT released under the project CC BY 4.0 license; it remains under
// CC BY-NC 4.0 (NonCommercial). Commercial use requires a separate license
// from NanoGS authors.
//
// LCC2 integration glue: convert between a node's source PLY columns (already
// LCC2-coordinate-transformed by the caller) and the ACTIVATED SplatAttrs bundle
// consumed by simplifyNode, and back to per-column PLY-space arrays for chunk
// writing. Activation/deactivation mirror NanoGS read_ply/store_ply exactly so
// the merge math operates in the same space as the Python reference.

import { SplatAttrs } from './merge';
import { simplifyNode, NANOGS_NODE_CAP, NANOGS_NODE_MIN, type SimplifyOpts } from './simplify';

/** Column lookup by PLY property name (values are any typed-array view). */
export type ColumnLookup = { [name: string]: ArrayLike<number> };

/**
 * Build ACTIVATED SplatAttrs for one node's splat indices from source columns.
 * Mirrors NanoGS read_ply:
 *   op = sigmoid(raw opacity)            — alpha in [0,1]
 *   sc = exp(clip(raw scale, -30, 30))   — linear scales
 *   q  = normalize(raw quat [w,x,y,z])
 *   mu = x,y,z (already LCC2-transformed by the caller)
 *   sh = raw passthrough (f_dc_* + f_rest_*, in PLY order)
 *
 * `shColNames` must list every appearance column (f_dc_* + f_rest_*) in PLY
 * property order, matching NanoGS `app_names`.
 */
export function nodeAttrsFromColumns(
    indices: ArrayLike<number>,
    cols: ColumnLookup,
    shColNames: string[]
): SplatAttrs {
    const N = indices.length;
    const mu = new Float32Array(N * 3);
    const sc = new Float32Array(N * 3);
    const q = new Float32Array(N * 4);
    const op = new Float32Array(N);
    const C = shColNames.length;
    const sh = C > 0 ? new Float32Array(N * C) : new Float32Array(0);

    const xC = cols.x, yC = cols.y, zC = cols.z;
    const opC = cols.opacity;
    const s0C = cols.scale_0, s1C = cols.scale_1, s2C = cols.scale_2;
    const r0C = cols.rot_0, r1C = cols.rot_1, r2C = cols.rot_2, r3C = cols.rot_3;
    const shC = C > 0 ? shColNames.map(cn => cols[cn]) : null;

    for (let i = 0; i < N; ++i) {
        const gi = indices[i];
        mu[i * 3] = xC[gi]; mu[i * 3 + 1] = yC[gi]; mu[i * 3 + 2] = zC[gi];
        sc[i * 3]     = Math.exp(Math.max(-30, Math.min(30, s0C[gi])));
        sc[i * 3 + 1] = Math.exp(Math.max(-30, Math.min(30, s1C[gi])));
        sc[i * 3 + 2] = Math.exp(Math.max(-30, Math.min(30, s2C[gi])));
        op[i] = 1.0 / (1.0 + Math.exp(-opC[gi]));
        const qw = r0C[gi], qx = r1C[gi], qy = r2C[gi], qz = r3C[gi];
        let n = Math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz);
        if (n < 1e-12) n = 1e-12;
        const inv = 1.0 / n;
        q[i * 4] = qw * inv; q[i * 4 + 1] = qx * inv; q[i * 4 + 2] = qy * inv; q[i * 4 + 3] = qz * inv;
        if (C > 0) for (let c = 0; c < C; ++c) sh[i * C + c] = shC[c][gi];
    }
    return { mu, sc, q, op, sh, shCols: C };
}

/**
 * Deactivate merged attrs back to PLY-space per-column Float32Arrays, ready to
 * concatenate into a chunk. Mirrors NanoGS store_ply:
 *   opacity = logit(op)                   — back to raw logit
 *   scale_k = log(max(sc_k, 1e-12))       — back to raw log-scale
 *   rot_k   = q_k (already normalized)
 *   x,y,z   = mu (LCC2 space)
 *   sh      = merged appearance (f_dc_* + f_rest_*)
 * Non-appearance columns (nx,ny,nz,…) are ABSENT in the result → caller writes
 * 0 for them (NanoGS store_ply zeros them too).
 */
export function nodeAttrsToColumns(
    attrs: SplatAttrs,
    shColNames: string[]
): { [name: string]: Float32Array } {
    const { mu, sc, q, op, sh, shCols } = attrs;
    const N = mu.length / 3;
    const out: { [name: string]: Float32Array } = {};

    const xc = new Float32Array(N), yc = new Float32Array(N), zc = new Float32Array(N);
    const opc = new Float32Array(N);
    const s0c = new Float32Array(N), s1c = new Float32Array(N), s2c = new Float32Array(N);
    const r0c = new Float32Array(N), r1c = new Float32Array(N), r2c = new Float32Array(N), r3c = new Float32Array(N);
    for (let i = 0; i < N; ++i) {
        xc[i] = mu[i * 3]; yc[i] = mu[i * 3 + 1]; zc[i] = mu[i * 3 + 2];
        let p = op[i]; if (p < 1e-6) p = 1e-6; else if (p > 1 - 1e-6) p = 1 - 1e-6;
        opc[i] = Math.log(p / (1 - p));
        s0c[i] = Math.log(Math.max(sc[i * 3], 1e-12));
        s1c[i] = Math.log(Math.max(sc[i * 3 + 1], 1e-12));
        s2c[i] = Math.log(Math.max(sc[i * 3 + 2], 1e-12));
        r0c[i] = q[i * 4]; r1c[i] = q[i * 4 + 1]; r2c[i] = q[i * 4 + 2]; r3c[i] = q[i * 4 + 3];
    }
    out.x = xc; out.y = yc; out.z = zc;
    out.opacity = opc;
    out.scale_0 = s0c; out.scale_1 = s1c; out.scale_2 = s2c;
    out.rot_0 = r0c; out.rot_1 = r1c; out.rot_2 = r2c; out.rot_3 = r3c;
    if (shCols > 0) {
        for (let c = 0; c < shCols; ++c) {
            const col = new Float32Array(N);
            for (let i = 0; i < N; ++i) col[i] = sh[i * shCols + c];
            out[shColNames[c]] = col;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Native (C++) acceleration hook
//
// The backend (server/lcc2-export.mjs) can inject a C++ implementation of the
// progressive simplification core (native/nanogs.cc → simplifyNodeProgressive)
// via setNativeImpl(). When present, simplifyNodeBatched routes each batch
// through C++ (≈15× faster than the pure-TS path); the browser bundle never
// injects, so it keeps the TS implementation. setNativeImpl is a plain module
// assignment — no import-time side effects.
// ---------------------------------------------------------------------------

export interface NativeSimplifyResult {
    counts: Int32Array;
    mu: Float32Array;
    scales: Float32Array;
    quats: Float32Array;
    ops: Float32Array;
    sh: Float32Array;
}

export type NativeSimplifyFn = (
    means: Float32Array,
    scales: Float32Array,
    quats: Float32Array,
    ops: Float32Array,
    sh: Float32Array,
    ratios: Float32Array,
    opts: Record<string, number>
) => NativeSimplifyResult | null;

let nativeImpl: NativeSimplifyFn | null = null;

export function setNativeImpl(impl: NativeSimplifyFn | null): void {
    nativeImpl = impl;
}

export function getNativeImpl(): NativeSimplifyFn | null {
    return nativeImpl;
}

// ---------------------------------------------------------------------------
// Large-node sub-batching
//
// LCC2 spatial-tree cells can hold millions of splats (the backend splits at
// SOG_CHUNK_TARGET = 3M), far above simplifyNode's NANOGS_NODE_CAP (100K).
// Without sub-batching, those large cells fall back to uniform stride sampling
// — so the cells holding most of the splats never get NanoGS quality.
//
// partitionSpatially cuts a node's indices into ≤cap spatially-coherent
// batches (recursive longest-axis midpoint split). simplifyNodeBatched runs
// simplifyNode per batch (per-batch uniform fallback on failure/undersize),
// then concatenates the resulting columns. NanoGS coverage goes from ~13% to
// ~100% of splats. Cost: export time ~2-4× (proportional to total splats).
// See plan: nanogs-large-node-subbatch.md.
// ---------------------------------------------------------------------------

type PosLookup = { x: ArrayLike<number>; y: ArrayLike<number>; z: ArrayLike<number> };

/**
 * Recursively partition `indices` into spatially-coherent batches each ≤ cap,
 * by splitting at the longest-axis AABB midpoint. O(N·depth), depth ≈ log2(N/cap).
 * Degenerate coincident-point cases (midpoint fails to split) fall back to an
 * index-based halving; maxDepth exhaustion falls back to cap-sized slices.
 * Exported for the backend worker pool, which pre-partitions chain tops into
 * per-batch tasks (must match simplifyNodeBatched's internal partitioning).
 */
export function partitionSpatially(
    indices: ArrayLike<number>,
    pos: PosLookup,
    cap: number,
    maxDepth = 16
): number[][] {
    const n = indices.length;
    if (n <= cap) {
        const arr = new Array<number>(n);
        for (let i = 0; i < n; ++i) arr[i] = indices[i];
        return [arr];
    }
    if (maxDepth <= 0) {
        // Exhausted recursion (all points coincident) — slice by index.
        const batches: number[][] = [];
        for (let s = 0; s < n; s += cap) {
            const e = Math.min(s + cap, n);
            const arr = new Array<number>(e - s);
            for (let i = 0; i < e - s; ++i) arr[i] = indices[s + i];
            batches.push(arr);
        }
        return batches;
    }

    // AABB
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < n; ++i) {
        const gi = indices[i];
        const x = pos.x[gi], y = pos.y[gi], z = pos.z[gi];
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    const dx = mxx - mnx, dy = mxy - mny, dz = mxz - mnz;

    // Longest axis → midpoint + coordinate accessor.
    let mid: number;
    let coord: (gi: number) => number;
    if (dx >= dy && dx >= dz) {
        mid = (mnx + mxx) * 0.5;
        coord = gi => pos.x[gi];
    } else if (dy >= dz) {
        mid = (mny + mxy) * 0.5;
        coord = gi => pos.y[gi];
    } else {
        mid = (mnz + mxz) * 0.5;
        coord = gi => pos.z[gi];
    }

    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < n; ++i) {
        const gi = indices[i];
        (coord(gi) <= mid ? left : right).push(gi);
    }

    // Degenerate: midpoint didn't separate (all on one side). Force an
    // index-based halving so recursion still shrinks each child.
    if (left.length === 0 || right.length === 0) {
        const all = new Array<number>(n);
        for (let i = 0; i < n; ++i) all[i] = indices[i];
        const half = n >> 1;
        const l = all.slice(0, half);
        const r = all.slice(half);
        return [
            ...partitionSpatially(l, pos, cap, maxDepth - 1),
            ...partitionSpatially(r, pos, cap, maxDepth - 1)
        ];
    }

    return [
        ...partitionSpatially(left, pos, cap, maxDepth - 1),
        ...partitionSpatially(right, pos, cap, maxDepth - 1)
    ];
}

/**
 * Per-node NanoGS simplification with automatic sub-batching for large nodes.
 *
 * Partitions the node's splats into ≤ NANOGS_NODE_CAP spatial batches, runs
 * simplifyNode on each (falling back to uniform stride per batch on failure or
 * undersize), and concatenates the resulting columns.
 *
 * Multi-ratio variant (plan §6 D3): a single call produces ONE snapshot per
 * ratio in `ratiosDesc`, by leveraging simplifyProgressive's one-KNN-pass
 * multi-threshold snapshotting. The caller passes all coarse-LOD keep ratios
 * (descending, excluding 1.0) and receives an array of m snapshots, ready to
 * distribute to the depth chunks. This avoids the prior waste where the
 * depth-major loop re-simplified the same `finestIndices` once per depth,
 * rebuilding KNN on N0 up to `treeDepth-1` times.
 *
 * Returns `null` only when `indices` is empty. Otherwise returns an array of
 * `ratiosDesc.length` entries, each `{ cols, count }` covering ALL `colNames`:
 *   - NanoGS batches: appearance/transform columns from nodeAttrsToColumns;
 *     non-appearance columns (nx,ny,nz normals) are zeroed.
 *   - Uniform-fallback batches: all columns copied from `colLookup`.
 *
 * Per-batch NanoGS failures are caught and logged (that batch falls back to
 * uniform for ALL ratios) — the caller's outer try/catch only fires on truly
 * unexpected errors.
 *
 * Small nodes (≤ cap) partition into a single batch = the previous behavior,
 * so this is a drop-in replacement with no regression (just returns an array).
 */
export function simplifyNodeBatched(
    indices: ArrayLike<number>,
    colLookup: ColumnLookup,
    colNames: string[],
    shColNames: string[],
    ratiosDesc: number[],
    opts: SimplifyOpts
): { cols: { [name: string]: Float32Array }; count: number }[] | null {
    const n = indices.length;
    if (n === 0) return null;
    const m = ratiosDesc.length;
    if (m === 0) return [];

    const pos: PosLookup = { x: colLookup.x, y: colLookup.y, z: colLookup.z };
    const batches = partitionSpatially(indices, pos, NANOGS_NODE_CAP);
    const numCols = colNames.length;

    // Pass 1: resolve each batch to per-ratio { colsForBatch, bCount }.
    // batchSnaps[b] = array of m { colsForBatch, bCount } (one per ratio).
    const batchSnaps:
        { colsForBatch: { [name: string]: Float32Array | null }; bCount: number }[][] = [];

    for (let b = 0; b < batches.length; ++b) {
        const batch = batches[b];
        const bLen = batch.length;
        const snapsForBatch:
            { colsForBatch: { [name: string]: Float32Array | null }; bCount: number }[] = new Array(m);
        let usedNanogs = false;

        try {
            const attrs = nodeAttrsFromColumns(batch, colLookup, shColNames);
            const bN = attrs.mu.length / 3;
            // Native (C++) path: whole batch in one call when available and the
            // batch is not undersized for KNN. Mirrors simplifyNode's N<MIN→null.
            const native = getNativeImpl();
            if (native && bN >= NANOGS_NODE_MIN) {
                // C++ binding requires typed arrays; plain number[] would fail
                // napi_get_typedarray_info (Fatal in NAPI_DISABLE_CPP_EXCEPTIONS).
                const ratiosArr = Float32Array.from(ratiosDesc);
                const nativeOpts: Record<string, number> = {
                    k: opts.k,
                    mergeCap: opts.mergeCap,
                    shCols: opts.shCols,
                    lamGeo: opts.cost.lamGeo,
                    lamSh: opts.cost.lamSh,
                    nMc: opts.cost.nMc ?? 1,
                    seed: opts.cost.seed ?? 0,
                    epsCov: opts.cost.epsCov ?? 1e-8
                };
                const nres = native(attrs.mu, attrs.sc, attrs.q, attrs.op, attrs.sh, ratiosArr, nativeOpts);
                if (nres && nres.counts.length === m && nres.counts.length > 0) {
                    const C = attrs.shCols;
                    let off = 0;
                    for (let r = 0; r < m; ++r) {
                        const cnt = nres.counts[r];
                        const snapAttrs: SplatAttrs = {
                            mu: nres.mu.subarray(off * 3, (off + cnt) * 3),
                            sc: nres.scales.subarray(off * 3, (off + cnt) * 3),
                            q: nres.quats.subarray(off * 4, (off + cnt) * 4),
                            op: nres.ops.subarray(off, off + cnt),
                            sh: C > 0 ? nres.sh.subarray(off * C, (off + cnt) * C) :
                                new Float32Array(0),
                            shCols: C
                        };
                        const snapCols = nodeAttrsToColumns(snapAttrs, shColNames);
                        const colsForBatch: { [name: string]: Float32Array | null } = {};
                        for (let ci = 0; ci < numCols; ++ci) {
                            const cn = colNames[ci];
                            colsForBatch[cn] = (cn in snapCols) ? snapCols[cn] : null;
                        }
                        snapsForBatch[r] = { colsForBatch, bCount: cnt };
                        off += cnt;
                    }
                    usedNanogs = true;
                }
            }
            if (!usedNanogs) {
                // simplifyNode → simplifyProgressive: one KNN pass, m snapshots.
                const snaps = simplifyNode(attrs, ratiosDesc, opts);
                if (snaps && snaps.length === m) {
                    for (let r = 0; r < m; ++r) {
                        const snapCols = nodeAttrsToColumns(snaps[r], shColNames);
                        const bCount = snaps[r].mu.length / 3;
                        const colsForBatch: { [name: string]: Float32Array | null } = {};
                        for (let ci = 0; ci < numCols; ++ci) {
                            const cn = colNames[ci];
                            // NanoGS output omits non-appearance columns (normals);
                            // mark them null so Pass 2 zeroes them.
                            colsForBatch[cn] = (cn in snapCols) ? snapCols[cn] : null;
                        }
                        snapsForBatch[r] = { colsForBatch, bCount };
                    }
                    usedNanogs = true;
                }
            }
        } catch (e) {
            console.warn(`[NanoGS] batch simplify failed (${bLen} splats): ${(e as Error).message} — uniform fallback`);
        }

        if (!usedNanogs) {
            // Uniform stride fallback for this batch (undersize <NANOGS_NODE_MIN,
            // simplifyNode threw/returned null). Produces m snapshots, one per
            // ratio, so the multi-ratio contract is preserved.
            for (let r = 0; r < m; ++r) {
                const rate = ratiosDesc[r];
                const bCount = Math.max(1, Math.ceil(bLen * rate));
                const step = bLen / bCount;
                const colsForBatch: { [name: string]: Float32Array | null } = {};
                for (let ci = 0; ci < numCols; ++ci) {
                    const cn = colNames[ci];
                    const src = colLookup[cn];
                    const dst = new Float32Array(bCount);
                    for (let j = 0; j < bCount; ++j) dst[j] = src[batch[Math.floor(j * step)]];
                    colsForBatch[cn] = dst;
                }
                snapsForBatch[r] = { colsForBatch, bCount };
            }
        }

        batchSnaps.push(snapsForBatch);
    }

    // Pass 2: per ratio, concatenate per-column across batches.
    const results: { cols: { [name: string]: Float32Array }; count: number }[] = [];
    for (let r = 0; r < m; ++r) {
        let total = 0;
        for (let b = 0; b < batches.length; ++b) total += batchSnaps[b][r].bCount;
        const cols: { [name: string]: Float32Array } = {};
        if (total === 0) {
            // Edge case: shouldn't happen (uniform uses Math.max(1, ...)), but
            // guard anyway so callers always get numCols entries.
            for (let ci = 0; ci < numCols; ++ci) cols[colNames[ci]] = new Float32Array(0);
            results.push({ cols, count: 0 });
            continue;
        }
        for (let ci = 0; ci < numCols; ++ci) {
            const cn = colNames[ci];
            const dst = new Float32Array(total);
            let off = 0;
            for (let b = 0; b < batches.length; ++b) {
                const src = batchSnaps[b][r].colsForBatch[cn];
                const cnt = batchSnaps[b][r].bCount;
                if (src) {
                    for (let j = 0; j < cnt; ++j) dst[off + j] = src[j];
                } // else: NanoGS batch without this column (normals) → leave 0
                off += cnt;
            }
            cols[cn] = dst;
        }
        results.push({ cols, count: total });
    }
    return results;
}
