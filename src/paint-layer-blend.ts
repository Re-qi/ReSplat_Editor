type Rgb = [number, number, number];
type PremultipliedRgba = [number, number, number, number];

const PAINT_BLEND_MODE_GROUPS = [
    ['normal'],
    ['darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color'],
    ['lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color'],
    ['overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix'],
    ['difference', 'exclusion', 'subtract', 'divide'],
    ['hue', 'saturation', 'color', 'luminosity']
] as const;

type PaintBlendMode = typeof PAINT_BLEND_MODE_GROUPS[number][number];

const PAINT_BLEND_MODES = PAINT_BLEND_MODE_GROUPS.flat() as PaintBlendMode[];
const PAINT_BLEND_MODE_SET = new Set<string>(PAINT_BLEND_MODES);

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const isPaintBlendMode = (value: unknown): value is PaintBlendMode => (
    typeof value === 'string' && PAINT_BLEND_MODE_SET.has(value)
);

const colorBurn = (backdrop: number, source: number) => {
    if (backdrop >= 1) return 1;
    if (source <= 0) return 0;
    return 1 - Math.min(1, (1 - backdrop) / source);
};

const colorDodge = (backdrop: number, source: number) => {
    if (backdrop <= 0) return 0;
    if (source >= 1) return 1;
    return Math.min(1, backdrop / (1 - source));
};

const softLight = (backdrop: number, source: number) => {
    if (source <= 0.5) {
        return backdrop - (1 - 2 * source) * backdrop * (1 - backdrop);
    }
    const d = backdrop <= 0.25 ? ((16 * backdrop - 12) * backdrop + 4) * backdrop : Math.sqrt(backdrop);
    return backdrop + (2 * source - 1) * (d - backdrop);
};

const vividLight = (backdrop: number, source: number) => (
    source <= 0.5 ? colorBurn(backdrop, 2 * source) : colorDodge(backdrop, 2 * source - 1)
);

const blendChannel = (backdrop: number, source: number, mode: PaintBlendMode) => {
    switch (mode) {
        case 'normal': return source;
        case 'darken': return Math.min(backdrop, source);
        case 'multiply': return backdrop * source;
        case 'color-burn': return colorBurn(backdrop, source);
        case 'linear-burn': return Math.max(0, backdrop + source - 1);
        case 'lighten': return Math.max(backdrop, source);
        case 'screen': return backdrop + source - backdrop * source;
        case 'color-dodge': return colorDodge(backdrop, source);
        case 'linear-dodge': return Math.min(1, backdrop + source);
        case 'overlay': return backdrop <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
        case 'soft-light': return softLight(backdrop, source);
        case 'hard-light': return source <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
        case 'vivid-light': return vividLight(backdrop, source);
        case 'linear-light': return clamp01(backdrop + 2 * source - 1);
        case 'pin-light': return source <= 0.5 ? Math.min(backdrop, 2 * source) : Math.max(backdrop, 2 * source - 1);
        case 'hard-mix': return vividLight(backdrop, source) < 0.5 ? 0 : 1;
        case 'difference': return Math.abs(backdrop - source);
        case 'exclusion': return backdrop + source - 2 * backdrop * source;
        case 'subtract': return Math.max(0, backdrop - source);
        case 'divide': return source <= 0 ? 1 : Math.min(1, backdrop / source);
        default: return source;
    }
};

const luminosity = (color: Rgb) => 0.3 * color[0] + 0.59 * color[1] + 0.11 * color[2];
const saturation = (color: Rgb) => Math.max(...color) - Math.min(...color);
const channelTotal = (color: Rgb) => color[0] + color[1] + color[2];

const clipColor = (color: Rgb): Rgb => {
    const result: Rgb = [...color];
    const luminance = luminosity(result);
    const minimum = Math.min(...result);
    const maximum = Math.max(...result);

    if (minimum < 0) {
        const divisor = luminance - minimum;
        for (let i = 0; i < 3; ++i) {
            result[i] = divisor === 0 ? luminance : luminance + ((result[i] - luminance) * luminance) / divisor;
        }
    }
    if (maximum > 1) {
        const divisor = maximum - luminance;
        for (let i = 0; i < 3; ++i) {
            result[i] = divisor === 0 ? luminance : luminance + ((result[i] - luminance) * (1 - luminance)) / divisor;
        }
    }
    return result.map(clamp01) as Rgb;
};

const setLuminosity = (color: Rgb, luminance: number): Rgb => {
    const delta = luminance - luminosity(color);
    return clipColor([color[0] + delta, color[1] + delta, color[2] + delta]);
};

const setSaturation = (color: Rgb, target: number): Rgb => {
    const result: Rgb = [...color];
    const sorted = [0, 1, 2].sort((a, b) => result[a] - result[b]);
    const minIndex = sorted[0];
    const midIndex = sorted[1];
    const maxIndex = sorted[2];

    if (result[maxIndex] > result[minIndex]) {
        result[midIndex] = ((result[midIndex] - result[minIndex]) * target) / (result[maxIndex] - result[minIndex]);
        result[maxIndex] = target;
    } else {
        result[midIndex] = 0;
        result[maxIndex] = 0;
    }
    result[minIndex] = 0;
    return result;
};

const blendModeRgb = (backdrop: Rgb, source: Rgb, mode: PaintBlendMode): Rgb => {
    const cb = backdrop.map(clamp01) as Rgb;
    const cs = source.map(clamp01) as Rgb;

    switch (mode) {
        case 'darker-color': return channelTotal(cs) < channelTotal(cb) ? cs : cb;
        case 'lighter-color': return channelTotal(cs) > channelTotal(cb) ? cs : cb;
        case 'hue': return setLuminosity(setSaturation(cs, saturation(cb)), luminosity(cb));
        case 'saturation': return setLuminosity(setSaturation(cb, saturation(cs)), luminosity(cb));
        case 'color': return setLuminosity(cs, luminosity(cb));
        case 'luminosity': return setLuminosity(cb, luminosity(cs));
        default: return [
            blendChannel(cb[0], cs[0], mode),
            blendChannel(cb[1], cs[1], mode),
            blendChannel(cb[2], cs[2], mode)
        ].map(clamp01) as Rgb;
    }
};

const compositePaintLayerRgb = (
    backdrop: Rgb,
    source: Rgb,
    alpha: number,
    mode: PaintBlendMode = 'normal',
    opacity = 1
): Rgb => {
    const effectiveAlpha = clamp01(alpha) * clamp01(opacity);
    const blended = blendModeRgb(backdrop, source, mode);
    return [
        backdrop[0] * (1 - effectiveAlpha) + blended[0] * effectiveAlpha,
        backdrop[1] * (1 - effectiveAlpha) + blended[1] * effectiveAlpha,
        backdrop[2] * (1 - effectiveAlpha) + blended[2] * effectiveAlpha
    ].map(clamp01) as Rgb;
};

const accumulatePaintLayerRgba = (
    current: PremultipliedRgba,
    sample: ArrayLike<number>,
    offset = 0
): PremultipliedRgba => {
    const alpha = clamp01(sample[offset + 3]);
    const inverseAlpha = 1 - alpha;
    return [
        clamp01(sample[offset]) * alpha + current[0] * inverseAlpha,
        clamp01(sample[offset + 1]) * alpha + current[1] * inverseAlpha,
        clamp01(sample[offset + 2]) * alpha + current[2] * inverseAlpha,
        alpha + current[3] * inverseAlpha
    ];
};

const erasePaintLayerRgba = (
    current: PremultipliedRgba,
    strength: number
): PremultipliedRgba => {
    const remaining = 1 - clamp01(strength);
    return [
        current[0] * remaining,
        current[1] * remaining,
        current[2] * remaining,
        current[3] * remaining
    ];
};

const blendPaintLayerRgb = (
    current: Rgb,
    sample: ArrayLike<number>,
    offset = 0,
    mode: PaintBlendMode = 'normal',
    opacity = 1
): Rgb => compositePaintLayerRgb(
    current,
    [sample[offset], sample[offset + 1], sample[offset + 2]],
    sample[offset + 3],
    mode,
    opacity
);

export {
    PAINT_BLEND_MODES,
    PAINT_BLEND_MODE_GROUPS,
    accumulatePaintLayerRgba,
    blendModeRgb,
    blendPaintLayerRgb,
    compositePaintLayerRgb,
    erasePaintLayerRgba,
    isPaintBlendMode
};
export type { PaintBlendMode, PremultipliedRgba, Rgb };
