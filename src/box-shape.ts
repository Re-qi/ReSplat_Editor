import {
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_SRC_ALPHA,
    CULLFACE_FRONT,
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
import { vertexShader, fragmentShader } from './shaders/box-shape-shader';

class BoxShape extends Element {
    _lenX = 2;
    _lenY = 2;
    _lenZ = 2;
    _color = new Color(1, 1, 1);
    pivot: Entity;
    material: ShaderMaterial;
    bound = new BoundingBox();
    invMat = new Mat4();

    constructor() {
        super(ElementType.debug);

        this.pivot = new Entity('boxPivot');
        this.pivot.addComponent('render', {
            type: 'box'
        });
        this.pivot.setLocalScale(this._lenX, this._lenY, this._lenZ);
    }

    add() {
        const material = new ShaderMaterial({
            uniqueName: 'boxShape',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
        material.cull = CULLFACE_FRONT;
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

        this.pivot.setLocalScale(this._lenX, this._lenY, this._lenZ);
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
        serializer.pack(this.lenX);
        serializer.pack(this.lenY);
        serializer.pack(this.lenZ);
    }

    onPreRender() {
        // Pass inverse world matrix for local-space ray-box intersection
        this.invMat.copy(this.pivot.getWorldTransform()).invert();
        this.material.setParameter('matrix_model_inv', this.invMat.data);
        this.material.setParameter('shapeColor', [this._color.r, this._color.g, this._color.b]);

        const device = this.scene.graphicsDevice;
        device.scope.resolve('targetSize').setValue([device.width, device.height]);
    }

    moved() {
        this.updateBound();
    }

    // Alias for EntityTransformHandler compatibility
    get entity() {
        return this.pivot;
    }

    // Implementation for transform system compatibility
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
            // Sync internal fields so lenX/Y/Z getters and serialization stay consistent
            this._lenX = scale.x;
            this._lenY = scale.y;
            this._lenZ = scale.z;
        }
        this.updateBound();
        this.scene.events.fire('splat.moved', this);
    }

    updateBound() {
        this.bound.center.copy(this.pivot.getPosition());
        const s = this.pivot.getLocalScale();
        this.bound.halfExtents.set(s.x / 2, s.y / 2, s.z / 2);
        this.scene.boundDirty = true;
    }

    get worldBound(): BoundingBox | null {
        return this.bound;
    }

    set lenX(lenX: number) {
        this._lenX = lenX;
        this.pivot.setLocalScale(lenX, this.pivot.getLocalScale().y, this.pivot.getLocalScale().z);
        this.updateBound();
    }

    get lenX() {
        return this.pivot.getLocalScale().x;
    }

    set lenY(lenY: number) {
        this._lenY = lenY;
        this.pivot.setLocalScale(this.pivot.getLocalScale().x, lenY, this.pivot.getLocalScale().z);
        this.updateBound();
    }

    get lenY() {
        return this.pivot.getLocalScale().y;
    }

    set lenZ(lenZ: number) {
        this._lenZ = lenZ;
        this.pivot.setLocalScale(this.pivot.getLocalScale().x, this.pivot.getLocalScale().y, lenZ);
        this.updateBound();
    }

    get lenZ() {
        return this.pivot.getLocalScale().z;
    }

    set color(c: Color) {
        this._color.copy(c);
    }

    get color() {
        return this._color;
    }
}

export { BoxShape };
