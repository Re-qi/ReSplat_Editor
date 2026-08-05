// Decisive feedback loop: run the REAL lcc2 export path inside Electron
// (spawn lcc2-export-worker exactly like server.js) but WITHOUT any renderer
// window. If it OOMs → the export process itself is the problem. If it
// completes → the renderer process (scene loaded in UI) is what tips memory
// over, and the fix must free renderer memory or shrink the export process.
// Run: npx electron scripts/diag-electron-export.cjs
const { app } = require('electron');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const INPUT = 'D:\\CodeProjects\\ReSplat\\数据\\LCC\\雕像群.lcc2.ply';
// os.tmpdir() is the only writable location under the IDE sandbox (slow SATA,
// but this run validates pool-v2 correctness + memory in Electron; the fast
// drive speedup is proven separately in plain Node).
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc2-electron-diag-'));

app.whenReady().then(() => {
    console.log(`[main] totalmem=${(os.totalmem() / 1073741824).toFixed(0)}GB freemem=${(os.freemem() / 1073741824).toFixed(0)}GB`);
    const w = new Worker(path.join(__dirname, '..', 'server', 'lcc2-export-worker.mjs'), {
        workerData: {
            filePath: INPUT,
            outputDir: OUT,
            options: { name: 'diag', lodLevels: 6, shBands: 0, iterations: 0, simplifyMethod: 'nanogs' }
        },
        resourceLimits: { maxOldGenerationSizeMb: 16384, maxYoungGenerationSizeMb: 2048 }
    });
    let lastPct = -1;
    w.on('message', (m) => {
        if (m.type === 'progress') {
            const pct = Math.round(m.progress);
            if (pct !== lastPct) { lastPct = pct; console.log(`  ${pct}% ${m.text}`); }
        } else if (m.type === 'done') {
            console.log(`[main] EXPORT DONE: ${JSON.stringify(m.result).slice(0, 300)}`);
            console.log(`[main] freemem after=${(os.freemem() / 1073741824).toFixed(1)}GB`);
            app.exit(0);
        } else if (m.type === 'error') {
            console.error(`[main] EXPORT ERROR: ${m.error}`);
            app.exit(1);
        }
    });
    w.on('error', (e) => { console.error(`[main] worker error: ${e.message}`); app.exit(1); });
    w.on('exit', (c) => { console.error(`[main] worker exit ${c}`); app.exit(c === 0 ? 0 : 1); });
    setInterval(() => {
        const mu = process.memoryUsage();
        console.log(`[main] rss=${(mu.rss/1048576).toFixed(0)}MB ext=${(mu.external/1048576).toFixed(0)}MB free=${(os.freemem()/1073741824).toFixed(1)}GB`);
    }, 30000).unref();
});
