// Postinstall patch: apply SH k-means performance optimizations to
// @playcanvas/splat-transform/dist/index.mjs
//
// Problem: the SOG writer's SH k-means used a 65536-centroid palette and ran
// the full Lloyd loop + assignment over every splat. On a 20.7M-splat scene
// this took hours (SwiftShader GPU path) or ~30+ min (single-thread CPU path),
// and with iterations=0 every splat collapsed onto one centroid (black/white
// view-dependent artifacts).
//
// This patch (applied idempotently — skips if already patched):
//   1. Caps the shN palette at 1024 centroids. Quality is palette-size
//      insensitive (the per-column quantize1d codebook dominates the error;
//      measured RMSE is flat from 512..65536), while assignment cost is
//      O(numRows * k * d).
//   2. Replaces the CPU k-means branch with a sample-based Lloyd loop
//      (65536 points) plus a brute-force full assignment spread across
//      worker_threads in Node (SharedArrayBuffer), keeping iterations intact.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const indexPath = join(root, 'node_modules', '@playcanvas', 'splat-transform', 'dist', 'index.mjs');

if (!existsSync(indexPath)) {
    console.warn('[patch-splat-transform] index.mjs not found — skipping');
    process.exit(0);
}

let code = readFileSync(indexPath, 'utf8');

// Idempotency marker: bail if already patched.
if (code.includes('Sample-based Lloyd loop')) {
    console.log('[patch-splat-transform] already patched — skipping');
    process.exit(0);
}

const failures = [];

// ---- Patch 1: cap the shN palette ----
const paletteOld = '                const paletteSize = Math.min(64, 2 ** Math.floor(Math.log2(numRows / 1024))) * 1024;';
const paletteNew = `                // Cap the SH palette so k-means stays tractable for very large
                // scenes. Quality is palette-size-insensitive (the per-column
                // quantize1d codebook dominates the error — measured RMSE is
                // flat from 512 to 65536 centroids), while the assignment cost
                // is O(numRows * k * d).
                const paletteSize = Math.min(1024, Math.min(64, 2 ** Math.floor(Math.log2(numRows / 1024))) * 1024);`;
if (code.includes(paletteOld)) {
    code = code.replace(paletteOld, paletteNew);
} else {
    failures.push('paletteSize cap');
}

// ---- Patch 2: sample-based Lloyd + parallel brute-force assignment ----
// Old CPU branch: from the `else {` after the device branch up to `bar.end();`.
const cpuBranchStart = '    else {\n        // recompute scratch (reused across iterations): per-cluster column sums';
const cpuBranchEnd = '            bar.tick();\n        }\n    }\n    bar.end();\n    return { centroids, labels };\n};';
const startIdx = code.indexOf(cpuBranchStart);
const endIdx = code.indexOf(cpuBranchEnd);
if (startIdx >= 0 && endIdx > startIdx) {
    const endPos = endIdx + cpuBranchEnd.length;
    const cpuNew = `    else {
        // Assignment strategy: for the (capped) palette sizes used by the SOG
        // writer a plain brute-force pass is fastest and exact; for very large
        // point counts in Node it is spread across worker_threads (the kd-tree
        // alternatives all degenerate at 45 dims — measured ~full scans).
        const useBrute = k <= 4096;
        const useCoarse = !useBrute && Math.min(9, nc) >= 3 && k > 256;
        // Node worker_threads for the brute-force pass (browser falls back to
        // the single-thread loop).
        let WorkerCtor = null;
        let cpuCount = 1;
        if (useBrute && typeof process !== 'undefined' && process.versions?.node) {
            try {
                const wt = await import('node:worker_threads');
                WorkerCtor = wt.Worker;
                const osMod = await import('node:os');
                cpuCount = Math.max(1, osMod.default ? osMod.default.availableParallelism?.() ?? osMod.default.cpus().length : 1);
            }
            catch {
                WorkerCtor = null;
            }
        }
        const PARALLEL_MIN = 8192;
        const NUM_WORKERS = Math.min(8, Math.max(1, cpuCount - 1));
        const assignBruteSingle = (pts, n, lbl) => {
            for (let r = 0; r < n; ++r) {
                const base = r * nc;
                let best = 0, bestD = Infinity;
                for (let c = 0; c < k; ++c) {
                    const cb = c * nc;
                    let d = 0;
                    for (let j = 0; j < nc; ++j) {
                        const v = pts[base + j] - centroids[cb + j];
                        d += v * v;
                    }
                    if (d < bestD) { bestD = d; best = c; }
                }
                lbl[r] = best;
            }
        };
        const assignBruteParallel = async (pts, n, lbl) => {
            // Ensure points live in a SharedArrayBuffer so workers read them
            // without copying (one-time up to 3.7 GB for 20M splats).
            let pointsSAB = pts.buffer instanceof SharedArrayBuffer ? pts.buffer : null;
            if (!pointsSAB) {
                pointsSAB = new SharedArrayBuffer(pts.byteLength);
                new Float32Array(pointsSAB).set(pts);
            }
            const labelsSAB = new SharedArrayBuffer(n * 4);
            const labelsView = new Uint32Array(labelsSAB);
            const chunkRows = Math.ceil(n / NUM_WORKERS);
            const workerSrc = \`
const { parentPort, workerData } = require('node:worker_threads');
const { pointsSAB, labelsSAB, centroids, nc, k, start, count } = workerData;
const points = new Float32Array(pointsSAB);
const labels = new Uint32Array(labelsSAB);
for (let r = 0; r < count; ++r) {
    const base = (start + r) * nc;
    let best = 0, bestD = Infinity;
    for (let c = 0; c < k; ++c) {
        const cb = c * nc;
        let dist = 0;
        for (let j = 0; j < nc; ++j) {
            const v = points[base + j] - centroids[cb + j];
            dist += v * v;
        }
        if (dist < bestD) { bestD = dist; best = c; }
    }
    labels[start + r] = best;
}
parentPort.postMessage('done');
\`;
            const tasks = [];
            for (let w = 0; w < NUM_WORKERS; ++w) {
                const start = w * chunkRows;
                const count = Math.min(chunkRows, n - start);
                if (count <= 0) break;
                tasks.push(new Promise((resolve, reject) => {
                    const worker = new WorkerCtor(workerSrc, {
                        eval: true,
                        workerData: { pointsSAB, labelsSAB, centroids, nc, k, start, count }
                    });
                    worker.once('message', () => { worker.terminate(); resolve(); });
                    worker.once('error', reject);
                }));
            }
            await Promise.all(tasks);
            lbl.set(labelsView.subarray(0, n));
        };
        const assignFn = async (pts, n, lbl) => {
            if (useBrute) {
                if (WorkerCtor && n >= PARALLEL_MIN) {
                    await assignBruteParallel(pts, n, lbl);
                }
                else {
                    assignBruteSingle(pts, n, lbl);
                }
                return;
            }
            if (!useCoarse) {
                assignCpu(pts, n, nc, centroids, k, lbl);
                return;
            }
            const CAND = 128;
            const coarseDim = Math.min(9, nc);
            const coarseCols = [];
            for (let j = 0; j < coarseDim; ++j) {
                const col = new Float32Array(k);
                for (let i = 0; i < k; ++i) col[i] = centroids[i * nc + j];
                coarseCols.push(col);
            }
            const coarseTree = new KdTree(coarseCols);
            const point = new Float32Array(nc);
            const kk = Math.min(CAND, k);
            for (let r = 0; r < n; ++r) {
                const base = r * nc;
                for (let j = 0; j < nc; ++j) point[j] = pts[base + j];
                const res = coarseTree.findKNearest(point, kk);
                let best = 0, bestD = Infinity;
                const nC = res.indices.length;
                for (let t = 0; t < nC; ++t) {
                    const c = res.indices[t];
                    if (c < 0) break;
                    let d = 0;
                    const cb = c * nc;
                    for (let j = 0; j < nc; ++j) {
                        const v = pts[base + j] - centroids[cb + j];
                        d += v * v;
                    }
                    if (d < bestD) { bestD = d; best = c; }
                }
                lbl[r] = best;
            }
        };
        // Sample-based Lloyd loop: run the k-means iterations on a bounded
        // random sample so the cost stays O(SAMPLE_MAX * k * d * iters).
        const SAMPLE_MAX = 65536;
        const sampleCount = Math.min(numRows, SAMPLE_MAX);
        const sampleIdx = pickRandomIndices(numRows, sampleCount);
        const samplePoints = new Float32Array(sampleCount * nc);
        for (let i = 0; i < sampleCount; ++i) {
            const s = sampleIdx[i] * nc;
            samplePoints.set(points.subarray(s, s + nc), i * nc);
        }
        const sampleLabels = new Uint32Array(sampleCount);
        // recompute scratch (reused across iterations): per-cluster column sums
        const sums = new Float64Array(k * nc);
        const counts = new Uint32Array(k);
        for (let step = 0; step < iterations; ++step) {
            await assignFn(samplePoints, sampleCount, sampleLabels);
            // recompute centroids in one vectorized pass: accumulate per-cluster
            // column sums into typed arrays, then divide by the cluster count.
            sums.fill(0);
            counts.fill(0);
            for (let r = 0; r < sampleCount; ++r) {
                const c = sampleLabels[r];
                counts[c]++;
                const sb = c * nc;
                const pb = r * nc;
                for (let j = 0; j < nc; ++j)
                    sums[sb + j] += samplePoints[pb + j];
            }
            for (let i = 0; i < k; ++i) {
                const cb = i * nc;
                if (counts[i] === 0) {
                    // re-seed empty cluster to a random point to avoid a zero vector
                    const src = Math.floor(Math.random() * sampleCount) * nc;
                    for (let j = 0; j < nc; ++j)
                        centroids[cb + j] = samplePoints[src + j];
                }
                else {
                    const inv = 1 / counts[i];
                    for (let j = 0; j < nc; ++j)
                        centroids[cb + j] = sums[cb + j] * inv;
                }
            }
            bar.tick();
        }
        // Final full assignment pass: label every point by its nearest centroid.
        await assignFn(points, numRows, labels);
    }
    bar.end();
    return { centroids, labels };
};`;
    code = code.slice(0, startIdx) + cpuNew + code.slice(endPos);
} else {
    failures.push('kmeansInterleaved CPU branch');
}

if (failures.length > 0) {
    console.error(`[patch-splat-transform] FAILED to apply: ${failures.join(', ')}`);
    process.exit(1);
}

writeFileSync(indexPath, code);
console.log('[patch-splat-transform] patched splat-transform (SH palette cap + sample k-means + parallel assignment)');
