// End-to-end LCC2 export test on the real 雕像群 dataset.
// Verifies the full backend pipeline with parallel NanoGS simplify pool:
//   native PLY read → adaptive tree → parallel chain-top pre-simplification
//   (worker pool + SharedArrayBuffer) → per-depth chunk writeSog → .lcc2 tree.
//
// Usage: node scripts/run-lcc2-export-test.mjs [lodLevels] [outDir]
// Default lodLevels=6, outDir=<tmp>. Run from project root.
// Requires: npm run build + native/ply_reader.node rebuilt.

import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const lodLevels = parseInt(process.argv[2] ?? '6', 10);
const outDir = process.argv[3] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lcc2-e2e-'));

const INPUT = 'D:\\CodeProjects\\ReSplat\\数据\\LCC\\雕像群.lcc2.ply';
const native = require('../native/index.js');
const { lcc2ExportToPath } = await import('../server/lcc2-export.mjs');
const splatLib = await import('@playcanvas/splat-transform');

console.log(`E2E LCC2 export: ${INPUT}`);
console.log(`lodLevels=${lodLevels}, outDir=${outDir}`);
console.log(`native readPlyFast=${typeof native.readPlyFast}, simplifyNodeProgressive=${typeof native.simplifyNodeProgressive}`);
console.log(`cpus=${os.cpus().length}`);

const t0 = performance.now();
let lastPct = -1;
const result = await lcc2ExportToPath(INPUT, outDir, {
    name: 'e2e-test',
    lodLevels,
    shBands: 0,
    iterations: 0,
    simplifyMethod: 'nanogs'
}, splatLib, native, ({ progress, text }) => {
    const pct = Math.round(progress);
    if (pct !== lastPct) {
        lastPct = pct;
        console.log(`  ${String(pct).padStart(3)}% ${text}`);
    }
});

const total = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`\nE2E done in ${total}s`);
console.log(`result: ${JSON.stringify(result).slice(0, 400)}`);
