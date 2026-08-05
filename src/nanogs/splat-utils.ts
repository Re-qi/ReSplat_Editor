// Ported from NanoGS (https://github.com/RongLiu-Leo/NanoGS) — CC BY-NC 4.0.
// Original: src/nanogs/utils/splat_utils.py
// See src/nanogs/README.md for attribution and license. This file is NOT
// released under the project CC BY 4.0 license; it remains under CC BY-NC 4.0
// (NonCommercial). Commercial use requires a separate license from NanoGS authors.
//
// Array layout conventions (matching numpy (N, K) batch semantics):
//   - quaternions q  : Float32Array length N*4, [w, x, y, z] per splat
//   - rotations R    : Float32Array length N*9, row-major (r*3 + c)
//   - vectors (mu/sc): Float32Array length N*3
//   - opacity op     : Float32Array length N
//   - sh             : Float32Array length N*C
// All batch functions take N explicitly to avoid implicit length inference.

/** 1.0 / (2*pi) is not needed; log(2*pi) is. */
const LOG2PI = Math.log(2.0 * Math.PI);

/** Normalize each quaternion in place semantics (returns new array). q is (N,4) [w,x,y,z]. */
export function quatNormalize(q: Float32Array, N: number): Float32Array {
    const out = new Float32Array(N * 4);
    for (let i = 0; i < N; ++i) {
        const b = i * 4;
        const w = q[b], x = q[b + 1], y = q[b + 2], z = q[b + 3];
        let n = Math.sqrt(w * w + x * x + y * y + z * z);
        if (n < 1e-12) n = 1e-12;
        const inv = 1.0 / n;
        out[b] = w * inv;
        out[b + 1] = x * inv;
        out[b + 2] = y * inv;
        out[b + 3] = z * inv;
    }
    return out;
}

/**
 * Quaternion (w,x,y,z) → 3×3 rotation matrix, batched. Mirrors
 * quat_to_rotmat_batch. Returns flat (N*9) row-major R.
 */
export function quatToRotmatBatch(qWxyz: Float32Array, N: number): Float32Array {
    const R = new Float32Array(N * 9);
    for (let i = 0; i < N; ++i) {
        const b = i * 4;
        const w = qWxyz[b], x = qWxyz[b + 1], y = qWxyz[b + 2], z = qWxyz[b + 3];
        const ww = w * w, xx = x * x, yy = y * y, zz = z * z;
        const wx = w * x, wy = w * y, wz = w * z;
        const xy = x * y, xz = x * z, yz = y * z;
        const o = i * 9;
        R[o + 0] = 1 - 2 * (yy + zz);
        R[o + 1] = 2 * (xy - wz);
        R[o + 2] = 2 * (xz + wy);
        R[o + 3] = 2 * (xy + wz);
        R[o + 4] = 1 - 2 * (xx + zz);
        R[o + 5] = 2 * (yz - wx);
        R[o + 6] = 2 * (xz - wy);
        R[o + 7] = 2 * (yz + wx);
        R[o + 8] = 1 - 2 * (xx + yy);
    }
    return R;
}

/**
 * 3×3 rotation matrix → quaternion (w,x,y,z), batched. Mirrors
 * rotmat_to_quat_batch (the four-branch Shepperd's method). Returns (N,4).
 */
export function rotmatToQuatBatch(R: Float32Array, N: number): Float32Array {
    const q = new Float32Array(N * 4);
    for (let i = 0; i < N; ++i) {
        const o = i * 9;
        const m00 = R[o + 0], m11 = R[o + 4], m22 = R[o + 8];
        const m01 = R[o + 1], m02 = R[o + 2];
        const m10 = R[o + 3], m12 = R[o + 5];
        const m20 = R[o + 6], m21 = R[o + 7];
        const tr = m00 + m11 + m22;
        let w: number, x: number, y: number, z: number;
        if (tr > 0) {
            const S = Math.sqrt(tr + 1.0) * 2.0; // S = 4*w
            w = 0.25 * S;
            x = (m21 - m12) / S;
            y = (m02 - m20) / S;
            z = (m10 - m01) / S;
        } else if (m00 > m11 && m00 > m22) {
            const S = Math.sqrt(1.0 + m00 - m11 - m22) * 2.0; // S = 4*x
            w = (m21 - m12) / S;
            x = 0.25 * S;
            y = (m01 + m10) / S;
            z = (m02 + m20) / S;
        } else if (m11 > m22) {
            const S = Math.sqrt(1.0 + m11 - m00 - m22) * 2.0; // S = 4*y
            w = (m02 - m20) / S;
            x = (m01 + m10) / S;
            y = 0.25 * S;
            z = (m12 + m21) / S;
        } else {
            const S = Math.sqrt(1.0 + m22 - m00 - m11) * 2.0; // S = 4*z
            w = (m10 - m01) / S;
            x = (m02 + m20) / S;
            y = (m12 + m21) / S;
            z = 0.25 * S;
        }
        const b = i * 4;
        q[b] = w; q[b + 1] = x; q[b + 2] = y; q[b + 3] = z;
    }
    return quatNormalize(q, N);
}

/**
 * Build covariance Sigma = R diag(s²) R^T, batched. Mirrors
 * sigma_from_scale_quat_batch. Returns flat (N*9) row-major.
 */
export function sigmaFromScaleQuatBatch(scales: Float32Array, qWxyz: Float32Array, N: number): Float32Array {
    const R = quatToRotmatBatch(qWxyz, N);
    const out = new Float32Array(N * 9);
    for (let i = 0; i < N; ++i) {
        const sb = i * 3;
        const s0 = scales[sb] * scales[sb];
        const s1 = scales[sb + 1] * scales[sb + 1];
        const s2 = scales[sb + 2] * scales[sb + 2];
        const o = i * 9;
        // Rd = R * s2 (scale columns of R by s²)
        // Sigma = Rd @ R^T
        // Rd row r, col c = R[r,c] * s2[c]
        // Sigma[r,c] = sum_k Rd[r,k] * R[c,k] = sum_k R[r,k]*s2[k]*R[c,k]
        for (let r = 0; r < 3; ++r) {
            for (let c = 0; c < 3; ++c) {
                let acc = 0;
                acc += R[o + r * 3 + 0] * R[o + c * 3 + 0] * s0;
                acc += R[o + r * 3 + 1] * R[o + c * 3 + 1] * s1;
                acc += R[o + r * 3 + 2] * R[o + c * 3 + 2] * s2;
                out[o + r * 3 + c] = acc;
            }
        }
    }
    return out;
}

/** Determinant of each 3×3 matrix, batched. Mirrors det_3x3. Returns (N,). */
export function det3x3(A: Float32Array, N: number): Float32Array {
    const out = new Float32Array(N);
    for (let i = 0; i < N; ++i) {
        const o = i * 9;
        const a00 = A[o + 0], a01 = A[o + 1], a02 = A[o + 2];
        const a10 = A[o + 3], a11 = A[o + 4], a12 = A[o + 5];
        const a20 = A[o + 6], a21 = A[o + 7], a22 = A[o + 8];
        out[i] = a00 * (a11 * a22 - a12 * a21) -
               a01 * (a10 * a22 - a12 * a20) +
               a02 * (a10 * a21 - a11 * a20);
    }
    return out;
}

/** Inverse of each 3×3 matrix, batched. Mirrors batch_inv_3x3. Returns (N*9). */
export function batchInv3x3(A: Float32Array, N: number): Float32Array {
    const out = new Float32Array(N * 9);
    for (let i = 0; i < N; ++i) {
        const o = i * 9;
        const a00 = A[o + 0], a01 = A[o + 1], a02 = A[o + 2];
        const a10 = A[o + 3], a11 = A[o + 4], a12 = A[o + 5];
        const a20 = A[o + 6], a21 = A[o + 7], a22 = A[o + 8];

        const c00 = a11 * a22 - a12 * a21;
        const c01 = a02 * a21 - a01 * a22;
        const c02 = a01 * a12 - a02 * a11;
        const c10 = a12 * a20 - a10 * a22;
        const c11 = a00 * a22 - a02 * a20;
        const c12 = a02 * a10 - a00 * a12;
        const c20 = a10 * a21 - a11 * a20;
        const c21 = a01 * a20 - a00 * a21;
        const c22 = a00 * a11 - a01 * a10;

        let det = a00 * c00 + a01 * c10 + a02 * c20;
        if (Math.abs(det) < 1e-18) det = 1e-18;
        const invDet = 1.0 / det;

        out[o + 0] = c00 * invDet;
        out[o + 1] = c01 * invDet;
        out[o + 2] = c02 * invDet;
        out[o + 3] = c10 * invDet;
        out[o + 4] = c11 * invDet;
        out[o + 5] = c12 * invDet;
        out[o + 6] = c20 * invDet;
        out[o + 7] = c21 * invDet;
        out[o + 8] = c22 * invDet;
    }
    return out;
}

/** elementwise log(max(x, 1e-12)). Mirrors safe_log. */
export function safeLog(x: Float32Array): Float32Array {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; ++i) {
        out[i] = Math.log(x[i] < 1e-12 ? 1e-12 : x[i]);
    }
    return out;
}

export function sigmoid(x: Float32Array): Float32Array {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; ++i) {
        out[i] = 1.0 / (1.0 + Math.exp(-x[i]));
    }
    return out;
}

export function logit(p: Float32Array): Float32Array {
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; ++i) {
        let v = p[i];
        if (v < 1e-6) v = 1e-6;
        if (v > 1 - 1e-6) v = 1 - 1e-6;
        out[i] = Math.log(v / (1 - v));
    }
    return out;
}

/**
 * log N(x | mu, Sigma) where Sigma = R diag(v) R^T, using the rotated-diagonal
 * quadratic. Mirrors gauss_logpdf_diagrot_batch.
 *   x:        (B, S, 3) flat, length B*S*3, x[b,s,c] at b*S*3 + s*3 + c
 *   mu:       (B, 3)
 *   R:        (B, 3, 3) row-major
 *   invdiag:  (B, 3)    (= 1/v)
 *   logdet:   (B,)
 * Returns (B, S).
 */
export function gaussLogpdfDiagrotBatch(
    x: Float32Array,
    mu: Float32Array,
    R: Float32Array,
    invdiag: Float32Array,
    logdet: Float32Array,
    B: number,
    S: number
): Float32Array {
    const k = 3.0;
    const out = new Float32Array(B * S);
    for (let b = 0; b < B; ++b) {
        const m0 = mu[b * 3], m1 = mu[b * 3 + 1], m2 = mu[b * 3 + 2];
        const id0 = invdiag[b * 3], id1 = invdiag[b * 3 + 1], id2 = invdiag[b * 3 + 2];
        const ro = b * 9;
        // R is row-major: R[r*3+c]. y = d @ R → y[c] = sum_k d[k] * R[k, c]
        for (let s = 0; s < S; ++s) {
            const xo = b * S * 3 + s * 3;
            const d0 = x[xo] - m0;
            const d1 = x[xo + 1] - m1;
            const d2 = x[xo + 2] - m2;
            const y0 = d0 * R[ro + 0] + d1 * R[ro + 3] + d2 * R[ro + 6];
            const y1 = d0 * R[ro + 1] + d1 * R[ro + 4] + d2 * R[ro + 7];
            const y2 = d0 * R[ro + 2] + d1 * R[ro + 5] + d2 * R[ro + 8];
            const quad = y0 * y0 * id0 + y1 * y1 * id1 + y2 * y2 * id2;
            out[b * S + s] = -0.5 * (k * LOG2PI + logdet[b] + quad);
        }
    }
    return out;
}

export { LOG2PI };
