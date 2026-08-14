/**
 * LCC2 export — per-cell NanoGS simplify worker (pool v2, disk-writer).
 *
 * Spawned by lcc2-export.mjs as a pool of sub-workers. Shares the full column
 * data via SharedArrayBuffer (zero-copy) and simplifies ONE WHOLE CELL per
 * task: every ≤NANOGS_NODE_CAP spatial batch of the cell runs through
 * simplifyNodeBatched (C++ native core when available), and its per-rate
 * snapshots are written DIRECTLY to the shared spill directory. The main
 * worker never receives batch buffers — it gets back only per-batch counts
 * (memory safety: the main isolate holds the SAB + metadata, never the
 * ~6.8 GB of snapshot data).
 *
 * Spill format (must match lcc2-export.mjs streamSpillIntoChunk):
 *   {topId}__{rate}.bin — [batch0: c0(count0) c1(count0) … c58(count0)][batch1: …]…
 *   with each column block count×4 bytes.
 *
 * Messages:
 *   init  { type, sab, layout, snapshotDir }   layout: { colNames, shColNames, columns:{name:{byteOffset,length}} }
 *   task  { type, taskId, topId, batches:[Uint32Array…], ratios, opts }
 *   back  { type:'init-done' } | { type:'result', taskId, ok, batches:[{counts:number[]}] }
 *         — counts[i] = output splats at ratios[i] for that batch (0 if skipped).
 */

import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

let nanogs = null;
let colNames = [];
let shColNames = [];
let colLookup = {};
let snapshotDir = null;
let taskCount = 0;

// Lazily load the NanoGS bundle + native addon on first init. Failures here
// fall back to the pure-TS path inside simplifyNodeBatched.
async function ensureLoaded() {
    if (nanogs) return;
    try {
        // Same asar caveat as lcc2-export.mjs loadNanogs: Node's ESM loader
        // cannot read files inside app.asar, so in the packaged exe load the
        // unpacked copy (<resources>/app.asar.unpacked/dist/nanogs.mjs) via a
        // file:// URL instead of the relative path.
        const ownDir = path.dirname(fileURLToPath(import.meta.url));
        const inAsar = ownDir.includes(path.sep + 'app.asar' + path.sep);
        const nanogsPath = inAsar
            ? path.join(path.resolve(ownDir, '..', '..'), 'app.asar.unpacked', 'dist', 'nanogs.mjs')
            : path.join(ownDir, '..', 'dist', 'nanogs.mjs');
        nanogs = await import(pathToFileURL(nanogsPath).href);
    } catch (e) {
        console.error(`[lcc2-worker] NanoGS module unavailable (${e.message}) — signaling init error`);
        // Tell the pool this worker can't simplify; the dispatcher marks it
        // dead so the export falls back to the serial path on the main worker.
        parentPort.postMessage({ type: 'init-error' });
        return;
    }
    try {
        const native = require('../native/index.js');
        if (native && typeof native.simplifyNodeProgressive === 'function') {
            nanogs.setNativeImpl(native.simplifyNodeProgressive);
            console.error('[lcc2-worker] native acceleration enabled');
        } else {
            console.error('[lcc2-worker] native MISSING — TS fallback');
        }
    } catch (e) {
        console.error(`[lcc2-worker] native load failed: ${e.message} — TS fallback`);
    }
}

parentPort.on('message', async (msg) => {
    try {
        if (msg.type === 'init') {
            await ensureLoaded();
            const layout = msg.layout;
            colNames = layout.colNames;
            shColNames = layout.shColNames;
            snapshotDir = msg.snapshotDir;
            colLookup = {};
            for (const cn of colNames) {
                const c = layout.columns[cn];
                colLookup[cn] = new Float32Array(msg.sab, c.byteOffset, c.length);
            }
            parentPort.postMessage({ type: 'init-done' });
            return;
        }
        if (msg.type === 'task') {
            const { taskId, topId, ratios, opts } = msg;
            const batches = msg.batches; // transferred Uint32Arrays
            const rates = Array.from(ratios);
            const batchMeta = []; // { counts } per batch, aligned to rates
            const fds = new Map(); // rate → open fd (one per rate, closed per cell)
            let ok = true;
            try {
                for (const batch of batches) {
                    const res = nanogs.simplifyNodeBatched(batch, colLookup, colNames, shColNames, rates, opts);
                    const counts = new Array(rates.length).fill(0);
                    if (res) {
                        for (let r = 0; r < rates.length; ++r) {
                            const snap = res[r];
                            if (!snap || snap.count === 0) continue;
                            const rate = rates[r];
                            let fd = fds.get(rate);
                            if (fd === undefined) {
                                fd = fs.openSync(path.join(snapshotDir, `${topId}__${rate}.bin`), 'w');
                                fds.set(rate, fd);
                            }
                            const chunks = [];
                            for (const cn of colNames) {
                                const src = snap.cols[cn];
                                if (src) {
                                    chunks.push(Buffer.from(src.buffer, src.byteOffset, snap.count * 4));
                                } else {
                                    chunks.push(Buffer.alloc(snap.count * 4));
                                }
                            }
                            fs.writevSync(fd, chunks);
                            counts[r] = snap.count;
                        }
                    }
                    batchMeta.push({ counts });
                }
            } catch (e) {
                ok = false;
                console.error(`[lcc2-worker] cell ${topId} failed (${batches.length} batches): ${e.message}`);
            } finally {
                for (const fd of fds.values()) {
                    try { fs.closeSync(fd); } catch { /* ignore */ }
                }
            }
            ++taskCount;
            if (taskCount % 32 === 0) {
                const mu = process.memoryUsage();
                console.error(`[lcc2-worker] task#${taskCount}: rss=${(mu.rss / 1048576).toFixed(0)}MB ext=${(mu.external / 1048576).toFixed(0)}MB`);
            }
            parentPort.postMessage({ type: 'result', taskId, ok, batches: batchMeta });
        }
    } catch (e) {
        parentPort.postMessage({ type: 'result', taskId: msg?.taskId, ok: false, error: String(e) });
    }
});
