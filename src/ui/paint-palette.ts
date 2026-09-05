import { Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { MyFancySliderInput } from './color-panel';
import { localize } from './localization';
import clipboardListSvg from './svg/clipboard-list.svg';
import cornerUpLeftSvg from './svg/corner-up-left.svg';
import paletteSvg from './svg/palette.svg';
import { Tooltips } from './tooltips';

type Hsv = {
    h: number;
    s: number;
    v: number;
};

const HUE_RING_SIZE = 300;
const HUE_INNER_SIZE = 252;
const SV_SIZE = 170;
const HUE_INDICATOR_RADIUS = (HUE_RING_SIZE + HUE_INNER_SIZE) / 4;
const PAINT_SWATCH_STORAGE_KEY = 'resplat-paint-swatches';

const DEFAULT_SWATCHES: Hsv[] = [
    { h: 0, s: 100, v: 100 },
    { h: 30, s: 100, v: 100 },
    { h: 60, s: 100, v: 100 },
    { h: 120, s: 100, v: 100 },
    { h: 180, s: 100, v: 100 },
    { h: 240, s: 100, v: 100 },
    { h: 300, s: 100, v: 100 }
];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const loadSwatches = (): Hsv[] => {
    try {
        const raw = localStorage.getItem(PAINT_SWATCH_STORAGE_KEY);
        if (!raw) return DEFAULT_SWATCHES.map(swatch => ({ ...swatch }));

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return DEFAULT_SWATCHES.map(swatch => ({ ...swatch }));

        return parsed.filter((swatch): swatch is Hsv => {
            return swatch && typeof swatch === 'object' &&
                Number.isFinite(swatch.h) && swatch.h >= 0 && swatch.h <= 360 &&
                Number.isFinite(swatch.s) && swatch.s >= 0 && swatch.s <= 100 &&
                Number.isFinite(swatch.v) && swatch.v >= 0 && swatch.v <= 100;
        }).map(swatch => ({ h: swatch.h, s: swatch.s, v: swatch.v }));
    } catch {
        return DEFAULT_SWATCHES.map(swatch => ({ ...swatch }));
    }
};

const saveSwatches = (swatches: Hsv[]): void => {
    try {
        localStorage.setItem(PAINT_SWATCH_STORAGE_KEY, JSON.stringify(swatches));
    } catch {
        // localStorage may be unavailable or full in embedded/private contexts.
    }
};

const hsvToRgb = ({ h, s, v }: Hsv) => {
    const hue = ((h % 360) + 360) % 360 / 60;
    const saturation = clamp(s, 0, 100) / 100;
    const value = clamp(v, 0, 100) / 100;
    const chroma = value * saturation;
    const x = chroma * (1 - Math.abs(hue % 2 - 1));
    const match = value - chroma;
    let rgb: [number, number, number];

    if (hue < 1) rgb = [chroma, x, 0];
    else if (hue < 2) rgb = [x, chroma, 0];
    else if (hue < 3) rgb = [0, chroma, x];
    else if (hue < 4) rgb = [0, x, chroma];
    else if (hue < 5) rgb = [x, 0, chroma];
    else rgb = [chroma, 0, x];

    return rgb.map(channel => channel + match) as [number, number, number];
};

const rgbToHsv = (r: number, g: number, b: number): Hsv => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;

    if (delta > 1e-6) {
        if (max === r) h = 60 * (((g - b) / delta) % 6);
        else if (max === g) h = 60 * ((b - r) / delta + 2);
        else h = 60 * ((r - g) / delta + 4);
    }

    if (h < 0) h += 360;
    return {
        h,
        s: max <= 1e-6 ? 0 : delta / max * 100,
        v: max * 100
    };
};

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

const createRevertBtn = () => {
    const btn = new Container({ class: 'row-revert-btn' });
    btn.dom.appendChild(createSvg(cornerUpLeftSvg));
    return btn;
};

/** Compact HSV palette shown in the scene panel while paint mode is active. */
class PaintPalette extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'paint-palette',
            hidden: true
        };

        super(args);

        const header = new Container({ class: 'panel-header' });
        const headerIcon = new Container({ class: 'panel-header-icon' });
        headerIcon.dom.appendChild(createSvg(paletteSvg));
        const headerLabel = new Label({
            class: 'panel-header-label',
            text: localize('paint.palette')
        });
        header.append(headerIcon);
        header.append(headerLabel);

        const swatchToggle = new Container({
            class: ['panel-header-button', 'paint-palette-swatch-toggle']
        });
        swatchToggle.dom.appendChild(createSvg(clipboardListSvg));
        header.append(swatchToggle);

        const wheel = document.createElement('div');
        wheel.className = 'paint-palette-wheel';
        wheel.setAttribute('role', 'group');
        wheel.setAttribute('aria-label', localize('paint.palette'));

        const hueRing = document.createElement('div');
        hueRing.className = 'paint-palette-hue';
        hueRing.setAttribute('role', 'slider');
        hueRing.setAttribute('aria-label', localize('paint.palette.hue'));

        const hueHandle = document.createElement('div');
        hueHandle.className = 'paint-palette-hue-handle';

        const svArea = document.createElement('div');
        svArea.className = 'paint-palette-sv';
        svArea.setAttribute('role', 'slider');
        svArea.setAttribute('aria-label', localize('paint.palette.saturation-value'));

        const svHandle = document.createElement('div');
        svHandle.className = 'paint-palette-sv-handle';

        svArea.append(svHandle);
        hueRing.append(svArea);
        hueRing.append(hueHandle);
        wheel.append(hueRing);

        let hsv: Hsv = { h: 0, s: 100, v: 100 };
        const swatches = loadSwatches();
        let swatchMode = false;
        let syncing = false;
        let emittingColor = false;
        let decalMode = false;
        let activePaintTool = 'brush';
        let decalMixStrength = 0;

        const swatchView = document.createElement('div');
        swatchView.className = 'paint-palette-swatch-view';
        swatchView.hidden = true;
        swatchView.setAttribute('role', 'list');
        swatchView.setAttribute('aria-label', localize('paint.palette.swatches'));

        const sliders: Record<'h' | 's' | 'v', MyFancySliderInput> = {
            h: new MyFancySliderInput({
                class: ['paint-palette-slider', 'paint-palette-slider-h'],
                min: 0,
                max: 360,
                step: 1,
                value: hsv.h
            }),
            s: new MyFancySliderInput({
                class: ['paint-palette-slider', 'paint-palette-slider-s'],
                min: 0,
                max: 100,
                step: 1,
                value: hsv.s
            }),
            v: new MyFancySliderInput({
                class: ['paint-palette-slider', 'paint-palette-slider-v'],
                min: 0,
                max: 100,
                step: 1,
                value: hsv.v
            })
        };

        const labels: Record<'h' | 's' | 'v', string> = {
            h: localize('paint.palette.hue'),
            s: localize('paint.palette.saturation'),
            v: localize('paint.palette.value')
        };

        const revertButtons: Record<'h' | 's' | 'v', Container> = {
            h: createRevertBtn(),
            s: createRevertBtn(),
            v: createRevertBtn()
        };

        const mixSlider = new MyFancySliderInput({
            class: ['paint-palette-slider', 'paint-palette-slider-mix'],
            min: 0,
            max: 100,
            step: 1,
            value: 0
        });
        const mixRevertButton = createRevertBtn();

        (['h', 's', 'v'] as const).forEach((channel) => {
            tooltips.register(revertButtons[channel], localize('paint.palette.reset'), 'bottom');
        });
        tooltips.register(mixRevertButton, localize('paint.palette.reset'), 'bottom');

        const sliderRows = (['h', 's', 'v'] as const).map((channel) => {
            const row = new Container({
                class: ['paint-palette-slider-row', `paint-palette-slider-row-${channel}`]
            });
            row.append(new Label({
                class: 'paint-palette-slider-label',
                text: labels[channel]
            }));
            row.append(sliders[channel]);
            row.append(revertButtons[channel]);
            return row;
        });

        const mixRow = new Container({
            class: ['paint-palette-slider-row', 'paint-palette-slider-row-mix'],
            hidden: true
        });
        mixRow.append(new Label({
            class: 'paint-palette-slider-label',
            text: localize('paint.palette.mix-strength')
        }));
        mixRow.append(mixSlider);
        mixRow.append(mixRevertButton);

        const sliderGroup = new Container({ class: 'paint-palette-sliders' });
        sliderRows.forEach(row => sliderGroup.append(row));
        sliderGroup.append(mixRow);

        const updateVisuals = () => {
            const hue = ((hsv.h % 360) + 360) % 360;
            const hueRadians = (hue - 90) * Math.PI / 180;
            hueHandle.style.left = `calc(50% + ${Math.cos(hueRadians) * HUE_INDICATOR_RADIUS}px)`;
            hueHandle.style.top = `calc(50% + ${Math.sin(hueRadians) * HUE_INDICATOR_RADIUS}px)`;
            hueHandle.style.transform = `translate(-50%, -50%) rotate(${hue}deg)`;
            svHandle.style.left = `${hsv.s}%`;
            svHandle.style.top = `${100 - hsv.v}%`;
            svArea.style.background = `linear-gradient(to top, #000 0%, transparent 100%), linear-gradient(to right, #fff 0%, hsl(${hue} 100% 50%) 100%)`;
        };

        const emitColor = () => {
            if (syncing) return;
            const [r, g, b] = hsvToRgb(decalMode ? { ...hsv, v: 100 } : hsv);
            // The RGB value cannot represent hue when saturation is zero, or
            // saturation when value is zero. Keep the HSV slider state while
            // this palette-originated update is echoed back through the paint
            // color events.
            emittingColor = true;
            try {
                events.fire('paint.color.set', [r, g, b]);
                if (decalMode) events.fire('paint.decal.brightness.set', hsv.v / 100);
            } finally {
                emittingColor = false;
            }
        };

        const setHsv = (next: Hsv, notify = true) => {
            hsv = {
                h: clamp(next.h, 0, 360),
                s: clamp(next.s, 0, 100),
                v: clamp(next.v, 0, 100)
            };
            syncing = true;
            sliders.h.value = hsv.h;
            sliders.s.value = hsv.s;
            sliders.v.value = hsv.v;
            syncing = false;
            updateVisuals();
            if (notify) emitColor();
        };

        const renderSwatches = () => {
            swatchView.replaceChildren();

            swatches.forEach((swatch, index) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'paint-palette-swatch';
                button.dataset.swatchIndex = index.toString();
                const [r, g, b] = hsvToRgb(swatch);
                button.style.backgroundColor = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
                button.setAttribute('aria-label', localize('paint.palette.swatch'));
                button.title = localize('paint.palette.swatch');

                let pointerId: number | null = null;
                let startX = 0;
                let startY = 0;
                let dragging = false;
                let suppressClick = false;
                let dragGhost: HTMLElement | null = null;

                const updateDragGhost = (event: PointerEvent) => {
                    if (!dragGhost) return;
                    dragGhost.style.left = `${event.clientX}px`;
                    dragGhost.style.top = `${event.clientY}px`;
                };

                const reorder = (event: PointerEvent) => {
                    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.paint-palette-swatch');
                    if (!target || target === button) return;

                    const targetIndex = Number(target.dataset.swatchIndex);
                    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= swatches.length) return;

                    const rect = target.getBoundingClientRect();
                    const after = event.clientY > rect.top + rect.height / 2 ||
                        (event.clientY >= rect.top && event.clientY <= rect.bottom &&
                            event.clientX > rect.left + rect.width / 2);
                    let insertionIndex = targetIndex + (after ? 1 : 0);
                    const [moved] = swatches.splice(index, 1);
                    if (index < insertionIndex) insertionIndex--;
                    swatches.splice(clamp(insertionIndex, 0, swatches.length), 0, moved);
                    saveSwatches(swatches);
                    renderSwatches();
                };

                const cleanupDrag = (event: PointerEvent) => {
                    if (pointerId !== event.pointerId) return;
                    if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
                    if (dragGhost) dragGhost.remove();
                    button.classList.remove('is-dragging');
                    pointerId = null;
                    dragGhost = null;
                    dragging = false;
                };

                button.addEventListener('pointerdown', (event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.stopPropagation();
                    pointerId = event.pointerId;
                    startX = event.clientX;
                    startY = event.clientY;
                    button.setPointerCapture(event.pointerId);
                });
                button.addEventListener('pointermove', (event) => {
                    if (pointerId !== event.pointerId) return;
                    if (!dragging && Math.hypot(event.clientX - startX, event.clientY - startY) < 4) return;
                    if (!dragging) {
                        dragging = true;
                        suppressClick = true;
                        button.classList.add('is-dragging');
                        dragGhost = button.cloneNode(true) as HTMLElement;
                        dragGhost.classList.add('paint-palette-swatch-drag-ghost');
                        document.body.appendChild(dragGhost);
                    }
                    updateDragGhost(event);
                });
                button.addEventListener('pointerup', (event) => {
                    if (pointerId !== event.pointerId) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (dragging) {
                        suppressClick = true;
                        reorder(event);
                    }
                    cleanupDrag(event);
                });
                button.addEventListener('pointercancel', cleanupDrag);
                button.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (suppressClick) {
                        suppressClick = false;
                        return;
                    }
                    setHsv(swatch);
                });
                button.addEventListener('contextmenu', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    swatches.splice(index, 1);
                    saveSwatches(swatches);
                    renderSwatches();
                });
                swatchView.append(button);
            });

            const addButton = document.createElement('button');
            addButton.type = 'button';
            addButton.className = 'paint-palette-swatch paint-palette-swatch-add';
            addButton.textContent = '+';
            addButton.setAttribute('aria-label', localize('paint.palette.add-swatch'));
            addButton.title = localize('paint.palette.add-swatch');
            addButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                swatches.push({ ...hsv });
                saveSwatches(swatches);
                renderSwatches();
            });
            addButton.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
            });
            swatchView.append(addButton);
        };

        const setSwatchMode = (visible: boolean) => {
            swatchMode = visible;
            wheel.hidden = visible;
            swatchView.hidden = !visible;
            swatchToggle.class.remove('active');
            swatchToggle.dom.replaceChildren(createSvg(visible ? paletteSvg : clipboardListSvg));
            headerIcon.dom.replaceChildren(createSvg(visible ? clipboardListSvg : paletteSvg));
            headerLabel.text = localize(visible ? 'paint.palette.swatches' : 'paint.palette');
            const label = localize(visible ? 'paint.palette.show-picker' : 'paint.palette.swatches');
            swatchToggle.dom.setAttribute('aria-label', label);
            tooltips.unregister(swatchToggle);
            tooltips.register(swatchToggle, label, 'bottom');
        };

        swatchToggle.on('click', () => setSwatchMode(!swatchMode));
        setSwatchMode(false);
        renderSwatches();

        const setRgb = (r: number, g: number, b: number) => {
            setHsv(rgbToHsv(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)), false);
        };

        const setHueFromPointer = (event: PointerEvent) => {
            const rect = hueRing.getBoundingClientRect();
            const x = event.clientX - rect.left - rect.width / 2;
            const y = event.clientY - rect.top - rect.height / 2;
            const angle = (Math.atan2(y, x) * 180 / Math.PI + 90 + 360) % 360;
            setHsv({ ...hsv, h: angle });
        };

        const setSvFromPointer = (event: PointerEvent) => {
            const rect = svArea.getBoundingClientRect();
            setHsv({
                ...hsv,
                s: clamp((event.clientX - rect.left) / rect.width * 100, 0, 100),
                v: clamp(100 - (event.clientY - rect.top) / rect.height * 100, 0, 100)
            });
        };

        const attachPointerDrag = (target: HTMLElement, handler: (event: PointerEvent) => void) => {
            let pointerId: number | null = null;
            target.addEventListener('pointerdown', (event) => {
                event.preventDefault();
                event.stopPropagation();
                pointerId = event.pointerId;
                target.setPointerCapture(pointerId);
                handler(event);
            });
            target.addEventListener('pointermove', (event) => {
                if (event.pointerId !== pointerId) return;
                event.preventDefault();
                event.stopPropagation();
                handler(event);
            });
            const release = (event: PointerEvent) => {
                if (event.pointerId !== pointerId) return;
                pointerId = null;
                if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
            };
            target.addEventListener('pointerup', release);
            target.addEventListener('pointercancel', release);
        };

        attachPointerDrag(hueRing, setHueFromPointer);
        attachPointerDrag(svArea, setSvFromPointer);

        sliders.h.on('change', value => setHsv({ ...hsv, h: value }));
        sliders.s.on('change', value => setHsv({ ...hsv, s: value }));
        sliders.v.on('change', value => setHsv({ ...hsv, v: value }));
        mixSlider.on('change', (value) => {
            if (syncing) return;
            decalMixStrength = clamp(value, 0, 100) / 100;
            events.fire('paint.decal.mixStrength.set', decalMixStrength);
        });

        revertButtons.h.on('click', () => setHsv({ ...hsv, h: 0 }));
        revertButtons.s.on('click', () => setHsv({ ...hsv, s: 100 }));
        revertButtons.v.on('click', () => setHsv({ ...hsv, v: 100 }));
        mixRevertButton.on('click', () => {
            decalMixStrength = 0;
            syncing = true;
            mixSlider.value = 0;
            syncing = false;
            events.fire('paint.decal.mixStrength.set', 0);
        });

        events.on('paint.color.changed', (value: any) => {
            if (emittingColor) return;
            const updateFromRgb = (r: number, g: number, b: number) => {
                const next = rgbToHsv(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1));
                setHsv(decalMode ? { h: next.h, s: next.s, v: hsv.v } : next, false);
            };
            if (Array.isArray(value)) {
                updateFromRgb(value[0], value[1], value[2]);
            } else if (value && typeof value.r === 'number') {
                updateFromRgb(value.r, value.g, value.b);
            }
        });

        events.on('paint.decal.brightness.changed', (value: number) => {
            if (!decalMode || syncing) return;
            setHsv({ ...hsv, v: clamp(value, 0, 1) * 100 }, false);
        });

        events.on('paint.decal.mixStrength.changed', (value: number) => {
            decalMixStrength = clamp(value, 0, 1);
            syncing = true;
            mixSlider.value = decalMixStrength * 100;
            syncing = false;
        });

        const updatePaletteToolMode = () => {
            decalMode = activePaintTool === 'decal';
            mixRow.hidden = !decalMode;
            if (decalMode) {
                const brightness = events.functions.has('paint.decal.brightness') ?
                    events.invoke('paint.decal.brightness') as number : 1;
                const mixStrength = events.functions.has('paint.decal.mixStrength') ?
                    events.invoke('paint.decal.mixStrength') as number : 0;
                setHsv({ ...hsv, v: clamp(brightness, 0, 1) * 100 }, false);
                decalMixStrength = clamp(mixStrength, 0, 1);
                syncing = true;
                mixSlider.value = decalMixStrength * 100;
                syncing = false;
            } else if (events.functions.has('paint.color')) {
                const value = events.invoke('paint.color') as any;
                if (value && typeof value.r === 'number') setRgb(value.r, value.g, value.b);
            }
        };

        events.on('paint.tool.changed', (toolName: string) => {
            activePaintTool = toolName;
            updatePaletteToolMode();
        });

        events.on('paint.decal.mode.changed', updatePaletteToolMode);

        this.append(header);
        this.append(wheel);
        this.append(swatchView);
        this.append(sliderGroup);
        updateVisuals();

        // PaintTool is registered after the UI. Read its default color once it
        // exists, while keeping red as the standalone palette default.
        requestAnimationFrame(() => {
            if (!events.functions.has('paint.color')) return;
            const value = events.invoke('paint.color') as any;
            if (value && typeof value.r === 'number') setRgb(value.r, value.g, value.b);
        });
    }
}

export { PaintPalette };
