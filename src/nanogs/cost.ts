// Ported from NanoGS (https://github.com/RongLiu-Leo/NanoGS) — CC BY-NC 4.0.
// Original: src/nanogs/utils/cost.py (full_cost_pairs)
// See src/nanogs/README.md for attribution and license. This file is NOT
// released under the project CC BY 4.0 license; it remains under CC BY-NC 4.0
// (NonCommercial). Commercial use requires a separate license from NanoGS authors.
//
// NOTE on numerical parity: the original uses numpy's `np.random.default_rng`
// (PCG64) for the deterministic MC samples. This port uses an independent
// seedable PRNG (mulberry32 + Box-Muller), so MC-derived costs are NOT
// bit-identical to Python for n_mc > 0. The cost FUNCTION and merge logic are
// preserved; only the MC sample sequence differs. For deterministic
// cross-language validation, increase n_mc or compare structural properties.

import { CostParams } from './params';
import {
    quatToRotmatBatch,
    gaussLogpdfDiagrotBatch,
    LOG2PI
} from './splat-utils';

const TWO_PI_SQRT_CUBE = Math.pow(2.0 * Math.PI, 1.5); // (2π)^1.5

/** Numerically stable log(exp(a) + exp(b)). Mirrors np.logaddexp. */
function logaddexp(a: number, b: number): number {
    if (a === -Infinity) return b;
    if (b === -Infinity) return a;
    const m = a > b ? a : b;
    return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/** mulberry32 — small deterministic PRNG. Not PCG64; see file header. */
function mulberry32(seed: number): () => number {
    let s = seed | 0;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t ^= (t + Math.imul(t ^ (t >>> 7), 61 | t));
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Standard normal via Box-Muller, drawing from rng. */
function randn(rng: () => number): number {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Symmetric merge cost for a batch of candidate pairs (i, j). Mirrors
 * full_cost_pairs: KL(p_mix || q_merge) geometry term + SH L2 term.
 *
 * Inputs are batched over B pairs:
 *   mu_i, mu_j : (B*3)  splat means
 *   s_i,  s_j  : (B*3)  linear scales (activated)
 *   q_i,  q_j  : (B*4)  quaternions [w,x,y,z] (normalized)
 *   a_i,  a_j  : (B)    opacities in [0,1]
 *   sh_i, sh_j : (B*C)  SH/appearance (C = shCols; 0 disables SH term)
 * Returns (B,) costs.
 */
export function fullCostPairs(
    mu_i: Float32Array, s_i: Float32Array, q_i: Float32Array, a_i: Float32Array, sh_i: Float32Array,
    mu_j: Float32Array, s_j: Float32Array, q_j: Float32Array, a_j: Float32Array, sh_j: Float32Array,
    cost: CostParams,
    B: number,
    shCols: number
): Float32Array {
    const nMc = cost.nMc ?? 1;
    const seed = cost.seed ?? 0;
    const epsCov = cost.epsCov ?? 1e-8;
    const lamGeo = cost.lamGeo;
    const lamSh = cost.lamSh;

    const out = new Float32Array(B);
    if (B === 0) return out;

    const R_i = quatToRotmatBatch(q_i, B);
    const R_j = quatToRotmatBatch(q_j, B);

    // Precompute per-batch scalars and arrays.
    const invdiag_i = new Float32Array(B * 3);
    const invdiag_j = new Float32Array(B * 3);
    const logdet_i = new Float32Array(B);
    const logdet_j = new Float32Array(B);
    const pi = new Float32Array(B);
    const logPi = new Float32Array(B);
    const logPj = new Float32Array(B);
    const logdetM = new Float32Array(B);
    const std_i = new Float32Array(B * 3);
    const std_j = new Float32Array(B * 3);

    for (let b = 0; b < B; ++b) {
        const si = b * 3, qi = b * 4;
        // v = s^2 + eps
        const v_i0 = s_i[si] * s_i[si] + epsCov;
        const v_i1 = s_i[si + 1] * s_i[si + 1] + epsCov;
        const v_i2 = s_i[si + 2] * s_i[si + 2] + epsCov;
        const v_j0 = s_j[si] * s_j[si] + epsCov;
        const v_j1 = s_j[si + 1] * s_j[si + 1] + epsCov;
        const v_j2 = s_j[si + 2] * s_j[si + 2] + epsCov;

        const vi0 = v_i0 < 1e-30 ? 1e-30 : v_i0;
        const vi1 = v_i1 < 1e-30 ? 1e-30 : v_i1;
        const vi2 = v_i2 < 1e-30 ? 1e-30 : v_i2;
        const vj0 = v_j0 < 1e-30 ? 1e-30 : v_j0;
        const vj1 = v_j1 < 1e-30 ? 1e-30 : v_j1;
        const vj2 = v_j2 < 1e-30 ? 1e-30 : v_j2;

        invdiag_i[si] = 1.0 / vi0; invdiag_i[si + 1] = 1.0 / vi1; invdiag_i[si + 2] = 1.0 / vi2;
        invdiag_j[si] = 1.0 / vj0; invdiag_j[si + 1] = 1.0 / vj1; invdiag_j[si + 2] = 1.0 / vj2;
        logdet_i[b] = Math.log(vi0) + Math.log(vi1) + Math.log(vi2);
        logdet_j[b] = Math.log(vj0) + Math.log(vj1) + Math.log(vj2);

        std_i[si] = Math.sqrt(v_i0 < 0 ? 0 : v_i0);
        std_i[si + 1] = Math.sqrt(v_i1 < 0 ? 0 : v_i1);
        std_i[si + 2] = Math.sqrt(v_i2 < 0 ? 0 : v_i2);
        std_j[si] = Math.sqrt(v_j0 < 0 ? 0 : v_j0);
        std_j[si + 1] = Math.sqrt(v_j1 < 0 ? 0 : v_j1);
        std_j[si + 2] = Math.sqrt(v_j2 < 0 ? 0 : v_j2);

        // mixture weights
        const wi = TWO_PI_SQRT_CUBE * a_i[b] * (s_i[si] * s_i[si + 1] * s_i[si + 2]) + 1e-12;
        const wj = TWO_PI_SQRT_CUBE * a_j[b] * (s_j[si] * s_j[si + 1] * s_j[si + 2]) + 1e-12;
        const W = wi + wj;
        const Wsafe = W > 0 ? W : 1.0;
        let p = wi / Wsafe;
        if (p < 1e-12) p = 1e-12;
        if (p > 1 - 1e-12) p = 1 - 1e-12;
        pi[b] = p;
        logPi[b] = Math.log(p);
        logPj[b] = Math.log(1.0 - p);

        // moment-matched merge mean
        const m0 = p * mu_i[si] + (1 - p) * mu_j[si];
        const m1 = p * mu_i[si + 1] + (1 - p) * mu_j[si + 1];
        const m2 = p * mu_i[si + 2] + (1 - p) * mu_j[si + 2];

        // di = mu_i - mu_m, dj = mu_j - mu_m
        const di0 = mu_i[si] - m0, di1 = mu_i[si + 1] - m1, di2 = mu_i[si + 2] - m2;
        const dj0 = mu_j[si] - m0, dj1 = mu_j[si + 1] - m1, dj2 = mu_j[si + 2] - m2;

        // Sig_i = R_i diag(v_i) R_i^T  (R_i row-major)
        const roi = b * 9, roj = b * 9;
        const Ri00 = R_i[roi], Ri01 = R_i[roi + 1], Ri02 = R_i[roi + 2];
        const Ri10 = R_i[roi + 3], Ri11 = R_i[roi + 4], Ri12 = R_i[roi + 5];
        const Ri20 = R_i[roi + 6], Ri21 = R_i[roi + 7], Ri22 = R_i[roi + 8];
        const Rj00 = R_j[roj], Rj01 = R_j[roj + 1], Rj02 = R_j[roj + 2];
        const Rj10 = R_j[roj + 3], Rj11 = R_j[roj + 4], Rj12 = R_j[roj + 5];
        const Rj20 = R_j[roj + 6], Rj21 = R_j[roj + 7], Rj22 = R_j[roj + 8];

        // Sigma[r,c] = sum_k R[r,k] * v[k] * R[c,k]
        const SigI00 = Ri00 * Ri00 * v_i0 + Ri01 * Ri01 * v_i1 + Ri02 * Ri02 * v_i2;
        const SigI01 = Ri00 * Ri10 * v_i0 + Ri01 * Ri11 * v_i1 + Ri02 * Ri12 * v_i2;
        const SigI02 = Ri00 * Ri20 * v_i0 + Ri01 * Ri21 * v_i1 + Ri02 * Ri22 * v_i2;
        const SigI10 = SigI01;
        const SigI11 = Ri10 * Ri10 * v_i0 + Ri11 * Ri11 * v_i1 + Ri12 * Ri12 * v_i2;
        const SigI12 = Ri10 * Ri20 * v_i0 + Ri11 * Ri21 * v_i1 + Ri12 * Ri22 * v_i2;
        const SigI20 = SigI02;
        const SigI21 = SigI12;
        const SigI22 = Ri20 * Ri20 * v_i0 + Ri21 * Ri21 * v_i1 + Ri22 * Ri22 * v_i2;

        const SigJ00 = Rj00 * Rj00 * v_j0 + Rj01 * Rj01 * v_j1 + Rj02 * Rj02 * v_j2;
        const SigJ01 = Rj00 * Rj10 * v_j0 + Rj01 * Rj11 * v_j1 + Rj02 * Rj12 * v_j2;
        const SigJ02 = Rj00 * Rj20 * v_j0 + Rj01 * Rj21 * v_j1 + Rj02 * Rj22 * v_j2;
        const SigJ11 = Rj10 * Rj10 * v_j0 + Rj11 * Rj11 * v_j1 + Rj12 * Rj12 * v_j2;
        const SigJ12 = Rj10 * Rj20 * v_j0 + Rj11 * Rj21 * v_j1 + Rj12 * Rj22 * v_j2;
        const SigJ22 = Rj20 * Rj20 * v_j0 + Rj21 * Rj21 * v_j1 + Rj22 * Rj22 * v_j2;

        // outer products odi[r,c] = di[r]*di[c]
        const odi00 = di0 * di0, odi01 = di0 * di1, odi02 = di0 * di2;
        const odi10 = odi01, odi11 = di1 * di1, odi12 = di1 * di2;
        const odi20 = odi02, odi21 = odi12, odi22 = di2 * di2;
        const odj00 = dj0 * dj0, odj01 = dj0 * dj1, odj02 = dj0 * dj2;
        const odj10 = odj01, odj11 = dj1 * dj1, odj12 = dj1 * dj2;
        const odj20 = odj02, odj21 = odj12, odj22 = dj2 * dj2;

        // Sig_m = pi*(Sig_i+odi) + (1-pi)*(Sig_j+odj)
        const q = 1 - p;
        let M00 = p * (SigI00 + odi00) + q * (SigJ00 + odj00);
        let M01 = p * (SigI01 + odi01) + q * (SigJ01 + odj01);
        let M02 = p * (SigI02 + odi02) + q * (SigJ02 + odj02);
        let M11 = p * (SigI11 + odi11) + q * (SigJ11 + odj11);
        let M12 = p * (SigI12 + odi12) + q * (SigJ12 + odj12);
        let M22 = p * (SigI22 + odi22) + q * (SigJ22 + odj22);
        // symmetrize + eps*I (Sig* and od* are symmetric, so (r,c)==(c,r);
        // the 0.5 average mirrors numpy's 0.5*(Sig_m + Sig_m^T) for FP safety)
        M01 = 0.5 * (M01 + p * (SigI10 + odi10) + q * (SigJ01 + odj10));
        M02 = 0.5 * (M02 + p * (SigI20 + odi20) + q * (SigJ02 + odj20));
        M12 = 0.5 * (M12 + p * (SigI21 + odi21) + q * (SigJ12 + odj21));
        M00 += epsCov;
        M11 += epsCov;
        M22 += epsCov;

        // slogdet of SPD 3x3 → log(det)
        const detM = M00 * (M11 * M22 - M12 * M12) -
                   M01 * (M01 * M22 - M12 * M02) +
                   M02 * (M01 * M12 - M11 * M02);
        logdetM[b] = Math.log(Math.abs(detM) < 1e-300 ? 1e-300 : Math.abs(detM));

        // E_p_neglogq = 0.5 * (k*log2pi + logdet_m + k)
        // stored below into out via MC section
        // (computed inline after MC)
    }

    // Deterministic MC samples shared across pairs: Z is (nMc, 3).
    const rng = mulberry32(seed);
    const Z = new Float32Array(nMc * 3);
    for (let i = 0; i < nMc * 3; ++i) Z[i] = randn(rng);

    // Build sample points x_i, x_j: (B, nMc, 3)
    //   Zi[b,s,k] = Z[s,k] * std_i[b,k]
    //   x_i[b,s,c] = mu_i[b,c] + sum_k Zi[b,s,k] * R_i[b,c,k]   (matmul(Zi, R_i^T))
    const x_i = new Float32Array(B * nMc * 3);
    const x_j = new Float32Array(B * nMc * 3);
    for (let b = 0; b < B; ++b) {
        const si = b * 3, roi = b * 9;
        const mui0 = mu_i[si], mui1 = mu_i[si + 1], mui2 = mu_i[si + 2];
        const muj0 = mu_j[si], muj1 = mu_j[si + 1], muj2 = mu_j[si + 2];
        const sti0 = std_i[si], sti1 = std_i[si + 1], sti2 = std_i[si + 2];
        const stj0 = std_j[si], stj1 = std_j[si + 1], stj2 = std_j[si + 2];
        const Ri00 = R_i[roi], Ri01 = R_i[roi + 1], Ri02 = R_i[roi + 2];
        const Ri10 = R_i[roi + 3], Ri11 = R_i[roi + 4], Ri12 = R_i[roi + 5];
        const Ri20 = R_i[roi + 6], Ri21 = R_i[roi + 7], Ri22 = R_i[roi + 8];
        const Rj00 = R_j[roi], Rj01 = R_j[roi + 1], Rj02 = R_j[roi + 2];
        const Rj10 = R_j[roi + 3], Rj11 = R_j[roi + 4], Rj12 = R_j[roi + 5];
        const Rj20 = R_j[roi + 6], Rj21 = R_j[roi + 7], Rj22 = R_j[roi + 8];
        for (let s = 0; s < nMc; ++s) {
            const zk0 = Z[s * 3], zk1 = Z[s * 3 + 1], zk2 = Z[s * 3 + 2];
            const zi0 = zk0 * sti0, zi1 = zk1 * sti1, zi2 = zk2 * sti2;
            const zj0 = zk0 * stj0, zj1 = zk1 * stj1, zj2 = zk2 * stj2;
            const xo = b * nMc * 3 + s * 3;
            // x_i[c] = mu_i[c] + sum_k zi[k] * R_i[c,k]
            x_i[xo] = mui0 + (zi0 * Ri00 + zi1 * Ri01 + zi2 * Ri02);
            x_i[xo + 1] = mui1 + (zi0 * Ri10 + zi1 * Ri11 + zi2 * Ri12);
            x_i[xo + 2] = mui2 + (zi0 * Ri20 + zi1 * Ri21 + zi2 * Ri22);
            x_j[xo] = muj0 + (zj0 * Rj00 + zj1 * Rj01 + zj2 * Rj02);
            x_j[xo + 1] = muj1 + (zj0 * Rj10 + zj1 * Rj11 + zj2 * Rj12);
            x_j[xo + 2] = muj2 + (zj0 * Rj20 + zj1 * Rj21 + zj2 * Rj22);
        }
    }

    // logpdfs (B, nMc)
    const logNiOnI = gaussLogpdfDiagrotBatch(x_i, mu_i, R_i, invdiag_i, logdet_i, B, nMc);
    const logNjOnI = gaussLogpdfDiagrotBatch(x_i, mu_j, R_j, invdiag_j, logdet_j, B, nMc);
    const logNiOnJ = gaussLogpdfDiagrotBatch(x_j, mu_i, R_i, invdiag_i, logdet_i, B, nMc);
    const logNjOnJ = gaussLogpdfDiagrotBatch(x_j, mu_j, R_j, invdiag_j, logdet_j, B, nMc);

    const k = 3.0;
    for (let b = 0; b < B; ++b) {
        const lp = logPi[b], lq = logPj[b];
        let Ei = 0;
        let Ej = 0;
        for (let s = 0; s < nMc; ++s) {
            const idx = b * nMc + s;
            Ei += logaddexp(lp + logNiOnI[idx], lq + logNjOnI[idx]);
            Ej += logaddexp(lp + logNiOnJ[idx], lq + logNjOnJ[idx]);
        }
        Ei /= nMc;
        Ej /= nMc;
        const E_p_logp = pi[b] * Ei + (1 - pi[b]) * Ej;
        const E_p_neglogq = 0.5 * (k * LOG2PI + logdetM[b] + k);
        const geo = E_p_logp + E_p_neglogq;

        let c_sh = 0;
        if (shCols > 0) {
            const sb = b * shCols;
            for (let c = 0; c < shCols; ++c) {
                const d = sh_i[sb + c] - sh_j[sb + c];
                c_sh += d * d;
            }
        }
        out[b] = lamGeo * geo + lamSh * c_sh;
    }

    return out;
}
