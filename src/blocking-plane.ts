import {
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_SRC_ALPHA,
    CULLFACE_NONE,
    BlendState,
    BoundingBox,
    Color,
    Entity,
    Mat4,
    Quat,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { Serializer } from './serializer';
import { Transform } from './transform';
import { vertexShader, fragmentShader } from './shaders/blocking-plane-shader';

class BlockingPlane extends Element {
    _sizeX = 4;
    _sizeY = 4;
    _color = new Color(0.2, 0.6, 1.0);
    pivot: Entity;
    material: ShaderMaterial;
    bound = new BoundingBox();
    invMat = new Mat4();

    constructor() {
        super(ElementType.debug);

        this.pivot = new Entity('blockingPlanePivot');
        this.pivot.addComponent('render', {
            type: 'plane'
        });
        this.pivot.setLocalScale(this._sizeX, 1, this._sizeY);
    }

    add() {
        const material = new ShaderMaterial({
            uniqueName: 'blockingPlane',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
        material.cull = CULLFACE_NONE;
        material.blendState = new BlendState(
            true,
            BLENDEQUATION_ADD, BLENDMODE_SRC_ALPHA, BLENDMODE_ONE_MINUS_SRC_ALPHA,
            BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA
        );
        material.update();

        this.pivot.render.meshInstances[0].material = material;
        this.pivot.render.meshInstances[0].cull = false;
        this.pivot.render.layers = [this.scene.worldLayer.id];

        this.material = material;

        this.scene.contentRoot.addChild(this.pivot);

        this.pivot.setLocalScale(this._sizeX, 1, this._sizeY);
        this.updateBound();
    }

    remove() {
        this.scene.contentRoot.removeChild(this.pivot);
        this.scene.boundDirty = true;
    }

    destroy() {
        if (this.scene) {
            this.scene.remove(this);
        }
    }

    serialize(serializer: Serializer): void {
        serializer.packa(this.pivot.getWorldTransform().data);
        serializer.pack(this.sizeX);
        serializer.pack(this.sizeY);
    }

    onPreRender() {
        this.invMat.copy(this.pivot.getWorldTransform()).invert();
        this.material.setParameter('matrix_model_inv', this.invMat.data);
        this.material.setParameter('shapeColor', [this._color.r, this._color.g, this._color.b]);

        const device = this.scene.graphicsDevice;
        device.scope.resolve('targetSize').setValue([device.width, device.height]);
    }

    moved() {
        this.updateBound();
    }

    get entity() {
        return this.pivot;
    }

    getPivot(_mode: string, _selection: boolean, result: Transform) {
        result.set(
            this.pivot.getLocalPosition(),
            this.pivot.getLocalRotation(),
            this.pivot.getLocalScale()
        );
    }

    move(position?: Vec3, rotation?: Quat, scale?: Vec3) {
        if (position) {
            this.pivot.setLocalPosition(position);
        }
        if (rotation) {
            this.pivot.setLocalRotation(rotation);
        }
        if (scale) {
            this.pivot.setLocalScale(scale);
            this._sizeX = scale.x;
            this._sizeY = scale.z;
        }
        this.updateBound();
        this.scene.events.fire('splat.moved', this);
    }

    updateBound() {
        this.bound.center.copy(this.pivot.getPosition());
        const s = this.pivot.getLocalScale();
        this.bound.halfExtents.set(s.x / 2, 0.01, s.z / 2);
        this.scene.boundDirty = true;
    }

    get worldBound(): BoundingBox | null {
        return this.bound;
    }

    set sizeX(sizeX: number) {
        this._sizeX = sizeX;
        this.pivot.setLocalScale(sizeX, this.pivot.getLocalScale().y, this.pivot.getLocalScale().z);
        this.updateBound();
    }

    get sizeX() {
        return this.pivot.getLocalScale().x;
    }

    set sizeY(sizeY: number) {
        this._sizeY = sizeY;
        this.pivot.setLocalScale(this.pivot.getLocalScale().x, this.pivot.getLocalScale().y, sizeY);
        this.updateBound();
    }

    get sizeY() {
        return this.pivot.getLocalScale().z;
    }

    set color(c: Color) {
        this._color.copy(c);
    }

    get color() {
        return this._color;
    }

    getPlaneNormal(): Vec3 {
        const worldTransform = this.pivot.getWorldTransform();
        const normal = new Vec3(0, 1, 0);
        return worldTransform.transformVector(normal);
    }

    getPlanePosition(): Vec3 {
        return this.pivot.getPosition();
    }
}

export { BlockingPlane };
