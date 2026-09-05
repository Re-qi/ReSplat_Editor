import { GSplatData, Mat4, Quat, Ray, Vec3 } from 'playcanvas';

import { Camera } from './camera';
import { ImagePixels } from './image-import';
import { invalidPickId } from './paint-pick';

type SurfaceProjection = {
    camera: Camera;
    canvasWidth: number;
    canvasHeight: number;
    fullLeft: number;
    fullTop: number;
    normalizedWidth: number;
    normalizedHeight: number;
    targetWidth: number;
    targetHeight: number;
    pixelLeft: number;
    pixelTop: number;
    pixelWidth: number;
    pixelHeight: number;
    pickIds: ArrayLike<number>;
    splatCount: number;
    getWorldPosition: (splatIndex: number, result: Vec3) => boolean;
};

type ShrinkwrapStats = {
    hitGaussians: number;
    trustedGaussians: number;
    discardedGaussians: number;
    distanceLimit: number;
};

type WeightedDistance = {
    value: number;
    weight: number;
};

const EPSILON = 1e-8;
const SMOOTHING_ITERATIONS = 10;

const weightedQuantile = (samples: WeightedDistance[], quantile: number) => {
    if (samples.length === 0) return Number.NaN;
    const sorted = [...samples].sort((a, b) => a.value - b.value);
    let totalWeight = 0;
    for (const sample of sorted) totalWeight += sample.weight;
    const targetWeight = Math.min(1, Math.max(0, quantile)) * totalWeight;
    let accumulated = 0;
    for (const sample of sorted) {
        accumulated += sample.weight;
        if (accumulated >= targetWeight) return sample.value;
    }
    return sorted[sorted.length - 1].value;
};

/**
 * Estimate the far edge of the trusted surface from all hit distances. Only
 * the near half contributes to the robust spread, so a sizeable background
 * cluster cannot make its own outliers look trustworthy.
 */
const calculateTrustedDistanceLimit = (samples: WeightedDistance[]) => {
    const median = weightedQuantile(samples, 0.5);
    if (!Number.isFinite(median)) return Number.NaN;

    const lowerDeviations = samples
    .filter(sample => sample.value <= median)
    .map(sample => ({ value: median - sample.value, weight: sample.weight }));
    const lowerMad = weightedQuantile(lowerDeviations, 0.5);
    const robustSpread = Number.isFinite(lowerMad) ? lowerMad * 1.4826 : 0;

    // The relative allowance keeps a single, slightly noisy surface usable;
    // the robust allowance grows naturally for a genuinely sloped surface.
    return median + Math.max(robustSpread * 6, Math.abs(median) * 0.12, 1e-4);
};

const inpaintAndSmoothDepth = (depth: Float32Array, known: Uint8Array, width: number, height: number) => {
    const count = width * height;
    const queue = new Int32Array(count);
    const filled = new Uint8Array(known);
    let queueStart = 0;
    let queueEnd = 0;
    for (let i = 0; i < count; ++i) {
        if (known[i]) queue[queueEnd++] = i;
    }
    if (queueEnd === 0) return null;

    const visit = (nextIndex: number, sourceIndex: number) => {
        if (filled[nextIndex]) return;
        filled[nextIndex] = 1;
        depth[nextIndex] = depth[sourceIndex];
        queue[queueEnd++] = nextIndex;
    };

    // Multi-source flood fill extends the nearest trusted surface through
    // holes and rejected background regions instead of leaving disconnected
    // islands in the generated decal.
    while (queueStart < queueEnd) {
        const index = queue[queueStart++];
        const x = index % width;
        const y = Math.floor(index / width);
        if (x > 0) visit(index - 1, index);
        if (x + 1 < width) visit(index + 1, index);
        if (y > 0) visit(index - width, index);
        if (y + 1 < height) visit(index + width, index);
    }

    const original = new Float32Array(depth);
    let current: Float32Array<ArrayBufferLike> = depth;
    let next: Float32Array<ArrayBufferLike> = new Float32Array(count);
    for (let iteration = 0; iteration < SMOOTHING_ITERATIONS; ++iteration) {
        for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) {
                const index = y * width + x;
                let sum = 0;
                let neighbors = 0;
                if (x > 0) {
                    sum += current[index - 1];
                    neighbors++;
                }
                if (x + 1 < width) {
                    sum += current[index + 1];
                    neighbors++;
                }
                if (y > 0) {
                    sum += current[index - width];
                    neighbors++;
                }
                if (y + 1 < height) {
                    sum += current[index + width];
                    neighbors++;
                }
                const average = neighbors > 0 ? sum / neighbors : current[index];
                // Keep trustworthy samples anchored while still removing the
                // point-centre stair steps from the picked Gaussian surface.
                next[index] = known[index] ? original[index] * 0.8 + average * 0.2 : average;
            }
        }
        const swap = current;
        current = next;
        next = swap;
    }

    return current;
};

const shrinkwrapImageGSplatData = (
    data: GSplatData,
    image: ImagePixels,
    projection: SurfaceProjection
): ShrinkwrapStats | null => {
    const { width, height, data: pixels } = image;
    const gridCount = width * height;
    if (pixels.length !== gridCount * 4 || projection.pickIds.length < projection.pixelWidth * projection.pixelHeight) {
        throw new Error('Shrinkwrap image or pick data has invalid dimensions.');
    }

    const cameraPosition = projection.camera.position;
    const cameraForward = projection.camera.forward;
    const worldPosition = new Vec3();
    const byId = new Map<number, { distance: number, depth: number, count: number }>();
    const hitIdByPixel = new Uint32Array(gridCount);
    hitIdByPixel.fill(invalidPickId);

    for (let row = 0; row < height; ++row) {
        for (let column = 0; column < width; ++column) {
            const index = row * width + column;
            if (pixels[index * 4 + 3] === 0) continue;

            const normalizedX = projection.fullLeft + (column + 0.5) / width * projection.normalizedWidth;
            const normalizedY = projection.fullTop + (row + 0.5) / height * projection.normalizedHeight;
            const screenX = Math.floor(normalizedX * projection.targetWidth);
            const screenY = Math.floor(normalizedY * projection.targetHeight);
            const localX = screenX - projection.pixelLeft;
            const localY = screenY - projection.pixelTop;
            if (localX < 0 || localY < 0 || localX >= projection.pixelWidth || localY >= projection.pixelHeight) continue;

            // Picker texture rows are returned bottom-up. Convert the top-down
            // image row into the same buffer index used by decal painting.
            const bufferY = projection.pixelHeight - 1 - localY;
            const id = projection.pickIds[bufferY * projection.pixelWidth + localX];
            if (id === undefined || id === invalidPickId || id >= projection.splatCount) continue;
            hitIdByPixel[index] = id;

            let sample = byId.get(id);
            if (!sample) {
                if (!projection.getWorldPosition(id, worldPosition)) continue;
                const offsetX = worldPosition.x - cameraPosition.x;
                const offsetY = worldPosition.y - cameraPosition.y;
                const offsetZ = worldPosition.z - cameraPosition.z;
                const distance = Math.hypot(offsetX, offsetY, offsetZ);
                const forwardDepth = offsetX * cameraForward.x + offsetY * cameraForward.y + offsetZ * cameraForward.z;
                if (!Number.isFinite(distance) || !Number.isFinite(forwardDepth) || forwardDepth <= projection.camera.near) continue;
                sample = { distance, depth: forwardDepth, count: 0 };
                byId.set(id, sample);
            }
            sample.count++;
        }
    }

    if (byId.size === 0) return null;
    const distanceSamples = Array.from(byId.values()).map(sample => ({
        value: sample.distance,
        weight: sample.count
    }));
    const distanceLimit = calculateTrustedDistanceLimit(distanceSamples);
    const trustedIds = new Set<number>();
    for (const [id, sample] of byId) {
        if (sample.distance <= distanceLimit) trustedIds.add(id);
    }
    if (trustedIds.size === 0) return null;

    const depth = new Float32Array(gridCount);
    const known = new Uint8Array(gridCount);
    for (let index = 0; index < gridCount; ++index) {
        const id = hitIdByPixel[index];
        if (!trustedIds.has(id)) continue;
        depth[index] = byId.get(id)!.depth;
        known[index] = 1;
    }
    const smoothDepth = inpaintAndSmoothDepth(depth, known, width, height);
    if (!smoothDepth) return null;

    const positions = new Float32Array(gridCount * 3);
    const ray = new Ray();
    const rayOffset = new Vec3();
    const surfaceOffset = Math.max(weightedQuantile(
        Array.from(trustedIds, id => ({ value: byId.get(id)!.depth, weight: byId.get(id)!.count })),
        0.5
    ) * 0.0005, 1e-6);
    for (let row = 0; row < height; ++row) {
        for (let column = 0; column < width; ++column) {
            const index = row * width + column;
            const normalizedX = projection.fullLeft + (column + 0.5) / width * projection.normalizedWidth;
            const normalizedY = projection.fullTop + (row + 0.5) / height * projection.normalizedHeight;
            projection.camera.getRay(
                normalizedX * projection.canvasWidth,
                normalizedY * projection.canvasHeight,
                ray
            );
            const originDepth = rayOffset.sub2(ray.origin, cameraPosition).dot(cameraForward);
            const denominator = ray.direction.dot(cameraForward);
            const distanceAlongRay = (smoothDepth[index] - surfaceOffset - originDepth) / denominator;
            const positionOffset = index * 3;
            positions[positionOffset] = ray.origin.x + ray.direction.x * distanceAlongRay;
            positions[positionOffset + 1] = ray.origin.y + ray.direction.y * distanceAlongRay;
            positions[positionOffset + 2] = ray.origin.z + ray.direction.z * distanceAlongRay;
        }
    }

    const x = data.getProp('x') as Float32Array;
    const y = data.getProp('y') as Float32Array;
    const z = data.getProp('z') as Float32Array;
    const scale0 = data.getProp('scale_0') as Float32Array;
    const scale1 = data.getProp('scale_1') as Float32Array;
    const scale2 = data.getProp('scale_2') as Float32Array;
    const rot0 = data.getProp('rot_0') as Float32Array;
    const rot1 = data.getProp('rot_1') as Float32Array;
    const rot2 = data.getProp('rot_2') as Float32Array;
    const rot3 = data.getProp('rot_3') as Float32Array;

    const right = new Vec3();
    const up = new Vec3();
    const normal = new Vec3();
    const towardCamera = new Vec3();
    const orthogonalComponent = new Vec3();
    const matrix = new Mat4();
    const rotation = new Quat();
    let outputIndex = 0;
    const readPosition = (index: number, result: Vec3) => result.set(
        positions[index * 3],
        positions[index * 3 + 1],
        positions[index * 3 + 2]
    );
    const leftPosition = new Vec3();
    const rightPosition = new Vec3();
    const topPosition = new Vec3();
    const bottomPosition = new Vec3();
    const cameraRight = projection.camera.mainCamera.right;
    const cameraUp = projection.camera.mainCamera.up;
    const fallbackSpacing = Math.max(surfaceOffset * 2, 1e-5);

    for (let row = 0; row < height; ++row) {
        for (let column = 0; column < width; ++column) {
            const gridIndex = row * width + column;
            if (pixels[gridIndex * 4 + 3] === 0) continue;
            const leftColumn = Math.max(0, column - 1);
            const rightColumn = Math.min(width - 1, column + 1);
            const topRow = Math.max(0, row - 1);
            const bottomRow = Math.min(height - 1, row + 1);
            readPosition(row * width + leftColumn, leftPosition);
            readPosition(row * width + rightColumn, rightPosition);
            readPosition(topRow * width + column, topPosition);
            readPosition(bottomRow * width + column, bottomPosition);

            const horizontalSpan = Math.max(1, rightColumn - leftColumn);
            const verticalSpan = Math.max(1, bottomRow - topRow);
            const horizontalSpacing = Math.max(rightPosition.distance(leftPosition) / horizontalSpan, fallbackSpacing);
            const verticalSpacing = Math.max(bottomPosition.distance(topPosition) / verticalSpan, fallbackSpacing);

            right.sub2(rightPosition, leftPosition);
            if (right.lengthSq() <= EPSILON) right.copy(cameraRight);
            right.normalize();
            // Image rows point down, so local +Y follows the world direction
            // from the lower sample toward the upper sample.
            up.sub2(topPosition, bottomPosition);
            up.sub(orthogonalComponent.copy(right).mulScalar(up.dot(right))).normalize();
            if (up.lengthSq() <= EPSILON) {
                up.copy(cameraUp);
                up.sub(orthogonalComponent.copy(right).mulScalar(up.dot(right))).normalize();
            }
            normal.cross(right, up).normalize();
            readPosition(gridIndex, worldPosition);
            towardCamera.sub2(cameraPosition, worldPosition);
            if (normal.dot(towardCamera) < 0) {
                up.mulScalar(-1);
                normal.mulScalar(-1);
            }

            matrix.set([
                right.x, right.y, right.z, 0,
                up.x, up.y, up.z, 0,
                normal.x, normal.y, normal.z, 0,
                0, 0, 0, 1
            ]);
            rotation.setFromMat4(matrix).normalize();

            x[outputIndex] = worldPosition.x;
            y[outputIndex] = worldPosition.y;
            z[outputIndex] = worldPosition.z;
            scale0[outputIndex] = Math.log(horizontalSpacing * 0.55);
            scale1[outputIndex] = Math.log(verticalSpacing * 0.55);
            scale2[outputIndex] = Math.log(Math.min(horizontalSpacing, verticalSpacing) * 0.05);
            rot0[outputIndex] = rotation.w;
            rot1[outputIndex] = rotation.x;
            rot2[outputIndex] = rotation.y;
            rot3[outputIndex] = rotation.z;
            outputIndex++;
        }
    }

    if (outputIndex !== data.numSplats) {
        throw new Error('Shrinkwrap Gaussian count does not match the visible image pixels.');
    }

    return {
        hitGaussians: byId.size,
        trustedGaussians: trustedIds.size,
        discardedGaussians: byId.size - trustedIds.size,
        distanceLimit
    };
};

export { calculateTrustedDistanceLimit, inpaintAndSmoothDepth, shrinkwrapImageGSplatData };
export type { ShrinkwrapStats, SurfaceProjection, WeightedDistance };
