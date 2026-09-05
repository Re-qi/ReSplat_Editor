import { Container, Element, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { localize } from './localization';
import chevronDownSvg from './svg/chevron-down.svg';
import chevronUpSvg from './svg/chevron-up.svg';
import paintbrushSvg from './svg/paintbrush.svg';
import sliceSvg from './svg/slice.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

type EditorMode = 'edit' | 'paint';

/** Edit/paint mode selector. It owns the mode-toggle id and its dropdown. */
class ModeToggle extends Container {
    constructor(events: Events, _tooltips: Tooltips, args = {}) {
        args = {
            id: 'mode-toggle',
            ...args
        };

        super(args);

        const editIcon = new Element({
            id: 'mode-edit-icon',
            dom: createSvg(sliceSvg)
        });
        const paintIcon = new Element({
            id: 'mode-paint-icon',
            dom: createSvg(paintbrushSvg)
        });
        const editText = new Label({
            id: 'mode-edit-text',
            text: localize('panel.mode.edit')
        });
        const paintText = new Label({
            id: 'mode-paint-text',
            text: localize('panel.mode.paint')
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

        const editOption = new Container({
            class: ['mode-dropdown-item', 'active']
        });
        editOption.append(new Element({
            class: 'mode-dropdown-icon',
            dom: createSvg(sliceSvg)
        }));
        editOption.append(new Label({
            text: localize('panel.mode.edit')
        }));

        const paintOption = new Container({
            class: 'mode-dropdown-item'
        });
        paintOption.append(new Element({
            class: 'mode-dropdown-icon',
            dom: createSvg(paintbrushSvg)
        }));
        paintOption.append(new Label({
            text: localize('panel.mode.paint')
        }));

        dropdownMenu.append(editOption);
        dropdownMenu.append(paintOption);
        dropdownMenu.hidden = true;

        this.append(editIcon);
        this.append(paintIcon);
        this.append(editText);
        this.append(paintText);
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
            this.dom.setAttribute('aria-expanded', String(!dropdownMenu.hidden));
        };
        const observer = new MutationObserver(updateDropdownState);
        observer.observe(dropdownMenu.dom, { attributes: true, attributeFilter: ['class'] });
        updateDropdownState();

        this.dom.setAttribute('aria-haspopup', 'menu');
        let pointerId: number | null = null;

        const clearLongPressHover = () => {
            editOption.class.remove('longpress-hover');
            paintOption.class.remove('longpress-hover');
        };

        const optionAtPoint = (clientX: number, clientY: number) => {
            const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
            if (!element || !dropdownMenu.dom.contains(element)) return null;
            const option = element.closest('.mode-dropdown-item');
            if (option === editOption.dom) return editOption;
            if (option === paintOption.dom) return paintOption;
            return null;
        };

        const updateLongPressHover = (clientX: number, clientY: number) => {
            clearLongPressHover();
            const option = optionAtPoint(clientX, clientY);
            if (option && !option.class.contains('disabled')) option.class.add('longpress-hover');
        };

        const selectOption = (option: Container) => {
            if (option === editOption) {
                events.fire('mode.set', 'edit');
            } else if (option === paintOption && !paintBusy) {
                events.fire('mode.set', 'paint');
            }
            dropdownMenu.hidden = true;
            clearLongPressHover();
        };

        this.dom.addEventListener('pointerdown', (event: PointerEvent) => {
            if (event.button !== 0 || paintBusy) return;
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
            if (option && !option.class.contains('disabled')) {
                selectOption(option);
            } else {
                clearLongPressHover();
            }
        });

        document.addEventListener('pointerdown', () => {
            dropdownMenu.hidden = true;
        });

        let paintBusy = false;

        const updateAccessibilityLabel = (mode: EditorMode) => {
            this.dom.setAttribute('aria-label', localize(mode === 'paint' ? 'panel.mode.paint' : 'panel.mode.edit'));
        };

        const updateAvailability = () => {
            const mode = (events.invoke('mode.active') as EditorMode) ?? 'edit';

            this.class[mode === 'paint' ? 'add' : 'remove']('paint-mode');
            this.class[paintBusy ? 'add' : 'remove']('disabled');
            this.dom.setAttribute('aria-disabled', String(paintBusy));
            editIcon.hidden = mode === 'paint';
            editText.hidden = mode === 'paint';
            paintIcon.hidden = mode !== 'paint';
            paintText.hidden = mode !== 'paint';
            editOption.class[mode === 'edit' ? 'add' : 'remove']('active');
            paintOption.class[mode === 'paint' ? 'add' : 'remove']('active');
            paintOption.class[paintBusy ? 'add' : 'remove']('disabled');
            paintOption.dom.setAttribute('aria-disabled', String(paintBusy));
            updateAccessibilityLabel(mode);
        };

        events.on('paint.busy', (busy: boolean) => {
            paintBusy = busy;
            updateAvailability();
        });
        events.on('mode.changed', updateAvailability);

        requestAnimationFrame(updateAvailability);
    }
}

export { ModeToggle };
