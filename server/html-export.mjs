/**
 * HTML Viewer Export — Backend Pipeline (Node.js)
 *
 * Bundled-HTML export for scenes too large for the renderer: the browser path
 * needs scene data + extractDataTable columns + writeSog's internal chunk
 * repack + its per-layer gathers all in ONE process (~12 GB for a 15.4M×59-col
 * scene) → "Array buffer allocation failed". Here the source is read fresh in
 * a worker thread, spilled to disk, and encoded through splat-transform's
 * chunk-native `writeSource` with a LAZY ChunkSource (one 1M-row chunk in
 * memory at a time), so peak memory is the largest single layer gather
 * (~3 GB) instead of the whole scene twice over.
 *
 * The sog zip byte stream is piped through an incremental base64 encoder
 * straight into the HTML output file (prefix + payload + suffix), mirroring
 * the browser's serializeViewerHtml — peak extra memory is one encode chunk.
 *
 * NOTE: like the LCC2 backend export, the ORIGINAL source file is encoded —
 * in-scene edits (deletions/transforms) are not applied. The renderer only
 * routes here for scenes the browser path cannot hold anyway.
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

import { NodePathReadFileSystem } from './node-path-read-file-system.mjs';

// Reuse the ZIP entry extractor used by the Electron renderer path. It reads
// the archive in the main/backend process and writes a seekable temporary PLY,
// avoiding a multi-GB Buffer for .respproj sources.
const require = createRequire(import.meta.url);
const { extractGzipProjectEntry } = require('../electron/project-extractor.cjs');

// Marker the bundled viewer uses to fetch the embedded scene (same constant
// as src/splat-serialize.ts — keep in sync).
const DATA_URL_PREFIX = 'fetch("data:application/octet-stream;base64,';

// Layer column names in canonical word order (must match splat-transform's
// position/geometric/color layouts — see positionFields/geometricFields/
// colorFields in dist/index.mjs).
const POSITION_COLS = ['x', 'y', 'z'];
const GEOMETRIC_COLS = ['rot_0', 'rot_1', 'rot_2', 'rot_3', 'scale_0', 'scale_1', 'scale_2', 'opacity'];
const colorColumnNames = (shBands) => {
    const numRest = [0, 9, 24, 45][shBands] ?? 0;
    return ['f_dc_0', 'f_dc_1', 'f_dc_2', ...Array.from({ length: numRest }, (_, i) => `f_rest_${i}`)];
};

// --- Lazy disk-backed ChunkSource ------------------------------------------
// Implements the ChunkSource interface consumed by writeSogSource (via
// writeSource 'sog-bundle'): meta + read({chunkIndex, <layer>: chunkData}).
// Each read interleaves one chunk's rows from the spilled per-column files —
// never holds more than the requested chunkData buffer.
const createLazyColumnSource = (spillDir, columnMeta, numRows, chunkSize, shBands) => {
    const numChunks = Math.ceil(numRows / chunkSize);
    const colorCols = colorColumnNames(shBands);

    const layerFor = (names) => {
        // A layer is available only when the source actually has ALL of its
        // columns (mirrors dataTableToChunkSource's hasPosition/… checks).
        // Missing SH rest columns are legal (filled with zeros) as long as
        // the DC columns exist — the browser extractDataTable allocates the
        // requested band count with zeros for absent coefficients.
        return names.map(n => columnMeta[n] ?? null);
    };


    const positionFiles = layerFor(POSITION_COLS);
    const geometricFiles = layerFor(GEOMETRIC_COLS);
    const dcFiles = layerFor(['f_dc_0', 'f_dc_1', 'f_dc_2']);
    const restFiles = colorCols.slice(3).map(n => columnMeta[n] ?? null);
    const colorFiles = [...dcFiles, ...restFiles];

    const availableLayers = new Set();
    const layouts = {};
    if (positionFiles.every(Boolean)) {
        availableLayers.add('position');
        layouts.position = { stride: 12, fields: { position: { byteOffset: 0, components: 3, type: 'float32' } } };
    }
    if (geometricFiles.every(Boolean)) {
        availableLayers.add('geometric');
        layouts.geometric = {
            stride: 32,
            fields: {
                rotation: { byteOffset: 0, components: 4, type: 'float32' },
                scale: { byteOffset: 16, components: 3, type: 'float32' },
                opacity: { byteOffset: 28, components: 1, type: 'float32' }
            }
        };
    }
    if (dcFiles.every(Boolean)) {
        availableLayers.add('color');
        const stride = (3 + [0, 9, 24, 45][shBands]) * 4;
        const fields = { dc: { byteOffset: 0, components: 3, type: 'float32' } };
        if (shBands > 0) {
            fields.shRest = { byteOffset: 12, components: [0, 9, 24, 45][shBands], type: 'float32' };
        }
        layouts.color = { stride, fields };
    }
    if (availableLayers.size === 0) {
        throw new Error('html-export: source has none of the position/geometric/color layers');
    }

    // Open (and cache) a read fd per column file on first use.
    const fdCache = new Map();
    const fdFor = (file) => {
        if (file === null) return null;
        let fd = fdCache.get(file);
        if (fd === undefined) {
            fd = fs.openSync(path.join(spillDir, file), 'r');
            fdCache.set(file, fd);
        }
        return fd;
    };

    // Read buf.length bytes of column `file` at row `base`; zeros when the
    // column is absent (requested SH bands beyond the source's own).
    const readColumn = (file, base, buf) => {
        const fd = fdFor(file);
        if (fd === null) {
            buf.fill(0);
            return;
        }
        fs.readSync(fd, buf, 0, buf.length, base * 4);
    };

    let readsDone = 0;
    const readsTotal = numChunks * availableLayers.size;

    const source = {
        meta: {
            numGaussians: numRows,
            numLods: 1,
            lodCounts: [numRows],
            chunkSize,
            numChunks: [numChunks],
            shBands,
            extraColumns: [],
            transform: null, // set to Transform.PLY by the caller
            availableLayers,
            layouts
        },
        async read(request) {
            if ('indices' in request) {
                throw new Error('html-export: gather-form reads are not supported by the lazy source');
            }
            const lod = request.lod ?? 0;
            if (lod !== 0) {
                throw new Error(`html-export: unexpected LOD ${lod}`);
            }
            const { chunkIndex } = request;
            const base = chunkIndex * chunkSize;
            const count = Math.min(chunkSize, numRows - base);
            const colBuf = Buffer.allocUnsafe(count * 4);

            const fill = (chunkData, files) => {
                const words = files.length;
                const out = new Float32Array(chunkData.data, 0, count * words);
                for (let c = 0; c < words; c++) {
                    readColumn(files[c], base, colBuf);
                    const col = new Float32Array(colBuf.buffer, colBuf.byteOffset, count);
                    for (let i = 0; i < count; i++) {
                        out[i * words + c] = col[i];
                    }
                }
            };

            if (request.position) fill(request.position, positionFiles);
            if (request.geometric) fill(request.geometric, geometricFiles);
            if (request.color) fill(request.color, colorFiles);
            if (request.other) {
                throw new Error('html-export: unexpected other-layer read');
            }

            readsDone++;
            source.onRead?.(readsDone, readsTotal);
        },
        close() {
            for (const fd of fdCache.values()) {
                try { fs.closeSync(fd); } catch { /* ignore */ }
            }
            fdCache.clear();
        },
        // progress hook installed by htmlExportToPath
        onRead: null
    };

    return source;
};

// --- Incremental base64 writer ----------------------------------------------
// Wraps a Node WritableStream. Incoming chunk sizes are arbitrary, so 0-2
// remainder bytes are carried between writes to keep 3-byte group alignment;
// the concatenated output is byte-identical to whole-buffer base64.
class Base64Writer {
    constructor(stream) {
        this.stream = stream;
        this.sourceBytes = 0;
        this.remainder = Buffer.alloc(0);
        this.chain = Promise.resolve();
        this.aborted = false;
    }

    get bytesWritten() {
        return this.sourceBytes;
    }

    write(data) {
        this.sourceBytes += data.byteLength;
        const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        this.chain = this.chain.then(async () => {
            if (this.aborted) return;
            const bytes = this.remainder.length > 0 ? Buffer.concat([this.remainder, buf]) : buf;
            const usable = Math.floor(bytes.length / 3) * 3;
            this.remainder = bytes.subarray(usable);
            if (usable > 0) {
                const encoded = Buffer.from(bytes.subarray(0, usable).toString('base64'));
                if (!this.stream.write(encoded)) {
                    await new Promise((resolve) => this.stream.once('drain', resolve));
                }
            }
        });
        return this.chain;
    }

    // Flushes the buffered tail (with base64 padding). Does NOT end the
    // stream — the HTML suffix is appended after the sog payload.
    close() {
        this.chain = this.chain.then(async () => {
            if (this.aborted || this.remainder.length === 0) return;
            const encoded = Buffer.from(this.remainder.toString('base64'));
            this.remainder = Buffer.alloc(0);
            if (!this.stream.write(encoded)) {
                await new Promise((resolve) => this.stream.once('drain', resolve));
            }
        });
        return this.chain;
    }

    abort() {
        this.aborted = true;
        this.chain = Promise.resolve();
        this.stream.destroy();
    }
}

const writeAll = (stream, buf) => new Promise((resolve, reject) => {
    stream.write(buf, (err) => (err ? reject(err) : resolve()));
});

/**
 * Export a source file as a self-contained bundled-HTML viewer.
 *
 * @param {string} inputPath  - source file (.ply native / .sog .splat .spz .ksplat via splat-transform)
 * @param {string} outputPath - destination .html file path
 * @param {object} options
 * @param {number} options.shBands       - requested SH bands (0–3; zeros fill missing coefficients)
 * @param {number} options.iterations    - k-means iterations (0 matches the browser viewer export)
 * @param {object} options.viewerSettings- viewer experience settings JSON (as in the export popup)
 * @param {object} splatLib              - resolved splat-transform module
 * @param {object|null} nativeAddon      - C++ native addon (or null)
 * @param {function} onProgress          - optional ({ progress, text }) => void
 */
export async function htmlExportToPath(inputPath, outputPath, options, splatLib, nativeAddon, onProgress = null) {
    const { shBands = 3, iterations = 0, viewerSettings } = options;
    const t0 = performance.now();

    const report = (progress, text) => onProgress?.({ progress, text });

    const {
        Column, DataTable, Transform, writeHtml, writeSource, createChunkDataPool,
        MemoryFileSystem, WorkerQueue
    } = splatLib;

    // Inline workers — same as the LCC2 backend export.
    WorkerQueue.maxWorkers = 0;

    // --- Stage 1: Read source (mirrors lcc2-export Stage 1) ---
    const lowerInput = inputPath.toLowerCase();
    let sourcePath = inputPath;
    let extractedProjectPath = null;
    if (lowerInput.endsWith('.respproj')) {
        // HTML backend export is currently routed for one-splat projects.
        // Their document payload is stored as splat_0.ply.gz in the ZIP.
        const tempDir = path.join(os.tmpdir(), 'resplat-temp', 'html-projects');
        const extracted = await extractGzipProjectEntry(inputPath, 'splat_0.ply.gz', tempDir);
        sourcePath = extracted.path;
        extractedProjectPath = extracted.path;
    }
    const lowerSource = sourcePath.toLowerCase();
    const isPlainPly = lowerSource.endsWith('.ply') && !lowerSource.endsWith('.compressed.ply');
    report(2, '读取源文件…');
    let columns, numRows;
    if (isPlainPly && nativeAddon) {
        console.log(`\n[html-export] Reading PLY (native): ${sourcePath}`);
        const result = nativeAddon.readPlyFast(sourcePath);
        columns = result.columns;
        numRows = result.numRows;
    } else {
        console.log(`\n[html-export] Reading ${path.extname(sourcePath) || 'source'} (splat-transform): ${sourcePath}`);
        const {
            readFile, getInputFormat, ZipReadFileSystem,
            bakeTransform, materializeToDataTable, selectLod
        } = splatLib;
        const base = path.basename(sourcePath);
        const inputFormat = getInputFormat(base);
        const nodeFs = new NodePathReadFileSystem(sourcePath);
        let readFs = nodeFs;
        let readFilename = base;
        if (inputFormat === 'sog' && lowerSource.endsWith('.sog')) {
            readFs = new ZipReadFileSystem(await nodeFs.createSource(base));
            readFilename = 'meta.json';
        }
        let dataTableFallback;
        try {
            const sources = await readFile({ filename: readFilename, inputFormat, fileSystem: readFs });
            let source = sources[0];
            if (source.meta.numLods > 1) source = selectLod(source, 0);
            const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
            try {
                const baked = bakeTransform(source, Transform.PLY);
                dataTableFallback = await materializeToDataTable(baked, pool);
            } finally {
                pool.destroy();
                for (const s of sources) s.close();
            }
        } finally {
            readFs.close?.();
            if (readFs !== nodeFs) nodeFs.close();
        }
        columns = dataTableFallback.columns.map(c => ({ name: c.name, data: c.data }));
        numRows = dataTableFallback.numRows;
    }
    if (extractedProjectPath) {
        try { fs.rmSync(extractedProjectPath, { force: true }); } catch { /* best-effort */ }
    }
    console.log(`[html-export] Read complete: ${numRows.toLocaleString()} Gaussians, ${((performance.now() - t0) / 1000).toFixed(1)}s`);

    // --- Stage 2: Spill columns to disk ---
    // The lazy source reads chunk ranges back on demand, so the whole column
    // set never coexists with writeSogSource's per-layer gathers.
    report(6, '准备数据…');
    const spillDir = path.join(path.dirname(outputPath), `.html-export-spill-${randomUUID()}`);
    fs.mkdirSync(spillDir, { recursive: true });
    const columnMeta = {};
    try {
        // Spill one column at a time and null its slot immediately so the
        // (large) column backing stores become collectable as early as
        // possible — the 59-col SH3 source is ~3.6 GB resident, and Stage 4's
        // color-layer gather needs another ~3 GB. Forcing GC after the spill
        // (--expose-gc) returns that 3.6 GB before the encode phase starts.
        for (let i = 0; i < columns.length; i++) {
            const c = columns[i];
            fs.writeFileSync(path.join(spillDir, `${c.name}.bin`), Buffer.from(c.data.buffer, 0, c.data.buffer.byteLength));
            columnMeta[c.name] = `${c.name}.bin`;
            columns[i] = null;
        }
        columns = null; // release the resident column set
        if (global.gc) global.gc();

        // --- Stage 3: HTML shell (1-row stub through writeHtml) ---
        // Same trick as the browser buildViewerHtmlShell: the stub's embedded
        // data URL is tiny, so prefix/suffix surround where the real base64
        // payload is streamed. Building the shell via writeHtml keeps it in
        // sync with the installed splat-transform viewer template.
        report(10, '生成 HTML 外壳…');
        const memberNames = [
            'x', 'y', 'z',
            'scale_0', 'scale_1', 'scale_2',
            'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
            'rot_0', 'rot_1', 'rot_2', 'rot_3'
        ];
        const stubTable = new DataTable(memberNames.map(name => new Column(name, new Float32Array([0]))), Transform.PLY);
        const shellFs = new MemoryFileSystem();
        await writeHtml({
            filename: 'shell.html',
            dataTable: stubTable,
            ...(viewerSettings !== undefined ? { viewerSettingsJson: viewerSettings } : {}),
            bundle: true,
            iterations: 0,
            logging: 'silent'
        }, shellFs);

        const shell = Buffer.from(shellFs.results.get('shell.html') ?? new Uint8Array(0)).toString('utf8');
        const dataStart = shell.indexOf(DATA_URL_PREFIX);
        const dataEnd = dataStart !== -1 ? shell.indexOf('")', dataStart + DATA_URL_PREFIX.length) : -1;
        if (dataStart === -1 || dataEnd === -1) {
            throw new Error('Failed to locate embedded data URL in viewer HTML shell');
        }
        const prefix = Buffer.from(shell.slice(0, dataStart + DATA_URL_PREFIX.length), 'utf8');
        const suffix = Buffer.from(shell.slice(dataEnd), 'utf8');
        console.log(`[html-export] Shell built (prefix ${prefix.length}B + suffix ${suffix.length}B)`);

        // --- Stage 4: Stream sog → base64 → output HTML ---
        const chunkSize = 1 << 20;
        const source = createLazyColumnSource(spillDir, columnMeta, numRows, chunkSize, shBands);
        source.meta.transform = Transform.PLY;

        // Rough sog-size estimate for progress (LCC2 empirics: ~40B/splat);
        // clamped so progress never stalls below the encode phase.
        const estSogBytes = Math.max(1, numRows * 40);

        const stream = fs.createWriteStream(outputPath);
        const streamFailed = new Promise((_, reject) => stream.on('error', reject));
        const base64Writer = new Base64Writer(stream);

        source.onRead = (done, total) => {
            report(10 + 10 * done / total, '编码 SOG 数据…');
        };

        try {
            await writeAll(stream, prefix);

            const sogFs = {
                createWriter: () => Promise.resolve(base64Writer),
                mkdir: () => Promise.resolve()
            };
            const pool = createChunkDataPool({ chunkSize });

            report(12, '编码 SOG 数据…');
            const encodeTick = setInterval(() => {
                report(Math.min(95, 12 + 83 * (base64Writer.sourceBytes / estSogBytes)), '编码 SOG 数据…');
            }, 1000);

            try {
                await Promise.race([
                    writeSource({
                        filename: 'temp.sog',
                        outputFormat: 'sog-bundle',
                        source,
                        pool,
                        options: { iterations }
                    }, sogFs),
                    streamFailed
                ]);
            } finally {
                clearInterval(encodeTick);
            }

            await base64Writer.close();
            await writeAll(stream, suffix);
            await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));

            const totalSeconds = (performance.now() - t0) / 1000;
            const stats = fs.statSync(outputPath);
            console.log(`[html-export] Done: ${(stats.size / 1048576).toFixed(1)} MB HTML in ${totalSeconds.toFixed(1)}s`);
            report(100, '导出完成');
            return {
                outputPath,
                numSplats: numRows,
                htmlBytes: stats.size,
                sogBytes: base64Writer.sourceBytes,
                totalSeconds
            };
        } catch (err) {
            base64Writer.abort();
            stream.destroy();
            throw err;
        } finally {
            source.close();
        }
    } finally {
        try { fs.rmSync(spillDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}
