import assert from 'node:assert/strict';

import { shrinkwrapOpacityLayers, shrinkwrapSplatOpacity } from '../src/shrinkwrap-opacity.ts';

const compositeOpacity = pointOpacity => 1 - (1 - pointOpacity) ** shrinkwrapOpacityLayers;
const samples = [0, 0.2, 0.5, 0.8, 0.9999];

let previous = -1;
for (const desired of samples) {
    const pointOpacity = shrinkwrapSplatOpacity(desired);
    assert.ok(pointOpacity > previous, `point opacity must increase at ${desired}`);
    assert.ok(Math.abs(compositeOpacity(pointOpacity) - desired) < 1e-10,
        `composite opacity must reconstruct ${desired}`);
    previous = pointOpacity;
}

// This is the original failure mode: writing slider=0.2 to every overlapping
// Gaussian already produced a nearly opaque result.
assert.ok(compositeOpacity(0.2) > 0.9);
// The compensated midpoint is deliberately close to the old visually useful
// per-point range while reconstructing a 50% composite result.
assert.ok(shrinkwrapSplatOpacity(0.5) > 0.05 && shrinkwrapSplatOpacity(0.5) < 0.07);

console.log('shrinkwrap opacity mapping: ok');
