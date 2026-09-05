import { Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { localize } from './localization';
import paletteSvg from './svg/palette.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

/**
 * Color adjustment entry point. The depth display control used to live beside
 * this button; it is intentionally removed from the UI, while the underlying
 * display-mode event remains available to preserve existing integrations.
 */
class ModeSwitch extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            id: 'mode-switch',
            ...args
        };

        super(args);

        this.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const colorModeBtn = new Container({
            id: 'color-mode-btn',
            class: 'mode-switch-btn'
        });
        const colorIcon = new Container({
            class: 'mode-switch-icon'
        });
        colorIcon.dom.appendChild(createSvg(paletteSvg));
        const colorText = new Label({
            text: localize('panel.mode.color'),
            class: 'mode-switch-text'
        });
        colorModeBtn.append(colorIcon);
        colorModeBtn.append(colorText);

        colorModeBtn.on('click', () => {
            events.fire('view.displayMode', 'color');
            events.fire('colorPanel.toggleVisible');
        });

        events.on('colorPanel.displayVisible', (visible: boolean) => {
            colorModeBtn.class[visible ? 'add' : 'remove']('active');
        });

        this.append(colorModeBtn);
        tooltips.register(colorModeBtn, localize('panel.mode.color'), 'bottom');
    }
}

export { ModeSwitch };
