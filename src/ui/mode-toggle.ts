import { Container, Element, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { localize } from './localization';
import centersSvg from './svg/centers.svg';
import chevronDownSvg from './svg/chevron-down.svg';
import chevronUpSvg from './svg/chevron-up.svg';
import ringsSvg from './svg/rings.svg';
import circleSvg from './svg/circle.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class ModeToggle extends Container {
    constructor(events: Events, _tooltips: Tooltips, args = {}) {
        args = {
            id: 'mode-toggle',
            class: 'splat-mode',
            ...args
        };

        super(args);

        const centersIcon = new Element({
            id: 'centers-icon',
            dom: createSvg(centersSvg)
        });

        const ringsIcon = new Element({
            id: 'rings-icon',
            dom: createSvg(ringsSvg)
        });

        const splatIcon = new Element({
            id: 'splat-icon',
            dom: createSvg(circleSvg)
        });

        const centersText = new Label({
            id: 'centers-text',
            text: localize('panel.mode.centers')
        });

        const ringsText = new Label({
            id: 'rings-text',
            text: localize('panel.mode.rings')
        });

        const splatText = new Label({
            id: 'splat-text',
            text: localize('panel.mode.splat')
        });

        const chevronDownDom = createSvg(chevronDownSvg);
        const chevronUpDom = createSvg(chevronUpSvg);

        const dropdownBtn = new Element({
            id: 'mode-dropdown-btn',
            dom: chevronDownDom
        });

        const dropdownMenu = new Container({
            id: 'mode-dropdown-menu'
        });

        const centersOption = new Container({
            class: 'mode-dropdown-item'
        });
        const centersOptionIcon = new Element({
            class: 'mode-dropdown-icon',
            dom: createSvg(centersSvg)
        });
        const centersOptionText = new Label({
            text: localize('panel.mode.centers')
        });
        centersOption.append(centersOptionIcon);
        centersOption.append(centersOptionText);

        const ringsOption = new Container({
            class: 'mode-dropdown-item'
        });
        const ringsOptionIcon = new Element({
            class: 'mode-dropdown-icon',
            dom: createSvg(ringsSvg)
        });
        const ringsOptionText = new Label({
            text: localize('panel.mode.rings')
        });
        ringsOption.append(ringsOptionIcon);
        ringsOption.append(ringsOptionText);

        const splatOption = new Container({
            class: ['mode-dropdown-item', 'active']
        });
        const splatOptionIcon = new Element({
            class: 'mode-dropdown-icon',
            dom: createSvg(circleSvg)
        });
        const splatOptionText = new Label({
            text: localize('panel.mode.splat')
        });
        splatOption.append(splatOptionIcon);
        splatOption.append(splatOptionText);

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

        const chevronDownPath = chevronDownDom.querySelector('path')!.getAttribute('d');
        const chevronUpPath = chevronUpDom.querySelector('path')!.getAttribute('d');

        const observer = new MutationObserver(() => {
            const path = dropdownBtn.dom.querySelector('path');
            if (path) {
                path.setAttribute('d', dropdownMenu.hidden ? chevronDownPath! : chevronUpPath!);
            }
            dropdownBtn.class[dropdownMenu.hidden ? 'remove' : 'add']('open');
        });

        observer.observe(dropdownMenu.dom, { attributes: true, attributeFilter: ['class'] });

        this.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
            dropdownMenu.hidden = !dropdownMenu.hidden;
        });

        centersOption.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
            events.fire('camera.setMode', 'centers');
            dropdownMenu.hidden = true;
        });

        ringsOption.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
            events.fire('camera.setMode', 'rings');
            dropdownMenu.hidden = true;
        });

        splatOption.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
            events.fire('camera.setMode', 'splat');
            dropdownMenu.hidden = true;
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

export { ModeToggle };
