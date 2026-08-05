/**
 * LCC2 export harness — headless feedback loop.
 *
 * Runs lcc2ExportToPath directly under plain Node (no renderer, no Electron)
 * with a real PLY file, printing a memory sample every 5s so a memory blowup
 * (the Electron 闪退/OOM) is visible as rising rss/external before a crash.
 *
 * Usage:
 *   node scripts/run-lcc2-export.mjs <input.ply> <outputDir> [simplifyMethod] [lodLevels]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { lcc2ExportToPath } from '../server/lcc2-export.mjs';

const require = createRequire(import.meta.url);

let native = null;
try { native = require('../native'); } catch (e) { console.error('native load failed:', e.message); }

const splatLib = await import('@playcanvas/splat-transform');

const inputPath = process.argv[2];
const outputDir = process.argv[3];
const simplifyMethod = process.argv[4] ?? 'nanogs';
const lodLevels = parseInt(process.argv[5] ?? '6', 10);
if (!inputPath || !outputDir || !fs.existsSync(inputPath)) {
    console.error('usage: node scripts/run-lcc2-export.mjs <input.ply> <outputDir> [nanogs|uniform] [lodLevels]');
    process.exit(2);
}

const options = { name: 'test', lodLevels, shBands: 0, iterations: 0, simplifyMethod };
const t0 = Date.now();

const timer = setInterval(() => {
    const mu = process.memoryUsage();
    console.error(`[mem t=${((Date.now() - t0) / 1000).toFixed(0)}s] rss=${(mu.rss / 1048576).toFixed(0)}MB ext=${(mu.external / 1048576).toFixed(0)}MB heap=${(mu.heapUsed / 1048576).toFixed(0)}MB`);
}, 5000);

console.error(`[harness] export: ${path.basename(inputPath)} method=${simplifyMethod} lodLevels=${lodLevels} → ${outputDir}`);
console.error(`[harness] native addon: ${native ? 'loaded' : 'MISSING'}`);

try {
    const result = await lcc2ExportToPath(inputPath, outputDir, options, splatLib, native, (p) => {
        console.error(`[progress ${p.progress}] ${p.text}`);
    });
    clearInterval(timer);
    console.error('[harness] RESULT ' + JSON.stringify(result));
    process.exit(0);
} catch (e) {
    clearInterval(timer);
    console.error('[harness] EXPORT FAILED: ' + (e?.stack ?? e));
    process.exit(1);
}
