import { Button, Container, NumericInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { localize } from '../ui/localization';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

class SizeSelection {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, _parent: HTMLElement, canvasContainer: Container) {
        let threshold = 0.01;

        const selectToolbar = new Container({
            class: 'select-toolbar',
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const thresholdInput = new NumericInput({
            value: threshold,
            placeholder: localize('toolbar.size.threshold'),
            width: 120,
            precision: 4,
            min: 0,
            max: 10
        });

        const selectButton = new Button({
            text: localize('toolbar.select.sizeLeq'),
            width: 60
        });

        const selectGeqButton = new Button({
            text: localize('toolbar.select.sizeGeq'),
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
        selectToolbar.append(selectGeqButton);
        selectToolbar.append(addButton);
        selectToolbar.append(removeButton);
        canvasContainer.append(selectToolbar);

        thresholdInput.on('change', () => {
            threshold = clamp(thresholdInput.value ?? threshold, 0, 10);
        });

        selectButton.on('click', () => {
            events.fire('select.sizeThreshold', 'set', threshold, 'leq');
        });

        selectGeqButton.on('click', () => {
            events.fire('select.sizeThreshold', 'set', threshold, 'geq');
        });

        addButton.on('click', () => {
            events.fire('select.sizeThreshold', 'add', threshold, 'leq');
        });

        removeButton.on('click', () => {
            events.fire('select.sizeThreshold', 'remove', threshold, 'leq');
        });

        this.activate = () => {
            selectToolbar.hidden = false;
        };

        this.deactivate = () => {
            selectToolbar.hidden = true;
        };
    }
}

export { SizeSelection };
