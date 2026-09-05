/**
 * Regression test for native-less HTML export.
 *
 * The production failure occurs when htmlExportToPath falls back to
 * fs.readFileSync(sourcePath): Node rejects source files larger than 2 GiB
 * before parsing them. This test uses a tiny PLY but forbids whole-file reads
 * of the source, forcing the same code seam to use seekable range reads.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as splatLib from '@playcanvas/splat-transform';

import { htmlExportToPath } from '../server/html-export.mjs';
import { lcc2ExportToPath } from '../server/lcc2-export.mjs';

const properties = [
    'x', 'y', 'z',
    'rot_0', 'rot_1', 'rot_2', 'rot_3',
    'scale_0', 'scale_1', 'scale_2',
    'opacity',
    'f_dc_0', 'f_dc_1', 'f_dc_2'
];

const makePly = () => {
    const header = Buffer.from([
        'ply',
        'format binary_little_endian 1.0',
        'element vertex 2',
        ...properties.map(name => `property float ${name}`),
        'end_header',
        ''
    ].join('\n'));
    const rows = Buffer.alloc(2 * properties.length * 4);
    const values = [
        [0, 0, 0, 1, 0, 0, 0, -2, -2, -2, 4, 0, 0, 0],
        [1, 1, 1, 1, 0, 0, 0, -2, -2, -2, 4, 0.1, 0.2, 0.3]
    ];
    let offset = 0;
    for (const row of values) {
        for (const value of row) {
            rows.writeFloatLE(value, offset);
            offset += 4;
        }
    }
    return Buffer.concat([header, rows]);
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resplat-html-read-test-'));
const inputPath = path.join(tempDir, 'source.ply');
const outputPath = path.join(tempDir, 'viewer.html');
fs.writeFileSync(inputPath, makePly());

const originalReadFileSync = fs.readFileSync;
let forbiddenReadCount = 0;
fs.readFileSync = function patchedReadFileSync(filename, ...args) {
    if (typeof filename === 'string' && path.resolve(filename) === path.resolve(inputPath)) {
        forbiddenReadCount++;
        throw new Error('SOURCE_READ_FILE_SYNC_FORBIDDEN');
    }
    return originalReadFileSync.call(this, filename, ...args);
};

try {
    const result = await htmlExportToPath(
        inputPath,
        outputPath,
        { shBands: 0, iterations: 0 },
        splatLib,
        null
    );

    assert.equal(forbiddenReadCount, 0, 'HTML export must not read the whole source file');
    assert.equal(result.numSplats, 2);
    assert.ok(fs.statSync(outputPath).size > 0, 'HTML output should be non-empty');

    const lcc2Result = await lcc2ExportToPath(
        inputPath,
        tempDir,
        { name: 'lcc2-range-read', lodLevels: 1, shBands: 0, iterations: 0, simplifyMethod: 'uniform' },
        splatLib,
        null
    );
    assert.equal(forbiddenReadCount, 0, 'LCC2 export must not read the whole source file');
    assert.equal(lcc2Result.totalSplats, 2);
    assert.ok(fs.existsSync(path.join(lcc2Result.outputPath, 'lcc2-range-read.lcc2')));

    console.log('PASS native-less backend exports use seekable range reads');
} finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(tempDir, { recursive: true, force: true });
}
