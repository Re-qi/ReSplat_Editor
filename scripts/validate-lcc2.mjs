// LCC2 (Lixel CyberColor 2) structural validator.
//
// Usage:  node scripts/validate-lcc2.mjs <path-to-XXX.lcc2>
//
// Validates an LCC2 metadata file and its sibling `data/` tree:
//   1. JSON parse (tolerant of trailing commas before }/], like splat-transform).
//   2. Top-level required fields present with correct shapes.
//   3. root has splatFiles/meshFiles/bvhFiles; root.data may be null/absent/env.
//   4. Tree walk from root.child (object-keyed or array): childNum matches child
//      count, id present, boundingBox min<=max; data.3dgs.name is a valid
//      splatFiles index; start+count within chunk bounds; per-file ranges
//      non-overlapping and fully covering [0, chunkCount).
//   5. Resolve each referenced chunk's point count WITHOUT full WebP decode:
//      .sog -> unzip meta.json (V2 `count`, V1 `means.shape[0]`); .spz -> 16-byte
//      header numPoints. Degrades to SKIPPED if no zip lib / read fails.
//   6. LOD consistency: non-root data nodes at depth d -> LOD level
//      totalLevels - d; lodSplats is indexed finest(0)->coarsest(L-1);
//      per-level sums match lodSplats; totalSplats == sum of all node counts.
//   7. Prints a per-check PASS/FAIL/SKIP report and an overall result.
//
// Only uses node built-ins + already-installed deps (yauzl for zip, zlib for
// gzip-wrapped spz). No npm installs.

import { open as fsOpen, readFile as fsReadFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
// yauzl is a CJS module present in node_modules; load lazily so a missing lib
// degrades to SKIPPED instead of crashing the validator.
let yauzl = null;
try {
    yauzl = require('yauzl');
} catch {
    yauzl = null;
}

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

const results = [];
const check = (name, status, detail = '') => {
    results.push({ name, status, detail });
    const tag = `[${status}] ${name}`;
    console.log(detail ? `${tag}\n        ${detail}` : tag);
};

// ---------------------------------------------------------------------------
// Tolerant JSON parse (strip trailing commas before } or ])
// ---------------------------------------------------------------------------

const tolerantJsonParse = (text) => {
    // First try strict parse (the common case — XGRIDS output is strict JSON).
    try {
        return JSON.parse(text);
    } catch {
        // Fall back: scan and remove a comma whose next non-whitespace char is
        // '}' or ']', while skipping over string literals (handles strings that
        // contain ",}" sequences). Mirrors splat-transform's tolerance.
        let out = '';
        let inStr = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inStr) {
                out += c;
                if (c === '\\') {
                    // Preserve the escaped char verbatim.
                    if (i + 1 < text.length) {
                        out += text[i + 1];
                        i++;
                    }
                } else if (c === '"') {
                    inStr = false;
                }
                continue;
            }
            if (c === '"') {
                inStr = true;
                out += c;
                continue;
            }
            if (c === ',') {
                // Peek ahead for the next non-whitespace char.
                let j = i + 1;
                while (j < text.length && /\s/.test(text[j])) j++;
                if (j < text.length && (text[j] === '}' || text[j] === ']')) {
                    // Drop the trailing comma.
                    continue;
                }
            }
            out += c;
        }
        return JSON.parse(out);
    }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const is3Vec = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');

// Return a node's children as an array, supporting object-keyed (`{"0":..}`) or
// array forms. null/absent child -> empty array.
const getChildren = (node) => {
    const child = node?.child;
    if (!child) return [];
    if (Array.isArray(child)) return child;
    if (typeof child === 'object') return Object.values(child);
    return [];
};

// Read a single entry out of a ZIP file via yauzl. Resolves to a Buffer or null.
const readZipEntry = (zipPath, entryName) => new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        zipfile.on('entry', (entry) => {
            if (entry.fileName === entryName) {
                zipfile.openReadStream(entry, (e, stream) => {
                    if (e) return reject(e);
                    const chunks = [];
                    stream.on('data', (c) => chunks.push(c));
                    stream.on('end', () => resolve(Buffer.concat(chunks)));
                    stream.on('error', reject);
                });
            } else {
                zipfile.readEntry();
            }
        });
        zipfile.on('end', () => resolve(null));
        zipfile.readEntry();
    });
});

// Resolve a chunk's splat count without decoding WebP.
//   .sog -> unzip + parse meta.json (V2 `count`; V1 `means.shape[0]`)
//   .spz -> 16-byte header numPoints (uint32 LE @ offset 8), gunzipping a
//           gzip-wrapped container first.
// Throws on unsupported type / unreadable file.
const resolveChunkCount = async (chunkPath, splatType) => {
    if (splatType === '.sog') {
        if (!yauzl) throw new Error('no zip library available (yauzl missing)');
        const buf = await readZipEntry(chunkPath, 'meta.json');
        if (!buf) throw new Error('meta.json not found in .sog zip');
        const meta = JSON.parse(buf.toString('utf8'));
        if (meta.version === undefined) {
            // V1: texture shape holds the splat count.
            const c = meta.means?.shape?.[0];
            if (!Number.isInteger(c) || c < 0) throw new Error('V1 means.shape[0] invalid');
            return c;
        }
        if (meta.version === 2) {
            if (!Number.isInteger(meta.count) || meta.count < 0) throw new Error('V2 count invalid');
            return meta.count;
        }
        throw new Error(`unsupported .sog meta version ${meta.version}`);
    }
    if (splatType === '.spz') {
        const handle = await fsOpen(chunkPath, 'r');
        try {
            const head = Buffer.alloc(16);
            await handle.read(head, 0, 16, 0);
            let buf = head;
            if (head[0] === 0x1f && head[1] === 0x8b) {
                // gzip-wrapped v1-3 container: gunzip the whole file (spz chunks
                // are modest) to recover the 16-byte header.
                await handle.close();
                const raw = zlib.gunzipSync(await fsReadFile(chunkPath));
                buf = raw.subarray(0, 16);
            } else {
                await handle.close();
            }
            const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            return view.getUint32(8, true);
        } finally {
            // close is idempotent-safe; the gzip branch closes early.
            try { await handle.close(); } catch { /* already closed */ }
        }
    }
    throw new Error(`unsupported splatType for chunk count: ${splatType}`);
};

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

const validate = async (lcc2Path) => {
    console.log(`=== LCC2 Validator: ${lcc2Path} ===\n`);

    // ---- 1. Read + parse ----
    let meta;
    try {
        const text = await fsReadFile(lcc2Path, 'utf8');
        meta = tolerantJsonParse(text);
        check('1. JSON parse', 'PASS');
    } catch (e) {
        check('1. JSON parse', 'FAIL', e.message);
        console.log('\n=== RESULT: FAIL (unparseable metadata) ===');
        process.exitCode = 1;
        return;
    }

    const dir = path.dirname(lcc2Path);

    // ---- 2. Top-level required fields ----
    {
        const errs = [];
        const expect = (k, pred, msg) => {
            if (!pred(meta[k])) errs.push(`${k}: ${msg}`);
        };
        expect('version', (v) => typeof v === 'string' && v.length > 0, 'missing/empty string');
        expect('name', (v) => typeof v === 'string', 'missing string');
        expect('guid', (v) => typeof v === 'string' && v.length > 0, 'missing/empty string');
        expect('source', (v) => typeof v === 'string' && v.length > 0, 'missing/empty string');
        expect('dataType', (v) => typeof v === 'string' && v.length > 0, 'missing/empty string');
        expect('epsg', (v) => typeof v === 'number' && Number.isFinite(v), 'missing number');
        expect('offset', is3Vec, 'must be number[3]');
        expect('shift', is3Vec, 'must be number[3]');
        expect('scale', is3Vec, 'must be number[3]');
        expect('fileType', (v) => v === 'quality' || v === 'portable', 'must be "quality" or "portable"');
        expect('totalSplats', (v) => typeof v === 'number' && v >= 0, 'missing non-negative number');
        expect('lodSplats', (v) => Array.isArray(v) && v.every((n) => typeof n === 'number'), 'must be number[]');
        expect('totalLevels', (v) => Number.isInteger(v) && v >= 1, 'must be integer >= 1');
        // splatType: .sog / .spz supported by readLcc2; .ply flagged as not
        // roundtrip-compatible (readLcc2 only decodes .sog/.spz chunks).
        expect('splatType', (v) => typeof v === 'string', 'missing string');
        expect('root', (v) => v && typeof v === 'object', 'missing object');
        expect('renderingHints', (v) => v && typeof v === 'object', 'missing object');

        if (meta.splatType === '.ply') {
            errs.push('splatType ".ply" is not ReSplat-roundtrip compatible (readLcc2 only decodes .sog/.spz)');
        } else if (meta.splatType !== '.sog' && meta.splatType !== '.spz') {
            errs.push(`splatType "${meta.splatType}" not in {.sog, .spz}`);
        }

        if (errs.length) check('2. Top-level fields', 'FAIL', errs.join('; '));
        else check('2. Top-level fields', 'PASS');
    }

    const root = meta.root;
    const splatType = meta.splatType;
    const splatFiles = root?.splatFiles;
    const totalLevels = meta.totalLevels;
    const lodSplats = meta.lodSplats;

    // ---- 3. root structure ----
    {
        const errs = [];
        if (!Array.isArray(splatFiles)) errs.push('root.splatFiles must be string[]');
        else if (!splatFiles.every((f) => typeof f === 'string')) errs.push('root.splatFiles entries must be strings');
        if (!Array.isArray(root.meshFiles)) errs.push('root.meshFiles must be array');
        if (!Array.isArray(root.bvhFiles)) errs.push('root.bvhFiles must be array');
        // root.data may be null/absent or an object (e.g. containing env).
        if (root.data != null && typeof root.data !== 'object') errs.push('root.data must be null or object');
        if (errs.length) check('3. root structure (splatFiles/meshFiles/bvhFiles/data)', 'FAIL', errs.join('; '));
        else check('3. root structure (splatFiles/meshFiles/bvhFiles/data)', 'PASS');
    }

    // ---- 4. Tree walk ----
    // Collect: every node (depth), and every data.3dgs reference.
    const dataRefs = []; // { id, depth, name, start, count }
    let treeOk = true;
    const treeErrs = [];
    const bboxOk = [];

    // BFS from root (depth 0). root itself is validated for bbox/childNum but
    // is not a data node.
    const queue = [{ node: root, depth: 0 }];
    while (queue.length) {
        const { node, depth } = queue.shift();
        if (!node || typeof node !== 'object') {
            treeErrs.push(`depth ${depth}: non-object node`);
            treeOk = false;
            continue;
        }
        if (typeof node.id !== 'string' || node.id.length === 0) {
            treeErrs.push(`depth ${depth}: id missing`);
            treeOk = false;
        }
        // boundingBox min<=max componentwise
        const bb = node.boundingBox;
        if (!bb || !is3Vec(bb.min) || !is3Vec(bb.max)) {
            treeErrs.push(`node ${node.id}: boundingBox.min/max must be number[3]`);
            treeOk = false;
        } else {
            const minLEmax = bb.min.every((m, i) => m <= bb.max[i]);
            bboxOk.push(minLEmax);
            if (!minLEmax) {
                treeErrs.push(`node ${node.id}: boundingBox min > max componentwise`);
                treeOk = false;
            }
        }
        // childNum == child count
        const kids = getChildren(node);
        if (typeof node.childNum !== 'number' || node.childNum !== kids.length) {
            treeErrs.push(`node ${node.id}: childNum=${node.childNum} != child count ${kids.length}`);
            treeOk = false;
        }
        // data.3dgs (root data is allowed to be null/env; non-root may hold 3dgs)
        if (node.data && node.data['3dgs']) {
            const g = node.data['3dgs'];
            dataRefs.push({ id: node.id, depth, name: g.name, start: g.start, count: g.count });
        }
        for (const k of kids) queue.push({ node: k, depth: depth + 1 });
    }
    check('4a. Tree walk (id / childNum / boundingBox)', treeOk ? 'PASS' : 'FAIL',
        treeOk ? '' : treeErrs.join('; '));

    // ---- 4b. data.3dgs index validity (independent of chunk reads) ----
    {
        const errs = [];
        const nFiles = Array.isArray(splatFiles) ? splatFiles.length : 0;
        for (const r of dataRefs) {
            if (!Number.isInteger(r.name) || r.name < 0 || r.name >= nFiles) {
                errs.push(`node ${r.id}: data.3dgs.name=${r.name} out of [0,${nFiles})`);
            }
            if (typeof r.start !== 'number' || r.start < 0) {
                errs.push(`node ${r.id}: start=${r.start} invalid`);
            }
            if (typeof r.count !== 'number' || r.count <= 0) {
                errs.push(`node ${r.id}: count=${r.count} must be > 0`);
            }
        }
        check('4b. data.3dgs index/start/count validity', errs.length ? 'FAIL' : 'PASS',
            errs.length ? errs.join('; ') : `${dataRefs.length} data node(s) referenced`);
    }

    // ---- 5. Resolve chunk counts for referenced files ----
    // name -> { count: number|null, status: 'ok'|'skipped'|'fail', reason }
    const chunkCounts = new Map();
    const referencedNames = [...new Set(dataRefs.map((r) => r.name).filter((n) => Number.isInteger(n)))];
    let zipAvailable = !!yauzl;
    for (const name of referencedNames) {
        const rel = splatFiles[name];
        const chunkPath = path.join(dir, rel);
        try {
            const count = await resolveChunkCount(chunkPath, splatType);
            chunkCounts.set(name, { count, status: 'ok' });
        } catch (e) {
            if (splatType === '.sog' && !zipAvailable) {
                chunkCounts.set(name, { count: null, status: 'skipped', reason: 'no zip lib' });
            } else {
                chunkCounts.set(name, { count: null, status: 'fail', reason: e.message });
            }
        }
    }
    {
        const ok = [...chunkCounts.values()].filter((c) => c.status === 'ok').length;
        const skip = [...chunkCounts.values()].filter((c) => c.status === 'skipped').length;
        const fail = [...chunkCounts.values()].filter((c) => c.status === 'fail').length;
        const detail = `${ok} resolved, ${skip} skipped, ${fail} failed (of ${referencedNames.length} referenced files)`;
        if (fail) check('5. Resolve referenced chunk counts', 'FAIL', detail);
        else if (skip && !ok) check('5. Resolve referenced chunk counts', 'SKIP', detail);
        else check('5. Resolve referenced chunk counts', 'PASS', detail);
    }

    // ---- 4c. start+count bounds + per-file non-overlap + full coverage ----
    {
        const errs = [];
        // group refs by file name
        const byFile = new Map();
        for (const r of dataRefs) {
            if (!byFile.has(r.name)) byFile.set(r.name, []);
            byFile.get(r.name).push(r);
        }
        for (const [name, refs] of byFile) {
            const cc = chunkCounts.get(name);
            // bounds against chunk count
            if (cc && cc.count != null) {
                for (const r of refs) {
                    if (r.start + r.count > cc.count) {
                        errs.push(`file[${name}] (${splatFiles[name]}): node ${r.id} start+count=${r.start + r.count} > chunkCount=${cc.count}`);
                    }
                }
            }
            // non-overlap + full coverage (when count known)
            const sorted = [...refs].sort((a, b) => a.start - b.start);
            for (let i = 1; i < sorted.length; i++) {
                if (sorted[i].start < sorted[i - 1].start + sorted[i - 1].count) {
                    errs.push(`file[${name}] (${splatFiles[name]}): overlapping ranges at node ${sorted[i].id} (start=${sorted[i].start}) vs ${sorted[i - 1].id} (end=${sorted[i - 1].start + sorted[i - 1].count})`);
                }
            }
            if (cc && cc.count != null) {
                const sum = refs.reduce((s, r) => s + r.count, 0);
                if (sum !== cc.count) {
                    errs.push(`file[${name}] (${splatFiles[name]}): node count sum=${sum} != chunkCount=${cc.count} (not fully partitioned)`);
                }
            }
        }
        // status: FAIL on hard errors; SKIP if any file was skipped and none failed
        const anySkipped = [...chunkCounts.values()].some((c) => c.status === 'skipped');
        const anyFailed = [...chunkCounts.values()].some((c) => c.status === 'fail');
        if (errs.length) check('4c. Per-file range bounds / non-overlap / coverage', 'FAIL', errs.join('; '));
        else if (anyFailed) check('4c. Per-file range bounds / non-overlap / coverage', 'FAIL', 'chunk count resolution failed (see check 5)');
        else if (anySkipped) check('4c. Per-file range bounds / non-overlap / coverage', 'SKIP', 'chunk counts skipped — bounds/coverage not checked');
        else check('4c. Per-file range bounds / non-overlap / coverage', 'PASS', `${byFile.size} referenced file(s)`);
    }

    // ---- 6. LOD consistency ----
    {
        const errs = [];
        // Sum counts per LOD level. Non-root data nodes at depth d -> LOD level
        // totalLevels - d. lodSplats indexed finest(0) -> coarsest(L-1), so
        // lodSplats[lodLevel] must equal the depth-(totalLevels - lodLevel) sum.
        const sumByLod = new Array(totalLevels).fill(0);
        let totalNodeSum = 0;
        let nodesBeyondLevels = 0;
        for (const r of dataRefs) {
            if (r.depth === 0) {
                // root carrying 3dgs is unexpected; ignore for LOD sums.
                continue;
            }
            const lodLevel = totalLevels - r.depth;
            if (lodLevel < 0 || lodLevel >= totalLevels) {
                nodesBeyondLevels++;
                errs.push(`node ${r.id}: depth ${r.depth} exceeds totalLevels ${totalLevels}`);
                continue;
            }
            sumByLod[lodLevel] += r.count;
            totalNodeSum += r.count;
        }
        // per-level match against lodSplats
        if (!Array.isArray(lodSplats) || lodSplats.length !== totalLevels) {
            errs.push(`lodSplats length ${lodSplats?.length} != totalLevels ${totalLevels}`);
        } else {
            for (let i = 0; i < totalLevels; i++) {
                if (sumByLod[i] !== lodSplats[i]) {
                    errs.push(`lodSplats[${i}]=${lodSplats[i]} != sum at LOD ${i} (depth ${totalLevels - i})=${sumByLod[i]}`);
                }
            }
        }
        // totalSplats == sum of all node counts (counts every LOD level, with
        // cross-level duplication). Single-level: lodSplats[0]==totalSplats==leaf.
        if (meta.totalSplats !== totalNodeSum) {
            errs.push(`totalSplats=${meta.totalSplats} != sum of all node counts=${totalNodeSum}`);
        }
        if (totalLevels === 1) {
            const leaf = dataRefs.reduce((s, r) => s + r.count, 0);
            if (lodSplats[0] !== meta.totalSplats || lodSplats[0] !== leaf) {
                errs.push(`single-level: lodSplats[0]=${lodSplats[0]} / totalSplats=${meta.totalSplats} / leafSum=${leaf} must be equal`);
            }
        }
        check('6. LOD consistency (lodSplats / totalSplats)', errs.length ? 'FAIL' : 'PASS',
            errs.length ? errs.join('; ') : `totalLevels=${totalLevels}, totalSplats=${meta.totalSplats}, lodSplats=[${lodSplats?.join(',')}]`);
    }

    // ---- Summary ----
    const fails = results.filter((r) => r.status === 'FAIL').length;
    const passes = results.filter((r) => r.status === 'PASS').length;
    const skips = results.filter((r) => r.status === 'SKIP').length;
    console.log(`\n--- Summary: ${passes} PASS, ${skips} SKIP, ${fails} FAIL ---`);
    if (fails === 0) {
        console.log('=== RESULT: PASS ===');
        process.exitCode = 0;
    } else {
        console.log('=== RESULT: FAIL ===');
        process.exitCode = 1;
    }
};

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const arg = process.argv[2];
if (!arg) {
    console.error('Usage: node scripts/validate-lcc2.mjs <path-to-XXX.lcc2>');
    process.exit(2);
}
validate(arg).catch((e) => {
    console.error('Validator crashed:', e);
    process.exit(1);
});
