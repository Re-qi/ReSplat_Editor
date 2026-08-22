import { Button, Container, ContainerArgs, Label, VectorInput } from '@playcanvas/pcui';
import { Quat, Vec3 } from 'playcanvas';

import { Element } from '../element';
import { Events } from '../events';
import { localize } from './localization';
import { Pivot } from '../pivot';
import { Tooltips } from './tooltips';
import { Transform as TRSTransform } from '../transform';
import cameraResetSvg from './svg/camera-reset.svg';
import cornerUpLeftSvg from './svg/corner-up-left.svg';
import lockOpenSvg from './svg/lock-keyhole-open.svg';
import lockSvg from './svg/lock-keyhole.svg';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

// 创建行级撤回按钮（恢复单个属性到初始值），图标 16x16
const createRevertBtn = (onRevert: () => void) => {
    const btn = new Container({
        class: 'row-revert-btn'
    });
    btn.dom.appendChild(createSvg(cornerUpLeftSvg));
    btn.on('click', onRevert);
    return btn;
};

const v = new Vec3();

class Transform extends Container {
    constructor(events: Events, tooltips: Tooltips, args: ContainerArgs = {}) {
        args = {
            ...args,
            id: 'transform'
        };

        super(args);

        // position
        const position = new Container({
            class: 'transform-row'
        });

        const positionLabel = new Label({
            class: 'transform-label',
            text: localize('panel.scene-manager.transform.position')
        });

        // 控制原点：拖拽到场景高斯文件上，移动其 gizmo 到对应位置
        const controlOrigin = new Button({
            class: 'transform-lock-btn',
            enabled: true
        });
        controlOrigin.dom.appendChild(createSvg(cameraResetSvg));

        const positionVector = new VectorInput({
            class: 'transform-expand',
            precision: 3,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [0, 0, 0],
            enabled: false
        });

        position.append(positionLabel);
        position.append(controlOrigin);
        position.append(positionVector);

        // 撤回：恢复位置到选中时的初始值
        const positionRevert = createRevertBtn(() => {
            if (!positionVector.enabled) return;
            const pivot = events.invoke('pivot') as Pivot;
            if (!pivot) return;

            // 「仅控制原点」模式：把 gizmo 恢复到文件默认位置
            if (events.invoke('pivot.detached') && originBase) {
                pivot.moveTRS(originBase.position, pivot.transform.rotation, pivot.transform.scale);
                updateUI(pivot);
                return;
            }

            if (initialTransform) {
                pivot.start();
                pivot.moveTRS(initialTransform.position, pivot.transform.rotation, pivot.transform.scale);
                pivot.end();
            }
        });
        tooltips.register(positionRevert, '恢复默认位置', 'bottom');
        position.append(positionRevert);

        tooltips.register(controlOrigin, '控制原点', 'bottom');
        // 拖拽控制原点按钮到场景高斯文件上，移动其 gizmo 到对应位置（复用双击拾取逻辑）
        controlOrigin.dom.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();

            // 拖拽时创建一个跟随鼠标的图标副本（首次移动才创建，避免单击闪烁）
            let ghost: HTMLDivElement | null = null;

            const onMouseMove = (ev: MouseEvent) => {
                if (!ghost) {
                    ghost = document.createElement('div');
                    ghost.className = 'transform-drag-ghost';
                    ghost.appendChild(createSvg(cameraResetSvg));
                    document.body.appendChild(ghost);
                }
                ghost.style.left = `${ev.clientX}px`;
                ghost.style.top = `${ev.clientY}px`;
            };

            const onMouseUp = (ev: MouseEvent) => {
                document.removeEventListener('mouseup', onMouseUp);
                document.removeEventListener('mousemove', onMouseMove);
                ghost?.remove();
                // 与双击聚焦（controllers.ts dblclick）完全一致的坐标系：
                // 以 #canvas-container 为基准归一化。不能用 #tools-container，
                // 它在没有选择工具激活时是 display:none（rect 为 0）。
                const container = document.getElementById('canvas-container');
                if (!container) return;
                const rect = container.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return;
                const x = ev.clientX - rect.left;
                const y = ev.clientY - rect.top;
                if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return;
                window.scene.camera.pickFocalPoint(x / rect.width, y / rect.height);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        // 点击切换「仅控制原点」模式：高亮时 gizmo 拖拽与面板参数只调整
        // pivot（gizmo 本身），不作用于选中物体
        controlOrigin.on('click', () => {
            const detached = !events.invoke('pivot.detached');
            events.fire('pivot.setDetached', detached);
            controlOrigin.dom.classList.toggle('active', detached);
            // 立即刷新显示（切换坐标基准：绝对 <-> 相对）
            if (detached) {
                computeDefaultOrigin();
            }
            updateUI(events.invoke('pivot') as Pivot);
        });

        // rotation
        const rotation = new Container({
            class: 'transform-row'
        });

        const rotationLabel = new Label({
            class: 'transform-label',
            text: localize('panel.scene-manager.transform.rotation')
        });

        const rotationVector = new VectorInput({
            class: 'transform-expand',
            precision: 2,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [0, 0, 0],
            enabled: false
        });

        rotation.append(rotationLabel);
        rotation.append(rotationVector);

        // 撤回：恢复旋转到选中时的初始值
        const rotationRevert = createRevertBtn(() => {
            if (!rotationVector.enabled) return;
            const pivot = events.invoke('pivot') as Pivot;
            if (pivot && initialTransform) {
                pivot.start();
                pivot.moveTRS(pivot.transform.position, initialTransform.rotation, pivot.transform.scale);
                pivot.end();
            }
        });
        tooltips.register(rotationRevert, '恢复默认旋转', 'bottom');
        rotation.append(rotationRevert);

        // scale
        const scale = new Container({
            class: 'transform-row'
        });

        const scaleLabel = new Label({
            class: 'transform-label',
            text: localize('panel.scene-manager.transform.scale')
        });

        const scaleLock = new Button({
            class: 'transform-lock-btn',
            enabled: true
        });
        scaleLock.dom.appendChild(createSvg(lockSvg));

        const scaleVector = new VectorInput({
            class: 'transform-expand',
            precision: 3,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [1, 1, 1],
            min: 0.001,
            max: 10000,
            enabled: false
        });

        scale.append(scaleLabel);
        scale.append(scaleLock);
        scale.append(scaleVector);

        // 撤回：恢复缩放到选中时的初始值
        const scaleRevert = createRevertBtn(() => {
            if (!scaleVector.enabled) return;
            const pivot = events.invoke('pivot') as Pivot;
            if (pivot && initialTransform) {
                pivot.start();
                pivot.moveTRS(pivot.transform.position, pivot.transform.rotation, initialTransform.scale);
                pivot.end();
            }
        });
        tooltips.register(scaleRevert, '恢复默认缩放', 'bottom');
        scale.append(scaleRevert);

        this.append(position);
        this.append(rotation);
        this.append(scale);

        const toArray = (v: Vec3) => {
            return [v.x, v.y, v.z];
        };

        let uiUpdating = false;
        let mouseUpdating = false;
        let scaleLocked = true;
        let scaleRatio = [1, 1, 1];
        let applyingScaleLock = false;

        // Toggle lock state
        scaleLock.on('click', () => {
            scaleLocked = !scaleLocked;
            if (scaleLocked) {
                const s = scaleVector.value;
                scaleRatio = [1, s[1] / s[0], s[2] / s[0]];
                // Swap to locked icon
                scaleLock.dom.removeChild(scaleLock.dom.firstChild);
                scaleLock.dom.appendChild(createSvg(lockSvg));
            } else {
                // Swap back to open icon
                scaleLock.dom.removeChild(scaleLock.dom.firstChild);
                scaleLock.dom.appendChild(createSvg(lockOpenSvg));
            }
        });

        // update UI with pivot
        const updateUI = (pivot: Pivot) => {
            uiUpdating = true;
            const transform = pivot.transform;
            transform.rotation.getEulerAngles(v);

            if (events.invoke('pivot.detached') && originBase) {
                // 「仅控制原点」模式：显示相对文件默认 gizmo 位置的偏移
                positionVector.value = [
                    transform.position.x - originBase.position.x,
                    transform.position.y - originBase.position.y,
                    transform.position.z - originBase.position.z
                ];
            } else {
                positionVector.value = toArray(transform.position);
            }

            rotationVector.value = toArray(v);
            scaleVector.value = toArray(transform.scale);
            (scaleVector as any)._lastValue = [...scaleVector.value];
            uiUpdating = false;
        };

        // update pivot with UI
        const updatePivot = (pivot: Pivot) => {
            const p = positionVector.value;
            const r = rotationVector.value;
            const s = scaleVector.value;
            const q = new Quat().setFromEulerAngles(r[0], r[1], r[2]);

            if (q.w < 0) {
                q.mulScalar(-1);
            }

            // 「仅控制原点」模式：面板输入的是相对偏移，加回基准位置
            let pos = new Vec3(p[0], p[1], p[2]);
            if (events.invoke('pivot.detached') && originBase) {
                pos = new Vec3(
                    originBase.position.x + p[0],
                    originBase.position.y + p[1],
                    originBase.position.z + p[2]
                );
            }

            pivot.moveTRS(pos, q, new Vec3(s[0], s[1], s[2]));
        };

        // handle pos/rot change
        const onChangeGeneral = () => {
            if (!uiUpdating) {
                const pivot = events.invoke('pivot') as Pivot;
                if (mouseUpdating) {
                    updatePivot(pivot);
                } else {
                    pivot.start();
                    updatePivot(pivot);
                    pivot.end();
                }
            }
        };

        // handle scale change with lock support
        const onChangeScale = () => {
            if (uiUpdating) return;

            if (scaleLocked && !applyingScaleLock) {
                applyingScaleLock = true;
                const s = scaleVector.value as number[];
                const oldS = (scaleVector as any)._lastValue || [1, 1, 1];

                if (s[0] !== oldS[0]) {
                    scaleVector.value = [s[0], s[0] * scaleRatio[1], s[0] * scaleRatio[2]];
                } else if (s[1] !== oldS[1]) {
                    const newX = s[1] / scaleRatio[1];
                    scaleVector.value = [newX, s[1], newX * scaleRatio[2]];
                } else if (s[2] !== oldS[2]) {
                    const newX = s[2] / scaleRatio[2];
                    scaleVector.value = [newX, newX * scaleRatio[1], s[2]];
                }

                applyingScaleLock = false;
            }

            (scaleVector as any)._lastValue = [...(scaleVector.value as number[])];

            const pivot = events.invoke('pivot') as Pivot;
            if (mouseUpdating) {
                updatePivot(pivot);
            } else {
                pivot.start();
                updatePivot(pivot);
                pivot.end();
            }
        };

        const mousedown = () => {
            mouseUpdating = true;
            const pivot = events.invoke('pivot') as Pivot;
            pivot.start();
        };

        const mouseup = () => {
            const pivot = events.invoke('pivot') as Pivot;
            updatePivot(pivot);
            mouseUpdating = false;
            pivot.end();
        };

        const bindEvents = (vector: any, onChange: () => void) => {
            vector.inputs.forEach((input: any) => {
                input.on('change', onChange);
                input.on('slider:mousedown', mousedown);
                input.on('slider:mouseup', mouseup);
            });
        };

        bindEvents(positionVector, onChangeGeneral);
        bindEvents(rotationVector, onChangeGeneral);
        bindEvents(scaleVector, onChangeScale);

        // 记录选中物体的初始 transform（用于撤回按钮恢复）
        let initialTransform: TRSTransform | null = null;

        // 「仅控制原点」模式的基准：文件默认 gizmo 位置（动态计算，
        // 跟随文件本身的移动 —— 与 placePivot 同源的 getPivot 结果）
        const defaultPivotT = new TRSTransform();
        let originBase: TRSTransform | null = null;

        const computeDefaultOrigin = () => {
            const selection = events.invoke('selection') as any;
            if (selection && (selection as any).getPivot) {
                const mode = events.invoke('pivot.origin') === 'center' ? 'center' : 'boundCenter';
                selection.getPivot(mode, false, defaultPivotT);
                originBase = new TRSTransform(
                    defaultPivotT.position.clone(),
                    defaultPivotT.rotation.clone(),
                    defaultPivotT.scale.clone()
                );
            } else {
                originBase = null;
            }
        };

        const captureInitialTransform = (selection: any) => {
            if (selection && (selection as any).entity) {
                const entity = (selection as any).entity;
                initialTransform = new TRSTransform(
                    entity.getLocalPosition(),
                    entity.getLocalRotation(),
                    entity.getLocalScale()
                );
            } else if (selection && (selection as any).getPivot) {
                // 形状（BoxShape/SphereShape）等无 entity 的元素：使用 pivot 当前值
                const pivot = events.invoke('pivot') as Pivot;
                if (pivot) {
                    initialTransform = new TRSTransform(
                        pivot.transform.position,
                        pivot.transform.rotation,
                        pivot.transform.scale
                    );
                }
            } else {
                initialTransform = null;
            }
        };

        // toggle ui availability based on selection
        events.on('selection.changed', (selection) => {
            positionVector.enabled = rotationVector.enabled = scaleVector.enabled = !!selection;
            captureInitialTransform(selection);
            computeDefaultOrigin();
        });

        events.on('selection.shapeChanged', (selection) => {
            positionVector.enabled = rotationVector.enabled = scaleVector.enabled = !!selection;
            captureInitialTransform(selection);
            computeDefaultOrigin();
        });

        events.on('pivot.placed', (pivot: Pivot) => {
            computeDefaultOrigin();
            updateUI(pivot);
        });

        events.on('pivot.moved', (pivot: Pivot) => {
            if (!mouseUpdating) {
                // 非控制原点模式下，文件本体随 gizmo 移动，默认位置需要跟随刷新；
                // 控制原点模式下文件不动，基准保持不变
                if (!events.invoke('pivot.detached')) {
                    computeDefaultOrigin();
                }
                updateUI(pivot);
            }
        });

        events.on('pivot.ended', (pivot: Pivot) => {
            if (!events.invoke('pivot.detached')) {
                computeDefaultOrigin();
            }
            updateUI(pivot);
        });
    }
}

export { Transform };
