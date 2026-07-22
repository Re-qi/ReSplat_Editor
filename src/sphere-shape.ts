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
import { vertexShader, fragmentShader } from './shaders/sphere-shape-shader';
import { Transform } from './transform';

class SphereShape extends Element {
    _radius = 1;
    _color = new Color(1, 1, 1);
    pivot: Entity;
    material: ShaderMaterial;
    bound = new BoundingBox();
    invMat = new Mat4();

    constructor() {
        super(ElementType.debug);

        this.pivot = new Entity('spherePivot');
        this.pivot.addComponent('render', {
            type: 'box'
        });
        const r = this._radius * 2;
        this.pivot.setLocalScale(r, r, r);
    }

    add() {
        const material = new ShaderMaterial({
            uniqueName: 'sphereShape',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
        material.cull = CULLFACE_FRONT;
        material.blendState = new BlendState(
            true,
            BLENDEQUATION_ADD, BLENDMODE_SRC_ALPHA, BLENDMODE_ONE_MINUS_SRC_ALPHA,
            BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA
        );
        material.setParameter('shapeColor', [this._color.r, this._color.g, this._color.b]);
        material.update();

        this.pivot.render.meshInstances[0].material = material;
        this.pivot.render.meshInstances[0].cull = false;
        this.pivot.render.layers = [this.scene.worldLayer.id];

        this.material = material;

        this.scene.contentRoot.addChild(this.pivot);

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

    docSerialize() {
        const p = this.pivot.getLocalPosition();
        const r = this.pivot.getLocalRotation();
        const s = this.pivot.getLocalScale();
        return {
            shapeType: 'sphere',
            uid: this.uid,
            position: [p.x, p.y, p.z],
            rotation: [r.x, r.y, r.z, r.w],
            scale: [s.x, s.y, s.z],
            color: [this._color.r, this._color.g, this._color.b]
        };
    }

    docDeserialize(doc: any) {
        this.uid = doc.uid;
        this.pivot.setLocalPosition(new Vec3(doc.position[0], doc.position[1], doc.position[2]));
        this.pivot.setLocalRotation(new Quat(doc.rotation[0], doc.rotation[1], doc.rotation[2], doc.rotation[3]));
        this.pivot.setLocalScale(new Vec3(doc.scale[0], doc.scale[1], doc.scale[2]));
        this._radius = Math.max(doc.scale[0], doc.scale[1], doc.scale[2]) / 2;
        this._color = new Color(doc.color[0], doc.color[1], doc.color[2]);
        this.updateBound();
    }

    serialize(serializer: Serializer): void {
        serializer.packa(this.pivot.getWorldTransform().data);
        serializer.pack(this.radius);
    }

    onPreRender() {
        // Pass inverse world matrix for local-space ray-ellipsoid intersection
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
            // Use the max dimension as radius so the selection covers the entire non-uniform shape
            this._radius = Math.max(scale.x, scale.y, scale.z) / 2;
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

    set radius(radius: number) {
        this._radius = radius;

        const r = this._radius * 2;
        this.pivot.setLocalScale(r, r, r);

        this.updateBound();
    }

    get radius() {
        const s = this.pivot.getLocalScale();
        return Math.max(s.x, s.y, s.z) / 2;
    }

    get radiusX() {
        return this.pivot.getLocalScale().x / 2;
    }

    get radiusY() {
        return this.pivot.getLocalScale().y / 2;
    }

    get radiusZ() {
        return this.pivot.getLocalScale().z / 2;
    }

    set color(c: Color) {
        this._color.copy(c);
    }

    get color() {
        return this._color;
    }
}

export { SphereShape };
