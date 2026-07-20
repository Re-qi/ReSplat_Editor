/**
 * ReSplat Electron Preload Script
 *
 * Exposes a minimal `electronAPI` to the renderer via contextBridge.
 * The renderer can detect Electron environment and use native dialogs/file access.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Holds renderer-side callbacks registered for close-time save prompt.
// These are populated by registerDirtyChecker / registerSaveHandler below.
const closeHandlers = {
    dirtyChecker: null,
    saveHandler: null,
    savePromptHandler: null
};

// Main → renderer queries (used by main.cjs during close handling).
// Each request includes a nonce so we can correlate the reply; this lets
// multiple close attempts not race each other.
ipcRenderer.on('__check-unsaved', async (event, nonce) => {
    let result = { dirty: false, docName: null };
    try {
        if (closeHandlers.dirtyChecker) {
            result = await closeHandlers.dirtyChecker();
        }
    } catch (err) {
        console.error('[preload] dirtyChecker failed:', err);
    }
    event.sender.send('__unsaved-result', { nonce, ...result });
});

ipcRenderer.on('__trigger-save', async (event, nonce) => {
    let ok = false;
    try {
        if (closeHandlers.saveHandler) {
            ok = await closeHandlers.saveHandler();
        }
    } catch (err) {
        console.error('[preload] saveHandler failed:', err);
    }
    event.sender.send('__save-result', { nonce, ok });
});

ipcRenderer.on('__show-save-prompt', async (event, { nonce, docName }) => {
    let action = 'cancel';
    try {
        if (closeHandlers.savePromptHandler) {
            action = await closeHandlers.savePromptHandler(docName);
        }
    } catch (err) {
        console.error('[preload] savePromptHandler failed:', err);
    }
    event.sender.send('__save-prompt-result', { nonce, action });
});

contextBridge.exposeInMainWorld('electronAPI', {
    /** Whether we're running inside Electron */
    isElectron: true,

    /** Open native file picker dialog */
    openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),

    /** Open native folder picker dialog */
    openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),

    /** Open native save dialog */
    saveFileDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options),

    /** Read a file from disk (by absolute path) */
    readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),

    /** Check if a file exists */
    fileExists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),

    /** List files in a directory (returns full paths) */
    readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),

    /** Get the current browser zoom factor */
    getZoomFactor: () => ipcRenderer.invoke('zoom:get'),

    /** Set the browser zoom factor */
    setZoomFactor: (factor) => ipcRenderer.invoke('zoom:set', factor),

    /** Open a URL in the system default browser */
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

    /** WebGPU availability check */
    hasWebGPU: typeof navigator !== 'undefined' && !!navigator.gpu,

    /**
     * Register a callback invoked by the main process before closing the
     * window. Should resolve to { dirty: boolean, docName: string|null }.
     */
    registerDirtyChecker: (fn) => { closeHandlers.dirtyChecker = fn; },

    /**
     * Register a callback that saves the current document. Should resolve
     * to true on success, false on failure or user-cancel.
     */
    registerSaveHandler: (fn) => { closeHandlers.saveHandler = fn; },

    /**
     * Register a callback that shows the unsaved-changes prompt dialog.
     * Receives `docName` (string), should resolve to 'save' | 'discard' | 'cancel'.
     */
    registerSavePromptHandler: (fn) => { closeHandlers.savePromptHandler = fn; }
});