import { Button, Container, NumericInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { localize } from '../ui/localization';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

class OpacitySelection {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, _parent: HTMLElement, canvasContainer: Container) {
        let threshold = 0.1;

        const selectToolbar = new Container({
            class: 'select-toolbar',
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const thresholdInput = new NumericInput({
            value: threshold,
            placeholder: localize('toolbar.opacity.threshold'),
            width: 120,
            precision: 3,
            min: 0,
            max: 1
        });

        const selectButton = new Button({
            text: localize('toolbar.select.set'),
            width: 60
        });

        const addButton = new Button({
            text: localize('toolbar.select.add'),
            width: 60
        });

        const removeButton = new Button({
            text: localize('toolbar.select.remove'),
            width: 70
        });

        selectToolbar.append(thresholdInput);
        selectToolbar.append(selectButton);
        selectToolbar.append(addButton);
        selectToolbar.append(removeButton);
        canvasContainer.append(selectToolbar);

        thresholdInput.on('change', () => {
            threshold = clamp01(thresholdInput.value ?? threshold);
        });

        selectButton.on('click', () => {
            events.fire('select.opacityThreshold', 'set', threshold);
        });

        addButton.on('click', () => {
            events.fire('select.opacityThreshold', 'add', threshold);
        });

        removeButton.on('click', () => {
            events.fire('select.opacityThreshold', 'remove', threshold);
        });

        this.activate = () => {
            selectToolbar.hidden = false;
        };

        this.deactivate = () => {
            selectToolbar.hidden = true;
        };
    }
}

export { OpacitySelection };
