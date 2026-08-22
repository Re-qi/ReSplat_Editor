/**
 * ReSplat Electron Main Process
 *
 * Embeds the Express backend server and loads the ReSplat SPA.
 * The renderer communicates with the backend via HTTP (BackendClient),
 * same as the web version — zero frontend changes needed.
 */

const { app: electronApp, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net } = require('electron');
const path = require('path');
const crypto = require('crypto');
const { extractGzipProjectEntry } = require('./project-extractor.cjs');

// ---------------------------------------------------------------------------
// Raise renderer V8 heap limit above the ~4 GB default
// ---------------------------------------------------------------------------
// SH=3 LCC2 re-export (serializeLcc2FromLodLog) peaks at ~10.4 GB for a 35.7M
// splat source: finest LOD treeDataTable 2 GB + LOD1 rawDataTable 4.2 GB +
// extractDataTable result 4.2 GB. The default renderer heap (~4 GB) throws
// "Array buffer allocation failed". Phase 1's SH cap prevents this for SH=0
// sources (zero-fill columns), but SH=3 sources carry real SH data that
// can't be dropped without quality loss. Raising --max-old-space-size lets
// V8 grow the heap to fit the genuine 59-column working set.
//
// V8 allocates on demand (no pre-allocation), so a high limit is safe on
// low-RAM machines — V8 OOMs at the system limit instead of the switch value.
// Cap at 75% of system RAM (minus 2 GB for OS/GPU/main process), clamped to
// [4 GB, 16 GB], to avoid triggering swap on memory-constrained machines.
const totalMemMB = Math.floor(require('os').totalmem() / 1024 / 1024);
const rendererMaxOldSpace = Math.min(16384, Math.max(4096, Math.floor((totalMemMB - 2048) * 0.75)));
// --expose-gc enables global.gc() in the renderer. The LCC2/HTML export paths
// call (globalThis).gc?.() to release multi-GB intermediate DataTables between
// LOD loads (serializeLcc2FromLodLog, html export). Without the flag those
// hints silently no-op and previous LOD tables stay resident until the next
// multi-GB allocation throws "Array buffer allocation failed".
electronApp.commandLine.appendSwitch('js-flags', `--expose-gc --max-old-space-size=${rendererMaxOldSpace}`);
console.log(`[electron] Renderer V8 heap limit: ${rendererMaxOldSpace} MB (system RAM: ${totalMemMB} MB)`);

// ---------------------------------------------------------------------------
// Register app:// privileged protocol BEFORE app.ready
// ---------------------------------------------------------------------------
// Replaces the previous file:// loading (loadFile) with a custom app://
// scheme. This fixes three problems caused by file://:
//   1. Module Workers can't spawn from file:// (CORS) → WorkerQueue hangs
//   2. fetch('./worker.mjs') from file:// may fail for blob:-origin workers
//   3. Service Worker (sw.js) can't register from file://
//
// With app:// + privileges (standard/secure/supportFetchAPI/allowServiceWorkers),
// the renderer can spawn module workers, fetch assets, and register sw.js —
// unblocking splat-transform's parallel WebP encoding (~3× SOG export speedup).
//
// Must be called synchronously at module top-level, BEFORE app.ready fires.
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: true } }
]);

// MIME type map for app:// handler. Chromium's file:// fetch leaves .wasm and
// .mjs at application/octet-stream, which breaks WebAssembly.instantiateStreaming
// and module worker spawning. We override Content-Type explicitly.
const APP_MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.mjs':  'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf':  'font/ttf',
    '.otf':  'font/otf',
    '.map':  'application/json; charset=utf-8'
};

// Register the app:// protocol handler. Serves files from dist/ with correct
// MIME types and path-traversal protection. Called after app.ready, before
// createWindow.
function registerAppProtocol() {
    const distPath = path.join(__dirname, '..', 'dist');
    protocol.handle('app', async (request) => {
        const url = new URL(request.url);
        // With standard:true, app://bundle/index.html → host='bundle', pathname='/index.html'
        // We ignore host (always 'bundle') and serve from dist/ by pathname.
        const filePath = decodeURIComponent(url.pathname).slice(1); // strip leading '/'

        // Security: normalize + prevent traversal outside dist/
        const resolved = path.normalize(path.join(distPath, filePath));
        if (resolved !== distPath && !resolved.startsWith(distPath + path.sep)) {
            return new Response('Forbidden', { status: 403 });
        }

        try {
            // net.fetch streams the file from disk (no full read into memory).
            // Convert Windows backslashes to forward slashes for the file:// URL.
            const fileUrl = 'file://' + resolved.replace(/\\/g, '/');
            const response = await net.fetch(fileUrl);

            // Override Content-Type for types Chromium doesn't map correctly.
            const ext = path.extname(resolved).toLowerCase();
            const mimeType = APP_MIME_TYPES[ext];
            if (mimeType) {
                const headers = new Headers(response.headers);
                headers.set('Content-Type', mimeType);
                return new Response(response.body, { status: response.status, headers });
            }
            return response;
        } catch (err) {
            return new Response('Not Found', { status: 404 });
        }
    });
}

// Import Express app from server.js (won't auto-listen due to require.main check)
const { app: expressApp, PORT } = require('../server.js');

// Resolve icon path — works in both dev (from project root) and production (from resources)
const getIconPath = () => {
    // In packaged app, resourcesPath points to the extracted resources dir
    if (electronApp.isPackaged) {
        return path.join(process.resourcesPath, 'static', 'icons', 'Logo512x512.png');
    }
    // In dev, resolve from project root
    return path.join(__dirname, '..', 'static', 'icons', 'Logo512x512.png');
};

let mainWindow = null;
let server = null;
const openSockets = new Set();

function startServer() {
    return new Promise((resolve, reject) => {
        server = expressApp.listen(PORT, () => {
            console.log(`[electron] Backend listening on http://localhost:${PORT}`);
            resolve();
        });
        server.on('error', reject);
        // Track all connections so we can destroy them on shutdown
        server.on('connection', (socket) => {
            openSockets.add(socket);
            socket.on('close', () => openSockets.delete(socket));
        });
    });
}

async function createWindow() {
    // Remove the default application menu bar
    Menu.setApplicationMenu(null);

    mainWindow = new BrowserWindow({
        width: 1600,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        title: 'ReSplat',
        icon: getIconPath(),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false  // needed for WebGPU in some Electron versions
        }
    });

    // Load the built SPA via app:// protocol (registered in registerAppProtocol).
    // app:// enables module workers, fetch(), and service workers — all blocked
    // under the previous file:// loadFile approach.
    await mainWindow.loadURL('app://bundle/index.html');

    // Check WebGPU availability in renderer
    try {
        const hasWebGPU = await mainWindow.webContents.executeJavaScript('typeof navigator !== "undefined" && !!navigator.gpu');
        console.log(`[electron] WebGPU available: ${hasWebGPU}`);
    } catch (e) {
        console.log('[electron] WebGPU check failed:', e.message);
    }

    // Forward renderer errors to the main-process terminal so export failures
    // can be diagnosed without opening DevTools.
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        if (typeof message === 'string' && level >= 3) {
            console.log(`[renderer] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`);
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

// UI zoom factor (Ctrl+Wheel on UI elements)
ipcMain.handle('zoom:get', () => {
    return mainWindow ? mainWindow.webContents.getZoomFactor() : 1.0;
});

ipcMain.handle('zoom:set', (_event, factor) => {
    if (mainWindow) {
        mainWindow.webContents.setZoomFactor(factor);
    }
    return factor;
});

// File open dialog — returns file paths selected by the user
ipcMain.handle('dialog:openFile', async (_event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: options?.title || 'Open PLY File',
        filters: options?.filters || [
            { name: 'Splat Files', extensions: ['ply', 'splat', 'sog', 'ksplat', 'spz', 'compressed.ply'] },
            { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile', 'multiSelections']
    });
    return result.canceled ? [] : result.filePaths;
});

// Folder open dialog
ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Open PLY Sequence Folder',
        properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
});

// Save file dialog
ipcMain.handle('dialog:saveFile', async (_event, options) => {
    const result = await dialog.showSaveDialog(mainWindow, {
        title: options?.title || 'Save File',
        defaultPath: options?.defaultPath,
        filters: options?.filters || [
            { name: 'Compressed PLY', extensions: ['compressed.ply'] },
            { name: 'PLY', extensions: ['ply'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });
    return result.canceled ? null : result.filePath;
});

// Read file from disk (for path-based import)
ipcMain.handle('fs:readFile', async (_event, filePath) => {
    const fs = require('fs');
    return fs.readFileSync(filePath);
});

// Read a byte range from a file by absolute path + position. Used by the LCC
// reader to stream GB-scale sibling files (data.bin/shcoef.bin) on demand
// WITHOUT going through Chromium's network stack — system proxies / flaky
// localhost routing made fetch-based reads (HTTP Range) unreliable, and IPC
// readFileSync of the whole file blows the renderer's ~4GB memory limit.
ipcMain.handle('fs:readRange', async (_event, filePath, position, length) => {
    const fs = require('fs');
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.allocUnsafe(length);
        const bytesRead = fs.readSync(fd, buf, 0, length, position);
        return buf.subarray(0, bytesRead);
    } finally {
        fs.closeSync(fd);
    }
});

// Stat a file; returns { size } (bytes)
ipcMain.handle('fs:stat', async (_event, filePath) => {
    const fs = require('fs');
    const s = fs.statSync(filePath);
    return { size: s.size };
});

// Check if a file path exists
ipcMain.handle('fs:exists', async (_event, filePath) => {
    const fs = require('fs');
    return fs.existsSync(filePath);
});

// List files in a directory (returns filenames only)
ipcMain.handle('fs:readDir', async (_event, dirPath) => {
    const fs = require('fs');
    const path = require('path');
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath).map(name => path.join(dirPath, name));
});

// Recursively walk a directory tree. Returns [{ path, rel, size }] for every
// regular file, where `path` is absolute, `rel` is the path relative to `dirPath`
// using forward slashes (so it matches web FileSystemEntry fullPath conventions),
// and `size` is the file size in bytes. The size lets the renderer skip
// GB-scale LCC siblings (data.bin/shcoef.bin) instead of shipping them over IPC.
// Used to auto-resolve LCC2 chunk siblings (.sog/.spz) that live in subdirectories
// next to a dropped .lcc2 meta file.
ipcMain.handle('fs:walk', async (_event, dirPath) => {
    const fs = require('fs');
    const path = require('path');
    const result = [];
    if (!fs.existsSync(dirPath)) return result;
    const walk = (dir, relBase) => {
        let entries;
        try { entries = fs.readdirSync(dir); } catch (_e) { return; }
        for (const name of entries) {
            const full = path.join(dir, name);
            const rel = relBase ? `${relBase}/${name}` : name;
            let stat;
            try { stat = fs.statSync(full); } catch (_e) { continue; }
            if (stat.isDirectory()) {
                walk(full, rel);
            } else if (stat.isFile()) {
                result.push({ path: full, rel, size: stat.size });
            }
        }
    };
    walk(dirPath, '');
    return result;
});

// Create a directory. `opts.recursive` mirrors fs.promises.mkdir semantics.
// Accepts an absolute path (e.g. from openFolderDialog).
ipcMain.handle('fs:mkdir', async (_event, p, opts) => {
    const fs = require('fs');
    return fs.promises.mkdir(p, { recursive: !!(opts && opts.recursive) });
});

// Streaming write file — keeps large files out of renderer memory.
// A Map<id, WriteStream> is maintained in main; chunks arrive over IPC.
const writeStreams = new Map();
let nextStreamId = 1;

// Open a write stream for `path`. Creates the parent directory first.
// Returns a numeric stream id the renderer uses for subsequent chunk/close calls.
ipcMain.handle('fs:writeStreamOpen', async (_event, p) => {
    const fs = require('fs');
    const path = require('path');
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    const stream = fs.createWriteStream(p, { flags: 'w' });
    const id = nextStreamId++;
    writeStreams.set(id, stream);
    return id;
});

// Append a chunk (Uint8Array/Buffer) to an open write stream.
// Resolves with the number of bytes written. Handles backpressure via 'drain'.
ipcMain.handle('fs:writeStreamChunk', async (_event, id, data) => {
    const stream = writeStreams.get(id);
    if (!stream) {
        throw new Error(`writeStreamChunk: unknown stream id ${id}`);
    }
    // data crosses contextBridge as a Uint8Array; build a Buffer view over its
    // underlying ArrayBuffer (honouring byteOffset/byteLength) without copying.
    const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            stream.removeListener('drain', onDrain);
            reject(err);
        };
        const onDrain = () => {
            stream.removeListener('error', onError);
            resolve(buf.length);
        };
        stream.once('error', onError);
        if (stream.write(buf)) {
            stream.removeListener('error', onError);
            resolve(buf.length);
        } else {
            stream.once('drain', onDrain);
        }
    });
});

// Finalize and close a write stream, then drop it from the map.
ipcMain.handle('fs:writeStreamClose', async (_event, id) => {
    const stream = writeStreams.get(id);
    if (!stream) return;  // already closed or unknown id
    writeStreams.delete(id);
    return new Promise((resolve, reject) => {
        stream.once('error', reject);
        stream.end(() => resolve());
    });
});

// Best-effort file deletion (used by DirectoryFileSystem writer abort cleanup).
ipcMain.handle('fs:unlink', async (_event, p) => {
    const fs = require('fs');
    try {
        await fs.promises.unlink(p);
        return true;
    } catch (_err) {
        return false;
    }
});

// Expand a .respproj PLY into a temporary file in the main process. Sending a
// multi-GB project payload to the renderer first creates avoidable heap copies.
ipcMain.handle('project:extractGzipEntry', async (_event, projectPath, entryName) => {
    if (typeof projectPath !== 'string' || typeof entryName !== 'string' || !/^splat_\d+\.ply\.gz$/.test(entryName)) {
        throw new Error('Invalid project extraction request');
    }
    const tempDir = path.join(electronApp.getPath('temp'), 'ReSplat-projects');
    return extractGzipProjectEntry(projectPath, entryName, tempDir);
});

// Open URL in system default browser
ipcMain.handle('shell:openExternal', async (_event, url) => {
    await shell.openExternal(url);
});

// Open Electron DevTools for the main window
ipcMain.handle('devtools:open', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.openDevTools();
    }
});

// Close Electron DevTools for the main window
ipcMain.handle('devtools:close', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.closeDevTools();
    }
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

let isQuitting = false;
let isForceClosing = false;       // set after the save prompt resolves to "Don't Save" or "Save OK"
let closePromptInFlight = false;  // guards against re-entrant close events

/**
 * Ask the renderer for the current document's dirty state + name.
 * Resolves to { dirty: boolean, docName: string|null }.
 * Times out after 2s (treats as not dirty) so a hung renderer can't lock the close.
 */
function queryUnsavedState() {
    return new Promise((resolve) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            resolve({ dirty: false, docName: null });
            return;
        }
        const nonce = crypto.randomBytes(8).toString('hex');
        const timer = setTimeout(() => {
            ipcMain.removeAllListeners('__unsaved-result');
            console.warn('[electron] dirty-check timed out — proceeding as if clean');
            resolve({ dirty: false, docName: null });
        }, 2000);

        ipcMain.once('__unsaved-result', (_e, payload) => {
            clearTimeout(timer);
            if (!payload || payload.nonce !== nonce) {
                // Stale reply from a previous attempt — keep waiting via a fresh call.
                resolve({ dirty: false, docName: null });
                return;
            }
            resolve({ dirty: !!payload.dirty, docName: payload.docName ?? null });
        });
        mainWindow.webContents.send('__check-unsaved', nonce);
    });
}

/**
 * Ask the renderer to run doc.save. Resolves to true on success.
 * Times out after 60s — large point clouds may take a while to serialize.
 */
function requestRendererSave() {
    return new Promise((resolve) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            resolve(false);
            return;
        }
        const nonce = crypto.randomBytes(8).toString('hex');
        const timer = setTimeout(() => {
            ipcMain.removeAllListeners('__save-result');
            console.warn('[electron] save timed out');
            resolve(false);
        }, 60_000);

        ipcMain.once('__save-result', (_e, payload) => {
            clearTimeout(timer);
            if (!payload || payload.nonce !== nonce) {
                resolve(false);
                return;
            }
            resolve(!!payload.ok);
        });
        mainWindow.webContents.send('__trigger-save', nonce);
    });
}

/**
 * Show a custom HTML save-prompt dialog before closing when there are unsaved changes.
 * Uses the renderer's Popup component (same style as other app dialogs) instead of
 * a native OS dialog.
 * Returns: 'save' | 'discard' | 'cancel'
 */
function requestSavePrompt(docName) {
    const nonce = Date.now() + Math.random();
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            ipcMain.removeAllListeners('__save-prompt-result');
            resolve('cancel');
        }, 300000); // 5 min timeout — user might step away
        ipcMain.once('__save-prompt-result', (_event, payload) => {
            if (payload.nonce === nonce) {
                clearTimeout(timeout);
                resolve(payload.action || 'cancel');
            }
        });
        mainWindow.webContents.send('__show-save-prompt', { nonce, docName: docName || '未命名工程' });
    });
}

/**
 * Handle the window's close button / Alt+F4 / etc.
 *
 * Electron note: the renderer registers a `beforeunload` handler that sets
 * `e.returnValue` when there are unsaved changes (editor.ts). Without an
 * explicit `close` listener here, that handler blocks the window from
 * closing and the app appears stuck — this is the root cause of the
 * "cannot quit after editing" bug.
 */
async function handleWindowClose(event) {
    if (isForceClosing) {
        // We've already prompted; allow the close to proceed.
        return;
    }
    event.preventDefault();

    if (closePromptInFlight) return;
    closePromptInFlight = true;
    try {
        const state = await queryUnsavedState();
        if (!state.dirty) {
            isForceClosing = true;
            closePromptInFlight = false;
            mainWindow.close();
            return;
        }

        const action = await requestSavePrompt(state.docName);
        if (action === 'cancel') {
            return;  // user aborted — keep window open
        }
        if (action === 'save') {
            const ok = await requestRendererSave();
            if (!ok) {
                // Save failed or user cancelled the save dialog — keep window open.
                return;
            }
        }
        // 'save' (succeeded) or 'discard' — proceed with close.
        isForceClosing = true;
        closePromptInFlight = false;
        mainWindow.close();
    } finally {
        closePromptInFlight = false;
    }
}

function shutdown() {
    if (isQuitting) return;
    isQuitting = true;

    // Destroy window first to stop renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
        mainWindow = null;
    }

    // Force-close the Express server and all connections
    if (server) {
        server.close(() => {
            console.log('[electron] Server closed');
        });
        // Destroy all tracked connections (including active ones)
        for (const socket of openSockets) {
            socket.destroy();
            openSockets.delete(socket);
        }
        server = null;
    }

    electronApp.quit();
}

electronApp.whenReady().then(async () => {
    try {
        await startServer();
        registerAppProtocol();
        await createWindow();
        // Attach the close handler now that the window exists.
        mainWindow.on('close', handleWindowClose);
    } catch (err) {
        console.error('[electron] Failed to start:', err);
        shutdown();
    }
});

// Handle window close button (X) — fires after handleWindowClose allows the
// close to complete (window actually destroyed).
electronApp.on('window-all-closed', () => {
    shutdown();
});

// before-quit: triggered by Cmd/Ctrl+Q, taskbar quit, system shutdown, etc.
// We don't prompt here directly because the renderer can't be safely queried
// once the app is quitting — instead, if there's an active window, route the
// quit through the window's close path so the save prompt can run.
electronApp.on('before-quit', (event) => {
    if (isQuitting) return;          // shutdown already in progress
    if (isForceClosing) return;      // prompt already resolved — let it proceed
    if (!mainWindow || mainWindow.isDestroyed()) return;

    // Convert the quit into a window close so the save prompt runs.
    event.preventDefault();
    mainWindow.close();
});

electronApp.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
