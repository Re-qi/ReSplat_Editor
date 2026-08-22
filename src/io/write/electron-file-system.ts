/**
 * Electron single-file FileSystem for splat-transform compatibility.
 *
 * In Electron the renderer has no showSaveFilePicker, so single-file exports
 * used to fall back to BrowserDownloadWriter — which accumulates the entire
 * file in a MemoryFileSystem and concats it into ONE ArrayBuffer on close
 * (plus a Blob copy for the download). For GB-scale exports (e.g. a bundled
 * HTML viewer with a base64-embedded sog) that single allocation fails with
 * "Array buffer allocation failed" on top of the already-loaded scene.
 *
 * Instead this FileSystem streams every writer chunk over the streaming
 * write IPC channel (the same one the LCC2 directory export uses), so
 * renderer memory stays at one aggregation buffer regardless of output size.
 */

import { type FileSystem, type Writer } from '@playcanvas/splat-transform';

// Aggregation buffer size. Writers commonly emit 32KB-1MB chunks; batching
// them into 1MB IPC messages keeps round-trip overhead low.
const FLUSH_SIZE = 1024 * 1024;

/**
 * Writer backed by the Electron streaming write IPC. Mirrors the
 * `BrowserFileWriter` shape: tracks `bytesWritten`, supports `abort`.
 * Abort initiates async cleanup (close + best-effort delete); `close` awaits
 * that cleanup if abort was triggered, so file descriptors are never leaked.
 */
class ElectronFileWriter implements Writer {
    private filePath: string;
    private buffer = new Uint8Array(FLUSH_SIZE);
    private bufferLength = 0;
    private cursor = 0;
    private aborted = false;
    private abortPromise: Promise<void> | null = null;

    // Resolved on first write/close; a failed open surfaces there.
    private openPromise: Promise<number>;

    constructor(filePath: string) {
        this.filePath = filePath;
        this.openPromise = window.electronAPI!.writeStreamOpen(filePath);
    }

    get bytesWritten(): number {
        return this.cursor;
    }

    private async flush(): Promise<void> {
        if (this.bufferLength === 0) return;
        const id = await this.openPromise;
        const data = this.buffer.subarray(0, this.bufferLength);
        await window.electronAPI!.writeStreamChunk(id, data);
        // the buffer is only reused after the IPC write has completed
        this.bufferLength = 0;
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.aborted) return;
        this.cursor += data.byteLength;
        let src = data;
        while (src.byteLength > 0) {
            const space = this.buffer.length - this.bufferLength;
            const n = Math.min(space, src.byteLength);
            this.buffer.set(src.subarray(0, n), this.bufferLength);
            this.bufferLength += n;
            src = src.subarray(n);
            if (this.bufferLength === this.buffer.length) {
                await this.flush();
            }
        }
    }

    abort(): void {
        if (this.aborted) return;
        this.aborted = true;
        // Fire-and-forget cleanup; close() awaits this if it is in flight.
        this.abortPromise = (async () => {
            try {
                const id = await this.openPromise;
                await window.electronAPI!.writeStreamClose(id);
                await window.electronAPI!.unlink(this.filePath);
            } catch {
                // best-effort cleanup
            }
        })();
    }

    async close(): Promise<void> {
        if (this.abortPromise) {
            await this.abortPromise;
            return;
        }
        if (this.aborted) return;
        await this.flush();
        const id = await this.openPromise;
        await window.electronAPI!.writeStreamClose(id);
    }
}

/**
 * FileSystem writing a single file at an absolute path (chosen with the
 * native save dialog) via the streaming write IPC. `createWriter` ignores
 * the requested filename — the output path was already fixed at creation.
 */
class ElectronFileSystem implements FileSystem {
    private filePath: string;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    createWriter(_filename: string): Writer {
        return new ElectronFileWriter(this.filePath);
    }

    mkdir(_path: string): Promise<void> {
        return Promise.resolve();
    }
}

export { ElectronFileSystem };
