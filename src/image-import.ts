import { GSplatData } from 'playcanvas';

import { dcEncode, invSigmoid } from './color-grade';

// The longest image edge occupies two scene units. This keeps images of every
// resolution at a predictable size while preserving their aspect ratio.
const IMAGE_SCENE_EXTENT = 2;
const IN_PLANE_SCALE_IN_PIXELS = 0.5;
const DEPTH_SCALE_IN_PIXELS = 0.05;

type ImagePixels = Pick<ImageData, 'data' | 'height' | 'width'>;

const downsampleDimensions = (width: number, height: number, level: number) => {
    const divisor = 2 ** Math.max(0, Math.floor(level));
    return {
        width: Math.max(1, Math.floor(width / divisor)),
        height: Math.max(1, Math.floor(height / divisor))
    };
};

const floatProperty = (name: string, storage: Float32Array) => ({
    type: 'float',
    name,
    storage,
    byteSize: Float32Array.BYTES_PER_ELEMENT
});

/**
 * Convert an RGBA image to one editable Gaussian per non-transparent source
 * pixel. Fully transparent PNG pixels are omitted entirely; partially
 * transparent pixels retain their source opacity.
 *
 * The image is centred on the XY plane, with its top edge toward +Y. PNG alpha
 * becomes Gaussian opacity; JPEG pixels are fully opaque. RGB values are stored
 * as degree-zero spherical harmonics so they pass through the normal splat
 * rendering, editing, and export paths without a custom material.
 */
const imagePixelsToGSplatData = (
    image: ImagePixels,
    emptyImageMessage = 'The selected image contains no visible pixels'
): GSplatData => {
    const { data: pixels, width, height } = image;
    const numPixels = width * height;

    if (width <= 0 || height <= 0 || pixels.length !== numPixels * 4) {
        throw new Error('The selected image has invalid pixel data');
    }

    let numGaussians = 0;
    for (let pixel = 3; pixel < pixels.length; pixel += 4) {
        if (pixels[pixel] !== 0) numGaussians++;
    }
    if (numGaussians === 0) {
        throw new Error(emptyImageMessage);
    }

    const x = new Float32Array(numGaussians);
    const y = new Float32Array(numGaussians);
    const z = new Float32Array(numGaussians);
    const scale0 = new Float32Array(numGaussians);
    const scale1 = new Float32Array(numGaussians);
    const scale2 = new Float32Array(numGaussians);
    const dc0 = new Float32Array(numGaussians);
    const dc1 = new Float32Array(numGaussians);
    const dc2 = new Float32Array(numGaussians);
    const opacity = new Float32Array(numGaussians);
    const rot0 = new Float32Array(numGaussians);
    const rot1 = new Float32Array(numGaussians);
    const rot2 = new Float32Array(numGaussians);
    const rot3 = new Float32Array(numGaussians);

    const pixelSpacing = IMAGE_SCENE_EXTENT / Math.max(width, height);
    const inPlaneScale = Math.log(pixelSpacing * IN_PLANE_SCALE_IN_PIXELS);
    const depthScale = Math.log(pixelSpacing * DEPTH_SCALE_IN_PIXELS);
    const left = -(width - 1) * pixelSpacing * 0.5;
    const top = (height - 1) * pixelSpacing * 0.5;

    scale0.fill(inPlaneScale);
    scale1.fill(inPlaneScale);
    scale2.fill(depthScale);
    rot0.fill(1); // identity quaternion (w, x, y, z)

    let outputIndex = 0;
    for (let row = 0, i = 0; row < height; row++) {
        const py = top - row * pixelSpacing;
        for (let column = 0; column < width; column++, i++) {
            const pixel = i * 4;
            const alpha = pixels[pixel + 3];
            if (alpha === 0) continue;

            x[outputIndex] = left + column * pixelSpacing;
            y[outputIndex] = py;
            dc0[outputIndex] = dcEncode(pixels[pixel] / 255);
            dc1[outputIndex] = dcEncode(pixels[pixel + 1] / 255);
            dc2[outputIndex] = dcEncode(pixels[pixel + 2] / 255);
            opacity[outputIndex] = invSigmoid(alpha / 255);
            outputIndex++;
        }
    }

    return new GSplatData([{
        name: 'vertex',
        count: numGaussians,
        properties: [
            floatProperty('x', x),
            floatProperty('y', y),
            floatProperty('z', z),
            floatProperty('scale_0', scale0),
            floatProperty('scale_1', scale1),
            floatProperty('scale_2', scale2),
            floatProperty('f_dc_0', dc0),
            floatProperty('f_dc_1', dc1),
            floatProperty('f_dc_2', dc2),
            floatProperty('opacity', opacity),
            floatProperty('rot_0', rot0),
            floatProperty('rot_1', rot1),
            floatProperty('rot_2', rot2),
            floatProperty('rot_3', rot3)
        ]
    }]);
};

export { downsampleDimensions, imagePixelsToGSplatData };
export type { ImagePixels };
