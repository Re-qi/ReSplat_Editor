/**
 * ReSplat Electron Main Process
 *
 * Embeds the Express backend server and loads the ReSplat SPA.
 * The renderer communicates with the backend via HTTP (BackendClient),
 * same as the web version — zero frontend changes needed.
 */

const { app: electronApp, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const crypto = require('crypto');

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

    // Load the built SPA
    const distIndex = path.join(__dirname, '..', 'dist', 'index.html');
    await mainWindow.loadFile(distIndex);

    // Check WebGPU availability in renderer
    try {
        const hasWebGPU = await mainWindow.webContents.executeJavaScript('typeof navigator !== "undefined" && !!navigator.gpu');
        console.log(`[electron] WebGPU available: ${hasWebGPU}`);
    } catch (e) {
        console.log('[electron] WebGPU check failed:', e.message);
    }

    // Open DevTools
    mainWindow.webContents.openDevTools();

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

// Open URL in system default browser
ipcMain.handle('shell:openExternal', async (_event, url) => {
    await shell.openExternal(url);
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
