import {
    Container,
    Element as PcuiElement,
    Label,
    SelectInput,
    type SelectInputArgs,
    SliderInput
} from '@playcanvas/pcui';

import { PaintLayerDeleteOp } from '../edit-ops';
import { Events } from '../events';
import { PAINT_BLEND_MODE_GROUPS, type PaintBlendMode } from '../paint-layer-blend';
import type { PaintLayer } from '../paint-layers';
import { i18n, localize } from './localization';
import deleteSvg from './svg/delete.svg';
import hiddenSvg from './svg/hidden.svg';
import newSvg from './svg/new.svg';
import shownSvg from './svg/shown.svg';
import { Tooltips } from './tooltips';
import { addVerticalListResizeHandle } from './vertical-list-resize';

const createSvg = (svgString: string) => {
    const decoded = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decoded, 'image/svg+xml').documentElement;
};

const BLEND_SEPARATOR_PREFIX = 'paint-blend-separator-';
const BLEND_MENU_GAP = 4;
const BLEND_MENU_VIEWPORT_PADDING = 8;
const LAYER_DRAG_START_THRESHOLD = 4;
const LAYER_DRAG_EDGE_SIZE = 24;
const LAYER_DRAG_SCROLL_STEP = 12;

const blendModeKey = (mode: PaintBlendMode) => `paint.layers.blend.${mode}`;

const buildBlendModeOptions = () => PAINT_BLEND_MODE_GROUPS.flatMap((group, groupIndex) => [
    ...(groupIndex === 0 ? [] : [{
        v: `${BLEND_SEPARATOR_PREFIX}${groupIndex}`,
        t: '\u00a0'
    }]),
    ...group.map(mode => ({
        v: mode,
        t: i18n.t(blendModeKey(mode))
    }))
]);

const blendSeparatorOptions = Object.fromEntries(
    PAINT_BLEND_MODE_GROUPS.slice(1).map((_, index) => [`${BLEND_SEPARATOR_PREFIX}${index + 1}`, '\u00a0'])
);

class PaintBlendSelectInput extends SelectInput {
    private readonly optionsHost: HTMLElement;
    private readonly resizeObserver: ResizeObserver;
    private optionsFloating = false;

    private readonly onViewportScroll = (event: Event) => {
        const target = event.target;
        if (target instanceof Node && this._containerOptions.dom.contains(target)) return;
        this.positionFloatingOptions();
    };

    private readonly positionFloatingOptions = () => {
        if (!this.optionsFloating || this._containerOptions.hidden) return;
        if (!this.dom.isConnected || this.dom.getClientRects().length === 0) {
            this.close();
            return;
        }

        const anchorRect = this.dom.getBoundingClientRect();
        const optionsDom = this._containerOptions.dom;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const maximumWidth = Math.max(0, viewportWidth - BLEND_MENU_VIEWPORT_PADDING * 2);

        optionsDom.classList.remove('paint-layer-blend-floating-list-above', 'paint-layer-blend-floating-list-constrained');
        Object.assign(optionsDom.style, {
            position: 'fixed',
            top: '0px',
            right: 'auto',
            bottom: 'auto',
            left: '0px',
            width: 'max-content',
            minWidth: `${anchorRect.width}px`,
            maxWidth: `${maximumWidth}px`,
            height: 'auto',
            maxHeight: 'none',
            overflowX: 'hidden',
            overflowY: 'visible'
        });

        const naturalWidth = Math.ceil(optionsDom.scrollWidth);
        const width = Math.min(maximumWidth, Math.max(anchorRect.width, naturalWidth));
        const left = Math.min(
            Math.max(BLEND_MENU_VIEWPORT_PADDING, anchorRect.left),
            Math.max(BLEND_MENU_VIEWPORT_PADDING, viewportWidth - BLEND_MENU_VIEWPORT_PADDING - width)
        );
        optionsDom.style.left = `${left}px`;
        optionsDom.style.width = `${width}px`;
        optionsDom.style.minWidth = '0';

        const naturalHeight = Math.ceil(optionsDom.scrollHeight);
        const spaceBelow = Math.max(
            0,
            viewportHeight - anchorRect.bottom - BLEND_MENU_GAP - BLEND_MENU_VIEWPORT_PADDING
        );
        const spaceAbove = Math.max(
            0,
            anchorRect.top - BLEND_MENU_GAP - BLEND_MENU_VIEWPORT_PADDING
        );

        if (naturalHeight <= spaceBelow) {
            optionsDom.style.top = `${anchorRect.bottom + BLEND_MENU_GAP}px`;
            return;
        }

        if (naturalHeight <= spaceAbove) {
            optionsDom.classList.add('paint-layer-blend-floating-list-above');
            optionsDom.style.top = `${anchorRect.top - BLEND_MENU_GAP - naturalHeight}px`;
            return;
        }

        const openAbove = spaceAbove > spaceBelow;
        const availableHeight = openAbove ? spaceAbove : spaceBelow;
        optionsDom.classList.add('paint-layer-blend-floating-list-constrained');
        optionsDom.style.maxHeight = `${availableHeight}px`;
        optionsDom.style.overflowY = 'auto';

        if (openAbove) {
            optionsDom.classList.add('paint-layer-blend-floating-list-above');
            optionsDom.style.top = `${BLEND_MENU_VIEWPORT_PADDING}px`;
        } else {
            optionsDom.style.top = `${anchorRect.bottom + BLEND_MENU_GAP}px`;
        }
    };

    constructor(args?: Readonly<SelectInputArgs>) {
        super(args);

        this.optionsHost = this._containerOptions.dom.parentElement;
        this._containerOptions.dom.classList.add('paint-layer-blend-floating-list');
        this._onDocumentPointerDown = (event) => {
            const target = event.composedPath()[0];
            if (!(target instanceof Node)) return;
            if (!this.dom.contains(target) && !this._containerOptions.dom.contains(target)) this.close();
        };

        this.resizeObserver = new ResizeObserver(this.positionFloatingOptions);
        this.resizeObserver.observe(this.dom);
    }

    private mountFloatingOptions() {
        if (this.optionsFloating) return;
        document.body.appendChild(this._containerOptions.dom);
        this.optionsFloating = true;
        document.removeEventListener('pointerdown', this._onDocumentPointerDown);
        document.addEventListener('pointerdown', this._onDocumentPointerDown, true);
        window.addEventListener('resize', this.positionFloatingOptions);
        window.addEventListener('scroll', this.onViewportScroll, true);
        this._domShadow.style.height = '';
    }

    private restoreOptions() {
        if (!this.optionsFloating) return;

        document.removeEventListener('pointerdown', this._onDocumentPointerDown, true);
        window.removeEventListener('resize', this.positionFloatingOptions);
        window.removeEventListener('scroll', this.onViewportScroll, true);
        this.optionsHost.appendChild(this._containerOptions.dom);
        this.optionsFloating = false;

        const optionsDom = this._containerOptions.dom;
        optionsDom.classList.remove('paint-layer-blend-floating-list-above', 'paint-layer-blend-floating-list-constrained');
        for (const property of [
            'position',
            'top',
            'right',
            'bottom',
            'left',
            'width',
            'min-width',
            'max-width',
            'height',
            'max-height',
            'overflow-x',
            'overflow-y'
        ]) {
            optionsDom.style.removeProperty(property);
        }
    }

    markSeparators() {
        this._containerOptions.dom.querySelectorAll<HTMLElement>(`[id^="${BLEND_SEPARATOR_PREFIX}"]`).forEach((separator) => {
            separator.classList.add('paint-layer-blend-separator');
        });
        this.positionFloatingOptions();
    }

    open() {
        super.open();
        if (this._containerOptions.hidden) return;
        this.dom.classList.remove('pcui-select-input-fit-height');
        this.mountFloatingOptions();
        this.positionFloatingOptions();
    }

    close() {
        super.close();
        this.restoreOptions();
    }

    destroy() {
        this.resizeObserver.disconnect();
        this.close();
        super.destroy();
    }

    protected _onSelectValue(value: string) {
        if (value.startsWith(BLEND_SEPARATOR_PREFIX)) return;
        super._onSelectValue(value);
    }
}

class PaintLayerItem extends Container {
    readonly layerId: string;
    private text: Label;
    private visibleIcon: PcuiElement | null = null;
    private hiddenIcon: PcuiElement | null = null;
    private deleteIcon: PcuiElement | null = null;

    constructor(layer: PaintLayer, tooltips: Tooltips) {
        super({ class: ['splat-item', 'paint-layer-item', 'visible', ...(layer.base ? ['paint-layer-base'] : [])] });
        this.layerId = layer.id;
        this.dom.dataset.paintLayerId = layer.id;
        if (!layer.base) this.class.add('paint-layer-draggable');

        this.text = new Label({
            class: 'splat-item-text',
            text: layer.name
        });
        this.append(this.text);

        if (layer.base) return;

        this.visibleIcon = new PcuiElement({
            dom: createSvg(shownSvg),
            class: 'splat-item-visible'
        });
        this.hiddenIcon = new PcuiElement({
            dom: createSvg(hiddenSvg),
            class: 'splat-item-visible',
            hidden: true
        });
        this.deleteIcon = new PcuiElement({
            dom: createSvg(deleteSvg),
            class: 'splat-item-delete'
        });

        this.append(this.visibleIcon);
        this.append(this.hiddenIcon);
        this.append(this.deleteIcon);

        tooltips.register(this.visibleIcon, localize('paint.layers.visible'), 'bottom');
        tooltips.register(this.hiddenIcon, localize('paint.layers.visible'), 'bottom');
        tooltips.register(this.deleteIcon, localize('paint.layers.delete'), 'bottom');

        const toggleVisible = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            this.emit('visibleToggle', this.layerId);
        };
        this.visibleIcon.dom.addEventListener('click', toggleVisible);
        this.hiddenIcon.dom.addEventListener('click', toggleVisible);
        this.deleteIcon.dom.addEventListener('click', (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            this.emit('delete', this.layerId);
        });
        this.dom.addEventListener('click', () => this.emit('select', this.layerId));
    }

    update(layer: PaintLayer, activeLayerId: string) {
        this.text.text = layer.name;
        if (this.visibleIcon) this.visibleIcon.hidden = !layer.visible;
        if (this.hiddenIcon) this.hiddenIcon.hidden = layer.visible;
        this.class[layer.visible ? 'add' : 'remove']('visible');
        this.class[!layer.base && layer.id === activeLayerId ? 'add' : 'remove']('selected');
    }
}

class PaintLayerPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        super({
            ...args,
            id: 'paint-layers',
            hidden: true
        });

        const header = new Container({ class: 'panel-header' });
        const headerIcon = new Label({
            class: 'panel-header-icon',
            text: '\uE344'
        });
        const headerLabel = new Label({
            class: 'panel-header-label',
            text: localize('paint.layers')
        });
        const addButton = new PcuiElement({
            dom: createSvg(newSvg),
            class: ['panel-header-button', 'paint-layer-add']
        });
        tooltips.register(addButton, localize('paint.layers.add'), 'bottom');
        addButton.dom.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            events.fire('paint.layers.create');
        });

        header.append(headerIcon);
        header.append(headerLabel);
        header.append(addButton);

        const controls = new Container({ class: 'paint-layer-controls' });
        const blendSelect = new PaintBlendSelectInput({
            class: 'paint-layer-blend-select',
            options: buildBlendModeOptions(),
            disabledOptions: blendSeparatorOptions,
            defaultValue: 'normal'
        });
        const opacitySlider = new SliderInput({
            class: 'paint-layer-opacity-slider',
            min: 0,
            max: 100,
            sliderMin: 0,
            sliderMax: 100,
            step: 1,
            precision: 0,
            value: 100
        });
        controls.append(blendSelect);
        controls.append(opacitySlider);
        const refreshOpacityHandle = () => {
            const handle = opacitySlider.dom.querySelector<HTMLElement>('.pcui-slider-handle');
            if (!handle) return;
            const value = Math.min(100, Math.max(0, opacitySlider.value ?? 0));
            const handleWidth = handle.getBoundingClientRect().width || parseFloat(getComputedStyle(handle).width) || 8;
            handle.style.left = `calc(${value}% + ${handleWidth / 2}px)`;
        };
        const opacityResizeObserver = new ResizeObserver(refreshOpacityHandle);
        opacityResizeObserver.observe(opacitySlider.dom);
        this.once('destroy', () => opacityResizeObserver.disconnect());
        requestAnimationFrame(refreshOpacityHandle);

        tooltips.register(blendSelect, localize('paint.layers.blend-mode'), 'bottom');
        tooltips.register(opacitySlider, localize('paint.layers.opacity'), 'bottom');

        blendSelect.markSeparators();
        i18n.onChange(() => {
            const value = blendSelect.value;
            blendSelect.options = buildBlendModeOptions();
            blendSelect.disabledOptions = {};
            blendSelect.disabledOptions = blendSeparatorOptions;
            blendSelect.value = value;
            blendSelect.markSeparators();
        }, blendSelect);

        const list = new Container({ class: ['splat-list', 'paint-layer-list'] });
        const items = new Map<string, PaintLayerItem>();
        const dropIndicator = document.createElement('div');
        dropIndicator.className = 'paint-layer-drop-indicator';
        dropIndicator.hidden = true;
        list.dom.appendChild(dropIndicator);
        let syncingControls = false;

        type LayerDragState = {
            pointerId: number;
            layerId: string;
            source: HTMLElement;
            startX: number;
            startY: number;
            grabX: number;
            grabY: number;
            preview: HTMLElement | null;
            dropIndex: number | null;
        };

        let layerDrag: LayerDragState | null = null;
        let suppressClickUntil = 0;

        const hideDropIndicator = () => {
            dropIndicator.hidden = true;
            if (layerDrag) layerDrag.dropIndex = null;
        };

        const updateDropIndicator = (clientX: number, clientY: number) => {
            if (!layerDrag?.preview) return;
            const listRect = list.dom.getBoundingClientRect();
            const insideList = clientX >= listRect.left && clientX <= listRect.right &&
                clientY >= listRect.top && clientY <= listRect.bottom;
            if (!insideList) {
                hideDropIndicator();
                return;
            }

            const candidates = Array.from(list.dom.querySelectorAll<HTMLElement>(
                '.paint-layer-item:not(.paint-layer-base):not(.paint-layer-drag-source)'
            ));
            let targetIndex = candidates.findIndex((candidate) => {
                const rect = candidate.getBoundingClientRect();
                return clientY < rect.top + rect.height / 2;
            });
            if (targetIndex === -1) targetIndex = candidates.length;

            const target = candidates[targetIndex] ??
                list.dom.querySelector<HTMLElement>('.paint-layer-base');
            const indicatorTop = target?.offsetTop ??
                (candidates.at(-1) ? candidates.at(-1)!.offsetTop + candidates.at(-1)!.offsetHeight : 0);
            dropIndicator.style.top = `${indicatorTop}px`;
            dropIndicator.hidden = false;
            layerDrag.dropIndex = targetIndex;
        };

        const updateDrag = (clientX: number, clientY: number) => {
            if (!layerDrag?.preview) return;
            layerDrag.preview.style.left = `${clientX - layerDrag.grabX}px`;
            layerDrag.preview.style.top = `${clientY - layerDrag.grabY}px`;

            const listRect = list.dom.getBoundingClientRect();
            if (clientY < listRect.top + LAYER_DRAG_EDGE_SIZE) {
                list.dom.scrollTop -= LAYER_DRAG_SCROLL_STEP;
            } else if (clientY > listRect.bottom - LAYER_DRAG_EDGE_SIZE) {
                list.dom.scrollTop += LAYER_DRAG_SCROLL_STEP;
            }
            updateDropIndicator(clientX, clientY);
        };

        const beginDrag = (clientX: number, clientY: number) => {
            if (!layerDrag || layerDrag.preview) return;
            events.fire('paint.layers.select', layerDrag.layerId);
            const rect = layerDrag.source.getBoundingClientRect();
            const previewItem = layerDrag.source.cloneNode(true) as HTMLElement;
            previewItem.classList.remove('paint-layer-drag-source');
            const preview = document.createElement('div');
            preview.className = 'splat-list paint-layer-drag-preview';
            preview.appendChild(previewItem);
            preview.style.width = `${rect.width}px`;
            preview.style.height = `${rect.height}px`;
            layerDrag.preview = preview;
            layerDrag.source.classList.add('paint-layer-drag-source');
            document.body.classList.add('paint-layer-dragging');
            document.body.appendChild(preview);
            updateDrag(clientX, clientY);
        };

        const finishDrag = (commit: boolean) => {
            if (!layerDrag) return;
            const { source, pointerId, preview, layerId, dropIndex } = layerDrag;
            const dragged = !!preview;
            layerDrag = null;
            source.classList.remove('paint-layer-drag-source');
            preview?.remove();
            dropIndicator.hidden = true;
            document.body.classList.remove('paint-layer-dragging');
            if (source.hasPointerCapture(pointerId)) source.releasePointerCapture(pointerId);
            if (dragged) suppressClickUntil = performance.now() + 250;
            if (commit && dragged && dropIndex !== null) events.fire('paint.layers.reorder', layerId, dropIndex);
        };

        const onLayerPointerDown = (event: PointerEvent) => {
            if (event.button !== 0 || layerDrag) return;
            const target = event.target;
            if (!(target instanceof Element) || target.closest('.splat-item-visible, .splat-item-delete')) return;
            const source = target.closest<HTMLElement>('.paint-layer-draggable');
            if (!source || !list.dom.contains(source)) return;
            const layerId = source.dataset.paintLayerId;
            if (!layerId) return;
            const rect = source.getBoundingClientRect();
            layerDrag = {
                pointerId: event.pointerId,
                layerId,
                source,
                startX: event.clientX,
                startY: event.clientY,
                grabX: event.clientX - rect.left,
                grabY: event.clientY - rect.top,
                preview: null,
                dropIndex: null
            };
            source.setPointerCapture(event.pointerId);
        };

        const onLayerPointerMove = (event: PointerEvent) => {
            if (!layerDrag || event.pointerId !== layerDrag.pointerId) return;
            if (!layerDrag.preview) {
                const distanceX = event.clientX - layerDrag.startX;
                const distanceY = event.clientY - layerDrag.startY;
                if (Math.hypot(distanceX, distanceY) < LAYER_DRAG_START_THRESHOLD) return;
                beginDrag(event.clientX, event.clientY);
            } else {
                updateDrag(event.clientX, event.clientY);
            }
            event.preventDefault();
            event.stopPropagation();
        };

        const onLayerPointerUp = (event: PointerEvent) => {
            if (!layerDrag || event.pointerId !== layerDrag.pointerId) return;
            const commit = event.type === 'pointerup';
            if (layerDrag.preview) {
                event.preventDefault();
                event.stopPropagation();
            }
            finishDrag(commit);
        };

        const onLayerClickCapture = (event: MouseEvent) => {
            if (performance.now() >= suppressClickUntil) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        };

        list.dom.addEventListener('pointerdown', onLayerPointerDown);
        document.addEventListener('pointermove', onLayerPointerMove, true);
        document.addEventListener('pointerup', onLayerPointerUp, true);
        document.addEventListener('pointercancel', onLayerPointerUp, true);
        list.dom.addEventListener('click', onLayerClickCapture, true);
        this.once('destroy', () => {
            finishDrag(false);
            list.dom.removeEventListener('pointerdown', onLayerPointerDown);
            document.removeEventListener('pointermove', onLayerPointerMove, true);
            document.removeEventListener('pointerup', onLayerPointerUp, true);
            document.removeEventListener('pointercancel', onLayerPointerUp, true);
            list.dom.removeEventListener('click', onLayerClickCapture, true);
        });

        blendSelect.on('change', (value: PaintBlendMode) => {
            if (syncingControls || !value || value.startsWith(BLEND_SEPARATOR_PREFIX)) return;
            const activeLayerId = events.invoke('paint.layers.active') as string;
            events.fire('paint.layers.setBlendMode', activeLayerId, value);
        });
        opacitySlider.on('change', (value: number) => {
            if (syncingControls) return;
            const activeLayerId = events.invoke('paint.layers.active') as string;
            events.fire('paint.layers.setOpacity', activeLayerId, value / 100);
        });

        const sync = (layers: PaintLayer[], activeLayerId: string) => {
            const layerIds = new Set(layers.map(layer => layer.id));
            if (layerDrag && !layerIds.has(layerDrag.layerId)) finishDrag(false);
            for (const [layerId, item] of items) {
                if (layerIds.has(layerId)) continue;
                list.remove(item);
                item.destroy();
                items.delete(layerId);
            }

            for (const layer of layers) {
                let item = items.get(layer.id);
                if (!item) {
                    item = new PaintLayerItem(layer, tooltips);
                    item.on('select', (layerId: string) => events.fire('paint.layers.select', layerId));
                    item.on('visibleToggle', (layerId: string) => {
                        const current = (events.invoke('paint.layers.list') as PaintLayer[]).find(value => value.id === layerId);
                        if (current) events.fire('paint.layers.setVisible', layerId, !current.visible);
                    });
                    item.on('delete', (layerId: string) => {
                        events.fire('edit.add', new PaintLayerDeleteOp(layerId, events));
                    });
                    items.set(layer.id, item);
                    list.append(item);
                }
                item.update(layer, activeLayerId);
            }

            // appendChild moves existing nodes, keeping the DOM in the same
            // top-to-bottom order as the manager (including the fixed base row).
            for (const layer of layers) {
                const item = items.get(layer.id);
                if (item) list.dom.appendChild(item.dom);
            }
            list.dom.appendChild(dropIndicator);

            const activeLayer = layers.find(layer => !layer.base && layer.id === activeLayerId);
            syncingControls = true;
            blendSelect.enabled = !!activeLayer;
            opacitySlider.enabled = !!activeLayer;
            if (activeLayer) {
                blendSelect.value = activeLayer.blendMode;
                opacitySlider.value = Math.round(activeLayer.opacity * 100);
                requestAnimationFrame(refreshOpacityHandle);
            }
            syncingControls = false;
        };

        events.on('paint.layers.changed', sync);
        events.on('mode.changed', (mode: 'edit' | 'paint') => {
            if (mode !== 'paint') {
                finishDrag(false);
                blendSelect.close();
                return;
            }
            requestAnimationFrame(refreshOpacityHandle);
            setTimeout(refreshOpacityHandle, 100);
        });

        this.append(header);
        this.append(controls);
        this.append(list);
        addVerticalListResizeHandle(list.dom);

        if (events.functions.has('paint.layers.list')) {
            sync(
                events.invoke('paint.layers.list') as PaintLayer[],
                events.invoke('paint.layers.active') as string
            );
        }
    }
}

export { PaintLayerPanel };
