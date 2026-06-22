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
        });

        // ---- Long-press / drag-to-select interaction ----
        // Hold down on mode-toggle → after 200ms (or right-drag ≥20px) → open
        // dropdown → drag to an item → release to select that mode.
        let longPressTimer: ReturnType<typeof setTimeout> | null = null;
        let isLongPressDrag = false;
        let dragStartX = 0;
        const SWIPE_THRESHOLD = 20;

        const modeActions: Array<{ element: HTMLElement; mode: string }> = [
            { element: splatOption.dom, mode: 'splat' },
            { element: centersOption.dom, mode: 'centers' },
            { element: ringsOption.dom, mode: 'rings' }
        ];

        const findModeItemAtPoint = (x: number, y: number) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return null;
            for (const item of modeActions) {
                if (item.element === el || item.element.contains(el)) {
                    return item;
                }
            }
            return null;
        };

        const cleanupDrag = () => {
            isLongPressDrag = false;
            dropdownMenu.hidden = true;
            document.removeEventListener('mouseup', onDocMouseUpCapture, true);
            document.removeEventListener('mousemove', onDocMouseMove, true);
            for (const item of modeActions) {
                item.element.classList.remove('longpress-hover');
            }
        };

        const onDocMouseMove = (e: MouseEvent) => {
            const hovered = findModeItemAtPoint(e.clientX, e.clientY);
            for (const item of modeActions) {
                item.element.classList.toggle('longpress-hover', item === hovered);
            }
        };

        const onDocMouseUpCapture = (e: MouseEvent) => {
            if (e.button !== 0) return;
            const hit = findModeItemAtPoint(e.clientX, e.clientY);
            if (hit) {
                events.fire('camera.setMode', hit.mode);
            }
            cleanupDrag();
        };

        const startDrag = () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            isLongPressDrag = true;
            dropdownMenu.hidden = false;
            document.addEventListener('mouseup', onDocMouseUpCapture, true);
            document.addEventListener('mousemove', onDocMouseMove, true);
        };

        this.dom.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            isLongPressDrag = false;
            dragStartX = e.clientX;
            longPressTimer = setTimeout(startDrag, 200);
        });

        this.dom.addEventListener('mousemove', (e) => {
            if (isLongPressDrag || !longPressTimer) return;
            if (e.clientX - dragStartX >= SWIPE_THRESHOLD) {
                startDrag();
                // highlight item under cursor after popup shown
                const hovered = findModeItemAtPoint(e.clientX, e.clientY);
                for (const item of modeActions) {
                    item.element.classList.toggle('longpress-hover', item === hovered);
                }
            }
        });

        this.dom.addEventListener('mouseup', (e) => {
            if (e.button !== 0) return;
            if (isLongPressDrag) return;
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
                // Short click: toggle dropdown
                dropdownMenu.hidden = !dropdownMenu.hidden;
            }
        });

        this.dom.addEventListener('mouseleave', () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        });

        // Click outside closes dropdown (skip during drag)
        document.addEventListener('pointerdown', (e) => {
            if (isLongPressDrag) return;
            if (!this.dom.contains(e.target as Node)) {
                dropdownMenu.hidden = true;
            }
        });

        // ---- Click handlers for dropdown items (for normal click users) ----

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
