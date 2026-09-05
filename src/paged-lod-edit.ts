import { Mat4, Quat, Vec3 } from 'playcanvas';

import { BackendClient } from './backend';
import type { Splat } from './splat';

export type PagedLodBounds = { min: number[]; max: number[] };

export type PagedLodPageTransform = {
    translation: number[];
    rotation: number[];
    scale: number;
};

export type PagedLodPage = {
    id: string;
    lod: number;
    count: number;
    bounds: PagedLodBounds;
    ranges: Array<{ start: number; count: number }>;
    sourceFile?: string | null;
};

export type PagedLodManifest = {
    sessionId: string;
    version: number;
    sourceFingerprint: string;
    sourcePath: string;
    format: 'lcc' | 'lcc2';
    proxyLod: number;
    totalLods: number;
    totalPoints: number;
    bounds: PagedLodBounds;
    pageCount: number;
    workingSetBytes?: number;
    maxConcurrentPages?: number;
    pages: PagedLodPage[];
};

export type VoxelSelectionLike = {
    aabbMin: [number, number, number];
    aabbMax: [number, number, number];
    n: number;
    bitmap: Uint8Array;
};

export type LodDeletePatchV2 = {
    version: 2;
    sourceFingerprint: string;
    proxyLod: number;
    operations: Array<{
        id: string;
        sourceIndices: number[];
        voxel: {
            aabbMin: [number, number, number];
            aabbMax: [number, number, number];
            n: number;
            bitmap: string;
        };
    }>;
};

type DeleteOperation = {
    id: string;
    sourceIndices: Uint32Array;
    voxel: VoxelSelectionLike;
};

const pointInVoxel = (point: Vec3, voxel: VoxelSelectionLike) => {
    const sx = Math.max(voxel.aabbMax[0] - voxel.aabbMin[0], 1e-6);
    const sy = Math.max(voxel.aabbMax[1] - voxel.aabbMin[1], 1e-6);
    const sz = Math.max(voxel.aabbMax[2] - voxel.aabbMin[2], 1e-6);
    if (point.x < voxel.aabbMin[0] || point.x > voxel.aabbMax[0] ||
        point.y < voxel.aabbMin[1] || point.y > voxel.aabbMax[1] ||
        point.z < voxel.aabbMin[2] || point.z > voxel.aabbMax[2]) return false;
    const ix = Math.min(voxel.n - 1, Math.max(0, Math.floor((point.x - voxel.aabbMin[0]) / sx * voxel.n)));
    const iy = Math.min(voxel.n - 1, Math.max(0, Math.floor((point.y - voxel.aabbMin[1]) / sy * voxel.n)));
    const iz = Math.min(voxel.n - 1, Math.max(0, Math.floor((point.z - voxel.aabbMin[2]) / sz * voxel.n)));
    return voxel.bitmap[ix * voxel.n * voxel.n + iy * voxel.n + iz] !== 0;
};

const encodeBytes = (bytes: Uint8Array) => {
    let result = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        result += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(result);
};

const decodeBytes = (value: string) => {
    const binary = atob(value);
    const result = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
    return result;
};

const worldBoundsToLocal = (bounds: PagedLodBounds, worldTransform: Mat4) => {
    const inverse = new Mat4().copy(worldTransform).invert();
    const min = new Vec3(bounds.min);
    const max = new Vec3(bounds.max);
    const localMin = new Vec3(Infinity, Infinity, Infinity);
    const localMax = new Vec3(-Infinity, -Infinity, -Infinity);
    const world = new Vec3();
    for (let mask = 0; mask < 8; mask++) {
        world.set(mask & 1 ? max.x : min.x, mask & 2 ? max.y : min.y, mask & 4 ? max.z : min.z);
        inverse.transformPoint(world, world);
        localMin.min(world);
        localMax.max(world);
    }
    return { min: [localMin.x, localMin.y, localMin.z], max: [localMax.x, localMax.y, localMax.z] };
};

const intersects = (a: PagedLodBounds, b: PagedLodBounds) => {
    for (let axis = 0; axis < 3; axis++) {
        if (a.max[axis] < b.min[axis] || a.min[axis] > b.max[axis]) return false;
    }
    return true;
};

class LodDeletePatchStore {
    private operations = new Map<string, DeleteOperation>();
    private deleted = new Set<number>();

    private rebuildDeleted() {
        this.deleted.clear();
        for (const operation of this.operations.values()) {
            for (const index of operation.sourceIndices) this.deleted.add(index);
        }
    }

    add(operation: DeleteOperation) {
        this.operations.set(operation.id, operation);
        this.rebuildDeleted();
    }

    remove(id: string) {
        this.operations.delete(id);
        this.rebuildDeleted();
    }

    has(index: number) {
        return this.deleted.has(index);
    }

    get deletedCount() {
        return this.deleted.size;
    }

    serialize(sourceFingerprint: string, proxyLod: number): LodDeletePatchV2 {
        return {
            version: 2,
            sourceFingerprint,
            proxyLod,
            operations: [...this.operations.values()].map(operation => ({
                id: operation.id,
                sourceIndices: Array.from(operation.sourceIndices),
                voxel: {
                    aabbMin: operation.voxel.aabbMin,
                    aabbMax: operation.voxel.aabbMax,
                    n: operation.voxel.n,
                    bitmap: encodeBytes(operation.voxel.bitmap)
                }
            }))
        };
    }

    deserialize(patch: LodDeletePatchV2) {
        this.operations.clear();
        for (const operation of patch.operations ?? []) {
            this.operations.set(operation.id, {
                id: operation.id,
                sourceIndices: Uint32Array.from(operation.sourceIndices ?? []),
                voxel: {
                    aabbMin: operation.voxel.aabbMin,
                    aabbMax: operation.voxel.aabbMax,
                    n: operation.voxel.n,
                    bitmap: decodeBytes(operation.voxel.bitmap)
                }
            });
        }
        this.rebuildDeleted();
    }
}

class PagedLodEditSession {
    proxy: Splat;
    readonly manifest: PagedLodManifest;
    readonly patch = new LodDeletePatchStore();
    private readonly pageCache = new Map<string, Awaited<ReturnType<typeof BackendClient.loadLodEditPage>>>();
    private readonly pendingRefinements = new Map<string, Promise<void>>();
    private refinementTail: Promise<void> = Promise.resolve();
    private destroyed = false;

    constructor(proxy: Splat, manifest: PagedLodManifest) {
        this.proxy = proxy;
        this.manifest = manifest;
    }

    get sourceFingerprint() {
        return this.manifest.sourceFingerprint;
    }

    get proxyLod() {
        return this.manifest.proxyLod;
    }

    /** Move the session to a newly loaded proxy without reopening LOD0. */
    rebindProxy(proxy: Splat, proxyLod = this.manifest.proxyLod) {
        if (this.destroyed) throw new Error('LOD edit session is closed');
        this.proxy = proxy;
        this.manifest.proxyLod = proxyLod;
    }

    get deletedCount() {
        return this.patch.deletedCount;
    }

    isSourceDeleted(sourceIndex: number) {
        return this.patch.has(sourceIndex);
    }

    async loadPage(page: PagedLodPage) {
        const cached = this.pageCache.get(page.id);
        if (cached) return cached;
        const loaded = await BackendClient.loadLodEditPage(this.manifest.sessionId, page.id);
        this.pageCache.set(page.id, loaded);
        return loaded;
    }

    /** Release temporary LOD0 pages after a selection/edit transaction. */
    releasePages(pageIds?: Iterable<string>) {
        if (!pageIds) {
            this.pageCache.clear();
            return;
        }
        for (const pageId of pageIds) this.pageCache.delete(pageId);
    }

    private candidatePages(voxel: VoxelSelectionLike) {
        const local = worldBoundsToLocal({ min: voxel.aabbMin, max: voxel.aabbMax }, this.proxy.worldTransform);
        const candidates = this.manifest.pages.filter(page => intersects(page.bounds, local));
        // A manifest produced by an older source reader may not have usable
        // page bounds. Falling back to all pages preserves exactness; pages
        // are still loaded one at a time and released after refinement.
        return candidates.length > 0 ? candidates : this.manifest.pages;
    }

    /**
     * Re-evaluate the proxy's selected points against the exact LOD0 pages.
     * This is intentionally invoked by delete, not by camera updates.
     */
    async refineDeleteSelection(voxel: VoxelSelectionLike): Promise<Uint32Array> {
        if (this.destroyed) throw new Error('LOD edit session is closed');
        const candidates = this.candidatePages(voxel);
        const result: number[] = [];
        const world = new Vec3();
        for (const page of candidates) {
            try {
                const loaded = await this.loadPage(page);
                const x = loaded.gsplatData.getProp('x') as Float32Array;
                const y = loaded.gsplatData.getProp('y') as Float32Array;
                const z = loaded.gsplatData.getProp('z') as Float32Array;
                const pageTransform = loaded.transform ?
                    new Mat4().setTRS(
                        new Vec3(loaded.transform.translation),
                        new Quat(loaded.transform.rotation),
                        new Vec3(loaded.transform.scale, loaded.transform.scale, loaded.transform.scale)
                    ) :
                    this.proxy.worldTransform;
                for (let i = 0; i < loaded.sourceIndices.length; i++) {
                    const sourceIndex = loaded.sourceIndices[i];
                    world.set(x[i], y[i], z[i]);
                    pageTransform.transformPoint(world, world);
                    if (pointInVoxel(world, voxel)) result.push(sourceIndex);
                }
            } finally {
                // At most one page is retained between iterations. This is
                // deliberately transaction-scoped rather than camera-driven.
                this.releasePages([page.id]);
            }
        }
        return Uint32Array.from(result).sort();
    }

    refineSelection(voxel: VoxelSelectionLike) {
        return this.refineDeleteSelection(voxel);
    }

    /**
     * Start exact LOD0 refinement without making the caller wait. The task is
     * tracked so project save/export can still wait for an authoritative patch.
     */
    startDeleteRefinement(
        id: string,
        voxel: VoxelSelectionLike,
        onResolved: (sourceIndices: Uint32Array) => void
    ) {
        // Keep page refinement serial per session. The proxy can accept
        // multiple immediate deletes, but only one LOD0 page transaction is
        // allowed to materialize at a time to preserve the working-set cap.
        const task = this.refinementTail
        .then(() => this.refineSelection(voxel))
        .then(sourceIndices => onResolved(sourceIndices))
        .finally(() => this.pendingRefinements.delete(id));
        this.refinementTail = task.catch(() => {});
        this.pendingRefinements.set(id, task);
        return task;
    }

    async waitForPendingRefinements() {
        while (this.pendingRefinements.size > 0) {
            await Promise.all([...this.pendingRefinements.values()]);
        }
    }

    applyDelete(id: string, sourceIndices: Uint32Array, voxel: VoxelSelectionLike) {
        this.patch.add({ id, sourceIndices, voxel });
        this.proxy.markSaveDirty();
    }

    commitDelete(id: string, sourceIndices: Uint32Array, voxel: VoxelSelectionLike) {
        this.applyDelete(id, sourceIndices, voxel);
    }

    undoDelete(id: string) {
        this.patch.remove(id);
        this.proxy.markSaveDirty();
    }

    serializePatch(): LodDeletePatchV2 {
        return this.patch.serialize(this.manifest.sourceFingerprint, this.manifest.proxyLod);
    }

    deserializePatch(patch: LodDeletePatchV2) {
        if (patch.version !== 2 || patch.sourceFingerprint !== this.manifest.sourceFingerprint || patch.proxyLod !== this.manifest.proxyLod) {
            throw new Error('LOD delete patch does not match the source file or proxy LOD');
        }
        this.patch.deserialize(patch);
    }

    async close() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.pageCache.clear();
        await BackendClient.closeLodEdit(this.manifest.sessionId);
    }
}

export { LodDeletePatchStore, PagedLodEditSession, decodeBytes, encodeBytes, pointInVoxel };
