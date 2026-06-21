/**
 * PLY file float32 precision fixer.
 * Centers coordinates by median and clips extreme outliers to ±5000.
 * Fixes depth sorting flickering caused by large coordinate values exceeding float32 precision.
 */

import { Events } from './events';
import { GSplatData } from 'playcanvas';
import { MemoryFileSystem } from '@playcanvas/splat-transform';
import { serializePly } from './splat-serialize';
import { Splat } from './splat';
import { localize } from './ui/localization';

const CLIP_BOUND = 5000.0;

const median = (arr: number[]): number => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Fix GSplatData in-place by centering coordinates and clipping outliers.
 * Returns the original GSplatData with modified x/y/z properties.
 */
const fixSplatData = (gsplatData: GSplatData): {
    vertexCount: number;
    clippedCount: number;
} => {
    const numSplats = gsplatData.numSplats;
    const xProp = gsplatData.getProp('x') as Float32Array;
    const yProp = gsplatData.getProp('y') as Float32Array;
    const zProp = gsplatData.getProp('z') as Float32Array;

    if (!xProp || !yProp || !zProp) {
        throw new Error('Splat data does not contain x, y, z properties.');
    }

    // Compute median using sampling
    const sampleSize = Math.min(numSplats, 500000);
    const step = Math.max(1, Math.floor(numSplats / sampleSize));
    const samplesX: number[] = [];
    const samplesY: number[] = [];
    const samplesZ: number[] = [];

    for (let i = 0; i < numSplats; i += step) {
        samplesX.push(xProp[i]);
        samplesY.push(yProp[i]);
        samplesZ.push(zProp[i]);
    }

    const cx = median(samplesX);
    const cy = median(samplesY);
    const cz = median(samplesZ);

    // Center and clip
    let clippedCount = 0;
    for (let i = 0; i < numSplats; i++) {
        let x = xProp[i] - cx;
        let y = yProp[i] - cy;
        let z = zProp[i] - cz;

        let clipped = false;
        if (x < -CLIP_BOUND) { x = -CLIP_BOUND; clipped = true; }
        if (x > CLIP_BOUND) { x = CLIP_BOUND; clipped = true; }
        if (y < -CLIP_BOUND) { y = -CLIP_BOUND; clipped = true; }
        if (y > CLIP_BOUND) { y = CLIP_BOUND; clipped = true; }
        if (z < -CLIP_BOUND) { z = -CLIP_BOUND; clipped = true; }
        if (z > CLIP_BOUND) { z = CLIP_BOUND; clipped = true; }

        if (clipped) clippedCount++;

        xProp[i] = x;
        yProp[i] = y;
        zProp[i] = z;
    }

    return { vertexCount: numSplats, clippedCount };
};

/**
 * Parse PLY binary header and return header bytes + metadata.
 */
const parsePlyHeader = (buffer: ArrayBuffer): {
    headerBytes: number;
    vertexCount: number;
    propertyNames: string[];
    allFloat: boolean;
} => {
    const view = new Uint8Array(buffer);

    let headerEnd = -1;
    const needle = new TextEncoder().encode('end_header');
    for (let i = 0; i < view.length - needle.length; i++) {
        let match = true;
        for (let j = 0; j < needle.length; j++) {
            if (view[i + j] !== needle[j]) {
                match = false;
                break;
            }
        }
        if (match) {
            for (let k = i + needle.length; k < view.length; k++) {
                if (view[k] === 0x0a) {
                    headerEnd = k + 1;
                    break;
                }
            }
            break;
        }
    }

    if (headerEnd < 0) {
        throw new Error('Invalid PLY file: end_header not found');
    }

    const headerStr = new TextDecoder().decode(view.subarray(0, headerEnd));
    const lines = headerStr.split(/\r?\n/);

    let vertexCount = 0;
    const propertyNames: string[] = [];
    let allFloat = true;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('element vertex')) {
            vertexCount = parseInt(trimmed.split(/\s+/)[2], 10);
        } else if (trimmed.startsWith('property')) {
            const parts = trimmed.split(/\s+/);
            const type = parts[1];
            const name = parts[2];
            propertyNames.push(name);
            if (type !== 'float' && type !== 'float32') {
                allFloat = false;
            }
        }
    }

    return { headerBytes: headerEnd, vertexCount, propertyNames, allFloat };
};

/**
 * Fix a PLY file's float32 precision by centering coordinates and clipping outliers.
 * Returns a new File with fixed data.
 */
const fixPlyFile = async (file: File): Promise<File> => {
    const buffer = await file.arrayBuffer();
    const header = parsePlyHeader(buffer);
    const { headerBytes, vertexCount, propertyNames, allFloat } = header;

    if (!allFloat) {
        throw new Error('Only float32 PLY files are supported.');
    }

    const propCount = propertyNames.length;
    const dataBytes = vertexCount * propCount * 4;
    const expectedBytes = headerBytes + dataBytes;

    if (buffer.byteLength < expectedBytes) {
        throw new Error(`PLY file truncated: expected ${expectedBytes} bytes, got ${buffer.byteLength}`);
    }

    const xIdx = propertyNames.indexOf('x');
    const yIdx = propertyNames.indexOf('y');
    const zIdx = propertyNames.indexOf('z');
    if (xIdx < 0 || yIdx < 0 || zIdx < 0) {
        throw new Error('PLY file does not contain x, y, z properties.');
    }

    const srcData = new Float32Array(buffer, headerBytes, vertexCount * propCount);
    const data = new Float32Array(srcData);

    // Compute median using sampling
    const sampleSize = Math.min(vertexCount, 500000);
    const step = Math.max(1, Math.floor(vertexCount / sampleSize));
    const samplesX: number[] = [];
    const samplesY: number[] = [];
    const samplesZ: number[] = [];

    for (let i = 0; i < vertexCount; i += step) {
        const base = i * propCount;
        samplesX.push(data[base + xIdx]);
        samplesY.push(data[base + yIdx]);
        samplesZ.push(data[base + zIdx]);
    }

    const cx = median(samplesX);
    const cy = median(samplesY);
    const cz = median(samplesZ);

    // Center and clip
    for (let i = 0; i < vertexCount; i++) {
        const base = i * propCount;
        let x = data[base + xIdx] - cx;
        let y = data[base + yIdx] - cy;
        let z = data[base + zIdx] - cz;

        if (x < -CLIP_BOUND) x = -CLIP_BOUND;
        if (x > CLIP_BOUND) x = CLIP_BOUND;
        if (y < -CLIP_BOUND) y = -CLIP_BOUND;
        if (y > CLIP_BOUND) y = CLIP_BOUND;
        if (z < -CLIP_BOUND) z = -CLIP_BOUND;
        if (z > CLIP_BOUND) z = CLIP_BOUND;

        data[base + xIdx] = x;
        data[base + yIdx] = y;
        data[base + zIdx] = z;
    }

    // Build output: new header + data
    const headerStr = new TextDecoder().decode(new Uint8Array(buffer, 0, headerBytes));
    const headerLines = headerStr.split('\n');
    const newHeaderLines = [
        headerLines[0],
        `comment original_cx ${cx}`,
        `comment original_cy ${cy}`,
        `comment original_cz ${cz}`,
        `comment clip_bound ${CLIP_BOUND}`,
        ...headerLines.slice(1)
    ];
    const newHeaderBytes = new TextEncoder().encode(newHeaderLines.join('\n'));

    const outBuffer = new ArrayBuffer(newHeaderBytes.length + data.byteLength);
    const outView = new Uint8Array(outBuffer);
    outView.set(newHeaderBytes);
    outView.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), newHeaderBytes.length);

    const baseName = file.name.replace(/\.ply$/i, '');
    return new File([outBuffer], `${baseName}_fixed.ply`, { type: 'application/octet-stream' });
};

/**
 * Register PLY fixer events.
 */
const registerPlyFixerEvents = (events: Events) => {
    events.function('ply.fix', async () => {
        const result = await events.invoke('show.fixPlyDialog');
        if (!result) {
            return;
        }

        events.fire('startSpinner');

        try {
            if (result.source === 'current' && result.splat) {
                const splat = result.splat as Splat;
                const baseName = splat.name.replace(/\.ply$/i, '');
                const fixedFilename = `${baseName}_fixed.ply`;

                // Fix the currently loaded splat in-place
                const stats = fixSplatData(splat.splatData);

                // Serialize the fixed splat to PLY in memory
                const memFs = new MemoryFileSystem();
                await serializePly([splat], {}, memFs, fixedFilename);
                const plyData = memFs.results.get(fixedFilename);
                const blob = new Blob([plyData.buffer as ArrayBuffer], { type: 'application/octet-stream' });
                const file = new File([blob], fixedFilename, { type: 'application/octet-stream' });

                // Import the fixed PLY as a new splat
                await events.invoke('import', [{
                    filename: fixedFilename,
                    contents: file
                }]);

                events.fire('stopSpinner');

                await events.invoke('showPopup', {
                    type: 'info',
                    header: localize('popup.fix-ply.header'),
                    message: `${localize('popup.fix-ply.success')}\n\nVertices: ${stats.vertexCount.toLocaleString()}, Clipped: ${stats.clippedCount.toLocaleString()}`
                });

            } else if (result.source === 'file' && result.file) {
                // Fix an external PLY file and import as new splat
                const outFile = await fixPlyFile(result.file);
                await events.invoke('import', [{
                    filename: outFile.name,
                    contents: outFile
                }]);

                events.fire('stopSpinner');

                await events.invoke('showPopup', {
                    type: 'info',
                    header: localize('popup.fix-ply.header'),
                    message: localize('popup.fix-ply.success')
                });
            }
        } catch (error: any) {
            events.fire('stopSpinner');
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('popup.error'),
                message: `${localize('popup.fix-ply.error')}: ${error.message}`
            });
        }
    });
};

export { registerPlyFixerEvents, fixSplatData, fixPlyFile };
