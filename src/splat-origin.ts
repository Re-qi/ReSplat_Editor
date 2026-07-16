import { IndexRanges } from './index-ranges';
import { Splat } from './splat';
import { State } from './splat-state';

/**
 * Tracks which gaussians belong to which source file.
 * Reuses the same IndexRanges data structure as the point cloud group system.
 *
 * Each splat gets exactly one origin record, created at import time,
 * covering all non-deleted gaussians in that splat.
 */
interface SplatOriginRecord {
    splat: Splat;
    filename: string;
    ranges: IndexRanges;
}

class SplatOriginTracker {
    records: SplatOriginRecord[] = [];

    /**
     * Register a splat's origin at import time.
     * Creates an IndexRanges covering all non-deleted gaussians.
     */
    register(splat: Splat, filename: string) {
        const ranges = IndexRanges.fromPredicate(
            splat.splatData.numSplats,
            i => ((splat.state.data[i] & State.deleted) === 0)
        );
        this.records.push({ splat, filename, ranges });
    }

    /**
     * Remove a splat's origin record.
     */
    remove(splat: Splat) {
        this.records = this.records.filter(r => r.splat !== splat);
    }

    /**
     * Get the sequential index of a splat (used as splatId for shader lookups).
     */
    getSplatId(splat: Splat): number {
        return this.records.findIndex(r => r.splat === splat);
    }

    /**
     * Get the filename for a splat.
     */
    getFilename(splat: Splat): string | null {
        const record = this.records.find(r => r.splat === splat);
        return record?.filename ?? null;
    }

    /**
     * Update ranges for a splat (e.g. after gaussians are deleted).
     */
    updateRanges(splat: Splat) {
        const record = this.records.find(r => r.splat === splat);
        if (record) {
            record.ranges = IndexRanges.fromPredicate(
                splat.splatData.numSplats,
                i => ((splat.state.data[i] & State.deleted) === 0)
            );
        }
    }

    /**
     * Get all registered splats.
     */
    get splats(): Splat[] {
        return this.records.map(r => r.splat);
    }

    /**
     * Clear all records.
     */
    clear() {
        this.records = [];
    }
}

export { SplatOriginTracker, SplatOriginRecord };
