type PickIdVisitor = (pixelIndex: number, splatIndex: number) => void;

const invalidPickId = 0xffffffff;

const toPaintByte = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);

const calculateDecalCoverageStrength = (
    coveredAlpha: number,
    footprintPixels: number,
    decalStrength: number,
    cutoff: number
) => {
    if (!Number.isFinite(coveredAlpha) || !Number.isFinite(footprintPixels) || footprintPixels <= 0) return 0;
    const coverage = Math.min(1, Math.max(0, coveredAlpha / footprintPixels));
    const threshold = Math.min(1, Math.max(0, cutoff));
    if (coverage < threshold) return 0;
    return coverage * Math.min(1, Math.max(0, decalStrength));
};

const mergeQueuedPaintSample = (pixels: Uint8Array, splatIndex: number, sample: ArrayLike<number>) => {
    const pixel = splatIndex * 4;
    if (pixel < 0 || pixel + 3 >= pixels.length) return;

    const sampleAlpha = toPaintByte(sample[3]);
    if (sampleAlpha <= pixels[pixel + 3]) return;
    pixels[pixel] = toPaintByte(sample[0]);
    pixels[pixel + 1] = toPaintByte(sample[1]);
    pixels[pixel + 2] = toPaintByte(sample[2]);
    pixels[pixel + 3] = sampleAlpha;
};

// Visit paintable IDs while preserving their source pixel. A splat can appear
// in both the ordinary visible layer and the low-alpha paint-through layer, so
// duplicate IDs are removed per pixel without dropping either depth layer.
const visitDistinctPaintPickIds = (
    layers: ArrayLike<number>[],
    pixelCount: number,
    splatCount: number,
    visit: PickIdVisitor
) => {
    for (let pixelIndex = 0; pixelIndex < pixelCount; ++pixelIndex) {
        for (let layerIndex = 0; layerIndex < layers.length; ++layerIndex) {
            const splatIndex = layers[layerIndex][pixelIndex];
            if (splatIndex === undefined || splatIndex === invalidPickId || splatIndex >= splatCount) continue;

            let duplicate = false;
            for (let previousLayer = 0; previousLayer < layerIndex; ++previousLayer) {
                if (layers[previousLayer][pixelIndex] === splatIndex) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) visit(pixelIndex, splatIndex);
        }
    }
};

export { calculateDecalCoverageStrength, invalidPickId, mergeQueuedPaintSample, visitDistinctPaintPickIds };
export type { PickIdVisitor };
