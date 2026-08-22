/**
 * LCC2 Export — Backend Pipeline (Node.js)
 *
 * Reads a PLY file, builds adaptive hybrid tree, encodes per-node SOG chunks
 * (via splat-transform writeSog without WebGPU), and generates the .lcc2
 * directory structure matching XGRIDS naming conventions.
 *
 * Imported by server.js via dynamic import().  
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

// --- Helpers ---

/** Sampling rate: finest=100%, geometric 0.5^k per level (matches XGRIDS reference). */
const samplingRate = (treeDepth, k) => Math.pow(0.5, k);

// --- Per-(cell, rate) snapshot spill ---
// NanoGS simplify produces one snapshot per LOD rate for every cell. On a
// 10.5M×59-col scene the sum of all snapshots is ≈6.8 GB — far more than the
// export worker's isolate can hold (Electron caps external memory ≈7.5 GB and
// the machine may have only ~5 GB free). Every (cell, rate) snapshot is
// therefore written to a temp file the moment it is produced (see Phase 1 in
// lcc2ExportToPath) and streamed back column-by-column in the depth loop.
//
// File layout (per cell+rate):
//   {topId}__{rate}.bin        — [batch0: c0 c1 … c58][batch1: …]… where each
//                                column block is count×4 bytes (column-major,
//                                one block per batch)
//   {topId}__{rate}.meta.json  — { batches: [{ count }], total } (seek table)

// --- Raw column spill (used only by the parallel pool) ---
// Sub-workers share the columns via SharedArrayBuffer (≈2.5 GB on a 10.5M×59-col
// scene), so holding the raw colSrc at the same time pushes the main isolate
// past Electron's ~7.5 GB external cap along with everything else. Before the
// pool runs, the raw columns are written to a temp dir and released; they are
// restored right after the pool (the depth loop needs them for the uniform
// path). Serial simplify never dumps (it reads colSrc in place).
const dumpColumnsToDisk = (colSrc, colNames, baseDir) => {
    try {
        const dir = fs.mkdtempSync(path.join(baseDir, 'cols-'));
        const meta = {};
        let totalBytes = 0;
        for (const cn of colNames) {
            // One file per column: fs.readFileSync caps at 2 GiB per file.
            const buf = colSrc[cn].buffer;
            fs.writeFileSync(path.join(dir, `${cn}.bin`), Buffer.from(buf, 0, buf.byteLength));
            meta[cn] = { file: `${cn}.bin`, length: colSrc[cn].length };
            totalBytes += buf.byteLength;
        }
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
        console.log(`[lcc2] columns spilled to ${dir} (${(totalBytes / 1048576).toFixed(0)} MB)`);
        return dir;
    } catch (e) {
        console.log(`[lcc2] column dump failed (${e.message}) — keep columns in memory`);
        return null;
    }
};

const restoreColumnsFromDisk = (dir, colSrc, colNames) => {
    try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
        for (const cn of colNames) {
            const m = meta[cn];
            const data = fs.readFileSync(path.join(dir, m.file));
            colSrc[cn] = new Float32Array(data.buffer, data.byteOffset, m.length);
        }
        return true;
    } catch (e) {
        console.log(`[lcc2] column restore failed (${e.message})`);
        return false;
    }
};

// --- Spill temp dir lifecycle ---
// The per-(cell, rate) snapshot spill (and the pool's column dump) are several
// GB. They must live on a FAST drive — os.tmpdir() on this machine is a 20 MB/s
// SATA disk while the export output sits on a 388 MB/s NVMe — so the spill root
// is created inside the OUTPUT directory (same drive, guaranteed writable).
// cleanupLcc2Spill() removes it on success AND on error (called by the export
// worker's finally).
let activeSpillRoot = null;
export const cleanupLcc2Spill = () => {
    if (activeSpillRoot) {
        try { fs.rmSync(activeSpillRoot, { recursive: true, force: true }); } catch { /* best effort */ }
        activeSpillRoot = null;
    }
};

// --- NanoGS module loader ---
// The NanoGS TypeScript port is bundled to dist/nanogs.mjs by rollup (see
// rollup.config.mjs `nanogs` entry). This worker runs raw .mjs without TS
// compilation, so it imports the pre-bundled module. On any load failure we
// silently fall back to uniform sampling — LCC2 export stays correct.
// Licensed CC BY-NC 4.0 — see src/nanogs/README.md.
//
// Packaged exe caveat: Node's ESM loader cannot read files inside app.asar
// (asar is a virtual filesystem, not a real directory). This worker runs from
// <resources>/app.asar/server/, so `import('../dist/nanogs.mjs')` would throw
// and drop us to uniform sampling. dist/nanogs.mjs is unpacked via electron-
// builder `asarUnpack`, so when running inside the archive we load it from
// <resources>/app.asar.unpacked/dist/nanogs.mjs through a file:// URL instead.
let _nanogsLib = undefined; // undefined=not yet loaded, null=load failed, object=loaded
async function loadNanogs() {
    if (_nanogsLib !== undefined) return _nanogsLib;
    const ownDir = path.dirname(fileURLToPath(import.meta.url));
    const inAsar = ownDir.includes(path.sep + 'app.asar' + path.sep);
    const nanogsPath = inAsar
        ? path.join(path.resolve(ownDir, '..', '..'), 'app.asar.unpacked', 'dist', 'nanogs.mjs')
        : path.join(ownDir, '..', 'dist', 'nanogs.mjs');
    try {
        _nanogsLib = await import(pathToFileURL(nanogsPath).href);
        console.log('[lcc2] NanoGS module loaded');
    } catch (e) {
        console.log(`[lcc2] NanoGS module unavailable (${e.message}); uniform sampling only`);
        _nanogsLib = null;
    }
    return _nanogsLib;
}

// --- Coordinate Transform ---

/**
 * Apply LCC2 coordinate transform in-place on a DataTable.
 * PLY space (Rz180) → LCC2 space: (x, z, -y) + Rx(-90°) quaternion.
 * Returns the scene AABB in LCC2 space.
 */
const applyLcc2CoordinateTransform = (dataTable, maxSHBands) => {
    const N = dataTable.numRows;
    const xs = dataTable.getColumnByName('x').data;
    const ys = dataTable.getColumnByName('y').data;
    const zs = dataTable.getColumnByName('z').data;
    const r0 = dataTable.getColumnByName('rot_0').data;
    const r1 = dataTable.getColumnByName('rot_1').data;
    const r2 = dataTable.getColumnByName('rot_2').data;
    const r3 = dataTable.getColumnByName('rot_3').data;
    const SQRT1_2 = Math.SQRT1_2;

    const shCoeffs = [0, 3, 8, 15][maxSHBands];
    let shCols = null;
    if (shCoeffs >= 3 && dataTable.getColumnByName('f_rest_0')) {
        shCols = [];
        for (let ch = 0; ch < 3; ++ch) {
            const base = ch * shCoeffs;
            shCols.push(
                dataTable.getColumnByName(`f_rest_${base + 0}`).data,
                dataTable.getColumnByName(`f_rest_${base + 1}`).data
            );
        }
    }

    for (let i = 0; i < N; ++i) {
        const x = xs[i], y = ys[i], z = zs[i];
        xs[i] = x;
        ys[i] = z;
        zs[i] = -y;

        const qw = r0[i], qx = r1[i], qy = r2[i], qz = r3[i];
        r0[i] = (qw + qx) * SQRT1_2;
        r1[i] = (qx - qw) * SQRT1_2;
        r2[i] = (qy + qz) * SQRT1_2;
        r3[i] = (qz - qy) * SQRT1_2;

        if (shCols) {
            for (let ch = 0; ch < 3; ++ch) {
                const s0 = shCols[ch * 2 + 0], s1 = shCols[ch * 2 + 1];
                const v0 = s0[i], v1 = s1[i];
                s0[i] = v1;
                s1[i] = -v0;
            }
        }
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < N; ++i) {
        const x = xs[i], y = ys[i], z = zs[i];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
    }
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
};

// --- Tree Building ---

const computeTightAabb = (indices, xs, ys, zs) => {
    let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity;
    let mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
    for (let i = 0; i < indices.length; ++i) {
        const idx = indices[i];
        const x = xs[idx], y = ys[idx], z = zs[idx];
        if (x < mn0) mn0 = x;
        if (y < mn1) mn1 = y;
        if (z < mn2) mn2 = z;
        if (x > mx0) mx0 = x;
        if (y > mx1) mx1 = y;
        if (z > mx2) mx2 = z;
    }
    return { min: [mn0, mn1, mn2], max: [mx0, mx1, mx2] };
};

const buildAdaptiveLcc2Tree = (xs, ys, zs, N, treeDepth, sceneAabb, sogChunkTarget, maxSplitDepth = 8) => {
    const rootIndices = new Uint32Array(N);
    for (let i = 0; i < N; ++i) rootIndices[i] = i;

    const buildChildren = (indices, aabb, depth, splitDepth) => {
        if (depth > treeDepth) return null;

        if (indices.length <= sogChunkTarget || splitDepth >= maxSplitDepth) {
            const child = { aabb, finestIndices: indices, child: null };
            child.child = buildChildren(indices, aabb, depth + 1, splitDepth);
            return [child];
        }

        const [mn0, mn1, mn2] = aabb.min;
        const [mx0, mx1, mx2] = aabb.max;
        const mid0 = (mn0 + mx0) * 0.5;
        const mid1 = (mn1 + mx1) * 0.5;
        const mid2 = (mn2 + mx2) * 0.5;

        const bucketCounts = new Uint32Array(8);
        for (let i = 0; i < indices.length; ++i) {
            const idx = indices[i];
            const bX = xs[idx] <= mid0 ? 0 : 1;
            const bY = ys[idx] <= mid1 ? 0 : 1;
            const bZ = zs[idx] <= mid2 ? 0 : 1;
            bucketCounts[(bX << 2) | (bY << 1) | bZ]++;
        }

        const bucketArrays = new Array(8).fill(null);
        const bucketFill = new Uint32Array(8);
        for (let o = 0; o < 8; ++o) {
            if (bucketCounts[o] > 0) bucketArrays[o] = new Uint32Array(bucketCounts[o]);
        }

        for (let i = 0; i < indices.length; ++i) {
            const idx = indices[i];
            const bX = xs[idx] <= mid0 ? 0 : 1;
            const bY = ys[idx] <= mid1 ? 0 : 1;
            const bZ = zs[idx] <= mid2 ? 0 : 1;
            const o = (bX << 2) | (bY << 1) | bZ;
            bucketArrays[o][bucketFill[o]++] = idx;
        }

        const children = [];
        for (let o = 0; o < 8; ++o) {
            if (bucketCounts[o] === 0) continue;
            const childIndices = bucketArrays[o];
            const childAabb = computeTightAabb(childIndices, xs, ys, zs);
            const child = { aabb: childAabb, finestIndices: childIndices, child: null };
            child.child = buildChildren(childIndices, childAabb, depth + 1, splitDepth + 1);
            children.push(child);
        }

        if (children.length === 1) {
            const only = children[0];
            only.child = buildChildren(only.finestIndices, only.aabb, depth + 1, maxSplitDepth);
        }
        return children;
    };

    const root = { aabb: sceneAabb, finestIndices: rootIndices, child: null };
    root.child = buildChildren(rootIndices, sceneAabb, 1, 0);
    return root;
};

const assignAdaptiveNodeIds = (root) => {
    const walk = (node, id) => {
        node.id = id;
        if (node.child) {
            for (let i = 0; i < node.child.length; ++i) {
                walk(node.child[i], `${id}_${i}`);
            }
        }
    };
    walk(root, '0');
};

const collectNodesAtDepth = (root, targetDepth) => {
    const result = [];
    const walk = (node, depth) => {
        if (depth === targetDepth) { result.push(node); return; }
        if (node.child) { for (const c of node.child) walk(c, depth + 1); }
    };
    if (root.child) { for (const c of root.child) walk(c, 1); }
    return result;
};

// --- JSON Tree Emission ---

const emitAdaptiveTreeJson = (root, nodeRefs) => {
    const emit = (node) => {
        const ref = nodeRefs.get(node);
        const data = ref && ref.count > 0 ? { '3dgs': ref } : null;
        if (!node.child || node.child.length === 0) {
            return { id: node.id, boundingBox: node.aabb, childNum: 0, data };
        }
        const child = {};
        for (let i = 0; i < node.child.length; ++i) {
            child[String(i)] = emit(node.child[i]);
        }
        return { id: node.id, boundingBox: node.aabb, childNum: node.child.length, data, child };
    };
    const child = {};
    if (root.child) {
        for (let i = 0; i < root.child.length; ++i) {
            child[String(i)] = emit(root.child[i]);
        }
    }
    return {
        id: root.id,
        boundingBox: root.aabb,
        childNum: root.child?.length ?? 0,
        data: null,
        child
    };
};

// --- Main Export ---

/**
 * Read PLY, build tree, write SOG chunks, generate .lcc2.
 * @param {string} inputPath   - source PLY file path
 * @param {string} outputDir   - parent directory (a {name}/ subdir is created inside)
 * @param {object} options
 * @param {string} options.name           - project name
 * @param {number} options.lodLevels      - user-requested LOD count (1–20)
 * @param {number} options.shBands        - SH bands (0=portable, 1–3=quality)
 * @param {number} options.iterations     - k-means iterations (default 10; 0 would skip the Lloyd loop and collapse SH to one centroid)
 * @param {object} splatLib               - resolved splat-transform module
 * @param {object|null} nativeAddon       - C++ native addon (or null)
 * @param {function} onProgress           - optional ({ progress, text }) => void
 */
export async function lcc2ExportToPath(inputPath, outputDir, options, splatLib, nativeAddon, onProgress = null) {
    const { name, lodLevels = 1, shBands = 0, iterations = 10, simplifyMethod = 'nanogs' } = options;
    // SOG chunk target. Lowered to 1M (from 3M): each flushChunk preallocates
    // chunkCols (59 cols × count × 4B) plus writeSog's gather/texture buffers.
    // On 1542 万-point scenes a 3M chunk alone was ~0.7 GB + ~0.7 GB gather;
    // 1M cuts the write-phase peak roughly in half. Node size is unaffected
    // (SPLIT_TARGET below), only the .sog file granularity.
    const SOG_CHUNK_TARGET = 1_000_000;
    // Per-cell spatial split threshold: cells below this size chain (LOD link)
    // instead of splitting. Mirrors src/splat-serialize.ts SPLIT_TARGET (~500K,
    // matching the XGRIDS reference ~400K max per cell). A smaller threshold
    // yields finer spatial cells → fewer splats per visible node → the UE
    // plugin renders fewer splats per draw call (node granularity drives
    // per-frame cost; oversized nodes tank frame rate).
    const SPLIT_TARGET = 500_000;
    const t0 = performance.now();

    const report = (progress, text) => onProgress?.({ progress, text });

    const { Column, DataTable, Transform, writeSog, WorkerQueue, WebPCodec, MemoryFileSystem } = splatLib;

    // --- Configure splat-transform for Node.js ---
    WorkerQueue.maxWorkers = 0; // inline mode (no worker_threads for now)

    // --- Stage 1: Read source ---
    // Plain PLY goes through the C++ native reader (mmap+scatter, ~4x faster).
    // Everything else (.sog/.splat/.spz/.ksplat/…) is decoded by splat-transform:
    // readFile + bakeTransform(→ PLY space) + materializeToDataTable produce the
    // same columnar form readPlyFast returns, so the rest of the pipeline is
    // format-agnostic. Previously non-PLY sources routed here always failed
    // ("sog无法导出lcc2").
    const lowerInput = inputPath.toLowerCase();
    const isPlainPly = lowerInput.endsWith('.ply') && !lowerInput.endsWith('.compressed.ply');
    report(1, '读取源文件…');
    let columns, numRows;
    if (isPlainPly && nativeAddon) {
        console.log(`\n[lcc2] Reading PLY (native): ${inputPath}`);
        const result = nativeAddon.readPlyFast(inputPath);
        columns = result.columns;
        numRows = result.numRows;
    } else {
        console.log(`\n[lcc2] Reading ${path.extname(inputPath) || 'source'} (splat-transform): ${inputPath}`);
        const {
            readFile, getInputFormat, MemoryReadFileSystem, ZipReadFileSystem,
            bakeTransform, materializeToDataTable, createChunkDataPool, selectLod
        } = splatLib;
        const bytes = fs.readFileSync(inputPath);
        const base = path.basename(inputPath);
        const inputFormat = getInputFormat(base);
        const memFs = new MemoryReadFileSystem();
        memFs.set(base, bytes);
        let readFs = memFs;
        let readFilename = base;
        if (inputFormat === 'sog' && lowerInput.endsWith('.sog')) {
            // Bundled .sog is a zip container; the sog reader expects the inner
            // meta.json as the entry point (mirrors the browser loader).
            readFs = new ZipReadFileSystem(await memFs.createSource(base));
            readFilename = 'meta.json';
        }
        let dataTableFallback;
        try {
            const sources = await readFile({ filename: readFilename, inputFormat, fileSystem: readFs });
            let source = sources[0];
            // Multi-LOD containers (lcc/lcc2/lod) would otherwise be FLATTENED
            // (all LODs concatenated) by materializeToDataTable — select LOD 0.
            if (source.meta.numLods > 1) source = selectLod(source, 0);
            const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
            try {
                // bakeTransform applies the source's tagged transform so the
                // columns come out in PLY space — matching the native path.
                const baked = bakeTransform(source, Transform.PLY);
                dataTableFallback = await materializeToDataTable(baked, pool);
            } finally {
                pool.destroy();
                for (const s of sources) s.close();
            }
        } finally {
            readFs.close?.();
            // Release the raw file bytes (may be 100s of MB) before the
            // pipeline allocates its per-column Float32Arrays.
            memFs.set(base, new Uint8Array(0));
        }
        columns = dataTableFallback.columns.map(c => ({ name: c.name, data: c.data }));
        numRows = dataTableFallback.numRows;
    }
    console.log(`[lcc2] Read complete: ${numRows.toLocaleString()} Gaussians, ${((performance.now() - t0) / 1000).toFixed(1)}s`);

    // Cap SH bands to the source's actual bands and trim surplus f_rest
    // columns (mirrors the browser path's extractDataTable memberNames logic).
    // Without the cap an SH=0 source (most SOG files) exported with a quality
    // request would claim fileType='quality' with no SH data; surplus SH=3
    // columns on a portable request would ship unrotated (the LCC2 coordinate
    // transform below only rotates the requested band count).
    let sourceShBands = 0;
    for (const c of columns) {
        if (c.name.startsWith('f_rest_')) {
            const idx = parseInt(c.name.slice(7), 10);
            sourceShBands = Math.max(sourceShBands, idx < 9 ? 1 : idx < 24 ? 2 : 3);
        }
    }
    const effShBands = Math.min(shBands, sourceShBands);
    if (effShBands !== shBands) {
        console.log(`[lcc2] SH capped ${shBands}→${effShBands} (source bands=${sourceShBands})`);
    }
    const keepRest = [0, 9, 24, 45][effShBands];
    if (keepRest < 45) {
        columns = columns.filter(c => !c.name.startsWith('f_rest_') || parseInt(c.name.slice(7), 10) < keepRest);
    }

    // --- Stage 2: Build DataTable + LCC2 transform ---
    const cols = columns.map(c => new Column(c.name, c.data));
    const dataTable = new DataTable(cols, Transform.PLY);
    const sceneAabb = applyLcc2CoordinateTransform(dataTable, effShBands);

    const xs = dataTable.getColumnByName('x').data;
    const ys = dataTable.getColumnByName('y').data;
    const zs = dataTable.getColumnByName('z').data;

    // --- Stage 3: Compute treeDepth + build tree ---
    const safeTreeDepth = Math.max(1, Math.ceil(Math.log2(numRows / SOG_CHUNK_TARGET)) - 2);
    const treeDepth = Math.min(20, Math.max(safeTreeDepth, lodLevels));

    console.log(`[lcc2] Building adaptive tree (depth=${treeDepth})…`);
    report(5, `构建空间树… (depth=${treeDepth})`);
    const tTree = performance.now();
    const adaptiveRoot = buildAdaptiveLcc2Tree(xs, ys, zs, numRows, treeDepth, sceneAabb, SPLIT_TARGET);
    assignAdaptiveNodeIds(adaptiveRoot);
    const depth1Count = adaptiveRoot.child?.length ?? 0;
    console.log(`[lcc2] Tree done: ${depth1Count} root children, ${((performance.now() - tTree) / 1000).toFixed(1)}s`);

    // --- Stage 4: Per-depth chunk + writeSog ---
    const projectDir = path.join(outputDir, name);
    const sogDir = path.join(projectDir, 'data', '3dgs');
    fs.mkdirSync(sogDir, { recursive: true });

    const splatFiles = []; // populated as we write chunks
    const nodeRefs = new Map(); // AdaptiveNode → { name, start, count }
    const lodCounts = []; // per-depth total splats

    // --- Column schema (shared across all depths/nodes) ---
    const colNames = dataTable.columns.map(c => c.name);
    const colSrc = {};
    for (const cn of colNames) colSrc[cn] = dataTable.getColumnByName(cn).data;

    // NanoGS appearance columns = all float SH-like fields (f_dc_* + f_rest_*),
    // matching NanoGS `app_names` (float fields excluding required/drop). Normals
    // (nx,ny,nz) are NOT appearance → zeroed on NanoGS output (store_ply convention).
    const shColNames = colNames.filter(cn => cn.startsWith('f_dc_') || cn.startsWith('f_rest_'));

    // --- Load NanoGS module (bundled to dist/nanogs.mjs by rollup) ---
    const nanogsLib = await loadNanogs();
    const useNanogsMethod = simplifyMethod === 'nanogs' && !!nanogsLib;
    const nanogsOpts = useNanogsMethod
        ? nanogsLib.defaultSimplifyOpts({ shCols: shColNames.length })
        : null;
    const simplifyNodeBatchedFn = nanogsLib?.simplifyNodeBatched ?? null;

    // --- Inject the C++ native simplify core when available ---
    // native/nanogs.cc exposes simplifyNodeProgressive on the same .node file
    // as ply-reader (see ply-reader.cc Init). When present, simplifyNodeBatched
    // routes each ≤100K batch through C++ (~15× faster). Absent → TS fallback.
    if (nanogsLib && nativeAddon && typeof nativeAddon.simplifyNodeProgressive === 'function') {
        nanogsLib.setNativeImpl(nativeAddon.simplifyNodeProgressive);
        console.log('[lcc2] NanoGS native acceleration enabled (C++)');
    } else {
        console.log('[lcc2] NanoGS native acceleration unavailable — TS path');
    }

    if (useNanogsMethod) {
        console.log(`[lcc2] NanoGS enabled (shCols=${shColNames.length}, cap=${nanogsLib.NANOGS_NODE_CAP}, min=${nanogsLib.NANOGS_NODE_MIN})`);
    } else if (simplifyMethod === 'nanogs') {
        console.log('[lcc2] NanoGS requested but module unavailable — using uniform sampling');
    }

    // Activation/deactivation glue (read_ply/store_ply equivalents) is provided
    // by the NanoGS module as nodeAttrsFromColumns/nodeAttrsToColumns, kept under
    // CC BY-NC 4.0 with the rest of the port (see src/nanogs/README.md).

    // --- Build chain-top map (cell-major NanoGS reuse, plan §6 D3) ---
    // The adaptive tree chains identical `finestIndices` across depths (chain
    // continuations share the same Uint32Array reference as their parent).
    // Without this map, the depth-major loop below re-simplifies the same
    // `finestIndices` once per depth — rebuilding KNN on N0 up to (treeDepth-1)
    // times per cell. By identifying each node's chain top (the node where its
    // `finestIndices` first appeared), we can simplify each cell ONCE with all
    // its LOD rates via simplifyProgressive (one KNN pass) and cache the
    // per-rate snapshots for reuse at deeper depths.
    //
    // A chain ends when the node splits (its child has different `finestIndices`)
    // or when it reaches a leaf. `chainTopEndDepth` records the deepest depth
    // the chain spans, so we only compute snapshots for rates actually used.
    const nodeToChainTop = new Map();
    const chainTopDepth = new Map();
    const chainTopEndDepth = new Map();
    const chainTops = []; // unique chain-top nodes (each simplified once)
    const walkChainTop = (node, parent, parentChainTop, depth) => {
        // Root's direct children are always chain tops (root itself is never
        // simplified — data stays null in the emitted JSON).
        const isRootChild = parent === adaptiveRoot;
        const isChainTop = isRootChild || (node.finestIndices !== parent.finestIndices);
        const chainTop = isChainTop ? node : parentChainTop;
        nodeToChainTop.set(node, chainTop);
        if (isChainTop) {
            chainTopDepth.set(chainTop, depth);
            chainTopEndDepth.set(chainTop, depth); // initialized; extended by continuations
            chainTops.push(chainTop);
        } else {
            // Chain continuation: extend the chain top's end depth.
            chainTopEndDepth.set(chainTop, depth);
        }
        if (node.child) {
            for (const c of node.child) walkChainTop(c, node, chainTop, depth + 1);
        }
    };
    if (adaptiveRoot.child) {
        for (const c of adaptiveRoot.child) walkChainTop(c, adaptiveRoot, null, 1);
    }

    // --- Chain-top simplification (Phase 1: spill every snapshot to disk) ---
    // Every chain top is simplified ONCE — all its LOD rates via one KNN pass
    // per ≤NANOGS_NODE_CAP batch (simplifyProgressive) — and each (cell, rate)
    // snapshot is written to a temp file immediately. The export worker's RAM
    // therefore never holds more than one batch's output (~65 MB) on top of the
    // source columns, instead of the old pool design's ~6.8 GB of accumulated
    // snapshots (which OOM'd Electron's ~7.5 GB isolate cap → 闪退).
    //
    // Two paths, same spill format:
    //   * Parallel (pool v2): sub-workers simplify WHOLE CELLS and write their
    //     own spill files directly (columns shared via SharedArrayBuffer; the
    //     raw columns are dumped to disk for the pool's duration). The main
    //     worker holds only the SAB + metadata — never batch buffers. ~8×
    //     faster than serial on the simplify phase.
    //   * Serial fallback: reads colSrc in place (no SAB). Used when
    //     SharedArrayBuffer is unavailable or the pool throws.
    let depthProgressBase = 5;
    let snapshotDir = null; // temp dir for per-(cell, rate) snapshot files
    const spillMeta = new Map(); // `${topId}__${rate}` → { batches: [{count}], total }
    const computeRatesDesc = (chainTop) => {
        const topDepth = chainTopDepth.get(chainTop);
        const endDepth = chainTopEndDepth.get(chainTop);
        const ratesDesc = [];
        for (let d = topDepth; d <= endDepth; ++d) {
            const rr = samplingRate(treeDepth, treeDepth - d);
            if (rr < 1.0) ratesDesc.push(rr);
        }
        ratesDesc.sort((a, b) => b - a);
        return ratesDesc;
    };

    if (useNanogsMethod) {
        const tSimplify = performance.now();
        report(8, `智能简化 ${chainTops.length} 个单元…`);
        // Spill root lives INSIDE the output dir: same fast drive as the .sog
        // output (os.tmpdir() is a 20 MB/s SATA disk on this machine).
        snapshotDir = path.join(outputDir, `.lcc2-spill-${randomUUID()}`);
        fs.mkdirSync(snapshotDir, { recursive: true });
        activeSpillRoot = snapshotDir;
        const pos = { x: colSrc.x, y: colSrc.y, z: colSrc.z };
        const taskCap = nanogsLib.NANOGS_NODE_CAP;
        const opts = { k: nanogsOpts.k, mergeCap: nanogsOpts.mergeCap, shCols: nanogsOpts.shCols, cost: nanogsOpts.cost };

        // Pre-partition every chain top into ≤cap spatial batches. Needs
        // colSrc positions in RAM, so it runs before the optional column dump.
        const cellPlan = [];
        for (const top of chainTops) {
            const ratesDesc = computeRatesDesc(top);
            if (ratesDesc.length === 0) continue;
            cellPlan.push({ top, ratesDesc, batches: nanogsLib.partitionSpatially(top.finestIndices, pos, taskCap) });
        }

        // --- Parallel pool v2 (sub-workers write their own spill files) ---
        let poolWorked = false;
        // Budget ~2.5 GB per sub-worker (SAB view + NanoGS working set) and cap
        // the pool by AVAILABLE RAM — on memory-constrained machines (Electron
        // renderer already resident) 8 workers pushed past physical RAM → OOM.
        // When even ONE worker doesn't fit (free RAM < 2.5 GB) skip the pool
        // entirely: the serial path reads colSrc in place and avoids the ~3.5 GB
        // SAB copy + column dump/restore, which is the only variant that fits.
        const MEM_PER_WORKER_GB = 2.5;
        const freeGb = os.freemem() / 1024 ** 3;
        const numWorkers = Math.max(1, Math.min(8, Math.floor(freeGb / MEM_PER_WORKER_GB)));
        const usePool = cellPlan.length > 1 && typeof SharedArrayBuffer !== 'undefined' && numWorkers > 1;
        console.log(`[lcc2] simplify: ${usePool ? `pool ${numWorkers} worker(s)` : 'serial'} (free RAM ${freeGb.toFixed(1)} GB)`);
        if (usePool) {
            let colDumpPath = null;
            let sab = null; // declared here so the finally can restore columns AFTER it is freed
            try {
                const tPool = performance.now();
                console.log(`[lcc2] Parallel simplify: ${cellPlan.length} cells across ${Math.min(os.cpus().length, 8)} CPUs`);
                // 1. Shared column copy (zero-copy for sub-workers).
                const columns = {};
                let byteOffset = 0;
                for (const cn of colNames) {
                    columns[cn] = { byteOffset, length: colSrc[cn].length };
                    byteOffset += colSrc[cn].length * 4;
                }
                sab = new SharedArrayBuffer(byteOffset);
                for (const cn of colNames) {
                    new Float32Array(sab, columns[cn].byteOffset, columns[cn].length).set(colSrc[cn]);
                }
                // 2. Spill + release the raw columns for the pool's duration
                //    (the depth loop needs them back for the uniform path).
                colDumpPath = dumpColumnsToDisk(colSrc, colNames, snapshotDir);
                if (colDumpPath) {
                    for (const cn of colNames) colSrc[cn] = null;
                    dataTable.columns.length = 0; // release backing stores
                }
                // 3. Spawn pool + greedy dispatch (biggest cells first).
                const layout = { colNames, shColNames, columns };
                const workerUrl = new URL('./lcc2-simplify-worker.mjs', import.meta.url);
                const workers = [];
                for (let i = 0; i < numWorkers; ++i) {
                    workers.push(new Worker(workerUrl, {
                        resourceLimits: { maxOldGenerationSizeMb: 4096, maxYoungGenerationSizeMb: 512 }
                    }));
                }
                const planById = new Map(cellPlan.map(c => [c.top.id, c]));
                const load = new Array(numWorkers).fill(0); // batch-count load estimate
                const queue = cellPlan.slice().sort((a, b) => b.batches.length - a.batches.length);
                let nextCell = 0;
                let doneCells = 0;
                const totalCells = queue.length;
                await new Promise((resolve) => {
                    const workerDead = new Array(numWorkers).fill(false);
                    const workerCell = new Array(numWorkers).fill(null); // top.id in flight per worker
                    let allDone = false;
                    const resolveIfDone = () => {
                        if (allDone) return;
                        if (doneCells >= totalCells || workerDead.every(d => d)) {
                            allDone = true;
                            resolve();
                        }
                    };
                    const dispatch = (w, wi) => {
                        if (workerDead[wi] || nextCell >= totalCells) return;
                        const cell = queue[nextCell++];
                        load[wi] += cell.batches.length;
                        workerCell[wi] = cell.top.id;
                        const batches = cell.batches.map(b => Uint32Array.from(b));
                        w.postMessage({
                            type: 'task',
                            taskId: cell.top.id,
                            topId: cell.top.id,
                            batches,
                            // Plain number[] — structured clone preserves doubles.
                            // Float32Array.from() would round 0.4 → 0.40000000596,
                            // mismatching the spillMeta keys (0.4) and the file names.
                            ratios: cell.ratesDesc,
                            opts
                        }, batches.map(b => b.buffer));
                    };
                    workers.forEach((w, wi) => {
                        w.on('message', (m) => {
                            if (m.type === 'init-done') { dispatch(w, wi); return; }
                            // Worker couldn't load its NanoGS module (e.g. ESM
                            // inside asar) — mark it dead; if ALL workers fail
                            // the export falls back to the serial path below.
                            if (m.type === 'init-error') {
                                workerDead[wi] = true;
                                resolveIfDone();
                                return;
                            }
                            if (m.type !== 'result') return;
                            if (workerCell[wi] === null) return; // late/duplicate
                            if (m.ok && m.batches) {
                                const cell = planById.get(m.taskId);
                                if (cell) {
                                    for (let r = 0; r < cell.ratesDesc.length; ++r) {
                                        const rate = cell.ratesDesc[r];
                                        const key = `${cell.top.id}__${rate}`;
                                        let total = 0;
                                        const batches = [];
                                        for (const bm of m.batches) {
                                            const cnt = bm.counts[r] ?? 0;
                                            batches.push({ count: cnt });
                                            total += cnt;
                                        }
                                        if (total > 0) spillMeta.set(key, { batches, total });
                                    }
                                }
                            }
                            workerCell[wi] = null;
                            ++doneCells;
                            dispatch(w, wi);
                            report(8 + Math.round((doneCells / totalCells) * 22), `智能简化 ${doneCells}/${totalCells} 个单元…`);
                            resolveIfDone();
                        });
                        w.on('error', (e) => {
                            console.log(`[lcc2] pool worker error: ${e.message}`);
                            if (workerCell[wi] !== null) { workerCell[wi] = null; ++doneCells; }
                            workerDead[wi] = true;
                            resolveIfDone();
                        });
                        w.on('exit', (code) => {
                            if (code !== 0 && !workerDead[wi]) {
                                if (workerCell[wi] !== null) { workerCell[wi] = null; ++doneCells; }
                                workerDead[wi] = true;
                                resolveIfDone();
                            }
                        });
                    });
                    for (const w of workers) w.postMessage({ type: 'init', sab, layout, snapshotDir });
                });
                // Ensure sub-workers are fully dead (releases their SAB views),
                // then free the SAB on THIS isolate BEFORE the finally restores
                // the raw columns — otherwise the restore's 2.37 GB allocation
                // sits on top of the still-live 2.37 GB SAB and OOMs
                // ("Array buffer allocation failed").
                await Promise.all(workers.map(w => w.terminate()));
                sab = null;
                // Only treat the pool as having worked if it actually produced
                // snapshots — otherwise fall through to the serial path, which
                // runs on this isolate with the already-loaded nanogsLib.
                poolWorked = doneCells > 0;
                const dur = ((performance.now() - tPool) / 1000).toFixed(1);
                console.log(`[lcc2] Parallel simplify done: ${doneCells}/${totalCells} cells [${dur}s]`);
            } catch (e) {
                console.log(`[lcc2] parallel simplify failed (${e.message}) — falling back to serial`);
            } finally {
                // Workers read the SAB; the depth loop (and serial fallback)
                // need colSrc back in RAM. Restore on every exit path — and
                // free the SAB first so the restore's allocation fits.
                sab = null;
                if (colDumpPath) {
                    if (colSrc.x === null || colSrc.x === undefined) {
                        restoreColumnsFromDisk(colDumpPath, colSrc, colNames);
                    }
                    try { fs.rmSync(colDumpPath, { recursive: true, force: true }); } catch { /* best effort */ }
                }
            }
        }

        // --- Serial fallback / default (reads colSrc in place) ---
        if (!poolWorked) {
            console.log(`[lcc2] NanoGS simplify (serial, ${cellPlan.length} chain tops)`);
            let doneCells = 0;
            let totalBatches = 0;
            for (const { top, ratesDesc, batches } of cellPlan) {
                const topFds = new Map(); // rate → open fd (closed per cell)
                for (const batch of batches) {
                    let results = null;
                    try {
                        results = simplifyNodeBatchedFn(batch, colSrc, colNames, shColNames, ratesDesc, opts);
                    } catch (e) {
                        console.log(`[NanoGS] batch simplify failed on ${top.id} (${batch.length} splats): ${e.message} — uniform fallback`);
                    }
                    if (results) {
                        for (let r = 0; r < ratesDesc.length; ++r) {
                            const snap = results[r];
                            if (!snap || snap.count === 0) continue;
                            const rate = ratesDesc[r];
                            const key = `${top.id}__${rate}`;
                            let fd = topFds.get(rate);
                            if (fd === undefined) {
                                fd = fs.openSync(path.join(snapshotDir, `${key}.bin`), 'w');
                                topFds.set(rate, fd);
                                spillMeta.set(key, { batches: [], total: 0 });
                            }
                            const meta = spillMeta.get(key);
                            const chunks = [];
                            for (const cn of colNames) {
                                const src = snap.cols[cn];
                                if (src) {
                                    chunks.push(Buffer.from(src.buffer, src.byteOffset, snap.count * 4));
                                } else {
                                    chunks.push(Buffer.alloc(snap.count * 4));
                                }
                            }
                            fs.writevSync(fd, chunks);
                            meta.batches.push({ count: snap.count });
                            meta.total += snap.count;
                        }
                        results = null; // release the batch's snapshot buffers
                    }
                    ++totalBatches;
                }
                for (const fd of topFds.values()) fs.closeSync(fd);
                ++doneCells;
                report(8 + Math.round((doneCells / cellPlan.length) * 22), `智能简化 ${doneCells}/${cellPlan.length} 个单元…`);
            }
            depthProgressBase = 30;
            const dur = ((performance.now() - tSimplify) / 1000).toFixed(1);
            console.log(`[lcc2] Simplify done: ${totalBatches} batches, ${doneCells}/${cellPlan.length} cells spilled [${dur}s]`);
        } else {
            depthProgressBase = 30;
        }
    }

    // Stream one (cell, rate) snapshot from disk into a chunk, column by column.
    // data.bin layout: [batch0: c0(count0) c1(count0) … c58(count0)][batch1: …]…
    // Each column block is count×4 bytes; reading per (column, batch) keeps the
    // transient buffer ≤ NANOGS_NODE_CAP×4 bytes regardless of cell size.
    const streamSpillIntoChunk = (spillKey, chunkCols, offset, meta) => {
        const counts = meta.batches.map(b => b.count);
        const nCols = colNames.length;
        const fd = fs.openSync(path.join(snapshotDir, `${spillKey}.bin`), 'r');
        try {
            const batchOff = new Array(counts.length);
            let acc = 0;
            for (let b = 0; b < counts.length; ++b) {
                batchOff[b] = acc;
                acc += counts[b] * nCols * 4;
            }
            for (let ci = 0; ci < nCols; ++ci) {
                const dst = chunkCols[colNames[ci]];
                let off = offset;
                for (let b = 0; b < counts.length; ++b) {
                    const cnt = counts[b];
                    const len = cnt * 4;
                    const buf = Buffer.allocUnsafe(len);
                    fs.readSync(fd, buf, 0, len, batchOff[b] + ci * len);
                    const f32 = new Float32Array(buf.buffer, buf.byteOffset, cnt);
                    for (let j = 0; j < cnt; ++j) dst[off + j] = f32[j];
                    off += cnt;
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    };

    for (let D = 1; D <= treeDepth; ++D) {
        const k = treeDepth - D;
        const rate = samplingRate(treeDepth, k);
        const nodesAtD = collectNodesAtDepth(adaptiveRoot, D);
        const depthProgress = Math.round(depthProgressBase + ((D - 1) / treeDepth) * (95 - depthProgressBase));
        const depthUsesNanogs = useNanogsMethod && rate < 1.0;
        const methodLabel = depthUsesNanogs ? '智能简化' : '均匀采样';

        console.log(`[lcc2] Depth ${D}/${treeDepth} (k=${k}, rate=${(rate*100).toFixed(0)}%): ${nodesAtD.length} nodes [${methodLabel}]`);
        report(depthProgress, `写入 LOD ${D}/${treeDepth}（${methodLabel}）…`);

        let chunkCols = null;
        let chunkSplatCount = 0;
        let chunkNodeStart = 0;
        let depthTotal = 0;
        const depthNodeCounts = new Array(nodesAtD.length).fill(0); // actual per-node splat count
        let nanogsNodes = 0, uniformNodes = 0;

        const flushChunk = async () => {
            if (!chunkCols || chunkSplatCount === 0) return;

            const firstNode = nodesAtD[chunkNodeStart];
            const lodFileName = `${firstNode.id}.sog`;
            const chunkPath = path.join(sogDir, lodFileName);

            const chunkColumns = Object.entries(chunkCols).map(([cn, data]) => new Column(cn, data.subarray(0, chunkSplatCount)));
            const chunkTable = new DataTable(chunkColumns, dataTable.transform.clone());

            console.log(`  Writing ${lodFileName} (${chunkSplatCount.toLocaleString()} splats)…`);

            // CRITICAL: pass identity indices so writeSog keeps the chunk's row
            // order as-is (it Morton-sorts internally when `indices` is absent).
            // nodeRefs.start/count below assume the file's splat order matches
            // the nodesAtD packing order; a Morton reorder would scramble every
            // node's data → UE plugin renders wrong regions (区块显示不全).
            const identity = new Uint32Array(chunkSplatCount);
            for (let i = 0; i < chunkSplatCount; ++i) identity[i] = i;

            const outFs = new MemoryFileSystem();
            await writeSog({
                filename: lodFileName,
                dataTable: chunkTable,
                bundle: true,
                iterations,
                indices: identity
            }, outFs);

            const buf = outFs.results.get(lodFileName);
            if (!buf) throw new Error(`writeSog produced no output for ${lodFileName}`);
            fs.writeFileSync(chunkPath, buf);

            const fileIdx = splatFiles.length;
            splatFiles.push(`data/3dgs/${lodFileName}`);

            // Record nodeRefs for all nodes in this chunk (actual per-node counts;
            // NanoGS snapshots may differ slightly from ceil(N*rate)).
            let nodeOffset = 0;
            for (let ni = chunkNodeStart; ni < nodesAtD.length; ++ni) {
                const cnt = depthNodeCounts[ni];
                nodeRefs.set(nodesAtD[ni], { name: fileIdx, start: nodeOffset, count: cnt });
                nodeOffset += cnt;
                if (nodeOffset >= chunkSplatCount) break;
            }

            chunkCols = null;
            chunkSplatCount = 0;
        };

        for (let n = 0; n < nodesAtD.length; ++n) {
            const node = nodesAtD[n];

            // Produce this node's splat data for the current LOD depth.
            //   NanoGS path: the (chainTop, rate) snapshot was spilled to disk
            //     in Phase 1; stream it back column-by-column into the chunk.
            //     Falls back to whole-node uniform when NanoGS is disabled, the
            //     cell's simplify failed/empty, or the depth is the finest
            //     (rate=1.0).
            //   Uniform path: stride-sample finestIndices (original behavior).
            let nodeCount;
            let mode = 'uniform';
            let spill = null;
            if (depthUsesNanogs) {
                const chainTop = nodeToChainTop.get(node);
                spill = spillMeta.get(`${chainTop.id}__${rate}`);
                if (spill && spill.total > 0) {
                    nodeCount = spill.total;
                    mode = 'nanogs';
                }
            }
            if (mode === 'uniform') {
                nodeCount = Math.max(1, Math.ceil(node.finestIndices.length * rate));
            }
            depthNodeCounts[n] = nodeCount;

            // Flush before adding this node if it would push us over target.
            if (chunkCols && chunkSplatCount + nodeCount > SOG_CHUNK_TARGET) {
                await flushChunk();
            }

            // Start a new chunk if needed. Preallocated Float32Array (no
            // push-array overhead): a 3M×59 chunk is 0.7 GB, not ~1.4 GB+.
            if (!chunkCols) {
                const capacity = Math.max(SOG_CHUNK_TARGET, nodeCount);
                chunkCols = {};
                for (const cn of colNames) chunkCols[cn] = new Float32Array(capacity);
                chunkSplatCount = 0;
                chunkNodeStart = n;
            }

            // Append this node's splats to the chunk (column-major for cache locality).
            if (mode === 'nanogs') {
                const chainTop = nodeToChainTop.get(node);
                streamSpillIntoChunk(`${chainTop.id}__${rate}`, chunkCols, chunkSplatCount, spill);
                ++nanogsNodes;
            } else {
                const step = node.finestIndices.length / nodeCount;
                for (const cn of colNames) {
                    const src = colSrc[cn];
                    const dst = chunkCols[cn];
                    for (let j = 0; j < nodeCount; ++j) {
                        dst[chunkSplatCount + j] = src[node.finestIndices[Math.floor(j * step)]];
                    }
                }
                ++uniformNodes;
            }
            chunkSplatCount += nodeCount;
            depthTotal += nodeCount;
        }

        // Flush the final chunk for this depth.
        if (chunkCols && chunkSplatCount > 0) {
            await flushChunk();
        }

        lodCounts.push(depthTotal);
        console.log(`  Depth ${D} total: ${depthTotal.toLocaleString()} splats (nanogs=${nanogsNodes}, uniform=${uniformNodes})`);
    }

    // --- Stage 5: Generate .lcc2 metadata ---
    const meta = {
        version: '0.0.3',
        name,
        description: '',
        guid: randomUUID(),
        source: 'resplat',
        dataType: 'Editor',
        epsg: 0,
        offset: [0, 0, 0],
        shift: [0, 0, 0],
        scale: [1, 1, 1],
        fileType: effShBands > 0 ? 'quality' : 'portable',
        totalSplats: lodCounts.reduce((a, b) => a + b, 0),
        lodSplats: lodCounts.slice().reverse(), // coarsest-first in meta
        totalLevels: treeDepth,
        splatType: '.sog',
        virtualLoD: null,
        env: null,
        splatExtraAttributes: null,
        renderingHints: {
            renderMethod: 'splatting',
            renderMethodVariant: 'ewa',
            sortingMethod: 'depth',
            cameraModel: 'pinhole'
        },
        root: emitAdaptiveTreeJson(adaptiveRoot, nodeRefs)
    };

    // Inject splatFiles into root
    meta.root.splatFiles = splatFiles;
    meta.root.meshFiles = [];
    meta.root.bvhFiles = [];

    const metaPath = path.join(projectDir, `${name}.lcc2`);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const totalSec = ((performance.now() - t0) / 1000).toFixed(1);
    const fileCount = splatFiles.length;
    console.log(`[lcc2] Export complete: ${fileCount} .sog files, ${lodCounts.reduce((a, b) => a + b, 0).toLocaleString()} total splats, ${totalSec}s`);
    console.log(`[lcc2] Output: ${projectDir}`);
    report(100, '导出完成');

    // Clean up the spilled snapshot temp directory (also removed on error via
    // cleanupLcc2Spill() in the export worker's finally).
    cleanupLcc2Spill();

    return {
        outputPath: projectDir,
        fileCount,
        totalSplats: lodCounts.reduce((a, b) => a + b, 0),
        totalLevels: treeDepth,
        lodSplats: lodCounts,
        totalSeconds: parseFloat(totalSec)
    };
}
