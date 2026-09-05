import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import ts from 'typescript';

const sourceUrl = new URL('../src/paint-parameter-adjustment.ts', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022
    }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { paintParameterAdjustment } = await import(moduleUrl);

assert.deepEqual(paintParameterAdjustment(100, 100, 99, 100, null), { axis: null, delta: 0 });
assert.deepEqual(paintParameterAdjustment(100, 100, 50, 100, null), { axis: 'horizontal', delta: -50 });
assert.deepEqual(paintParameterAdjustment(100, 100, 150, 100, null), { axis: 'horizontal', delta: 50 });
assert.deepEqual(paintParameterAdjustment(100, 100, 100, 50, null), { axis: 'vertical', delta: 50 });
assert.deepEqual(paintParameterAdjustment(100, 100, 100, 150, null), { axis: 'vertical', delta: -50 });

// Once a direction is established, changing the dominant displacement must not
// switch axes and cause a sudden value jump.
const horizontal = paintParameterAdjustment(100, 100, 140, 100, null);
assert.deepEqual(paintParameterAdjustment(100, 100, 140, 30, horizontal.axis), {
    axis: 'horizontal',
    delta: 40
});
const vertical = paintParameterAdjustment(100, 100, 100, 60, null);
assert.deepEqual(paintParameterAdjustment(100, 100, 170, 60, vertical.axis), {
    axis: 'vertical',
    delta: 40
});

console.log('paint parameter adjustment direction regression test passed');
