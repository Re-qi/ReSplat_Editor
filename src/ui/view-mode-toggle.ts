import { Container, Element, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { localize } from './localization';
import centersSvg from './svg/centers.svg';
import chevronDownSvg from './svg/chevron-down.svg';
import chevronUpSvg from './svg/chevron-up.svg';
import circleSvg from './svg/circle.svg';
import ringsSvg from './svg/rings.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

/** Render representation selector (splat, centers or rings). */
class ViewModeToggle extends Container {
    constructor(events: Events, _tooltips: Tooltips, args = {}) {
        args = {
            id: 'view-mode-toggle',
            class: 'splat-mode',
            ...args
        };

        super(args);

        const centersIcon = new Element({
            id: 'view-centers-icon',
            dom: createSvg(centersSvg)
        });
        const ringsIcon = new Element({
            id: 'view-rings-icon',
            dom: createSvg(ringsSvg)
        });
        const splatIcon = new Element({
            id: 'view-splat-icon',
            dom: createSvg(circleSvg)
        });

        const centersText = new Label({
            id: 'view-centers-text',
            text: localize('panel.mode.centers')
        });
        const ringsText = new Label({
            id: 'view-rings-text',
            text: localize('panel.mode.rings')
        });
        const splatText = new Label({
            id: 'view-splat-text',
            text: localize('panel.mode.splat')
        });

        const chevronDownDom = createSvg(chevronDownSvg);
        const chevronUpDom = createSvg(chevronUpSvg);
        const dropdownBtn = new Element({
            id: 'view-mode-dropdown-btn',
            dom: chevronDownDom
        });
        const dropdownMenu = new Container({
            id: 'view-mode-dropdown-menu'
        });

        const makeOption = (icon: string, text: string) => {
            const option = new Container({
                class: 'view-mode-dropdown-item'
            });
            option.append(new Element({
                class: 'view-mode-dropdown-icon',
                dom: createSvg(icon)
            }));
            option.append(new Label({ text }));
            return option;
        };

        const centersOption = makeOption(centersSvg, localize('panel.mode.centers'));
        const ringsOption = makeOption(ringsSvg, localize('panel.mode.rings'));
        const splatOption = makeOption(circleSvg, localize('panel.mode.splat'));
        splatOption.class.add('active');

        dropdownMenu.append(splatOption);
        dropdownMenu.append(centersOption);
        dropdownMenu.append(ringsOption);
        dropdownMenu.hidden = true;

        this.append(splatIcon);
        this.append(centersIcon);
        this.append(ringsIcon);
        this.append(splatText);
        this.append(centersText);
        this.append(ringsText);
        this.append(dropdownBtn);
        this.append(dropdownMenu);

        const chevronDownPath = chevronDownDom.querySelector('path')?.getAttribute('d');
        const chevronUpPath = chevronUpDom.querySelector('path')?.getAttribute('d');
        const updateDropdownState = () => {
            const path = dropdownBtn.dom.querySelector('path');
            if (path) {
                path.setAttribute('d', dropdownMenu.hidden ? chevronDownPath! : chevronUpPath!);
            }
            dropdownBtn.class[dropdownMenu.hidden ? 'remove' : 'add']('open');
        };
        const observer = new MutationObserver(updateDropdownState);
        observer.observe(dropdownMenu.dom, { attributes: true, attributeFilter: ['class'] });
        updateDropdownState();

        let pointerId: number | null = null;

        const clearLongPressHover = () => {
            centersOption.class.remove('longpress-hover');
            ringsOption.class.remove('longpress-hover');
            splatOption.class.remove('longpress-hover');
        };

        const optionAtPoint = (clientX: number, clientY: number) => {
            const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
            if (!element || !dropdownMenu.dom.contains(element)) return null;
            const option = element.closest('.view-mode-dropdown-item');
            if (option === centersOption.dom) return centersOption;
            if (option === ringsOption.dom) return ringsOption;
            if (option === splatOption.dom) return splatOption;
            return null;
        };

        const updateLongPressHover = (clientX: number, clientY: number) => {
            clearLongPressHover();
            const option = optionAtPoint(clientX, clientY);
            option?.class.add('longpress-hover');
        };

        const selectOption = (option: Container) => {
            const mode = option === centersOption ? 'centers' : option === ringsOption ? 'rings' : 'splat';
            events.fire('camera.setMode', mode);
            dropdownMenu.hidden = true;
            clearLongPressHover();
        };

        this.dom.addEventListener('pointerdown', (event: PointerEvent) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            pointerId = event.pointerId;
            const option = optionAtPoint(event.clientX, event.clientY);
            if (!option) dropdownMenu.hidden = !dropdownMenu.hidden;
            updateLongPressHover(event.clientX, event.clientY);
        });

        document.addEventListener('pointermove', (event: PointerEvent) => {
            if (event.pointerId !== pointerId) return;
            updateLongPressHover(event.clientX, event.clientY);
        });

        document.addEventListener('pointerup', (event: PointerEvent) => {
            if (event.pointerId !== pointerId) return;
            const option = optionAtPoint(event.clientX, event.clientY);
            pointerId = null;
            if (option) {
                selectOption(option);
            } else {
                clearLongPressHover();
            }
        });

        document.addEventListener('pointerdown', () => {
            dropdownMenu.hidden = true;
        });

        events.on('camera.mode', (mode: string) => {
            this.class[mode === 'centers' ? 'add' : 'remove']('centers-mode');
            this.class[mode === 'rings' ? 'add' : 'remove']('rings-mode');
            this.class[mode === 'splat' ? 'add' : 'remove']('splat-mode');
            centersOption.class[mode === 'centers' ? 'add' : 'remove']('active');
            ringsOption.class[mode === 'rings' ? 'add' : 'remove']('active');
            splatOption.class[mode === 'splat' ? 'add' : 'remove']('active');
        });
    }
}

export { ViewModeToggle };
