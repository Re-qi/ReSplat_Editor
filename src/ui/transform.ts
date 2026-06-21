import { Button, Container, ContainerArgs, Label, VectorInput } from '@playcanvas/pcui';
import { Quat, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { localize } from './localization';
import { Pivot } from '../pivot';
import lockOpenSvg from './svg/lock-keyhole-open.svg';
import lockSvg from './svg/lock-keyhole.svg';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

const v = new Vec3();

class Transform extends Container {
    constructor(events: Events, args: ContainerArgs = {}) {
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

        const positionVector = new VectorInput({
            class: 'transform-expand',
            precision: 3,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [0, 0, 0],
            enabled: false
        });

        position.append(positionLabel);
        position.append(positionVector);

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
            positionVector.value = toArray(transform.position);
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

            pivot.moveTRS(new Vec3(p[0], p[1], p[2]), q, new Vec3(s[0], s[1], s[2]));
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

        // toggle ui availability based on selection
        events.on('selection.changed', (selection) => {
            positionVector.enabled = rotationVector.enabled = scaleVector.enabled = !!selection;
        });

        events.on('selection.shapeChanged', (selection) => {
            positionVector.enabled = rotationVector.enabled = scaleVector.enabled = !!selection;
        });

        events.on('pivot.placed', (pivot: Pivot) => {
            updateUI(pivot);
        });

        events.on('pivot.moved', (pivot: Pivot) => {
            if (!mouseUpdating) {
                updateUI(pivot);
            }
        });

        events.on('pivot.ended', (pivot: Pivot) => {
            updateUI(pivot);
        });
    }
}

export { Transform };
