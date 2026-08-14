/**
 * LCC2 Export — Worker Thread Entry (Node.js)
 *
 * Runs the CPU-bound backend export off the Electron main process event loop
 * (which also drives the window message pump — a synchronous export there
 * freezes the whole UI). The worker loads its own splat-transform + native
 * addon instances and streams progress back to the parent via postMessage.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { lcc2ExportToPath, cleanupLcc2Spill } from './lcc2-export.mjs';

const require = createRequire(import.meta.url);

// C++ native addon — PLY parse acceleration (each thread loads its own copy).
// The addon lives at the project root next to server.js, one level above this file.
let native = null;
try { native = require('../native'); } catch (_) { native = null; }

const { filePath, outputDir, options } = workerData;

try {
    const splatLib = await import('@playcanvas/splat-transform');
    const result = await lcc2ExportToPath(filePath, outputDir, options, splatLib, native, (progress) => {
        parentPort.postMessage({ type: 'progress', ...progress });
    });
    parentPort.postMessage({ type: 'done', result });
} catch (error) {
    parentPort.postMessage({ type: 'error', error: error?.message ?? String(error) });
} finally {
    cleanupLcc2Spill();
}
