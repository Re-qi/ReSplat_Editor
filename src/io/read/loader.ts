/**
 * Unified loader for all splat file formats using splat-transform.
 */

import {
    getInputFormat,
    readFile,
    sortMortonOrder,
    Column,
    ColumnType,
    DataTable,
    Options,
    ReadFileSystem,
    Transform,
    WebPCodec,
    ZipReadFileSystem
} from '@playcanvas/splat-transform';
import { GSplatData } from 'playcanvas';

type LoadResult = {
    gsplatData: GSplatData;
    transform: Transform;
};

/** Error thrown when a SOG file exceeds the safe memory threshold */
class SOGTooLargeError extends Error {
    count: number;
    constructor(message: string, count: number) {
        super(message);
        this.name = 'SOGTooLargeError';
        this.count = count;
    }
}

/**
 * Default options for readFile.
 */
const defaultOptions: Options = {
    iterations: 10,
    lodSelect: [0],
    unbundled: false,
    lodChunkCount: 512,
    lodChunkExtent: 16
};

/**
 * Map splat-transform column types to GSplatData property types.
 */
const columnTypeToGSplatType = (colType: ColumnType | null): string => {
    switch (colType) {
        case 'int8': return 'char';
        case 'uint8': return 'uchar';
        case 'int16': return 'short';
        case 'uint16': return 'ushort';
        case 'int32': return 'int';
        case 'uint32': return 'uint';
        case 'float32': return 'float';
        case 'float64': return 'double';
        default: return 'float';
    }
};

/**
 * Convert a splat-transform DataTable to PlayCanvas GSplatData.
 */
const dataTableToGSplatData = (dataTable: DataTable): GSplatData => {
    const properties = dataTable.columns.map((col: Column) => ({
        type: columnTypeToGSplatType(col.dataType),
        name: col.name,
        storage: col.data,
        byteSize: col.data.BYTES_PER_ELEMENT
    }));

    const gsplatData = new GSplatData([{
        name: 'vertex',
        count: dataTable.numRows,
        properties
    }]);

    // Support loading 2D splats by adding scale_2 property with almost 0 scale
    if (gsplatData.getProp('scale_0') && gsplatData.getProp('scale_1') && !gsplatData.getProp('scale_2')) {
        const scale2 = new Float32Array(gsplatData.numSplats).fill(Math.log(1e-6));
        gsplatData.addProp('scale_2', scale2);

        // Place the new scale_2 property just after scale_1
        const props = gsplatData.getElement('vertex').properties;
        props.splice(props.findIndex((prop: any) => prop.name === 'scale_1') + 1, 0, props.splice(props.length - 1, 1)[0]);
    }

    return gsplatData;
};

/**
 * Estimated memory needed per gaussian for the core Float32Array columns
 * (14 columns: x,y,z, scale_0-2, f_dc_0-2, opacity, rot_0-3 = 14 × 4 bytes)
 * Plus ~1.5x overhead for WebP decode buffers and temporary allocations.
 */
const BYTES_PER_GAUSSIAN_ESTIMATE = 14 * 4 * 1.5; // ~84 bytes per gaussian (SOG default)
const BYTES_PER_PLY_PROPERTY = 4; // float32 = 4 bytes each
const PEAK_MEMORY_FACTOR = 2.5; // file + parsed + overhead

/** Thresholds for SOG file size warnings (in gaussians) */
const SOG_WARN_COUNT = 15_000_000;   // ~1.5 GB — show a warning
const SOG_BLOCK_COUNT = 30_000_000;  // ~3.0 GB — block and require confirmation

/**
 * Read meta.json from a bundled SOG file and return the gaussian count.
 * This is a lightweight check before the full load.
 */
const getSOGCount = async (source: ReadFileSystem, zipFs: ZipReadFileSystem): Promise<number> => {
    const metaBytes = await (await zipFs.createSource('meta.json')).read().readAll();
    const rawMeta = JSON.parse(new TextDecoder().decode(metaBytes));
    return rawMeta.count ?? rawMeta.numPoints ?? 0;
};

/**
 * Load a file using splat-transform and convert to GSplatData.
 * @param filename - The filename to load
 * @param fileSystem - The file system to read from
 * @param skipReorder - Skip morton reordering (for files already in morton order or animation playback)
 */
const loadGSplatData = async (filename: string, fileSystem: ReadFileSystem, skipReorder?: boolean): Promise<LoadResult> => {
    const inputFormat = getInputFormat(filename);
    const lowerFilename = filename.toLowerCase();

    // Handle bundled SOG (.sog extension) - wrap with ZipReadFileSystem
    if (inputFormat === 'sog' && lowerFilename.endsWith('.sog')) {
        const source = await fileSystem.createSource(filename);
        const zipFs = new ZipReadFileSystem(source);
        try {
            const tables = await readFile({
                filename: 'meta.json',
                inputFormat: 'sog',
                options: defaultOptions,
                params: [],
                fileSystem: zipFs
            });
            return { gsplatData: dataTableToGSplatData(tables[0]), transform: tables[0].transform };
        } finally {
            zipFs.close();
        }
    }

    // Read the file using splat-transform
    const tables = await readFile({
        filename,
        inputFormat,
        options: defaultOptions,
        params: [],
        fileSystem
    });

    // Reorder data into morton order for better render performance.
    // Skip reordering for:
    // - SOG format (already in morton order)
    // - Compressed PLY (already in morton order from write-compressed-ply)
    // - When skipReorder is true (ssproj files are already ordered, animation frames need speed)
    const isCompressedPly = lowerFilename.endsWith('.compressed.ply');
    if (inputFormat !== 'sog' && !isCompressedPly && !skipReorder) {
        const indices = new Uint32Array(tables[0].numRows);
        for (let i = 0; i < indices.length; i++) {
            indices[i] = i;
        }
        sortMortonOrder(tables[0], indices);
        tables[0].permuteRowsInPlace(indices);
    }

    // Convert to GSplatData (use first table, as most formats return single table)
    // LCC may return multiple tables for different LOD levels - we use the first (highest detail)
    return { gsplatData: dataTableToGSplatData(tables[0]), transform: tables[0].transform };
};

// ---- Stride-sampled SOG loader (for decimating large files during load) ----

// Replicated from @playcanvas/splat-transform internals — not exported publicly.
const invLogTransform = (v: number): number => {
    const a = Math.abs(v);
    const e = Math.exp(a) - 1;
    return v < 0 ? -e : e;
};

const unpackQuat = (px: number, py: number, pz: number, tag: number): [number, number, number, number] => {
    const maxComp = tag - 252;
    const a = px / 255 * 2 - 1;
    const b = py / 255 * 2 - 1;
    const c = pz / 255 * 2 - 1;
    const sqrt2 = Math.SQRT2;
    const comps = [0, 0, 0, 0];
    const idx = [
        [1, 2, 3],
        [0, 2, 3],
        [0, 1, 3],
        [0, 1, 2]
    ][maxComp];
    comps[idx[0]] = a / sqrt2;
    comps[idx[1]] = b / sqrt2;
    comps[idx[2]] = c / sqrt2;
    const t = 1 - (comps[0] ** 2 + comps[1] ** 2 + comps[2] ** 2 + comps[3] ** 2);
    comps[maxComp] = Math.sqrt(Math.max(0, t));
    return comps as [number, number, number, number];
};

const sigmoidInv = (y: number): number => {
    const e = Math.min(1 - 1e-6, Math.max(1e-6, y));
    return Math.log(e / (1 - e));
};

/**
 * Load a SOG file with stride sampling to reduce gaussian count during loading.
 *
 * Unlike `loadGSplatData` which allocates columns for ALL gaussians and OOMs
 * on large files, this function decodes the WebP textures normally but only
 * samples every Nth gaussian, allocating columns for `count / stride` elements.
 *
 * @param filename - Path to the .sog file
 * @param fileSystem - File system to read from
 * @param decimatePercent - Percentage of gaussians to keep (1-100)
 */
const loadSogDecimated = async (
    filename: string,
    fileSystem: ReadFileSystem,
    decimatePercent: number
): Promise<LoadResult> => {
    const source = await fileSystem.createSource(filename);
    const zipFs = new ZipReadFileSystem(source);
    try {
        // 1. Read meta.json
        const metaBytes = await (await zipFs.createSource('meta.json')).read().readAll();
        const meta = JSON.parse(new TextDecoder().decode(metaBytes));
        const originalCount: number = meta.count;

        if (meta.version !== 2) {
            throw new Error(`Stride-sampled SOG loading only supports version 2, got ${meta.version}`);
        }

        // 2. Calculate target count and stride
        const targetCount = Math.max(1, Math.floor(originalCount * decimatePercent / 100));
        const stride = Math.max(1, Math.floor(originalCount / targetCount));
        const actualCount = Math.ceil(originalCount / stride);

        // 3. Allocate columns at target size
        const columns = [
            new Column('x', new Float32Array(actualCount)),
            new Column('y', new Float32Array(actualCount)),
            new Column('z', new Float32Array(actualCount)),
            new Column('scale_0', new Float32Array(actualCount)),
            new Column('scale_1', new Float32Array(actualCount)),
            new Column('scale_2', new Float32Array(actualCount)),
            new Column('f_dc_0', new Float32Array(actualCount)),
            new Column('f_dc_1', new Float32Array(actualCount)),
            new Column('f_dc_2', new Float32Array(actualCount)),
            new Column('opacity', new Float32Array(actualCount)),
            new Column('rot_0', new Float32Array(actualCount)),
            new Column('rot_1', new Float32Array(actualCount)),
            new Column('rot_2', new Float32Array(actualCount)),
            new Column('rot_3', new Float32Array(actualCount))
        ];

        // 4. Helper: read file bytes from ZIP
        const load = async (name: string): Promise<Uint8Array> => {
            const src = await zipFs.createSource(name);
            try {
                return await src.read().readAll();
            } finally {
                src.close();
            }
        };

        // 5. Decode WebP images
        const decoder = await WebPCodec.create();

        // --- means ---
        const meansLoWebp = await load(meta.means.files[0]);
        const meansHiWebp = await load(meta.means.files[1]);
        const { rgba: lo, width, height } = decoder.decodeRGBA(meansLoWebp);
        const { rgba: hi } = decoder.decodeRGBA(meansHiWebp);
        if (width * height < originalCount) {
            throw new Error('SOG means texture too small for count');
        }
        const { mins, maxs } = meta.means;
        const xCol = columns[0].data;
        const yCol = columns[1].data;
        const zCol = columns[2].data;
        const xMin = mins[0], xScale = (maxs[0] - mins[0]) || 1;
        const yMin = mins[1], yScale = (maxs[1] - mins[1]) || 1;
        const zMin = mins[2], zScale = (maxs[2] - mins[2]) || 1;
        for (let i = 0, t = 0; i < originalCount && t < actualCount; i += stride, t++) {
            const o = i * 4;
            const x16 = lo[o] | (hi[o] << 8);
            const y16 = lo[o + 1] | (hi[o + 1] << 8);
            const z16 = lo[o + 2] | (hi[o + 2] << 8);
            xCol[t] = invLogTransform(xMin + xScale * (x16 / 65535));
            yCol[t] = invLogTransform(yMin + yScale * (y16 / 65535));
            zCol[t] = invLogTransform(zMin + zScale * (z16 / 65535));
        }

        // --- quats ---
        const quatsWebp = await load(meta.quats.files[0]);
        const { rgba: qr, width: qw, height: qh } = decoder.decodeRGBA(quatsWebp);
        if (qw * qh < originalCount) {
            throw new Error('SOG quats texture too small for count');
        }
        const r0 = columns[10].data;
        const r1 = columns[11].data;
        const r2 = columns[12].data;
        const r3 = columns[13].data;
        for (let i = 0, t = 0; i < originalCount && t < actualCount; i += stride, t++) {
            const o = i * 4;
            const tag = qr[o + 3];
            if (tag < 252 || tag > 255) {
                r0[t] = 1; r1[t] = 0; r2[t] = 0; r3[t] = 0;
                continue;
            }
            const [w, x, y, z] = unpackQuat(qr[o], qr[o + 1], qr[o + 2], tag);
            r0[t] = w; r1[t] = x; r2[t] = y; r3[t] = z;
        }

        // --- scales ---
        const scalesWebp = await load(meta.scales.files[0]);
        const { rgba: sl, width: sw, height: sh } = decoder.decodeRGBA(scalesWebp);
        if (sw * sh < originalCount) {
            throw new Error('SOG scales texture too small for count');
        }
        const sCode = new Float32Array(meta.scales.codebook);
        const s0 = columns[3].data;
        const s1 = columns[4].data;
        const s2 = columns[5].data;
        for (let i = 0, t = 0; i < originalCount && t < actualCount; i += stride, t++) {
            const o = i * 4;
            s0[t] = sCode[sl[o]];
            s1[t] = sCode[sl[o + 1]];
            s2[t] = sCode[sl[o + 2]];
        }

        // --- sh0 ---
        const sh0Webp = await load(meta.sh0.files[0]);
        const { rgba: c0, width: cw, height: ch } = decoder.decodeRGBA(sh0Webp);
        if (cw * ch < originalCount) {
            throw new Error('SOG sh0 texture too small for count');
        }
        const cCode = new Float32Array(meta.sh0.codebook);
        const dc0 = columns[6].data;
        const dc1 = columns[7].data;
        const dc2 = columns[8].data;
        const opCol = columns[9].data;
        for (let i = 0, t = 0; i < originalCount && t < actualCount; i += stride, t++) {
            const o = i * 4;
            dc0[t] = cCode[c0[o]];
            dc1[t] = cCode[c0[o + 1]];
            dc2[t] = cCode[c0[o + 2]];
            opCol[t] = sigmoidInv(c0[o + 3] / 255);
        }

        // --- shN (skip for stride-sampled: adds many columns per gaussian) ---
        if (meta.shN && meta.shN.bands > 0) {
            console.warn('[ReSplat] Stride-sampled SOG: skipping shN bands — they will be missing from the result');
        }

        const dataTable = new DataTable(columns, Transform.PLY);
        return { gsplatData: dataTableToGSplatData(dataTable), transform: dataTable.transform };
    } finally {
        zipFs.close();
    }
};

/**
 * Read meta.json from a bundled SOG file to get the gaussian count and metadata.
 * Returns null if the file can't be read.
 */
const readSogMeta = async (fileSystem: ReadFileSystem, filename: string): Promise<{ count: number; estMemMB: number } | null> => {
    let source;
    try {
        source = await fileSystem.createSource(filename);
        const zipFs = new ZipReadFileSystem(source);
        try {
            const metaBytes = await (await zipFs.createSource('meta.json')).read().readAll();
            const meta = JSON.parse(new TextDecoder().decode(metaBytes));
            const count = meta.count ?? 0;
            const estMemMB = Math.round(count * BYTES_PER_GAUSSIAN_ESTIMATE / (1024 * 1024));
            return { count, estMemMB };
        } finally {
            zipFs.close();
        }
    } catch {
        source?.close?.();
        return null;
    }
};

/**
 * Read a PLY file header to get the vertex count without loading the entire file.
 * Returns null if the file can't be read or isn't a valid PLY file.
 */
const readPlyMeta = async (fileSystem: ReadFileSystem, filename: string): Promise<{ count: number; estMemMB: number } | null> => {
    let source;
    try {
        source = await fileSystem.createSource(filename);
        try {
            // Read only the header (~8 KB) to avoid loading the entire file
            let stream;
            if (source.seekable && source.size && source.size > 8192) {
                stream = source.read(0, 8192);
            } else {
                stream = source.read();
            }
            const headerBytes = await stream.readAll();
            const header = new TextDecoder().decode(headerBytes);
            const endIdx = header.indexOf('end_header');
            if (endIdx < 0) return null;

            const headerSection = header.substring(0, endIdx);
            const match = headerSection.match(/element\s+vertex\s+(\d+)/i);
            if (!match) return null;

            // Count properties to get accurate bytes-per-gaussian estimate
            const propertyMatches = headerSection.match(/\bproperty\b/g);
            const numProperties = propertyMatches ? propertyMatches.length : 14;

            const count = parseInt(match[1], 10);
            // Peak memory ≈ numProperties × count × 4 bytes × 2.5 (file copy + parsed + overhead)
            const estMemMB = Math.round(count * numProperties * BYTES_PER_PLY_PROPERTY * PEAK_MEMORY_FACTOR / (1024 * 1024));
            return { count, estMemMB };
        } finally {
            source.close();
        }
    } catch {
        source?.close?.();
        return null;
    }
};

/**
 * Validate that GSplatData contains required properties.
 */
const validateGSplatData = (gsplatData: GSplatData): void => {
    const required = [
        'x', 'y', 'z',
        'scale_0', 'scale_1', 'scale_2',
        'rot_0', 'rot_1', 'rot_2', 'rot_3',
        'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'
    ];

    const missing = required.filter(x => !gsplatData.getProp(x));
    if (missing.length > 0) {
        throw new Error(`This file does not contain gaussian splatting data. The following properties are missing: ${missing.join(', ')}`);
    }
};

export {
    loadGSplatData,
    loadSogDecimated,
    readSogMeta,
    readPlyMeta,
    validateGSplatData,
    SOGTooLargeError,
    getSOGCount,
    SOG_WARN_COUNT,
    SOG_BLOCK_COUNT,
    BYTES_PER_GAUSSIAN_ESTIMATE
};
