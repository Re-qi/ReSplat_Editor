const vertexShader = /* glsl*/ `
#include "gsplatCommonVS"

uniform sampler2D splatState;

uniform vec4 selectedClr;
uniform vec4 lockedClr;

uniform vec3 clrOffset;
uniform vec4 clrScale;

varying mediump vec4 texCoord_flags;            // xy: texCoord, z: selected, w: locked
varying mediump vec4 color;
varying mediump float depthValue;               // Depth value for depth mode

#if PICK_PASS
    uniform uint pickOp;                        // 0: add, 1: remove, 2: set
    uniform int pickMode;                       // 0: pick id, 1: depth estimation
#endif

uniform int displayMode;                        // 0: color mode, 1: depth mode
uniform float near_clip;
uniform float far_clip;
uniform float depthCycleLength;                 // depth fmod cycle length (default 50)

mediump vec4 discardVec = vec4(0.0, 0.0, 2.0, 1.0);

uniform float saturation;

vec3 applySaturation(vec3 color) {
    vec3 grey = vec3(dot(color, vec3(0.299, 0.587, 0.114)));
    return grey + (color - grey) * saturation;
}

#if HSL_MIXER
uniform vec4 hslCenters[2];       // 8 hue centers (normalized 0-1), packed as 2 vec4
uniform vec4 hslHalfWidths[2];    // 8 half widths (normalized 0-1)
uniform vec4 hslHueShifts[2];     // 8 hue shifts (normalized, -0.5..0.5)
uniform vec4 hslSatShifts[2];     // 8 saturation shifts (-1..1)
uniform vec4 hslLightShifts[2];   // 8 lightness shifts (-1..1)

// RGB to HSL conversion. Returns vec3(h, s, l) with h in [0,1]
vec3 rgb2hsl(vec3 c) {
    float maxc = max(c.r, max(c.g, c.b));
    float minc = min(c.r, min(c.g, c.b));
    float l = (maxc + minc) * 0.5;
    float d = maxc - minc;
    float h = 0.0;
    float s = 0.0;
    if (d > 1e-6) {
        s = (l < 0.5) ? d / (maxc + minc) : d / (2.0 - maxc - minc);
        if (maxc == c.r) {
            h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
        } else if (maxc == c.g) {
            h = (c.b - c.r) / d + 2.0;
        } else {
            h = (c.r - c.g) / d + 4.0;
        }
        h *= 0.16666667;  // /6
    }
    return vec3(h, s, l);
}

// HSL to RGB conversion. h in [0,1]
vec3 hsl2rgb(vec3 hsl) {
    float h = hsl.x;
    float s = hsl.y;
    float l = hsl.z;
    if (s < 1e-6) return vec3(l);
    float q = (l < 0.5) ? l * (1.0 + s) : l + s - l * s;
    float p = 2.0 * l - q;
    float r = q;
    float g = q;
    float b = q;
    float[3] hk = float[3](h + 0.33333333, h, h - 0.33333333);
    float[3] rgb = float[3](r, g, b);
    for (int i = 0; i < 3; i++) {
        float t = hk[i];
        if (t < 0.0) t += 1.0;
        if (t > 1.0) t -= 1.0;
        if (t < 0.16666667) rgb[i] = p + (q - p) * 6.0 * t;
        else if (t < 0.5) rgb[i] = q;
        else if (t < 0.66666667) rgb[i] = p + (q - p) * (0.66666667 - t) * 6.0;
        else rgb[i] = p;
    }
    return vec3(rgb[0], rgb[1], rgb[2]);
}

// Color range weight with smooth falloff and hue wrap-around
float rangeWeight(float hue, float center, float halfWidth) {
    float d = abs(hue - center);
    d = min(d, 1.0 - d);
    return smoothstep(halfWidth, 0.0, d);
}

// Apply HSL mixer: 8 color ranges with weighted hue/sat/light adjustments
vec3 applyHslMixer(vec3 rgb) {
    vec3 hsl = rgb2hsl(rgb);
    float totalWeight = 0.0;
    float sumHue = 0.0;
    float sumSat = 0.0;
    float sumLight = 0.0;

    // Unpack 8 values from 2 vec4s
    float[8] centers = float[8](hslCenters[0].x, hslCenters[0].y, hslCenters[0].z, hslCenters[0].w,
                                 hslCenters[1].x, hslCenters[1].y, hslCenters[1].z, hslCenters[1].w);
    float[8] halfWidths = float[8](hslHalfWidths[0].x, hslHalfWidths[0].y, hslHalfWidths[0].z, hslHalfWidths[0].w,
                                    hslHalfWidths[1].x, hslHalfWidths[1].y, hslHalfWidths[1].z, hslHalfWidths[1].w);
    float[8] hueShifts = float[8](hslHueShifts[0].x, hslHueShifts[0].y, hslHueShifts[0].z, hslHueShifts[0].w,
                                   hslHueShifts[1].x, hslHueShifts[1].y, hslHueShifts[1].z, hslHueShifts[1].w);
    float[8] satShifts = float[8](hslSatShifts[0].x, hslSatShifts[0].y, hslSatShifts[0].z, hslSatShifts[0].w,
                                   hslSatShifts[1].x, hslSatShifts[1].y, hslSatShifts[1].z, hslSatShifts[1].w);
    float[8] lightShifts = float[8](hslLightShifts[0].x, hslLightShifts[0].y, hslLightShifts[0].z, hslLightShifts[0].w,
                                     hslLightShifts[1].x, hslLightShifts[1].y, hslLightShifts[1].z, hslLightShifts[1].w);

    for (int i = 0; i < 8; i++) {
        float w = rangeWeight(hsl.x, centers[i], halfWidths[i]);
        totalWeight += w;
        sumHue += w * hueShifts[i];
        sumSat += w * satShifts[i];
        sumLight += w * lightShifts[i];
    }

    if (totalWeight > 1e-4) {
        float invW = 1.0 / totalWeight;
        hsl.x = fract(hsl.x + sumHue * invW + 1.0);
        hsl.y = clamp(hsl.y + sumSat * invW, 0.0, 1.0);
        hsl.z = clamp(hsl.z + sumLight * invW, 0.0, 1.0);
        return hsl2rgb(hsl);
    }
    return rgb;
}
#endif

#if LUT_ENABLED
uniform sampler2D lutTexture;
uniform float lutIntensity;

// 16^3 3D LUT packed as a 256x16 texture: 16 B-slices laid out horizontally,
// each slice is 16x16 texels (R along X, G along Y). Bilinear within each
// slice (R,G) and linear across B-slices, matching ColorGrade.applyDC.
vec3 applyLUT(vec3 rgb) {
    float bIdx = clamp(rgb.b, 0.0, 1.0) * 15.0;
    float b0 = floor(bIdx);
    float b1 = min(b0 + 1.0, 15.0);
    float bFrac = fract(bIdx);

    float tileW = 1.0 / 16.0;        // 16 tiles across 256px
    float texelX = 1.0 / 256.0;      // x texel size
    float texelY = 1.0 / 16.0;       // y texel size

    // map r,g in [0,1] to within-tile UV spanning [half_texel, tileW - half_texel]
    // (and full height minus half texel) so bilinear never bleeds across B-slices.
    float rU = (tileW - texelX) * clamp(rgb.r, 0.0, 1.0) + texelX * 0.5;
    float gU = (1.0 - texelY) * clamp(rgb.g, 0.0, 1.0) + texelY * 0.5;

    vec3 c0 = texture2D(lutTexture, vec2(b0 * tileW + rU, gU)).rgb;
    vec3 c1 = texture2D(lutTexture, vec2(b1 * tileW + rU, gU)).rgb;
    return mix(c0, c1, bFrac);
}
#endif

void main(void) {
    // read gaussian details
    SplatSource source;
    if (!initSource(source)) {
        gl_Position = discardVec;
        return;
    }

    // get per-gaussian edit state, discard if deleted
    uint vertexState = uint(texelFetch(splatState, splat.uv, 0).r * 255.0 + 0.5) & 7u;

    #if PICK_PASS
        if (pickOp == 0u) {
            // add: skip deleted, locked and selected splats
            if (vertexState != 0u) {
                gl_Position = discardVec;
                return;
            }
        } else if (pickOp == 1u) {
            // remove: skip deleted, locked and unselected splats
            if (vertexState != 1u) {
                gl_Position = discardVec;
                return;
            }
        } else {
            // set: skip deleted and locked splats
            if ((vertexState & 6u) != 0u) {
                gl_Position = discardVec;
                return;
            }
        }
    #else
        // skip deleted splats
        if ((vertexState & 4u) != 0u) {
            gl_Position = discardVec;
            return;
        }
    #endif

    // get center
    vec3 modelCenter = getCenter();

    SplatCenter center;
    center.modelCenterOriginal = modelCenter;
    center.modelCenterModified = modelCenter;
    if (!initCenter(modelCenter, center)) {
        gl_Position = discardVec;
        return;
    }

    SplatCorner corner;
    if (!initCorner(source, center, corner)) {
        gl_Position = discardVec;
        return;
    }

    gl_Position = center.proj + vec4(corner.offset, 0.0);

    // store texture coord and locked state
    texCoord_flags = vec4(
        corner.uv,
        (vertexState & 1u) != 0u ? 1.0 : 0.0,       // selected
        (vertexState & 2u) != 0u ? 1.0 : 0.0        // locked
    );

    // Calculate depth value - repeating gradient based on depthCycleLength
    float linearDepth = -center.view.z;
    depthValue = mod(linearDepth / max(depthCycleLength, 1.0), 1.0);

    #if PICK_PASS
        if (pickMode == 1) {
            // depth estimation mode: compute normalized depth in vertex shader
            float normalizedDepth = (linearDepth - near_clip) / (far_clip - near_clip);
            vec4 clr = getColor();
            color = vec4(normalizedDepth, 0.0, 0.0, 1.0) * clr.a;
        } else {
            // pick id
            uvec4 bits = (uvec4(splat.index) >> uvec4(0u, 8u, 16u, 24u)) & uvec4(255u);
            color = vec4(bits) / 255.0;
        }
    // handle splat color
    #elif FORWARD_PASS
        // read color
        color = getColor();

        // evaluate spherical harmonics
        #if SH_BANDS > 0
        // calculate the model-space view direction
            vec3 dir = normalize(center.view * mat3(center.modelView));

            // read sh coefficients
            vec3 sh[SH_COEFFS];
            float scale;
            readSHData(sh, scale);

            // evaluate
            color.xyz += evalSH(sh, dir) * scale;
        #endif

        // apply tint/brightness
        color = color * clrScale + vec4(clrOffset, 0.0);

        // apply HSL mixer (color range adjustments)
        #if HSL_MIXER
        color.xyz = applyHslMixer(color.xyz);
        #endif

        // apply saturation
        color.xyz = applySaturation(color.xyz);

        // apply LUT color grading (16^3 3D LUT, intensity-mixed)
        #if LUT_ENABLED
        color.xyz = mix(color.xyz, applyLUT(clamp(color.xyz, 0.0, 1.0)), lutIntensity);
        #endif

        // don't allow out-of-range alpha
        color.a = clamp(color.a, 0.0, 1.0);

        // apply tonemapping
        color = vec4(prepareOutputFromGamma(max(color.xyz, 0.0), -center.view.z), color.w);

        // apply locked/selected colors
        if ((vertexState & 2u) != 0u) {
            // locked
            color *= lockedClr;
        } else if ((vertexState & 1u) != 0u) {
            // selected
            color.xyz = mix(color.xyz, selectedClr.xyz, selectedClr.a);
        }
    #endif
}
`;

const fragmentShader = /* glsl*/`
varying mediump vec4 texCoord_flags;
varying mediump vec4 color;
varying mediump float depthValue;

uniform bool outlineMode;
uniform float ringSize;
uniform int displayMode;

#if PICK_PASS
    uniform int pickMode;           // 0: id, 1: depth estimation
#endif

const float EXP4 = exp(-4.0);
const float INV_EXP4 = 1.0 / (1.0 - EXP4);

float normExp(float x) {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

void main(void) {
    mediump float A = dot(texCoord_flags.xy, texCoord_flags.xy);

    if (A > 1.0) {
        discard;
    }

    #if PICK_PASS
        if (pickMode == 1) {
            // depth estimation
            mediump float alpha = normExp(A);
            if (alpha < 1.0 / 255.0) {
                discard;
            }
            // we should multiply by alpha here to take into account gaussian falloff,
            // but it results in less accurate depth for some reason
            gl_FragColor = color * alpha;
        } else {
            // pick id
            gl_FragColor = color;
        }
    #else
        mediump float norm = normExp(A);
        mediump float alpha = norm * color.a;

        if (texCoord_flags.w == 0.0 && ringSize > 0.0) {
            // rings mode
            if (A < 1.0 - ringSize) {
                alpha = max(0.05, alpha);
            } else {
                alpha = 0.6;
            }
        }

        bool selected = texCoord_flags.z != 0.0 && texCoord_flags.w == 0.0;

        if (displayMode == 1) {
            // Depth mode - repeating gradient based on depthCycleLength
            // depthValue goes 0->1 as distance goes 0->depthCycleLength
            // Force alpha to 1.0 to avoid blending artifacts from semi-transparent Gaussians
            pcFragColor0 = vec4(vec3(depthValue), 1.0);
            pcFragColor1 = vec4(0.0, 0.0, 0.0, 0.0);
        } else {
            // Color mode (original)
            if (outlineMode) {
                pcFragColor0 = vec4(color.xyz * alpha, alpha);
                pcFragColor1 = vec4(0.0, 0.0, 0.0, selected ? norm : 0.0);
            } else {
                if (selected) {
                    pcFragColor0 = vec4(color.xyz * alpha * 0.8, alpha);
                    pcFragColor1 = vec4(color.xyz * alpha * 0.2, alpha);
                } else {
                    pcFragColor0 = vec4(color.xyz * alpha, alpha);
                    pcFragColor1 = vec4(0.0, 0.0, 0.0, 0.0);
                }
            }
        }
    #endif
}
`;

const gsplatCenter = /* glsl*/`
uniform highp usampler2D splatTransform;        // per-splat index into transform palette
uniform sampler2D transformPalette;             // palette of transform matrices

mat4 applyPaletteTransform(mat4 model) {
    uint transformIndex = texelFetch(splatTransform, splat.uv, 0).r;
    if (transformIndex == 0u) {
        return model;
    }

    // read transform matrix
    int u = int(transformIndex % 512u) * 3;
    int v = int(transformIndex / 512u);

    mat4 t;
    t[0] = texelFetch(transformPalette, ivec2(u, v), 0);
    t[1] = texelFetch(transformPalette, ivec2(u + 1, v), 0);
    t[2] = texelFetch(transformPalette, ivec2(u + 2, v), 0);
    t[3] = vec4(0.0, 0.0, 0.0, 1.0);

    return model * transpose(t);
}

uniform mat4 matrix_model;
uniform mat4 matrix_view;
#ifndef GSPLAT_CENTER_NOPROJ
    uniform vec4 camera_params;             // 1 / far, far, near, isOrtho
    uniform mat4 matrix_projection;
#endif

// project the model space gaussian center to view and clip space
bool initCenter(vec3 modelCenter, inout SplatCenter center) {
    mat4 modelView = matrix_view * applyPaletteTransform(matrix_model);
    vec4 centerView = modelView * vec4(modelCenter, 1.0);

    #ifndef GSPLAT_CENTER_NOPROJ

        // early out if splat is behind the camera (perspective only)
        // orthographic projections don't need this check as frustum culling handles it
        if (camera_params.w != 1.0 && centerView.z > 0.0) {
            return false;
        }

        vec4 centerProj = matrix_projection * centerView;

        // ensure gaussians are not clipped by camera near and far
        #if WEBGPU
            centerProj.z = clamp(centerProj.z, 0, abs(centerProj.w));
        #else
            centerProj.z = clamp(centerProj.z, -abs(centerProj.w), abs(centerProj.w));
        #endif

        center.proj = centerProj;
        center.projMat00 = matrix_projection[0][0];

    #endif

    center.view = centerView.xyz / centerView.w;
    center.modelView = modelView;
    return true;
}
`;

export { vertexShader, fragmentShader, gsplatCenter };
