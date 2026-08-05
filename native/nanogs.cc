// nanogs.cc - C++ native acceleration for the NanoGS TS port
// (LCC2 multi-LOD progressive simplification core)
//
// Ported from the TypeScript implementation in src/nanogs/ (simplify.ts,
// cost.ts, merge.ts, splat-utils.ts, knn.ts), which itself is a port of
// NanoGS (https://github.com/RongLiu-Leo/NanoGS) - CC BY-NC 4.0. This file
// is NOT released under the project CC BY 4.0 license; it remains under
// CC BY-NC 4.0 (NonCommercial). See src/nanogs/README.md.
//
// Exposes:
//   simplifyNodeProgressive(means, scales, quats, ops, sh, ratios, opts)
//     -> { counts, mu, scales, quats, ops, sh }
// Implements the FULL progressive pipeline (KD-tree KNN -> undirected edges
// -> KL+SH cost -> greedy disjoint pairs -> moment-matched merge -> ratio
// snapshots) in one call, mirroring simplifyProgressive() exactly.

#include <napi.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <numeric>
#include <queue>
#include <vector>

namespace nanogs {

// ========== Math helpers (mirror src/nanogs/splat-utils.ts) ==========

static constexpr double LOG2PI = 1.8378770664093453; // log(2*pi)
static constexpr double TWO_PI_SQRT_CUBE = 8.862269254527580; // (2pi)^1.5
static constexpr double PI = 3.14159265358979323846;

// mulberry32 - deterministic PRNG (mirrors cost.ts mulberry32).
struct Mulberry32 {
    uint32_t s;
    explicit Mulberry32(uint32_t seed) : s(seed) {}
    double next() {
        s += 0x6D2B79F5u;
        uint32_t t = s;
        t = (t ^ (t >> 15)) * (t | 1u);
        t = t ^ (t + ((t ^ (t >> 7)) * (t | 61u)));
        return ((t ^ (t >> 14)) & 0xFFFFFFFFu) / 4294967296.0;
    }
};

// Standard normal via Box-Muller (mirrors cost.ts randn).
static double randn(Mulberry32& rng) {
    double u = 0, v = 0;
    while (u == 0) u = rng.next();
    while (v == 0) v = rng.next();
    return std::sqrt(-2.0 * std::log(u)) * std::cos(2.0 * PI * v);
}

// Quaternion (w,x,y,z) -> 3x3 rotation matrix, row-major (mirrors
// quatToRotmatBatch for a single quat).
static inline void quatToRotmat(const float* q, double R[9]) {
    const double w = q[0], x = q[1], y = q[2], z = q[3];
    const double ww = w * w, xx = x * x, yy = y * y, zz = z * z;
    const double wx = w * x, wy = w * y, wz = w * z;
    const double xy = x * y, xz = x * z, yz = y * z;
    R[0] = 1 - 2 * (yy + zz);
    R[1] = 2 * (xy - wz);
    R[2] = 2 * (xz + wy);
    R[3] = 2 * (xy + wz);
    R[4] = 1 - 2 * (xx + zz);
    R[5] = 2 * (yz - wx);
    R[6] = 2 * (xz - wy);
    R[7] = 2 * (yz + wx);
    R[8] = 1 - 2 * (xx + yy);
}

// Rotation matrix -> quaternion (w,x,y,z), Shepperd's method, then normalize
// (mirrors rotmatToQuatBatch + quatNormalize for a single quat).
static inline void rotmatToQuat(const double R[9], float q[4]) {
    const double m00 = R[0], m11 = R[4], m22 = R[8];
    const double m01 = R[1], m02 = R[2];
    const double m10 = R[3], m12 = R[5];
    const double m20 = R[6], m21 = R[7];
    const double tr = m00 + m11 + m22;
    double w, x, y, z;
    if (tr > 0) {
        const double S = std::sqrt(tr + 1.0) * 2.0;
        w = 0.25 * S;
        x = (m21 - m12) / S;
        y = (m02 - m20) / S;
        z = (m10 - m01) / S;
    } else if (m00 > m11 && m00 > m22) {
        const double S = std::sqrt(1.0 + m00 - m11 - m22) * 2.0;
        w = (m21 - m12) / S;
        x = 0.25 * S;
        y = (m01 + m10) / S;
        z = (m02 + m20) / S;
    } else if (m11 > m22) {
        const double S = std::sqrt(1.0 + m11 - m00 - m22) * 2.0;
        w = (m02 - m20) / S;
        x = (m01 + m10) / S;
        y = 0.25 * S;
        z = (m12 + m21) / S;
    } else {
        const double S = std::sqrt(1.0 + m22 - m00 - m11) * 2.0;
        w = (m10 - m01) / S;
        x = (m02 + m20) / S;
        y = (m12 + m21) / S;
        z = 0.25 * S;
    }
    double n = std::sqrt(w * w + x * x + y * y + z * z);
    if (n < 1e-12) n = 1e-12;
    const double inv = 1.0 / n;
    q[0] = (float)(w * inv);
    q[1] = (float)(x * inv);
    q[2] = (float)(y * inv);
    q[3] = (float)(z * inv);
}

// Symmetric 3x3 eigendecomposition via cyclic Jacobi (mirrors merge.ts
// symEig3). Returns eigenvalues ASCENDING and eigenvectors as row-major 3x3
// where COLUMN c is the eigenvector for evals[c].
static inline void symEig3(double a00, double a01, double a02,
                           double a11, double a12, double a22,
                           double evals[3], double evecs[9]) {
    double m00 = a00, m01 = a01, m02 = a02;
    double m11 = a11, m12 = a12, m22 = a22;
    double V[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};

    auto applyRotation = [&](int p, int q) {
        const double apq = p == 0 && q == 1 ? m01 : (p == 0 && q == 2 ? m02 : m12);
        if (std::fabs(apq) < 1e-18) return;
        const double app = p == 0 ? m00 : m11;
        const double aqq = q == 1 ? m11 : m22;
        const double tau = (aqq - app) / (2 * apq);
        const double t = tau >= 0 ? 1 / (tau + std::sqrt(1 + tau * tau))
                                  : -1 / (-tau + std::sqrt(1 + tau * tau));
        const double c = 1 / std::sqrt(1 + t * t);
        const double s = t * c;

        if (p == 0 && q == 1) {
            m00 = app - t * apq;
            m11 = aqq + t * apq;
            m01 = 0;
            const double r2p = m02, r2q = m12;
            m02 = c * r2p - s * r2q;
            m12 = s * r2p + c * r2q;
        } else if (p == 0 && q == 2) {
            m00 = app - t * apq;
            m22 = aqq + t * apq;
            m02 = 0;
            const double r1p = m01, r1q = m12;
            m01 = c * r1p - s * r1q;
            m12 = s * r1p + c * r1q;
        } else {
            m11 = app - t * apq;
            m22 = aqq + t * apq;
            m12 = 0;
            const double r0p = m01, r0q = m02;
            m01 = c * r0p - s * r0q;
            m02 = s * r0p + c * r0q;
        }

        for (int r = 0; r < 3; ++r) {
            const double vrp = V[r * 3 + p];
            const double vrq = V[r * 3 + q];
            V[r * 3 + p] = c * vrp - s * vrq;
            V[r * 3 + q] = s * vrp + c * vrq;
        }
    };

    for (int sweep = 0; sweep < 40; ++sweep) {
        const double off = std::fabs(m01) + std::fabs(m02) + std::fabs(m12);
        if (off < 1e-15) break;
        applyRotation(0, 1);
        applyRotation(0, 2);
        applyRotation(1, 2);
    }

    double evs[3] = {m00, m11, m22};
    int idx[3] = {0, 1, 2};
    if (evs[idx[0]] > evs[idx[1]]) std::swap(idx[0], idx[1]);
    if (evs[idx[1]] > evs[idx[2]]) std::swap(idx[1], idx[2]);
    if (evs[idx[0]] > evs[idx[1]]) std::swap(idx[0], idx[1]);
    evals[0] = evs[idx[0]];
    evals[1] = evs[idx[1]];
    evals[2] = evs[idx[2]];
    for (int c = 0; c < 3; ++c) {
        const int src = idx[c];
        for (int r = 0; r < 3; ++r) evecs[r * 3 + c] = V[r * 3 + src];
    }
}

// ========== KD-tree KNN (mirror src/nanogs/knn.ts) ==========

struct KdTree {
    std::vector<int32_t> idxArr;
    std::vector<int8_t> axisArr;
    std::vector<int32_t> leftArr;
    std::vector<int32_t> rightArr;
    int32_t count = 0;
};

static int32_t buildKdRec(const float* means, std::vector<int32_t>& buf,
                          int32_t lo, int32_t hi, int depth, KdTree& tree) {
    if (lo >= hi) return -1;
    const int axis = depth % 3;
    const int32_t mid = (lo + hi) >> 1;
    std::nth_element(buf.begin() + lo, buf.begin() + mid, buf.begin() + hi,
                     [&](int a, int b) { return means[a * 3 + axis] < means[b * 3 + axis]; });
    const int32_t nodeId = tree.count++;
    tree.idxArr[nodeId] = buf[mid];
    tree.axisArr[nodeId] = (int8_t)axis;
    tree.leftArr[nodeId] = buildKdRec(means, buf, lo, mid, depth + 1, tree);
    tree.rightArr[nodeId] = buildKdRec(means, buf, mid + 1, hi, depth + 1, tree);
    return nodeId;
}

static void buildKdTree(const float* means, int32_t N, KdTree& tree) {
    std::vector<int32_t> buf(N);
    for (int32_t i = 0; i < N; ++i) buf[i] = i;
    tree.idxArr.assign(N, 0);
    tree.axisArr.assign(N, 0);
    tree.leftArr.assign(N, -1);
    tree.rightArr.assign(N, -1);
    tree.count = 0;
    buildKdRec(means, buf, 0, N, 0, tree);
}

// k-NN query: kk nearest point indices (ascending by squared distance).
static void knnQuery(const float* means, const KdTree& tree,
                     double qx, double qy, double qz, int32_t kk,
                     std::vector<int32_t>& out) {
    // max-heap: root = farthest of the current kk nearest
    // store pair (dist, idx) - use two parallel arrays
    std::vector<int32_t> heapIdx;
    std::vector<double> heapDist;
    heapIdx.reserve(kk);
    heapDist.reserve(kk);

    auto siftUp = [&](int32_t i) {
        while (i > 0) {
            const int32_t parent = (i - 1) >> 1;
            if (heapDist[parent] < heapDist[i]) {
                std::swap(heapDist[parent], heapDist[i]);
                std::swap(heapIdx[parent], heapIdx[i]);
                i = parent;
            } else break;
        }
    };
    auto siftDown = [&](int32_t i) {
        const int32_t size = (int32_t)heapDist.size();
        while (true) {
            const int32_t l = 2 * i + 1, r = 2 * i + 2;
            int32_t largest = i;
            if (l < size && heapDist[l] > heapDist[largest]) largest = l;
            if (r < size && heapDist[r] > heapDist[largest]) largest = r;
            if (largest != i) {
                std::swap(heapDist[i], heapDist[largest]);
                std::swap(heapIdx[i], heapIdx[largest]);
                i = largest;
            } else break;
        }
    };
    auto pushHeap = [&](int32_t idx, double d) {
        const int32_t size = (int32_t)heapDist.size();
        if (size < kk) {
            heapDist.push_back(d);
            heapIdx.push_back(idx);
            siftUp(size);
        } else if (d < heapDist[0]) {
            heapDist[0] = d;
            heapIdx[0] = idx;
            siftDown(0);
        }
    };

    // Iterative DFS, plane-distance pruning (mirror knn.ts knnQuery).
    std::vector<int32_t> stack;
    stack.push_back(0);
    while (!stack.empty()) {
        const int32_t node = stack.back();
        stack.pop_back();
        if (node < 0) continue;
        const int32_t axis = tree.axisArr[node];
        const int32_t pIdx = tree.idxArr[node];
        const double px = means[pIdx * 3], py = means[pIdx * 3 + 1], pz = means[pIdx * 3 + 2];
        const double dx = qx - px, dy = qy - py, dz = qz - pz;
        pushHeap(pIdx, dx * dx + dy * dy + dz * dz);

        const double diff = axis == 0 ? qx - px : (axis == 1 ? qy - py : qz - pz);
        const double planeDist2 = diff * diff;
        const int32_t left = tree.leftArr[node];
        const int32_t right = tree.rightArr[node];
        const int32_t near = diff <= 0 ? left : right;
        const int32_t far = diff <= 0 ? right : left;
        const int32_t size = (int32_t)heapDist.size();
        if (far >= 0 && (size < kk || planeDist2 < heapDist[0])) stack.push_back(far);
        if (near >= 0) stack.push_back(near);
    }

    // Extract ascending (pop max repeatedly) into out (size == kk after full).
    out.resize(heapDist.size());
    int32_t size = (int32_t)heapDist.size();
    for (int32_t i = size - 1; i >= 0; --i) {
        out[i] = heapIdx[0];
        heapIdx[0] = heapIdx[size - 1];
        heapDist[0] = heapDist[size - 1];
        --size;
        if (size > 0) siftDown(0);
    }
}

// knnIndices: for each point, k nearest EXCLUDING itself. Mirrors
// knnIndices(means, N, k). out must be sized N*k.
static void knnIndices(const float* means, int32_t N, int32_t k,
                       std::vector<int32_t>& out) {
    const int32_t kk = std::min(k + 1, N);
    KdTree tree;
    buildKdTree(means, N, tree);
    out.resize(N * k);
    std::vector<int32_t> nb;
    for (int32_t q = 0; q < N; ++q) {
        knnQuery(means, tree, means[q * 3], means[q * 3 + 1], means[q * 3 + 2], kk, nb);
        int32_t written = 0;
        for (size_t i = 0; i < nb.size() && written < k; ++i) {
            if (nb[i] != q) out[q * k + written++] = nb[i];
        }
        while (written < k) out[q * k + written++] = q;
    }
}

// ========== SplatSet + edges + cost + greedy + merge ==========

struct SplatSet {
    std::vector<float> mu; // N*3
    std::vector<float> sc; // N*3
    std::vector<float> q;  // N*4
    std::vector<float> op; // N
    std::vector<float> sh; // N*C
    int32_t N = 0;
    int32_t C = 0;

    int32_t totalFloats() const {
        return N * (3 + 3 + 4 + 1 + C);
    }
};

// Per-splat precomputed data for cost/merge, rebuilt once per merge pass.
// Computing these inside pairCost would redo ~8 transcendental ops per edge;
// hoisting them here turns that into a single O(N) pass per pass.
struct SplatPre {
    std::vector<float> R;       // N*9 rotation matrix (row-major)
    std::vector<float> v;       // N*3 s^2 + eps (cost space)
    std::vector<float> invdiag; // N*3 1/v
    std::vector<float> logdet;  // N   log(sqrt?) sum log(v)
    std::vector<float> std;     // N*3 sqrt(v)
    std::vector<float> wmix;    // N   TWO_PI_SQRT_CUBE*op*s0*s1*s2 + 1e-12
};

static SplatPre buildSplatPre(const SplatSet& s, double epsCov) {
    const int32_t N = s.N;
    SplatPre pre;
    pre.R.resize(N * 9);
    pre.v.resize(N * 3);
    pre.invdiag.resize(N * 3);
    pre.logdet.resize(N);
    pre.std.resize(N * 3);
    pre.wmix.resize(N);
    const float* sc = s.sc.data();
    const float* q = s.q.data();
    const float* op = s.op.data();
    for (int32_t i = 0; i < N; ++i) {
        double R[9];
        quatToRotmat(&q[i * 4], R);
        for (int k = 0; k < 9; ++k) pre.R[i * 9 + k] = (float)R[k];

        const double s0 = sc[i * 3], s1 = sc[i * 3 + 1], s2 = sc[i * 3 + 2];
        const double v0 = s0 * s0 + epsCov;
        const double v1 = s1 * s1 + epsCov;
        const double v2 = s2 * s2 + epsCov;
        const double e0 = v0 < 1e-30 ? 1e-30 : v0;
        const double e1 = v1 < 1e-30 ? 1e-30 : v1;
        const double e2 = v2 < 1e-30 ? 1e-30 : v2;
        pre.v[i * 3] = (float)e0;
        pre.v[i * 3 + 1] = (float)e1;
        pre.v[i * 3 + 2] = (float)e2;
        pre.invdiag[i * 3] = (float)(1.0 / e0);
        pre.invdiag[i * 3 + 1] = (float)(1.0 / e1);
        pre.invdiag[i * 3 + 2] = (float)(1.0 / e2);
        pre.logdet[i] = (float)(std::log(e0) + std::log(e1) + std::log(e2));
        pre.std[i * 3] = (float)(std::sqrt(v0 < 0 ? 0 : v0));
        pre.std[i * 3 + 1] = (float)(std::sqrt(v1 < 0 ? 0 : v1));
        pre.std[i * 3 + 2] = (float)(std::sqrt(v2 < 0 ? 0 : v2));
        pre.wmix[i] = (float)(TWO_PI_SQRT_CUBE * op[i] * (s0 * s1 * s2) + 1e-12);
    }
    return pre;
}

// Undirected unique edges from directed KNN neighbors (mirror
// knnUndirectedEdges): edges stored as flat (u,v) pairs, u<v.
static void undirectedEdges(const std::vector<int32_t>& nbr, int32_t N, int32_t k,
                            std::vector<int32_t>& edges) {
    std::vector<uint64_t> keys;
    keys.reserve((size_t)N * k);
    for (int32_t i = 0; i < N; ++i) {
        for (int32_t j = 0; j < k; ++j) {
            const int32_t nb = nbr[i * k + j];
            if (nb == i) continue;
            const int32_t u = i < nb ? i : nb;
            const int32_t v = i < nb ? nb : i;
            keys.push_back((uint64_t)(uint32_t)u * (uint32_t)N + (uint32_t)v);
        }
    }
    std::sort(keys.begin(), keys.end());
    keys.erase(std::unique(keys.begin(), keys.end()), keys.end());
    edges.clear();
    edges.reserve(keys.size() * 2);
    for (uint64_t key : keys) {
        const int32_t u = (int32_t)(key / (uint32_t)N);
        const int32_t v = (int32_t)(key % (uint32_t)N);
        edges.push_back(u);
        edges.push_back(v);
    }
}

// logaddexp (mirror cost.ts logaddexp).
static inline double logaddexp(double a, double b) {
    if (a == -INFINITY) return b;
    if (b == -INFINITY) return a;
    const double m = a > b ? a : b;
    return m + std::log(std::exp(a - m) + std::exp(b - m));
}

// Full symmetric merge cost for ONE candidate pair (mirror cost.ts
// fullCostPairs for B=1). Z is the shared MC sample set (nMc x 3), stored as
// float to match the TS Float32Array Z bit-for-bit.
static double pairCost(const SplatSet& s, const SplatPre& pre, int32_t u, int32_t v,
                       const float* Z, int32_t nMc,
                       double lamGeo, double lamSh, double epsCov) {
    const int32_t C = s.C;
    const float* mu = s.mu.data();
    const float* sh = s.sh.data();

    const double mu_iu = mu[u * 3], mu_i1 = mu[u * 3 + 1], mu_i2 = mu[u * 3 + 2];
    const double mu_ju = mu[v * 3], mu_j1 = mu[v * 3 + 1], mu_j2 = mu[v * 3 + 2];

    const double vi0 = pre.v[u * 3], vi1 = pre.v[u * 3 + 1], vi2 = pre.v[u * 3 + 2];
    const double vj0 = pre.v[v * 3], vj1 = pre.v[v * 3 + 1], vj2 = pre.v[v * 3 + 2];
    const double invdiag_i0 = pre.invdiag[u * 3], invdiag_i1 = pre.invdiag[u * 3 + 1], invdiag_i2 = pre.invdiag[u * 3 + 2];
    const double invdiag_j0 = pre.invdiag[v * 3], invdiag_j1 = pre.invdiag[v * 3 + 1], invdiag_j2 = pre.invdiag[v * 3 + 2];
    const double logdet_i = pre.logdet[u];
    const double logdet_j = pre.logdet[v];
    const double std_i0 = pre.std[u * 3], std_i1 = pre.std[u * 3 + 1], std_i2 = pre.std[u * 3 + 2];
    const double std_j0 = pre.std[v * 3], std_j1 = pre.std[v * 3 + 1], std_j2 = pre.std[v * 3 + 2];

    // mixture weights (precomputed)
    const double wi = pre.wmix[u];
    const double wj = pre.wmix[v];
    const double W = wi + wj;
    const double Wsafe = W > 0 ? W : 1.0;
    double p = wi / Wsafe;
    if (p < 1e-12) p = 1e-12;
    if (p > 1 - 1e-12) p = 1 - 1e-12;
    const double logPi = std::log(p);
    const double logPj = std::log(1.0 - p);

    // moment-matched merge mean
    const double m0 = p * mu_iu + (1 - p) * mu_ju;
    const double m1 = p * mu_i1 + (1 - p) * mu_j1;
    const double m2 = p * mu_i2 + (1 - p) * mu_j2;

    const double di0 = mu_iu - m0, di1 = mu_i1 - m1, di2 = mu_i2 - m2;
    const double dj0 = mu_ju - m0, dj1 = mu_j1 - m1, dj2 = mu_j2 - m2;

    const float* R_i = &pre.R[u * 9];
    const float* R_j = &pre.R[v * 9];

    // Sigma = R diag(v) R^T (row-major)
    const double SigI00 = R_i[0] * R_i[0] * vi0 + R_i[1] * R_i[1] * vi1 + R_i[2] * R_i[2] * vi2;
    const double SigI01 = R_i[0] * R_i[3] * vi0 + R_i[1] * R_i[4] * vi1 + R_i[2] * R_i[5] * vi2;
    const double SigI02 = R_i[0] * R_i[6] * vi0 + R_i[1] * R_i[7] * vi1 + R_i[2] * R_i[8] * vi2;
    const double SigI11 = R_i[3] * R_i[3] * vi0 + R_i[4] * R_i[4] * vi1 + R_i[5] * R_i[5] * vi2;
    const double SigI12 = R_i[3] * R_i[6] * vi0 + R_i[4] * R_i[7] * vi1 + R_i[5] * R_i[8] * vi2;
    const double SigI22 = R_i[6] * R_i[6] * vi0 + R_i[7] * R_i[7] * vi1 + R_i[8] * R_i[8] * vi2;

    const double SigJ00 = R_j[0] * R_j[0] * vj0 + R_j[1] * R_j[1] * vj1 + R_j[2] * R_j[2] * vj2;
    const double SigJ01 = R_j[0] * R_j[3] * vj0 + R_j[1] * R_j[4] * vj1 + R_j[2] * R_j[5] * vj2;
    const double SigJ02 = R_j[0] * R_j[6] * vj0 + R_j[1] * R_j[7] * vj1 + R_j[2] * R_j[8] * vj2;
    const double SigJ11 = R_j[3] * R_j[3] * vj0 + R_j[4] * R_j[4] * vj1 + R_j[5] * R_j[5] * vj2;
    const double SigJ12 = R_j[3] * R_j[6] * vj0 + R_j[4] * R_j[7] * vj1 + R_j[5] * R_j[8] * vj2;
    const double SigJ22 = R_j[6] * R_j[6] * vj0 + R_j[7] * R_j[7] * vj1 + R_j[8] * R_j[8] * vj2;

    // outer products
    const double odi00 = di0 * di0, odi01 = di0 * di1, odi02 = di0 * di2;
    const double odi11 = di1 * di1, odi12 = di1 * di2, odi22 = di2 * di2;
    const double odj00 = dj0 * dj0, odj01 = dj0 * dj1, odj02 = dj0 * dj2;
    const double odj11 = dj1 * dj1, odj12 = dj1 * dj2, odj22 = dj2 * dj2;

    const double qq = 1 - p;
    double M00 = p * (SigI00 + odi00) + qq * (SigJ00 + odj00);
    double M01 = p * (SigI01 + odi01) + qq * (SigJ01 + odj01);
    double M02 = p * (SigI02 + odi02) + qq * (SigJ02 + odj02);
    double M11 = p * (SigI11 + odi11) + qq * (SigJ11 + odj11);
    double M12 = p * (SigI12 + odi12) + qq * (SigJ12 + odj12);
    double M22 = p * (SigI22 + odi22) + qq * (SigJ22 + odj22);
    // symmetrize (mirror cost.ts 0.5*(M + M^T))
    M01 = 0.5 * (M01 + p * (SigI01 + odi01) + qq * (SigJ01 + odj01));
    M02 = 0.5 * (M02 + p * (SigI02 + odi02) + qq * (SigJ02 + odj02));
    M12 = 0.5 * (M12 + p * (SigI12 + odi12) + qq * (SigJ12 + odj12));
    M00 += epsCov;
    M11 += epsCov;
    M22 += epsCov;

    const double detM = M00 * (M11 * M22 - M12 * M12) -
                        M01 * (M01 * M22 - M12 * M02) +
                        M02 * (M01 * M12 - M11 * M02);
    const double logdetM = std::log(std::fabs(detM) < 1e-300 ? 1e-300 : std::fabs(detM));

    // MC samples x_i, x_j for THIS pair
    double Ei = 0, Ej = 0;
    for (int32_t sm = 0; sm < nMc; ++sm) {
        const double zk0 = Z[sm * 3], zk1 = Z[sm * 3 + 1], zk2 = Z[sm * 3 + 2];
        const double zi0 = zk0 * std_i0, zi1 = zk1 * std_i1, zi2 = zk2 * std_i2;
        const double zj0 = zk0 * std_j0, zj1 = zk1 * std_j1, zj2 = zk2 * std_j2;
        // x_i[c] = mu_i[c] + sum_k zi[k] * R_i[c,k]
        const double xi0 = mu_iu + (zi0 * R_i[0] + zi1 * R_i[1] + zi2 * R_i[2]);
        const double xi1 = mu_i1 + (zi0 * R_i[3] + zi1 * R_i[4] + zi2 * R_i[5]);
        const double xi2 = mu_i2 + (zi0 * R_i[6] + zi1 * R_i[7] + zi2 * R_i[8]);
        const double xj0 = mu_ju + (zj0 * R_j[0] + zj1 * R_j[1] + zj2 * R_j[2]);
        const double xj1 = mu_j1 + (zj0 * R_j[3] + zj1 * R_j[4] + zj2 * R_j[5]);
        const double xj2 = mu_j2 + (zj0 * R_j[6] + zj1 * R_j[7] + zj2 * R_j[8]);

        // logpdfs: y = d @ R (row-major), quad = sum y_c^2 * invdiag_c
        // logN(xi | mu_i, Sig_i)
        const double di0a = xi0 - mu_iu, di1a = xi1 - mu_i1, di2a = xi2 - mu_i2;
        const double yi0 = di0a * R_i[0] + di1a * R_i[3] + di2a * R_i[6];
        const double yi1 = di0a * R_i[1] + di1a * R_i[4] + di2a * R_i[7];
        const double yi2 = di0a * R_i[2] + di1a * R_i[5] + di2a * R_i[8];
        const double logNiOnI = -0.5 * (3 * LOG2PI + logdet_i + yi0 * yi0 * invdiag_i0 + yi1 * yi1 * invdiag_i1 + yi2 * yi2 * invdiag_i2);
        // logN(xi | mu_j, Sig_j)
        const double dj0a = xi0 - mu_ju, dj1a = xi1 - mu_j1, dj2a = xi2 - mu_j2;
        const double yj0 = dj0a * R_j[0] + dj1a * R_j[3] + dj2a * R_j[6];
        const double yj1 = dj0a * R_j[1] + dj1a * R_j[4] + dj2a * R_j[7];
        const double yj2 = dj0a * R_j[2] + dj1a * R_j[5] + dj2a * R_j[8];
        const double logNjOnI = -0.5 * (3 * LOG2PI + logdet_j + yj0 * yj0 * invdiag_j0 + yj1 * yj1 * invdiag_j1 + yj2 * yj2 * invdiag_j2);
        // logN(xj | mu_i, Sig_i)
        const double ei0 = xj0 - mu_iu, ei1 = xj1 - mu_i1, ei2 = xj2 - mu_i2;
        const double zi0b = ei0 * R_i[0] + ei1 * R_i[3] + ei2 * R_i[6];
        const double zi1b = ei0 * R_i[1] + ei1 * R_i[4] + ei2 * R_i[7];
        const double zi2b = ei0 * R_i[2] + ei1 * R_i[5] + ei2 * R_i[8];
        const double logNiOnJ = -0.5 * (3 * LOG2PI + logdet_i + zi0b * zi0b * invdiag_i0 + zi1b * zi1b * invdiag_i1 + zi2b * zi2b * invdiag_i2);
        // logN(xj | mu_j, Sig_j)
        const double ej0 = xj0 - mu_ju, ej1 = xj1 - mu_j1, ej2 = xj2 - mu_j2;
        const double zj0b = ej0 * R_j[0] + ej1 * R_j[3] + ej2 * R_j[6];
        const double zj1b = ej0 * R_j[1] + ej1 * R_j[4] + ej2 * R_j[7];
        const double zj2b = ej0 * R_j[2] + ej1 * R_j[5] + ej2 * R_j[8];
        const double logNjOnJ = -0.5 * (3 * LOG2PI + logdet_j + zj0b * zj0b * invdiag_j0 + zj1b * zj1b * invdiag_j1 + zj2b * zj2b * invdiag_j2);

        Ei += logaddexp(logPi + logNiOnI, logPj + logNjOnI);
        Ej += logaddexp(logPi + logNiOnJ, logPj + logNjOnJ);
    }
    Ei /= nMc;
    Ej /= nMc;
    const double E_p_logp = p * Ei + (1 - p) * Ej;
    const double E_p_neglogq = 0.5 * (3 * LOG2PI + logdetM + 3);
    const double geo = E_p_logp + E_p_neglogq;

    double c_sh = 0;
    if (C > 0) {
        for (int32_t c = 0; c < C; ++c) {
            const double d = (double)sh[u * C + c] - sh[v * C + c];
            c_sh += d * d;
        }
    }
    return lamGeo * geo + lamSh * c_sh;
}

// Greedy disjoint pairs from edges sorted by cost ascending (mirror
// greedyPairsFromEdges). Pairs appended to `pairs` as flat (u,v).
static void greedyPairs(const std::vector<int32_t>& edges, const std::vector<float>& w,
                        int32_t N, int32_t P, std::vector<int32_t>& pairs) {
    const size_t M = edges.size() / 2;
    if (M == 0) return;
    std::vector<int32_t> order(M);
    std::iota(order.begin(), order.end(), 0);
    std::sort(order.begin(), order.end(),
              [&](int a, int b) { return w[a] < w[b]; });

    std::vector<uint8_t> used(N, 0);
    pairs.clear();
    pairs.reserve(P * 2);
    for (size_t oi = 0; oi < M; ++oi) {
        const int32_t ei = order[oi];
        if (!std::isfinite(w[ei])) continue;
        const int32_t u = edges[ei * 2];
        const int32_t v = edges[ei * 2 + 1];
        if (used[u] || used[v]) continue;
        used[u] = 1;
        used[v] = 1;
        pairs.push_back(u);
        pairs.push_back(v);
        if ((int32_t)(pairs.size() / 2) >= P) break;
    }
}

// Moment-matched merge of ONE pair (mirror merge.ts momentMatching, B=1).
static void mergePair(const SplatSet& s, const SplatPre& pre, int32_t u, int32_t v,
                      float outMu[3], float outSc[3], float outQ[4], float& outOp) {
    const float* mu = s.mu.data();
    const float* sc = s.sc.data();
    const float* op = s.op.data();

    const double s_i0 = sc[u * 3], s_i1 = sc[u * 3 + 1], s_i2 = sc[u * 3 + 2];
    const double s_j0 = sc[v * 3], s_j1 = sc[v * 3 + 1], s_j2 = sc[v * 3 + 2];

    // Sigma_i = R_i diag(s_i^2) R_i^T (mirror sigmaFromScaleQuatBatch); R from
    // the shared per-splat precompute.
    const float* R_i = &pre.R[u * 9];
    const float* R_j = &pre.R[v * 9];
    double SigI[9], SigJ[9];
    {
        const double v0 = s_i0 * s_i0, v1 = s_i1 * s_i1, v2 = s_i2 * s_i2;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                SigI[r * 3 + c] = R_i[r * 3 + 0] * R_i[c * 3 + 0] * v0 +
                                  R_i[r * 3 + 1] * R_i[c * 3 + 1] * v1 +
                                  R_i[r * 3 + 2] * R_i[c * 3 + 2] * v2;
    }
    {
        const double v0 = s_j0 * s_j0, v1 = s_j1 * s_j1, v2 = s_j2 * s_j2;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                SigJ[r * 3 + c] = R_j[r * 3 + 0] * R_j[c * 3 + 0] * v0 +
                                  R_j[r * 3 + 1] * R_j[c * 3 + 1] * v1 +
                                  R_j[r * 3 + 2] * R_j[c * 3 + 2] * v2;
    }

    const double wi = pre.wmix[u];
    const double wj = pre.wmix[v];
    double W = wi + wj;
    if (W < 1e-12) W = 1e-12;
    const double invW = 1.0 / W;

    const double m0 = (wi * mu[u * 3] + wj * mu[v * 3]) * invW;
    const double m1 = (wi * mu[u * 3 + 1] + wj * mu[v * 3 + 1]) * invW;
    const double m2 = (wi * mu[u * 3 + 2] + wj * mu[v * 3 + 2]) * invW;
    outMu[0] = (float)m0;
    outMu[1] = (float)m1;
    outMu[2] = (float)m2;

    const double di0 = mu[u * 3] - m0, di1 = mu[u * 3 + 1] - m1, di2 = mu[u * 3 + 2] - m2;
    const double dj0 = mu[v * 3] - m0, dj1 = mu[v * 3 + 1] - m1, dj2 = mu[v * 3 + 2] - m2;

    // Sigma = (wi*(Sig_i + odi) + wj*(Sig_j + odj)) * invW  (+1e-8*I)
    const double S00 = (wi * (SigI[0] + di0 * di0) + wj * (SigJ[0] + dj0 * dj0)) * invW;
    double S01 = (wi * (SigI[1] + di0 * di1) + wj * (SigJ[1] + dj0 * dj1)) * invW;
    double S02 = (wi * (SigI[2] + di0 * di2) + wj * (SigJ[2] + dj0 * dj2)) * invW;
    const double S11 = (wi * (SigI[4] + di1 * di1) + wj * (SigJ[4] + dj1 * dj1)) * invW;
    double S12 = (wi * (SigI[5] + di1 * di2) + wj * (SigJ[5] + dj1 * dj2)) * invW;
    const double S22 = (wi * (SigI[8] + di2 * di2) + wj * (SigJ[8] + dj2 * dj2)) * invW;
    S01 = 0.5 * (S01 + (wi * (SigI[3] + di1 * di0) + wj * (SigJ[3] + dj1 * dj0)) * invW);
    S02 = 0.5 * (S02 + (wi * (SigI[6] + di2 * di0) + wj * (SigJ[6] + dj2 * dj0)) * invW);
    S12 = 0.5 * (S12 + (wi * (SigI[7] + di2 * di1) + wj * (SigJ[7] + dj2 * dj1)) * invW);
    const double M00 = S00 + 1e-8;
    const double M11 = S11 + 1e-8;
    const double M22 = S22 + 1e-8;

    double evals[3], evecs[9];
    symEig3(M00, S01, S02, M11, S12, M22, evals, evecs);
    // numpy path: max(evals,1e-18), descending; symEig3 gives ascending
    const double e0 = std::max(evals[2], 1e-18);
    const double e1 = std::max(evals[1], 1e-18);
    const double e2 = std::max(evals[0], 1e-18);
    // descending eigenvectors: col 0 <- evals[2], col 1 <- evals[1], col 2 <- evals[0]
    double Vdesc[9];
    for (int r = 0; r < 3; ++r) {
        Vdesc[r * 3 + 0] = evecs[r * 3 + 2];
        Vdesc[r * 3 + 1] = evecs[r * 3 + 1];
        Vdesc[r * 3 + 2] = evecs[r * 3 + 0];
    }
    // enforce right-handed: if det < 0 flip column 2
    const double detV = Vdesc[0] * (Vdesc[4] * Vdesc[8] - Vdesc[5] * Vdesc[7]) -
                        Vdesc[1] * (Vdesc[3] * Vdesc[8] - Vdesc[5] * Vdesc[6]) +
                        Vdesc[2] * (Vdesc[3] * Vdesc[7] - Vdesc[4] * Vdesc[6]);
    if (detV < 0) {
        Vdesc[2] = -Vdesc[2];
        Vdesc[5] = -Vdesc[5];
        Vdesc[8] = -Vdesc[8];
    }
    outSc[0] = (float)std::sqrt(e0);
    outSc[1] = (float)std::sqrt(e1);
    outSc[2] = (float)std::sqrt(e2);
    rotmatToQuat(Vdesc, outQ);

    outOp = op[u] + op[v] - op[u] * op[v];
}

// mergePairs: unmerged splats kept + merged appended (mirror merge.ts
// mergePairs). pairs is flat (M*2) with indices into the current set.
static SplatSet mergePairs(const SplatSet& s, const SplatPre& pre,
                           const std::vector<int32_t>& pairs) {
    const int32_t N = s.N;
    const int32_t M = (int32_t)(pairs.size() / 2);
    const int32_t C = s.C;
    SplatSet out;
    out.C = C;
    if (M == 0) return out; // caller treats empty specially

    const int32_t newN = N - 2 * M + M; // keepCount + M
    out.N = newN;
    out.mu.resize(newN * 3);
    out.sc.resize(newN * 3);
    out.q.resize(newN * 4);
    out.op.resize(newN);
    if (C > 0) out.sh.resize(newN * C);

    std::vector<uint8_t> used(N, 0);
    for (int32_t p = 0; p < M; ++p) {
        used[pairs[p * 2]] = 1;
        used[pairs[p * 2 + 1]] = 1;
    }

    int32_t o = 0;
    for (int32_t i = 0; i < N; ++i) {
        if (used[i]) continue;
        std::memcpy(&out.mu[o * 3], &s.mu[i * 3], 3 * sizeof(float));
        std::memcpy(&out.sc[o * 3], &s.sc[i * 3], 3 * sizeof(float));
        std::memcpy(&out.q[o * 4], &s.q[i * 4], 4 * sizeof(float));
        out.op[o] = s.op[i];
        if (C > 0) std::memcpy(&out.sh[o * C], &s.sh[i * C], C * sizeof(float));
        ++o;
    }
    // append merged
    for (int32_t p = 0; p < M; ++p) {
        const int32_t u = pairs[p * 2];
        const int32_t v = pairs[p * 2 + 1];
        float outMu[3], outSc[3], outQ[4], outOp;
        mergePair(s, pre, u, v, outMu, outSc, outQ, outOp);
        out.mu[o * 3] = outMu[0];
        out.mu[o * 3 + 1] = outMu[1];
        out.mu[o * 3 + 2] = outMu[2];
        out.sc[o * 3] = outSc[0];
        out.sc[o * 3 + 1] = outSc[1];
        out.sc[o * 3 + 2] = outSc[2];
        out.q[o * 4] = outQ[0];
        out.q[o * 4 + 1] = outQ[1];
        out.q[o * 4 + 2] = outQ[2];
        out.q[o * 4 + 3] = outQ[3];
        out.op[o] = outOp;
        if (C > 0) {
            const double wi = pre.wmix[u];
            const double wj = pre.wmix[v];
            double W = wi + wj;
            if (W < 1e-12) W = 1e-12;
            const double invW = 1.0 / W;
            for (int32_t c = 0; c < C; ++c) {
                out.sh[o * C + c] = (float)((wi * s.sh[u * C + c] + wj * s.sh[v * C + c]) * invW);
            }
        }
        ++o;
    }
    return out;
}

// ========== Progressive multi-ratio simplification (mirror simplifyProgressive) ==========

struct ProgressiveResult {
    std::vector<int32_t> counts;   // m
    SplatSet merged;               // concatenated snapshots in ratiosDesc order
};

static ProgressiveResult simplifyNodeProgressiveCore(const SplatSet& attrs,
                                                     const std::vector<float>& ratios,
                                                     int32_t k, double mergeCap,
                                                     double lamGeo, double lamSh,
                                                     int32_t nMc, uint32_t seed,
                                                     double epsCov) {
    const int32_t m = (int32_t)ratios.size();
    ProgressiveResult res;
    if (m == 0) return res;
    const int32_t N0 = attrs.N;

    std::vector<int32_t> targets(m);
    for (int32_t i = 0; i < m; ++i) {
        // double math: int32×float loses precision (55000.001f rounds to 55000f,
        // then ceil→55000 vs TS's ceil(55000.0000…)=55001). Match TS exactly.
        const int32_t t = (int32_t)std::ceil((double)N0 * (double)ratios[i]);
        targets[i] = t < 1 ? 1 : t;
    }

    // snapshot accumulator
    SplatSet snapAcc;
    snapAcc.C = attrs.C;
    snapAcc.N = 0;
    snapAcc.mu.reserve(N0 * 3);
    snapAcc.sc.reserve(N0 * 3);
    snapAcc.q.reserve(N0 * 4);
    snapAcc.op.reserve(N0);
    if (attrs.C > 0) snapAcc.sh.reserve(N0 * attrs.C);

    auto snapshot = [&](const SplatSet& work) {
        const int32_t N = work.N;
        const int32_t C = work.C;
        snapAcc.mu.insert(snapAcc.mu.end(), work.mu.begin(), work.mu.end());
        snapAcc.sc.insert(snapAcc.sc.end(), work.sc.begin(), work.sc.end());
        snapAcc.q.insert(snapAcc.q.end(), work.q.begin(), work.q.end());
        snapAcc.op.insert(snapAcc.op.end(), work.op.begin(), work.op.end());
        if (C > 0) snapAcc.sh.insert(snapAcc.sh.end(), work.sh.begin(), work.sh.end());
        snapAcc.N += N;
    };

    SplatSet work = attrs;
    const int32_t pCap = std::max(1, (int32_t)std::floor(mergeCap * N0));
    const int32_t coarsestTarget = targets[m - 1];
    int32_t nextIdx = 0;

    // shared MC samples (mirror cost.ts: one Z per call, Float32Array → float)
    std::vector<float> Z;
    if (nMc > 0) {
        Z.resize(nMc * 3);
        Mulberry32 rng(seed);
        for (int32_t i = 0; i < nMc * 3; ++i) Z[i] = (float)randn(rng);
    }

    auto fillRemaining = [&]() {
        while (nextIdx < m) {
            res.counts.push_back(work.N);
            snapshot(work);
            ++nextIdx;
        }
    };

    int32_t iter = 0;
    while (nextIdx < m) {
        const int32_t N = work.N;
        while (nextIdx < m && N <= targets[nextIdx]) {
            res.counts.push_back(N);
            snapshot(work);
            ++nextIdx;
        }
        if (nextIdx >= m) break;
        if (N <= coarsestTarget || N <= 1) {
            fillRemaining();
            break;
        }

        const int32_t kEff = std::min(std::max(1, k), std::max(1, N - 1));
        std::vector<int32_t> nbr;
        knnIndices(work.mu.data(), N, kEff, nbr);

        std::vector<int32_t> edges;
        undirectedEdges(nbr, N, kEff, edges);
        if (edges.empty()) {
            fillRemaining();
            break;
        }

        const size_t E = edges.size() / 2;
        // Rebuild the per-splat precompute once per pass (cost+merge share it).
        SplatPre pre = buildSplatPre(work, epsCov);
        std::vector<float> w(E);
        for (size_t e = 0; e < E; ++e) {
            w[e] = (float)pairCost(work, pre, edges[e * 2], edges[e * 2 + 1],
                                   Z.data(), nMc, lamGeo, lamSh, epsCov);
        }

        const int32_t nextTarget = targets[nextIdx];
        const int32_t mergesNeeded = std::max(1, N - nextTarget);
        const int32_t P = std::min(mergesNeeded, pCap);
        std::vector<int32_t> pairs;
        greedyPairs(edges, w, N, P, pairs);
        if (pairs.empty()) {
            fillRemaining();
            break;
        }

        work = mergePairs(work, pre, pairs);
        ++iter;
        if (iter > 10000) {
            fillRemaining();
            break;
        }
    }

    // clip opacity into [0,1] for every snapshot (mirror simplify.ts final clip)
    for (size_t i = 0; i < snapAcc.op.size(); ++i) {
        if (snapAcc.op[i] < 0) snapAcc.op[i] = 0;
        if (snapAcc.op[i] > 1) snapAcc.op[i] = 1;
    }
    res.merged = std::move(snapAcc);
    return res;
}

// ========== N-API binding ==========

Napi::Object InitNanogs(Napi::Env env, Napi::Object exports) {
    auto SimplifyNodeProgressive = [](const Napi::CallbackInfo& info) -> Napi::Value {
        Napi::Env e = info.Env();
        if (info.Length() < 7) {
            Napi::TypeError::New(e, "Expected (means, scales, quats, ops, sh, ratios, opts)")
                .ThrowAsJavaScriptException();
            return e.Undefined();
        }
        Napi::Float32Array means = info[0].As<Napi::Float32Array>();
        Napi::Float32Array scales = info[1].As<Napi::Float32Array>();
        Napi::Float32Array quats = info[2].As<Napi::Float32Array>();
        Napi::Float32Array ops = info[3].As<Napi::Float32Array>();
        Napi::Float32Array sh = info[4].As<Napi::Float32Array>();
        Napi::Float32Array ratios = info[5].As<Napi::Float32Array>();
        Napi::Object opts = info[6].As<Napi::Object>();

        const int32_t N = (int32_t)ops.ElementLength();
        const int32_t C = opts.Get("shCols").As<Napi::Number>().Int32Value();
        if (N <= 0) {
            Napi::TypeError::New(e, "Empty splat set").ThrowAsJavaScriptException();
            return e.Undefined();
        }
        const int32_t k = opts.Get("k").As<Napi::Number>().Int32Value();
        const double mergeCap = opts.Get("mergeCap").As<Napi::Number>().DoubleValue();
        const double lamGeo = opts.Get("lamGeo").As<Napi::Number>().DoubleValue();
        const double lamSh = opts.Get("lamSh").As<Napi::Number>().DoubleValue();
        const int32_t nMc = opts.Get("nMc").As<Napi::Number>().Int32Value();
        const uint32_t seed = opts.Get("seed").As<Napi::Number>().Uint32Value();
        const double epsCov = opts.Get("epsCov").As<Napi::Number>().DoubleValue();

        const int32_t m = (int32_t)ratios.ElementLength();
        const float* ratiosData = ratios.Data();
        std::vector<float> ratiosV(m);
        for (int32_t i = 0; i < m; ++i) ratiosV[i] = ratiosData[i];

        SplatSet attrs;
        attrs.N = N;
        attrs.C = C;
        attrs.mu.assign(means.Data(), means.Data() + N * 3);
        attrs.sc.assign(scales.Data(), scales.Data() + N * 3);
        attrs.q.assign(quats.Data(), quats.Data() + N * 4);
        attrs.op.assign(ops.Data(), ops.Data() + N);
        if (C > 0) attrs.sh.assign(sh.Data(), sh.Data() + (size_t)N * C);

        ProgressiveResult res = simplifyNodeProgressiveCore(
            attrs, ratiosV, k, mergeCap, lamGeo, lamSh, nMc, seed, epsCov);

        Napi::Object result = Napi::Object::New(e);
        Napi::Int32Array counts = Napi::Int32Array::New(e, m);
        for (int32_t i = 0; i < m; ++i) counts.Set(i, res.counts[i]);
        result.Set("counts", counts);

        const int32_t totalN = res.merged.N;
        Napi::Float32Array outMu = Napi::Float32Array::New(e, totalN * 3);
        Napi::Float32Array outSc = Napi::Float32Array::New(e, totalN * 3);
        Napi::Float32Array outQ = Napi::Float32Array::New(e, totalN * 4);
        Napi::Float32Array outOp = Napi::Float32Array::New(e, totalN);
        if (totalN > 0) {
            std::memcpy(outMu.Data(), res.merged.mu.data(), sizeof(float) * totalN * 3);
            std::memcpy(outSc.Data(), res.merged.sc.data(), sizeof(float) * totalN * 3);
            std::memcpy(outQ.Data(), res.merged.q.data(), sizeof(float) * totalN * 4);
            std::memcpy(outOp.Data(), res.merged.op.data(), sizeof(float) * totalN);
        }
        result.Set("mu", outMu);
        result.Set("scales", outSc);
        result.Set("quats", outQ);
        result.Set("ops", outOp);

        if (C > 0) {
            Napi::Float32Array outSh = Napi::Float32Array::New(e, totalN * C);
            if (totalN > 0)
                std::memcpy(outSh.Data(), res.merged.sh.data(), sizeof(float) * totalN * C);
            result.Set("sh", outSh);
        } else {
            Napi::Float32Array outSh = Napi::Float32Array::New(e, 0);
            result.Set("sh", outSh);
        }
        return result;
    };

    exports.Set(Napi::String::New(env, "simplifyNodeProgressive"),
                Napi::Function::New(env, SimplifyNodeProgressive));
    return exports;
}

} // namespace nanogs
