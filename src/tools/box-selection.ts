import { Button, Container } from '@playcanvas/pcui';
import { TranslateGizmo, Vec3 } from 'playcanvas';

import { AddShapeOp, EntityTransformOp } from '../edit-ops';
import { BoxShape } from '../box-shape';
import { Element } from '../element';
import { Events } from '../events';
import { localize } from '../ui/localization';
import { Pivot } from '../pivot';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { Transform } from '../transform';

// Tools that have their own select-toolbar and would visually overlap with the wrapper toolbar
const toolsWithToolbar = new Set(['opacitySelection', 'sizeSelection', 'eyedropperSelection', 'floodSelection', 'measure']);

class BoxSelection {
    activate: () => void;
    deactivate: () => void;

    active = false;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const boxes: BoxShape[] = [];
        let currentBox: BoxShape | null = null;
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
            if (currentBox) {
                const p = currentBox.pivot.getLocalPosition();
                const r = currentBox.pivot.getLocalRotation();
                const s = currentBox.pivot.getLocalScale();
                transformStart = new Transform(p, r, s);
            }
        });

        gizmo.on('transform:move', () => {
            currentBox?.moved();
        });

        gizmo.on('transform:end', () => {
            if (currentBox && transformStart) {
                const p = currentBox.pivot.getLocalPosition();
                const r = currentBox.pivot.getLocalRotation();
                const s = currentBox.pivot.getLocalScale();
                const transformEnd = new Transform(p, r, s);

                if (!transformStart.equals(transformEnd)) {
                    const op = new EntityTransformOp({
                        element: currentBox,
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
            if (!currentBox) return;
            const p = currentBox.pivot.getPosition();
            const r = currentBox.pivot.getLocalRotation();
            events.fire('select.byBox', op, [p.x, p.y, p.z, currentBox.lenX, currentBox.lenY, currentBox.lenZ, r.x, r.y, r.z, r.w]);
        };

        setButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('set');
        });
        addButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('add');
        });
        removeButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('remove');
        });

        events.on('camera.focalPointPicked', (details: { splat: Splat, position: Vec3 }) => {
            if (!this.active) return;

            createBox(details.position);
        });

        // Additional event to create a box when tool icon is clicked while already active
        events.on('boxSelection.create', () => {
            createBox(scene.camera.focalPoint.clone());
        });

        // Clean up our reference when a box is removed from the scene
        events.on('scene.elementRemoved', (element: Element) => {
            if (element instanceof BoxShape) {
                const idx = boxes.indexOf(element);
                if (idx !== -1) {
                    boxes.splice(idx, 1);
                    if (currentBox === element) {
                        currentBox = null;
                        gizmo.enabled = false;
                        gizmo.detach();
                    }
                }
            }
        });

        // When a box is selected from the scene manager, update our gizmo
        events.on('selection.shapeChanged', (selection: Element | null) => {
            if (selection instanceof BoxShape && boxes.includes(selection)) {
                currentBox = selection;
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

        // When the box is transformed (e.g., via scale tool)
        events.on('splat.moved', (element: Element) => {
            if (element === currentBox) {
                // box moved, no UI to update
            }
        });

        // When another tool with a toolbar activates, hide our toolbar to prevent overlap
        events.on('tool.activated', (toolName: string) => {
            if (toolName && toolName !== 'boxSelection' && toolsWithToolbar.has(toolName)) {
                selectToolbar.hidden = true;
                toolbarHiddenByOtherTool = true;
            }

            // Deactivate our gizmo if another tool takes over
            if (this.active && toolName !== 'boxSelection') {
                gizmo.enabled = false;
                gizmo.detach();
                this.active = false;
            }
        });

        // When a toolbar-owning tool deactivates, show our toolbar again if box is still selected
        events.on('tool.deactivated', (toolName: string) => {
            if (toolbarHiddenByOtherTool && toolName && toolsWithToolbar.has(toolName)) {
                toolbarHiddenByOtherTool = false;
                const shapeSel = events.invoke('shapeSelection') as Element | null;
                if (shapeSel instanceof BoxShape && boxes.includes(shapeSel)) {
                    selectToolbar.hidden = false;
                }
            }
        });

        // When the box tool reactivates
        events.on('tool.boxSelection.activated', () => {
            if (!this.active) {
                this.active = true;
                selectToolbar.hidden = false;
                if (currentBox) {
                    gizmo.enabled = true;
                    gizmo.attach([currentBox.pivot]);
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

        const createBox = (position: Vec3) => {
            const box = new BoxShape();
            // 先添加到场景中，使 updateBound() 能获取到 this.scene
            scene.add(box);
            boxes.push(box);
            currentBox = box;
            box.lenX = 2;
            box.lenY = 2;
            box.lenZ = 2;
            box.pivot.setPosition(position);
            box.updateBound();

            const op = new AddShapeOp({
                scene,
                shape: box,
                shapes: boxes,
                currentShape: currentBox,
                setCurrentShape: (shape) => {
                    currentBox = shape as BoxShape | null;
                },
                skipDo: true
            });
            events.fire('edit.add', op);

            gizmo.enabled = true;
            gizmo.attach([box.pivot]);
        };

        this.activate = () => {
            this.active = true;
            selectToolbar.hidden = false;
            // Re-attach gizmo to the last box (or current if still alive)
            if (boxes.length > 0) {
                const target = currentBox ?? boxes[boxes.length - 1];
                currentBox = target;
                gizmo.enabled = true;
                gizmo.attach([target.pivot]);
            }
        };

        this.deactivate = () => {
            gizmo.enabled = false;
            gizmo.detach();

            // Sync the pivot to the current box's position so transform tools
            // pick up the correct location when they activate.
            const shapeSel = events.invoke('shapeSelection') as Element | null;
            if (currentBox && shapeSel === currentBox) {
                const pivot = events.invoke('pivot') as Pivot;
                const t = new Transform();
                currentBox.getPivot('center', false, t);
                pivot.place(t);
            }

            // Keep toolbar visible if a box is still selected
            if (!(shapeSel instanceof BoxShape)) {
                selectToolbar.hidden = true;
            }

            this.active = false;
        };
    }
}

export { BoxSelection };
