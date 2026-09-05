/**
 * Regression test for the /api/lod-convert-path JS fallback.
 *
 * The compressed-Ply input deliberately bypasses the native PLY path, so this
 * exercises the same MemoryFileSystem-backed writer used when the native addon
 * is unavailable (for example in a packaged build without native binaries).
 *
 * Run: node scripts/test-lod-convert-path.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
    Column,
    DataTable,
    MemoryFileSystem,
    Transform,
    getOutputFormat,
    writeFile
} from '@playcanvas/splat-transform';

const require = createRequire(import.meta.url);
const { app } = require('../server.js');

const makeColumns = (count) => {
    const columns = [
        ['x', [0, 1]], ['y', [0, 1]], ['z', [0, 1]],
        ['scale_0', [-1, -1]], ['scale_1', [-1, -1]], ['scale_2', [-1, -1]],
        ['f_dc_0', [0, 0]], ['f_dc_1', [0, 0]], ['f_dc_2', [0, 0]],
        ['opacity', [0, 0]],
        ['rot_0', [0, 0]], ['rot_1', [0, 0]], ['rot_2', [0, 0]], ['rot_3', [1, 1]]
    ];
    return columns.map(([name, values]) => {
        const data = new Float32Array(count);
        data.set(values);
        return new Column(name, data);
    });
};

const inputName = `lod-convert-regression-${process.pid}.compressed.ply`;
const inputPath = path.join(os.tmpdir(), inputName);
const outputPaths = [];
const inputFs = new MemoryFileSystem();

try {
    const dataTable = new DataTable(makeColumns(2), Transform.PLY.clone());
    await writeFile({
        filename: inputName,
        outputFormat: getOutputFormat(inputName, {}),
        dataTable,
        options: {}
    }, inputFs);
    const inputBytes = inputFs.results.get(inputName);
    assert.ok(inputBytes, 'test fixture should be encoded');
    fs.writeFileSync(inputPath, inputBytes);

    const listener = await new Promise((resolve) => {
        const server = app.listen(0, () => resolve(server));
    });
    const port = listener.address().port;

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/lod-convert-path`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filePath: inputPath, levels: [100] })
        });
        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.levels.length, 1);
        assert.equal(body.levels[0].count, 2);
        assert.ok(body.levels[0].sizeBytes > 0);

        const outputName = decodeURIComponent(new URL(body.levels[0].url).pathname.split('/').pop());
        const outputPath = path.join(os.tmpdir(), 'resplat-temp', outputName);
        outputPaths.push(outputPath);
        assert.ok(fs.existsSync(outputPath), `output should exist: ${outputPath}`);

        console.log('PASS /api/lod-convert-path JS fallback returns a served compressed PLY');
    } finally {
        await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
} finally {
    fs.rmSync(inputPath, { force: true });
    for (const outputPath of outputPaths) fs.rmSync(outputPath, { force: true });
}
