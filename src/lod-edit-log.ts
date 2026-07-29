import { Mat4, Vec3 } from 'playcanvas';

import {
    applyTransformToSelected,
    DeleteSelectionOp,
    SelectAllOp,
    SelectInvertOp,
    SelectNoneOp,
    SelectOp
} from './edit-ops';
import { sortedPredicate } from './index-ranges';
import type { Splat } from './splat';
import { State } from './splat-state';

// Target voxel edge length in world units. 4cm balances precision against
// cross-LOD coverage: too small and sparse-LOD points leave gaps that cause
// dense LODs to miss points during replay; too large and selections bleed
// past their intended boundary. Combined with adaptive dilation below, 4cm
// closes inter-point gaps in typical sparse LODs.
const TARGET_VOXEL_SIZE = 0.04;
const MIN_N = 32;
const MAX_N = 128;

// Bounds for adaptive dilation iterations. The actual iteration count is
// computed per-selection from source-LOD point density: sparse LODs get more
// iterations (larger radius) so adjacent points' dilation kernels touch and
// no gaps remain for denser target LODs to miss. Hard caps prevent extreme
// over-deletion on degenerate selections.
const MIN_DILATION_ITERATIONS = 1;
const MAX_DILATION_ITERATIONS = 10;

// World-space voxel bitmap describing a selection region.
// Addressing: bitmap[ix * n * n + iy * n + iz], ix/iy/iz ∈ [0, n).
interface VoxelSelection {
    aabbMin: [number, number, number];
    aabbMax: [number, number, number];
    n: number;
    bitmap: Uint8Array;
}

// Operations that can be replayed across LODs. Each carries world-space data
// only — no splat indices — so the same op applies to any LOD.
type LodEditOp =
    | { type: 'select'; op: 'add' | 'remove' | 'set'; voxel: VoxelSelection }
    | { type: 'delete'; voxel: VoxelSelection }
    | { type: 'selectAll' }
    | { type: 'selectNone' }
    | { type: 'selectInvert' }
    | { type: 'transform'; voxel: VoxelSelection; transform: number[] };

// Uint8Array → base64. TextDecoder('iso-8859-1') maps each byte 1:1 to a
// character (equivalent to String.fromCharCode) without call-stack concerns
// on large arrays. The entire binary string is encoded in a single btoa()
// call — independent chunk encoding produces concatenated base64 strings with
// internal padding that atob() cannot decode.
const uint8ToBase64 = (data: Uint8Array): string => {
    const binary = new TextDecoder('iso-8859-1').decode(data);
    return btoa(binary);
};

const base64ToUint8 = (str: string): Uint8Array => {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
};

// Pick an adaptive resolution N so voxel edge ≈ TARGET_VOXEL_SIZE, clamped to
// [MIN_N, MAX_N]. Using the largest AABB axis keeps voxels roughly cubic.
const computeAdaptiveN = (aabbSize: number): number => {
    const n = Math.ceil(aabbSize / TARGET_VOXEL_SIZE);
    return Math.max(MIN_N, Math.min(MAX_N, n));
};

// Dilate the voxel bitmap in-place using a 26-neighborhood morphological
// dilation. Each iteration expands every marked voxel by 1 voxel in all
// 26 directions (including diagonals), filling gaps between sparse source-LOD
// points so that denser target LODs don't miss points falling between them.
// The AABB is NOT expanded — dilation only fills interior gaps, so selection
// boundaries are preserved within ~1 voxel.
const dilateVoxel = (voxel: VoxelSelection, iterations: number): void => {
    if (iterations <= 0) return;
    const { n } = voxel;
    let current = voxel.bitmap;

    for (let iter = 0; iter < iterations; iter++) {
        const next = new Uint8Array(current.length);
        for (let ix = 0; ix < n; ix++) {
            const x0 = Math.max(0, ix - 1);
            const x1 = Math.min(n - 1, ix + 1);
            for (let iy = 0; iy < n; iy++) {
                const y0 = Math.max(0, iy - 1);
                const y1 = Math.min(n - 1, iy + 1);
                for (let iz = 0; iz < n; iz++) {
                    if (!current[ix * n * n + iy * n + iz]) continue;
                    const z0 = Math.max(0, iz - 1);
                    const z1 = Math.min(n - 1, iz + 1);
                    // Stamp the 3x3x3 kernel (clamped to grid bounds)
                    for (let dx = x0; dx <= x1; dx++) {
                        for (let dy = y0; dy <= y1; dy++) {
                            for (let dz = z0; dz <= z1; dz++) {
                                next[dx * n * n + dy * n + dz] = 1;
                            }
                        }
                    }
                }
            }
        }
        current = next;
    }
    voxel.bitmap = current;
};

class LodEditLog {
    private entries: LodEditOp[] = [];
    private cursor = 0;

    // === Recording API (called from editor.ts / edit-history.ts) ===

    // Mirror EditHistory.add: truncate redo stack, append, advance cursor.
    onEditHistoryAdd(): void {
        this.entries.length = this.cursor;
    }

    onEditHistoryUndo(): void {
        if (this.cursor > 0) this.cursor--;
    }

    onEditHistoryRedo(): void {
        if (this.cursor < this.entries.length) this.cursor++;
    }

    // Called when editHistory is cleared for a splat (e.g. LOD switch).
    // Entries are kept so replay() can still reapply them.
    onEditHistoryClear(): void {
        this.cursor = this.entries.length;
    }

    // Record a select operation. sel is the mask/indices that SelectOp will
    // consume — must be captured BEFORE constructing SelectOp.
    recordSelect(splat: Splat, op: 'add' | 'remove' | 'set', sel: Uint8Array | Uint32Array): void {
        const voxel = this.maskToVoxel(splat, sel);
        if (!voxel) return;
        this.entries.length = this.cursor;
        this.entries.push({ type: 'select', op, voxel });
        this.cursor = this.entries.length;
    }

    // Record a delete of the currently-selected splats.
    recordDelete(splat: Splat): void {
        const voxel = this.captureSelectedAsVoxel(splat);
        if (!voxel) return;
        this.entries.length = this.cursor;
        this.entries.push({ type: 'delete', voxel });
        this.cursor = this.entries.length;
    }

    recordSelectAll(splat: Splat): void {
        this.entries.length = this.cursor;
        this.entries.push({ type: 'selectAll' });
        this.cursor = this.entries.length;
    }

    recordSelectNone(splat: Splat): void {
        this.entries.length = this.cursor;
        this.entries.push({ type: 'selectNone' });
        this.cursor = this.entries.length;
    }

    recordSelectInvert(splat: Splat): void {
        this.entries.length = this.cursor;
        this.entries.push({ type: 'selectInvert' });
        this.cursor = this.entries.length;
    }

    // Record a transform applied to currently-selected splats.
    // transform is the world-space Mat4 (column-major data array).
    recordTransform(splat: Splat, transform: number[]): void {
        const voxel = this.captureSelectedAsVoxel(splat);
        if (!voxel) return;
        this.entries.length = this.cursor;
        this.entries.push({ type: 'transform', voxel, transform });
        this.cursor = this.entries.length;
    }

    // === Replay ===

    // Reapply all ops [0..cursor) to the given splat. Calls EditOp.do()
    // directly — must NOT fire 'edit.add' (would cause EditHistory recursion).
    async replay(splat: Splat): Promise<void> {
        for (let i = 0; i < this.cursor; i++) {
            const op = this.entries[i];
            switch (op.type) {
                case 'select': {
                    const mask = this.voxelToMask(splat, op.voxel);
                    const selectOp = new SelectOp(splat, op.op, mask);
                    await selectOp.do();
                    break;
                }
                case 'delete': {
                    // 1. restore selected state from voxel
                    const mask = this.voxelToMask(splat, op.voxel);
                    const state = splat.splatData.getProp('state') as Uint8Array;
                    for (let j = 0; j < state.length; j++) {
                        if (mask[j] === 255) {
                            state[j] = (state[j] & ~State.deleted) | State.selected;
                        }
                    }
                    // 2. delete the selection
                    const deleteOp = new DeleteSelectionOp(splat);
                    await deleteOp.do();
                    break;
                }
                case 'selectAll': {
                    await new SelectAllOp(splat).do();
                    break;
                }
                case 'selectNone': {
                    await new SelectNoneOp(splat).do();
                    break;
                }
                case 'selectInvert': {
                    await new SelectInvertOp(splat).do();
                    break;
                }
                case 'transform': {
                    // 1. Restore selection from voxel (same pattern as 'delete'
                    //    case — adds selection without clearing, since prior ops
                    //    in the replay sequence have already established the
                    //    correct selection state).
                    const mask = this.voxelToMask(splat, op.voxel);
                    const state = splat.splatData.getProp('state') as Uint8Array;
                    for (let j = 0; j < state.length; j++) {
                        if (mask[j] === 255) {
                            state[j] = (state[j] & ~State.deleted) | State.selected;
                        }
                    }

                    // 2. Recover local-space transform from the recorded
                    //    world-space matrix. worldMat was recorded as
                    //    `localToWorld * localTransform` (see
                    //    splats-transform-handler.end()); recover localTransform
                    //    via `inv(splat.worldTransform) * worldMat`. Valid as
                    //    long as the splat's entity transform is unchanged
                    //    between recording and replay — the common case for LOD
                    //    switches, since swapGSplatData only swaps splat data.
                    const worldMat = new Mat4().set(op.transform);
                    const localMat = new Mat4();
                    localMat.invert(splat.worldTransform);
                    localMat.mul2(localMat, worldMat);

                    // 3. Apply the transform to the selected splats (allocates
                    //    new transform-palette entries on the splat).
                    await applyTransformToSelected(splat, localMat);
                    break;
                }
            }
        }
    }

    // === Export-time application ===

    // Mark deleted rows in a state array based on recorded delete operations.
    // Used during LCC2 export to filter deleted gaussians from LODs loaded
    // directly from the source file (bypassing the EditHistory/Splat pipeline).
    // Positions (xs, ys, zs) are in the splat's native data space; worldTransform
    // maps them to the world space where the voxel bitmaps were captured.
    applyDeletionsToState(
        state: Uint8Array,
        xs: Float32Array, ys: Float32Array, zs: Float32Array,
        worldTransform: { transformPoint: (src: Vec3, dst: Vec3) => Vec3 }
    ): void {
        const N = state.length;
        if (N === 0) return;
        const tmp = new Vec3();

        for (let e = 0; e < this.cursor; e++) {
            const op = this.entries[e];
            if (op.type !== 'delete') continue;
            const { aabbMin, aabbMax, n, bitmap } = op.voxel;
            const sizeX = Math.max(aabbMax[0] - aabbMin[0], 1e-6);
            const sizeY = Math.max(aabbMax[1] - aabbMin[1], 1e-6);
            const sizeZ = Math.max(aabbMax[2] - aabbMin[2], 1e-6);

            for (let i = 0; i < N; i++) {
                if ((state[i] & State.deleted) !== 0) continue;
                tmp.set(xs[i], ys[i], zs[i]);
                worldTransform.transformPoint(tmp, tmp);
                if (tmp.x < aabbMin[0] || tmp.x > aabbMax[0] ||
                    tmp.y < aabbMin[1] || tmp.y > aabbMax[1] ||
                    tmp.z < aabbMin[2] || tmp.z > aabbMax[2]) continue;
                const ix = Math.min(n - 1, Math.floor((tmp.x - aabbMin[0]) / sizeX * n));
                const iy = Math.min(n - 1, Math.floor((tmp.y - aabbMin[1]) / sizeY * n));
                const iz = Math.min(n - 1, Math.floor((tmp.z - aabbMin[2]) / sizeZ * n));
                if (bitmap[ix * n * n + iy * n + iz]) {
                    state[i] |= State.deleted;
                }
            }
        }
    }

    // === Serialization ===

    serialize(): { version: string; cursor: number; entries: any[] } {
        return {
            version: '1.0.0',
            cursor: this.cursor,
            entries: this.entries.map((op) => {
                if ('voxel' in op) {
                    const { aabbMin, aabbMax, n, bitmap } = op.voxel;
                    return { ...op, voxel: { aabbMin, aabbMax, n, bitmap: uint8ToBase64(bitmap) } };
                }
                return op;
            })
        };
    }

    deserialize(data: any): void {
        this.entries = (data.entries ?? []).map((op: any) => {
            if (op.voxel) {
                return {
                    ...op,
                    voxel: {
                        aabbMin: op.voxel.aabbMin,
                        aabbMax: op.voxel.aabbMax,
                        n: op.voxel.n,
                        bitmap: base64ToUint8(op.voxel.bitmap)
                    }
                };
            }
            return op;
        });
        this.cursor = Math.min(data.cursor ?? this.entries.length, this.entries.length);
    }

    // === Voxel conversion ===

    // Build a voxel bitmap from a splat selection (mask or indices).
    // Returns null for empty selections (no entry recorded).
    private maskToVoxel(splat: Splat, sel: Uint8Array | Uint32Array): VoxelSelection | null {
        const { splatData, worldTransform } = splat;
        const x = splatData.getProp('x') as Float32Array;
        const y = splatData.getProp('y') as Float32Array;
        const z = splatData.getProp('z') as Float32Array;
        if (!x || !y || !z) return null;

        const N = splatData.numSplats;
        const isHit = sel instanceof Uint32Array ?
            sortedPredicate(sel) :
            (i: number) => sel[i] === 255;

        // Pass 1: compute world-space AABB of hit splats
        const tmp = new Vec3();
        let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
        let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
        let hitCount = 0;
        for (let i = 0; i < N; i++) {
            if (!isHit(i)) continue;
            tmp.set(x[i], y[i], z[i]);
            worldTransform.transformPoint(tmp, tmp);
            if (tmp.x < mnX) mnX = tmp.x;
            if (tmp.y < mnY) mnY = tmp.y;
            if (tmp.z < mnZ) mnZ = tmp.z;
            if (tmp.x > mxX) mxX = tmp.x;
            if (tmp.y > mxY) mxY = tmp.y;
            if (tmp.z > mxZ) mxZ = tmp.z;
            hitCount++;
        }

        if (hitCount === 0) return null;

        // Degenerate AABB: nudge to avoid divide-by-zero
        const sizeX = Math.max(mxX - mnX, 1e-6);
        const sizeY = Math.max(mxY - mnY, 1e-6);
        const sizeZ = Math.max(mxZ - mnZ, 1e-6);
        const maxSize = Math.max(sizeX, sizeY, sizeZ);
        const n = computeAdaptiveN(maxSize);
        const bitmap = new Uint8Array(n * n * n);

        // Pass 2: fill voxel bitmap
        for (let i = 0; i < N; i++) {
            if (!isHit(i)) continue;
            tmp.set(x[i], y[i], z[i]);
            worldTransform.transformPoint(tmp, tmp);
            const ix = Math.min(n - 1, Math.floor((tmp.x - mnX) / sizeX * n));
            const iy = Math.min(n - 1, Math.floor((tmp.y - mnY) / sizeY * n));
            const iz = Math.min(n - 1, Math.floor((tmp.z - mnZ) / sizeZ * n));
            bitmap[ix * n * n + iy * n + iz] = 1;
        }

        const voxel: VoxelSelection = {
            aabbMin: [mnX, mnY, mnZ],
            aabbMax: [mxX, mxY, mxZ],
            n,
            bitmap
        };

        // Adaptive dilation: estimate the average inter-point spacing in the
        // source LOD's selection, then dilate by half that spacing so adjacent
        // points' kernels touch and no interior gaps remain. Without this,
        // sparse source LODs (e.g. low-detail levels) leave empty voxels that
        // denser target LODs' points fall into, causing those points to be
        // missed during replay — visible as leftover points in the deleted
        // region after LOD switch.
        //
        // Spacing estimate: (AABB volume / point count)^(1/3), which gives the
        // edge length of a cube that each point "occupies" on average. Dilating
        // by half that edge makes neighboring points' dilation kernels meet.
        const aabbVol = sizeX * sizeY * sizeZ;
        const estSpacing = Math.pow(aabbVol / Math.max(hitCount, 1), 1 / 3);
        const voxelEdge = maxSize / n;
        const adaptiveIters = Math.max(
            MIN_DILATION_ITERATIONS,
            Math.min(MAX_DILATION_ITERATIONS, Math.ceil(estSpacing / 2 / voxelEdge))
        );
        dilateVoxel(voxel, adaptiveIters);

        return voxel;
    }

    // Build a mask (Uint8Array, 255 = hit) for a splat from a voxel bitmap.
    private voxelToMask(splat: Splat, voxel: VoxelSelection): Uint8Array {
        const { splatData, worldTransform } = splat;
        const x = splatData.getProp('x') as Float32Array;
        const y = splatData.getProp('y') as Float32Array;
        const z = splatData.getProp('z') as Float32Array;
        const N = splatData.numSplats;
        const mask = new Uint8Array(N);

        if (!x || !y || !z) return mask;

        const { aabbMin, aabbMax, n, bitmap } = voxel;
        const sizeX = Math.max(aabbMax[0] - aabbMin[0], 1e-6);
        const sizeY = Math.max(aabbMax[1] - aabbMin[1], 1e-6);
        const sizeZ = Math.max(aabbMax[2] - aabbMin[2], 1e-6);

        const tmp = new Vec3();
        for (let i = 0; i < N; i++) {
            tmp.set(x[i], y[i], z[i]);
            worldTransform.transformPoint(tmp, tmp);
            // Early-out: outside AABB
            if (tmp.x < aabbMin[0] || tmp.x > aabbMax[0] ||
                tmp.y < aabbMin[1] || tmp.y > aabbMax[1] ||
                tmp.z < aabbMin[2] || tmp.z > aabbMax[2]) {
                continue;
            }
            const ix = Math.min(n - 1, Math.floor((tmp.x - aabbMin[0]) / sizeX * n));
            const iy = Math.min(n - 1, Math.floor((tmp.y - aabbMin[1]) / sizeY * n));
            const iz = Math.min(n - 1, Math.floor((tmp.z - aabbMin[2]) / sizeZ * n));
            if (bitmap[ix * n * n + iy * n + iz]) {
                mask[i] = 255;
            }
        }
        return mask;
    }

    // Capture the currently-selected splats as a voxel bitmap.
    private captureSelectedAsVoxel(splat: Splat): VoxelSelection | null {
        const state = splat.splatData.getProp('state') as Uint8Array;
        if (!state) return null;
        // Build a mask from current state.selected, then voxelize it.
        const mask = new Uint8Array(state.length);
        let count = 0;
        for (let i = 0; i < state.length; i++) {
            if (state[i] === State.selected) {
                mask[i] = 255;
                count++;
            }
        }
        if (count === 0) return null;
        return this.maskToVoxel(splat, mask);
    }

    // === Misc ===

    get length(): number {
        return this.cursor;
    }

    clear(): void {
        this.entries = [];
        this.cursor = 0;
    }
}

export { LodEditLog, VoxelSelection, LodEditOp };
