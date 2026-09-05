import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import ts from 'typescript';

const sourceUrl = new URL('../src/paint-pick.ts', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022
    }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { calculateDecalCoverageStrength, mergeQueuedPaintSample, visitDistinctPaintPickIds } = await import(moduleUrl);

assert.equal(calculateDecalCoverageStrength(1, 4, 1, 0.02), 0.25);
assert.equal(calculateDecalCoverageStrength(0.019, 1, 1, 0.02), 0);
assert.equal(calculateDecalCoverageStrength(4, 4, 0.8, 0.02), 0.8);

const visibleIds = new Uint32Array([9, 0xffffffff, 4, 8]);
const penetratedIds = new Uint32Array([2, 3, 4, 99]);
const visited = [];

visitDistinctPaintPickIds(
    [visibleIds, penetratedIds],
    visibleIds.length,
    10,
    (pixelIndex, splatIndex) => visited.push([pixelIndex, splatIndex])
);

assert.deepEqual(visited, [
    [0, 9],
    [0, 2],
    [1, 3],
    [2, 4],
    [3, 8]
]);

const paintPixels = new Uint8Array([
    10, 20, 30, 200,
    0, 0, 0, 0
]);
mergeQueuedPaintSample(paintPixels, 0, [1, 0, 0, 0.5]);
mergeQueuedPaintSample(paintPixels, 1, [0.25, 0.5, 0.75, 0.4]);
assert.deepEqual([...paintPixels], [
    10, 20, 30, 200,
    64, 128, 191, 102
]);

console.log('paint-through pick-layer regression test passed');
