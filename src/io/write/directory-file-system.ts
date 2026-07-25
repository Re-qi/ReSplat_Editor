/**
 * Directory FileSystem implementation for splat-transform compatibility.
 *
 * Writes multiple files into a real directory tree, as required by directory
 * formats like LCC2 (`XXX.lcc2` metadata + `data/3dgs/*.sog` chunks). The
 * existing single-file `BrowserFileSystem` (showSaveFilePicker + a single
 * FileSystemWritableFileStream) cannot write multiple files, so this module
 * provides a `FileSystem` backed by either:
 *   - Electron native IPC (mkdir + streaming write) for the desktop build, or
 *   - the File System Access API (showDirectoryPicker) for Chromium browsers, or
 *   - an in-memory `MemoryFileSystem` fallback (for later ZIP packaging).
 */

import { MemoryFileSystem, type FileSystem, type Writer } from '@playcanvas/splat-transform';

/**
 * Handle to an open streaming write, as exposed by a DirectoryBackend.
 * Each backend adapts its underlying storage to this common surface.
 */
interface StreamHandle {
    /** Append a chunk; resolves with the number of bytes written. */
    write: (data: Uint8Array) => Promise<number>;
    /** Flush and finalize the file. */
    close: () => Promise<void>;
    /** Abort: close the stream and best-effort delete the partial file. */
    abort: () => Promise<void>;
}

/**
 * Backend strategy for writing a directory tree. Both the Electron and
 * browser implementations plug into this abstraction so `DirectoryFileSystem`
 * stays backend-agnostic.
 */
interface DirectoryBackend {
    /** Create a subdirectory (relative to root), creating parents as needed. */
    mkdir: (relPath: string) => Promise<void>;
    /** Open a streaming writer for a relative file path; creates parent dirs. */
    openWriter: (relPath: string) => Promise<StreamHandle>;
}

/**
 * Writer backed by a DirectoryBackend stream handle. Mirrors the
 * `BrowserFileWriter` shape: tracks `bytesWritten`, supports `abort`.
 * Abort initiates async cleanup (close + best-effort delete); `close` awaits
 * that cleanup if abort was triggered, so file descriptors are never leaked.
 */
class DirectoryWriter implements Writer {
    private handle: StreamHandle;
    private cursor = 0;
    private aborted = false;
    private abortPromise: Promise<void> | null = null;

    constructor(handle: StreamHandle) {
        this.handle = handle;
    }

    get bytesWritten(): number {
        return this.cursor;
    }

    abort(): void {
        if (this.aborted) return;
        this.aborted = true;
        // Fire-and-forget cleanup; close() awaits this if it is in flight.
        this.abortPromise = this.handle.abort().catch(() => {});
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.aborted) return;
        this.cursor += data.byteLength;
        await this.handle.write(data);
    }

    async close(): Promise<void> {
        if (this.abortPromise) {
            await this.abortPromise;
            return;
        }
        if (this.aborted) return;
        await this.handle.close();
    }
}

/**
 * Electron backend. Root is an absolute directory path obtained from
 * `openFolderDialog`. Writes go through the streaming write IPC so large SOG
 * files never need to be held whole in renderer memory.
 */
class ElectronDirectoryBackend implements DirectoryBackend {
    private rootAbsPath: string;

    constructor(rootAbsPath: string) {
        this.rootAbsPath = rootAbsPath;
    }

    private resolve(relPath: string): string {
        // relPath uses forward slashes; Node accepts mixed separators on Windows.
        return `${this.rootAbsPath}/${relPath}`;
    }

    async mkdir(relPath: string): Promise<void> {
        await window.electronAPI.mkdir(this.resolve(relPath), { recursive: true });
    }

    async openWriter(relPath: string): Promise<StreamHandle> {
        const abs = this.resolve(relPath);
        const id = await window.electronAPI.writeStreamOpen(abs);
        return {
            write: data => window.electronAPI.writeStreamChunk(id, data),
            close: () => window.electronAPI.writeStreamClose(id),
            abort: async () => {
                await window.electronAPI.writeStreamClose(id);
                await window.electronAPI.unlink(abs);
            }
        };
    }
}

/**
 * Browser backend. Root is a `FileSystemDirectoryHandle` from
 * `showDirectoryPicker({ mode: 'readwrite' })`. Subdirectories are walked via
 * `getDirectoryHandle(seg, { create: true })`; files via
 * `getFileHandle(name, { create: true }).createWritable()`.
 */
class BrowserDirectoryBackend implements DirectoryBackend {
    private rootHandle: FileSystemDirectoryHandle;

    constructor(rootHandle: FileSystemDirectoryHandle) {
        this.rootHandle = rootHandle;
    }

    async mkdir(relPath: string): Promise<void> {
        let dir = this.rootHandle;
        for (const seg of splitSegments(relPath)) {
            dir = await dir.getDirectoryHandle(seg, { create: true });
        }
    }

    async openWriter(relPath: string): Promise<StreamHandle> {
        const segments = splitSegments(relPath);
        const filename = segments.pop();
        if (filename === undefined) {
            throw new Error(`DirectoryFileSystem: invalid path '${relPath}'`);
        }
        let dir = this.rootHandle;
        for (const seg of segments) {
            dir = await dir.getDirectoryHandle(seg, { create: true });
        }
        const fileHandle = await dir.getFileHandle(filename, { create: true });
        const stream = await fileHandle.createWritable();
        return {
            write: async (data) => {
                await stream.write(data as unknown as ArrayBuffer);
                return data.byteLength;
            },
            close: () => stream.close(),
            abort: async () => {
                await stream.close();
                await fileHandle.remove().catch(() => {});
            }
        };
    }
}

// Split a relative path into non-empty segments (forward-slash separated).
const splitSegments = (relPath: string): string[] => {
    return relPath.split('/').filter(seg => seg.length > 0);
};

/**
 * FileSystem implementation backed by a real directory (Electron IPC or
 * browser File System Access API). Implements the splat-transform
 * `FileSystem` interface: `createWriter(relPath)` returns a streaming `Writer`
 * that writes `root/relPath` (creating parent dirs), and `mkdir(relPath)`
 * creates a subdirectory under root.
 */
class DirectoryFileSystem implements FileSystem {
    private backend: DirectoryBackend;

    constructor(backend: DirectoryBackend) {
        this.backend = backend;
    }

    async mkdir(relPath: string): Promise<void> {
        await this.backend.mkdir(relPath);
    }

    async createWriter(relPath: string): Promise<Writer> {
        const handle = await this.backend.openWriter(relPath);
        return new DirectoryWriter(handle);
    }
}

/**
 * Create a directory-capable FileSystem for export.
 *
 * Resolution order:
 *   1. Electron (`window.electronAPI.openFolderDialog`): native folder picker,
 *      returns a `DirectoryFileSystem` backed by the streaming write IPC.
 *   2. Chromium browser (`window.showDirectoryPicker`): directory picker with
 *      readwrite mode, returns a `DirectoryFileSystem` over the directory handle.
 *   3. Fallback (Firefox/Safari, no File System Access API): returns a
 *      `MemoryFileSystem` so the caller can ZIP-package the tree for download.
 *
 * Returns `null` when the user cancels the picker (Electron yields no path,
 * browser throws `AbortError`), mirroring how `showSaveFilePicker` cancellation
 * is handled elsewhere in the export flow.
 *
 * The optional `rootName` parameter is reserved for future use (e.g. naming
 * the fallback ZIP) and accepted to keep the factory signature stable.
 */
const createDirectoryFileSystem = async (_rootName?: string): Promise<DirectoryFileSystem | MemoryFileSystem | null> => {
    // Electron: native folder picker
    if (window.electronAPI?.openFolderDialog) {
        const folderPath = await window.electronAPI.openFolderDialog();
        if (!folderPath) return null;  // user cancelled
        return new DirectoryFileSystem(new ElectronDirectoryBackend(folderPath));
    }

    // Browser with File System Access API
    if (window.showDirectoryPicker) {
        try {
            const handle = await window.showDirectoryPicker({
                id: 'ReSplatLcc2Export',
                mode: 'readwrite'
            });
            return new DirectoryFileSystem(new BrowserDirectoryBackend(handle));
        } catch (error) {
            if (error?.name === 'AbortError') return null;  // user cancelled
            throw error;
        }
    }

    // Fallback: in-memory tree (caller ZIP-packages for download)
    return new MemoryFileSystem();
};

export { DirectoryFileSystem, createDirectoryFileSystem };
