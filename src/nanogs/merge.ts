// Ported from NanoGS (https://github.com/RongLiu-Leo/NanoGS) — CC BY-NC 4.0.
// Original: src/nanogs/utils/merge.py (moment_matching, merge_pairs)
// See src/nanogs/README.md for attribution and license. This file is NOT
// released under the project CC BY 4.0 license; it remains under CC BY-NC 4.0
// (NonCommercial). Commercial use requires a separate license from NanoGS authors.

import { sigmaFromScaleQuatBatch, rotmatToQuatBatch } from './splat-utils';

/** Bundle of activated gaussian attributes (column-of-splats layout). */
export interface SplatAttrs {
    mu: Float32Array;   // (N*3)
    sc: Float32Array;   // (N*3) linear scales
    q: Float32Array;    // (N*4) [w,x,y,z] normalized
    op: Float32Array;   // (N,)  in [0,1]
    sh: Float32Array;   // (N*C) appearance; length 0 if none
    shCols: number;     // C
}

const TWO_PI_SQRT_CUBE = Math.pow(2.0 * Math.PI, 1.5);

/**
 * Symmetric 3×3 eigendecomposition via cyclic Jacobi rotations. Replaces
 * numpy.linalg.eigh. Returns eigenvalues ASCENDING (matching eigh) and
 * eigenvectors as a row-major 3×3 where COLUMN c is the eigenvector for
 * evals[c] (i.e. matrix[r*3 + c] = evec_c[r]).
 */
function symEig3(
    a00: number, a01: number, a02: number,
    a11: number, a12: number,
    a22: number
): { evals: number[]; evecs: Float32Array } {
    let m00 = a00, m01 = a01, m02 = a02;
    let m11 = a11, m12 = a12, m22 = a22;
    // V starts as identity (column c is eigenvector c). Row-major.
    const V = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

    const applyRotation = (p: number, q: number) => {
        const apq = p === 0 && q === 1 ? m01 : (p === 0 && q === 2 ? m02 : m12);
        if (Math.abs(apq) < 1e-18) return;
        const app = p === 0 ? m00 : m11;
        const aqq = q === 1 ? m11 : m22;
        const tau = (aqq - app) / (2 * apq);
        const t = tau >= 0 ?
            1 / (tau + Math.sqrt(1 + tau * tau)) :
            -1 / (-tau + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        // new diagonals
        if (p === 0 && q === 1) {
            m00 = app - t * apq;
            m11 = aqq + t * apq;
            m01 = 0; // m01 zeroed; m02, m12 updated below
            const r2p = m02, r2q = m12;
            m02 = c * r2p - s * r2q;
            m12 = s * r2p + c * r2q;
        } else if (p === 0 && q === 2) {
            m00 = app - t * apq;
            m22 = aqq + t * apq;
            m02 = 0;
            const r1p = m01, r1q = m12;
            m01 = c * r1p - s * r1q;
            m12 = s * r1p + c * r1q;
        } else { // p === 1, q === 2
            m11 = app - t * apq;
            m22 = aqq + t * apq;
            m12 = 0;
            const r0p = m01, r0q = m02;
            m01 = c * r0p - s * r0q;
            m02 = s * r0p + c * r0q;
        }

        // update eigenvector columns p and q: V[r][p], V[r][q]
        for (let r = 0; r < 3; ++r) {
            const vrp = V[r * 3 + p];
            const vrq = V[r * 3 + q];
            V[r * 3 + p] = c * vrp - s * vrq;
            V[r * 3 + q] = s * vrp + c * vrq;
        }
    };

    for (let sweep = 0; sweep < 40; ++sweep) {
        const off = Math.abs(m01) + Math.abs(m02) + Math.abs(m12);
        if (off < 1e-15) break;
        applyRotation(0, 1);
        applyRotation(0, 2);
        applyRotation(1, 2);
    }

    const evals = [m00, m11, m22];
    // Sort ascending (insertion sort, n=3).
    const idx = [0, 1, 2];
    idx.sort((a, b) => evals[a] - evals[b]);
    const sortedEvals = idx.map(i => evals[i]);
    // Reorder V columns.
    const Vsorted = new Float32Array(9);
    for (let c = 0; c < 3; ++c) {
        const src = idx[c];
        for (let r = 0; r < 3; ++r) {
            Vsorted[r * 3 + c] = V[r * 3 + src];
        }
    }
    return { evals: sortedEvals, evecs: Vsorted };
}

/** Determinant of a row-major 3×3. */
function det3(evecs: Float32Array): number {
    return evecs[0] * (evecs[4] * evecs[8] - evecs[5] * evecs[7]) -
         evecs[1] * (evecs[3] * evecs[8] - evecs[5] * evecs[6]) +
         evecs[2] * (evecs[3] * evecs[7] - evecs[4] * evecs[6]);
}

/**
 * Moment-matched merge of B candidate pairs. Mirrors moment_matching. Inputs
 * are ACTIVATED (linear scales, alpha in [0,1], normalized quat). Outputs are
 * ACTIVATED (caller converts to RAW for PLY writing).
 *
 *   mu_i, mu_j : (B*3),  s_i, s_j : (B*3),  q_i, q_j : (B*4),
 *   a_i, a_j   : (B),    sh_i, sh_j : (B*C)
 * Returns merged { mu, sc, q, op, sh } over B results.
 */
export function momentMatching(
    mu_i: Float32Array, s_i: Float32Array, q_i: Float32Array, a_i: Float32Array, sh_i: Float32Array,
    mu_j: Float32Array, s_j: Float32Array, q_j: Float32Array, a_j: Float32Array, sh_j: Float32Array,
    B: number,
    shCols: number
): SplatAttrs {
    const SigI = sigmaFromScaleQuatBatch(s_i, q_i, B);
    const SigJ = sigmaFromScaleQuatBatch(s_j, q_j, B);

    const outMu = new Float32Array(B * 3);
    const outSc = new Float32Array(B * 3);
    const outQ = new Float32Array(B * 4);
    const outOp = new Float32Array(B);
    const outSh = shCols > 0 ? new Float32Array(B * shCols) : new Float32Array(0);

    for (let b = 0; b < B; ++b) {
        const si = b * 3;
        const prodI = s_i[si] * s_i[si + 1] * s_i[si + 2];
        const prodJ = s_j[si] * s_j[si + 1] * s_j[si + 2];
        const wi = TWO_PI_SQRT_CUBE * a_i[b] * prodI + 1e-12;
        const wj = TWO_PI_SQRT_CUBE * a_j[b] * prodJ + 1e-12;
        let W = wi + wj;
        if (W < 1e-12) W = 1e-12;
        const invW = 1.0 / W;

        // merged mean
        const m0 = (wi * mu_i[si] + wj * mu_j[si]) * invW;
        const m1 = (wi * mu_i[si + 1] + wj * mu_j[si + 1]) * invW;
        const m2 = (wi * mu_i[si + 2] + wj * mu_j[si + 2]) * invW;
        outMu[si] = m0; outMu[si + 1] = m1; outMu[si + 2] = m2;

        const di0 = mu_i[si] - m0, di1 = mu_i[si + 1] - m1, di2 = mu_i[si + 2] - m2;
        const dj0 = mu_j[si] - m0, dj1 = mu_j[si + 1] - m1, dj2 = mu_j[si + 2] - m2;

        const oi = b * 9;
        // Sigma = (wi*(Sig_i + odi) + wj*(Sig_j + odj)) / W
        const S00 = (wi * (SigI[oi] + di0 * di0) + wj * (SigJ[oi] + dj0 * dj0)) * invW;
        let S01 = (wi * (SigI[oi + 1] + di0 * di1) + wj * (SigJ[oi + 1] + dj0 * dj1)) * invW;
        let S02 = (wi * (SigI[oi + 2] + di0 * di2) + wj * (SigJ[oi + 2] + dj0 * dj2)) * invW;
        const S11 = (wi * (SigI[oi + 4] + di1 * di1) + wj * (SigJ[oi + 4] + dj1 * dj1)) * invW;
        let S12 = (wi * (SigI[oi + 5] + di1 * di2) + wj * (SigJ[oi + 5] + dj1 * dj2)) * invW;
        const S22 = (wi * (SigI[oi + 8] + di2 * di2) + wj * (SigJ[oi + 8] + dj2 * dj2)) * invW;
        // symmetrize + 1e-8 * I
        S01 = 0.5 * (S01 + (wi * (SigI[oi + 3] + di1 * di0) + wj * (SigJ[oi + 3] + dj1 * dj0)) * invW) + 0;
        S02 = 0.5 * (S02 + (wi * (SigI[oi + 6] + di2 * di0) + wj * (SigJ[oi + 6] + dj2 * dj0)) * invW);
        S12 = 0.5 * (S12 + (wi * (SigI[oi + 7] + di2 * di1) + wj * (SigJ[oi + 7] + dj2 * dj1)) * invW);
        const M00 = S00 + 1e-8;
        const M11 = S11 + 1e-8;
        const M22 = S22 + 1e-8;

        const { evals, evecs } = symEig3(M00, S01, S02, M11, S12, M22);
        // numpy path: maximum(evals, 1e-18) then sort DESCENDING; symEig3 gives
        // ascending, so reverse to descending.
        const e0 = Math.max(evals[2], 1e-18);
        const e1 = Math.max(evals[1], 1e-18);
        const e2 = Math.max(evals[0], 1e-18);
        // descending eigenvectors: col 0 ← evals[2] (largest), col 1 ← evals[1], col 2 ← evals[0]
        const Vdesc = new Float32Array(9);
        for (let r = 0; r < 3; ++r) {
            Vdesc[r * 3 + 0] = evecs[r * 3 + 2];
            Vdesc[r * 3 + 1] = evecs[r * 3 + 1];
            Vdesc[r * 3 + 2] = evecs[r * 3 + 0];
        }
        // enforce right-handed: if det < 0, flip column 2 (smallest eigenvalue)
        if (det3(Vdesc) < 0) {
            Vdesc[2] = -Vdesc[2];
            Vdesc[5] = -Vdesc[5];
            Vdesc[8] = -Vdesc[8];
        }
        const sc0 = Math.sqrt(e0);
        const sc1 = Math.sqrt(e1);
        const sc2 = Math.sqrt(e2);
        outSc[si] = sc0; outSc[si + 1] = sc1; outSc[si + 2] = sc2;

        // quaternion from rotation matrix (single)
        const quat = rotmatToQuatBatch(Vdesc, 1);
        outQ[b * 4] = quat[0];
        outQ[b * 4 + 1] = quat[1];
        outQ[b * 4 + 2] = quat[2];
        outQ[b * 4 + 3] = quat[3];

        outOp[b] = a_i[b] + a_j[b] - a_i[b] * a_j[b];

        if (shCols > 0) {
            const sb = b * shCols;
            for (let c = 0; c < shCols; ++c) {
                outSh[sb + c] = (wi * sh_i[sb + c] + wj * sh_j[sb + c]) * invW;
            }
        }
    }

    return { mu: outMu, sc: outSc, q: outQ, op: outOp, sh: outSh, shCols };
}

/**
 * Apply a set of disjoint merge pairs to the full splat set. Mirrors merge_pairs.
 * Returns a new SplatAttrs with un-merged splats kept and merged results appended.
 *   pairs: Int32Array (M*2), each row [i, j] into the current splat set of size N.
 */
export function mergePairs(attrs: SplatAttrs, pairs: Int32Array): SplatAttrs {
    const { mu, sc, q, op, sh, shCols } = attrs;
    const N = mu.length / 3;
    const M = pairs.length / 2;
    const C = shCols;

    if (M === 0) return attrs;

    const iArr = new Float32Array(M * 3);
    const siArr = new Float32Array(M * 3);
    const qiArr = new Float32Array(M * 4);
    const aiArr = new Float32Array(M);
    const shiArr = C > 0 ? new Float32Array(M * C) : new Float32Array(0);
    const jArr = new Float32Array(M * 3);
    const sjArr = new Float32Array(M * 3);
    const qjArr = new Float32Array(M * 4);
    const ajArr = new Float32Array(M);
    const shjArr = C > 0 ? new Float32Array(M * C) : new Float32Array(0);

    for (let p = 0; p < M; ++p) {
        const ii = pairs[p * 2];
        const jj = pairs[p * 2 + 1];
        iArr[p * 3] = mu[ii * 3]; iArr[p * 3 + 1] = mu[ii * 3 + 1]; iArr[p * 3 + 2] = mu[ii * 3 + 2];
        siArr[p * 3] = sc[ii * 3]; siArr[p * 3 + 1] = sc[ii * 3 + 1]; siArr[p * 3 + 2] = sc[ii * 3 + 2];
        qiArr[p * 4] = q[ii * 4]; qiArr[p * 4 + 1] = q[ii * 4 + 1]; qiArr[p * 4 + 2] = q[ii * 4 + 2]; qiArr[p * 4 + 3] = q[ii * 4 + 3];
        aiArr[p] = op[ii];
        jArr[p * 3] = mu[jj * 3]; jArr[p * 3 + 1] = mu[jj * 3 + 1]; jArr[p * 3 + 2] = mu[jj * 3 + 2];
        sjArr[p * 3] = sc[jj * 3]; sjArr[p * 3 + 1] = sc[jj * 3 + 1]; sjArr[p * 3 + 2] = sc[jj * 3 + 2];
        qjArr[p * 4] = q[jj * 4]; qjArr[p * 4 + 1] = q[jj * 4 + 1]; qjArr[p * 4 + 2] = q[jj * 4 + 2]; qjArr[p * 4 + 3] = q[jj * 4 + 3];
        ajArr[p] = op[jj];
        if (C > 0) {
            for (let c = 0; c < C; ++c) {
                shiArr[p * C + c] = sh[ii * C + c];
                shjArr[p * C + c] = sh[jj * C + c];
            }
        }
    }

    const merged = momentMatching(iArr, siArr, qiArr, aiArr, shiArr, jArr, sjArr, qjArr, ajArr, shjArr, M, C);

    // keep_idx = all indices not in any pair
    const used = new Uint8Array(N);
    for (let p = 0; p < M; ++p) {
        used[pairs[p * 2]] = 1;
        used[pairs[p * 2 + 1]] = 1;
    }
    const keepCount = N - 2 * M;
    const newN = keepCount + M;
    const newMu = new Float32Array(newN * 3);
    const newSc = new Float32Array(newN * 3);
    const newQ = new Float32Array(newN * 4);
    const newOp = new Float32Array(newN);
    const newSh = C > 0 ? new Float32Array(newN * C) : new Float32Array(0);

    let o = 0;
    for (let i = 0; i < N; ++i) {
        if (used[i]) continue;
        newMu[o * 3] = mu[i * 3]; newMu[o * 3 + 1] = mu[i * 3 + 1]; newMu[o * 3 + 2] = mu[i * 3 + 2];
        newSc[o * 3] = sc[i * 3]; newSc[o * 3 + 1] = sc[i * 3 + 1]; newSc[o * 3 + 2] = sc[i * 3 + 2];
        newQ[o * 4] = q[i * 4]; newQ[o * 4 + 1] = q[i * 4 + 1]; newQ[o * 4 + 2] = q[i * 4 + 2]; newQ[o * 4 + 3] = q[i * 4 + 3];
        newOp[o] = op[i];
        if (C > 0) {
            for (let c = 0; c < C; ++c) newSh[o * C + c] = sh[i * C + c];
        }
        ++o;
    }
    // append merged
    newMu.set(merged.mu, o * 3);
    newSc.set(merged.sc, o * 3);
    newQ.set(merged.q, o * 4);
    newOp.set(merged.op, o);
    if (C > 0) newSh.set(merged.sh, o * C);

    return { mu: newMu, sc: newSc, q: newQ, op: newOp, sh: newSh, shCols: C };
}
