import { Color, Mat4 } from 'playcanvas';

import { AnimTrack } from './anim-track';
import { Element } from './element';
import { IndexRanges, sortedPredicate } from './index-ranges';
import { Pivot } from './pivot';
import { Scene } from './scene';
import { Splat } from './splat';
import { State } from './splat-state';
import { Transform } from './transform';

interface EditOp {
    name: string;
    do(): void | Promise<void>;
    undo(): void | Promise<void>;
    destroy?(): void;
}

const enum BitOp {
    SET,
    CLEAR,
    TOGGLE
}

class StateOp {
    splat: Splat;
    ranges: IndexRanges;
    mask: number;
    op: BitOp;
    updateFlags: number;

    constructor(splat: Splat, ranges: IndexRanges, mask: number, op: BitOp, updateFlags = State.selected) {
        this.splat = splat;
        this.ranges = ranges;
        this.mask = mask;
        this.op = op;
        this.updateFlags = updateFlags;
    }

    private apply(op: BitOp) {
        const { state } = this.splat;
        const { mask, ranges } = this;

        switch (op) {
            case BitOp.SET:
                state.setBits(ranges, mask);
                break;
            case BitOp.CLEAR:
                state.clearBits(ranges, mask);
                break;
            case BitOp.TOGGLE:
                state.toggleBits(ranges, mask);
                break;
        }
    }

    async do() {
        this.apply(this.op);
        await this.splat.updateState(this.updateFlags);
    }

    async undo() {
        const undoOp = this.op === BitOp.TOGGLE ? BitOp.TOGGLE :
            this.op === BitOp.SET ? BitOp.CLEAR : BitOp.SET;
        this.apply(undoOp);
        await this.splat.updateState(this.updateFlags);
    }

    destroy() {
        this.splat = null;
        this.ranges = null;
    }
}

class SelectAllOp extends StateOp {
    name = 'selectAll';

    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => state[i] === 0), State.selected, BitOp.SET);
    }
}

class SelectNoneOp extends StateOp {
    name = 'selectNone';

    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => state[i] === State.selected), State.selected, BitOp.CLEAR);
    }
}

class SelectInvertOp extends StateOp {
    name = 'selectInvert';

    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => (state[i] & (State.locked | State.deleted)) === 0), State.selected, BitOp.TOGGLE);
    }
}

class SelectOp extends StateOp {
    name = 'selectOp';

    // `sel` is a committed snapshot of hits: either a per-splat mask
    // (Uint8Array, 255 = hit) or a sorted Uint32Array of indices. taking a
    // committed mask rather than a closure removes the foot-gun where a
    // predicate captured `state[i]` at call time and was evaluated later.
    // `op` semantics:
    //   add    — select valid splats that are hit and currently unselected
    //   remove — deselect valid splats that are hit and currently selected
    //   set    — make selection match the hit mask (toggle valid splats whose
    //            current selection state differs from the mask). NOT a replace —
    //            the underlying BitOp is TOGGLE on the rows where selection and
    //            hit disagree, which leaves locked/deleted bits untouched.
    constructor(splat: Splat, op: 'add' | 'remove' | 'set', sel: Uint8Array | Uint32Array) {
        const splatData = splat.splatData;
        const state = splatData.getProp('state') as Uint8Array;
        const bitOp = op === 'add' ? BitOp.SET : op === 'remove' ? BitOp.CLEAR : BitOp.TOGGLE;

        const isHit = sel instanceof Uint32Array ? sortedPredicate(sel) : (i: number) => sel[i] === 255;

        // single rule applied uniformly: only valid (clean or selected) splats
        // are considered. consolidates the locked/deleted guard in one place so
        // each producer doesn't have to remember it for the 'set' (toggle) path.
        const valid = (i: number) => state[i] === 0 || state[i] === State.selected;

        const preds = {
            add: (i: number) => valid(i) && isHit(i) && state[i] === 0,
            remove: (i: number) => valid(i) && isHit(i) && state[i] === State.selected,
            set: (i: number) => valid(i) && ((state[i] === State.selected) !== isHit(i))
        };

        super(splat, IndexRanges.fromPredicate(splatData.numSplats, preds[op]), State.selected, bitOp);
    }
}

class HideSelectionOp extends StateOp {
    name = 'hideSelection';

    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => state[i] === State.selected), State.locked, BitOp.SET, State.locked);
    }
}

class UnhideAllOp extends StateOp {
    name = 'unhideAll';

    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => (state[i] & (State.locked | State.deleted)) === State.locked), State.locked, BitOp.CLEAR, State.locked);
    }
}

class DeleteSelectionOp extends StateOp {
    name = 'deleteSelection';

    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => state[i] === State.selected), State.deleted, BitOp.SET, State.deleted);
    }
}

class ResetOp extends StateOp {
    name = 'reset';

    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => (state[i] & State.deleted) !== 0), State.deleted, BitOp.CLEAR, State.deleted);
    }
}

// op for modifying a splat transform
class EntityTransformOp {
    name = 'entityTransform';
    element: any;
    oldt: Transform;
    newt: Transform;

    constructor(options: { element: any, oldt: Transform, newt: Transform }) {
        this.element = options.element;
        this.oldt = options.oldt;
        this.newt = options.newt;
    }

    do() {
        this.element.move(this.newt.position, this.newt.rotation, this.newt.scale);
    }

    undo() {
        this.element.move(this.oldt.position, this.oldt.rotation, this.oldt.scale);
    }

    destroy() {
        this.element = null;
        this.oldt = null;
        this.newt = null;
    }
}

const mat = new Mat4();

// op for modifying a subset of individual splats
class SplatsTransformOp {
    name = 'splatsTransform';

    splat: Splat;
    transform: Mat4;
    paletteMap: Map<number, number>;

    constructor(options: { splat: Splat, transform: Mat4, paletteMap: Map<number, number> }) {
        this.splat = options.splat;
        this.transform = options.transform;
        this.paletteMap = options.paletteMap;
    }

    async do() {
        const { splat, transform, paletteMap } = this;
        const state = splat.splatData.getProp('state') as Uint8Array;
        const indices = splat.transformTexture.lock() as Uint16Array;

        // update splat transform palette indices
        for (let i = 0; i < state.length; ++i) {
            if (state[i] === State.selected) {
                indices[i] = paletteMap.get(indices[i]);
            }
        }

        splat.transformTexture.unlock();

        splat.transformPalette.alloc(paletteMap.size);

        // update transform palette
        const { transformPalette } = splat;
        this.paletteMap.forEach((newIdx, oldIdx) => {
            transformPalette.getTransform(oldIdx, mat);
            mat.mul2(transform, mat);
            transformPalette.setTransform(newIdx, mat);
        });

        await splat.updatePositions();
    }

    async undo() {
        const { splat, paletteMap } = this;
        const state = splat.splatData.getProp('state') as Uint8Array;
        const indices = splat.transformTexture.lock() as Uint16Array;

        // invert the palette map
        const inverseMap = new Map<number, number>();
        paletteMap.forEach((newIdx, oldIdx) => {
            inverseMap.set(newIdx, oldIdx);
        });

        // restore the original transform indices
        for (let i = 0; i < state.length; ++i) {
            if (state[i] === State.selected) {
                indices[i] = inverseMap.get(indices[i]);
            }
        }

        splat.transformTexture.unlock();

        splat.transformPalette.free(paletteMap.size);

        await splat.updatePositions();
    }

    destroy() {
        this.splat = null;
        this.transform = null;
        this.paletteMap = null;
    }
}

class PlacePivotOp {
    name = 'setPivot';
    pivot: Pivot;
    oldt: Transform;
    newt: Transform;

    constructor(options: { pivot: Pivot, oldt: Transform, newt: Transform }) {
        this.pivot = options.pivot;
        this.oldt = options.oldt;
        this.newt = options.newt;
    }

    do() {
        this.pivot.place(this.newt);
    }

    undo() {
        this.pivot.place(this.oldt);
    }
}

type ColorAdjustment = {
    tintClr?: Color
    temperature?: number,
    saturation?: number,
    brightness?: number,
    blackPoint?: number,
    whitePoint?: number,
    transparency?: number
};

class SetSplatColorAdjustmentOp {
    name: 'setSplatColor';
    splat: Splat;

    newState: ColorAdjustment;
    oldState: ColorAdjustment;

    constructor(options: { splat: Splat, oldState: ColorAdjustment, newState: ColorAdjustment }) {
        const { splat, oldState, newState } = options;
        this.splat = splat;
        this.oldState = oldState;
        this.newState = newState;
    }

    do() {
        const { splat } = this;
        const { tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency } = this.newState;
        if (tintClr) splat.tintClr = tintClr;
        if (temperature !== null) splat.temperature = temperature;
        if (saturation !== null) splat.saturation = saturation;
        if (brightness !== null) splat.brightness = brightness;
        if (blackPoint !== null) splat.blackPoint = blackPoint;
        if (whitePoint !== null) splat.whitePoint = whitePoint;
        if (transparency !== null) splat.transparency = transparency;
    }

    undo() {
        const { splat } = this;
        const { tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency } = this.oldState;
        if (tintClr) splat.tintClr = tintClr;
        if (temperature !== null) splat.temperature = temperature;
        if (saturation !== null) splat.saturation = saturation;
        if (brightness !== null) splat.brightness = brightness;
        if (blackPoint !== null) splat.blackPoint = blackPoint;
        if (whitePoint !== null) splat.whitePoint = whitePoint;
        if (transparency !== null) splat.transparency = transparency;
    }
}

// Snapshot-based undo/redo for animation track edits.
// Captures the full track state before and after a mutation.
class AnimTrackEditOp {
    name: string;
    track: AnimTrack;
    before: unknown;
    after: unknown;

    constructor(name: string, track: AnimTrack, before: unknown, after: unknown) {
        this.name = name;
        this.track = track;
        this.before = before;
        this.after = after;
    }

    do() {
        this.track.restore(this.after);
    }

    undo() {
        this.track.restore(this.before);
    }
}

class MultiOp {
    name = 'multiOp';
    ops: EditOp[];

    constructor(ops: EditOp[]) {
        this.ops = ops;
    }

    async do() {
        for (const op of this.ops) {
            await op.do();
        }
    }

    async undo() {
        for (const op of this.ops) {
            await op.undo();
        }
    }
}

class AddSplatOp {
    name: 'addSplat';
    scene: Scene;
    splat: Splat;

    constructor(scene: Scene, splat: Splat) {
        this.scene = scene;
        this.splat = splat;
    }

    async do() {
        await this.scene.add(this.splat);
    }

    undo() {
        this.scene.remove(this.splat);
    }

    destroy() {
        this.splat.destroy();
    }
}

class SplatRenameOp {
    name = 'splatRename';
    splat: Splat;
    oldName: string;
    newName: string;

    constructor(splat: Splat, newName: string) {
        this.splat = splat;
        this.oldName = splat.name;
        this.newName = newName;
    }

    do() {
        this.splat.name = this.newName;
    }

    undo() {
        this.splat.name = this.oldName;
    }
}

class AddShapeOp {
    name = 'addShape';
    scene: Scene;
    shape: Element;
    shapes: Element[];
    currentShape: Element | null;
    setCurrentShape: (shape: Element | null) => void;
    skipDo: boolean;

    constructor(options: { scene: Scene, shape: Element, shapes: Element[], currentShape: Element | null, setCurrentShape: (shape: Element | null) => void, skipDo?: boolean }) {
        this.scene = options.scene;
        this.shape = options.shape;
        this.shapes = options.shapes;
        this.currentShape = options.currentShape;
        this.setCurrentShape = options.setCurrentShape;
        this.skipDo = options.skipDo || false;
    }

    do() {
        if (!this.skipDo) {
            this.shapes.push(this.shape);
            this.scene.add(this.shape);
            this.setCurrentShape(this.shape);
        }
        this.skipDo = false;
    }

    undo() {
        const idx = this.shapes.indexOf(this.shape);
        if (idx !== -1) {
            this.shapes.splice(idx, 1);
        }
        if (this.currentShape === this.shape) {
            const newCurrent = this.shapes.length > 0 ? this.shapes[this.shapes.length - 1] : null;
            this.setCurrentShape(newCurrent);
        }
        this.scene.remove(this.shape);
    }
}

interface SerializedGroupData {
    name: string;
    indices: Uint32Array;
}

class MergeOp {
    name = 'merge';
    scene: Scene;
    sourceSplats: Splat[];
    mergedSplat: Splat | null;
    mergedFilename: string;
    mergedData: Uint8Array | null;
    sourceGroupsData: Map<Splat, SerializedGroupData[]>;
    mergedGroupsData: SerializedGroupData[];

    constructor(scene: Scene, sourceSplats: Splat[], mergedFilename: string, mergedData: Uint8Array) {
        this.scene = scene;
        this.sourceSplats = sourceSplats;
        this.mergedSplat = null;
        this.mergedFilename = mergedFilename;
        this.mergedData = mergedData;
        this.sourceGroupsData = new Map();
        this.mergedGroupsData = [];

        this.captureAndRemapGroups();
    }

    private captureAndRemapGroups() {
        let offset = 0;

        for (const splat of this.sourceSplats) {
            // Count non-deleted gaussians and build index mapping
            const state = splat.splatData.getProp('state') as Uint8Array;
            const indexMapping = new Map<number, number>();
            let nonDeletedCount = 0;

            for (let i = 0; i < state.length; i++) {
                if ((state[i] & State.deleted) === 0) {
                    indexMapping.set(i, offset + nonDeletedCount);
                    nonDeletedCount++;
                }
            }

            // Get groups for this source splat
            const groups = this.scene.events.invoke('pointCloudGroup.getGroupsForSplat', splat) as SerializedGroupData[] | undefined;

            if (groups && groups.length > 0) {
                // Store original groups for undo
                this.sourceGroupsData.set(splat, groups.map(g => ({
                    name: g.name,
                    indices: new Uint32Array(g.indices)
                })));

                // Remap group indices to merged splat indices
                for (const group of groups) {
                    const remappedIndices: number[] = [];
                    for (let j = 0; j < group.indices.length; j++) {
                        const newIndex = indexMapping.get(group.indices[j]);
                        if (newIndex !== undefined) {
                            remappedIndices.push(newIndex);
                        }
                    }

                    if (remappedIndices.length > 0) {
                        this.mergedGroupsData.push({
                            name: group.name,
                            indices: new Uint32Array(remappedIndices).sort()
                        });
                    }
                }
            }

            offset += nonDeletedCount;
        }
    }

    async do() {
        // Remove source splats from scene (but keep references)
        for (const splat of this.sourceSplats) {
            this.scene.remove(splat);
        }

        // Create and add merged splat if it doesn't exist yet
        if (!this.mergedSplat) {
            const { BlobReadSource, MappedReadFileSystem } = await import('./io/read/file-systems');
            const blob = new Blob([this.mergedData.buffer as ArrayBuffer], { type: 'application/octet-stream' });
            const fileSystem = new MappedReadFileSystem();
            fileSystem.addFile(this.mergedFilename, blob);
            this.mergedSplat = await this.scene.assetLoader.load(this.mergedFilename, fileSystem, undefined, true);
        }

        await this.scene.add(this.mergedSplat);

        // Add remapped groups to merged splat
        if (this.mergedGroupsData.length > 0 && this.mergedSplat) {
            this.scene.events.fire('pointCloudGroup.addGroupsForSplat', this.mergedSplat, this.mergedGroupsData);
        }
    }

    async undo() {
        // Remove merged splat
        if (this.mergedSplat) {
            this.scene.remove(this.mergedSplat);
        }

        // Restore source splats
        for (const splat of this.sourceSplats) {
            await this.scene.add(splat);
        }

        // Restore original groups for source splats
        for (const [splat, groupsData] of this.sourceGroupsData) {
            this.scene.events.fire('pointCloudGroup.addGroupsForSplat', splat, groupsData);
        }
    }

    destroy() {
        // Destroy merged splat when operation is destroyed
        if (this.mergedSplat) {
            this.mergedSplat.destroy();
            this.mergedSplat = null;
        }
        this.sourceSplats = null;
        this.mergedData = null;
        this.sourceGroupsData = null;
        this.mergedGroupsData = null;
    }
}

export {
    EditOp,
    SelectAllOp,
    SelectNoneOp,
    SelectInvertOp,
    SelectOp,
    HideSelectionOp,
    UnhideAllOp,
    DeleteSelectionOp,
    ResetOp,
    EntityTransformOp,
    SplatsTransformOp,
    PlacePivotOp,
    ColorAdjustment,
    SetSplatColorAdjustmentOp,
    AnimTrackEditOp,
    MultiOp,
    AddSplatOp,
    SplatRenameOp,
    AddShapeOp,
    MergeOp
};
