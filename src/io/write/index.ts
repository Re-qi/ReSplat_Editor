/**
 * IO Write module - handles writing splat data to various destinations.
 */

// Browser file system
export { BrowserFileSystem } from './browser-file-system';

// Directory file system (Electron IPC / File System Access API / memory fallback)
export { DirectoryFileSystem, createDirectoryFileSystem } from './directory-file-system';

// Writer utilities
export {
    GZipWriter,
    ZstdWriter,
    ProgressWriter,
    isZstdSupported
} from './writer';
