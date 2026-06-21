import { Button, Container } from '@playcanvas/pcui';
import { TranslateGizmo, Vec3 } from 'playcanvas';

import { AddShapeOp, EntityTransformOp } from '../edit-ops';
import { Element } from '../element';
import { Events } from '../events';
import { localize } from '../ui/localization';
import { Pivot } from '../pivot';
import { Scene } from '../scene';
import { SphereShape } from '../sphere-shape';
import { Splat } from '../splat';
import { Transform } from '../transform';

// Tools that have their own select-toolbar and would visually overlap with the wrapper toolbar
const toolsWithToolbar = new Set(['opacitySelection', 'sizeSelection', 'eyedropperSelection', 'floodSelection', 'measure']);

class SphereSelection {
    activate: () => void;
    deactivate: () => void;

    active = false;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const spheres: SphereShape[] = [];
        let currentSphere: SphereShape | null = null;
        let toolbarHiddenByOtherTool = false;

        const gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);

        // only allow left mouse button to control the gizmo
        gizmo.mouseButtons[1] = false;
        gizmo.mouseButtons[2] = false;

        gizmo.on('render:update', () => {
            scene.forceRender = true;
        });

        let transformStart: Transform | null = null;

        gizmo.on('transform:start', () => {
            if (currentSphere) {
                const p = currentSphere.pivot.getLocalPosition();
                const r = currentSphere.pivot.getLocalRotation();
                const s = currentSphere.pivot.getLocalScale();
                transformStart = new Transform(p, r, s);
            }
        });

        gizmo.on('transform:move', () => {
            currentSphere?.moved();
        });

        gizmo.on('transform:end', () => {
            if (currentSphere && transformStart) {
                const p = currentSphere.pivot.getLocalPosition();
                const r = currentSphere.pivot.getLocalRotation();
                const s = currentSphere.pivot.getLocalScale();
                const transformEnd = new Transform(p, r, s);

                if (!transformStart.equals(transformEnd)) {
                    const op = new EntityTransformOp({
                        element: currentSphere,
                        oldt: transformStart,
                        newt: transformEnd
                    });
                    events.fire('edit.add', op);
                }
                transformStart = null;
            }
        });

        // ui
        const selectToolbar = new Container({
            class: 'select-toolbar',
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        const setButton = new Button({ text: localize('toolbar.select.set'), class: 'select-toolbar-button' });
        const addButton = new Button({ text: localize('toolbar.select.add'), class: 'select-toolbar-button' });
        const removeButton = new Button({ text: localize('toolbar.select.remove'), class: 'select-toolbar-button' });

        selectToolbar.append(setButton);
        selectToolbar.append(addButton);
        selectToolbar.append(removeButton);

        canvasContainer.append(selectToolbar);

        const apply = (op: 'set' | 'add' | 'remove') => {
            if (!currentSphere) return;
            const p = currentSphere.pivot.getPosition();
            const r = currentSphere.pivot.getLocalRotation();
            events.fire('select.bySphere', op, [p.x, p.y, p.z, currentSphere.radiusX, currentSphere.radiusY, currentSphere.radiusZ, r.x, r.y, r.z, r.w]);
        };

        setButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); apply('set');
        });
        addButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); apply('add');
        });
        removeButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); apply('remove');
        });

        events.on('camera.focalPointPicked', (details: { splat: Splat, position: Vec3 }) => {
            if (!this.active) return;

            createSphere(details.position);
        });

        // Additional event to create a sphere when tool icon is clicked while already active
        events.on('sphereSelection.create', () => {
            createSphere(scene.camera.focalPoint.clone());
        });

        // Clean up our reference when a sphere is removed from the scene
        events.on('scene.elementRemoved', (element: Element) => {
            if (element instanceof SphereShape) {
                const idx = spheres.indexOf(element);
                if (idx !== -1) {
                    spheres.splice(idx, 1);
                    if (currentSphere === element) {
                        currentSphere = null;
                        gizmo.enabled = false;
                        gizmo.detach();
                    }
                }
            }
        });

        // When a sphere is selected from the scene manager, update our gizmo
        events.on('selection.shapeChanged', (selection: Element | null) => {
            if (selection instanceof SphereShape && spheres.includes(selection)) {
                currentSphere = selection;
                if (this.active) {
                    gizmo.enabled = true;
                    gizmo.attach([selection.pivot]);
                } else {
                    gizmo.enabled = false;
                    gizmo.detach();
                }
                selectToolbar.hidden = false;
            } else {
                selectToolbar.hidden = true;
                gizmo.enabled = false;
                gizmo.detach();
            }
        });

        // When the sphere is transformed (e.g., via scale tool), update toolbar inputs
        events.on('splat.moved', (element: Element) => {
            if (element === currentSphere) {
                // Sphere radius is now managed through transform tools
            }
        });

        // When another tool with a toolbar activates, hide our toolbar to prevent overlap
        events.on('tool.activated', (toolName: string) => {
            if (toolName && toolName !== 'sphereSelection' && toolsWithToolbar.has(toolName)) {
                selectToolbar.hidden = true;
                toolbarHiddenByOtherTool = true;
            }

            // Deactivate our gizmo if another tool takes over
            if (this.active && toolName !== 'sphereSelection') {
                gizmo.enabled = false;
                gizmo.detach();
                this.active = false;
            }
        });

        // When a toolbar-owning tool deactivates, show our toolbar again if sphere is still selected
        events.on('tool.deactivated', (toolName: string) => {
            if (toolbarHiddenByOtherTool && toolName && toolsWithToolbar.has(toolName)) {
                toolbarHiddenByOtherTool = false;
                const shapeSel = events.invoke('shapeSelection') as Element | null;
                if (shapeSel instanceof SphereShape && spheres.includes(shapeSel)) {
                    selectToolbar.hidden = false;
                }
            }
        });

        // When another tool deactivates and we should re-activate
        events.on('tool.sphereSelection.activated', () => {
            if (!this.active) {
                this.active = true;
                selectToolbar.hidden = false;
                if (currentSphere) {
                    gizmo.enabled = true;
                    gizmo.attach([currentSphere.pivot]);
                }
            }
        });

        const updateGizmoSize = () => {
            const { camera, canvas } = scene;
            if (camera.ortho) {
                gizmo.size = 1125 / canvas.clientHeight;
            } else {
                gizmo.size = 1200 / Math.max(canvas.clientWidth, canvas.clientHeight);
            }
        };
        updateGizmoSize();
        events.on('camera.resize', updateGizmoSize);
        events.on('camera.ortho', updateGizmoSize);

        // 创建包裹体积球体
        // 球体不在世界原点生成，而是在相机当前焦点位置（focalPoint）或用户点击拾取的位置生成
        // 这样可以确保新创建的包裹体积直接出现在用户正在查看的模型区域
        const createSphere = (position: Vec3) => {
            const sphere = new SphereShape();
            // 先添加到场景中，使 updateBound() 能获取到 this.scene
            scene.add(sphere);
            spheres.push(sphere);
            currentSphere = sphere;
            // 使用默认半径 1.0，后续可通过变换工具调整
            sphere.radius = 1.0;
            // 将球体定位到传入的位置（相机焦点或拾取点），而非世界原点
            sphere.pivot.setPosition(position);
            sphere.updateBound();

            const op = new AddShapeOp({
                scene,
                shape: sphere,
                shapes: spheres,
                currentShape: currentSphere,
                setCurrentShape: (shape) => {
                    currentSphere = shape as SphereShape | null;
                },
                skipDo: true
            });
            events.fire('edit.add', op);

            gizmo.enabled = true;
            gizmo.attach([sphere.pivot]);
        };

        this.activate = () => {
            this.active = true;
            selectToolbar.hidden = false;
            // Re-attach gizmo to the last sphere (or current if still alive)
            if (spheres.length > 0) {
                const target = currentSphere ?? spheres[spheres.length - 1];
                currentSphere = target;
                gizmo.enabled = true;
                gizmo.attach([target.pivot]);
            }
        };

        this.deactivate = () => {
            gizmo.enabled = false;
            gizmo.detach();

            // Sync the pivot to the current sphere's position so transform tools
            // pick up the correct location when they activate.
            const shapeSel = events.invoke('shapeSelection') as Element | null;
            if (currentSphere && shapeSel === currentSphere) {
                const pivot = events.invoke('pivot') as Pivot;
                const t = new Transform();
                currentSphere.getPivot('center', false, t);
                pivot.place(t);
            }

            // Keep toolbar visible if a sphere is still selected
            if (!(shapeSel instanceof SphereShape)) {
                selectToolbar.hidden = true;
            }

            this.active = false;
        };
    }
}

export { SphereSelection };
