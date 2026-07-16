/**
 * ReSplat Local Backend Server
 * 
 * Provides decimate/merge/convert/export APIs for large Gaussian splat files
 * that exceed browser memory limits (~4GB V8 heap).
 * 
 * Usage: node server.js [port]
 * Default port: 3266
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');

// C++ native addon — PLY parse + compressed-ply write acceleration
let native;
try { native = require('./native'); } catch (_) { native = null; }
if (native) console.log('[native] C++ ply_reader addon loaded');

const PORT = parseInt(process.env.PORT || process.argv[2] || '3266', 10);
const DIST_DIR = path.join(__dirname, 'dist');

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Send result inline (for upload endpoints — file may be large so chunk it) */
function sendResult(res, { resultData, outFilename, count }) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${outFilename}"`);
    res.setHeader('X-Splat-Count', String(count));
    // Stream in chunks — Buffer.from and res.end have 2GB limits
    const CHUNK = 256 * 1024 * 1024;
    for (let offset = 0; offset < resultData.length; offset += CHUNK) {
        res.write(Buffer.from(resultData.subarray(offset, offset + CHUNK)));
    }
    res.end();
}

/** Write result to temp/ and return URL (for path endpoints — avoids 4.5GB HTTP body) */
function sendPathResult(res, { resultData, outFilename, count }) {
    // Unique temp filename to avoid collisions
    const ext = path.extname(outFilename);
    const baseName = path.basename(outFilename, ext);
    const tempName = `${baseName}_${Date.now()}${ext}`;
    const tempPath = path.join(TEMP_DIR, tempName);

    // Write in chunks via fd — stream.write() overwhelms event loop for >4GB files
    const fd = fs.openSync(tempPath, 'w');
    try {
        const CHUNK = 256 * 1024 * 1024;
        for (let offset = 0; offset < resultData.length; offset += CHUNK) {
            const slice = Buffer.from(resultData.subarray(offset, offset + CHUNK));
            fs.writeSync(fd, slice, 0, slice.length, offset);
        }
    } finally {
        fs.closeSync(fd);
    }

    // Schedule cleanup after 10 minutes (browser should load it by then)
    setTimeout(() => cleanup(tempPath), 10 * 60 * 1000);

    const url = `http://localhost:${PORT}/temp/${encodeURIComponent(tempName)}`;
    console.log(`  → Serving via URL: ${url}`);
    res.json({ url, filename: outFilename, count });
}

// ---------------------------------------------------------------------------
// Dynamic import for ESM-only @playcanvas/splat-transform
// ---------------------------------------------------------------------------
let splatTransform = null;

async function loadSplatTransform() {
    if (splatTransform) return splatTransform;
    splatTransform = await import('@playcanvas/splat-transform');
    return splatTransform;
}

// ---------------------------------------------------------------------------
// NodeFileReadSystem — chunked file reader for files > 2 GiB
//
// fs.readFileSync has a ~2 GiB Buffer limit. This custom ReadFileSystem
// reads from disk in chunks via fs.read(), supporting files of any size.
// ---------------------------------------------------------------------------

class NodeFileReadStream {
    constructor(fd, size, start, end) {
        this._fd = fd;
        this._size = size;
        this._start = start || 0;
        this._end = end || size;
        this._pos = this._start;
        this.bytesRead = 0;
        this.expectedSize = this._end - this._start;
    }

    async pull(target) {
        const maxBytes = Math.min(target.length, this._end - this._pos);
        if (maxBytes <= 0) return 0;

        return new Promise((resolve, reject) => {
            fs.read(this._fd, target, 0, maxBytes, this._pos, (err, bytesRead) => {
                if (err) return reject(err);
                this._pos += bytesRead;
                this.bytesRead += bytesRead;
                resolve(bytesRead);
            });
        });
    }

    async readAll() {
        const buf = Buffer.allocUnsafe(this.expectedSize);
        let offset = 0;
        let bytesRead = 0;
        while ((bytesRead = await this.pull(buf.subarray(offset))) > 0) {
            offset += bytesRead;
        }
        return new Uint8Array(buf.buffer, buf.byteOffset, offset);
    }

    close() {
        // fd is managed by the source
    }
}

class NodeFileReadSource {
    constructor(filePath, fd, size) {
        this._filePath = filePath;
        this._fd = fd;
        this.size = size;
        this.seekable = true;
    }

    read(start, end) {
        return new NodeFileReadStream(this._fd, this.size, start, end);
    }

    close() {
        if (this._fd !== null) {
            try { fs.closeSync(this._fd); } catch (_) { /* ignore */ }
            this._fd = null;
        }
    }
}

class NodeFileReadFileSystem {
    constructor(filePath, originalName) {
        this._filePath = filePath;
        this._originalName = originalName;
        this._fd = null;           // lazy-open, shared
        this._source = null;       // singleton source
        this._closed = false;
    }

    async createSource(filename, _progress) {
        if (this._closed) {
            throw new Error('File system already closed');
        }

        // Single-file upload: only the original filename is available.
        // SOG bundles reference webp by path; for single-file uploads,
        // return the same source for any request (reader handles bundle internally).
        if (this._source) return this._source;

        const fd = fs.openSync(this._filePath, 'r');
        const stat = fs.fstatSync(fd);
        this._fd = fd;
        this._source = new NodeFileReadSource(this._filePath, fd, stat.size);
        return this._source;
    }

    close() {
        this._closed = true;
        if (this._source) {
            this._source.close();
            this._source = null;
        }
        this._fd = null;
    }
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
const app = express();

// CORS: allow localhost origins for dev flexibility
app.use(cors({
    origin: /^https?:\/\/localhost(:\d+)?$/,
    credentials: true
}));

// Increase body/url limits for large file upload proxy
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Static file serving: dist/ directory
app.use(express.static(DIST_DIR, {
    setHeaders: (res, filePath) => {
        // Ensure .wasm files get the correct MIME type for WebAssembly
        if (filePath.endsWith('.wasm')) {
            res.setHeader('Content-Type', 'application/wasm');
        }
    }
}));

// temp directory for path-based conversion output
// Use os.tmpdir() instead of __dirname to avoid ENOTDIR when packaged in asar
const TEMP_DIR = path.join(os.tmpdir(), 'resplat-temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
app.use('/temp', express.static(TEMP_DIR, { maxAge: 0 }));

// SPA fallback: all non-API, non-file routes → index.html
app.get(/^\/(?!api\/)/, (req, res, next) => {
    // Skip if the request looks like a file (has extension) or is an API call
    if (path.extname(req.path)) {
        return next();
    }
    res.sendFile(path.join(DIST_DIR, 'index.html'));
});

// ---------------------------------------------------------------------------
// Multer: upload to temp directory
// ---------------------------------------------------------------------------
const upload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: 20 * 1024 * 1024 * 1024 } // 20 GB max
});

// ---------------------------------------------------------------------------
// API: Health check
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: '1.0.4' });
});

// ---------------------------------------------------------------------------
// Fast PLY reader — synchronous I/O, zero async overhead
// Bypasses splat-transform's ReadStream (39K async fs.read calls → 9 sync reads)
// Uses C++ native addon (mmap + scatter) when available, falls back to JS.
// ---------------------------------------------------------------------------
function readPlyFast(filePath) {
    if (native) {
        return native.readPlyFast(filePath);
    }
    const fd = fs.openSync(filePath, 'r');
    try {
        const fileSize = fs.statSync(filePath).size;

        // 1. Read header in one shot (PLY headers are small, < 128KB)
        const headerBuf = Buffer.allocUnsafe(Math.min(128 * 1024, fileSize));
        const headerBytesRead = fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);

        // 2. Find \nend_header\n
        const endHeader = Buffer.from('\nend_header\n', 'ascii');
        let endIdx = -1;
        for (let i = 0; i <= headerBytesRead - endHeader.length; i++) {
            let match = true;
            for (let j = 0; j < endHeader.length; j++) {
                if (headerBuf[i + j] !== endHeader[j]) { match = false; break; }
            }
            if (match) { endIdx = i; break; }
        }
        if (endIdx < 0) throw new Error('end_header not found in PLY');

        const binaryStart = endIdx + endHeader.length;

        // 3. Parse header
        const headerStr = headerBuf.toString('ascii', 0, endIdx);
        const lines = headerStr.split('\n');
        const elements = [];
        let currentElement = null;

        for (const line of lines) {
            const trimmed = line.replace(/\r$/, '');
            const words = trimmed.split(' ');
            switch (words[0]) {
                case 'ply': case 'format': case 'end_header': case '': case 'comment':
                    break;
                case 'element':
                    currentElement = { name: words[1], count: parseInt(words[2], 10), properties: [] };
                    elements.push(currentElement);
                    break;
                case 'property':
                    if (currentElement) {
                        currentElement.properties.push({ name: words[2], type: words[1] });
                    }
                    break;
            }
        }

        // 4. Reject compressed PLY (chunk + vertex elements)
        if (elements.length === 2 && elements[0].name === 'chunk' && elements[1].name === 'vertex') {
            throw new Error('Compressed PLY not supported in fast path');
        }

        // 5. Find vertex element
        const vertexEl = elements.find(e => e.name === 'vertex');
        if (!vertexEl) throw new Error('No vertex element in PLY');

        const numRows = vertexEl.count;
        const numProps = vertexEl.properties.length;

        // 6. Require all-float properties (standard 3DGS PLY)
        const allFloat = vertexEl.properties.every(p => p.type === 'float');
        if (!allFloat) throw new Error('Non-float PLY properties not supported in fast path');

        // 7. Allocate column arrays
        const columns = vertexEl.properties.map(p => ({
            name: p.name,
            data: new Float32Array(numRows)
        }));

        // 8. Read binary data in 256MB chunks, scatter to columns
        const rowSize = numProps * 4;
        const chunkRows = Math.min(numRows, Math.floor(256 * 1024 * 1024 / rowSize));
        const chunkBuf = Buffer.allocUnsafe(chunkRows * rowSize);
        const floatView = new Float32Array(chunkBuf.buffer, chunkBuf.byteOffset, chunkBuf.length / 4);

        // Pre-extract column data arrays for direct access
        const dsts = columns.map(c => c.data);

        let rowBase = 0;
        let fileOffset = binaryStart;

        while (rowBase < numRows) {
            const rowsInChunk = Math.min(chunkRows, numRows - rowBase);
            const bytesToRead = rowsInChunk * rowSize;
            fs.readSync(fd, chunkBuf, 0, bytesToRead, fileOffset);

            // Row-major scatter: sequential floatView reads, linear dst writes
            for (let r = 0; r < rowsInChunk; r++) {
                const srcOff = r * numProps;
                const dstOff = rowBase + r;
                for (let p = 0; p < numProps; p++) {
                    dsts[p][dstOff] = floatView[srcOff + p];
                }
            }

            rowBase += rowsInChunk;
            fileOffset += bytesToRead;
        }

        return { columns, numRows };
    } finally {
        fs.closeSync(fd);
    }
}

// ---------------------------------------------------------------------------
// Core processing function — shared by upload and path-based endpoints
// Returns { resultData, outFilename, count } so callers decide delivery method
// ---------------------------------------------------------------------------
async function processFile(inputPath, originalName, mode, targetPercent, deleteInput) {
    let fileSystem = null;
    const tag = mode === 'decimate' ? 'decimate' : 'convert';
    const fileSizeMB = fs.existsSync(inputPath) ? fs.statSync(inputPath).size / (1024 * 1024) : 0;
    console.log(`\n[${tag}] Received: ${originalName} (${fileSizeMB.toFixed(1)} MB)`);

    try {
        const splatLib = await loadSplatTransform();
        const { readFile, getInputFormat, processDataTable, writeFile, getOutputFormat, MemoryFileSystem, Column, DataTable, Transform } = splatLib;

        const totalStages = mode === 'decimate' ? 3 : 2;
        const t1 = performance.now();

        // Detect PLY format for fast path
        const lowerName = originalName.toLowerCase();
        const isPly = lowerName.endsWith('.ply') && !lowerName.endsWith('.compressed.ply');

        let dataTable;
        let numRows;

        if (isPly) {
            // Fast path: synchronous I/O, no async overhead
            console.log(`[${tag}] Stage 1/${totalStages}: Reading PLY (fast sync I/O)...`);
            try {
                const result = readPlyFast(inputPath);
                dataTable = new DataTable(
                    result.columns.map(c => new Column(c.name, c.data)),
                    Transform.PLY.clone()
                );
                numRows = result.numRows;
            } catch (fastErr) {
                // Fall back to splat-transform's reader for compressed/mixed PLY
                console.log(`[${tag}] Fast PLY reader failed (${fastErr.message}), falling back to splat-transform...`);
                fileSystem = new NodeFileReadFileSystem(inputPath, originalName);
                const inputFormat = getInputFormat(originalName);
                const data = await readFile({
                    filename: originalName,
                    inputFormat,
                    options: { iterations: 1 },
                    params: [],
                    fileSystem
                });
                if (!data || data.length === 0) {
                    throw new Error('Failed to read input file');
                }
                dataTable = data[0];
                numRows = dataTable.numRows;
            }
        } else {
            // Non-PLY: use splat-transform's reader (SOG, splat, ksplat, etc.)
            console.log(`[${tag}] Stage 1/${totalStages}: Reading file...`);
            fileSystem = new NodeFileReadFileSystem(inputPath, originalName);
            const inputFormat = getInputFormat(originalName);
            const data = await readFile({
                filename: originalName,
                inputFormat,
                options: { iterations: 1 },
                params: [],
                fileSystem
            });
            if (!data || data.length === 0) {
                throw new Error('Failed to read input file');
            }
            dataTable = data[0];
            numRows = dataTable.numRows;
        }

        console.log(`[${tag}] Read complete (${((performance.now() - t1) / 1000).toFixed(1)}s), ${numRows.toLocaleString()} Gaussians`);

        let stage = 2;

        // 2. Decimate (if requested)
        if (mode === 'decimate') {
            console.log(`[${tag}] Stage 2/3: Decimating to ${targetPercent}% (target ~${Math.round(numRows * targetPercent / 100).toLocaleString()} Gaussians)...`);
            const t2 = performance.now();
            dataTable = await processDataTable(dataTable, [
                { kind: 'decimate', percent: targetPercent, count: null }
            ]);
            console.log(`[${tag}] Decimate complete (${((performance.now() - t2) / 1000).toFixed(1)}s), ${dataTable.numRows.toLocaleString()} Gaussians`);
            stage = 3;
        }

        // 3. Write output — compressed PLY (SuperSplat chunk-based, ~16 bytes/gaussian GPU)
        const writeFilename = mode === 'decimate'
            ? originalName.replace(/\.\w+$/, `_d${targetPercent}.compressed.ply`)
            : originalName.replace(/\.\w+$/, '.compressed.ply');
        console.log(`[${tag}] Stage ${stage}/${totalStages}: Writing output compressed PLY...`);
        const t3 = performance.now();

        let outFilename = writeFilename;
        let resultData = null;

        // C++ native fast path: direct file write (4.3x faster than JS)
        if (native && isPly) {
            try {
                const colMap = {};
                for (const col of dataTable.columns) {
                    colMap[col.name] = col.data;
                }
                // Detect SH bands from f_rest column count
                let shBands = 0;
                let restCount = 0;
                while (colMap[`f_rest_${restCount}`] !== undefined) restCount++;
                if (restCount >= 45) shBands = 3;
                else if (restCount >= 24) shBands = 2;
                else if (restCount >= 9) shBands = 1;

                const tempOutPath = path.join(TEMP_DIR, `${Date.now()}_${path.basename(writeFilename)}`);
                native.writeCompressedPly({
                    columns: colMap,
                    numRows: dataTable.numRows,
                    outputPath: tempOutPath,
                    shBands
                });
                resultData = new Uint8Array(fs.readFileSync(tempOutPath));
                cleanup(tempOutPath);
                console.log(`[${tag}] (native) Write done (${((performance.now() - t3) / 1000).toFixed(1)}s)`);
            } catch (nativeErr) {
                console.log(`[${tag}] Native write failed (${nativeErr.message}), falling back to JS...`);
                resultData = null;
            }
        }

        if (!resultData) {
            // JS fallback: splat-transform MemoryFileSystem + writeFile
            const outFs = new MemoryFileSystem();
            await writeFile({
                filename: writeFilename,
                outputFormat: getOutputFormat(writeFilename, {}),
                dataTable: dataTable,
                options: {}
            }, outFs);

            resultData = outFs.results.get(outFilename);
            if (!resultData) {
                const keys = Array.from(outFs.results.keys());
                if (keys.length === 0) {
                    throw new Error('No output generated');
                }
                outFilename = keys[0];
                resultData = outFs.results.get(keys[0]);
            }
        }

        const outputSizeMB = resultData.length / (1024 * 1024);
        const totalSec = ((performance.now() - t1) / 1000).toFixed(1);
        console.log(`[${tag}] Done! Write (${((performance.now() - t3) / 1000).toFixed(1)}s) | Output: ${outputSizeMB.toFixed(1)} MB, ${dataTable.numRows.toLocaleString()} Gaussians | Total: ${totalSec}s`);

        return { resultData, outFilename, count: dataTable.numRows };

    } finally {
        if (fileSystem) fileSystem.close();
        if (deleteInput) cleanup(inputPath);
    }
}

// ---------------------------------------------------------------------------
// API: Decimate (upload) — reduce Gaussian count via MPMM merging
// ---------------------------------------------------------------------------
app.post('/api/decimate', upload.single('file'), async (req, res) => {
    const inputPath = req.file?.path;
    const originalName = req.file?.originalname || 'input.sog';
    if (!inputPath) { res.status(400).json({ error: 'No file uploaded' }); return; }
    const targetPercent = parseInt(req.body.targetPercent || '10', 10);
    if (isNaN(targetPercent) || targetPercent < 1 || targetPercent > 100) {
        res.status(400).json({ error: 'targetPercent must be 1-100' });
        cleanup(inputPath);
        return;
    }
    try {
        const result = await processFile(inputPath, originalName, 'decimate', targetPercent, true);
        sendResult(res, result);
    } catch (error) {
        console.error('[decimate] Error:', error);
        res.status(500).json({ error: error.message || 'Decimate failed' });
    }
});

// ---------------------------------------------------------------------------
// API: Decimate (path) — read file directly from disk, no upload
// ---------------------------------------------------------------------------
app.post('/api/decimate-path', express.json(), async (req, res) => {
    const { filePath, targetPercent = 10 } = req.body;
    if (!filePath || !fs.existsSync(filePath)) {
        res.status(400).json({ error: 'Invalid file path' });
        return;
    }
    const originalName = path.basename(filePath);
    try {
        const result = await processFile(filePath, originalName, 'decimate', parseInt(targetPercent, 10), false);
        sendPathResult(res, result);
    } catch (error) {
        console.error('[decimate] Error:', error);
        res.status(500).json({ error: error.message || 'Decimate failed' });
    }
});

// ---------------------------------------------------------------------------
// API: Convert (upload) — read file, write as PLY without decimation
// ---------------------------------------------------------------------------
app.post('/api/convert', upload.single('file'), async (req, res) => {
    const inputPath = req.file?.path;
    const originalName = req.file?.originalname || 'input.ply';
    if (!inputPath) { res.status(400).json({ error: 'No file uploaded' }); return; }
    try {
        const result = await processFile(inputPath, originalName, 'convert', 0, true);
        sendResult(res, result);
    } catch (error) {
        console.error('[convert] Error:', error);
        res.status(500).json({ error: error.message || 'Convert failed' });
    }
});

// ---------------------------------------------------------------------------
// API: Convert (path) — read file from disk, convert to PLY, no upload
// ---------------------------------------------------------------------------
app.post('/api/convert-path', express.json(), async (req, res) => {
    const { filePath } = req.body;
    if (!filePath || !fs.existsSync(filePath)) {
        res.status(400).json({ error: 'Invalid file path' });
        return;
    }
    const originalName = path.basename(filePath);
    try {
        const result = await processFile(filePath, originalName, 'convert', 0, false);
        sendPathResult(res, result);
    } catch (error) {
        console.error('[convert] Error:', error);
        res.status(500).json({ error: error.message || 'Convert failed' });
    }
});

// ---------------------------------------------------------------------------
// API: Read PLY header — returns vertex count + estimated memory
// ---------------------------------------------------------------------------
app.post('/api/ply-meta', express.json(), async (req, res) => {
    const { filePath } = req.body;
    if (!filePath || !fs.existsSync(filePath)) {
        res.status(400).json({ error: 'Invalid file path' });
        return;
    }
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(8192);
        fs.readSync(fd, buf, 0, 8192, 0);
        fs.closeSync(fd);
        const header = buf.toString('ascii');
        const endIdx = header.indexOf('end_header');
        if (endIdx < 0) { res.status(400).json({ error: 'Invalid PLY header' }); return; }
        const section = header.substring(0, endIdx);
        const match = section.match(/element\s+vertex\s+(\d+)/i);
        if (!match) { res.status(400).json({ error: 'No vertex count found' }); return; }
        const count = parseInt(match[1], 10);
        const propMatches = section.match(/\bproperty\b/g);
        const numProps = propMatches ? propMatches.length : 14;
        const estMemMB = Math.round(count * numProps * 4 * 2.5 / (1024 * 1024));
        res.json({ count, estMemMB, numProps });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------------------------
// API: LOD Convert (upload) — file blob → multi-level compressed-ply for progressive loading
// ---------------------------------------------------------------------------
app.post('/api/lod-convert', upload.single('file'), async (req, res) => {
    const inputPath = req.file?.path;
    const originalName = req.file?.originalname || 'input.ply';
    if (!inputPath) { res.status(400).json({ error: 'No file uploaded' }); return; }
    // Parse levels from form field (sent as JSON string)
    let levels = [5, 25, 100];
    try {
        if (req.body.levels) levels = JSON.parse(req.body.levels);
    } catch { /* use default */ }
    try {
        const result = await lodConvert(inputPath, originalName, levels);
        res.json(result);
    } catch (error) {
        console.error('[lod-upload] Error:', error);
        res.status(500).json({ error: error.message || 'LOD convert failed' });
    }
});

// ---------------------------------------------------------------------------
// API: LOD Convert (path) — generate multi-level compressed-ply for progressive loading
// Levels: [5%, 25%, 100%] by default — preview loaded first, higher LOD in background
// ---------------------------------------------------------------------------
app.post('/api/lod-convert-path', express.json(), async (req, res) => {
    const { filePath, levels = [5, 25, 100] } = req.body;
    if (!filePath || !fs.existsSync(filePath)) {
        res.status(400).json({ error: 'Invalid file path' });
        return;
    }
    const originalName = path.basename(filePath);
    try {
        const result = await lodConvert(filePath, originalName, levels);
        res.json(result);
    } catch (error) {
        console.error('[lod-path] Error:', error);
        res.status(500).json({ error: error.message || 'LOD convert failed' });
    }
});

// ---------------------------------------------------------------------------
// LOD Convert (core) — shared by upload and path-based endpoints
// ---------------------------------------------------------------------------
async function lodConvert(inputPath, originalName, levels = [5, 25, 100]) {
    const t0 = performance.now();
    const lowerName = originalName.toLowerCase();
    const isPly = lowerName.endsWith('.ply') && !lowerName.endsWith('.compressed.ply');
    if (!isPly) throw new Error('LOD convert currently only supports standard PLY');

    const fileSizeMB = fs.existsSync(inputPath) ? fs.statSync(inputPath).size / (1024 * 1024) : 0;
    console.log(`\n[lod] Received: ${originalName} (${fileSizeMB.toFixed(1)} MB), levels: [${levels.join(', ')}%]`);

    const splatLib = await loadSplatTransform();
    const { Column, DataTable, Transform } = splatLib;

    console.log('[lod] Stage 1/3: Reading PLY...');
    const result = readPlyFast(inputPath);
        console.log(`[lod] Read complete (${((performance.now() - t0) / 1000).toFixed(1)}s), ${result.numRows.toLocaleString()} Gaussians`);

        const lodResults = [];
        const sortedLevels = [...levels].sort((a, b) => b - a); // process 100% first, then descending

        // Keep a pristine copy of column data for cloning
        const pristineColumns = result.columns;

        for (let li = 0; li < sortedLevels.length; li++) {
            const lvl = sortedLevels[li];
            const tLvl = performance.now();
            console.log(`[lod] Generating ${lvl}% LOD...`);

            // Clone column data for this level (processDataTable mutates in place)
            // 100% level uses pristine data directly — no decimate, so no mutation risk
            const needsClone = lvl < 100;
            const lvlColumns = needsClone
                ? pristineColumns.map(c => new Column(c.name, new Float32Array(c.data)))
                : pristineColumns.map(c => new Column(c.name, c.data));
            let lvlDataTable = new DataTable(lvlColumns, Transform.PLY.clone());

            if (lvl < 100) {
                // Fast interval sampling: take every Nth splat, preserving Morton order
                // Much faster than MPMM decimate (262s → <1s for 5M points)
                const numRows = result.numRows;
                const sampleRatio = lvl / 100;
                const sampleCount = Math.max(1, Math.floor(numRows * sampleRatio));
                const step = Math.max(1, Math.floor(numRows / sampleCount));

                const sampledColumns = lvlColumns.map(c => {
                    const src = c.data;
                    const dst = new Float32Array(sampleCount);
                    for (let i = 0; i < sampleCount; i++) {
                        dst[i] = src[i * step];
                    }
                    return new Column(c.name, dst);
                });
                lvlDataTable = new DataTable(sampledColumns, Transform.PLY.clone());
            }

            const writeFilename = originalName.replace(/\.\w+$/, `.lod${lvl}.compressed.ply`);
            let resultData;

            if (native) {
                const colMap = {};
                for (const col of lvlDataTable.columns) colMap[col.name] = col.data;
                let shBands = 0, restCount = 0;
                while (colMap[`f_rest_${restCount}`] !== undefined) restCount++;
                if (restCount >= 45) shBands = 3;
                else if (restCount >= 24) shBands = 2;
                else if (restCount >= 9) shBands = 1;

                const tempOutPath = path.join(TEMP_DIR, `${Date.now()}_${path.basename(writeFilename)}`);
                native.writeCompressedPly({
                    columns: colMap,
                    numRows: lvlDataTable.numRows,
                    outputPath: tempOutPath,
                    shBands
                });
                resultData = new Uint8Array(fs.readFileSync(tempOutPath));
                cleanup(tempOutPath);
            } else {
                const { writeFile, getOutputFormat } = splatLib;
                const outFs = new MemoryFileSystem();
                await writeFile({
                    filename: writeFilename,
                    outputFormat: getOutputFormat(writeFilename, {}),
                    dataTable: lvlDataTable,
                    options: {}
                }, outFs);
                resultData = outFs.results.get(writeFilename);
                if (!resultData) {
                    const keys = Array.from(outFs.results.keys());
                    if (keys.length === 0) throw new Error('No output generated');
                    resultData = outFs.results.get(keys[0]);
                }
            }

            const ext = path.extname(writeFilename);
            const base = path.basename(writeFilename, ext);
            const serveName = `${base}_${Date.now()}${ext}`;
            const servePath = path.join(TEMP_DIR, serveName);
            const fd = fs.openSync(servePath, 'w');
            try {
                const CHUNK = 256 * 1024 * 1024;
                for (let offset = 0; offset < resultData.length; offset += CHUNK) {
                    const slice = Buffer.from(resultData.subarray(offset, offset + CHUNK));
                    fs.writeSync(fd, slice, 0, slice.length, offset);
                }
            } finally { fs.closeSync(fd); }
            setTimeout(() => cleanup(servePath), 30 * 60 * 1000);

            const url = `http://localhost:${PORT}/temp/${encodeURIComponent(serveName)}`;
            const sizeMB = fs.statSync(servePath).size / (1024 * 1024);
            console.log(`[lod]   Level ${lvl}%: ${lvlDataTable.numRows.toLocaleString()} Gaussians, ${sizeMB.toFixed(1)} MB, ${((performance.now() - tLvl) / 1000).toFixed(1)}s`);
            lodResults.push({ level: lvl, count: lvlDataTable.numRows, url, sizeBytes: fs.statSync(servePath).size });
        }

        const totalSec = ((performance.now() - t0) / 1000).toFixed(1);
        console.log(`[lod] Done! Total: ${totalSec}s`);
        return { levels: lodResults, totalSeconds: parseFloat(totalSec) };
}

// ---------------------------------------------------------------------------
// API: Merge (path) — merge multiple PLY files into one compressed-ply, offline
// Uses C++ native mergePlyFiles + writeCompressedPly to avoid browser OOM
// ---------------------------------------------------------------------------
app.post('/api/merge-path', express.json(), async (req, res) => {
    const { filePaths } = req.body;
    if (!filePaths || !Array.isArray(filePaths) || filePaths.length < 2) {
        res.status(400).json({ error: 'Need at least 2 file paths' });
        return;
    }
    // Validate all files exist
    for (const fp of filePaths) {
        if (!fs.existsSync(fp)) {
            res.status(400).json({ error: `File not found: ${fp}` });
            return;
        }
    }

    console.log(`\n[merge] Received ${filePaths.length} files to merge`);
    const t0 = performance.now();

    try {
        const splatLib = await loadSplatTransform();
        const { Column, DataTable, Transform } = splatLib;

        let mergedColumns, mergedNumRows;
        const lowerNames = filePaths.map(f => path.basename(f).toLowerCase());
        const allStandardPly = lowerNames.every(n => n.endsWith('.ply') && !n.endsWith('.compressed.ply'));

        if (native && allStandardPly) {
            // C++ native merge: mmap + direct column concatenation
            console.log('[merge] Stage 1/2: Merging with C++ native...');
            const merged = native.mergePlyFiles(filePaths);
            mergedColumns = merged.columns;
            mergedNumRows = merged.numRows;
            console.log(`[merge] Merge complete (${((performance.now() - t0) / 1000).toFixed(1)}s), ${mergedNumRows.toLocaleString()} Gaussians`);
        } else {
            // JS fallback: read files one by one with splat-transform
            console.log('[merge] Stage 1/2: Merging with JS fallback...');
            const { readFile, getInputFormat } = splatLib;

            const allColumns = [];
            let totalRows = 0;

            for (const fp of filePaths) {
                const origName = path.basename(fp);
                const fs2 = new NodeFileReadFileSystem(fp, origName);
                const data = await readFile({
                    filename: origName,
                    inputFormat: getInputFormat(origName),
                    options: { iterations: 1 },
                    params: [],
                    fileSystem: fs2
                });
                const dt = data[0];
                for (const col of dt.columns) {
                    let existing = allColumns.find(c => c.name === col.name);
                    if (!existing) {
                        existing = { name: col.name, data: [] };
                        allColumns.push(existing);
                    }
                    existing.data.push(col.data);
                }
                totalRows += dt.numRows;
                fs2.close();
            }

            mergedColumns = allColumns.map(c => {
                const merged = new Float32Array(totalRows);
                let offset = 0;
                for (const chunk of c.data) {
                    merged.set(chunk, offset);
                    offset += chunk.length;
                }
                return new Column(c.name, merged);
            });
            mergedNumRows = totalRows;
            console.log(`[merge] Merge complete (${((performance.now() - t0) / 1000).toFixed(1)}s), ${mergedNumRows.toLocaleString()} Gaussians`);
        }

        // Stage 2: Write merged compressed-ply
        console.log('[merge] Stage 2/2: Writing compressed PLY...');
        const t2 = performance.now();

        const colMap = {};
        for (const col of mergedColumns) colMap[col.name] = col.data;
        let shBands = 0, restCount = 0;
        while (colMap[`f_rest_${restCount}`] !== undefined) restCount++;
        if (restCount >= 45) shBands = 3;
        else if (restCount >= 24) shBands = 2;
        else if (restCount >= 9) shBands = 1;

        const writeFilename = `merged_${Date.now()}.compressed.ply`;
        let resultData;

        if (native) {
            const tempOutPath = path.join(TEMP_DIR, `_merge_${Date.now()}.compressed.ply`);
            native.writeCompressedPly({
                columns: colMap,
                numRows: mergedNumRows,
                outputPath: tempOutPath,
                shBands
            });
            resultData = new Uint8Array(fs.readFileSync(tempOutPath));
            cleanup(tempOutPath);
        } else {
            const { writeFile, getOutputFormat, MemoryFileSystem } = splatLib;
            const dataTable = new DataTable(mergedColumns, Transform.PLY.clone());
            const outFs = new MemoryFileSystem();
            await writeFile({
                filename: writeFilename,
                outputFormat: getOutputFormat(writeFilename, {}),
                dataTable,
                options: {}
            }, outFs);
            resultData = outFs.results.get(writeFilename);
            if (!resultData) {
                const keys = Array.from(outFs.results.keys());
                if (keys.length === 0) throw new Error('No output generated');
                resultData = outFs.results.get(keys[0]);
            }
        }

        // Write to temp file for serving
        const ext = path.extname(writeFilename);
        const base = path.basename(writeFilename, ext);
        const serveName = `${base}_${Date.now()}${ext}`;
        const servePath = path.join(TEMP_DIR, serveName);
        const fd = fs.openSync(servePath, 'w');
        try {
            const CHUNK = 256 * 1024 * 1024;
            for (let offset = 0; offset < resultData.length; offset += CHUNK) {
                const slice = Buffer.from(resultData.subarray(offset, offset + CHUNK));
                fs.writeSync(fd, slice, 0, slice.length, offset);
            }
        } finally { fs.closeSync(fd); }
        setTimeout(() => cleanup(servePath), 30 * 60 * 1000);

        const outputSizeMB = resultData.length / (1024 * 1024);
        const totalSec = ((performance.now() - t0) / 1000).toFixed(1);
        const url = `http://localhost:${PORT}/temp/${encodeURIComponent(serveName)}`;
        console.log(`[merge] Done! Write (${((performance.now() - t2) / 1000).toFixed(1)}s) | Output: ${outputSizeMB.toFixed(1)} MB, ${mergedNumRows.toLocaleString()} Gaussians | Total: ${totalSec}s`);

        res.json({ url, filename: writeFilename, count: mergedNumRows, sizeBytes: resultData.length });

    } catch (error) {
        console.error('[merge] Error:', error);
        res.status(500).json({ error: error.message || 'Merge failed' });
    }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function cleanup(filePath) {
    if (filePath) {
        try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    }
}

// ---------------------------------------------------------------------------
// Start (if run directly, not required as a module)
// ---------------------------------------------------------------------------
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`\n  ReSplat Local Backend v1.0.4`);
        console.log(`  ─────────────────────────────`);
        console.log(`  Server : http://localhost:${PORT}`);
        console.log(`  API    : http://localhost:${PORT}/api/health`);
        console.log(`  Static : ${DIST_DIR}`);
        console.log();
    });
}

module.exports = { app, PORT };
