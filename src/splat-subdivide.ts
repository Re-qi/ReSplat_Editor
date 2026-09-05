import { GSplatData, Quat, Vec3 } from 'playcanvas';

import type { Events } from './events';
import { IndexRanges, sortedPredicate } from './index-ranges';
import type { Splat } from './splat';
import { State } from './splat-state';

const DECAL_SUBDIVISION_POINT_BUDGET = 50_000;
const DECAL_SUBDIVISION_TARGET_PIXEL_AREA = 4;

type DecalSubdivisionRequest = {
    parentIndex: number;
    level: number;
};

type DecalSubdivisionChildRange = {
    parentIndex: number;
    start: number;
    count: number;
};

type DecalSubdivisionResult = {
    data: GSplatData;
    transformIndices: Uint16Array;
    soloMask: Uint8Array;
    desaturateMask: Uint8Array;
    structuralIndices: Uint32Array;
    beforeStates: Uint8Array;
    afterStates: Uint8Array;
    childRanges: DecalSubdivisionChildRange[];
};

type SubdivisionGroupChange = {
    groupIndex: number;
    name: string;
    beforeRanges: IndexRanges;
    afterRanges: IndexRanges;
};

type SerializedGroupData = {
    name: string;
    indices: Uint32Array;
};

type MutableGroupData = {
    name: string;
    splat: Splat;
    ranges: IndexRanges;
};

type IncrementalLevel = {
    parentIndex: number;
    level: number;
    score: number;
    cost: number;
};

const planDecalSubdivision = (
    projectedAreaById: Map<number, number>,
    maxLevel: number,
    pointBudget = DECAL_SUBDIVISION_POINT_BUDGET,
    targetPixelArea = DECAL_SUBDIVISION_TARGET_PIXEL_AREA
): DecalSubdivisionRequest[] => {
    const clampedMaxLevel = Math.max(0, Math.min(3, Math.floor(maxLevel)));
    if (clampedMaxLevel === 0 || pointBudget < 4) return [];

    const tasks: IncrementalLevel[] = [];
    projectedAreaById.forEach((area, parentIndex) => {
        if (!Number.isFinite(area) || area <= targetPixelArea || parentIndex < 0) return;

        let desiredLevel = 0;
        while (desiredLevel < clampedMaxLevel && area > targetPixelArea * 4 ** desiredLevel) {
            desiredLevel++;
        }

        for (let level = 1; level <= desiredLevel; ++level) {
            const previousCount = level === 1 ? 0 : 4 ** (level - 1);
            const nextCount = 4 ** level;
            tasks.push({
                parentIndex,
                level,
                score: area / 4 ** (level - 1),
                cost: nextCount - previousCount
            });
        }
    });

    // Allocate detail to the largest remaining projected footprint first. A
    // level-N task always sorts after the same point's level-(N-1) task.
    tasks.sort((a, b) => b.score - a.score || a.level - b.level || a.parentIndex - b.parentIndex);

    const levels = new Map<number, number>();
    let remaining = pointBudget;
    for (const task of tasks) {
        const currentLevel = levels.get(task.parentIndex) ?? 0;
        if (currentLevel !== task.level - 1 || task.cost > remaining) continue;
        levels.set(task.parentIndex, task.level);
        remaining -= task.cost;
    }

    return Array.from(levels, ([parentIndex, level]) => ({ parentIndex, level }))
    .sort((a, b) => a.parentIndex - b.parentIndex);
};

// The selection-menu command uses the same child generation as decal
// subdivision. If the point cloud has a Gaussian selection, only those points
// are targeted; otherwise every editable point in the selected cloud is used.
const planSplatSubdivision = (source: GSplatData, level = 1): DecalSubdivisionRequest[] => {
    const clampedLevel = Math.max(1, Math.min(3, Math.floor(level)));
    const state = source.getProp('state') as Uint8Array | undefined;
    if (!state) return [];

    let hasSelection = false;
    for (let i = 0; i < source.numSplats; ++i) {
        const value = state[i];
        if ((value & State.selected) !== 0 && (value & (State.locked | State.deleted)) === 0) {
            hasSelection = true;
            break;
        }
    }

    const requests: DecalSubdivisionRequest[] = [];
    for (let i = 0; i < source.numSplats; ++i) {
        const value = state[i];
        if ((value & (State.locked | State.deleted)) !== 0) continue;
        if (hasSelection && (value & State.selected) === 0) continue;
        requests.push({ parentIndex: i, level: clampedLevel });
    }
    return requests;
};

const copyElements = (source: GSplatData, vertexCount: number) => {
    return (source as any).elements.map((element: any) => {
        const isVertex = element.name === 'vertex';
        return {
            ...element,
            count: isVertex ? vertexCount : element.count,
            properties: element.properties.map((property: any) => {
                const storage = property.storage;
                if (!storage) return { ...property };
                const Ctor = storage.constructor as new (length: number) => any;
                const next = new Ctor(isVertex ? vertexCount : storage.length);
                next.set(storage);
                return { ...property, storage: next };
            })
        };
    });
};

const subdivideSplatData = (
    source: GSplatData,
    requests: DecalSubdivisionRequest[],
    sourceTransformIndices: Uint16Array,
    sourceSoloMask: Uint8Array,
    sourceDesaturateMask: Uint8Array
): DecalSubdivisionResult | null => {
    if (requests.length === 0) return null;

    const oldCount = source.numSplats;
    const validRequests = requests.filter(request => (
        request.parentIndex >= 0 && request.parentIndex < oldCount && request.level >= 1 && request.level <= 3
    ));
    if (validRequests.length === 0) return null;

    const childCount = validRequests.reduce((sum, request) => sum + 4 ** request.level, 0);
    const newCount = oldCount + childCount;
    const elements = copyElements(source, newCount);
    const data = new GSplatData(elements, (source as any).comments ?? []);

    const x = data.getProp('x') as Float32Array;
    const y = data.getProp('y') as Float32Array;
    const z = data.getProp('z') as Float32Array;
    const scale = [
        data.getProp('scale_0') as Float32Array,
        data.getProp('scale_1') as Float32Array,
        data.getProp('scale_2') as Float32Array
    ];
    const rotW = data.getProp('rot_0') as Float32Array;
    const rotX = data.getProp('rot_1') as Float32Array;
    const rotY = data.getProp('rot_2') as Float32Array;
    const rotZ = data.getProp('rot_3') as Float32Array;
    const state = data.getProp('state') as Uint8Array;
    if (!x || !y || !z || scale.some(value => !value) || !rotW || !rotX || !rotY || !rotZ || !state) {
        throw new Error('Decal subdivision requires position, scale, rotation, and state properties.');
    }

    const transformIndices = new Uint16Array(newCount);
    transformIndices.set(sourceTransformIndices.subarray(0, oldCount));
    const soloMask = new Uint8Array(newCount);
    soloMask.fill(255);
    soloMask.set(sourceSoloMask.subarray(0, oldCount));
    const desaturateMask = new Uint8Array(newCount);
    desaturateMask.set(sourceDesaturateMask.subarray(0, oldCount));

    const vertexProps = data.getElement('vertex').properties as any[];
    const transformProp = data.getProp('transform') as Uint16Array | undefined;
    const structuralIndices = new Uint32Array(validRequests.length + childCount);
    const beforeStates = new Uint8Array(structuralIndices.length);
    const afterStates = new Uint8Array(structuralIndices.length);
    const childRanges: DecalSubdivisionChildRange[] = [];
    const quaternion = new Quat();
    const axes = [new Vec3(1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 0, 1)];
    const axisU = new Vec3();
    const axisV = new Vec3();
    let writeIndex = oldCount;
    let structuralWrite = 0;

    for (const request of validRequests) {
        const parent = request.parentIndex;
        const parentState = state[parent];
        structuralIndices[structuralWrite] = parent;
        beforeStates[structuralWrite] = parentState;
        afterStates[structuralWrite] = parentState | State.deleted;
        structuralWrite++;
        state[parent] = parentState | State.deleted;

        const axisOrder = [0, 1, 2].sort((a, b) => scale[b][parent] - scale[a][parent]);
        const tangentU = axisOrder[0];
        const tangentV = axisOrder[1];
        quaternion.set(rotX[parent], rotY[parent], rotZ[parent], rotW[parent]).normalize();
        quaternion.transformVector(axes[tangentU], axisU);
        quaternion.transformVector(axes[tangentV], axisV);

        const linearU = Math.exp(scale[tangentU][parent]);
        const linearV = Math.exp(scale[tangentV][parent]);
        const gridSize = 2 ** request.level;
        const scaleDelta = Math.log(gridSize);
        const rangeStart = writeIndex;

        for (let gridY = 0; gridY < gridSize; ++gridY) {
            const offsetV = (2 * gridY + 1 - gridSize) / gridSize * linearV;
            for (let gridX = 0; gridX < gridSize; ++gridX) {
                const offsetU = (2 * gridX + 1 - gridSize) / gridSize * linearU;
                const child = writeIndex++;

                for (const property of vertexProps) {
                    if (property.storage) property.storage[child] = property.storage[parent];
                }

                x[child] = x[parent] + axisU.x * offsetU + axisV.x * offsetV;
                y[child] = y[parent] + axisU.y * offsetU + axisV.y * offsetV;
                z[child] = z[parent] + axisU.z * offsetU + axisV.z * offsetV;
                scale[tangentU][child] = scale[tangentU][parent] - scaleDelta;
                scale[tangentV][child] = scale[tangentV][parent] - scaleDelta;

                const childState = parentState & ~State.deleted;
                state[child] = childState;
                transformIndices[child] = sourceTransformIndices[parent] ?? 0;
                if (transformProp) transformProp[child] = transformIndices[child];
                soloMask[child] = sourceSoloMask[parent] ?? 255;
                desaturateMask[child] = sourceDesaturateMask[parent] ?? 0;

                structuralIndices[structuralWrite] = child;
                beforeStates[structuralWrite] = childState | State.deleted;
                afterStates[structuralWrite] = childState;
                structuralWrite++;
            }
        }

        childRanges.push({
            parentIndex: parent,
            start: rangeStart,
            count: writeIndex - rangeStart
        });
    }

    return {
        data,
        transformIndices,
        soloMask,
        desaturateMask,
        structuralIndices,
        beforeStates,
        afterStates,
        childRanges
    };
};

const applySubdivisionGroups = (
    events: Events,
    target: Splat,
    changes: SubdivisionGroupChange[],
    applied: boolean
) => {
    if (changes.length === 0 || !events.functions.has('pointCloudGroup.getGroupsArray')) return;
    const allGroups = events.invoke('pointCloudGroup.getGroupsArray') as MutableGroupData[];
    const splatGroups = allGroups.filter(group => group.splat === target);
    for (const change of changes) {
        let group = splatGroups[change.groupIndex];
        if (!group || group.name !== change.name) {
            group = splatGroups.find(candidate => candidate.name === change.name);
        }
        if (group) group.ranges = applied ? change.afterRanges : change.beforeRanges;
    }
    if (events.functions.has('pointCloudGroup.getRenderCallback')) {
        const onChanged = events.invoke('pointCloudGroup.getRenderCallback', target) as (() => void) | undefined;
        onChanged?.();
    }
};

const buildSubdivisionGroupChanges = (
    events: Events,
    target: Splat,
    oldCount: number,
    newCount: number,
    childRanges: DecalSubdivisionChildRange[]
): SubdivisionGroupChange[] => {
    if (!events.functions.has('pointCloudGroup.getGroupsForSplat')) return [];
    const groups = (events.invoke('pointCloudGroup.getGroupsForSplat', target) ?? []) as SerializedGroupData[];
    const childrenByParent = new Map(childRanges.map(range => [range.parentIndex, range]));

    return groups.flatMap((group, groupIndex) => {
        const preserved: number[] = [];
        const appended: number[] = [];
        let changed = false;
        for (let i = 0; i < group.indices.length; ++i) {
            const id = group.indices[i];
            const childRange = childrenByParent.get(id);
            if (!childRange) {
                preserved.push(id);
                continue;
            }
            changed = true;
            for (let child = childRange.start; child < childRange.start + childRange.count; ++child) {
                appended.push(child);
            }
        }
        if (!changed) return [];
        const afterIds = new Uint32Array(preserved.length + appended.length);
        afterIds.set(preserved);
        afterIds.set(appended, preserved.length);
        return [{
            groupIndex,
            name: group.name,
            beforeRanges: IndexRanges.fromPredicate(oldCount, sortedPredicate(group.indices)),
            afterRanges: IndexRanges.fromPredicate(newCount, sortedPredicate(afterIds))
        }];
    });
};

export {
    DECAL_SUBDIVISION_POINT_BUDGET,
    DECAL_SUBDIVISION_TARGET_PIXEL_AREA,
    applySubdivisionGroups,
    buildSubdivisionGroupChanges,
    planDecalSubdivision,
    planSplatSubdivision,
    subdivideSplatData
};
export type {
    DecalSubdivisionChildRange,
    DecalSubdivisionRequest,
    DecalSubdivisionResult,
    SubdivisionGroupChange
};
