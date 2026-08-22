import { Button, Container, Label, NumericInput } from '@playcanvas/pcui';
import { Entity, Mat4, Quat, TranslateGizmo, Vec3 } from 'playcanvas';

import { AddEditPointOp, EntityTransformOp } from '../edit-ops';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { pickSplatSurfacePoint } from '../splat-pick';
import { Transform } from '../transform';
import { projectLine, projectPoint } from './screen-projection';
import { localize } from '../ui/localization';

// pointer movement below this many pixels still counts as a click
const CLICK_TOLERANCE = 4;

const mat = new Mat4();
const mat1 = new Mat4();
const mat2 = new Mat4();
const mat3 = new Mat4();
const p = new Vec3();
const p0 = new Vec3();
const p1 = new Vec3();
const screen0 = new Vec3();
const screen1 = new Vec3();
const v = new Vec3();
const r = new Quat();
const s = new Vec3();

const t = new Transform();

class MeasureTransformHandler {
    activate() {}
    deactivate() {}
}

class MeasureTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, parent: HTMLElement, canvasContainer: Container) {
        // create svg
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('tool-svg', 'hidden');
        svg.id = 'measure-tool-svg';
        parent.appendChild(svg);

        const ns = svg.namespaceURI;

        // defs for reuse
        const defs = document.createElementNS(ns, 'defs');
        const dotPrototype = document.createElementNS(ns, 'circle');
        dotPrototype.setAttribute('r', '5');
        dotPrototype.setAttribute('fill', 'white');
        dotPrototype.setAttribute('stroke', '#333');
        dotPrototype.setAttribute('stroke-width', '1.5');
        dotPrototype.id = 'measure-dot-prototype';
        defs.appendChild(dotPrototype);

        const line = document.createElementNS(ns, 'line') as SVGLineElement;
        line.id = 'measure-line';
        defs.appendChild(line);

        svg.appendChild(defs);

        const lineBottom = document.createElementNS(ns, 'use') as SVGUseElement;
        lineBottom.id = 'measure-line-bottom';
        lineBottom.setAttribute('href', '#measure-line');
        svg.appendChild(lineBottom);

        const lineTop = document.createElementNS(ns, 'use') as SVGUseElement;
        lineTop.id = 'measure-line-top';
        lineTop.setAttribute('href', '#measure-line');
        svg.appendChild(lineTop);

        // dot circles (up to 2)
        const dots: SVGUseElement[] = [];
        for (let i = 0; i < 2; i++) {
            const use = document.createElementNS(ns, 'use') as SVGUseElement;
            use.setAttribute('href', '#measure-dot-prototype');
            use.id = `measure-dot${i}`;
            use.setAttribute('visibility', 'hidden');
            svg.appendChild(use);
            dots.push(use);
        }

        // ui
        const lengthLabel = new Label({
            text: localize('measure.length')
        });

        const lengthInput = new NumericInput({
            width: 90,
            placeholder: 'm',
            precision: 2,
            min: 0.0001,
            value: 0
        });
        let suppressUI = 0;

        const hintLabel = new Label({ class: 'select-toolbar-label' });
        hintLabel.text = localize('measure.hint');

        const clearButton = new Button({ class: 'select-toolbar-button', enabled: false });
        clearButton.text = localize('measure.clear');

        const selectToolbar = new Container({
            class: ['select-toolbar', 'select-toolbar-tool'],
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        selectToolbar.append(hintLabel);
        selectToolbar.append(lengthLabel);
        selectToolbar.append(lengthInput);
        selectToolbar.append(clearButton);
        canvasContainer.append(selectToolbar);

        const gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);

        // only allow left mouse button to control the gizmo
        gizmo.mouseButtons[1] = false;
        gizmo.mouseButtons[2] = false;

        const entity = new Entity('measureGizmoPivot');
        scene.app.root.addChild(entity);
        const transformHandler = new MeasureTransformHandler();

        let active = false;
        let splat: Splat;

        // get world space point
        const getPoint = (index: number, result: Vec3) => {
            splat.worldTransform.transformPoint(splat.measurePoints[index], result);
        };

        const getPoint2d = (index: number, result: Vec3, width: number, height: number) => {
            getPoint(index, result);
            scene.camera.worldToScreen(result, result);
            result.x *= width;
            result.y *= height;
        };

        const updateVisuals = () => {
            gizmo.detach();

            if (splat && active && splat.measureSelection >= 0 && splat.measureSelection < splat.measurePoints.length) {
                getPoint(splat.measureSelection, p);
                t.set(p, Quat.IDENTITY, Vec3.ONE);
                events.invoke('pivot').place(t);
                entity.setLocalPosition(p);
                gizmo.attach(entity);
            }

            if (splat && splat.measurePoints.length === 2) {
                getPoint(0, p0);
                getPoint(1, p1);
                const len = p0.distance(p1);

                suppressUI++;
                lengthInput.value = len;
                lengthInput.enabled = true;
                suppressUI--;
            } else {
                lengthInput.enabled = false;
            }

            clearButton.enabled = !!splat && splat.measurePoints.length > 0;
        };

        clearButton.on('click', () => {
            if (splat) {
                splat.measurePoints.length = 0;
                splat.measureSelection = -1;
                updateVisuals();
                scene.forceRender = true;
            }
        });

        gizmo.on('render:update', () => {
            scene.forceRender = true;
        });

        gizmo.on('transform:start', () => {
            events.invoke('pivot').start();
        });

        gizmo.on('transform:move', () => {
            events.invoke('pivot').moveTRS(entity.getLocalPosition(), entity.getLocalRotation(), entity.getLocalScale());
        });

        gizmo.on('transform:end', () => {
            events.invoke('pivot').end();
        });

        events.on('selection.changed', (selection: any) => {
            splat = selection instanceof Splat ? selection : null;
            if (active) {
                // for now we always deactivate the tool so the current transform handler remains in place
                events.fire('tool.deactivate');
            }
        });

        events.on('pivot.started', () => {

        });

        events.on('pivot.moved', () => {
            if (active && splat && splat.measureSelection >= 0 && splat.measureSelection < splat.measurePoints.length) {
                const p = events.invoke('pivot').transform.position;
                mat.invert(splat.worldTransform);
                mat.transformPoint(p, splat.measurePoints[splat.measureSelection]);
            }
            scene.forceRender = true;
        });

        events.on('pivot.ended', () => {
            if (active && splat && splat.measureSelection >= 0 && splat.measureSelection < splat.measurePoints.length) {
                updateVisuals();
            }
        });

        const origTransform = new Mat4();
        const origP = new Vec3();
        const origR = new Quat();
        const origS = new Vec3();
        const mid = new Vec3();
        let startLen = 0;

        const startScale = () => {
            if (!splat || splat.measurePoints.length !== 2) {
                return;
            }

            origTransform.copy(splat.worldTransform);
            origP.copy(splat.entity.getLocalPosition());
            origR.copy(splat.entity.getLocalRotation());
            origS.copy(splat.entity.getLocalScale());

            getPoint(0, p0);
            getPoint(1, p1);
            mid.sub2(p1, p0);
            startLen = mid.length();
            mid.mulScalar(0.5).add(p0);
        };

        // position and scale the splat according to the new length
        const applyLength = (newLength: number) => {
            if (!splat || splat.measurePoints.length !== 2 || newLength <= 0) {
                return;
            }

            const scale = newLength / startLen;

            // calculate mid point
            p.copy(mid);

            // construct a transform matrix that scales from p by len * 0.5
            mat1.setTranslate(-p.x, -p.y, -p.z);
            mat2.setScale(scale, scale, scale);
            mat3.setTranslate(p.x, p.y, p.z);

            mat.mul2(mat1, origTransform);
            mat.mul2(mat2, mat);
            mat.mul2(mat3, mat);

            mat.getTranslation(p);
            r.setFromMat4(mat);
            mat.getScale(s);

            splat.entity.setLocalPosition(p);
            splat.entity.setLocalRotation(r);
            splat.entity.setLocalScale(s);

            scene.forceRender = true;
        };

        const endScale = () => {
            const top = new EntityTransformOp({
                element: splat,
                oldt: new Transform(origP, origR, origS),
                newt: new Transform(splat.entity.getLocalPosition(), splat.entity.getLocalRotation(), splat.entity.getLocalScale())
            });

            events.fire('edit.add', top);
            updateVisuals();
        };

        let dragging = false;

        // handle length input updates
        lengthInput.on('slider:mousedown', () => {
            startScale();
            dragging = true;
        });
        lengthInput.on('change', (value) => {
            if (dragging) {
                applyLength(value);
            } else if (!suppressUI) {
                startScale();
                applyLength(value);
                endScale();
            }
        });
        lengthInput.on('slider:mouseup', () => {
            endScale();
            dragging = false;
        });

        events.on('select.delete', () => {
            if (active && splat && splat.measureSelection >= 0 && splat.measureSelection < splat.measurePoints.length) {
                splat.measurePoints.splice(splat.measureSelection, 1);
                splat.measureSelection--;
                updateVisuals();
            }
        });

        // refresh visuals when an added point is undone/redone
        events.on('edit.apply', (op: AddEditPointOp) => {
            if (active && splat && op instanceof AddEditPointOp && op.splat === splat && op.kind === 'measure') {
                updateVisuals();
                scene.forceRender = true;
            }
        });

        const isPrimary = (e: PointerEvent) => {
            return e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary;
        };

        let clicked = false;
        let clickX = 0;
        let clickY = 0;

        const pointerdown = (e: PointerEvent) => {
            if (!clicked && isPrimary(e)) {
                clicked = true;
                clickX = e.offsetX;
                clickY = e.offsetY;
            }
        };

        const pointermove = (e: PointerEvent) => {
            if (clicked && Math.hypot(e.offsetX - clickX, e.offsetY - clickY) > CLICK_TOLERANCE) {
                clicked = false;
            }
        };

        const pointerup = (e: PointerEvent) => {
            if (splat && clicked && isPrimary(e)) {
                clicked = false;

                let closestIdx = -1;

                // check for intersection with existing point
                const cameraPos = scene.camera.mainCamera.getPosition();
                const cameraFwd = scene.camera.mainCamera.forward;
                for (let i = 0; i < splat.measurePoints.length; i++) {
                    getPoint(i, p);
                    if (p.sub(cameraPos).dot(cameraFwd) <= 0) {
                        continue;
                    }

                    getPoint2d(i, p, canvasContainer.dom.clientWidth, canvasContainer.dom.clientHeight);

                    if (Math.abs(p.x - clickX) < 8 && Math.abs(p.y - clickY) < 8) {
                        closestIdx = i;
                        break;
                    }
                }

                if (closestIdx >= 0) {
                    splat.measureSelection = closestIdx;
                    updateVisuals();
                    return;
                }

                if (splat.measurePoints.length < 2 && pickSplatSurfacePoint(scene, splat, clickX, clickY, v)) {
                    const op = new AddEditPointOp({ splat, kind: 'measure', point: v.clone(), skipDo: true });
                    splat.measureSelection = splat.measurePoints.length;
                    splat.measurePoints.push(op.point);
                    events.fire('edit.add', op);
                    updateVisuals();
                }

                e.preventDefault();
                e.stopPropagation();
            }
        };

        const updateSvg = () => {
            const count = splat ? splat.measurePoints.length : 0;

            // SVG lives inside #tools-container which has the same style.zoom as
            // <canvas>; its coord system therefore matches canvas.clientWidth.
            const svgW = scene.canvas.clientWidth;
            const svgH = scene.canvas.clientHeight;

            for (let i = 0; i < 2; i++) {
                const dotEl = dots[i];
                getPoint(i, v);
                if (i < count && projectPoint(scene.camera, v, v)) {
                    v.x *= svgW;
                    v.y *= svgH;
                    dotEl.setAttribute('x', v.x.toString());
                    dotEl.setAttribute('y', v.y.toString());
                    dotEl.setAttribute('visibility', 'visible');
                    dotEl.setAttribute('stroke', i === (splat ? splat.measureSelection : -1) ? '#ff9900' : '#333');
                } else {
                    dotEl.setAttribute('visibility', 'hidden');
                }
            }

            if (count > 1) {
                getPoint(0, p0);
                getPoint(1, p1);
                if (projectLine(scene.camera, p0, p1, screen0, screen1)) {
                    screen0.x *= svgW;
                    screen0.y *= svgH;
                    screen1.x *= svgW;
                    screen1.y *= svgH;
                    line.setAttribute('x1', screen0.x.toString());
                    line.setAttribute('y1', screen0.y.toString());
                    line.setAttribute('x2', screen1.x.toString());
                    line.setAttribute('y2', screen1.y.toString());
                    line.setAttribute('visibility', 'visible');
                } else {
                    line.setAttribute('visibility', 'hidden');
                }
            } else {
                line.setAttribute('visibility', 'hidden');
            }
        };

        events.on('postrender', () => {
            if (!active || !splat) {
                svg.classList.add('hidden');
                return;
            }
            svg.classList.remove('hidden');
            updateSvg();
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

        this.activate = () => {
            active = true;
            updateVisuals();
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
            selectToolbar.hidden = false;
            parent.style.display = 'block';
            parent.classList.add('noevents');
            svg.classList.remove('hidden');

            events.fire('transformHandler.push', transformHandler);
        };

        this.deactivate = () => {
            active = false;
            updateVisuals();
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup);
            selectToolbar.hidden = true;
            parent.style.display = 'none';
            parent.classList.remove('noevents');
            svg.classList.add('hidden');

            events.fire('transformHandler.pop');
        };
    }
}

export { MeasureTool };
