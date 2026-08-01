import { Color } from 'playcanvas';

import { GaussianLUT } from './lut';

const SH_C0 = 0.28209479177387814;

const dcDecode = (v: number) => v * SH_C0 + 0.5;
const dcEncode = (v: number) => (v - 0.5) / SH_C0;

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
const invSigmoid = (v: number) => ((v <= 0) ? -400 : ((v >= 1) ? 400 : -Math.log(1 / v - 1)));

// HSL mixer: 8 color ranges (red, orange, yellow, green, aqua, blue, purple, magenta)
// Centers in degrees, widths in degrees (full range = center ± width/2)
const HSL_CENTERS_DEG = [0, 30, 60, 120, 165, 220, 275, 315];
const HSL_HALF_WIDTHS_DEG = [20, 20, 20, 25, 20, 25, 20, 20];

// Pre-computed normalized (0-1) Float32Arrays for shader uniforms
const HSL_CENTERS_F32 = new Float32Array(HSL_CENTERS_DEG.map(d => d / 360));
const HSL_HALF_WIDTHS_F32 = new Float32Array(HSL_HALF_WIDTHS_DEG.map(d => d / 360));

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

// RGB to HSL. Returns [h, s, l] with h in [0, 1]
const rgb2hsl = (r: number, g: number, b: number): [number, number, number] => {
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    const l = (maxc + minc) * 0.5;
    const d = maxc - minc;
    let h = 0;
    let s = 0;
    if (d > 1e-6) {
        s = (l < 0.5) ? d / (maxc + minc) : d / (2 - maxc - minc);
        if (maxc === r) {
            h = (g - b) / d + (g < b ? 6 : 0);
        } else if (maxc === g) {
            h = (b - r) / d + 2;
        } else {
            h = (r - g) / d + 4;
        }
        h *= 0.16666667;  // /6
    }
    return [h, s, l];
};

// hue to RGB helper
const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 0.16666667) return p + (q - p) * 6 * t;
    if (t < 0.5) return q;
    if (t < 0.66666667) return p + (q - p) * (0.66666667 - t) * 6;
    return p;
};

// HSL to RGB. h in [0, 1]
const hsl2rgb = (h: number, s: number, l: number): [number, number, number] => {
    if (s < 1e-6) return [l, l, l];
    const q = (l < 0.5) ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
        hue2rgb(p, q, h + 0.33333333),
        hue2rgb(p, q, h),
        hue2rgb(p, q, h - 0.33333333)
    ];
};

// Color range weight with smooth falloff and hue wrap-around (all normalized 0-1)
const rangeWeight = (hue: number, center: number, halfWidth: number) => {
    let d = Math.abs(hue - center);
    d = Math.min(d, 1 - d);
    if (d >= halfWidth) return 0;
    // smoothstep: 0 at halfWidth, 1 at 0
    const t = 1 - d / halfWidth;
    return t * t * (3 - 2 * t);
};

type GradeParams = {
    tintClr: Color,
    temperature: number,
    saturation: number,
    brightness: number,
    blackPoint: number,
    whitePoint: number,
    transparency: number,
    hslHueShifts?: Float32Array,   // length 8, normalized [-0.5, 0.5]
    hslSatShifts?: Float32Array,   // length 8, [-1, 1]
    hslLightShifts?: Float32Array,  // length 8, [-1, 1]
    lut?: GaussianLUT | null,       // 16^3 3D LUT (null = no LUT)
    lutIntensity?: number           // 0..1, 0 = LUT off
};

type RGB = { r: number, g: number, b: number };

class ColorGrade {
    private s: RGB;
    private offset: number;
    private saturation: number;
    private transparency: number;
    private hslHueShifts: Float32Array | null;
    private hslSatShifts: Float32Array | null;
    private hslLightShifts: Float32Array | null;
    private hasHslShift: boolean;
    private lut: GaussianLUT | null;
    private lutIntensity: number;
    readonly hasLut: boolean;

    readonly hasTint: boolean;

    constructor(p: GradeParams) {
        const scale = 1 / (p.whitePoint - p.blackPoint);
        this.s = {
            r: scale * p.tintClr.r * (1 + p.temperature),
            g: scale * p.tintClr.g,
            b: scale * p.tintClr.b * (1 - p.temperature)
        };
        this.offset = -p.blackPoint + p.brightness;
        this.saturation = p.saturation;
        this.transparency = p.transparency;

        this.hslHueShifts = p.hslHueShifts ?? null;
        this.hslSatShifts = p.hslSatShifts ?? null;
        this.hslLightShifts = p.hslLightShifts ?? null;

        this.hasHslShift = false;
        if (this.hslHueShifts) {
            for (let i = 0; i < 8; i++) {
                if (this.hslHueShifts[i] !== 0 || this.hslSatShifts[i] !== 0 || this.hslLightShifts[i] !== 0) {
                    this.hasHslShift = true;
                    break;
                }
            }
        }

        this.lut = p.lut ?? null;
        this.lutIntensity = p.lutIntensity ?? 0;
        this.hasLut = !!this.lut && this.lutIntensity > 0;

        this.hasTint = (
            !p.tintClr.equals(Color.WHITE) ||
            p.temperature !== 0 ||
            p.saturation !== 1 ||
            p.brightness !== 0 ||
            p.blackPoint !== 0 ||
            p.whitePoint !== 1 ||
            this.hasHslShift ||
            this.hasLut
        );
    }

    private apply(c: RGB, offset: number) {
        c.r = offset + c.r * this.s.r;
        c.g = offset + c.g * this.s.g;
        c.b = offset + c.b * this.s.b;

        const grey = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
        c.r = grey + (c.r - grey) * this.saturation;
        c.g = grey + (c.g - grey) * this.saturation;
        c.b = grey + (c.b - grey) * this.saturation;
    }

    private applyHSL(c: RGB) {
        if (!this.hasHslShift) return;
        const hsl = rgb2hsl(c.r, c.g, c.b);
        let totalW = 0;
        let sumH = 0;
        let sumS = 0;
        let sumL = 0;
        for (let i = 0; i < 8; i++) {
            const w = rangeWeight(hsl[0], HSL_CENTERS_F32[i], HSL_HALF_WIDTHS_F32[i]);
            totalW += w;
            sumH += w * this.hslHueShifts[i];
            sumS += w * this.hslSatShifts[i];
            sumL += w * this.hslLightShifts[i];
        }
        if (totalW > 1e-4) {
            const invW = 1 / totalW;
            hsl[0] = ((hsl[0] + sumH * invW) % 1 + 1) % 1;
            hsl[1] = clamp(hsl[1] + sumS * invW, 0, 1);
            hsl[2] = clamp(hsl[2] + sumL * invW, 0, 1);
            const rgb = hsl2rgb(hsl[0], hsl[1], hsl[2]);
            c.r = rgb[0];
            c.g = rgb[1];
            c.b = rgb[2];
        }
    }

    applyDC(c: RGB) {
        this.apply(c, this.offset);
        this.applyHSL(c);
        // apply LUT color grading (non-linear, like HSL — DC only, not SH)
        if (this.hasLut && this.lut) {
            const [nr, ng, nb] = this.lut.sample(c.r, c.g, c.b);
            const t = this.lutIntensity;
            const it = 1 - t;
            c.r = c.r * it + nr * t;
            c.g = c.g * it + ng * t;
            c.b = c.b * it + nb * t;
        }
    }

    applySH(c: RGB) {
        this.apply(c, 0);
        // HSL is not applied to SH coefficients — HSL is a non-linear transform
        // and SH represents view-dependent deviations from the DC base color.
    }

    applyOpacity(o: number): number {
        return invSigmoid(sigmoid(o) * this.transparency);
    }

    applyAlpha(o: number): number {
        return sigmoid(o) * this.transparency;
    }
}

export { ColorGrade, dcDecode, dcEncode, sigmoid, invSigmoid, SH_C0, HSL_CENTERS_F32, HSL_HALF_WIDTHS_F32 };
export type { GradeParams, RGB };
