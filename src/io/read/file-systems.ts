/**
 * File system implementations for reading splat data from various sources.
 */

import {
    BufferedReadStream,
    ReadFileSystem,
    ReadSource,
    ReadStream,
    UrlReadFileSystem
} from '@playcanvas/splat-transform';

// Read blob in 4MB chunks to balance async overhead vs memory usage
const BLOB_CHUNK_SIZE = 4 * 1024 * 1024;

/** Chunk size for caching — balances allocation count vs memory waste */
const CACHE_CHUNK_SIZE = 64 * 1024 * 1024;

/**
 * ReadStream that transparently caches all bytes passing through it.
 * Used to collect compressed data for instant re-save while streaming
 * to the decompressor — avoids a separate read pass.
 *
 * Accumulates data into 64MB chunks (matching the previous batch-read
 * approach) to minimize ArrayBuffer allocation count and avoid memory
 * fragmentation that triggers "Array buffer allocation failed".
 */
class TeeReadStream extends ReadStream {
    private inner: ReadStream;
    private chunks: Uint8Array[];
    private buf: Uint8Array;
    private offset = 0;

    constructor(inner: ReadStream, chunks: Uint8Array[]) {
        super(inner.expectedSize);
        this.inner = inner;
        this.chunks = chunks;
        this.buf = new Uint8Array(CACHE_CHUNK_SIZE);
    }

    async pull(target: Uint8Array): Promise<number> {
        const n = await this.inner.pull(target);
        if (n > 0) {
            this.bytesRead += n;
            let srcOffset = 0;
            while (srcOffset < n) {
                const space = CACHE_CHUNK_SIZE - this.offset;
                const copy = Math.min(n - srcOffset, space);
                this.buf.set(target.subarray(srcOffset, srcOffset + copy), this.offset);
                this.offset += copy;
                srcOffset += copy;
                if (this.offset >= CACHE_CHUNK_SIZE) {
                    this.chunks.push(this.buf);
                    this.buf = new Uint8Array(CACHE_CHUNK_SIZE);
                    this.offset = 0;
                }
            }
        }
        return n;
    }

    close(): void {
        if (this.offset > 0) {
            this.chunks.push(this.buf.subarray(0, this.offset));
        }
        this.inner.close();
    }
}

/**
 * ReadStream that decompresses data on-the-fly using browser DecompressionStream.
 * Avoids loading the entire decompressed file into memory.
 */
class DecompressingReadStream extends ReadStream {
    private reader: ReadableStreamDefaultReader<Uint8Array>;
    private currentChunk: Uint8Array | null = null;
    private chunkOffset = 0;
    private done = false;

    constructor(compressedSource: ReadSource, algo: string) {
        // size is unknown when decompressing
        super(undefined);

        const ds = new DecompressionStream(algo as any);
        const dsWriter = ds.writable.getWriter();
        const dsReader = ds.readable.getReader();

        this.reader = dsReader;

        // feed compressed data into the decompression stream in the background
        const feed = (async () => {
            const stream = compressedSource.read();
            const buf = new Uint8Array(BLOB_CHUNK_SIZE);
            while (true) {
                const bytesRead = await stream.pull(buf);
                if (bytesRead === 0) break;
                await dsWriter.write(buf.subarray(0, bytesRead) as unknown as ArrayBuffer);
                this.bytesRead += bytesRead;
            }
            await dsWriter.close();
        })();

        // store the feed promise so errors propagate
        this._feedPromise = feed;
    }

    private _feedPromise: Promise<void>;

    async pull(target: Uint8Array): Promise<number> {
        if (this.done) return 0;

        let totalWritten = 0;

        while (totalWritten < target.length) {
            // if we have a partially consumed chunk, use it first
            if (this.currentChunk && this.chunkOffset < this.currentChunk.length) {
                const remaining = this.currentChunk.length - this.chunkOffset;
                const toCopy = Math.min(remaining, target.length - totalWritten);
                target.set(this.currentChunk.subarray(this.chunkOffset, this.chunkOffset + toCopy), totalWritten);
                this.chunkOffset += toCopy;
                totalWritten += toCopy;
                continue;
            }

            // read next decompressed chunk
            const { done, value } = await this.reader.read();
            if (done) {
                this.done = true;
                break;
            }

            this.currentChunk = value;
            this.chunkOffset = 0;
        }

        return totalWritten;
    }
}

/**
 * ReadStream implementation for reading from Blob/File.
 */
class BlobReadStream extends ReadStream {
    private blob: Blob;
    private offset: number;
    private end: number;

    constructor(blob: Blob, start: number, end: number) {
        super(end - start);
        this.blob = blob;
        this.offset = start;
        this.end = end;
    }

    async pull(target: Uint8Array): Promise<number> {
        const remaining = this.end - this.offset;
        if (remaining <= 0) {
            return 0;
        }

        const bytesToRead = Math.min(target.length, remaining);
        const slice = this.blob.slice(this.offset, this.offset + bytesToRead);
        const arrayBuffer = await slice.arrayBuffer();
        target.set(new Uint8Array(arrayBuffer));
        this.offset += bytesToRead;
        this.bytesRead += bytesToRead;
        return bytesToRead;
    }
}

/**
 * ReadSource implementation for Blob/File.
 */
class BlobReadSource implements ReadSource {
    readonly size: number;
    readonly seekable: boolean = true;

    private blob: Blob;
    private closed: boolean = false;

    constructor(blob: Blob) {
        this.blob = blob;
        this.size = blob.size;
    }

    read(start: number = 0, end: number = this.size): ReadStream {
        if (this.closed) {
            throw new Error('Source has been closed');
        }

        const clampedStart = Math.max(0, Math.min(start, this.size));
        const clampedEnd = Math.max(clampedStart, Math.min(end, this.size));

        // Wrap with BufferedReadStream to reduce async overhead from blob reads
        const raw = new BlobReadStream(this.blob, clampedStart, clampedEnd);
        return new BufferedReadStream(raw, BLOB_CHUNK_SIZE);
    }

    close(): void {
        this.closed = true;
    }
}

/**
 * ReadSource that transparently decompresses data from a compressed source.
 * Streams decompression to avoid loading the entire decompressed file into memory.
 */
class DecompressingReadSource implements ReadSource {
    readonly size: number = 0;  // unknown size after decompression
    readonly seekable: boolean = false;

    private compressedSource: ReadSource;
    private algo: string;

    constructor(compressedSource: ReadSource, algo: string) {
        this.compressedSource = compressedSource;
        this.algo = algo;
    }

    read(): ReadStream {
        return new BufferedReadStream(
            new DecompressingReadStream(this.compressedSource, this.algo),
            BLOB_CHUNK_SIZE
        );
    }

    close(): void {
        this.compressedSource.close();
    }
}

/**
 * ReadFileSystem for reading from browser File/Blob objects.
 * Used for drag & drop and file picker scenarios.
 */
class BlobReadFileSystem implements ReadFileSystem {
    private files: Map<string, Blob> = new Map();

    /**
     * Add a file to the file system.
     */
    set(name: string, blob: Blob): void {
        this.files.set(name.toLowerCase(), blob);
    }

    /**
     * Get a file by name.
     */
    get(name: string): Blob | undefined {
        return this.files.get(name.toLowerCase());
    }

    createSource(filename: string): Promise<ReadSource> {
        const blob = this.files.get(filename.toLowerCase());
        if (!blob) {
            return Promise.reject(new Error(`File not found: ${filename}`));
        }
        return Promise.resolve(new BlobReadSource(blob));
    }
}

/**
 * ReadFileSystem that combines URL-based loading with local file storage.
 * Used for multi-file formats (SOG, LCC) where some files may be local
 * and others may need to be fetched from URLs.
 */
class MappedReadFileSystem implements ReadFileSystem {
    private blobFs: BlobReadFileSystem;
    private urlFs: UrlReadFileSystem;

    constructor(baseUrl?: string) {
        this.blobFs = new BlobReadFileSystem();
        this.urlFs = new UrlReadFileSystem(baseUrl);
    }

    /**
     * Add a local file.
     */
    addFile(name: string, blob: Blob): void {
        this.blobFs.set(name, blob);
    }

    async createSource(filename: string): Promise<ReadSource> {
        // First check if we have a local blob
        const localBlob = this.blobFs.get(filename);
        if (localBlob) {
            return new BlobReadSource(localBlob);
        }

        // Fall back to URL loading
        return await this.urlFs.createSource(filename);
    }
}

export {
    BlobReadSource,
    DecompressingReadSource,
    MappedReadFileSystem,
    TeeReadStream
};
