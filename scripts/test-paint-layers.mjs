import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import ts from 'typescript';

const sourceUrl = new URL('../src/paint-layer-blend.ts', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022
    }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const {
    PAINT_BLEND_MODES,
    accumulatePaintLayerRgba,
    blendModeRgb,
    blendPaintLayerRgb,
    compositePaintLayerRgb,
    erasePaintLayerRgba
} = await import(moduleUrl);

const namingSourceUrl = new URL('../src/paint-layer-naming.ts', import.meta.url);
const namingSource = readFileSync(namingSourceUrl, 'utf8');
const namingCompiled = ts.transpileModule(namingSource, {
    compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022
    }
}).outputText;
const namingModuleUrl = `data:text/javascript;base64,${Buffer.from(namingCompiled).toString('base64')}`;
const { nextAvailablePaintLayerNumber } = await import(namingModuleUrl);

const assertRgbClose = (actual, expected, epsilon = 1e-10) => {
    assert.equal(actual.length, expected.length);
    actual.forEach((value, index) => {
        assert.ok(Math.abs(value - expected[index]) <= epsilon, `${value} != ${expected[index]} at channel ${index}`);
    });
};

const baseline = [0, 0, 0];
const redHalf = [1, 0, 0, 0.5];
const blueHalf = [0, 0, 1, 0.5];

const redThenBlue = blendPaintLayerRgb(blendPaintLayerRgb(baseline, redHalf), blueHalf);
assert.deepEqual(redThenBlue, [0.25, 0, 0.5]);

// Hiding the red layer must rebuild from the original baseline instead of
// retaining red in the blue layer's cached result.
const blueOnly = blendPaintLayerRgb(baseline, blueHalf);
assert.deepEqual(blueOnly, [0, 0, 0.5]);

// Strength and source channels are clamped to the shader's normalized range.
assert.deepEqual(blendPaintLayerRgb([0.2, 0.4, 0.6], [2, -1, 0.5, 2]), [1, 0, 0.5]);

// Match the requested Photoshop-style menu, with Dissolve intentionally absent.
assert.equal(PAINT_BLEND_MODES.length, 26);
assert.equal(PAINT_BLEND_MODES.includes('dissolve'), false);
for (const mode of PAINT_BLEND_MODES) {
    const result = blendModeRgb([0, 0.35, 1], [1, 0.65, 0], mode);
    assert.equal(result.length, 3);
    assert.equal(result.every(value => Number.isFinite(value) && value >= 0 && value <= 1), true, mode);
}

assertRgbClose(blendModeRgb([0.8, 0.5, 0.2], [0.5, 0.5, 0.5], 'multiply'), [0.4, 0.25, 0.1]);
assertRgbClose(blendModeRgb([0.8, 0.5, 0.2], [0.5, 0.5, 0.5], 'screen'), [0.9, 0.75, 0.6]);
assertRgbClose(blendModeRgb([0.8, 0.5, 0.2], [0.5, 0.5, 0.5], 'difference'), [0.3, 0, 0.3]);
assertRgbClose(blendModeRgb([0.2, 0.4, 0.6], [0.1, 0.2, 0.3], 'linear-dodge'), [0.3, 0.6, 0.9]);

// Brush samples first accumulate into a transparent layer. Layer opacity is
// applied only once when that finished layer is composited onto its backdrop.
let layer = accumulatePaintLayerRgba([0, 0, 0, 0], redHalf);
layer = accumulatePaintLayerRgba(layer, blueHalf);
assertRgbClose(layer, [0.25, 0, 0.5, 0.75]);
const layerSource = [layer[0] / layer[3], layer[1] / layer[3], layer[2] / layer[3]];
assertRgbClose(compositePaintLayerRgb(baseline, layerSource, layer[3], 'normal', 0.5), [0.125, 0, 0.25]);

// Erasing scales premultiplied color and alpha together, revealing lower
// layers without tinting or otherwise modifying their pixels.
assertRgbClose(erasePaintLayerRgba(layer, 0.5), [0.125, 0, 0.25, 0.375]);
assertRgbClose(erasePaintLayerRgba(layer, 1), [0, 0, 0, 0]);

// The lower layer is established first and the upper layer blends against it.
const lower = compositePaintLayerRgb(baseline, [0, 0, 1], 1, 'normal');
const upper = compositePaintLayerRgb(lower, [1, 0, 0], 1, 'screen');
assertRgbClose(upper, [1, 0, 1]);

// Display names reuse the smallest number no longer visible, while deleted
// tombstones remain available to undo/redo through their separate unique IDs.
assert.equal(nextAvailablePaintLayerNumber([]), 1);
assert.equal(nextAvailablePaintLayerNumber([{ name: '图层 1' }]), 2);
assert.equal(nextAvailablePaintLayerNumber([
    { name: '图层 1' },
    { name: '图层 2', deleted: true }
]), 2);
assert.equal(nextAvailablePaintLayerNumber([
    { name: '图层 1' },
    { name: '图层 3' }
]), 2);

console.log('paint layer compositing regression test passed');
