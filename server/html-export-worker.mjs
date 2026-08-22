/**
 * HTML Viewer Export — Worker Thread Entry (Node.js)
 *
 * Runs the CPU/memory-heavy bundled-HTML export off the Electron main process
 * event loop (which also drives the window message pump). Mirrors
 * lcc2-export-worker.mjs: loads its own splat-transform + native addon
 * instances and streams progress back to the parent via postMessage.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { htmlExportToPath } from './html-export.mjs';

const require = createRequire(import.meta.url);

// Enable global.gc so htmlExportToPath can force a collection after spilling
// the source columns to disk (~3.6 GB) before the ~3 GB color-layer gather.
// --expose-gc is not a valid worker execArgv flag, so flip it at runtime.
try {
    setFlagsFromString('--expose-gc');
    global.gc = runInNewContext('gc');
} catch {
    // gc unavailable — the export still works, just relies on normal GC.
}

// C++ native addon — PLY parse acceleration (each thread loads its own copy).
// The addon lives at the project root next to server.js, one level above this file.
let native = null;
try { native = require('../native'); } catch (_) { native = null; }

const { filePath, outputPath, options } = workerData;

try {
    const splatLib = await import('@playcanvas/splat-transform');
    const result = await htmlExportToPath(filePath, outputPath, options, splatLib, native, (progress) => {
        parentPort.postMessage({ type: 'progress', ...progress });
    });
    parentPort.postMessage({ type: 'done', result });
} catch (error) {
    // Include the full stack (and, if available, a heap snapshot) so an
    // out-of-memory failure can be pinpointed to the exact stage instead of
    // surfacing a bare "Array buffer allocation failed".
    const heap = (() => {
        const m = process.memoryUsage?.();
        return m ? `${(m.rss / 1048576).toFixed(0)}MB rss, ${(m.heapUsed / 1048576).toFixed(0)}MB heapUsed, ${(m.external / 1048576).toFixed(0)}MB external` : '';
    })();
    parentPort.postMessage({
        type: 'error',
        error: `${error?.stack ?? error?.message ?? String(error)}${heap ? ` [${heap}]` : ''}`
    });
}
