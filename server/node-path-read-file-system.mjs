import fs from 'node:fs';

// Seekable ReadFileSystem adapter for one local file. splat-transform's PLY
// reader requests bounded ranges, so a multi-gigabyte source never has to be
// represented by one Node Buffer (which is rejected above 2 GiB).
class NodeFileReadStream {
    constructor(fd, size, start, end) {
        this.fd = fd;
        this.start = Math.max(0, Math.min(start ?? 0, size));
        this.end = Math.max(this.start, Math.min(end ?? size, size));
        this.position = this.start;
        this.bytesRead = 0;
        this.expectedSize = this.end - this.start;
    }

    async pull(target) {
        const bytesToRead = Math.min(target.length, this.end - this.position);
        if (bytesToRead <= 0) return 0;

        return new Promise((resolve, reject) => {
            fs.read(this.fd, target, 0, bytesToRead, this.position, (error, bytesRead) => {
                if (error) {
                    reject(error);
                    return;
                }
                this.position += bytesRead;
                this.bytesRead += bytesRead;
                resolve(bytesRead);
            });
        });
    }

    async readAll() {
        const data = Buffer.allocUnsafe(this.expectedSize);
        let offset = 0;
        while (offset < data.length) {
            const bytesRead = await this.pull(data.subarray(offset));
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        return new Uint8Array(data.buffer, data.byteOffset, offset);
    }

    close() { }
}

class NodeFileReadSource {
    constructor(fd, size, onClose) {
        this.fd = fd;
        this.size = size;
        this.seekable = true;
        this.onClose = onClose;
    }

    read(start, end) {
        if (this.fd === null) throw new Error('Source has been closed');
        return new NodeFileReadStream(this.fd, this.size, start, end);
    }

    close() {
        if (this.fd === null) return;
        try {
            fs.closeSync(this.fd);
        } finally {
            this.fd = null;
            this.onClose?.(this);
        }
    }
}

class NodePathReadFileSystem {
    constructor(filePath) {
        this.filePath = filePath;
        this.sources = new Set();
        this.closed = false;
    }

    async createSource(_filename, progress) {
        if (this.closed) throw new Error('File system has been closed');
        const fd = fs.openSync(this.filePath, 'r');
        const size = fs.fstatSync(fd).size;
        const source = new NodeFileReadSource(fd, size, value => this.sources.delete(value));
        this.sources.add(source);
        progress?.(0, size);
        return source;
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        for (const source of [...this.sources]) source.close();
        this.sources.clear();
    }
}

export { NodePathReadFileSystem };
