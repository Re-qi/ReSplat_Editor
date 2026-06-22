import { Container, Label, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { localize } from './localization';
import { Tooltips } from './tooltips';
import circleSvg from './svg/circle.svg';
import circleDashedSvg from './svg/circle-dashed.svg';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

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
            class: 'mode-switch-btn'
        });
        const colorIcon = new Container({
            class: 'mode-switch-icon'
        });
        colorIcon.dom.appendChild(createSvg(circleSvg));
        const colorText = new Label({
            text: localize('panel.mode.color'),
            class: 'mode-switch-text'
        });
        colorModeBtn.append(colorIcon);
        colorModeBtn.append(colorText);
        colorModeBtn.class.add('active');

        const depthModeBtn = new Container({
            class: 'mode-switch-btn'
        });
        const depthIcon = new Container({
            class: 'mode-switch-icon'
        });
        depthIcon.dom.appendChild(createSvg(circleDashedSvg));
        const depthText = new Label({
            text: localize('panel.mode.depth'),
            class: 'mode-switch-text'
        });
        depthModeBtn.append(depthIcon);
        depthModeBtn.append(depthText);

        // depth fmod range popup
        const depthPopup = new Container({
            id: 'depth-cycle-popup'
        });

        const depthLabel = new Label({
            text: '深度fmod范围',
            class: 'depth-cycle-popup-label'
        });

        const depthSlider = new SliderInput({
            class: 'depth-cycle-popup-slider',
            min: 1,
            max: 100,
            precision: 0,
            value: 50
        });

        const setDepthCycleLength = (value: number) => {
            events.fire('view.setDepthCycleLength', value);
        };

        events.on('view.depthCycleLength', (value: number) => {
            depthSlider.value = value;
        });

        depthSlider.on('change', (value: number) => {
            setDepthCycleLength(value);
            resetHideTimeout();
        });

        depthPopup.append(depthLabel);
        depthPopup.append(depthSlider);
        depthPopup.dom.style.display = 'none';
        this.append(depthPopup);

        // Auto-hide popup after 1s of inactivity
        let hideTimeout: ReturnType<typeof setTimeout> | null = null;
        let popupHovered = false;

        const resetHideTimeout = () => {
            if (hideTimeout) {
                clearTimeout(hideTimeout);
                hideTimeout = null;
            }
            hideTimeout = setTimeout(() => {
                hideTimeout = null;
                // Don't hide if hovered or input focused
                if (depthPopup.dom.style.display !== 'none' && !popupHovered) {
                    const active = document.activeElement;
                    if (!depthPopup.dom.contains(active)) {
                        depthPopup.dom.style.display = 'none';
                    } else {
                        resetHideTimeout();
                    }
                }
            }, 1000);
        };

        const showDepthPopup = () => {
            depthPopup.dom.style.display = '';
            resetHideTimeout();
        };

        // Pause hide timer while hovering over popup
        depthPopup.dom.addEventListener('mouseenter', () => {
            popupHovered = true;
            if (hideTimeout) {
                clearTimeout(hideTimeout);
                hideTimeout = null;
            }
        });
        depthPopup.dom.addEventListener('mouseleave', () => {
            popupHovered = false;
            resetHideTimeout();
        });

        // Reset timer on any interaction with the popup
        depthPopup.dom.addEventListener('pointerdown', () => {
            resetHideTimeout();
        });
        depthPopup.dom.addEventListener('pointermove', (e: PointerEvent) => {
            if (e.buttons) {
                resetHideTimeout();
            }
        });
        depthPopup.dom.addEventListener('input', () => {
            resetHideTimeout();
        });
        depthPopup.dom.addEventListener('focusin', () => {
            resetHideTimeout();
        });


        colorModeBtn.on('click', () => {
            const wasActive = colorModeBtn.class.contains('active');
            colorModeBtn.class.add('active');
            depthModeBtn.class.remove('active');
            depthPopup.dom.style.display = 'none';
            if (hideTimeout) {
                clearTimeout(hideTimeout);
                hideTimeout = null;
            }
            if (wasActive) {
                // Already in color mode, toggle color panel visibility
                events.fire('colorPanel.toggleVisible');
            } else {
                events.fire('view.displayMode', 'color');
            }
        });

        depthModeBtn.on('click', () => {
            colorModeBtn.class.remove('active');
            depthModeBtn.class.add('active');
            showDepthPopup();
            events.fire('view.displayMode', 'depth');
        });

        events.on('view.displayMode', (mode: 'color' | 'depth') => {
            if (mode === 'depth') {
                colorModeBtn.class.remove('active');
                depthModeBtn.class.add('active');
                showDepthPopup();
            } else {
                colorModeBtn.class.add('active');
                depthModeBtn.class.remove('active');
                depthPopup.dom.style.display = 'none';
                if (hideTimeout) {
                    clearTimeout(hideTimeout);
                    hideTimeout = null;
                }
            }
        });

        this.append(colorModeBtn);
        this.append(depthModeBtn);

        tooltips.register(colorModeBtn, localize('panel.mode.color'), 'bottom');
        tooltips.register(depthModeBtn, localize('panel.mode.depth'), 'bottom');
    }
}

export { ModeSwitch };
