/**
 * ReSplat Electron Preload Script
 *
 * Exposes a minimal `electronAPI` to the renderer via contextBridge.
 * The renderer can detect Electron environment and use native dialogs/file access.
 */

const { contextBridge, ipcRenderer } = require('electron');

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

    /** WebGPU availability check */
    hasWebGPU: typeof navigator !== 'undefined' && !!navigator.gpu
});
