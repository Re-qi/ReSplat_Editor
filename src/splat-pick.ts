import { Mat4, Ray, Vec3, Vec4 } from 'playcanvas';

import { sigmoid } from './color-grade';
import { Scene } from './scene';
import { Splat } from './splat';
import { State } from './splat-state';

// clicked points gather the gaussians whose centers project within this many
// pixels of the cursor (falling back to the larger radius on sparse surfaces)
const PICK_RADIUS = 8;
const PICK_RADIUS_FAR = 24;

const mat = new Mat4();
const ray = new Ray();
const vec4 = new Vec4();
const v = new Vec3();

// Pick the visible surface point of a splat under a screen position, writing
// the splat-local result. offsetX and offsetY are in canvasContainer CSS pixel
// coordinates (e.g. from PointerEvent.offsetX/offsetY).
const pickSplatSurfacePoint = (scene: Scene, splat: Splat, offsetX: number, offsetY: number, result: Vec3) => {
    const { splatData } = splat;
    const state = splatData.getProp('state') as Uint8Array;
    const opacity = splatData.getProp('opacity') as Float32Array;
    const { centers } = splat.entity.gsplat.instance.sorter;
    const { numSplats } = splatData;

    // Use getBoundingClientRect (visible size) to match PlayCanvas's
    // CameraComponent.screenToWorld, which uses device.clientRect (= canvas
    // .getBoundingClientRect()). zoom-manager applies style.zoom to <canvas>,
    // making clientWidth differ from the visible size; using clientWidth here
    // would project gaussians into a different coord space than the ray and
    // pick the wrong gaussians.
    const rect = scene.canvas.getBoundingClientRect();
    const cw = rect.width;
    const ch = rect.height;

    mat.mul2(scene.camera.camera.projectionMatrix, scene.camera.camera.viewMatrix);
    mat.mul(splat.worldTransform);
    scene.camera.getRay(offsetX, offsetY, ray);

    const near: { t: number, w: number }[] = [];
    const far: { t: number, w: number }[] = [];

    for (let i = 0; i < numSplats; i++) {
        if (state[i] & State.deleted) {
            continue;
        }

        const x = centers[i * 3 + 0];
        const y = centers[i * 3 + 1];
        const z = centers[i * 3 + 2];

        vec4.set(x, y, z, 1);
        mat.transformVec4(vec4, vec4);
        if (vec4.w <= 0) {
            continue;
        }

        const dx = Math.abs((vec4.x / vec4.w * 0.5 + 0.5) * cw - offsetX);
        const dy = Math.abs((-vec4.y / vec4.w * 0.5 + 0.5) * ch - offsetY);
        if (dx >= PICK_RADIUS_FAR || dy >= PICK_RADIUS_FAR) {
            continue;
        }

        v.set(x, y, z);
        splat.worldTransform.transformPoint(v, v);
        const dist = v.sub(ray.origin).dot(ray.direction);
        if (!(dist > 0)) {
            continue;
        }

        const entry = { t: dist, w: opacity ? sigmoid(opacity[i]) : 1 };
        far.push(entry);
        if (dx < PICK_RADIUS && dy < PICK_RADIUS) {
            near.push(entry);
        }
    }

    const candidates = near.length > 0 ? near : far;
    if (candidates.length === 0) {
        return false;
    }

    candidates.sort((a, b) => a.t - b.t);
    let transmittance = 1;
    let total = 0;
    for (const cand of candidates) {
        const alpha = cand.w;
        cand.w = alpha * transmittance;
        total += cand.w;
        transmittance *= 1 - Math.min(0.99, alpha);
        if (transmittance < 0.05) {
            break;
        }
    }

    let accum = 0;
    let median = candidates[candidates.length - 1].t;
    for (const cand of candidates) {
        accum += cand.w;
        if (accum >= total * 0.5) {
            median = cand.t;
            break;
        }
    }

    v.copy(ray.direction).mulScalar(median).add(ray.origin);
    mat.invert(splat.worldTransform);
    mat.transformPoint(v, result);

    return true;
};

export { pickSplatSurfacePoint };
