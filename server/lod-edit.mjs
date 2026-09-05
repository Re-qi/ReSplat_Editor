import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    Column,
    DataTable,
    createChunkDataPool,
    getInputFormat,
    readFile,
    writeFile
} from '@playcanvas/splat-transform';

const TARGET_POINTS = 200_000;
const MAX_POINTS = 250_000;
const WORKING_SET_BYTES = 768 * 1024 * 1024;
const MAX_CONCURRENT_PAGES = 2;
const PAGE_VERSION = 1;
const PAGE_MAGIC = 'RSPAGED1';
const SH_REST_COUNTS = [0, 9, 24, 45];

class NodeReadStream {
    constructor(fd, size, start = 0, end = size) {
        this.fd = fd;
        this.size = size;
        this.start = start;
        this.end = end;
        this.pos = start;
        this.bytesRead = 0;
        this.expectedSize = Math.max(0, end - start);
    }

    async pull(target) {
        const length = Math.min(target.length, this.end - this.pos);
        if (length <= 0) return 0;
        const bytesRead = await new Promise((resolve, reject) => {
            fs.read(this.fd, target, 0, length, this.pos, (error, count) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(count);
                }
            });
        });
        this.pos += bytesRead;
        this.bytesRead += bytesRead;
        return bytesRead;
    }

    async readAll() {
        const result = Buffer.allocUnsafe(this.expectedSize);
        let offset = 0;
        while (offset < result.length) {
            const count = await this.pull(result.subarray(offset));
            if (count === 0) break;
            offset += count;
        }
        return new Uint8Array(result.buffer, result.byteOffset, offset);
    }

    close() {}
}

class NodeReadSource {
    constructor(filePath) {
        this.filePath = filePath;
        this.fd = fs.openSync(filePath, 'r');
        this.size = fs.fstatSync(this.fd).size;
        this.seekable = true;
        this.closed = false;
    }

    read(start = 0, end = this.size) {
        if (this.closed) throw new Error(`Source is closed: ${this.filePath}`);
        return new NodeReadStream(this.fd, this.size, start, end);
    }

    close() {
        if (!this.closed) {
            this.closed = true;
            fs.closeSync(this.fd);
        }
    }
}

class NodeDirectoryFileSystem {
    constructor(root) {
        this.root = root;
    }

    async createSource(filename) {
        const safe = filename.replace(/^[/\\]+/, '');
        return new NodeReadSource(path.join(this.root, safe));
    }

    close() {}
}

const normalizeBounds = (value, fallback) => {
    if (!value) return fallback;
    const min = value.min ?? value.minimum;
    const max = value.max ?? value.maximum;
    if (Array.isArray(min) && Array.isArray(max)) return { min: min.slice(0, 3), max: max.slice(0, 3) };
    if (min && max && Number.isFinite(min.x) && Number.isFinite(max.x)) {
        return { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] };
    }
    return fallback;
};

const unionBounds = (items) => {
    const result = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const item of items) {
        for (let axis = 0; axis < 3; axis++) {
            result.min[axis] = Math.min(result.min[axis], item.bounds.min[axis]);
            result.max[axis] = Math.max(result.max[axis], item.bounds.max[axis]);
        }
    }
    return result;
};

const morton2 = (x, y) => {
    const spread = (input) => {
        let v = (input + 32768) & 0xffff;
        v = (v | (v << 8)) & 0x00ff00ff;
        v = (v | (v << 4)) & 0x0f0f0f0f;
        v = (v | (v << 2)) & 0x33333333;
        v = (v | (v << 1)) & 0x55555555;
        return v >>> 0;
    };
    return (spread(x) | (spread(y) << 1)) >>> 0;
};

const fingerprint = async (metaPath) => {
    const hash = crypto.createHash('sha256');
    const dir = path.dirname(metaPath);
    const files = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
    for (const name of files) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        hash.update(name);
        hash.update(String(stat.size));
        hash.update(String(stat.mtimeMs));
    }
    return hash.digest('hex');
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const lccUnitBounds = (unit, meta, fallback) => {
    if (!meta.boundingBox || !Number.isFinite(Number(meta.cellLengthX)) || !Number.isFinite(Number(meta.cellLengthY))) {
        return fallback;
    }
    const global = normalizeBounds(meta.boundingBox, fallback);
    const x = global.min[0] + unit.x * Number(meta.cellLengthX);
    const y = global.min[1] + unit.y * Number(meta.cellLengthY);
    return {
        min: [x, y, global.min[2]],
        max: [x + Number(meta.cellLengthX), y + Number(meta.cellLengthY), global.max[2]]
    };
};

const parseLccPages = (meta, indexBytes, proxyLod) => {
    const totalLevels = Number(meta.totalLevel);
    const recordSize = 4 + totalLevels * 16;
    if (!Number.isInteger(totalLevels) || totalLevels <= 0 || indexBytes.length % recordSize !== 0) {
        throw new Error('Invalid LCC index.bin');
    }
    const view = new DataView(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength);
    const fallback = normalizeBounds(meta.boundingBox, { min: [0, 0, 0], max: [0, 0, 0] });
    const units = [];
    let globalStart = 0;
    for (let offset = 0, unitIndex = 0; offset < indexBytes.length; offset += recordSize, unitIndex++) {
        const x = view.getInt16(offset, true);
        const y = view.getInt16(offset + 2, true);
        let cursor = offset + 4;
        const lods = [];
        for (let lod = 0; lod < totalLevels; lod++, cursor += 16) {
            lods.push({
                points: view.getInt32(cursor, true),
                dataByteOffset: Number(view.getBigInt64(cursor + 4, true)),
                byteSize: view.getInt32(cursor + 12, true)
            });
        }
        const lod = lods[0];
        if (lod.points > 0) {
            units.push({
                unitIndex,
                x,
                y,
                start: globalStart,
                count: lod.points,
                bounds: lccUnitBounds({ x, y }, meta, fallback)
            });
            globalStart += lod.points;
        }
    }

    const tiles = new Map();
    for (const unit of units) {
        const key = `${Math.floor(unit.x / 8)},${Math.floor(unit.y / 8)}`;
        const tile = tiles.get(key) ?? { x: Math.floor(unit.x / 8), y: Math.floor(unit.y / 8), units: [] };
        tile.units.push(unit);
        tiles.set(key, tile);
    }

    const pages = [];
    const oversized = [];
    const flush = (pending) => {
        if (pending.length === 0) return;
        pages.push({
            id: `lod0-part${String(pages.length).padStart(5, '0')}`,
            lod: 0,
            count: pending.reduce((sum, unit) => sum + unit.count, 0),
            bounds: unionBounds(pending),
            ranges: pending.map(unit => ({ start: unit.start, count: unit.count }))
        });
    };
    for (const tile of [...tiles.values()].sort((a, b) => morton2(a.x, a.y) - morton2(b.x, b.y))) {
        let pending = [];
        let count = 0;
        for (const unit of tile.units.sort((a, b) => morton2(a.x, a.y) - morton2(b.x, b.y))) {
            if (unit.count > MAX_POINTS) {
                flush(pending);
                pending = [];
                count = 0;
                oversized.push(unit);
                continue;
            }
            if (count > 0 && count + unit.count > MAX_POINTS) {
                flush(pending);
                pending = [];
                count = 0;
            }
            pending.push(unit);
            count += unit.count;
            if (count >= TARGET_POINTS) {
                flush(pending);
                pending = [];
                count = 0;
            }
        }
        flush(pending);
    }
    return { pages, oversized, totalPoints: globalStart, totalLods: totalLevels, bounds: fallback, proxyLod };
};

const childrenOf = (node) => {
    if (!node) return [];
    if (Array.isArray(node.children)) return node.children;
    if (node.child && typeof node.child === 'object') {
        return Array.isArray(node.child) ? node.child : Object.keys(node.child)
            .filter(key => /^\d+$/.test(key))
            .sort((a, b) => Number(a) - Number(b))
            .map(key => node.child[key]);
    }
    return Object.keys(node)
        .filter(key => /^\d+$/.test(key))
        .sort((a, b) => Number(a) - Number(b))
        .map(key => node[key]);
};

const parseLcc2Pages = (meta, proxyLod) => {
    const totalLevels = Number(meta.totalLevels);
    const lodCounts = Array.isArray(meta.lodSplats) ? [...meta.lodSplats] : [];
    const files = meta.root?.splatFiles ?? [];
    const fallback = normalizeBounds(meta.boundingBox, { min: [0, 0, 0], max: [0, 0, 0] });
    const nodesByDepth = new Map();
    const walk = (node, depth) => {
        for (const child of childrenOf(node)) {
            const ref = child?.data?.['3dgs'];
            if (ref && Number.isInteger(ref.name)) {
                const bounds = normalizeBounds(child.boundingBox ?? child.bounds, fallback);
                const nodes = nodesByDepth.get(depth) ?? [];
                nodes.push({ file: ref.name, start: Number(ref.start) || 0, count: Number(ref.count) || 0, bounds });
                nodesByDepth.set(depth, nodes);
            }
            walk(child, depth + 1);
        }
    };
    walk(meta.root, 1);
    const expectedLod0Count = Number(lodCounts[0]);
    const depthTotals = [...nodesByDepth.entries()]
        .map(([depth, nodes]) => ({ depth, count: nodes.reduce((sum, node) => sum + node.count, 0) }))
        .sort((a, b) => b.depth - a.depth);
    // LCC2 stores each quality level at a tree depth. The deepest data depth
    // is normally LOD0; prefer an exact metadata count when sparse trees make
    // the depth relationship ambiguous.
    const targetDepth = depthTotals.find(item => item.count === expectedLod0Count)?.depth ?? depthTotals[0]?.depth;
    const nodes = targetDepth == null ? [] : (nodesByDepth.get(targetDepth) ?? []);
    const fileCounts = new Map();
    for (const node of nodes) {
        fileCounts.set(node.file, (fileCounts.get(node.file) ?? 0) + node.count);
    }
    const fileBase = new Map();
    let base = 0;
    for (const file of [...fileCounts.keys()].sort((a, b) => a - b)) {
        fileBase.set(file, base);
        base += fileCounts.get(file);
    }
    const pages = [];
    for (const node of nodes) {
        for (let start = 0; start < node.count; start += MAX_POINTS) {
            const count = Math.min(MAX_POINTS, node.count - start);
            pages.push({
                id: `lod0-part${String(pages.length).padStart(5, '0')}`,
                lod: 0,
                count,
                bounds: node.bounds,
                ranges: [{ start: (fileBase.get(node.file) ?? 0) + node.start + start, count }],
                sourceFile: files[node.file] ?? null
            });
        }
    }
    pages.sort((a, b) => a.ranges[0].start - b.ranges[0].start);
    pages.forEach((page, index) => { page.id = `lod0-part${String(index).padStart(5, '0')}`; });
    return {
        pages,
        totalPoints: Number.isFinite(expectedLod0Count) ? expectedLod0Count : base,
        totalLods: totalLevels,
        bounds: fallback,
        proxyLod
    };
};

const fieldData = (data, name) => data?.fields?.[name] ? data.field(name) : null;

const componentData = (data, groupedName, scalarNames, count, component) => {
    const grouped = fieldData(data, groupedName);
    if (grouped) {
        const components = data.fields[groupedName].components ?? Math.max(1, grouped.length / count);
        if (component >= components) return null;
        const result = new grouped.constructor(count);
        if (components === 1) {
            result.set(grouped);
        } else {
            for (let i = 0; i < count; i++) result[i] = grouped[i * components + component];
        }
        return result;
    }
    const scalar = fieldData(data, scalarNames[component]);
    return scalar ? new scalar.constructor(scalar) : null;
};

const appendComponents = (columns, data, groupedName, scalarNames, outputNames, count) => {
    for (let component = 0; component < outputNames.length; component++) {
        const values = componentData(data, groupedName, scalarNames, count, component);
        if (values) columns.push(new Column(outputNames[component], values));
    }
};

const gatherRows = async (source, indices) => {
    const meta = source.meta;
    const count = indices.length;
    const pool = createChunkDataPool({ chunkSize: Math.max(1, count), maxPooledBytes: 512 * 1024 * 1024 });
    const acquired = [];
    const req = { indices, indexOffset: 0, count, lod: 0 };
    const layers = ['position', 'geometric', 'color', 'other'];
    for (const layer of layers) {
        if (!meta.availableLayers.has(layer)) continue;
        const layout = meta.layouts[layer];
        if (!layout || (layer === 'other' && meta.extraColumns.length === 0)) continue;
        const data = pool.acquire(layer, layout, count);
        req[layer] = data;
        acquired.push(data);
    }
    try {
        await source.read(req);
        const columns = [];
        appendComponents(columns, req.position, 'position', ['x', 'y', 'z'], ['x', 'y', 'z'], count);
        appendComponents(columns, req.geometric, 'rotation', ['rot_0', 'rot_1', 'rot_2', 'rot_3'], ['rot_0', 'rot_1', 'rot_2', 'rot_3'], count);
        appendComponents(columns, req.geometric, 'scale', ['scale_0', 'scale_1', 'scale_2'], ['scale_0', 'scale_1', 'scale_2'], count);
        appendComponents(columns, req.geometric, 'opacity', ['opacity'], ['opacity'], count);
        const rest = SH_REST_COUNTS[meta.shBands] ?? 0;
        appendComponents(columns, req.color, 'dc', ['f_dc_0', 'f_dc_1', 'f_dc_2'], ['f_dc_0', 'f_dc_1', 'f_dc_2'], count);
        appendComponents(columns, req.color, 'shRest', Array.from({ length: rest }, (_, i) => `f_rest_${i}`), Array.from({ length: rest }, (_, i) => `f_rest_${i}`), count);
        for (const extra of meta.extraColumns ?? []) {
            const values = fieldData(req.other, extra.name);
            if (values) columns.push(new Column(extra.name, new values.constructor(values)));
        }
        return new DataTable(columns, meta.transform);
    } finally {
        for (const data of acquired) data.release();
        pool.destroy();
    }
};

const gatherPositions = async (source, indices) => {
    const layout = source.meta.layouts.position;
    if (!layout) throw new Error('LOD0 source has no position layout');
    const pool = createChunkDataPool({ chunkSize: Math.max(1, indices.length), maxPooledBytes: 64 * 1024 * 1024 });
    const position = pool.acquire('position', layout, indices.length);
    try {
        await source.read({ lod: 0, indices, indexOffset: 0, count: indices.length, position });
        const x = componentData(position, 'position', ['x', 'y', 'z'], indices.length, 0);
        const y = componentData(position, 'position', ['x', 'y', 'z'], indices.length, 1);
        const z = componentData(position, 'position', ['x', 'y', 'z'], indices.length, 2);
        if (!x || !y || !z) throw new Error('LOD0 source has no x/y/z position fields');
        const result = new Float32Array(indices.length * 3);
        for (let i = 0; i < indices.length; i++) {
            result[i * 3] = x[i];
            result[i * 3 + 1] = y[i];
            result[i * 3 + 2] = z[i];
        }
        return result;
    } finally {
        position.release();
        pool.destroy();
    }
};

const boundsForPositions = (positions, indices) => {
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let i = 0; i < indices.length; i++) {
        const p = i * 3;
        for (let axis = 0; axis < 3; axis++) {
            bounds.min[axis] = Math.min(bounds.min[axis], positions[p + axis]);
            bounds.max[axis] = Math.max(bounds.max[axis], positions[p + axis]);
        }
    }
    return bounds;
};

const rangesForLocalIndices = (start, indices) => {
    const ranges = [];
    if (indices.length === 0) return ranges;
    let rangeStart = indices[0];
    let previous = indices[0];
    for (let i = 1; i < indices.length; i++) {
        const value = indices[i];
        if (value !== previous + 1) {
            ranges.push({ start: start + rangeStart, count: previous - rangeStart + 1 });
            rangeStart = value;
        }
        previous = value;
    }
    ranges.push({ start: start + rangeStart, count: previous - rangeStart + 1 });
    return ranges;
};

const splitOversizedLccUnit = async (source, unit) => {
    const local = new Uint32Array(unit.count);
    for (let i = 0; i < local.length; i++) local[i] = i;
    const rootIndices = new Uint32Array(unit.count);
    for (let i = 0; i < unit.count; i++) rootIndices[i] = unit.start + i;
    const rootPositions = await gatherPositions(source, rootIndices);
    const leaves = [];
    const visit = (indices, positions) => {
        const bounds = boundsForPositions(positions, indices);
        if (indices.length <= MAX_POINTS) {
            const sorted = Uint32Array.from(indices).sort();
            leaves.push({ count: sorted.length, bounds, ranges: rangesForLocalIndices(unit.start, sorted) });
            return;
        }
        const extents = bounds.max.map((value, axis) => value - bounds.min[axis]);
        const axis = extents[1] > extents[0] ? (extents[2] > extents[1] ? 2 : 1) : (extents[2] > extents[0] ? 2 : 0);
        const order = Array.from({ length: indices.length }, (_, index) => index)
            .sort((a, b) => positions[a * 3 + axis] - positions[b * 3 + axis]);
        const middle = Math.ceil(order.length / 2);
        const makeChild = (ordered) => {
            const childIndices = Uint32Array.from(ordered);
            const childPositions = new Float32Array(childIndices.length * 3);
            for (let i = 0; i < childIndices.length; i++) {
                const sourcePosition = ordered[i];
                childIndices[i] = indices[sourcePosition];
                childPositions[i * 3] = positions[sourcePosition * 3];
                childPositions[i * 3 + 1] = positions[sourcePosition * 3 + 1];
                childPositions[i * 3 + 2] = positions[sourcePosition * 3 + 2];
            }
            visit(childIndices, childPositions);
        };
        makeChild(order.slice(0, middle));
        makeChild(order.slice(middle));
    };
    visit(local, rootPositions);
    return leaves;
};

const sessionMap = new Map();

const openLodEditSession = async ({ filePath, proxyLod }) => {
    if (!filePath || !fs.existsSync(filePath)) throw new Error('LOD edit source file does not exist');
    const root = path.dirname(filePath);
    const filename = path.basename(filePath);
    const lower = filename.toLowerCase();
    if (!lower.endsWith('.lcc') && !lower.endsWith('.lcc2')) throw new Error('LOD edit requires an LCC or LCC2 source');
    const fsys = new NodeDirectoryFileSystem(root);
    const format = getInputFormat(filename);
    const sources = await readFile({ filename, inputFormat: format, options: { iterations: 1, logging: 'silent' }, params: [], fileSystem: fsys });
    if (!sources?.[0]) throw new Error('Failed to open LCC source');
    const source = sources[0];
    const meta = readJson(filePath);
    const totalLevels = Number(meta.totalLevel ?? meta.totalLevels ?? source.meta.numLods);
    if (!Number.isInteger(totalLevels) || proxyLod >= totalLevels) {
        for (const item of sources) await item.close();
        fsys.close();
        throw new Error(`Invalid proxy LOD ${proxyLod} (source has ${totalLevels} levels)`);
    }
    const indexData = lower.endsWith('.lcc') ? fs.readFileSync(path.join(root, 'index.bin')) : null;
    const pageInfo = lower.endsWith('.lcc') ? parseLccPages(meta, indexData, proxyLod) : parseLcc2Pages(meta, proxyLod);
    if (lower.endsWith('.lcc') && pageInfo.oversized?.length) {
        for (const unit of pageInfo.oversized) {
            const leaves = await splitOversizedLccUnit(source, unit);
            for (const leaf of leaves) {
                pageInfo.pages.push({
                    id: `lod0-part${String(pageInfo.pages.length).padStart(5, '0')}`,
                    lod: 0,
                    count: leaf.count,
                    bounds: leaf.bounds,
                    ranges: leaf.ranges
                });
            }
        }
        pageInfo.pages.sort((a, b) => a.ranges[0].start - b.ranges[0].start);
        pageInfo.pages.forEach((page, index) => {
            page.id = `lod0-part${String(index).padStart(5, '0')}`;
        });
        pageInfo.oversized = [];
    }
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const session = { id, filePath, root, format, source, sources, fsys, pageInfo, fingerprint: await fingerprint(filePath), createdAt: Date.now() };
    sessionMap.set(id, session);
    return {
        sessionId: id,
        version: PAGE_VERSION,
        magic: PAGE_MAGIC,
        sourceFingerprint: session.fingerprint,
        sourcePath: filePath,
        format: lower.endsWith('.lcc') ? 'lcc' : 'lcc2',
        proxyLod,
        totalLods: pageInfo.totalLods,
        totalPoints: pageInfo.totalPoints,
        bounds: pageInfo.bounds,
        pageCount: pageInfo.pages.length,
        workingSetBytes: WORKING_SET_BYTES,
        maxConcurrentPages: MAX_CONCURRENT_PAGES,
        pages: pageInfo.pages.map(({ sourceFile, ...page }) => ({ ...page, sourceFile }))
    };
};

const pageTempDir = path.join(os.tmpdir(), 'resplat-lod-pages');
fs.mkdirSync(pageTempDir, { recursive: true });

const loadLodEditPage = async (sessionId, pageId) => {
    const session = sessionMap.get(sessionId);
    if (!session) throw new Error('LOD edit session is closed');
    const page = session.pageInfo.pages.find(candidate => candidate.id === pageId);
    if (!page) throw new Error(`Unknown LOD edit page ${pageId}`);
    const indices = new Uint32Array(page.count);
    let cursor = 0;
    for (const range of page.ranges) {
        for (let i = 0; i < range.count; i++) indices[cursor++] = range.start + i;
    }
    if (cursor !== page.count) throw new Error(`Page ${pageId} range coverage mismatch`);
    const table = await gatherRows(session.source, indices);
    const outputName = `${sessionId}-${pageId}.ply`;
    const outputPath = path.join(pageTempDir, outputName);
    const memoryFs = new (await import('@playcanvas/splat-transform')).MemoryFileSystem();
    // Keep the source row order. The compressed-PLY writer intentionally
    // Morton-reorders rows, which would make sourceIndices impossible to
    // associate with the decoded page without another permutation table.
    await writeFile({ filename: outputName, outputFormat: 'ply', dataTable: table, options: {} }, memoryFs);
    const bytes = memoryFs.results.get(outputName);
    if (!bytes) throw new Error(`Failed to encode page ${pageId}`);
    fs.writeFileSync(outputPath, Buffer.from(bytes));
    const cleanupTimer = setTimeout(() => { try { fs.unlinkSync(outputPath); } catch {} }, 30 * 60 * 1000);
    cleanupTimer.unref?.();
    return {
        pageId,
        count: page.count,
        sourceIndices: Array.from(indices),
        url: `/temp/${encodeURIComponent(path.basename(outputPath))}`,
        bounds: page.bounds
    };
};

const closeLodEditSession = async (sessionId) => {
    const session = sessionMap.get(sessionId);
    if (!session) return;
    sessionMap.delete(sessionId);
    for (const source of session.sources) await source.close();
    session.fsys.close();
};

const cleanupLodEditSessions = () => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, session] of sessionMap) {
        if (session.createdAt < cutoff) closeLodEditSession(id).catch(() => {});
    }
};

export { closeLodEditSession, cleanupLodEditSessions, loadLodEditPage, openLodEditSession };
