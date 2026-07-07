import { Color, Mat4, Quat, Vec3 } from 'playcanvas';

import { AnimTrack } from './anim-track';
import { Element } from './element';
import { Events } from './events';
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
    serialize(): { type: string; data: any };
}

enum BitOp {
    SET,
    CLEAR,
    TOGGLE
}

class StateOp {
    name = 'stateOp';
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

    serialize() {
        return {
            type: this.name,
            data: {
                splatIndex: this.splat.scene.getSplatIndex(this.splat),
                ranges: this.ranges.serialize(),
                mask: this.mask,
                op: ['SET', 'CLEAR', 'TOGGLE'][this.op],
                updateFlags: this.updateFlags
            }
        };
    }

    static deserialize(data: any, scene: Scene): StateOp {
        const splat = scene.getSplatByIndex(data.splatIndex);
        const ranges = IndexRanges.deserialize(data.ranges);
        const op = ['SET', 'CLEAR', 'TOGGLE'].indexOf(data.op);
        return new StateOp(splat, ranges, data.mask, op, data.updateFlags);
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

/**
 *  Unlike SelectOp 'set' (TOGGLE-based, no-op when state matches), this op
 *  truly replaces the selection: clears all selected bits then sets only the
 *  target indices. All state queries happen at execution time, so it works
 *  correctly inside MultiOp or when gaussians already match the target.
 */
class ReplaceSelectionOp {
    name = 'replaceSelection';
    splat: Splat;
    prevRanges: IndexRanges;
    targetIndices: Uint32Array;

    constructor(splat: Splat, targetIndices: Uint32Array) {
        this.splat = splat;
        this.targetIndices = targetIndices;
        // Snapshot currently selected gaussians for undo
        const state = splat.splatData.getProp('state') as Uint8Array;
        this.prevRanges = IndexRanges.fromPredicate(
            splat.splatData.numSplats,
            (i: number) => (state[i] & State.selected) !== 0
        );
    }

    async do() {
        const { splat, targetIndices } = this;
        const numSplats = splat.splatData.numSplats;
        const state = splat.splatData.getProp('state') as Uint8Array;

        // Compute ranges at execution time — not construction — so this
        // works after a prior SelectNoneOp inside a MultiOp has already
        // cleared the selection.
        const currentlySelected = IndexRanges.fromPredicate(
            numSplats,
            (i: number) => (state[i] & State.selected) !== 0
        );
        splat.state.clearBits(currentlySelected, State.selected);

        const targetRanges = IndexRanges.fromPredicate(
            numSplats,
            sortedPredicate(targetIndices)
        );
        splat.state.setBits(targetRanges, State.selected);

        await splat.updateState(State.selected);
    }

    async undo() {
        const { splat } = this;
        const numSplats = splat.splatData.numSplats;
        const state = splat.splatData.getProp('state') as Uint8Array;

        // Compute currently selected (should be the target indices we set)
        const currentlySelected = IndexRanges.fromPredicate(
            numSplats,
            (i: number) => (state[i] & State.selected) !== 0
        );
        splat.state.clearBits(currentlySelected, State.selected);

        // Restore previous selection
        splat.state.setBits(this.prevRanges, State.selected);

        await splat.updateState(State.selected);
    }

    serialize() {
        return {
            type: this.name,
            data: {
                splatIndex: this.splat.scene.getSplatIndex(this.splat),
                targetIndices: Array.from(this.targetIndices),
                prevRanges: this.prevRanges.serialize()
            }
        };
    }

    static deserialize(data: any, scene: Scene): ReplaceSelectionOp {
        const splat = scene.getSplatByIndex(data.splatIndex);
        const op = new ReplaceSelectionOp(splat, new Uint32Array(data.targetIndices));
        op.prevRanges = IndexRanges.deserialize(data.prevRanges);
        return op;
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

    serialize() {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];
        const pack4 = (q: Quat) => [q.x, q.y, q.z, q.w];
        return {
            type: this.name,
            data: {
                elementIndex: this.element.scene.elements.indexOf(this.element),
                oldt: {
                    position: pack3(this.oldt.position),
                    rotation: pack4(this.oldt.rotation),
                    scale: pack3(this.oldt.scale)
                },
                newt: {
                    position: pack3(this.newt.position),
                    rotation: pack4(this.newt.rotation),
                    scale: pack3(this.newt.scale)
                }
            }
        };
    }

    static deserialize(data: any, scene: Scene): EntityTransformOp {
        const unpackTransform = (t: any) => new Transform(
            new Vec3(t.position), new Quat(t.rotation), new Vec3(t.scale)
        );
        return new EntityTransformOp({
            element: scene.elements[data.elementIndex],
            oldt: unpackTransform(data.oldt),
            newt: unpackTransform(data.newt)
        });
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

    serialize() {
        return {
            type: this.name,
            data: {
                splatIndex: this.splat.scene.getSplatIndex(this.splat),
                transform: Array.from(this.transform.data),
                paletteMap: Array.from(this.paletteMap.entries())
            }
        };
    }

    static deserialize(data: any, scene: Scene): SplatsTransformOp {
        return new SplatsTransformOp({
            splat: scene.getSplatByIndex(data.splatIndex),
            transform: new Mat4().set(data.transform),
            paletteMap: new Map<number, number>(data.paletteMap)
        });
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

    serialize() {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];
        const pack4 = (q: Quat) => [q.x, q.y, q.z, q.w];
        return {
            type: this.name,
            data: {
                oldt: {
                    position: pack3(this.oldt.position),
                    rotation: pack4(this.oldt.rotation),
                    scale: pack3(this.oldt.scale)
                },
                newt: {
                    position: pack3(this.newt.position),
                    rotation: pack4(this.newt.rotation),
                    scale: pack3(this.newt.scale)
                }
            }
        };
    }

    static deserialize(data: any, events: Events): PlacePivotOp {
        const unpackTransform = (t: any) => new Transform(
            new Vec3(t.position), new Quat(t.rotation), new Vec3(t.scale)
        );
        return new PlacePivotOp({
            pivot: events.invoke('pivot') as Pivot,
            oldt: unpackTransform(data.oldt),
            newt: unpackTransform(data.newt)
        });
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

    serialize() {
        const packColor = (c: Color | undefined) => (c ? [c.r, c.g, c.b, c.a] : null);
        const packState = (s: ColorAdjustment) => ({
            tintClr: packColor(s.tintClr),
            temperature: s.temperature ?? null,
            saturation: s.saturation ?? null,
            brightness: s.brightness ?? null,
            blackPoint: s.blackPoint ?? null,
            whitePoint: s.whitePoint ?? null,
            transparency: s.transparency ?? null
        });
        return {
            type: this.name,
            data: {
                splatIndex: this.splat.scene.getSplatIndex(this.splat),
                oldState: packState(this.oldState),
                newState: packState(this.newState)
            }
        };
    }

    static deserialize(data: any, scene: Scene): SetSplatColorAdjustmentOp {
        const unpackState = (s: any): ColorAdjustment => ({
            tintClr: s.tintClr ? new Color(s.tintClr) : undefined,
            temperature: s.temperature ?? undefined,
            saturation: s.saturation ?? undefined,
            brightness: s.brightness ?? undefined,
            blackPoint: s.blackPoint ?? undefined,
            whitePoint: s.whitePoint ?? undefined,
            transparency: s.transparency ?? undefined
        });
        return new SetSplatColorAdjustmentOp({
            splat: scene.getSplatByIndex(data.splatIndex),
            oldState: unpackState(data.oldState),
            newState: unpackState(data.newState)
        });
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

    serialize() {
        return {
            type: this.name,
            data: {
                before: this.before,
                after: this.after
            }
        };
    }

    static deserialize(data: any, events: Events): AnimTrackEditOp {
        const track = events.invoke('animTrack.current') as AnimTrack;
        return new AnimTrackEditOp(data.name || 'animTrackEdit', track, data.before, data.after);
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

    serialize() {
        return {
            type: this.name,
            data: {
                ops: this.ops.map(op => op.serialize())
            }
        };
    }

    static deserialize(data: any, scene: Scene, events: Events): MultiOp {
        const ops = (data.ops as any[]).map(opData => deserializeEditOp(opData, scene, events));
        return new MultiOp(ops);
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

    serialize() {
        return {
            type: this.name,
            data: {
                splatIndex: this.scene.getSplatIndex(this.splat)
            }
        };
    }

    static deserialize(data: any, scene: Scene): AddSplatOp {
        return new AddSplatOp(scene, scene.getSplatByIndex(data.splatIndex));
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

    serialize() {
        return {
            type: this.name,
            data: {
                splatIndex: this.splat.scene.getSplatIndex(this.splat),
                oldName: this.oldName,
                newName: this.newName
            }
        };
    }

    static deserialize(data: any, scene: Scene): SplatRenameOp {
        const splat = scene.getSplatByIndex(data.splatIndex);
        const op = new SplatRenameOp(splat, data.newName);
        op.oldName = data.oldName;
        return op;
    }
}

// Minimal group data shape shared with point-cloud-group UI
interface GroupData {
    name: string;
    splat: Splat;
    ranges: IndexRanges;
}

class AddGroupOp {
    name = 'addGroup';
    groups: GroupData[];
    groupData: GroupData;
    onChanged: () => void;
    skipDo: boolean;

    constructor(groups: GroupData[], groupData: GroupData, onChanged: () => void, skipDo = true) {
        this.groups = groups;
        this.groupData = groupData;
        this.onChanged = onChanged;
        this.skipDo = skipDo;
    }

    do() {
        if (!this.skipDo) {
            this.groups.push(this.groupData);
            this.onChanged();
        }
        this.skipDo = false;
    }

    undo() {
        const idx = this.groups.indexOf(this.groupData);
        if (idx !== -1) {
            this.groups.splice(idx, 1);
        }
        this.onChanged();
    }

    serialize() {
        const ids: number[] = [];
        this.groupData.ranges.forEach(i => ids.push(i));
        return {
            type: this.name,
            data: {
                splatIndex: this.groupData.splat.scene.getSplatIndex(this.groupData.splat),
                name: this.groupData.name,
                ranges: ids
            }
        };
    }

    static deserialize(data: any, scene: Scene, events: Events): AddGroupOp {
        const splat = scene.getSplatByIndex(data.splatIndex);
        const groups = events.invoke('pointCloudGroup.getGroupsArray') as GroupData[];
        const onChanged = events.invoke('pointCloudGroup.getRenderCallback', splat) as () => void;
        const ranges = IndexRanges.fromPredicate(
            splat.splatData.numSplats,
            (i: number) => data.ranges.includes(i)
        );
        const groupData: GroupData = { name: data.name, splat, ranges };
        return new AddGroupOp(groups, groupData, onChanged, data.skipDo ?? true);
    }
}

class DeleteGroupOp {
    name = 'deleteGroup';
    groups: GroupData[];
    groupData: GroupData;
    setSelectedGroupData: (value: GroupData | null) => void;
    onChanged: () => void;
    skipDo: boolean;

    constructor(groups: GroupData[], groupData: GroupData, setSelectedGroupData: (value: GroupData | null) => void, onChanged: () => void, skipDo = true) {
        this.groups = groups;
        this.groupData = groupData;
        this.setSelectedGroupData = setSelectedGroupData;
        this.onChanged = onChanged;
        this.skipDo = skipDo;
    }

    do() {
        if (!this.skipDo) {
            const idx = this.groups.indexOf(this.groupData);
            if (idx !== -1) this.groups.splice(idx, 1);
            this.setSelectedGroupData(null);
            this.onChanged();
        }
        this.skipDo = false;
    }

    undo() {
        this.groups.push(this.groupData);
        this.onChanged();
    }

    serialize() {
        const ids: number[] = [];
        this.groupData.ranges.forEach(i => ids.push(i));
        return {
            type: this.name,
            data: {
                splatIndex: this.groupData.splat.scene.getSplatIndex(this.groupData.splat),
                name: this.groupData.name,
                ranges: ids
            }
        };
    }

    static deserialize(data: any, scene: Scene, events: Events): DeleteGroupOp {
        const splat = scene.getSplatByIndex(data.splatIndex);
        const groups = events.invoke('pointCloudGroup.getGroupsArray') as GroupData[];
        const setSelectedGroupData = events.invoke('pointCloudGroup.setSelectedGroupData') as (value: GroupData | null) => void;
        const onChanged = events.invoke('pointCloudGroup.getRenderCallback', splat) as () => void;
        const ranges = IndexRanges.fromPredicate(
            splat.splatData.numSplats,
            (i: number) => data.ranges.includes(i)
        );
        const groupData: GroupData = { name: data.name, splat, ranges };
        return new DeleteGroupOp(groups, groupData, setSelectedGroupData, onChanged, data.skipDo ?? true);
    }
}

class ModifyGroupRangesOp {
    name = 'modifyGroupRanges';
    groupData: GroupData;
    oldRanges: IndexRanges;
    newRanges: IndexRanges;
    onChanged: () => void;
    skipDo: boolean;

    constructor(groupData: GroupData, oldRanges: IndexRanges, newRanges: IndexRanges, onChanged: () => void, skipDo = true) {
        this.groupData = groupData;
        this.oldRanges = oldRanges;
        this.newRanges = newRanges;
        this.onChanged = onChanged;
        this.skipDo = skipDo;
    }

    do() {
        if (!this.skipDo) {
            this.groupData.ranges = this.newRanges;
            this.onChanged();
        }
        this.skipDo = false;
    }

    undo() {
        this.groupData.ranges = this.oldRanges;
        this.onChanged();
    }

    serialize() {
        return {
            type: this.name,
            data: {
                splatIndex: this.groupData.splat.scene.getSplatIndex(this.groupData.splat),
                name: this.groupData.name,
                oldRanges: this.oldRanges.serialize(),
                newRanges: this.newRanges.serialize()
            }
        };
    }

    static deserialize(data: any, scene: Scene, events: Events): ModifyGroupRangesOp {
        const splat = scene.getSplatByIndex(data.splatIndex);
        const groups = events.invoke('pointCloudGroup.getGroupsArray') as GroupData[];
        // Find the existing group by name
        const groupData = groups.find((g: GroupData) => g.splat === splat && g.name === data.name);
        if (!groupData) {
            throw new Error(`Group '${data.name}' not found for splat`);
        }
        const onChanged = events.invoke('pointCloudGroup.getRenderCallback', splat) as () => void;
        const oldRanges = IndexRanges.deserialize(data.oldRanges);
        const newRanges = IndexRanges.deserialize(data.newRanges);
        return new ModifyGroupRangesOp(groupData, oldRanges, newRanges, onChanged, data.skipDo ?? true);
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

    serialize() {
        return {
            type: this.name,
            data: {
                shapeUid: this.shape.uid,
                shapeType: this.shape.type,
                shapesUids: this.shapes.map(s => s.uid)
            }
        };
    }

    static deserialize(data: any, scene: Scene): AddShapeOp | null {
        // Look up the shape from scene.elements by UID
        const shape = scene.elements.find(e => e.uid === data.shapeUid) as Element;
        if (!shape) {
            return null; // shape not in scene (e.g. shapes not saved in document), skip
        }
        // Reconstruct the shapes array from scene elements
        const uidSet = new Set(data.shapesUids);
        const shapes = scene.elements.filter(e => uidSet.has(e.uid));
        const currentShape = shapes.length > 0 ? shapes[shapes.length - 1] : null;
        return new AddShapeOp({
            scene,
            shape,
            shapes,
            currentShape,
            setCurrentShape: () => {},
            skipDo: true
        });
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
    sourceGroupsData: Map<Splat, SerializedGroupData[]>;
    mergedGroupsData: SerializedGroupData[];

    constructor(scene: Scene, sourceSplats: Splat[], mergedSplat: Splat) {
        this.scene = scene;
        this.sourceSplats = sourceSplats;
        this.mergedSplat = mergedSplat;
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

        // Add the pre-built merged splat to the scene
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
        this.sourceGroupsData = null;
        this.mergedGroupsData = null;
    }

    serialize() {
        return {
            type: this.name,
            data: {
                sourceSplatIndices: this.sourceSplats.map(s => this.scene.getSplatIndex(s)),
                mergedSplatIndex: this.mergedSplat ? this.scene.getSplatIndex(this.mergedSplat) : -1,
                sourceGroupsData: Array.from(this.sourceGroupsData.entries()).map(([splat, groups]) => ({
                    splatIndex: this.scene.getSplatIndex(splat),
                    groups: groups.map(g => ({ name: g.name, indices: Array.from(g.indices) }))
                })),
                mergedGroupsData: this.mergedGroupsData.map(g => ({
                    name: g.name,
                    indices: Array.from(g.indices)
                }))
            }
        };
    }

    static deserialize(data: any, scene: Scene): MergeOp {
        const sourceSplats = data.sourceSplatIndices.map((i: number) => scene.getSplatByIndex(i));
        const mergedSplat = data.mergedSplatIndex >= 0 ? scene.getSplatByIndex(data.mergedSplatIndex) : null;
        const op = new MergeOp(scene, sourceSplats, mergedSplat);
        op.sourceGroupsData = new Map();
        for (const entry of data.sourceGroupsData) {
            op.sourceGroupsData.set(
                scene.getSplatByIndex(entry.splatIndex),
                entry.groups.map((g: any) => ({ name: g.name, indices: new Uint32Array(g.indices) }))
            );
        }
        op.mergedGroupsData = data.mergedGroupsData.map((g: any) => ({
            name: g.name,
            indices: new Uint32Array(g.indices)
        }));
        return op;
    }
}

// Factory function to deserialize any EditOp from its serialized form
function deserializeEditOp(
    opData: { type: string; data: any },
    scene: Scene,
    events: Events
): EditOp {
    switch (opData.type) {
        case 'stateOp':
        case 'selectAll':
        case 'selectNone':
        case 'selectInvert':
        case 'selectOp':
        case 'hideSelection':
        case 'unhideAll':
        case 'deleteSelection':
        case 'reset':
            return StateOp.deserialize(opData.data, scene);
        case 'entityTransform':
            return EntityTransformOp.deserialize(opData.data, scene);
        case 'splatsTransform':
            return SplatsTransformOp.deserialize(opData.data, scene);
        case 'setPivot':
            return PlacePivotOp.deserialize(opData.data, events);
        case 'setSplatColor':
            return SetSplatColorAdjustmentOp.deserialize(opData.data, scene);
        case 'animTrackEdit':
            return AnimTrackEditOp.deserialize(opData.data, events);
        case 'multiOp':
            return MultiOp.deserialize(opData.data, scene, events);
        case 'addSplat':
            return AddSplatOp.deserialize(opData.data, scene);
        case 'splatRename':
            return SplatRenameOp.deserialize(opData.data, scene);
        case 'merge':
            return MergeOp.deserialize(opData.data, scene);
        case 'addGroup':
            return AddGroupOp.deserialize(opData.data, scene, events);
        case 'deleteGroup':
            return DeleteGroupOp.deserialize(opData.data, scene, events);
        case 'modifyGroupRanges':
            return ModifyGroupRangesOp.deserialize(opData.data, scene, events);
        case 'replaceSelection':
            return ReplaceSelectionOp.deserialize(opData.data, scene);
        case 'addShape':
            return AddShapeOp.deserialize(opData.data, scene);
        default:
            throw new Error(`Unknown EditOp type: ${opData.type}`);
    }
}

export {
    EditOp,
    StateOp,
    BitOp,
    SelectAllOp,
    SelectNoneOp,
    SelectInvertOp,
    SelectOp,
    ReplaceSelectionOp,
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
    MergeOp,
    AddGroupOp,
    DeleteGroupOp,
    ModifyGroupRangesOp,
    deserializeEditOp
};
