import {
    BLENDEQUATION_MAX,
    BLENDMODE_ONE,
    BlendState,
    Color,
    GSPLAT_STREAM_INSTANCE,
    GSplatProcessor,
    GSplatResource,
    PIXELFORMAT_RGBA8,
    Texture,
    Vec3
} from 'playcanvas';

import { dcDecode, dcEncode } from './color-grade';
import { mergeQueuedPaintSample } from './paint-pick';
import type { Splat } from './splat';

const PAINT_STREAM = 'paintColor';

// Painting uses MAX blending so repeated samples in the same stroke do not
// accidentally compound their strength. The stroke uses one fixed color and
// strength, so MAX also preserves every texel written by earlier samples.
const paintBlendState = new BlendState(
    true,
    BLENDEQUATION_MAX,
    BLENDMODE_ONE,
    BLENDMODE_ONE,
    BLENDEQUATION_MAX,
    BLENDMODE_ONE,
    BLENDMODE_ONE
);

const processGLSL = /* glsl */ `
uniform vec4 uPaintSphere;
uniform vec4 uPaintColor;
uniform float uPaintHardness;
uniform highp sampler2D splatState;
uniform highp sampler2D soloMask;
uniform highp usampler2D splatTransform;
uniform highp sampler2D transformPalette;

vec3 getPaintCenter() {
    vec3 center = getCenter();
    uint transformIndex = texelFetch(splatTransform, splat.uv, 0).r;
    if (transformIndex == 0u) {
        return center;
    }

    int u = int(transformIndex % 512u) * 3;
    int v = int(transformIndex / 512u);
    mat4 transform;
    transform[0] = texelFetch(transformPalette, ivec2(u, v), 0);
    transform[1] = texelFetch(transformPalette, ivec2(u + 1, v), 0);
    transform[2] = texelFetch(transformPalette, ivec2(u + 2, v), 0);
    transform[3] = vec4(0.0, 0.0, 0.0, 1.0);
    return (transpose(transform) * vec4(center, 1.0)).xyz;
}

void process() {
    vec4 result = vec4(0.0);
    uint vertexState = uint(texelFetch(splatState, splat.uv, 0).r * 255.0 + 0.5) & 7u;
    bool editable = (vertexState & 6u) == 0u;
    bool visible = texelFetch(soloMask, splat.uv, 0).r >= 0.5;

    if (editable && visible) {
        vec3 center = getPaintCenter();
        float distanceToCenter = distance(center, uPaintSphere.xyz);
        if (distanceToCenter < uPaintSphere.w) {
            float hardness = clamp(uPaintHardness, 0.0, 1.0);
            float falloff = hardness >= 0.999
                ? 1.0
                : 1.0 - smoothstep(uPaintSphere.w * hardness, uPaintSphere.w, distanceToCenter);
            result = uPaintColor;
            result.a *= falloff;
        }
    }

    writePaintColor(result);
}
`;

type PaintSettings = {
    color: Color;
    strength: number;
    hardness: number;
    radius: number;
};

type PaintStrokeDelta = {
    indices: Uint32Array;
    before: Float32Array;
    after: Float32Array;
    colors: Float32Array;
};

type PaintEraseDelta = {
    indices: Uint32Array;
    strengths: Float32Array;
};

type PaintSampleData = {
    indices: Uint32Array;
    colors: Float32Array;
};

class SplatPaintRuntime {
    readonly splat: Splat;
    readonly texture: Texture;

    private processor: GSplatProcessor;
    private sphere = new Float32Array(4);
    private color = new Float32Array(4);
    private queuedSamples = new Map<number, Float32Array>();
    private previewEnabled = true;
    private destroyed = false;

    constructor(splat: Splat) {
        this.splat = splat;

        const resource = splat.asset.resource as GSplatResource;
        if (!resource.format.getStream(PAINT_STREAM)) {
            resource.format.addExtraStreams([{
                name: PAINT_STREAM,
                format: PIXELFORMAT_RGBA8,
                storage: GSPLAT_STREAM_INSTANCE
            }]);
        }

        // The stroke overlay belongs to this Splat instance, not to its backing
        // resource. Multiple scene objects are allowed to reference one resource
        // (for example after duplication); a resource texture would make every
        // such object sample the stroke while the pointer is held down.
        const { x: width, y: height } = resource.textureDimensions;
        const texture = Texture.createDataTexture2D(
            resource.device,
            `${PAINT_STREAM}-${splat.uid}`,
            width,
            height,
            PIXELFORMAT_RGBA8
        );
        this.texture = texture;
        this.clear();

        // GSplatProcessor resolves instance streams through a component binding.
        // Legacy rendering does not create engine-owned instance textures, so
        // provide the runtime-owned texture explicitly while retaining the real
        // resource for stream layout and Gaussian count information.
        const paintDestination = {
            resource,
            getInstanceTexture: (name: string) => (name === PAINT_STREAM ? texture : null)
        };

        this.processor = new GSplatProcessor(
            resource.device,
            { resource },
            { component: paintDestination as any, streams: [PAINT_STREAM] },
            { processGLSL }
        );
        this.processor.blendState = paintBlendState;
        this.processor.setParameter('splatState', splat.stateTexture);
        this.processor.setParameter('soloMask', splat.soloMaskTexture);
        this.processor.setParameter('splatTransform', splat.transformTexture);
        this.processor.setParameter('transformPalette', splat.transformPalette.texture);
        this.processor.setParameter('uPaintSphere', this.sphere);
        this.processor.setParameter('uPaintColor', this.color);
        this.processor.setParameter('uPaintHardness', 1);

        splat.setPaintTexture(texture);
    }

    setPreviewEnabled(enabled: boolean) {
        if (this.destroyed || this.previewEnabled === enabled) return;
        this.previewEnabled = enabled;
        this.splat.setPaintTexture(enabled ? this.texture : null);
        if (this.splat.scene) this.splat.scene.forceRender = true;
    }

    paintSphere(center: Vec3, settings: PaintSettings) {
        if (this.destroyed || !this.splat.scene) return;

        this.sphere[0] = center.x;
        this.sphere[1] = center.y;
        this.sphere[2] = center.z;
        this.sphere[3] = Math.max(settings.radius, 1e-8);
        this.color[0] = settings.color.r;
        this.color[1] = settings.color.g;
        this.color[2] = settings.color.b;
        this.color[3] = Math.min(1, Math.max(0, settings.strength));
        this.processor.setParameter('uPaintHardness', Math.min(1, Math.max(0, settings.hardness)));

        this.processor.process();
        this.splat.scene.forceRender = true;
    }

    paintSamples({ indices, colors }: PaintSampleData) {
        if (this.destroyed || !this.splat.scene) return;
        if (colors.length !== indices.length * 4) {
            throw new Error('Paint samples require four RGBA values per splat.');
        }

        const data = this.texture.lock() as Uint8Array;
        for (let i = 0; i < indices.length; ++i) {
            const splatIndex = indices[i];
            if (splatIndex >= this.splat.splatData.numSplats) continue;
            const src = i * 4;
            const dst = splatIndex * 4;
            data[dst] = Math.round(Math.min(1, Math.max(0, colors[src])) * 255);
            data[dst + 1] = Math.round(Math.min(1, Math.max(0, colors[src + 1])) * 255);
            data[dst + 2] = Math.round(Math.min(1, Math.max(0, colors[src + 2])) * 255);
            data[dst + 3] = Math.round(Math.min(1, Math.max(0, colors[src + 3])) * 255);
        }
        this.texture.unlock();
        this.splat.scene.forceRender = true;
    }

    // Brush paint-through IDs come from asynchronous screen-space picking.
    // Defer them until commit so CPU texture writes cannot race the processor's
    // GPU sphere writes. MAX-strength semantics match paintBlendState.
    queuePaintSample(splatIndex: number, color: Color, strength: number) {
        if (this.destroyed || !this.splat.scene || splatIndex < 0 || splatIndex >= this.splat.splatData.numSplats) return;

        const alpha = Math.min(1, Math.max(0, strength));
        const queued = this.queuedSamples.get(splatIndex);
        if (queued && queued[3] >= alpha) return;
        this.queuedSamples.set(splatIndex, new Float32Array([color.r, color.g, color.b, alpha]));
    }

    private async readStrokePixels() {
        if (this.destroyed || !this.splat.scene) {
            return null;
        }

        const resource = this.splat.asset.resource as GSplatResource;
        const { x: width, y: height } = resource.textureDimensions;
        const pixels = await this.texture.read(0, 0, width, height, {
            immediate: true
        }) as Uint8Array;

        if (this.destroyed || !this.splat.scene) {
            return null;
        }

        const count = this.splat.splatData.numSplats;
        for (const [splatIndex, sample] of this.queuedSamples) {
            if (splatIndex >= count) continue;
            mergeQueuedPaintSample(pixels, splatIndex, sample);
        }
        return pixels;
    }

    async commit(): Promise<PaintStrokeDelta | null> {
        const pixels = await this.readStrokePixels();
        if (!pixels) return null;

        const count = this.splat.splatData.numSplats;

        let changed = 0;
        for (let i = 0; i < count; ++i) {
            if (pixels[i * 4 + 3] !== 0) changed++;
        }

        if (changed === 0) {
            this.clear();
            return null;
        }

        const indices = new Uint32Array(changed);
        const before = new Float32Array(changed * 3);
        const after = new Float32Array(changed * 3);
        const colors = new Float32Array(changed * 4);
        const dc0 = this.splat.splatData.getProp('f_dc_0') as Float32Array;
        const dc1 = this.splat.splatData.getProp('f_dc_1') as Float32Array;
        const dc2 = this.splat.splatData.getProp('f_dc_2') as Float32Array;

        let dst = 0;
        for (let i = 0; i < count; ++i) {
            const pixel = i * 4;
            const strength = pixels[pixel + 3] / 255;
            if (strength === 0) continue;

            const value = dst * 3;
            indices[dst] = i;
            before[value] = dc0[i];
            before[value + 1] = dc1[i];
            before[value + 2] = dc2[i];

            const invStrength = 1 - strength;
            after[value] = dcEncode(dcDecode(dc0[i]) * invStrength + pixels[pixel] / 255 * strength);
            after[value + 1] = dcEncode(dcDecode(dc1[i]) * invStrength + pixels[pixel + 1] / 255 * strength);
            after[value + 2] = dcEncode(dcDecode(dc2[i]) * invStrength + pixels[pixel + 2] / 255 * strength);
            const color = dst * 4;
            colors[color] = pixels[pixel] / 255;
            colors[color + 1] = pixels[pixel + 1] / 255;
            colors[color + 2] = pixels[pixel + 2] / 255;
            colors[color + 3] = strength;
            dst++;
        }

        this.splat.applyPaintValues(indices, after);
        this.clear();
        return { indices, before, after, colors };
    }

    async commitErase(): Promise<PaintEraseDelta | null> {
        const pixels = await this.readStrokePixels();
        if (!pixels) return null;

        const count = this.splat.splatData.numSplats;
        let changed = 0;
        for (let i = 0; i < count; ++i) {
            if (pixels[i * 4 + 3] !== 0) changed++;
        }

        if (changed === 0) {
            this.clear();
            return null;
        }

        const indices = new Uint32Array(changed);
        const strengths = new Float32Array(changed);
        let dst = 0;
        for (let i = 0; i < count; ++i) {
            const strength = pixels[i * 4 + 3] / 255;
            if (strength === 0) continue;
            indices[dst] = i;
            strengths[dst] = strength;
            dst++;
        }

        this.clear();
        return { indices, strengths };
    }

    clear() {
        if (this.destroyed) return;
        this.queuedSamples.clear();
        const data = this.texture.lock() as Uint8Array;
        data.fill(0);
        this.texture.unlock();
        if (this.splat.scene) this.splat.scene.forceRender = true;
    }

    destroy() {
        if (this.destroyed) return;
        this.clear();
        this.destroyed = true;
        this.processor?.destroy();
        this.splat.setPaintTexture(null);
        this.texture.destroy();
    }
}

export { SplatPaintRuntime };
export type { PaintEraseDelta, PaintSampleData, PaintSettings, PaintStrokeDelta };
