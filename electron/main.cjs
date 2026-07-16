/**
 * ReSplat Electron Main Process
 *
 * Embeds the Express backend server and loads the ReSplat SPA.
 * The renderer communicates with the backend via HTTP (BackendClient),
 * same as the web version — zero frontend changes needed.
 */

const { app: electronApp, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');

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

    // Open DevTools in development
    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }

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

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

let isQuitting = false;

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
    } catch (err) {
        console.error('[electron] Failed to start:', err);
        shutdown();
    }
});

// Handle window close button (X)
electronApp.on('window-all-closed', () => {
    shutdown();
});

electronApp.on('before-quit', (event) => {
    if (!isQuitting) {
        event.preventDefault();
        shutdown();
    }
});

electronApp.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
