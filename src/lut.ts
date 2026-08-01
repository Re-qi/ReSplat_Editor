// 16^3 3D LUT packed as a 256x16 PNG texture.
// Layout: 16 B-slices laid out horizontally, each slice is 16x16 (R along X, G along Y).
// The "16x1" naming refers to 16 tiles x 1 row of tiles.

const LUT_WIDTH = 256;
const LUT_HEIGHT = 16;
const TILE = 16;          // tile size in texels (16x16 per B-slice)
const LEVELS = 16;        // per-channel levels (16^3 = 4096 entries)

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/**
 * A 16^3 3D color LUT backed by a 256x16 RGBA Uint8ClampedArray.
 * Used both for GPU preview (texture) and CPU-side export baking (sample()).
 */
class GaussianLUT {
    /** RGBA pixel data, length = 256 * 16 * 4 = 16384. */
    data: Uint8ClampedArray;
    /** Display name (e.g. "纯净", "调色", or filename). */
    name: string;
    /** Preset identifier when loaded from a bundled preset, null for custom. */
    presetId: string | null;

    constructor(data: Uint8ClampedArray, name: string, presetId: string | null = null) {
        if (data.length !== LUT_WIDTH * LUT_HEIGHT * 4) {
            throw new Error(`LUT data must be ${LUT_WIDTH}x${LUT_HEIGHT}x4 = ${LUT_WIDTH * LUT_HEIGHT * 4} bytes, got ${data.length}`);
        }
        this.data = data;
        this.name = name;
        this.presetId = presetId;
    }

    /**
     * Trilinear sample of the 3D LUT.
     * Input r,g,b in [0,1]. Returns [r,g,b] in [0,1].
     * Matches the GPU shader applyLUT(): bilinear within each B-slice (R,G),
     * linear across B-slices. Texel-index mapping r -> 15*r so r=0 -> texel 0,
     * r=1 -> texel 15 (no cross-tile bleed).
     */
    sample(r: number, g: number, b: number): [number, number, number] {
        const data = this.data;

        const bIdx = clamp(b, 0, 1) * (LEVELS - 1);
        const b0 = Math.floor(bIdx);
        const b1 = Math.min(b0 + 1, LEVELS - 1);
        const bF = bIdx - b0;

        const rIdx = clamp(r, 0, 1) * (LEVELS - 1);
        const gIdx = clamp(g, 0, 1) * (LEVELS - 1);
        const r0 = Math.floor(rIdx);
        const r1 = Math.min(r0 + 1, LEVELS - 1);
        const g0 = Math.floor(gIdx);
        const g1 = Math.min(g0 + 1, LEVELS - 1);
        const rF = rIdx - r0;
        const gF = gIdx - g0;

        // fetch texel (bSlice, rx, gy) -> [r,g,b] in 0..1
        const fetch = (bSlice: number, rx: number, gy: number): [number, number, number] => {
            const x = bSlice * TILE + rx;
            const y = gy;
            const idx = (y * LUT_WIDTH + x) * 4;
            return [data[idx] / 255, data[idx + 1] / 255, data[idx + 2] / 255];
        };

        // bilinear within tile for a given b-slice
        const bilinear = (bSlice: number): [number, number, number] => {
            const c00 = fetch(bSlice, r0, g0);
            const c10 = fetch(bSlice, r1, g0);
            const c01 = fetch(bSlice, r0, g1);
            const c11 = fetch(bSlice, r1, g1);
            const ir = 1 - rF;
            const ig = 1 - gF;
            return [
                (c00[0] * ir + c10[0] * rF) * ig + (c01[0] * ir + c11[0] * rF) * gF,
                (c00[1] * ir + c10[1] * rF) * ig + (c01[1] * ir + c11[1] * rF) * gF,
                (c00[2] * ir + c10[2] * rF) * ig + (c01[2] * ir + c11[2] * rF) * gF
            ];
        };

        const cb0 = bilinear(b0);
        const cb1 = bilinear(b1);
        const ib = 1 - bF;
        return [
            cb0[0] * ib + cb1[0] * bF,
            cb0[1] * ib + cb1[1] * bF,
            cb0[2] * ib + cb1[2] * bF
        ];
    }

    /** Serialize custom LUT as a PNG data URL for .respproj embedding. */
    toDataURL(): string {
        const canvas = document.createElement('canvas');
        canvas.width = LUT_WIDTH;
        canvas.height = LUT_HEIGHT;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Failed to get 2D context for LUT serialization');
        const imgData = ctx.createImageData(LUT_WIDTH, LUT_HEIGHT);
        imgData.data.set(this.data);
        ctx.putImageData(imgData, 0, 0);
        return canvas.toDataURL('image/png');
    }

    /** Construct from raw ImageData (must be 256x16). */
    static fromImageData(imgData: ImageData, name: string, presetId: string | null = null): GaussianLUT {
        if (imgData.width !== LUT_WIDTH || imgData.height !== LUT_HEIGHT) {
            throw new Error(`LUT image must be ${LUT_WIDTH}x${LUT_HEIGHT}, got ${imgData.width}x${imgData.height}`);
        }
        // copy to detach from the ImageData's underlying buffer
        const data = new Uint8ClampedArray(imgData.data);
        return new GaussianLUT(data, name, presetId);
    }

    /** Construct from an ImageBitmap / HTMLImageElement (decoded PNG). */
    static fromImageBitmap(img: ImageBitmap | HTMLImageElement, name: string, presetId: string | null = null): GaussianLUT {
        const canvas = document.createElement('canvas');
        canvas.width = LUT_WIDTH;
        canvas.height = LUT_HEIGHT;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Failed to get 2D context for LUT decode');
        ctx.drawImage(img, 0, 0, LUT_WIDTH, LUT_HEIGHT);
        const imgData = ctx.getImageData(0, 0, LUT_WIDTH, LUT_HEIGHT);
        return GaussianLUT.fromImageData(imgData, name, presetId);
    }

    /** Construct from a File (PNG). Works in browser and Electron renderer. */
    static async fromFile(file: File, name?: string): Promise<GaussianLUT> {
        const bitmap = await createImageBitmap(file);
        const lut = GaussianLUT.fromImageBitmap(bitmap, name ?? file.name, null);
        bitmap.close?.();
        return lut;
    }

    /** Construct from a URL (bundled preset). */
    static async fromUrl(url: string, name: string, presetId: string): Promise<GaussianLUT> {
        const resp = await fetch(url);
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob);
        const lut = GaussianLUT.fromImageBitmap(bitmap, name, presetId);
        bitmap.close?.();
        return lut;
    }

    /** Deserialize from a PNG data URL (custom LUT stored in .respproj). */
    static async fromDataURL(dataURL: string, name: string): Promise<GaussianLUT> {
        const resp = await fetch(dataURL);
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob);
        const lut = GaussianLUT.fromImageBitmap(bitmap, name, null);
        bitmap.close?.();
        return lut;
    }
}

export { GaussianLUT, LUT_WIDTH, LUT_HEIGHT };
