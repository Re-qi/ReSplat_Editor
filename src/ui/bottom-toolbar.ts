import { Button, Element, Container } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { localize, formatTooltipWithShortcut } from './localization';
import redoSvg from './svg/redo.svg';
import brushSvg from './svg/select-brush.svg';
import eyedropperSvg from './svg/select-eyedropper.svg';
import floodSvg from './svg/select-flood.svg';
import lassoSvg from './svg/select-lasso.svg';
import opacitySvg from './svg/select-opacity.svg';
import pickerSvg from './svg/select-picker.svg';
import polygonSvg from './svg/select-poly.svg';
import sizeSvg from './svg/select-inverse.svg';
import undoSvg from './svg/undo.svg';
import translateSvg from './svg/move.svg';
import rotateSvg from './svg/rotate.svg';
import scaleSvg from './svg/scale.svg';
import measureSvg from './svg/ruler.svg';
import coordSpaceSvg from './svg/compass.svg';
import originSvg from './svg/origin.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class BottomToolbar extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'bottom-toolbar'
        };

        super(args);

        this.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const undo = new Button({
            id: 'bottom-toolbar-undo',
            class: 'bottom-toolbar-button',
            enabled: false
        });

        const redo = new Button({
            id: 'bottom-toolbar-redo',
            class: 'bottom-toolbar-button',
            enabled: false
        });

        const picker = new Button({
            id: 'bottom-toolbar-picker',
            class: 'bottom-toolbar-tool'
        });

        const polygon = new Button({
            id: 'bottom-toolbar-polygon',
            class: 'bottom-toolbar-tool'
        });

        const brush = new Button({
            id: 'bottom-toolbar-brush',
            class: 'bottom-toolbar-tool'
        });

        const flood = new Button({
            id: 'bottom-toolbar-flood',
            class: 'bottom-toolbar-tool'
        });

        const lasso = new Button({
            id: 'bottom-toolbar-lasso',
            class: 'bottom-toolbar-tool'
        });

        const eyedropper = new Button({
            id: 'bottom-toolbar-eyedropper',
            class: 'bottom-toolbar-tool'
        });

        const floodPopupBtn = new Button({
            id: 'bottom-toolbar-flood-popup',
            class: 'bottom-toolbar-tool'
        });

        const opacity = new Button({
            id: 'bottom-toolbar-opacity',
            class: 'bottom-toolbar-tool'
        });

        const size = new Button({
            id: 'bottom-toolbar-size',
            class: 'bottom-toolbar-tool'
        });

        const translate = new Button({
            id: 'bottom-toolbar-translate',
            class: 'bottom-toolbar-tool'
        });

        const rotate = new Button({
            id: 'bottom-toolbar-rotate',
            class: 'bottom-toolbar-tool'
        });

        const scale = new Button({
            id: 'bottom-toolbar-scale',
            class: 'bottom-toolbar-tool'
        });

        const measure = new Button({
            id: 'bottom-toolbar-measure',
            class: 'bottom-toolbar-tool'
        });

        const coordSpace = new Button({
            id: 'bottom-toolbar-coord-space',
            class: 'bottom-toolbar-toggle'
        });

        const origin = new Button({
            id: 'bottom-toolbar-origin',
            class: ['bottom-toolbar-toggle']
        });

        undo.dom.appendChild(createSvg(undoSvg));
        redo.dom.appendChild(createSvg(redoSvg));
        picker.dom.appendChild(createSvg(pickerSvg));
        polygon.dom.appendChild(createSvg(polygonSvg));
        brush.dom.appendChild(createSvg(brushSvg));
        lasso.dom.appendChild(createSvg(lassoSvg));
        eyedropper.dom.appendChild(createSvg(eyedropperSvg));
        opacity.dom.appendChild(createSvg(opacitySvg));
        size.dom.appendChild(createSvg(sizeSvg));
        translate.dom.appendChild(createSvg(translateSvg));
        rotate.dom.appendChild(createSvg(rotateSvg));
        scale.dom.appendChild(createSvg(scaleSvg));
        measure.dom.appendChild(createSvg(measureSvg));
        coordSpace.dom.appendChild(createSvg(coordSpaceSvg));
        origin.dom.appendChild(createSvg(originSvg));
        // crop.dom.appendChild(createSvg(cropSvg));

        // 创建长按弹出列表（收纳 eyedropper、flood、opacity、size）
        const floodPopup = document.createElement('div');
        floodPopup.className = 'bottom-toolbar-popup';
        floodPopup.style.display = 'none';
        floodPopup.appendChild(eyedropper.dom);
        floodPopupBtn.dom.appendChild(createSvg(floodSvg));
        floodPopup.appendChild(floodPopupBtn.dom);
        floodPopup.appendChild(opacity.dom);
        floodPopup.appendChild(size.dom);
        this.dom.appendChild(floodPopup);

        // 阻止弹出列表中的事件冒泡
        floodPopup.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });
        floodPopup.addEventListener('mouseup', (e) => {
            e.stopPropagation();
        });

        this.append(undo);
        this.append(redo);
        this.append(new Element({ class: 'bottom-toolbar-separator' }));
        this.append(picker);
        this.append(lasso);
        this.append(polygon);
        this.append(brush);
        this.append(flood);
        this.append(new Element({ class: 'bottom-toolbar-separator' }));
        this.append(translate);
        this.append(rotate);
        this.append(scale);
        this.append(new Element({ class: 'bottom-toolbar-separator' }));
        this.append(measure);
        this.append(coordSpace);
        this.append(origin);

        undo.dom.addEventListener('click', () => events.fire('edit.undo'));
        redo.dom.addEventListener('click', () => events.fire('edit.redo'));
        polygon.dom.addEventListener('click', () => events.fire('tool.polygonSelection'));
        lasso.dom.addEventListener('click', () => events.fire('tool.lassoSelection'));
        brush.dom.addEventListener('click', () => events.fire('tool.brushSelection'));

        // 用于动态切换 flood 按钮上的 SVG
        let currentFloodSvgElement: HTMLElement | null = null;
        const floodSvgMap: Record<string, string> = {
            floodSelection: floodSvg,
            eyedropperSelection: eyedropperSvg,
            opacitySelection: opacitySvg,
            sizeSelection: sizeSvg
        };

        const floodTooltipMap: Record<string, string> = {
            floodSelection: 'tooltip.bottom-toolbar.flood',
            eyedropperSelection: 'tooltip.bottom-toolbar.eyedropper',
            opacitySelection: 'tooltip.bottom-toolbar.opacity',
            sizeSelection: 'tooltip.bottom-toolbar.size'
        };

        const updateFloodSvg = (toolName: string) => {
            const svgData = floodSvgMap[toolName];
            if (!svgData) return;
            if (currentFloodSvgElement) {
                currentFloodSvgElement.remove();
            }
            currentFloodSvgElement = createSvg(svgData) as HTMLElement;
            flood.dom.appendChild(currentFloodSvgElement);
        };

        // 初始显示 eyedropper SVG
        updateFloodSvg('eyedropperSelection');

        // 添加小三角点击区域
        const floodToggle = document.createElement('div');
        floodToggle.className = 'bottom-toolbar-flood-toggle';
        floodToggle.style.cssText = `
            position: absolute;
            right: 1px;
            bottom: 1px;
            width: 10px;
            height: 10px;
            cursor: pointer;
            z-index: 2;
        `;
        flood.dom.style.position = 'relative';
        flood.dom.appendChild(floodToggle);

        // flood 按钮：短按激活 eyedropper 工具，长按展开子菜单，拖拽到选项松开可触发对应工具
        let longPressTimer: ReturnType<typeof setTimeout> | null = null;
        let isLongPress = false;
        let isLongPressDrag = false;

        // Map popup button DOM elements to their tool events for drag-to-select
        const popupButtonActions: Array<{ element: HTMLElement; toolEvent: string }> = [
            { element: eyedropper.dom, toolEvent: 'tool.eyedropperSelection' },
            { element: floodPopupBtn.dom, toolEvent: 'tool.floodSelection' },
            { element: opacity.dom, toolEvent: 'tool.opacitySelection' },
            { element: size.dom, toolEvent: 'tool.sizeSelection' }
        ];

        // Find which popup button is under a given cursor position
        const findPopupButtonAtPoint = (x: number, y: number) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return null;
            for (const btn of popupButtonActions) {
                if (btn.element === el || btn.element.contains(el)) {
                    return btn;
                }
            }
            return null;
        };

        // Clean up long press drag state and remove document-level listeners
        const cleanupLongPressDrag = () => {
            isLongPressDrag = false;
            isLongPress = false;
            hideFloodPopup();
            document.removeEventListener('mouseup', onDocMouseUpCapture, true);
            document.removeEventListener('mousemove', onDocMouseMoveCapture, true);
            // Reset all popup button hover states
            for (const btn of popupButtonActions) {
                btn.element.classList.remove('longpress-hover');
            }
        };

        // Document-level mousemove during long press drag: highlight button under cursor
        const onDocMouseMoveCapture = (e: MouseEvent) => {
            const hovered = findPopupButtonAtPoint(e.clientX, e.clientY);
            for (const btn of popupButtonActions) {
                btn.element.classList.toggle('longpress-hover', btn === hovered);
            }
        };

        // Document-level mouseup during long press drag: trigger tool if over a popup button
        const onDocMouseUpCapture = (e: MouseEvent) => {
            if (e.button !== 0) return;
            const btn = findPopupButtonAtPoint(e.clientX, e.clientY);
            if (btn) {
                events.fire(btn.toolEvent);
            }
            cleanupLongPressDrag();
        };

        const showFloodPopup = () => {
            const floodRect = flood.dom.getBoundingClientRect();
            const toolbarRect = this.dom.getBoundingClientRect();
            floodPopup.style.left = `${floodRect.right - toolbarRect.left + 10}px`;
            floodPopup.style.top = `${floodRect.top - toolbarRect.top - 6}px`;
            floodPopup.style.display = '';
        };

        const hideFloodPopup = () => {
            floodPopup.style.display = 'none';
        };

        const isPopupVisible = () => {
            return floodPopup.style.display !== 'none';
        };

        // 小三角点击：直接展开菜单
        floodToggle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (isPopupVisible()) {
                hideFloodPopup();
            } else {
                showFloodPopup();
            }
        });

        const startLongPressDrag = () => {
            isLongPress = true;
            isLongPressDrag = true;
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            showFloodPopup();
            document.addEventListener('mouseup', onDocMouseUpCapture, true);
            document.addEventListener('mousemove', onDocMouseMoveCapture, true);
        };

        let dragStartX = 0;
        const SWIPE_THRESHOLD = 20; // px to drag right before triggering popup

        flood.dom.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // 如果点击的是小三角区域，不触发工具激活
            if (floodToggle.contains(e.target as Node)) return;
            isLongPress = false;
            isLongPressDrag = false;
            dragStartX = e.clientX;

            // 长按定时器
            longPressTimer = setTimeout(() => {
                startLongPressDrag();
            }, 200);
        });

        // 在 flood 按钮上监听 mousemove：向右拖动超过阈值立即展开
        flood.dom.addEventListener('mousemove', (e) => {
            if (isLongPressDrag || !longPressTimer) return;
            if (e.clientX - dragStartX >= SWIPE_THRESHOLD) {
                startLongPressDrag();
                // 初始化时手动触发一次 hover 高亮
                const hovered = findPopupButtonAtPoint(e.clientX, e.clientY);
                for (const btn of popupButtonActions) {
                    btn.element.classList.toggle('longpress-hover', btn === hovered);
                }
            }
        });

        flood.dom.addEventListener('mouseup', (e) => {
            if (e.button !== 0) return;
            // 如果点击的是小三角区域，不触发工具激活
            if (floodToggle.contains(e.target as Node)) return;
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            // Long press drag: release detection is handled by document capture listener
            if (isLongPressDrag) return;
            if (!isLongPress) {
                if (isPopupVisible()) {
                    hideFloodPopup();
                } else {
                    events.fire('tool.eyedropperSelection');
                }
            }
        });

        flood.dom.addEventListener('mouseleave', () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        });

        // 点击弹窗外区域关闭弹出列表（长按拖拽期间不响应此关闭逻辑）
        document.addEventListener('mousedown', (e) => {
            if (isPopupVisible() && !isLongPressDrag && !floodPopup.contains(e.target as Node) && !flood.dom.contains(e.target as Node)) {
                hideFloodPopup();
            }
        });

        // 弹出列表中的按钮点击后关闭弹出列表
        [eyedropper, floodPopupBtn, opacity, size].forEach((btn) => {
            btn.dom.addEventListener('click', () => {
                hideFloodPopup();
            });
        });

        picker.dom.addEventListener('click', () => events.fire('tool.rectSelection'));
        eyedropper.dom.addEventListener('click', () => events.fire('tool.eyedropperSelection'));
        floodPopupBtn.dom.addEventListener('click', () => events.fire('tool.floodSelection'));
        opacity.dom.addEventListener('click', () => events.fire('tool.opacitySelection'));
        size.dom.addEventListener('click', () => events.fire('tool.sizeSelection'));
        translate.dom.addEventListener('click', () => events.fire('tool.move'));
        rotate.dom.addEventListener('click', () => events.fire('tool.rotate'));
        scale.dom.addEventListener('click', () => events.fire('tool.scale'));
        measure.dom.addEventListener('click', () => events.fire('tool.measure'));
        coordSpace.dom.addEventListener('click', () => events.fire('tool.toggleCoordSpace'));
        origin.dom.addEventListener('click', () => events.fire('pivot.toggleOrigin'));

        events.on('edit.canUndo', (value: boolean) => {
            undo.enabled = value;
        });
        events.on('edit.canRedo', (value: boolean) => {
            redo.enabled = value;
        });

        events.on('tool.activated', (toolName: string) => {
            picker.class[toolName === 'rectSelection' ? 'add' : 'remove']('active');
            brush.class[toolName === 'brushSelection' ? 'add' : 'remove']('active');
            flood.class[['floodSelection', 'eyedropperSelection', 'opacitySelection', 'sizeSelection'].includes(toolName) ? 'add' : 'remove']('active');
            polygon.class[toolName === 'polygonSelection' ? 'add' : 'remove']('active');
            lasso.class[toolName === 'lassoSelection' ? 'add' : 'remove']('active');
            translate.class[toolName === 'move' ? 'add' : 'remove']('active');
            rotate.class[toolName === 'rotate' ? 'add' : 'remove']('active');
            scale.class[toolName === 'scale' ? 'add' : 'remove']('active');
            measure.class[toolName === 'measure' ? 'add' : 'remove']('active');
            eyedropper.class[toolName === 'eyedropperSelection' ? 'add' : 'remove']('active');
            opacity.class[toolName === 'opacitySelection' ? 'add' : 'remove']('active');
            size.class[toolName === 'sizeSelection' ? 'add' : 'remove']('active');

            // 动态切换 flood 按钮上的 SVG 图标
            if (['floodSelection', 'eyedropperSelection', 'opacitySelection', 'sizeSelection'].includes(toolName)) {
                updateFloodSvg(toolName);
                // 更新 tooltip
                tooltips.unregister(flood);
                tooltips.register(flood, tooltip(floodTooltipMap[toolName], `tool.${toolName}`));
            }
        });

        events.on('tool.coordSpace', (space: 'local' | 'world') => {
            coordSpace.dom.classList[space === 'local' ? 'add' : 'remove']('active');
        });

        events.on('pivot.origin', (o: 'center' | 'boundCenter') => {
            origin.dom.classList[o === 'boundCenter' ? 'add' : 'remove']('active');
        });

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

        // register tooltips
        tooltips.register(undo, tooltip('tooltip.bottom-toolbar.undo', 'edit.undo'));
        tooltips.register(redo, tooltip('tooltip.bottom-toolbar.redo', 'edit.redo'));
        tooltips.register(picker, tooltip('tooltip.bottom-toolbar.rect', 'tool.rectSelection'));
        tooltips.register(lasso, tooltip('tooltip.bottom-toolbar.lasso', 'tool.lassoSelection'));
        tooltips.register(polygon, tooltip('tooltip.bottom-toolbar.polygon', 'tool.polygonSelection'));
        tooltips.register(brush, tooltip('tooltip.bottom-toolbar.brush', 'tool.brushSelection'));
        tooltips.register(flood, tooltip('tooltip.bottom-toolbar.eyedropper', 'tool.eyedropperSelection'));
        tooltips.register(translate, tooltip('tooltip.bottom-toolbar.translate', 'tool.move'));
        tooltips.register(rotate, tooltip('tooltip.bottom-toolbar.rotate', 'tool.rotate'));
        tooltips.register(scale, tooltip('tooltip.bottom-toolbar.scale', 'tool.scale'));
        tooltips.register(measure, tooltip('tooltip.bottom-toolbar.measure'));
        tooltips.register(coordSpace, tooltip('tooltip.bottom-toolbar.local-space', 'tool.toggleCoordSpace'));
        tooltips.register(origin, tooltip('tooltip.bottom-toolbar.bound-center'));
        tooltips.register(eyedropper, tooltip('tooltip.bottom-toolbar.eyedropper', 'tool.eyedropperSelection'));
        tooltips.register(floodPopupBtn, tooltip('tooltip.bottom-toolbar.flood', 'tool.floodSelection'));
        tooltips.register(opacity, tooltip('tooltip.bottom-toolbar.opacity', 'tool.opacitySelection'));
        tooltips.register(size, tooltip('tooltip.bottom-toolbar.size', 'tool.sizeSelection'));

        events.on('bottomToolbar.toggle', () => {
            this.dom.classList.toggle('collapsed');
        });
    }
}

export { BottomToolbar };
