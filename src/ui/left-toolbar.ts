import { Button, Element, Container } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { localize, formatTooltipWithShortcut } from './localization';
import coordSpaceSvg from './svg/compass.svg';
import translateSvg from './svg/move.svg';
import originSvg from './svg/origin.svg';
import redoSvg from './svg/redo.svg';
import rotateSvg from './svg/rotate.svg';
import measureSvg from './svg/ruler.svg';
import scaleSvg from './svg/scale.svg';
import brushSvg from './svg/select-brush.svg';
import eyedropperSvg from './svg/select-eyedropper.svg';
import floodSvg from './svg/select-flood.svg';
import sizeSvg from './svg/select-inverse.svg';
import lassoSvg from './svg/select-lasso.svg';
import opacitySvg from './svg/select-opacity.svg';
import pickerSvg from './svg/select-picker.svg';
import polygonSvg from './svg/select-poly.svg';
import undoSvg from './svg/undo.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class LeftToolbar extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'left-toolbar'
        };

        super(args);

        this.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const undo = new Button({
            id: 'left-toolbar-undo',
            class: 'left-toolbar-button',
            enabled: false
        });

        const redo = new Button({
            id: 'left-toolbar-redo',
            class: 'left-toolbar-button',
            enabled: false
        });

        const picker = new Button({
            id: 'left-toolbar-picker',
            class: 'left-toolbar-tool'
        });

        const polygon = new Button({
            id: 'left-toolbar-polygon',
            class: 'left-toolbar-tool'
        });

        const brush = new Button({
            id: 'left-toolbar-brush',
            class: 'left-toolbar-tool'
        });

        const flood = new Button({
            id: 'left-toolbar-flood',
            class: 'left-toolbar-tool'
        });

        const lasso = new Button({
            id: 'left-toolbar-lasso',
            class: 'left-toolbar-tool'
        });

        const eyedropper = new Button({
            id: 'left-toolbar-eyedropper',
            class: 'left-toolbar-tool'
        });

        const floodPopupBtn = new Button({
            id: 'left-toolbar-flood-popup',
            class: 'left-toolbar-tool'
        });

        const opacity = new Button({
            id: 'left-toolbar-opacity',
            class: 'left-toolbar-tool'
        });

        const size = new Button({
            id: 'left-toolbar-size',
            class: 'left-toolbar-tool'
        });

        const translate = new Button({
            id: 'left-toolbar-translate',
            class: 'left-toolbar-tool'
        });

        const rotate = new Button({
            id: 'left-toolbar-rotate',
            class: 'left-toolbar-tool'
        });

        const scale = new Button({
            id: 'left-toolbar-scale',
            class: 'left-toolbar-tool'
        });

        const measure = new Button({
            id: 'left-toolbar-measure',
            class: 'left-toolbar-tool'
        });

        const coordSpace = new Button({
            id: 'left-toolbar-coord-space',
            class: 'left-toolbar-toggle'
        });

        const origin = new Button({
            id: 'left-toolbar-origin',
            class: ['left-toolbar-toggle']
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
        floodPopup.className = 'left-toolbar-popup';
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
        this.append(new Element({ class: 'left-toolbar-separator' }));
        this.append(brush);
        this.append(picker);
        this.append(polygon);
        this.append(lasso);
        this.append(flood);
        this.append(new Element({ class: 'left-toolbar-separator' }));
        this.append(translate);
        this.append(rotate);
        this.append(scale);
        this.append(new Element({ class: 'left-toolbar-separator' }));
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
            floodSelection: 'tooltip.left-toolbar.flood',
            eyedropperSelection: 'tooltip.left-toolbar.eyedropper',
            opacitySelection: 'tooltip.left-toolbar.opacity',
            sizeSelection: 'tooltip.left-toolbar.size'
        };

        // 循环切换工具的顺序
        const floodTools = ['eyedropperSelection', 'floodSelection', 'opacitySelection', 'sizeSelection'];
        let currentFloodIndex = 0; // 默认显示 eyedropper

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
        floodToggle.className = 'left-toolbar-flood-toggle';
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
            // eslint-disable-next-line no-use-before-define
            hideFloodPopup();
            // eslint-disable-next-line no-use-before-define
            document.removeEventListener('mouseup', onDocMouseUpCapture, true);
            // eslint-disable-next-line no-use-before-define
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
                    // 循环切换到下一个工具
                    currentFloodIndex = (currentFloodIndex + 1) % floodTools.length;
                    events.fire(`tool.${floodTools[currentFloodIndex]}`);
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
            // 如果是flood工具组，更新当前索引
            if (floodTools.includes(toolName)) {
                currentFloodIndex = floodTools.indexOf(toolName);
            }
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
                // eslint-disable-next-line no-use-before-define
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
        tooltips.register(undo, tooltip('tooltip.left-toolbar.undo', 'edit.undo'));
        tooltips.register(redo, tooltip('tooltip.left-toolbar.redo', 'edit.redo'));
        tooltips.register(picker, tooltip('tooltip.left-toolbar.rect', 'tool.rectSelection'));
        tooltips.register(lasso, tooltip('tooltip.left-toolbar.lasso', 'tool.lassoSelection'));
        tooltips.register(polygon, tooltip('tooltip.left-toolbar.polygon', 'tool.polygonSelection'));
        tooltips.register(brush, tooltip('tooltip.left-toolbar.brush', 'tool.brushSelection'));
        tooltips.register(flood, tooltip('tooltip.left-toolbar.eyedropper', 'tool.eyedropperSelection'));
        tooltips.register(translate, tooltip('tooltip.left-toolbar.translate', 'tool.move'));
        tooltips.register(rotate, tooltip('tooltip.left-toolbar.rotate', 'tool.rotate'));
        tooltips.register(scale, tooltip('tooltip.left-toolbar.scale', 'tool.scale'));
        tooltips.register(measure, tooltip('tooltip.left-toolbar.measure'));
        tooltips.register(coordSpace, tooltip('tooltip.left-toolbar.local-space', 'tool.toggleCoordSpace'));
        tooltips.register(origin, tooltip('tooltip.left-toolbar.bound-center'));
        tooltips.register(eyedropper, tooltip('tooltip.left-toolbar.eyedropper', 'tool.eyedropperSelection'));
        tooltips.register(floodPopupBtn, tooltip('tooltip.left-toolbar.flood', 'tool.floodSelection'));
        tooltips.register(opacity, tooltip('tooltip.left-toolbar.opacity', 'tool.opacitySelection'));
        tooltips.register(size, tooltip('tooltip.left-toolbar.size', 'tool.sizeSelection'));

        events.on('bottomToolbar.toggle', () => {
            this.dom.classList.toggle('collapsed');
        });

        // 键盘快捷键 '5' 循环切换 flood 工具组
        events.on('tool.cycleFloodTool', () => {
            currentFloodIndex = (currentFloodIndex + 1) % floodTools.length;
            events.fire(`tool.${floodTools[currentFloodIndex]}`);
        });
    }
}

export { LeftToolbar };
