/**
 * K-means SOG 文件大小对比测试
 *
 * 验证假设：对于树节点空间排序后的 splats，k-means 聚类 (iterations=10)
 * 相对于不聚类 (iterations=0) 产生的 SOG 文件大小差异是否 <10%。
 *
 * 用法: node scripts/test-kmeans-sog.mjs
 */

import { Column, DataTable, Transform, writeSog, MemoryFileSystem, WorkerQueue } from '@playcanvas/splat-transform';

WorkerQueue.maxWorkers = 0; // inline mode

// --- Generate spatially coherent splat data ---
const genScene = (N, shBands) => {
    const xs = new Float32Array(N);
    const ys = new Float32Array(N);
    const zs = new Float32Array(N);
    const s0 = new Float32Array(N);
    const s1 = new Float32Array(N);
    const s2 = new Float32Array(N);
    const r0 = new Float32Array(N);
    const r1 = new Float32Array(N);
    const r2 = new Float32Array(N);
    const r3 = new Float32Array(N);
    const dc0 = new Float32Array(N);
    const dc1 = new Float32Array(N);
    const dc2 = new Float32Array(N);
    const opacity = new Float32Array(N);

    // SH rest coefficients (per splat, interleaved RGB)
    const restCount = [0, 3, 8, 15][shBands] * 3; // total f_rest_* columns = SH_COEFFS * 3
    const restCols = [];
    for (let c = 0; c < restCount; ++c) {
        restCols.push(new Float32Array(N));
    }

    for (let i = 0; i < N; ++i) {
        // Spatially coherent: points on a noisy spherical shell
        const phi = 2 * Math.PI * Math.random();
        const theta = Math.acos(2 * Math.random() - 1);
        const radius = 1.0 + 0.05 * (Math.random() - 0.5);

        xs[i] = radius * Math.sin(theta) * Math.cos(phi);
        ys[i] = radius * Math.sin(theta) * Math.sin(phi);
        zs[i] = radius * Math.cos(theta);

        s0[i] = Math.exp(-3 - Math.random() * 2);
        s1[i] = Math.exp(-3 - Math.random() * 2);
        s2[i] = Math.exp(-3 - Math.random() * 2);

        const a = Math.random() * 2 - 1, b = Math.random() * 2 - 1, c = Math.random() * 2 - 1, d = Math.random() * 2 - 1;
        const len = Math.sqrt(a * a + b * b + c * c + d * d);
        r0[i] = a / len; r1[i] = b / len; r2[i] = c / len; r3[i] = d / len;

        dc0[i] = (xs[i] + 1) / 2;
        dc1[i] = (ys[i] + 1) / 2;
        dc2[i] = (zs[i] + 1) / 2;
        opacity[i] = 0.5 + 0.5 * Math.random();

        // SH rest: spatially varying small values
        for (let c = 0; c < restCount; ++c) {
            restCols[c][i] = (Math.random() - 0.5) * 0.1;
        }
    }

    const columns = [
        new Column('x', xs), new Column('y', ys), new Column('z', zs),
        new Column('scale_0', s0), new Column('scale_1', s1), new Column('scale_2', s2),
        new Column('rot_0', r0), new Column('rot_1', r1), new Column('rot_2', r2), new Column('rot_3', r3),
        new Column('f_dc_0', dc0), new Column('f_dc_1', dc1), new Column('f_dc_2', dc2),
        new Column('opacity', opacity)
    ];
    for (let c = 0; c < restCount; ++c) {
        columns.push(new Column(`f_rest_${c}`, restCols[c]));
    }

    return { columns, xs, zs };
};

// --- Test configs ---
const CONFIGS = [
    { N: 500_000, sh: 0, label: '500K SH=0' },
    { N: 10_000, sh: 3, label: '10K SH=3' },
    { N: 2_000_000, sh: 0, label: '2M SH=0' },
];

console.log('=== K-means SOG Size Comparison (SH=0 vs SH=3) ===\n');

for (const { N, sh, label } of CONFIGS) {
    console.log(`\n--- ${label} (N=${N.toLocaleString()}, ${sh===0?14:59} cols) ---`);

    const { columns } = genScene(N, sh);
    const dataTable = new DataTable(columns, Transform.PLY);

    const runTest = async (iters) => {
        const tA = performance.now();
        const outFs = new MemoryFileSystem();
        await writeSog({ filename: 'test.sog', dataTable, bundle: true, iterations: iters }, outFs);
        const tB = performance.now();
        return { size: outFs.results.get('test.sog')?.length ?? 0, time: (tB - tA) / 1000, fs: outFs };
    };

    try {
        const r0 = await runTest(0);
        const r10 = await runTest(10);

        const ratio = (r0.size / r10.size * 100).toFixed(1);
        const savings = ((r0.size - r10.size) / r10.size * 100).toFixed(1);

        console.log(`  iter=0:  ${(r0.size / 1024 / 1024).toFixed(1)} MB  (${r0.time.toFixed(1)}s)`);
        console.log(`  iter=10: ${(r10.size / 1024 / 1024).toFixed(1)} MB  (${r10.time.toFixed(1)}s)`);
        console.log(`  size ratio: ${ratio}%  |  k-means savings: ${savings}%`);
        console.log(`  CONCLUSION: ${Math.abs(parseFloat(savings)) <= 5 ? 'K-MEANS REDUNDANT (≤5% diff)' : 'K-MEANS HELPFUL (>5% compression)'}`);
    } catch (e) {
        console.log(`  ERROR: ${e.message}`);
    }

    dataTable.columns.length = 0;
}

console.log('\n=== Done ===');
