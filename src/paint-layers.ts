import { dcDecode, dcEncode } from './color-grade';
import { DecalSubdividePaintOp, EditOp, PaintEraseOp, PaintLayerOp, PaintStrokeOp } from './edit-ops';
import { Events } from './events';
import {
    accumulatePaintLayerRgba,
    compositePaintLayerRgb,
    erasePaintLayerRgba,
    isPaintBlendMode,
    type PaintBlendMode,
    type PremultipliedRgba
} from './paint-layer-blend';
import { nextAvailablePaintLayerNumber } from './paint-layer-naming';
import { Splat } from './splat';
import { State } from './splat-state';
import { applySubdivisionGroups } from './splat-subdivide';
import { localize } from './ui/localization';

type PaintLayer = {
    id: string;
    name: string;
    visible: boolean;
    blendMode: PaintBlendMode;
    opacity: number;
    // The selected Gaussian is exposed as a read-only backdrop row.
    // It is derived from scene selection and is never persisted as a paint layer.
    base?: boolean;
    // Deleted layers stay as tombstones while their edit-history entries are
    // retained, so undo/redo and project restore can bring them back without
    // accidentally recreating them during history deserialization.
    deleted?: boolean;
};

type PaintLayersDocument = {
    version: number;
    // Version 3 stores one independent layer stack for every Gaussian file.
    groups?: Array<{
        splatIndex: number;
        activeLayerId: string;
        layers: PaintLayer[];
    }>;
    // Versions 1 and 2 stored one shared layer stack. Keep these optional
    // fields so older projects can still be migrated when opened.
    activeLayerId?: string;
    layers?: PaintLayer[];
    splats: Array<{ splatIndex: number, layerId: string }>;
};

type ColorValue = [number, number, number];

type SplatBaseline = {
    colors: Map<number, ColorValue>;
    deleted: Map<number, number>;
};

type LayerColorWork = Map<string, Map<Splat, Map<number, PremultipliedRgba>>>;

const BASE_LAYER_ID = 'paint-layer-base';
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

class PaintLayerManager {
    private events: Events;
    private layers: PaintLayer[] = [];
    private layerOwners = new Map<string, Splat>();
    private activeLayerIds = new Map<Splat, string>();
    private nextLayerIdNumber = 1;
    private operations: PaintLayerOp[] = [];
    private operationApplied = new Map<PaintLayerOp, boolean>();
    private baselines = new Map<Splat, SplatBaseline>();
    private attachedSplats = new Map<Splat, string>();
    private baseSplat: Splat | null = null;
    private restoring = false;
    private dirty = false;
    private recomposeRevision = 0;
    private recomposeQueued = false;

    constructor(events: Events) {
        this.events = events;
        this.reset(false);

        events.function('paint.layers.list', () => this.getLayers());
        events.function('paint.layers.active', () => this.getActiveLayerId());
        events.function('paint.layers.activeVisible', () => {
            const layer = this.getLayer(this.getActiveLayerId());
            return !!layer && !layer.deleted && layer.visible;
        });
        events.function('paint.layers.attachedSplats', (layerId = this.getActiveLayerId()) => {
            const result: Splat[] = [];
            for (const [splat, attachedLayerId] of this.attachedSplats) {
                if (attachedLayerId === layerId && splat.scene) result.push(splat);
            }
            return result;
        });
        events.function('paint.target', () => this.getPaintTarget());
        events.function('paint.layers.wrapOperation', (op: EditOp, layerId?: string) => this.wrapOperation(op, layerId));
        events.function('paint.layers.attachSplat', (splat: Splat, layerId?: string) => this.attachSplat(splat, layerId));
        events.function('paint.layers.delete', (layerId: string) => this.deleteLayer(layerId));
        events.function('paint.layers.restore', (layerId: string) => this.restoreLayer(layerId));
        events.function('paint.layers.operation.register', (op: PaintLayerOp, applied = false) => this.registerOperation(op, applied));
        events.function('paint.layers.operation.unregister', (op: PaintLayerOp) => this.unregisterOperation(op));
        events.function('paint.layers.operation.setApplied', (op: PaintLayerOp, applied: boolean) => this.setOperationApplied(op, applied));
        events.function('paint.layers.serialize', () => this.serialize());
        events.function('paint.layers.deserialize', (data: PaintLayersDocument | null | undefined, splats: Splat[]) => this.deserialize(data, splats));
        events.function('paint.layers.finishRestore', () => this.finishRestore());
        events.function('paint.layers.recompose', () => this.recompose());
        events.function('paint.layers.dirty', () => this.dirty);

        events.on('paint.layers.create', () => this.createLayer());
        events.on('paint.layers.select', (layerId: string) => this.selectLayer(layerId));
        events.on('paint.layers.setVisible', (layerId: string, visible: boolean) => this.setLayerVisible(layerId, visible));
        events.on('paint.layers.setBlendMode', (layerId: string, mode: PaintBlendMode) => this.setLayerBlendMode(layerId, mode));
        events.on('paint.layers.setOpacity', (layerId: string, opacity: number) => this.setLayerOpacity(layerId, opacity));
        events.on('paint.layers.reorder', (layerId: string, index: number) => this.reorderLayer(layerId, index));
        events.on('selection.changed', () => {
            // Keep the paint target and visible layer stack synchronized with
            // the actual selected Gaussian, including selection changes made
            // while paint mode is active.
            this.refreshBaseSplat();
        });
        events.on('mode.willChange', (mode: 'edit' | 'paint') => {
            if (mode === 'paint') this.refreshBaseSplat();
        });
        events.on('mode.changed', (mode: 'edit' | 'paint') => {
            if (mode === 'edit') this.refreshBaseSplat();
        });
        events.on('splat.name', (splat: Splat) => {
            if (splat === this.baseSplat) this.fireChanged();
        });
        events.on('scene.clear', () => this.reset());
        events.on('scene.elementAdded', (element: unknown) => {
            if (!(element instanceof Splat)) return;
            this.ensureSplatLayers(element);
            const layer = this.getLayer(this.attachedSplats.get(element) ?? '');
            if (layer) {
                element.visible = !layer.deleted && layer.visible;
                element.paintLayerOpacity = layer.opacity;
            }
        });
        events.on('scene.elementRemoved', (element: unknown) => {
            if (element === this.baseSplat) {
                this.baseSplat = null;
                this.fireChanged();
            }
        });
        events.on('splat.visibility', (splat: Splat) => {
            if (splat === this.baseSplat && !splat.visible) {
                this.baseSplat = null;
                this.fireChanged();
            }
        });
        events.on('doc.saved', () => {
            this.dirty = false;
        });
    }

    private getLayer(layerId: string) {
        return this.layers.find(layer => layer.id === layerId);
    }

    private getOwnedLayers(owner: Splat, includeDeleted = true) {
        return this.layers.filter(layer => this.layerOwners.get(layer.id) === owner && (includeDeleted || !layer.deleted));
    }

    private getActiveLayerId(owner = this.baseSplat) {
        return owner ? this.activeLayerIds.get(owner) ?? '' : '';
    }

    private ensureSplatLayers(owner: Splat) {
        const layers = this.getOwnedLayers(owner, false);
        if (layers.length === 0) {
            return this.createLayer(undefined, undefined, false, owner);
        }

        const activeLayerId = this.getActiveLayerId(owner);
        if (!layers.some(layer => layer.id === activeLayerId)) {
            this.activeLayerIds.set(owner, layers[0].id);
        }
        return layers[0];
    }

    private getLayers() {
        const layers = (this.baseSplat ? this.getOwnedLayers(this.baseSplat, false) : [])
        .map(layer => ({ ...layer }));
        layers.push({
            id: BASE_LAYER_ID,
            name: this.baseSplat?.name || this.baseSplat?.filename || localize('paint.layers.no-gaussian'),
            visible: true,
            blendMode: 'normal',
            opacity: 1,
            base: true
        });
        return layers;
    }

    private refreshBaseSplat() {
        const selection = this.events.functions.has('splatSelection') ? this.events.invoke('splatSelection') : null;
        const splat = selection instanceof Splat ? selection : null;
        if (this.baseSplat === splat) return;
        this.baseSplat = splat;
        if (splat) this.ensureSplatLayers(splat);
        this.fireChanged();
    }

    private getPaintTarget() {
        const splat = this.baseSplat;
        const selection = this.events.functions.has('splatSelection') ? this.events.invoke('splatSelection') : null;
        if (selection !== splat || !splat?.scene || !splat.visible ||
            (splat.lodEditLog && splat.lodCounts.length > 1)) return null;
        return splat;
    }

    private createLayer(name?: string, id?: string, notify = true, owner = this.baseSplat) {
        if (!owner) return null;
        const idNumber = this.nextLayerIdNumber++;
        const nameNumber = nextAvailablePaintLayerNumber(this.getOwnedLayers(owner));
        const layer: PaintLayer = {
            id: id ?? `paint-layer-${idNumber}`,
            name: name ?? `${localize('paint.layers.layer')} ${nameNumber}`,
            visible: true,
            blendMode: 'normal',
            opacity: 1
        };
        this.layers.unshift(layer);
        this.layerOwners.set(layer.id, owner);
        this.activeLayerIds.set(owner, layer.id);
        if (notify) {
            this.dirty = true;
            this.fireChanged();
        }
        return layer;
    }

    private ensureLayer(layerId: string, owner = this.baseSplat) {
        const existing = this.getLayer(layerId);
        if (existing) return existing;
        return this.createLayer(undefined, layerId, false, owner);
    }

    private selectLayer(layerId: string) {
        const layer = this.getLayer(layerId);
        const owner = layer ? this.layerOwners.get(layer.id) : null;
        if (!layer || !owner || owner !== this.baseSplat || layer.deleted || this.getActiveLayerId(owner) === layerId) return;
        this.activeLayerIds.set(owner, layerId);
        this.dirty = true;
        this.fireChanged();
    }

    private setLayerVisible(layerId: string, visible: boolean) {
        const layer = this.getLayer(layerId);
        if (!layer || layer.deleted || layer.visible === visible) return;
        layer.visible = visible;
        this.dirty = true;
        this.fireChanged();
        this.queueRecompose();
    }

    private setLayerBlendMode(layerId: string, mode: PaintBlendMode) {
        const layer = this.getLayer(layerId);
        if (!layer || layer.deleted || !isPaintBlendMode(mode) || layer.blendMode === mode) return;
        layer.blendMode = mode;
        this.dirty = true;
        this.fireChanged();
        this.queueRecompose();
    }

    private setLayerOpacity(layerId: string, opacity: number) {
        const layer = this.getLayer(layerId);
        if (!layer || layer.deleted || !Number.isFinite(opacity)) return;
        const nextOpacity = clamp01(opacity);
        if (layer.opacity === nextOpacity) return;
        layer.opacity = nextOpacity;
        this.dirty = true;
        this.fireChanged();
        this.queueRecompose();
    }

    private reorderLayer(layerId: string, index: number) {
        const layer = this.getLayer(layerId);
        const owner = layer ? this.layerOwners.get(layer.id) : null;
        if (!layer || !owner || owner !== this.baseSplat || layer.deleted || !Number.isFinite(index)) return;

        const visibleLayers = this.getOwnedLayers(owner, false);
        const sourceIndex = visibleLayers.indexOf(layer);
        if (sourceIndex === -1) return;

        visibleLayers.splice(sourceIndex, 1);
        const targetIndex = Math.min(visibleLayers.length, Math.max(0, Math.trunc(index)));
        visibleLayers.splice(targetIndex, 0, layer);

        const currentOrder = this.getOwnedLayers(owner, false);
        if (currentOrder.every((candidate, currentIndex) => candidate === visibleLayers[currentIndex])) return;

        let visibleIndex = 0;
        this.layers = this.layers.map(candidate => (
            this.layerOwners.get(candidate.id) === owner && !candidate.deleted ? visibleLayers[visibleIndex++] : candidate
        ));
        this.dirty = true;
        this.fireChanged();
        this.queueRecompose();
    }

    private queueRecompose() {
        this.recomposeRevision++;
        if (this.recomposeQueued || this.restoring) return;
        this.recomposeQueued = true;
        const queued = this.events.invoke('queue', async () => {
            try {
                let revision: number;
                do {
                    revision = this.recomposeRevision;
                    await this.recompose();
                } while (revision !== this.recomposeRevision);
            } finally {
                this.recomposeQueued = false;
            }
        }) as Promise<void> | undefined;
        queued?.catch(error => console.error('[PaintLayers] Failed to recompose paint layers', error));
    }

    private deleteLayer(layerId: string) {
        const layer = this.getLayer(layerId);
        if (!layer || layer.deleted) return;

        const owner = this.layerOwners.get(layer.id);
        layer.deleted = true;
        if (owner && this.getActiveLayerId(owner) === layerId) {
            this.activeLayerIds.set(owner, this.getOwnedLayers(owner, false)[0]?.id ?? '');
        }
        this.dirty = true;
        this.fireChanged();
        return this.recompose();
    }

    private restoreLayer(layerId: string) {
        const layer = this.getLayer(layerId);
        if (!layer || !layer.deleted) return;

        const owner = this.layerOwners.get(layer.id);
        layer.deleted = false;
        // Restoring the deleted layer makes it the active target when the
        // previous active layer no longer exists. Otherwise preserve the
        // current active layer (for example after undoing a non-active delete).
        if (owner && (!this.getActiveLayerId(owner) || this.getLayer(this.getActiveLayerId(owner))?.deleted)) {
            this.activeLayerIds.set(owner, layerId);
        }
        this.dirty = true;
        this.fireChanged();
        return this.recompose();
    }

    private wrapOperation(op: EditOp, layerId?: string) {
        const owner = (op as any).splat instanceof Splat ? (op as any).splat as Splat : this.baseSplat;
        if (!owner) return op;
        this.ensureSplatLayers(owner);
        const requestedLayer = layerId ? this.getLayer(layerId) : null;
        const resolvedLayerId = requestedLayer && this.layerOwners.get(requestedLayer.id) === owner ?
            requestedLayer.id : this.getActiveLayerId(owner);
        if (!resolvedLayerId || !this.ensureLayer(resolvedLayerId, owner)) return op;
        const wrapped = new PaintLayerOp(resolvedLayerId, op, this.events);
        this.registerOperation(wrapped, true);
        return wrapped;
    }

    private attachSplat(splat: Splat, layerId = this.getActiveLayerId()) {
        if (!layerId || !this.ensureLayer(layerId)) return;
        this.attachedSplats.set(splat, layerId);
        const layer = this.getLayer(layerId);
        if (layer) {
            splat.visible = !layer.deleted && layer.visible;
            splat.paintLayerOpacity = layer.opacity;
        }
        this.dirty = true;
    }

    private getBaseline(splat: Splat) {
        let baseline = this.baselines.get(splat);
        if (!baseline) {
            baseline = { colors: new Map(), deleted: new Map() };
            this.baselines.set(splat, baseline);
        }
        return baseline;
    }

    private captureColors(splat: Splat, indices: Uint32Array, values: Float32Array) {
        const colors = this.getBaseline(splat).colors;
        for (let i = 0; i < indices.length; ++i) {
            const index = indices[i];
            if (colors.has(index)) continue;
            const value = i * 3;
            colors.set(index, [values[value], values[value + 1], values[value + 2]]);
        }
    }

    private captureDeleted(splat: Splat, indices: Uint32Array, values: Uint8Array) {
        const deleted = this.getBaseline(splat).deleted;
        for (let i = 0; i < indices.length; ++i) {
            const index = indices[i];
            if (!deleted.has(index)) deleted.set(index, values[i] & State.deleted);
        }
    }

    private captureOperationBaseline(op: PaintLayerOp) {
        if (op.op instanceof PaintStrokeOp) {
            this.captureColors(op.op.splat, op.op.indices, op.op.before);
        } else if (op.op instanceof DecalSubdividePaintOp) {
            this.captureColors(op.op.splat, op.op.paintIndices, op.op.beforePaint);
            this.captureDeleted(op.op.splat, op.op.structuralIndices, op.op.beforeStates);
        }
    }

    private registerOperation(op: PaintLayerOp, applied = false) {
        if (this.operationApplied.has(op)) return op;
        const owner = op.splat instanceof Splat ? op.splat : this.baseSplat;
        this.ensureLayer(op.layerId, owner);
        this.operations.push(op);
        this.operationApplied.set(op, applied);
        this.captureOperationBaseline(op);
        return op;
    }

    private unregisterOperation(op: PaintLayerOp) {
        const index = this.operations.indexOf(op);
        if (index !== -1) this.operations.splice(index, 1);
        this.operationApplied.delete(op);
        if (this.operations.length === 0) this.baselines.clear();
    }

    private async setOperationApplied(op: PaintLayerOp, applied: boolean) {
        if (!this.operationApplied.has(op)) this.registerOperation(op, false);
        this.operationApplied.set(op, applied);
        if (!this.restoring) await this.recompose();
    }

    private composeLayerColors(
        work: LayerColorWork,
        layerId: string,
        splat: Splat,
        indices: Uint32Array,
        colors: Float32Array | null,
        fallback: Float32Array
    ) {
        let splatWork = work.get(layerId);
        if (!splatWork) {
            splatWork = new Map();
            work.set(layerId, splatWork);
        }
        let values = splatWork.get(splat);
        if (!values) {
            values = new Map();
            splatWork.set(splat, values);
        }
        for (let i = 0; i < indices.length; ++i) {
            const index = indices[i];
            const current = values.get(index) ?? [0, 0, 0, 0];
            if (!colors) {
                const value = i * 3;
                values.set(index, [
                    clamp01(dcDecode(fallback[value])),
                    clamp01(dcDecode(fallback[value + 1])),
                    clamp01(dcDecode(fallback[value + 2])),
                    1
                ]);
                continue;
            }

            const color = i * 4;
            values.set(index, accumulatePaintLayerRgba(current, colors, color));
        }
    }

    private eraseLayerColors(
        work: LayerColorWork,
        layerId: string,
        splat: Splat,
        indices: Uint32Array,
        strengths: Float32Array
    ) {
        const values = work.get(layerId)?.get(splat);
        if (!values) return;

        for (let i = 0; i < indices.length; ++i) {
            const index = indices[i];
            const current = values.get(index);
            if (!current) continue;
            const erased = erasePaintLayerRgba(current, strengths[i]);
            if (erased[3] <= 0) {
                values.delete(index);
            } else {
                values.set(index, erased);
            }
        }
    }

    private async recompose() {
        const colorWork = new Map<Splat, Map<number, ColorValue>>();
        const layerColorWork: LayerColorWork = new Map();
        const deletedWork = new Map<Splat, Map<number, number>>();
        for (const [splat, baseline] of this.baselines) {
            colorWork.set(splat, new Map(Array.from(baseline.colors, ([index, color]) => [index, [...color] as ColorValue])));
            deletedWork.set(splat, new Map(baseline.deleted));
        }

        for (let i = this.operations.length - 1; i >= 0; --i) {
            const inner = this.operations[i].op;
            if (inner instanceof DecalSubdividePaintOp && inner.splat.scene) {
                applySubdivisionGroups(this.events, inner.splat, inner.groupChanges, false);
            }
        }

        for (const operation of this.operations) {
            const layer = this.getLayer(operation.layerId);
            if (!this.operationApplied.get(operation) || !layer || layer.deleted || !layer.visible) continue;
            const inner = operation.op;
            if (inner instanceof PaintStrokeOp) {
                this.composeLayerColors(layerColorWork, layer.id, inner.splat, inner.indices, inner.colors, inner.after);
            } else if (inner instanceof PaintEraseOp) {
                this.eraseLayerColors(layerColorWork, layer.id, inner.splat, inner.indices, inner.strengths);
            } else if (inner instanceof DecalSubdividePaintOp) {
                const states = deletedWork.get(inner.splat);
                if (states) {
                    for (let i = 0; i < inner.structuralIndices.length; ++i) {
                        states.set(inner.structuralIndices[i], inner.afterStates[i] & State.deleted);
                    }
                }
                this.composeLayerColors(
                    layerColorWork,
                    layer.id,
                    inner.splat,
                    inner.paintIndices,
                    inner.paintColors,
                    inner.afterPaint
                );
                if (inner.splat.scene) applySubdivisionGroups(this.events, inner.splat, inner.groupChanges, true);
            }
        }

        // The array is stored in visual order (top to bottom). Composite in
        // reverse so each upper layer uses the complete result beneath it as
        // its backdrop.
        for (let layerIndex = this.layers.length - 1; layerIndex >= 0; --layerIndex) {
            const layer = this.layers[layerIndex];
            if (layer.deleted || !layer.visible || layer.opacity <= 0) continue;
            const splatWork = layerColorWork.get(layer.id);
            if (!splatWork) continue;

            for (const [splat, values] of splatWork) {
                const output = colorWork.get(splat);
                if (!output) continue;
                for (const [index, premultiplied] of values) {
                    const backdropDc = output.get(index);
                    const alpha = premultiplied[3];
                    if (!backdropDc || alpha <= 0) continue;
                    const source: ColorValue = [
                        premultiplied[0] / alpha,
                        premultiplied[1] / alpha,
                        premultiplied[2] / alpha
                    ];
                    const composited = compositePaintLayerRgb([
                        dcDecode(backdropDc[0]),
                        dcDecode(backdropDc[1]),
                        dcDecode(backdropDc[2])
                    ], source, alpha, layer.blendMode, layer.opacity);
                    output.set(index, [
                        dcEncode(composited[0]),
                        dcEncode(composited[1]),
                        dcEncode(composited[2])
                    ]);
                }
            }
        }

        for (const [splat, values] of colorWork) {
            if (!splat.scene || values.size === 0) continue;
            const indices = new Uint32Array(values.size);
            const colors = new Float32Array(values.size * 3);
            let write = 0;
            for (const [index, color] of values) {
                indices[write] = index;
                colors[write * 3] = color[0];
                colors[write * 3 + 1] = color[1];
                colors[write * 3 + 2] = color[2];
                write++;
            }
            splat.applyPaintValues(indices, colors);
        }

        for (const [splat, values] of deletedWork) {
            if (!splat.scene || values.size === 0) continue;
            const indices = new Uint32Array(values.size);
            const states = new Uint8Array(values.size);
            let write = 0;
            for (const [index, deleted] of values) {
                indices[write] = index;
                const current = splat.state.data[index] ?? 0;
                states[write] = (current & ~State.deleted) | deleted;
                write++;
            }
            await splat.applyStateValues(indices, states);
        }

        for (const [splat, layerId] of this.attachedSplats) {
            const layer = this.getLayer(layerId);
            if (splat.scene && layer) {
                splat.visible = !layer.deleted && layer.visible;
                splat.paintLayerOpacity = layer.opacity;
            }
        }
    }

    private serialize(): PaintLayersDocument {
        const splats = (this.events.invoke('scene.allSplats') ?? []) as Splat[];
        const attached = Array.from(this.attachedSplats, ([splat, layerId]) => ({
            splatIndex: splats.indexOf(splat),
            layerId
        })).filter(entry => entry.splatIndex >= 0);
        const groups = splats.map((splat, splatIndex) => ({
            splatIndex,
            activeLayerId: this.getActiveLayerId(splat),
            layers: this.getOwnedLayers(splat).map(layer => ({ ...layer }))
        })).filter(group => group.layers.length > 0);
        return {
            version: 3,
            groups,
            splats: attached
        };
    }

    private deserialize(data: PaintLayersDocument | null | undefined, splats: Splat[]) {
        this.operations = [];
        this.operationApplied.clear();
        this.baselines.clear();
        this.attachedSplats.clear();
        this.layers = [];
        this.layerOwners.clear();
        this.activeLayerIds.clear();
        this.nextLayerIdNumber = 1;
        this.restoring = true;

        const ids = new Set<string>();
        const restoreGroup = (owner: Splat, sources: PaintLayer[], activeLayerId: string) => {
            for (const source of sources) {
                if (!source?.id || ids.has(source.id)) continue;
                ids.add(source.id);
                const layer = {
                    id: source.id,
                    name: source.name || `${localize('paint.layers.layer')} ${this.getOwnedLayers(owner).length + 1}`,
                    visible: source.visible !== false,
                    blendMode: isPaintBlendMode(source.blendMode) ? source.blendMode : 'normal',
                    opacity: Number.isFinite(source.opacity) ? clamp01(source.opacity) : 1,
                    deleted: source.deleted === true
                } satisfies PaintLayer;
                this.layers.push(layer);
                this.layerOwners.set(layer.id, owner);
                const match = /paint-layer-(\d+)/.exec(source.id);
                if (match) this.nextLayerIdNumber = Math.max(this.nextLayerIdNumber, Number(match[1]) + 1);
            }

            const savedActive = this.getLayer(activeLayerId);
            const firstVisible = this.getOwnedLayers(owner, false)[0];
            if (savedActive && this.layerOwners.get(savedActive.id) === owner && !savedActive.deleted) {
                this.activeLayerIds.set(owner, savedActive.id);
            } else if (firstVisible) {
                this.activeLayerIds.set(owner, firstVisible.id);
            }
        };

        if (data?.version >= 3 && data.groups?.length) {
            for (const group of data.groups) {
                const owner = splats[group.splatIndex];
                if (!owner || !Array.isArray(group.layers)) continue;
                restoreGroup(owner, group.layers, group.activeLayerId);
            }
        } else if (data?.layers?.length && splats.length > 0) {
            // Legacy projects had one global stack. Associate it with the
            // selected source Gaussian; all other files receive a fresh,
            // independent stack below.
            const attachedIndices = new Set((data.splats ?? []).map(entry => entry.splatIndex));
            const selectedIndex = this.baseSplat ? splats.indexOf(this.baseSplat) : -1;
            const selected = selectedIndex >= 0 && !attachedIndices.has(selectedIndex) ? this.baseSplat : null;
            const owner = selected ?? splats.find((_splat, index) => !attachedIndices.has(index)) ?? splats[0];
            // Version 1 appended new layers and therefore stored them bottom
            // first. Version 2 stores the same top-to-bottom order as the UI.
            const sources = data.version >= 2 ? data.layers : [...data.layers].reverse();
            restoreGroup(owner, sources, data.activeLayerId ?? '');
        }

        // Every Gaussian owns a layer stack, even if it was never selected in
        // an older project or its saved group was invalid.
        for (const splat of splats) this.ensureSplatLayers(splat);

        for (const entry of data?.splats ?? []) {
            const splat = splats[entry.splatIndex];
            if (splat && this.getLayer(entry.layerId)) this.attachedSplats.set(splat, entry.layerId);
        }
        this.dirty = false;
        this.fireChanged();
    }

    private async finishRestore() {
        this.restoring = false;
        await this.recompose();
        this.dirty = false;
    }

    private reset(notify = true) {
        this.layers = [];
        this.layerOwners.clear();
        this.activeLayerIds.clear();
        this.nextLayerIdNumber = 1;
        this.operations = [];
        this.operationApplied.clear();
        this.baselines.clear();
        this.attachedSplats.clear();
        this.baseSplat = null;
        this.restoring = false;
        this.dirty = false;
        this.recomposeRevision = 0;
        this.recomposeQueued = false;
        if (notify) this.fireChanged();
    }

    private fireChanged() {
        this.events.fire('paint.layers.changed', this.getLayers(), this.getActiveLayerId());
    }
}

export { PaintLayerManager };
export type { PaintLayer, PaintLayersDocument };
