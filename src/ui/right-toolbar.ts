import { Button, Container, Element } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { localize, formatTooltipWithShortcut } from './localization';
import cameraFrameSelectionSvg from './svg/camera-frame-selection.svg';
import cameraResetSvg from './svg/camera-reset.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class RightToolbar extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'right-toolbar'
        };

        super(args);

        this.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const cameraFrameSelection = new Button({
            id: 'right-toolbar-frame-selection',
            class: 'right-toolbar-button'
        });

        const cameraReset = new Button({
            id: 'right-toolbar-camera-origin',
            class: 'right-toolbar-button'
        });

        cameraFrameSelection.dom.appendChild(createSvg(cameraFrameSelectionSvg));
        cameraReset.dom.appendChild(createSvg(cameraResetSvg));

        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(cameraFrameSelection);
        this.append(cameraReset);

        // Helper to compose localized tooltip text with shortcut
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const tooltip = (localeKey: string, shortcutId?: string) => {
            const text = localize(localeKey);
            if (shortcutId) {
                const shortcut = shortcutManager.formatShortcut(shortcutId);
                if (shortcut) {
                    return formatTooltipWithShortcut(text, shortcut);
                }
            }
            return text;
        };

        tooltips.register(cameraFrameSelection, tooltip('tooltip.right-toolbar.frame-selection', 'camera.focus'), 'bottom');
        tooltips.register(cameraReset, tooltip('tooltip.right-toolbar.reset-camera', 'camera.reset'), 'bottom');

        cameraFrameSelection.on('click', () => events.fire('camera.focus'));
        cameraReset.on('click', () => events.fire('camera.reset'));
    }
}

export { RightToolbar };
