import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_LINEAR,
    FILTER_NEAREST,
    PIXELFORMAT_R8,
    PIXELFORMAT_RGBA8,
    PIXELFORMAT_R16U,
    Asset,
    BoundingBox,
    Color,
    Entity,
    GSplatData,
    GSplatResource,
    Mat4,
    Quat,
    Texture,
    Vec3
} from 'playcanvas';

import { BlockingPlane } from './blocking-plane';
import { BoxShape } from './box-shape';
import { HSL_CENTERS_F32, HSL_HALF_WIDTHS_F32 } from './color-grade';
import { Element, ElementType } from './element';
import { IndexRanges } from './index-ranges';
import { LodEditLog } from './lod-edit-log';
import { GaussianLUT } from './lut';
import { Serializer } from './serializer';
import { vertexShader, fragmentShader, gsplatCenter } from './shaders/splat-shader';
import { SphereShape } from './sphere-shape';
import { State, SplatState } from './splat-state';
import { Transform } from './transform';
import { TransformPalette } from './transform-palette';

const vec = new Vec3();
const veca = new Vec3();
const vecb = new Vec3();

const boundingPoints =
    [-1, 1].map((x) => {
        return [-1, 1].map((y) => {
            return [-1, 1].map((z) => {
                return [
                    new Vec3(x, y, z), new Vec3(x * 0.75, y, z),
                    new Vec3(x, y, z), new Vec3(x, y * 0.75, z),
                    new Vec3(x, y, z), new Vec3(x, y, z * 0.75)
                ];
            });
        });
    }).flat(3);

class Splat extends Element {
    asset: Asset;
    splatData: GSplatData;
    numSplats = 0;
    numDeleted = 0;
    numLocked = 0;
    numSelected = 0;
    entity: Entity;
    changedCounter = 0;
    stateTexture: Texture;
    // encapsulates per-splat state mirror (cpu Uint8Array + gpu Texture).
    // all writes go through state.setBits/clearBits/toggleBits, then flush().
    state: SplatState;
    transformTexture: Texture;
    // transient viewport-only visibility mask for point-cloud-group solo:
    // texel value 255 = visible, 0 = hidden. Never persisted to disk.
    soloMaskData: Uint8Array;
    soloMaskTexture: Texture;
    // transient viewport-only desaturation mask for point-cloud-group edit:
    // texel value 255 = desaturated (grey), 0 = normal. Never persisted.
    desaturateMaskData: Uint8Array;
    desaturateMaskTexture: Texture;
    selectionBoundStorage: BoundingBox;
    localBoundStorage: BoundingBox;
    worldBoundStorage: BoundingBox;

    _visible = true;
    transformPalette: TransformPalette;

    selectionAlpha = 1;

    _name = '';
    _tintClr = new Color(1, 1, 1);
    _temperature = 0;
    _saturation = 1;
    _brightness = 0;
    _blackPoint = 0;
    _whitePoint = 1;
    _transparency = 1;
    // HSL mixer: 8 color ranges × 3 adjustments (hue/sat/light), normalized
    // hue shifts in [-0.5, 0.5] (i.e. ±180°), sat/light shifts in [-1, 1]
    _hslHueShifts = new Float32Array(8);
    _hslSatShifts = new Float32Array(8);
    _hslLightShifts = new Float32Array(8);
    _hslDefineActive = false;

    // LUT color grading: per-splat 16^3 3D LUT + intensity (0..1, 0 = off)
    _lut: GaussianLUT | null = null;
    _lutIntensity = 1;
    _lutTexture: Texture | null = null;
    _lutDefineActive = false;
    _lutVersion = 0;  // bumped on lut change so serialize() detects it for re-render

    originalFilePath: string | null = null;

    // LCC multi-LOD editing: when non-null, this splat was imported from a
    // multi-LOD LCC file. lodEditLog records spatial ops (select/delete/transform)
    // as world-space voxel bitmaps so they can be replayed on other LODs during
    // LOD switch or LCC2 export. lccFileSystem is a runtime-only reference (not
    // serialized) used by loadLodDataTable to stream other LODs.
    lccFilePath: string | null = null;
    lccFileSystem: any = null;  // ReadFileSystem (runtime only)
    lodCounts: number[] = [];
    currentLodIndex = 0;
    lodEditLog: LodEditLog | null = null;

    // Save-dirty tracking: incremented on any change that affects PLY output
    // (transform, color properties, state). Compared against _savedDirtyVersion
    // to decide whether to reuse cached serialized data.
    _saveDirtyVersion = 1;
    _savedDirtyVersion = 0;

    markSaveDirty() {
        this._saveDirtyVersion++;
    }
    isSaveDirty() {
        return this._saveDirtyVersion !== this._savedDirtyVersion;
    }
    markSaveClean() {
        this._savedDirtyVersion = this._saveDirtyVersion;
    }

    measurePoints: Vec3[] = [];
    measureSelection = -1;

    // orient tool: user-picked surface points defining a plane
    orientPoints: Vec3[] = [];
    orientSelection = -1;

    // user-defined local frame (relative to the data frame), set from the
    // orient tool's picked plane: origin at the first picked point, rotation
    // aligning +y with the plane normal. the transform gizmos and panel use
    // it as the model's local coordinate space; the gaussian data is unaffected.
    localFrameOrigin = new Vec3();
    localFrame = new Quat();

    rebuildMaterial: (bands: number) => void;

    constructor(asset: Asset, rotation: Quat) {
        super(ElementType.splat);

        const splatResource = asset.resource as GSplatResource;
        const splatData = splatResource.gsplatData;
        const { device } = splatResource;

        this._name = (asset.file as any).filename;
        this.asset = asset;
        this.splatData = splatData as GSplatData;
        this.numSplats = splatData.numSplats;

        this.entity = new Entity('splatEntitiy');
        this.entity.setLocalRotation(rotation);
        this.entity.addComponent('gsplat', { asset });

        const instance = this.entity.gsplat.instance;

        // added per-splat state channel
        // bit 1: selected
        // bit 2: deleted
        // bit 3: locked
        if (!this.splatData.getProp('state')) {
            this.splatData.getElement('vertex').properties.push({
                type: 'uchar',
                name: 'state',
                storage: new Uint8Array(this.splatData.numSplats),
                byteSize: 1
            });
        }

        // per-splat transform matrix
        this.splatData.getElement('vertex').properties.push({
            type: 'ushort',
            name: 'transform',
            storage: new Uint16Array(this.splatData.numSplats),
            byteSize: 2
        });

        const { x: width, y: height } = (splatResource as any).textureDimensions;

        // pack spherical harmonic data
        const createTexture = (name: string, format: number) => {
            return new Texture(device, {
                name: name,
                width: width,
                height: height,
                format: format,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
        };

        // create the state texture and the SplatState mirror that owns it.
        // splatData.getProp('state') aliases state.data so existing read-only
        // consumers (serialize, status-bar, etc) keep working unchanged.
        this.stateTexture = createTexture('splatState', PIXELFORMAT_R8);
        this.state = new SplatState(this.splatData.getProp('state') as Uint8Array, this.stateTexture);
        this.transformTexture = createTexture('splatTransform', PIXELFORMAT_R16U);

        // solo mask texture: same layout as the state texture, default all-visible.
        this.soloMaskTexture = createTexture('soloMask', PIXELFORMAT_R8);
        const maskBuffer = this.soloMaskTexture.lock() as Uint8Array;
        maskBuffer.fill(255);
        this.soloMaskTexture.unlock();
        this.soloMaskData = new Uint8Array(this.splatData.numSplats);

        // desaturate mask texture: default all-normal (no desaturation).
        this.desaturateMaskTexture = createTexture('desaturateMask', PIXELFORMAT_R8);
        const desatBuffer = this.desaturateMaskTexture.lock() as Uint8Array;
        desatBuffer.fill(0);
        this.desaturateMaskTexture.unlock();
        this.desaturateMaskData = new Uint8Array(this.splatData.numSplats);

        // create the transform palette
        this.transformPalette = new TransformPalette(device);

        this.rebuildMaterial = (bands: number) => {
            const { material } = instance;
            const { glsl } = material.shaderChunks;
            glsl.set('gsplatVS', vertexShader);
            glsl.set('gsplatPS', fragmentShader);
            glsl.set('gsplatCenterVS', gsplatCenter);

            material.setDefine('SH_BANDS', `${Math.min(bands, (instance.resource as GSplatResource).shBands)}`);
            material.setParameter('splatState', this.stateTexture);
            material.setParameter('splatTransform', this.transformTexture);
            material.setParameter('soloMask', this.soloMaskTexture);
            material.setParameter('desaturateMask', this.desaturateMaskTexture);
            material.update();
        };

        this.selectionBoundStorage = new BoundingBox();
        this.localBoundStorage = instance.resource.aabb;
        // @ts-ignore
        this.worldBoundStorage = instance.meshInstance._aabb;

        // @ts-ignore
        instance.meshInstance._updateAabb = false;

        // when sort changes, re-render the scene
        instance.sorter.on('updated', () => {
            this.changedCounter++;
            if (this.scene) {
                this.scene.forceRender = true;
            }
        });
    }

    destroy() {
        super.destroy();
        if (this._lutTexture) {
            this._lutTexture.destroy();
            this._lutTexture = null;
        }
        this.soloMaskTexture.destroy();
        this.desaturateMaskTexture.destroy();
        this.entity.destroy();
        this.asset.registry.remove(this.asset);
        this.asset.unload();
    }

    async updateState(changedState = State.selected) {
        // uploads dirty range + refreshes counts in one pass.
        this.state.flush();
        this.numSplats = this.state.data.length - this.state.numDeleted;
        this.numLocked = this.state.numLocked;
        this.numSelected = this.state.numSelected;
        this.numDeleted = this.state.numDeleted;

        // handle splats being added or removed
        if (changedState & State.deleted) {
            await this.updateSorting();
        } else {
            await this.updateLocalBounds();
        }

        // Check if scene still exists after async operation (splat may have been removed)
        if (this.scene) {
            this.scene.forceRender = true;
            this.scene.events.fire('splat.stateChanged', this);
        }
    }

    // Point-cloud-group solo isolation (viewport only, not persisted).
    // `ranges` marks gaussians that remain visible; null/empty shows everything.
    setSoloMask(ranges: IndexRanges[] | null) {
        const data = this.soloMaskData;
        if (ranges && ranges.length > 0) {
            data.fill(0);
            for (const r of ranges) {
                r.forEach((i) => {
                    data[i] = 255;
                });
            }
        } else {
            data.fill(255);
        }
        const buffer = this.soloMaskTexture.lock() as Uint8Array;
        buffer.set(data);
        this.soloMaskTexture.unlock();
        if (this.scene) {
            this.scene.forceRender = true;
        }
    }

    // Point-cloud-group independent edit (viewport only, not persisted).
    // `ranges` marks gaussians that keep their color; every other gaussian is
    // desaturated (saturation -> 0). null/empty restores normal saturation.
    setDesaturateMask(ranges: IndexRanges[] | null) {
        const data = this.desaturateMaskData;
        if (ranges && ranges.length > 0) {
            data.fill(255);
            for (const r of ranges) {
                r.forEach((i) => {
                    data[i] = 0;
                });
            }
        } else {
            data.fill(0);
        }
        const buffer = this.desaturateMaskTexture.lock() as Uint8Array;
        buffer.set(data);
        this.desaturateMaskTexture.unlock();
        if (this.scene) {
            this.scene.forceRender = true;
        }
    }

    async updatePositions() {
        const data = await this.scene.dataProcessor.calcPositions(this);

        // update the splat centers which are used for render-time sorting
        const state = this.splatData.getProp('state') as Uint8Array;
        const { sorter } = this.entity.gsplat.instance;
        const { centers } = sorter;
        for (let i = 0; i < this.splatData.numSplats; ++i) {
            if (state[i] === State.selected) {
                centers[i * 3 + 0] = data[i * 4];
                centers[i * 3 + 1] = data[i * 4 + 1];
                centers[i * 3 + 2] = data[i * 4 + 2];
            }
        }

        await this.updateSorting();

        // Check if scene still exists after async operation (splat may have been removed)
        if (this.scene) {
            this.scene.forceRender = true;
            this.scene.events.fire('splat.positionsChanged', this);
        }
    }

    async updateSorting(skipBounds = false) {
        const state = this.splatData.getProp('state') as Uint8Array;

        let mapping: Uint32Array;

        // create a sorter mapping to remove deleted splats
        if (this.numSplats !== state.length) {
            mapping = new Uint32Array(this.numSplats);
            let idx = 0;
            for (let i = 0; i < state.length; ++i) {
                if ((state[i] & State.deleted) === 0) {
                    mapping[idx++] = i;
                }
            }
        } else {
            // Explicit identity mapping: setMapping(null) may leave stale
            // state in the worker, preventing deleted points from reappearing.
            mapping = new Uint32Array(this.numSplats);
            for (let i = 0; i < this.numSplats; i++) {
                mapping[i] = i;
            }
        }

        // update sorting instance
        this.entity.gsplat.instance.sorter.setMapping(mapping);

        // recalculate bounds after sorting changes
        if (!skipBounds) {
            await this.updateLocalBounds();
        }
    }

    get worldTransform() {
        return this.entity.getWorldTransform();
    }

    set name(newName: string) {
        if (newName !== this.name) {
            this._name = newName;
            if (this.scene) {
                this.scene.events.fire('splat.name', this);
            }
        }
    }

    get name() {
        return this._name;
    }

    get filename() {
        return (this.asset.file as any).filename;
    }

    calcSplatWorldPosition(splatId: number, result: Vec3) {
        if (splatId >= this.splatData.numSplats) {
            return false;
        }

        // use centers data, which are updated when edits occur
        const { sorter } = this.entity.gsplat.instance;
        const { centers } = sorter;

        result.set(
            centers[splatId * 3 + 0],
            centers[splatId * 3 + 1],
            centers[splatId * 3 + 2]
        );

        this.worldTransform.transformPoint(result, result);

        return true;
    }

    async add() {
        // add the entity to the scene
        this.scene.contentRoot.addChild(this.entity);

        // assign splat to the dedicated splat layer (rendered by splat camera with MRT)
        this.entity.gsplat.layers = [this.scene.splatLayer.id];

        this.scene.events.on('view.bands', this.rebuildMaterial, this);
        this.rebuildMaterial(this.scene.events.invoke('view.bands'));

        // we must update state in case the state data was loaded from ply
        await this.updateState();
    }

    remove() {
        this.scene.events.off('view.bands', this.rebuildMaterial, this);

        this.scene.contentRoot.removeChild(this.entity);
        this.scene.boundDirty = true;
    }

    serialize(serializer: Serializer) {
        serializer.packa(this.entity.getWorldTransform().data);
        serializer.pack(this.changedCounter);
        serializer.pack(this.visible);
        serializer.pack(this.tintClr.r, this.tintClr.g, this.tintClr.b);
        serializer.pack(this.temperature, this.saturation, this.brightness, this.blackPoint, this.whitePoint, this.transparency);
        serializer.packa(Array.from(this._hslHueShifts));
        serializer.packa(Array.from(this._hslSatShifts));
        serializer.packa(Array.from(this._hslLightShifts));
        serializer.pack(this._lutVersion, this._lutIntensity);
    }

    onPreRender() {
        const events = this.scene.events;
        const isSceneSelection = events.invoke('splatSelection') === this;
        const hasSelectedGaussians = this.numSelected > 0;
        const renderOverlays = this.scene.camera.renderOverlays;
        const hasSelection = isSceneSelection || hasSelectedGaussians;
        const selected = renderOverlays && hasSelection;
        const cameraMode = events.invoke('camera.mode');

        // configure rings rendering - rings show whenever there's a selection, regardless of overlay
        const material = this.entity.gsplat.instance.material;
        material.setParameter('outlineMode', events.invoke('view.outlineSelection') ? 1 : 0);
        material.setParameter('ringSize', (hasSelection && cameraMode === 'rings') ? 0.04 : 0);

        // configure colors
        const selectedClr = events.invoke('selectedClr');
        const unselectedClr = events.invoke('unselectedClr');
        const lockedClr = events.invoke('lockedClr');

        if (!selected) {
            material.setParameter('selectedClr', [0, 0, 0, 0]);
        } else if (events.invoke('view.outlineSelection')) {
            material.setParameter('selectedClr', [0, 0, 0, 0]);
        } else {
            material.setParameter('selectedClr', [selectedClr.r, selectedClr.g, selectedClr.b, selectedClr.a * this.selectionAlpha]);
        }
        material.setParameter('unselectedClr', [unselectedClr.r, unselectedClr.g, unselectedClr.b, unselectedClr.a]);
        material.setParameter('lockedClr', [lockedClr.r, lockedClr.g, lockedClr.b, lockedClr.a]);

        // combine black pointer, white point and brightness
        const offset = -this.blackPoint + this.brightness;
        const scale = 1 / (this.whitePoint - this.blackPoint);

        material.setParameter('clrOffset', [offset, offset, offset]);
        material.setParameter('clrScale', [
            scale * this.tintClr.r * (1 + this.temperature),
            scale * this.tintClr.g,
            scale * this.tintClr.b * (1 - this.temperature),
            this.transparency
        ]);

        material.setParameter('saturation', this.saturation);
        material.setParameter('transformPalette', this.transformPalette.texture);

        // HSL mixer parameters
        const hasHsl = this.hasHslShift();
        if (hasHsl !== this._hslDefineActive) {
            material.setDefine('HSL_MIXER', hasHsl ? '1' : '0');
            material.update();              // 消费 _definesDirty → clearVariants → 着色器重编译
            this._hslDefineActive = hasHsl;
        }
        if (hasHsl) {
            // NOTE: PlayCanvas registers array uniforms under 'name[0]' (getActiveUniform
            // returns the [0]-suffixed name), so setParameter must use the [0] suffix to
            // match the shader input's scopeId. See standard-material.js ambientSH[0].
            material.setParameter('hslCenters[0]', HSL_CENTERS_F32);
            material.setParameter('hslHalfWidths[0]', HSL_HALF_WIDTHS_F32);
            material.setParameter('hslHueShifts[0]', this._hslHueShifts);
            material.setParameter('hslSatShifts[0]', this._hslSatShifts);
            material.setParameter('hslLightShifts[0]', this._hslLightShifts);
        }

        // LUT color grading parameters
        const hasLut = !!this._lut && this._lutIntensity > 0;
        if (hasLut !== this._lutDefineActive) {
            console.warn(`[LUT] define transition: ${this._lutDefineActive} → ${hasLut} (lut=${!!this._lut}, intensity=${this._lutIntensity})`);
            material.setDefine('LUT_ENABLED', hasLut ? '1' : '0');
            material.update();
            this._lutDefineActive = hasLut;
        }
        if (hasLut) {
            const lutTex = this.loadLutTexture();
            if (lutTex) {
                material.setParameter('lutTexture', lutTex);
                material.setParameter('lutIntensity', this._lutIntensity);
            } else {
                console.warn('[LUT] hasLut=true but loadLutTexture returned null');
            }
        }

        // Set display mode
        const displayMode = events.invoke('view.displayMode') || 'color';
        material.setParameter('displayMode', displayMode === 'depth' ? 1 : 0);

        // Set camera near and far for depth mode
        material.setParameter('near_clip', this.scene.camera.near);
        material.setParameter('far_clip', this.scene.camera.far);

        // Set depth cycle length for depth mode
        material.setParameter('depthCycleLength', events.invoke('view.depthCycleLength') || 50);

        if (this.visible && selected) {
            // render bounding box (use selection bound only when a point-cloud group is active)
            if (events.invoke('camera.bound')) {
                // Hide bounds when gizmo is controlling a shape
                const gizmoTarget = events.invoke('selection');
                const gizmoOnShape = gizmoTarget instanceof BoxShape ||
                    gizmoTarget instanceof SphereShape ||
                    gizmoTarget instanceof BlockingPlane;
                if (!gizmoOnShape) {
                    const groupActive = events.invoke('pointCloudGroup.activeGroup') as boolean;
                    const bound = (groupActive && this.numSelected > 0) ? this.selectionBound : this.localBound;
                    const scale = new Mat4().setTRS(bound.center, Quat.IDENTITY, bound.halfExtents);
                    scale.mul2(this.entity.getWorldTransform(), scale);

                    for (let i = 0; i < boundingPoints.length / 2; i++) {
                        const a = boundingPoints[i * 2];
                        const b = boundingPoints[i * 2 + 1];
                        scale.transformPoint(a, veca);
                        scale.transformPoint(b, vecb);

                        this.scene.app.drawLine(veca, vecb, Color.WHITE, true, this.scene.worldLayer);
                    }
                }
            }
        }

        this.entity.enabled = this.visible;
    }

    focalPoint() {
        // GSplatData has a function for calculating an weighted average of the splat positions
        // to get a focal point for the camera, but we use bound center instead
        return this.worldBound.center;
    }

    move(position?: Vec3, rotation?: Quat, scale?: Vec3) {
        const entity = this.entity;
        if (position) {
            entity.setLocalPosition(position);
        }
        if (rotation) {
            entity.setLocalRotation(rotation);
        }
        if (scale) {
            entity.setLocalScale(scale);
        }

        this.markSaveDirty();
        this.updateWorldBound();

        if (this.scene) {
            this.scene.events.fire('splat.moved', this);
        }
    }

    // calculate both selection and local bounds (async, callers must await)
    async updateLocalBounds(): Promise<void> {
        await this.scene.dataProcessor.calcBound(this, this.selectionBoundStorage, this.localBoundStorage);
        // Check if scene still exists after async operation (splat may have been removed)
        if (this.scene) {
            this.updateWorldBound();
        }
    }

    // update world bound from local bound (synchronous)
    private updateWorldBound() {
        this.worldBoundStorage.setFromTransformedAabb(this.localBoundStorage, this.entity.getWorldTransform());
        if (this.scene) {
            this.scene.boundDirty = true;
        }
    }

    // get the selection bound
    get selectionBound() {
        return this.selectionBoundStorage;
    }

    // get local space bound
    get localBound() {
        return this.localBoundStorage;
    }

    // get world space bound
    get worldBound() {
        return this.worldBoundStorage;
    }

    set visible(value: boolean) {
        if (value !== this.visible) {
            this._visible = value;
            this.scene?.events.fire('splat.visibility', this);
        }
    }

    get visible() {
        return this._visible;
    }

    set tintClr(value: Color) {
        if (!this._tintClr.equals(value)) {
            this._tintClr.set(value.r, value.g, value.b);
            this.markSaveDirty();
            this.scene.events.fire('splat.tintClr', this);
        }
    }

    get tintClr() {
        return this._tintClr;
    }

    set temperature(value: number) {
        if (value !== this._temperature) {
            this._temperature = value;
            this.markSaveDirty();
            this.scene.events.fire('splat.temperature', this);
        }
    }

    get temperature() {
        return this._temperature;
    }

    set saturation(value: number) {
        if (value !== this._saturation) {
            this._saturation = value;
            this.markSaveDirty();
            this.scene.events.fire('splat.saturation', this);
        }
    }

    get saturation() {
        return this._saturation;
    }

    set brightness(value: number) {
        if (value !== this._brightness) {
            this._brightness = value;
            this.markSaveDirty();
            this.scene.events.fire('splat.brightness', this);
        }
    }

    get brightness() {
        return this._brightness;
    }

    set blackPoint(value: number) {
        if (value !== this._blackPoint) {
            this._blackPoint = value;
            this.markSaveDirty();
            this.scene.events.fire('splat.blackPoint', this);
        }
    }

    get blackPoint() {
        return this._blackPoint;
    }

    set whitePoint(value: number) {
        if (value !== this._whitePoint) {
            this._whitePoint = value;
            this.markSaveDirty();
            this.scene.events.fire('splat.whitePoint', this);
        }
    }

    get whitePoint() {
        return this._whitePoint;
    }

    set transparency(value: number) {
        if (value !== this._transparency) {
            this._transparency = value;
            this.markSaveDirty();
            this.scene.events.fire('splat.transparency', this);
        }
    }

    get transparency() {
        return this._transparency;
    }

    set hslHueShifts(value: Float32Array) {
        this._hslHueShifts.set(value);
        this.markSaveDirty();
        this.scene?.events.fire('splat.hslHueShifts', this);
    }

    get hslHueShifts() {
        return this._hslHueShifts;
    }

    set hslSatShifts(value: Float32Array) {
        this._hslSatShifts.set(value);
        this.markSaveDirty();
        this.scene?.events.fire('splat.hslSatShifts', this);
    }

    get hslSatShifts() {
        return this._hslSatShifts;
    }

    set hslLightShifts(value: Float32Array) {
        this._hslLightShifts.set(value);
        this.markSaveDirty();
        this.scene?.events.fire('splat.hslLightShifts', this);
    }

    get hslLightShifts() {
        return this._hslLightShifts;
    }

    set lut(value: GaussianLUT | null) {
        if (value === this._lut) return;
        this._lut = value;
        this._lutVersion++;
        // invalidate cached GPU texture so it rebuilds from new data
        if (this._lutTexture) {
            this._lutTexture.destroy();
            this._lutTexture = null;
        }
        this.markSaveDirty();
        this.scene?.events.fire('splat.lut', this);
    }

    get lut() {
        return this._lut;
    }

    set lutIntensity(value: number) {
        if (value !== this._lutIntensity) {
            this._lutIntensity = value;
            this.markSaveDirty();
            this.scene?.events.fire('splat.lutIntensity', this);
        }
    }

    get lutIntensity() {
        return this._lutIntensity;
    }

    // Build (or reuse) a 256x16 RGBA8 GPU texture from the LUT's pixel data.
    // LINEAR filtering + half-texel inset in the shader prevents cross-slice bleed.
    private loadLutTexture(): Texture | null {
        if (!this._lut) return null;
        if (this._lutTexture) return this._lutTexture;
        const { device } = this.entity.gsplat.instance.resource as GSplatResource;
        const tex = new Texture(device, {
            name: 'lutTexture',
            width: 256,
            height: 16,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        // upload pixels via a canvas source
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 16;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            tex.destroy();
            return null;
        }
        const imgData = ctx.createImageData(256, 16);
        imgData.data.set(this._lut.data);
        ctx.putImageData(imgData, 0, 0);
        tex.setSource(canvas);
        this._lutTexture = tex;
        return tex;
    }

    hasHslShift() {
        for (let i = 0; i < 8; i++) {
            if (this._hslHueShifts[i] !== 0 || this._hslSatShifts[i] !== 0 || this._hslLightShifts[i] !== 0) {
                return true;
            }
        }
        return false;
    }

    // get pivot position/rotation/scale (caller should have awaited operation that changed data)
    getPivot(mode: 'center' | 'boundCenter', selection: boolean, result: Transform) {
        const { entity } = this;
        switch (mode) {
            case 'center':
                result.set(entity.getLocalPosition(), entity.getLocalRotation(), entity.getLocalScale());
                break;
            case 'boundCenter': {
                const bound = selection ? this.selectionBound : this.localBound;
                entity.getLocalTransform().transformPoint(bound.center, vec);
                result.set(vec, entity.getLocalRotation(), entity.getLocalScale());
                break;
            }
        }
    }

    setLocalFrame(origin: Vec3, rotation: Quat) {
        this.localFrameOrigin.copy(origin);
        this.localFrame.copy(rotation);
    }

    get hasLocalFrame() {
        return !this.localFrameOrigin.equals(Vec3.ZERO) || !this.localFrame.equals(Quat.IDENTITY);
    }

    docSerialize() {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];
        const pack4 = (q: Quat) => [q.x, q.y, q.z, q.w];
        const packC = (c: Color) => [c.r, c.g, c.b, c.a];
        return {
            name: this.name,
            position: pack3(this.entity.getLocalPosition()),
            rotation: pack4(this.entity.getLocalRotation()),
            scale: pack3(this.entity.getLocalScale()),
            localFrameOrigin: pack3(this.localFrameOrigin),
            localFrame: pack4(this.localFrame),
            visible: this.visible,
            tintClr: packC(this.tintClr),
            temperature: this.temperature,
            saturation: this.saturation,
            brightness: this.brightness,
            blackPoint: this.blackPoint,
            whitePoint: this.whitePoint,
            transparency: this.transparency,
            hslHueShifts: Array.from(this._hslHueShifts),
            hslSatShifts: Array.from(this._hslSatShifts),
            hslLightShifts: Array.from(this._hslLightShifts),
            originalFilePath: this.originalFilePath ?? null,
            lccFilePath: this.lccFilePath,
            lodCounts: this.lodCounts.length > 0 ? this.lodCounts : null,
            currentLodIndex: this.lodCounts.length > 0 ? this.currentLodIndex : null,
            lodEditLog: this.lodEditLog?.serialize() ?? null
        };
    }

    docDeserialize(doc: any) {
        const { name, position, rotation, scale, visible, tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency } = doc;

        this.name = name;
        this.move(new Vec3(position), new Quat(rotation), new Vec3(scale));
        this.localFrameOrigin = doc.localFrameOrigin ? new Vec3(doc.localFrameOrigin) : new Vec3();
        this.localFrame = doc.localFrame ? new Quat(doc.localFrame) : new Quat();
        this.visible = visible;
        this.tintClr = new Color(tintClr[0], tintClr[1], tintClr[2], tintClr[3]);
        this.temperature = temperature ?? 0;
        this.saturation = saturation ?? 1;
        this.brightness = brightness;
        this.blackPoint = blackPoint;
        this.whitePoint = whitePoint;
        this.transparency = transparency;
        this._hslHueShifts = new Float32Array(doc.hslHueShifts ?? [0, 0, 0, 0, 0, 0, 0, 0]);
        this._hslSatShifts = new Float32Array(doc.hslSatShifts ?? [0, 0, 0, 0, 0, 0, 0, 0]);
        this._hslLightShifts = new Float32Array(doc.hslLightShifts ?? [0, 0, 0, 0, 0, 0, 0, 0]);
        this.originalFilePath = doc.originalFilePath ?? null;
        // LCC multi-LOD metadata (null for non-LCC splats)
        this.lccFilePath = doc.lccFilePath ?? null;
        this.lodCounts = doc.lodCounts ?? [];
        this.currentLodIndex = doc.currentLodIndex ?? 0;
        if (doc.lodEditLog) {
            this.lodEditLog = new LodEditLog();
            this.lodEditLog.deserialize(doc.lodEditLog);
        }
    }
}

export { Splat };
