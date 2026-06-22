import { Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { localize } from './localization';
import { Tooltips } from './tooltips';
import squircleDashedSvg from './svg/squircle-dashed.svg';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class OverlayToggle extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            id: 'overlay-toggle',
            ...args
        };

        super(args);

        this.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const overlayBtn = new Container({
            class: ['overlay-toggle-btn']
        });
        const overlayIcon = new Container({
            class: 'overlay-toggle-icon'
        });
        overlayIcon.dom.appendChild(createSvg(squircleDashedSvg));
        const overlayText = new Label({
            text: localize('panel.mode.overlay'),
            class: 'overlay-toggle-text'
        });
        overlayBtn.append(overlayIcon);
        overlayBtn.append(overlayText);

        overlayBtn.on('click', () => {
            events.fire('camera.toggleOverlay');
        });

        events.on('camera.overlay', (enabled: boolean) => {
            overlayBtn.class[enabled ? 'add' : 'remove']('active');
        });

        this.append(overlayBtn);

        tooltips.register(overlayBtn, `${localize('panel.mode.overlay')}（Alt+Z）`, 'bottom');
    }
}

export { OverlayToggle };
