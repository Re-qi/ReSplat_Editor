/**
 * Extract a gzip-compressed PLY stored in a .respproj ZIP archive directly to
 * a temporary file. Keeping this in the main process prevents the renderer
 * from materialising both the compressed and decompressed multi-GB payload.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

const findEocdOffset = (buffer) => {
    for (let offset = buffer.length - 22; offset >= 0; offset--) {
        if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
    }
    throw new Error('Invalid project archive: end of central directory not found');
};

const readZipEntry = async (archivePath, entryName) => {
    const { size } = await fsp.stat(archivePath);
    const tailSize = Math.min(size, 65536 + 22);
    const tail = Buffer.alloc(tailSize);
    const handle = await fsp.open(archivePath, 'r');

    try {
        await handle.read(tail, 0, tailSize, size - tailSize);
        const eocd = findEocdOffset(tail);
        const entryCount = tail.readUInt16LE(eocd + 10);
        const directorySize = tail.readUInt32LE(eocd + 12);
        const directoryOffset = tail.readUInt32LE(eocd + 16);
        const directory = Buffer.alloc(directorySize);
        await handle.read(directory, 0, directorySize, directoryOffset);

        let offset = 0;
        for (let i = 0; i < entryCount; i++) {
            if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
                throw new Error('Invalid project archive: malformed central directory');
            }
            const flags = directory.readUInt16LE(offset + 8);
            const compressionMethod = directory.readUInt16LE(offset + 10);
            const compressedSize = directory.readUInt32LE(offset + 20);
            const nameLength = directory.readUInt16LE(offset + 28);
            const extraLength = directory.readUInt16LE(offset + 30);
            const commentLength = directory.readUInt16LE(offset + 32);
            const localHeaderOffset = directory.readUInt32LE(offset + 42);
            const encoding = (flags & 0x800) !== 0 ? 'utf8' : 'ascii';
            const name = directory.toString(encoding, offset + 46, offset + 46 + nameLength);

            if (name === entryName) {
                const localHeader = Buffer.alloc(30);
                await handle.read(localHeader, 0, localHeader.length, localHeaderOffset);
                if (localHeader.readUInt32LE(0) !== LOCAL_FILE_SIGNATURE) {
                    throw new Error('Invalid project archive: malformed local file header');
                }
                const localNameLength = localHeader.readUInt16LE(26);
                const localExtraLength = localHeader.readUInt16LE(28);
                return {
                    compressionMethod,
                    compressedSize,
                    dataOffset: localHeaderOffset + 30 + localNameLength + localExtraLength
                };
            }
            offset += 46 + nameLength + extraLength + commentLength;
        }
    } finally {
        await handle.close();
    }

    throw new Error(`Invalid project archive: entry "${entryName}" not found`);
};

const extractGzipProjectEntry = async (archivePath, entryName, outputDir) => {
    const entry = await readZipEntry(archivePath, entryName);
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod}`);
    }

    await fsp.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.ply`);
    const input = fs.createReadStream(archivePath, {
        start: entry.dataOffset,
        end: entry.dataOffset + entry.compressedSize - 1
    });
    const transforms = entry.compressionMethod === 8 ? [zlib.createInflateRaw()] : [];

    try {
        await pipeline(input, ...transforms, zlib.createGunzip(), fs.createWriteStream(outputPath, { flags: 'wx' }));
        const { size } = await fsp.stat(outputPath);
        return { path: outputPath, size };
    } catch (error) {
        await fsp.rm(outputPath, { force: true }).catch(() => {});
        throw error;
    }
};

module.exports = { extractGzipProjectEntry };
