// Ported from NanoGS (https://github.com/RongLiu-Leo/NanoGS) — CC BY-NC 4.0.
// Original: src/nanogs/simplification.py (simplify, knn_undirected_edges,
// edge_costs, greedy_pairs_from_edges, prune_by_opacity)
// See src/nanogs/README.md for attribution and license. This file is NOT
// released under the project CC BY 4.0 license; it remains under CC BY-NC 4.0
// (NonCommercial). Commercial use requires a separate license from NanoGS authors.
//
// Extension over the original: `simplifyProgressive` / `simplifyNode` produce
// multiple ratio-snapshot LOD levels from a single merge pass. The core
// greedy merge logic (KNN → undirected edges → KL cost → disjoint pairs →
// moment-matched merge) is preserved.

import { fullCostPairs } from './cost';
import { knnIndices } from './knn';
import { SplatAttrs, mergePairs } from './merge';
import { CostParams } from './params';

export { SplatAttrs };

/** Options shared by the simplify loops. */
export interface SimplifyOpts {
    /** k for KNN candidates. */
    k: number;
    /** Max merges per pass as a ratio of the original splat count (0.01–0.5). */
    mergeCap: number;
    /** Cost-function parameters. */
    cost: CostParams;
    /** Number of SH/appearance columns (0 disables the SH term). */
    shCols: number;
}

/** Default opts mirroring the NanoGS CLI defaults. */
export const defaultSimplifyOpts = (overrides: Partial<SimplifyOpts> = {}): SimplifyOpts => ({
    k: 16,
    mergeCap: 0.5,
    cost: { lamGeo: 1.0, lamSh: 1.0, nMc: 1, seed: 0, epsCov: 1e-8 },
    shCols: 0,
    ...overrides
});

/**
 * Per-node splat count above which the LCC2 integration falls back to uniform
 * sampling. Pure-TS KNN+cost on larger nodes is too slow for interactive
 * export. Tunable via opts; see plan §3.2/§7.4.
 */
export const NANOGS_NODE_CAP = 100_000;
/** Per-node splat count below which KNN is unstable → uniform fallback. */
export const NANOGS_NODE_MIN = 32;

const EDGE_BLOCK = 100_000;

/** Deep-copy a SplatAttrs (typed arrays are copied). */
function cloneAttrs(a: SplatAttrs): SplatAttrs {
    return {
        mu: new Float32Array(a.mu),
        sc: new Float32Array(a.sc),
        q: new Float32Array(a.q),
        op: new Float32Array(a.op),
        sh: a.sh.length > 0 ? new Float32Array(a.sh) : new Float32Array(0),
        shCols: a.shCols
    };
}

/**
 * Build unique undirected edges (u < v) from directed kNN neighbors, taking the
 * union of "j in kNN(i) OR i in kNN(j)". Mirrors knn_undirected_edges. Edge
 * order is unspecified (greedy re-sorts by cost anyway); self-edges dropped.
 */
export function knnUndirectedEdges(nbr: Int32Array, N: number, k: number): Int32Array {
    const seen = new Set<number>();
    const edges: number[] = [];
    for (let i = 0; i < N; ++i) {
        for (let j = 0; j < k; ++j) {
            const nb = nbr[i * k + j];
            if (nb === i) continue;
            const u = i < nb ? i : nb;
            const v = i < nb ? nb : i;
            const key = u * N + v; // u < v; safe for N up to ~2^26.5 (>> our cap)
            if (!seen.has(key)) {
                seen.add(key);
                edges.push(u, v);
            }
        }
    }
    return Int32Array.from(edges);
}

/** Compute the symmetric merge cost for every edge. Mirrors edge_costs. */
export function edgeCosts(edges: Int32Array, attrs: SplatAttrs, cost: CostParams, shCols: number): Float32Array {
    const M = edges.length / 2;
    const w = new Float32Array(M);
    if (M === 0) return w;
    const { mu, sc, q, op, sh } = attrs;
    const C = shCols;

    for (let e0 = 0; e0 < M; e0 += EDGE_BLOCK) {
        const e1 = Math.min(M, e0 + EDGE_BLOCK);
        const B = e1 - e0;
        const mu_i = new Float32Array(B * 3), mu_j = new Float32Array(B * 3);
        const s_i = new Float32Array(B * 3), s_j = new Float32Array(B * 3);
        const q_i = new Float32Array(B * 4), q_j = new Float32Array(B * 4);
        const a_i = new Float32Array(B), a_j = new Float32Array(B);
        const sh_i = C > 0 ? new Float32Array(B * C) : new Float32Array(0);
        const sh_j = C > 0 ? new Float32Array(B * C) : new Float32Array(0);

        for (let b = 0; b < B; ++b) {
            const u = edges[(e0 + b) * 2];
            const v = edges[(e0 + b) * 2 + 1];
            mu_i[b * 3] = mu[u * 3]; mu_i[b * 3 + 1] = mu[u * 3 + 1]; mu_i[b * 3 + 2] = mu[u * 3 + 2];
            mu_j[b * 3] = mu[v * 3]; mu_j[b * 3 + 1] = mu[v * 3 + 1]; mu_j[b * 3 + 2] = mu[v * 3 + 2];
            s_i[b * 3] = sc[u * 3]; s_i[b * 3 + 1] = sc[u * 3 + 1]; s_i[b * 3 + 2] = sc[u * 3 + 2];
            s_j[b * 3] = sc[v * 3]; s_j[b * 3 + 1] = sc[v * 3 + 1]; s_j[b * 3 + 2] = sc[v * 3 + 2];
            q_i[b * 4] = q[u * 4]; q_i[b * 4 + 1] = q[u * 4 + 1]; q_i[b * 4 + 2] = q[u * 4 + 2]; q_i[b * 4 + 3] = q[u * 4 + 3];
            q_j[b * 4] = q[v * 4]; q_j[b * 4 + 1] = q[v * 4 + 1]; q_j[b * 4 + 2] = q[v * 4 + 2]; q_j[b * 4 + 3] = q[v * 4 + 3];
            a_i[b] = op[u];
            a_j[b] = op[v];
            if (C > 0) {
                for (let c = 0; c < C; ++c) {
                    sh_i[b * C + c] = sh[u * C + c];
                    sh_j[b * C + c] = sh[v * C + c];
                }
            }
        }

        const wb = fullCostPairs(mu_i, s_i, q_i, a_i, sh_i, mu_j, s_j, q_j, a_j, sh_j, cost, B, C);
        for (let b = 0; b < B; ++b) w[e0 + b] = wb[b];
    }
    return w;
}

/**
 * Greedily pick disjoint pairs from edges sorted by cost ascending. Mirrors
 * greedy_pairs_from_edges. `P` (null = no cap) bounds the number of pairs.
 */
export function greedyPairsFromEdges(edges: Int32Array, w: Float32Array, N: number, P: number | null): Int32Array {
    const M = edges.length / 2;
    if (M === 0) return new Int32Array(0);

    const order = new Array<number>(M);
    for (let i = 0; i < M; ++i) order[i] = i;
    // Stable ascending sort by cost (Array.sort is stable in ES2019+).
    order.sort((a, b) => w[a] - w[b]);

    const used = new Uint8Array(N);
    const pairs: number[] = [];
    const cap = P === null ? Infinity : P;
    for (let oi = 0; oi < M; ++oi) {
        const ei = order[oi];
        if (!isFinite(w[ei])) continue;
        const u = edges[ei * 2];
        const v = edges[ei * 2 + 1];
        if (used[u] || used[v]) continue;
        used[u] = 1;
        used[v] = 1;
        pairs.push(u, v);
        if (pairs.length / 2 >= cap) break;
    }
    return Int32Array.from(pairs);
}

/**
 * Prune splats with opacity below threshold. Mirrors prune_by_opacity. The
 * effective threshold is min(threshold, median(opacity)). Retained for parity
 * with the reference CLI path; `simplifyNode` skips it (source data is clean).
 */
export function pruneByOpacity(attrs: SplatAttrs, threshold: number): SplatAttrs {
    const { mu, sc, q, op, sh, shCols } = attrs;
    const N = mu.length / 3;
    const C = shCols;
    // median opacity
    const sorted = Float32Array.from(op).sort();
    const median = sorted[Math.floor(N / 2)];
    const eff = Math.min(threshold, median);
    const keepIdx: number[] = [];
    for (let i = 0; i < N; ++i) if (op[i] >= eff) keepIdx.push(i);
    const K = keepIdx.length;
    const newMu = new Float32Array(K * 3);
    const newSc = new Float32Array(K * 3);
    const newQ = new Float32Array(K * 4);
    const newOp = new Float32Array(K);
    const newSh = C > 0 ? new Float32Array(K * C) : new Float32Array(0);
    for (let k = 0; k < K; ++k) {
        const i = keepIdx[k];
        newMu[k * 3] = mu[i * 3]; newMu[k * 3 + 1] = mu[i * 3 + 1]; newMu[k * 3 + 2] = mu[i * 3 + 2];
        newSc[k * 3] = sc[i * 3]; newSc[k * 3 + 1] = sc[i * 3 + 1]; newSc[k * 3 + 2] = sc[i * 3 + 2];
        newQ[k * 4] = q[i * 4]; newQ[k * 4 + 1] = q[i * 4 + 1]; newQ[k * 4 + 2] = q[i * 4 + 2]; newQ[k * 4 + 3] = q[i * 4 + 3];
        newOp[k] = op[i];
        if (C > 0) for (let c = 0; c < C; ++c) newSh[k * C + c] = sh[i * C + c];
    }
    return { mu: newMu, sc: newSc, q: newQ, op: newOp, sh: newSh, shCols: C };
}

/**
 * Single-ratio simplification. Mirrors simplify() — used for parity validation
 * against the Python reference. Iteratively merges until count ≤ target.
 */
export function simplify(attrs: SplatAttrs, ratio: number, opts: SimplifyOpts): SplatAttrs {
    const N0 = attrs.mu.length / 3;
    const target = Math.max(Math.ceil(N0 * ratio), 1);
    let work = cloneAttrs(attrs);
    const pCap = Math.max(1, Math.floor(opts.mergeCap * N0));

    let iter = 0;
    while (work.mu.length / 3 > target) {
        const N = work.mu.length / 3;
        const kEff = Math.min(Math.max(1, opts.k), Math.max(1, N - 1));
        const nbr = knnIndices(work.mu, N, kEff);
        const edges = knnUndirectedEdges(nbr, N, kEff);
        const w = edgeCosts(edges, work, opts.cost, opts.shCols);
        const mergesNeeded = N - target;
        const P = Math.min(mergesNeeded, pCap);
        const pairs = greedyPairsFromEdges(edges, w, N, P);
        if (pairs.length / 2 === 0) break; // no valid merges
        work = mergePairs(work, pairs);
        ++iter;
        if (iter > 10000) break; // safety valve
    }
    // clip opacity into [0,1] (matches Python final clip)
    const op = work.op;
    for (let i = 0; i < op.length; ++i) {
        if (op[i] < 0) op[i] = 0;
        if (op[i] > 1) op[i] = 1;
    }
    return work;
}

/**
 * Progressive multi-ratio simplification: run ONE merge sequence toward the
 * coarsest target, snapshotting the current splat set each time the count
 * crosses an intermediate target. Returns one SplatAttrs per ratio, in the SAME
 * order as `ratiosDesc`.
 *
 * `ratiosDesc` must be sorted DESCENDING (e.g. [0.75, 0.5, 0.25]), each in
 * (0, 1). The finest level (ratio 1.0) is NOT included here — the caller keeps
 * the original finest data.
 *
 * NOTE: this is an efficient approximation of running `simplify` once per
 * ratio. Because merges per pass are capped by `mergeCap` (not by each ratio's
 * target until near it), the early-pass merge sequence matches independent
 * runs; intermediate snapshots are high-quality but not bit-identical to
 * separate simplify() calls. See plan §6 D3.
 */
export function simplifyProgressive(attrs: SplatAttrs, ratiosDesc: number[], opts: SimplifyOpts): SplatAttrs[] {
    const m = ratiosDesc.length;
    if (m === 0) return [];
    const N0 = attrs.mu.length / 3;
    // targets descend with ratios: t0 > t1 > ... > t(m-1)
    const targets = ratiosDesc.map(r => Math.max(Math.ceil(N0 * r), 1));
    const snapshots: SplatAttrs[] = new Array(m).fill(null as unknown as SplatAttrs);

    let work = cloneAttrs(attrs);
    const pCap = Math.max(1, Math.floor(opts.mergeCap * N0));
    const coarsestTarget = targets[m - 1];
    let nextIdx = 0; // next unmet snapshot

    const fillRemaining = () => {
        while (nextIdx < m) {
            snapshots[nextIdx] = cloneAttrs(work);
            ++nextIdx;
        }
    };

    let iter = 0;
    while (nextIdx < m) {
        const N = work.mu.length / 3;
        // Snapshot any targets already met by the current count.
        while (nextIdx < m && N <= targets[nextIdx]) {
            snapshots[nextIdx] = cloneAttrs(work);
            ++nextIdx;
        }
        if (nextIdx >= m) break;
        if (N <= coarsestTarget || N <= 1) {
            fillRemaining();
            break;
        }

        const kEff = Math.min(Math.max(1, opts.k), Math.max(1, N - 1));
        const nbr = knnIndices(work.mu, N, kEff);
        const edges = knnUndirectedEdges(nbr, N, kEff);
        if (edges.length === 0) {
            fillRemaining(); break;
        }
        const w = edgeCosts(edges, work, opts.cost, opts.shCols);
        // Bound merges by the NEXT unmet snapshot target so each ratio
        // produces a distinct LOD snapshot. Using coarsestTarget here lets
        // mergeCap (default 0.5) merge past several intermediate ratio
        // thresholds in one pass, collapsing LOD levels together.
        const nextTarget = targets[nextIdx];
        const mergesNeeded = Math.max(1, N - nextTarget);
        const P = Math.min(mergesNeeded, pCap);
        const pairs = greedyPairsFromEdges(edges, w, N, P);
        if (pairs.length / 2 === 0) {
            fillRemaining(); break;
        }
        work = mergePairs(work, pairs);

        ++iter;
        if (iter > 10000) {
            fillRemaining(); break;
        }
    }

    // clip opacity into [0,1] for every snapshot
    for (const s of snapshots) {
        if (!s) continue;
        for (let i = 0; i < s.op.length; ++i) {
            if (s.op[i] < 0) s.op[i] = 0;
            if (s.op[i] > 1) s.op[i] = 1;
        }
    }
    return snapshots;
}

/**
 * Node-level entry point for LCC2 multi-LOD generation. Returns one snapshot
 * per ratio (descending order, same as input), or `null` to signal the caller
 * should fall back to uniform sampling (node too small or too large for the
 * pure-TS path).
 *
 *   attrs     : the node's finest splats (ACTIVATED: linear scales, alpha in
 *               [0,1], normalized quat).
 *   ratiosDesc: coarse-LOD keep ratios in descending order, e.g. [0.75,0.5,0.25]
 *               (exclude the finest ratio 1.0).
 *   opts      : simplify options; opts.shCols must match attrs.shCols.
 */
export function simplifyNode(
    attrs: SplatAttrs,
    ratiosDesc: number[],
    opts: SimplifyOpts,
    nodeCap = NANOGS_NODE_CAP,
    nodeMin = NANOGS_NODE_MIN
): SplatAttrs[] | null {
    const N = attrs.mu.length / 3;
    if (N < nodeMin || N > nodeCap) return null;
    // Nothing to simplify if no coarse ratios requested.
    if (ratiosDesc.length === 0) return [];
    return simplifyProgressive(attrs, ratiosDesc, opts);
}
