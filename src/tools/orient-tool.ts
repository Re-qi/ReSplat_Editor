import { Button, Container, Label } from '@playcanvas/pcui';
import { Entity, Mat4, Quat, TranslateGizmo, Vec3, math } from 'playcanvas';

import { AddEditPointOp, EntityTransformOp, MultiOp, PlacePivotOp, SetLocalFrameOp } from '../edit-ops';
import { Events } from '../events';
import type { Pivot } from '../pivot';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { pickSplatSurfacePoint } from '../splat-pick';
import { Transform } from '../transform';
import { projectLine, projectPoint } from './screen-projection';
import { localize } from '../ui/localization';

// snap the picked plane normal to a splat-local axis within this angle so
// axis-aligned scans (e.g. z-up captures) produce exact quarter/half turns
const SNAP_ANGLE_DEG = 3;

// pointer movement below this many pixels still counts as a click
const CLICK_TOLERANCE = 4;

const mat = new Mat4();
const p = new Vec3();
const p0 = new Vec3();
const p1 = new Vec3();
const p2 = new Vec3();
const screen0 = new Vec3();
const screen1 = new Vec3();
const screen2 = new Vec3();
const e0 = new Vec3();
const e1 = new Vec3();
const n = new Vec3();
const c = new Vec3();
const v = new Vec3();
const axis = new Vec3();
const snapped = new Vec3();
const newPos = new Vec3();
const q = new Quat();
const newRot = new Quat();

const t = new Transform();

class OrientTransformHandler {
    activate() {}
    deactivate() {}
}

class OrientTool {
    activate: () => void;
    deactivate: () => void;
    getFocus: () => { position: Vec3, radius: number } | null;

    constructor(events: Events, scene: Scene, parent: HTMLElement, canvasContainer: Container) {
        // SVG overlay for drawing orient points, lines and triangle
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('tool-svg', 'hidden');
        svg.id = 'orient-tool-svg';
        parent.appendChild(svg);

        const ns = svg.namespaceURI;

        // defs for reuse
        const defs = document.createElementNS(ns, 'defs');
        const dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('r', '5');
        dot.setAttribute('fill', 'white');
        dot.setAttribute('stroke', '#333');
        dot.setAttribute('stroke-width', '1.5');
        dot.id = 'orient-dot-prototype';
        defs.appendChild(dot);
        svg.appendChild(defs);

        // dual-layer line segments (up to 3, each with bottom/top)
        const lineBottoms: SVGLineElement[] = [];
        const lineTops: SVGLineElement[] = [];
        for (let i = 0; i < 3; i++) {
            const btm = document.createElementNS(ns, 'line') as SVGLineElement;
            btm.id = `orient-line${i}-bottom`;
            btm.setAttribute('stroke', 'black');
            btm.setAttribute('stroke-width', '6');
            btm.setAttribute('visibility', 'hidden');
            svg.appendChild(btm);
            lineBottoms.push(btm);

            const top = document.createElementNS(ns, 'line') as SVGLineElement;
            top.id = `orient-line${i}-top`;
            top.setAttribute('stroke', 'white');
            top.setAttribute('stroke-width', '2');
            top.setAttribute('visibility', 'hidden');
            svg.appendChild(top);
            lineTops.push(top);
        }

        // filled triangle
        const polygon = document.createElementNS(ns, 'polygon');
        polygon.setAttribute('fill', 'rgba(255,255,255,0.15)');
        polygon.setAttribute('stroke', 'none');
        polygon.id = 'orient-fill';
        svg.appendChild(polygon);

        // dot circles (up to 3)
        const dots: SVGUseElement[] = [];
        for (let i = 0; i < 3; i++) {
            const use = document.createElementNS(ns, 'use') as SVGUseElement;
            use.setAttribute('href', '#orient-dot-prototype');
            use.id = `orient-dot${i}`;
            use.setAttribute('visibility', 'hidden');
            svg.appendChild(use);
            dots.push(use);
        }

        // ui toolbar
        const hintLabel = new Label({ class: 'select-toolbar-label' });
        hintLabel.text = localize('orient.hint');

        const alignButton = new Button({ class: 'select-toolbar-button', enabled: false });
        alignButton.text = localize('orient.align');

        const clearButton = new Button({ class: 'select-toolbar-button', enabled: false });
        clearButton.text = localize('orient.clear');

        const selectToolbar = new Container({
            class: ['select-toolbar', 'select-toolbar-tool'],
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        selectToolbar.append(hintLabel);
        selectToolbar.append(alignButton);
        selectToolbar.append(clearButton);
        canvasContainer.append(selectToolbar);

        const gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);
        const transformHandler = new OrientTransformHandler();

        const entity = new Entity('orientGizmoPivot');
        scene.app.root.addChild(entity);

        gizmo.coordSpace = events.invoke('tool.coordSpace');
        events.on('tool.coordSpace', (coordSpace: 'local' | 'world') => {
            gizmo.coordSpace = coordSpace;
            scene.forceRender = true;
        });

        let active = false;
        let splat: Splat;

        // get world space point
        const getPoint = (index: number, result: Vec3) => {
            splat.worldTransform.transformPoint(splat.orientPoints[index], result);
        };

        // Project orient point to 2D screen pixel coords in the given target space.
        // width/height select the coordinate space: SVG drawing uses canvas.clientWidth
        // (post-zoom, matches #tools-container's SVG coord system), while click-hit
        // testing uses canvasContainer.clientWidth (pre-zoom, matches e.offsetX).
        // Without this, zoom-manager's style.zoom on <canvas>/#tools-container breaks
        // the assumption that those two dimensions are equal.
        const getPoint2d = (index: number, result: Vec3, width: number, height: number) => {
            getPoint(index, result);
            scene.camera.worldToScreen(result, result);
            result.x *= width;
            result.y *= height;
        };

        // calculate the world space plane normal and centroid from the three points
        const calcPlane = () => {
            getPoint(0, p0);
            getPoint(1, p1);
            getPoint(2, p2);

            e0.sub2(p1, p0);
            e1.sub2(p2, p0);
            n.cross(e0, e1);

            if (n.length() < 1e-6 * e0.length() * e1.length()) {
                return false;
            }

            n.normalize();
            c.add2(p0, p1).add(p2).mulScalar(1 / 3);

            return true;
        };

        // calculate the rotation aligning +y with the plane normal
        const calcPlaneRotation = (result: Quat) => {
            if (n.dot(v.sub2(scene.camera.position, c)) < 0) {
                n.mulScalar(-1);
            }
            e0.normalize();
            e1.cross(e0, n);
            mat.set([e0.x, e0.y, e0.z, 0, n.x, n.y, n.z, 0, e1.x, e1.y, e1.z, 0, 0, 0, 0, 1]);
            result.setFromMat4(mat);
        };

        const updateButtons = () => {
            const planeReady = !!splat && splat.orientPoints.length === 3 && calcPlane();
            alignButton.enabled = planeReady;
            clearButton.enabled = !!splat && splat.orientPoints.length > 0;
        };

        const updateVisuals = () => {
            gizmo.detach();

            if (splat && active && splat.orientSelection >= 0 && splat.orientSelection < splat.orientPoints.length) {
                getPoint(splat.orientSelection, p);
                t.set(p, Quat.IDENTITY, Vec3.ONE);
                events.invoke('pivot').place(t);
                entity.setLocalPosition(p);

                if (splat.orientPoints.length === 3 && calcPlane()) {
                    calcPlaneRotation(q);
                    entity.setLocalRotation(q);
                } else {
                    entity.setLocalRotation(Quat.IDENTITY);
                }

                gizmo.attach(entity);
            }

            updateButtons();
        };

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

        events.on('selection.changed', (selection: Splat) => {
            if (active) {
                events.fire('tool.deactivate');
            }
            splat = selection;
        });

        events.on('pivot.moved', () => {
            if (active && splat && splat.orientSelection >= 0 && splat.orientSelection < splat.orientPoints.length) {
                const pp = events.invoke('pivot').transform.position;
                mat.invert(splat.worldTransform);
                mat.transformPoint(pp, splat.orientPoints[splat.orientSelection]);
            }
            scene.forceRender = true;
        });

        events.on('pivot.ended', () => {
            if (active && splat && splat.orientSelection >= 0 && splat.orientSelection < splat.orientPoints.length) {
                updateVisuals();
            }
        });

        events.on('select.delete', () => {
            if (active && splat && splat.orientSelection >= 0 && splat.orientSelection < splat.orientPoints.length) {
                splat.orientPoints.splice(splat.orientSelection, 1);
                splat.orientSelection--;
                updateVisuals();
            }
        });

        // refresh visuals when an added point is undone/redone
        events.on('edit.apply', (op: AddEditPointOp) => {
            if (active && splat && op instanceof AddEditPointOp && op.splat === splat && op.kind === 'orient') {
                updateVisuals();
                scene.forceRender = true;
            }
        });

        // rotate and translate the splat so the picked plane aligns with Y+ (xZ plane)
        const alignToGrid = () => {
            if (!splat || splat.orientPoints.length !== 3 || !calcPlane()) {
                return;
            }

            if (n.dot(v.sub2(scene.camera.position, c)) < 0) {
                n.mulScalar(-1);
            }

            // snap the normal to the nearest splat-local axis if within SNAP_ANGLE_DEG
            const { worldTransform } = splat;
            let bestDot = Math.cos(SNAP_ANGLE_DEG * math.DEG_TO_RAD);
            let snap = false;
            for (let i = 0; i < 3; i++) {
                switch (i) {
                    case 0: worldTransform.getX(axis); break;
                    case 1: worldTransform.getY(axis); break;
                    case 2: worldTransform.getZ(axis); break;
                }
                axis.normalize();
                const d = n.dot(axis);
                if (Math.abs(d) > bestDot) {
                    bestDot = Math.abs(d);
                    snapped.copy(axis).mulScalar(Math.sign(d));
                    snap = true;
                }
            }
            if (snap) {
                n.copy(snapped);
            }

            // align to Y+ (the default grid plane is XZ / Y-up)
            const a = Vec3.UP;

            // shortest arc rotation from the plane normal to Y+
            q.setFromDirections(n, a);

            const oldt = new Transform(
                splat.entity.getLocalPosition(),
                splat.entity.getLocalRotation(),
                splat.entity.getLocalScale()
            );

            newPos.sub2(oldt.position, c);
            q.transformVector(newPos, newPos);
            newPos.add(c);
            newPos.sub(v.copy(a).mulScalar(c.dot(a)));

            newRot.mul2(q, oldt.rotation);

            const newt = new Transform(newPos, newRot, oldt.scale);

            if (oldt.equalsApprox(newt)) {
                return;
            }

            const top = new EntityTransformOp({ element: splat, oldt, newt });

            const pivot = events.invoke('pivot') as Pivot;
            mat.setTRS(newt.position, newt.rotation, newt.scale);
            mat.transformPoint(splat.localFrameOrigin, v);
            q.mul2(newt.rotation, splat.localFrame);
            t.set(v, q, newt.scale);
            const pop = new PlacePivotOp({ pivot, oldt: pivot.transform.clone(), newt: t.clone() });

            events.fire('edit.add', new MultiOp([top, pop]));

            splat.orientSelection = -1;
            updateVisuals();

            scene.forceRender = true;
        };

        alignButton.on('click', alignToGrid);

        // make the picked plane the model's local frame without moving it
        events.on('orient.setPivot', () => {
            if (!active) {
                return;
            }

            if (!splat || splat.orientPoints.length !== 3 || !calcPlane()) {
                return;
            }
            calcPlaneRotation(q);

            newRot.copy(splat.entity.getLocalRotation()).invert().mul(q);

            events.fire('edit.add', new SetLocalFrameOp({
                splat,
                oldOrigin: splat.localFrameOrigin.clone(),
                oldFrame: splat.localFrame.clone(),
                newOrigin: splat.orientPoints[0].clone(),
                newFrame: newRot.clone()
            }));
        });

        clearButton.on('click', () => {
            if (splat) {
                splat.orientPoints.length = 0;
                splat.orientSelection = -1;
                updateVisuals();
                scene.forceRender = true;
            }
        });

        // place a point at the visible surface under the click (see splat-pick.ts)
        const placePoint = (offsetX: number, offsetY: number) => {
            if (!pickSplatSurfacePoint(scene, splat, offsetX, offsetY, v)) {
                return false;
            }
            const op = new AddEditPointOp({ splat, kind: 'orient', point: v.clone(), skipDo: true });
            splat.orientSelection = splat.orientPoints.length;
            splat.orientPoints.push(op.point);
            events.fire('edit.add', op);
            return true;
        };

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
            if (!splat || !clicked || !isPrimary(e)) {
                clicked = false;
                return;
            }

            clicked = false;

            // check for intersection with existing point
            const cameraPos = scene.camera.mainCamera.getPosition();
            const cameraFwd = scene.camera.mainCamera.forward;
            let closestIdx = -1;
            for (let i = 0; i < splat.orientPoints.length; i++) {
                getPoint(i, v);
                if (v.sub(cameraPos).dot(cameraFwd) <= 0) {
                    continue;
                }

                getPoint2d(i, p, canvasContainer.dom.clientWidth, canvasContainer.dom.clientHeight);

                if (Math.abs(p.x - clickX) < 8 && Math.abs(p.y - clickY) < 8) {
                    closestIdx = i;
                    break;
                }
            }

            if (closestIdx >= 0) {
                splat.orientSelection = closestIdx;
                updateVisuals();
                return;
            }

            if (splat.orientPoints.length < 3 && placePoint(clickX, clickY)) {
                updateVisuals();
                scene.forceRender = true;
            }

            e.preventDefault();
            e.stopPropagation();
        };

        const updateSvg = () => {
            const count = splat ? splat.orientPoints.length : 0;

            // SVG lives inside #tools-container which has the same style.zoom as
            // <canvas>; its coord system therefore matches canvas.clientWidth.
            const svgW = scene.canvas.clientWidth;
            const svgH = scene.canvas.clientHeight;

            for (let i = 0; i < 3; i++) {
                const dotEl = dots[i];
                getPoint(i, v);
                if (i < count && projectPoint(scene.camera, v, v)) {
                    v.x *= svgW;
                    v.y *= svgH;
                    dotEl.setAttribute('x', v.x.toString());
                    dotEl.setAttribute('y', v.y.toString());
                    dotEl.setAttribute('visibility', 'visible');
                    dotEl.setAttribute('stroke', i === (splat ? splat.orientSelection : -1) ? '#ff9900' : 'black');
                } else {
                    dotEl.setAttribute('visibility', 'hidden');
                }
            }

            // helper: set x1,y1,x2,y2,visibility on both bottom and top layers
            const setLine = (idx: number, x1: string, y1: string, x2: string, y2: string, visible: boolean) => {
                const vis = visible ? 'visible' : 'hidden';
                lineBottoms[idx].setAttribute('x1', x1);
                lineBottoms[idx].setAttribute('y1', y1);
                lineBottoms[idx].setAttribute('x2', x2);
                lineBottoms[idx].setAttribute('y2', y2);
                lineBottoms[idx].setAttribute('visibility', vis);
                lineTops[idx].setAttribute('x1', x1);
                lineTops[idx].setAttribute('y1', y1);
                lineTops[idx].setAttribute('x2', x2);
                lineTops[idx].setAttribute('y2', y2);
                lineTops[idx].setAttribute('visibility', vis);
            };

            if (count > 1) {
                getPoint(0, p0);
                getPoint(1, p1);
                const line01Visible = projectLine(scene.camera, p0, p1, screen0, screen1);
                let line12Visible = false;
                let line20Visible = false;
                if (count === 3) {
                    getPoint(2, p2);
                    line12Visible = projectLine(scene.camera, p1, p2, screen1, screen2);
                    line20Visible = projectLine(scene.camera, p2, p0, screen2, screen0);
                }

                screen0.x *= svgW;
                screen0.y *= svgH;
                screen1.x *= svgW;
                screen1.y *= svgH;
                setLine(0, screen0.x.toString(), screen0.y.toString(), screen1.x.toString(), screen1.y.toString(), line01Visible);

                if (count === 3) {
                    screen2.x *= svgW;
                    screen2.y *= svgH;
                    setLine(1, screen1.x.toString(), screen1.y.toString(), screen2.x.toString(), screen2.y.toString(), line12Visible);
                    setLine(2, screen2.x.toString(), screen2.y.toString(), screen0.x.toString(), screen0.y.toString(), line20Visible);
                    polygon.setAttribute('points', `${screen0.x},${screen0.y} ${screen1.x},${screen1.y} ${screen2.x},${screen2.y}`);
                    polygon.setAttribute('visibility', line12Visible && line20Visible ? 'visible' : 'hidden');
                }
            } else {
                setLine(0, '', '', '', '', false);
            }

            if (count !== 3) {
                setLine(1, '', '', '', '', false);
                setLine(2, '', '', '', '', false);
                polygon.setAttribute('visibility', 'hidden');
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

        // frame the placed points instead of the selection ('f' shortcut)
        this.getFocus = () => {
            const count = splat ? splat.orientPoints.length : 0;
            if (count === 0) {
                return null;
            }

            const position = new Vec3();
            for (let i = 0; i < count; i++) {
                getPoint(i, v);
                position.add(v);
            }
            position.mulScalar(1 / count);

            let radius = 0;
            for (let i = 0; i < count; i++) {
                getPoint(i, v);
                radius = Math.max(radius, v.distance(position));
            }

            splat.worldTransform.getScale(v);
            const maxScale = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
            radius = Math.max(radius * 1.5, splat.localBound.halfExtents.length() * maxScale * 0.05);

            return { position, radius };
        };

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

            scene.forceRender = true;
        };

        this.deactivate = () => {
            active = false;

            updateVisuals();
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
            selectToolbar.hidden = true;
            parent.style.display = 'none';
            parent.classList.remove('noevents');
            svg.classList.add('hidden');

            events.fire('transformHandler.pop');

            scene.forceRender = true;
        };
    }
}

export { OrientTool };
