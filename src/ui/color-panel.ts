import { ColorPicker, Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';
import { Color } from 'playcanvas';

import { Events } from '../events';
import { localize } from './localization';
import { Tooltips } from './tooltips';
import { BackendClient } from '../backend';
import { BlockingPlane } from '../blocking-plane';
import { BoxShape } from '../box-shape';
import { SetSplatColorAdjustmentOp } from '../edit-ops';
import { Element } from '../element';
import { GaussianLUT } from '../lut';
import { SphereShape } from '../sphere-shape';
import { Splat } from '../splat';
import cornerUpLeftSvg from './svg/corner-up-left.svg';
import fileDownSvg from './svg/file-down.svg';
import importSvg from './svg/import.svg';

// -- LUT backend/static fallback -------------------------------------------------
// When the Node.js backend is available, LUT files are served from
// http://localhost:3266/static/luts/ and listed via /api/luts.
// In static deployments (GitHub Pages), there is no backend, so we
// fall back to relative paths (`./static/luts/…`) and a pre-generated
// manifest.json file that lists all available LUT PNGs.
let backendAvailable: boolean | null = null;
const initBackendCheck = async () => {
    backendAvailable = await BackendClient.isAvailable();
};
initBackendCheck();

const lutBaseUrl = (): string => (backendAvailable ? BackendClient.BASE_URL : '.');

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

// 创建行级撤回按钮（恢复单个参数到初始值），图标 16x16
const createRevertBtn = (onRevert: () => void) => {
    const btn = new Container({
        class: 'row-revert-btn'
    });
    btn.dom.appendChild(createSvg(cornerUpLeftSvg));
    btn.on('click', onRevert);
    return btn;
};

// pcui slider doesn't include start and end events
class MyFancySliderInput extends SliderInput {
    // ResizeObserver used to refresh handle position once the handle
    // is laid out (getBoundingClientRect().width returns 0 while the
    // element is detached or hidden, which makes the stock _updateHandle
    // set left=calc(50%+0px); combined with CSS margin-left:-9px the
    // handle ends up ~9px left of center).
    private _handleRO: ResizeObserver | null = null;
    private _lastValue = 0;

    _onSlideStart(pageX: number) {
        super._onSlideStart(pageX);
        this.emit('slide:start');
    }

    _onSlideEnd(pageX: number) {
        super._onSlideEnd(pageX);
        this.emit('slide:end');
    }

    _updateHandle(value: number) {
        this._lastValue = value;
        const left = Math.max(0, Math.min(1, ((value || 0) - this._sliderMin) / (this._sliderMax - this._sliderMin))) * 100;
        const handleWidth = this._domHandle.getBoundingClientRect().width;
        if (handleWidth > 0) {
            this._domHandle.style.left = `calc(${left}% + ${handleWidth / 2}px)`;
            // layout ready — stop observing
            if (this._handleRO) {
                this._handleRO.disconnect();
                this._handleRO = null;
            }
        } else {
            // handle not laid out yet: fall back to CSS width so the handle
            // is ~centered instead of stuck 9px left, then observe until the
            // real width is available.
            const cssWidth = parseFloat(getComputedStyle(this._domHandle).width) || 8;
            this._domHandle.style.left = `calc(${left}% + ${cssWidth / 2}px)`;
            if (!this._handleRO) {
                this._handleRO = new ResizeObserver(() => this._updateHandle(this._lastValue));
                this._handleRO.observe(this._domHandle);
            }
        }
    }
}

class ColorPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args: any = {}) {
        const embedded = args.embedded;
        args = {
            ...args,
            id: 'color-panel',
            class: embedded ? '' : 'panel',
            hidden: !embedded
        };

        super(args);

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });
        // wheel: stopPropagation but allow default scrolling (passive: true)
        this.dom.addEventListener('wheel', (event: Event) => event.stopPropagation(), { passive: true });

        // header

        const header = new Container({
            class: 'panel-header'
        });

        const icon = new Label({
            class: 'panel-header-icon',
            text: '\uE146'
        });

        const label = new Label({
            class: 'panel-header-label',
            text: localize('panel.colors')
        });

        header.append(icon);
        header.append(label);

        const reset = new Label({
            class: 'panel-header-button',
            text: '\uE304'
        });

        header.append(reset);

        // tint

        const tintRow = new Container({
            class: 'color-panel-row'
        });

        const tintLabel = new Label({
            text: localize('panel.colors.tint'),
            class: 'color-panel-row-label'
        });

        const tintPicker = new ColorPicker({
            class: 'color-panel-row-picker',
            value: [1, 1, 1]
        });

        tintRow.append(tintLabel);
        tintRow.append(tintPicker);

        // 撤回：恢复色调到白色 (1,1,1)
        const tintRevert = createRevertBtn(() => {
            if (selectedShape) {
                selectedShape.color = new Color(1, 1, 1);
                updateShapeUIFromState(selectedShape);
            } else if (selected) {
                revertParam((s: any) => {
                    s.tintClr = new Color(1, 1, 1);
                });
            }
        });
        tooltips.register(tintRevert, '恢复默认值', 'bottom');
        tintRow.append(tintRevert);

        // temperature

        const temperatureRow = new Container({
            class: 'color-panel-row'
        });

        const temperatureLabel = new Label({
            text: localize('panel.colors.temperature'),
            class: 'color-panel-row-label'
        });

        const temperatureSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: -0.5,
            max: 0.5,
            step: 0.005,
            value: 0
        });

        temperatureRow.append(temperatureLabel);
        temperatureRow.append(temperatureSlider);

        // 撤回：恢复色温到 0
        const temperatureRevert = createRevertBtn(() => {
            revertParam((s: any) => {
                s.temperature = 0;
            });
        });
        tooltips.register(temperatureRevert, '恢复默认值', 'bottom');
        temperatureRow.append(temperatureRevert);

        // saturation

        const saturationRow = new Container({
            class: 'color-panel-row'
        });

        const saturationLabel = new Label({
            text: localize('panel.colors.saturation'),
            class: 'color-panel-row-label'
        });

        const saturationSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: 0,
            max: 2,
            step: 0.1,
            value: 1
        });

        saturationRow.append(saturationLabel);
        saturationRow.append(saturationSlider);

        // 撤回：恢复饱和度到 1
        const saturationRevert = createRevertBtn(() => {
            revertParam((s: any) => {
                s.saturation = 1;
            });
        });
        tooltips.register(saturationRevert, '恢复默认值', 'bottom');
        saturationRow.append(saturationRevert);

        // brightness

        const brightnessRow = new Container({
            class: 'color-panel-row'
        });

        const brightnessLabel = new Label({
            text: localize('panel.colors.brightness'),
            class: 'color-panel-row-label'
        });

        const brightnessSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: -1,
            max: 1,
            step: 0.1,
            value: 0
        });

        brightnessRow.append(brightnessLabel);
        brightnessRow.append(brightnessSlider);

        // 撤回：恢复亮度到 0
        const brightnessRevert = createRevertBtn(() => {
            revertParam((s: any) => {
                s.brightness = 0;
            });
        });
        tooltips.register(brightnessRevert, '恢复默认值', 'bottom');
        brightnessRow.append(brightnessRevert);

        // black point

        const blackPointRow = new Container({
            class: 'color-panel-row'
        });

        const blackPointLabel = new Label({
            text: localize('panel.colors.black-point'),
            class: 'color-panel-row-label'
        });

        const blackPointSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: 0,
            max: 1,
            step: 0.01,
            value: 0
        });

        blackPointRow.append(blackPointLabel);
        blackPointRow.append(blackPointSlider);

        // 撤回：恢复黑点（black point）到 0
        const blackPointRevert = createRevertBtn(() => {
            revertParam((s: any) => {
                s.blackPoint = 0;
            });
        });
        tooltips.register(blackPointRevert, '恢复默认值', 'bottom');
        blackPointRow.append(blackPointRevert);

        // white point

        const whitePointRow = new Container({
            class: 'color-panel-row'
        });

        const whitePointLabel = new Label({
            text: localize('panel.colors.white-point'),
            class: 'color-panel-row-label'
        });

        const whitePointSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: 0,
            max: 1,
            step: 0.01,
            value: 1
        });

        whitePointRow.append(whitePointLabel);
        whitePointRow.append(whitePointSlider);

        // 撤回：恢复白点（white point）到 1
        const whitePointRevert = createRevertBtn(() => {
            revertParam((s: any) => {
                s.whitePoint = 1;
            });
        });
        tooltips.register(whitePointRevert, '恢复默认值', 'bottom');
        whitePointRow.append(whitePointRevert);

        // transparency

        const transparencyRow = new Container({
            class: 'color-panel-row'
        });

        const transparencyLabel = new Label({
            text: localize('panel.colors.transparency'),
            class: 'color-panel-row-label'
        });

        const transparencySlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: -6,
            max: 6,
            step: 0.01,
            value: 0
        });

        transparencyRow.append(transparencyLabel);
        transparencyRow.append(transparencySlider);

        // 撤回：恢复透明度到 1（对应滑条值 0）
        const transparencyRevert = createRevertBtn(() => {
            revertParam((s: any) => {
                s.transparency = 1;
            });
        });
        tooltips.register(transparencyRevert, '恢复默认值', 'bottom');
        transparencyRow.append(transparencyRevert);

        // LUT color grading: preset dropdown + custom file loader + intensity slider

        const lutRow = new Container({
            class: 'color-panel-row'
        });

        const lutLabel = new Label({
            text: localize('panel.colors.lut'),
            class: 'color-panel-row-label'
        });

        const lutSelect = new SelectInput({
            class: 'color-panel-row-select',
            defaultValue: '默认.png',
            options: [
                { v: '默认.png', t: '默认' }
            ]
        });

        // Dynamic LUT file list from static/luts/
        const defaultLutFile = '默认.png';
        const loadLutFileList = async () => {
            const sortFiles = (files: string[]) => {
                const pngFiles = files.filter(f => /\.png$/i.test(f));
                pngFiles.sort((a, b) => {
                    if (a === defaultLutFile) return -1;
                    if (b === defaultLutFile) return 1;
                    return a.localeCompare(b);
                });
                return pngFiles.map(f => ({
                    v: f,
                    t: f.replace(/\.png$/i, '')
                }));
            };

            // Try backend API first (local dev / Electron)
            try {
                const resp = await fetch(`${BackendClient.BASE_URL}/api/luts`);
                const files: string[] = await resp.json();
                lutSelect.options = sortFiles(files);
                return;
            } catch { /* fallback to static manifest */ }

            // Static fallback: load pre-generated manifest.json
            try {
                const resp = await fetch(`${lutBaseUrl()}/static/luts/manifest.json`);
                const files: string[] = await resp.json();
                lutSelect.options = sortFiles(files);
            } catch (e) {
                console.error('[color-panel] Failed to load LUT file list:', e);
            }
        };
        loadLutFileList();

        const lutLoadBtn = new Container({
            class: ['panel-header-button', 'scene-import-btn']
        });
        lutLoadBtn.dom.appendChild(createSvg(importSvg));

        const lutDownloadBtn = new Container({
            class: ['panel-header-button', 'scene-import-btn']
        });
        lutDownloadBtn.dom.appendChild(createSvg(fileDownSvg));

        const lutIntensitySlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: 0,
            max: 1,
            step: 0.01,
            value: 1
        });

        // LUT intensity row (separate from preset row so the slider gets full width)
        const lutIntensityRow = new Container({
            class: 'color-panel-row'
        });
        lutIntensityRow.dom.classList.add('lut-intensity-row');

        const lutIntensityLabel = new Label({
            text: localize('panel.colors.lut.intensity'),
            class: 'color-panel-row-label'
        });

        lutIntensityRow.append(lutIntensityLabel);
        lutIntensityRow.append(lutIntensitySlider);

        // 撤回：恢复 LUT 强度到 1
        const lutIntensityRevert = createRevertBtn(() => {
            revertParam((s: any) => {
                s.lutIntensity = 1;
            });
        });
        tooltips.register(lutIntensityRevert, '恢复默认值', 'bottom');
        lutIntensityRow.append(lutIntensityRevert);

        // 撤回：恢复 LUT 预设到默认
        const lutRevert = createRevertBtn(async () => {
            if (!selected) return;
            try {
                const lut = await GaussianLUT.fromUrl(
                    `${lutBaseUrl()}/static/luts/${defaultLutFile}`,
                    '默认',
                    defaultLutFile
                );
                start();
                if (op) {
                    op.newState.lut = lut;
                    if (op.newState.lutIntensity === 0) {
                        op.newState.lutIntensity = 1;
                        suppress = true;
                        lutIntensitySlider.value = 1;
                        suppress = false;
                    }
                    op.do();
                }
                end();
            } catch (e) {
                console.error('[color-panel] LUT default load failed:', e);
                updateUIFromState(selected);
            }
        });
        tooltips.register(lutRevert, '恢复默认值', 'bottom');

        lutRow.append(lutLabel);
        lutRow.append(lutSelect);
        lutRow.append(lutLoadBtn);
        lutRow.append(lutDownloadBtn);
        lutRow.append(lutRevert);

        // Pick a LUT PNG file via native picker (Electron) or showOpenFilePicker (browser).
        // Mirrors the pickLccFile pattern in doc.ts.
        const pickLutFile = (): Promise<File | null> => {
            return new Promise((resolve) => {
                if (window.showOpenFilePicker) {
                    window.showOpenFilePicker({
                        multiple: false,
                        types: [{
                            description: 'LUT PNG image',
                            accept: { 'image/png': ['.png'] }
                        }]
                    }).then(async (handles) => {
                        resolve(handles?.length === 1 ? await handles[0].getFile() : null);
                    }).catch((e: Error) => {
                        if (e.name !== 'AbortError') console.error('[color-panel] pickLutFile failed:', e);
                        resolve(null);
                    });
                    return;
                }
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.png,image/png';
                let resolved = false;
                const finish = (file: File | null) => {
                    if (resolved) return;
                    resolved = true;
                    resolve(file);
                };
                input.onchange = () => finish(input.files?.[0] ?? null);
                input.addEventListener('cancel', () => finish(null), { once: true });
                input.click();
            });
        };

        // HSL mixer: 3 sections (hue/saturation/lightness) × 8 color ranges
        // With toggle buttons: Hue / Saturation / Lightness / All

        const hslColorRanges = [
            { key: 'red', label: localize('panel.colors.mixer.red') },
            { key: 'orange', label: localize('panel.colors.mixer.orange') },
            { key: 'yellow', label: localize('panel.colors.mixer.yellow') },
            { key: 'green', label: localize('panel.colors.mixer.green') },
            { key: 'aqua', label: localize('panel.colors.mixer.aqua') },
            { key: 'blue', label: localize('panel.colors.mixer.blue') },
            { key: 'purple', label: localize('panel.colors.mixer.purple') },
            { key: 'magenta', label: localize('panel.colors.mixer.magenta') }
        ];

        // Toggle buttons container
        const hslToggleContainer = new Container({
            class: 'color-panel-mixer-toggle'
        });

        // Create toggle buttons
        const createToggleButton = (text: string) => {
            return new Label({
                text: text,
                class: 'color-panel-mixer-toggle-btn'
            });
        };

        const hueToggleBtn = createToggleButton(localize('panel.colors.mixer.hue'));
        const satToggleBtn = createToggleButton(localize('panel.colors.mixer.saturation'));
        const lightToggleBtn = createToggleButton(localize('panel.colors.mixer.lightness'));
        const allToggleBtn = createToggleButton(localize('panel.colors.mixer.all'));

        hslToggleContainer.append(hueToggleBtn);
        hslToggleContainer.append(satToggleBtn);
        hslToggleContainer.append(lightToggleBtn);
        hslToggleContainer.append(allToggleBtn);

        // Create a mixer section with 8 sliders and a title (title hidden unless in "all" mode)
        const createMixerSection = (title: string, type: 'hue' | 'saturation' | 'lightness', min: number, max: number) => {
            const section = new Container({
                class: 'color-panel-mixer-section'
            });

            const titleLabel = new Label({
                text: title,
                class: 'color-panel-mixer-title'
            });
            section.append(titleLabel);

            const sliders: MyFancySliderInput[] = [];
            hslColorRanges.forEach((range, i) => {
                const row = new Container({
                    class: 'color-panel-row'
                });
                // 双属性标识：用于 CSS 选择器定位每个滑条的渐变背景
                row.dom.setAttribute('data-mixer-type', type);
                row.dom.setAttribute('data-color-range', range.key);

                const rowLabel = new Label({
                    text: range.label,
                    class: 'color-panel-row-label'
                });
                const slider = new MyFancySliderInput({
                    class: 'color-panel-row-slider',
                    min: min,
                    max: max,
                    step: 1,
                    value: 0
                });

                // 撤回：恢复该 HSL 滑条到 0
                const mixerRevert = createRevertBtn(() => {
                    revertParam((s: any) => {
                        if (type === 'hue') {
                            s.hslHueShifts[i] = 0;
                        } else if (type === 'saturation') {
                            s.hslSatShifts[i] = 0;
                        } else {
                            s.hslLightShifts[i] = 0;
                        }
                    });
                });
                tooltips.register(mixerRevert, '恢复默认值', 'bottom');

                row.append(rowLabel);
                row.append(slider);
                row.append(mixerRevert);
                section.append(row);
                sliders.push(slider);
            });

            return { section, sliders, titleLabel };
        };

        const hueSection = createMixerSection(localize('panel.colors.mixer.hue'), 'hue', -180, 180);
        const satSection = createMixerSection(localize('panel.colors.mixer.saturation'), 'saturation', -100, 100);
        const lightSection = createMixerSection(localize('panel.colors.mixer.lightness'), 'lightness', -100, 100);

        const hslHueSliders = hueSection.sliders;
        const hslSatSliders = satSection.sliders;
        const hslLightSliders = lightSection.sliders;
        const hslTitles = [hueSection.titleLabel, satSection.titleLabel, lightSection.titleLabel];
        const hslSections = [hueSection.section, satSection.section, lightSection.section];

        // Toggle button logic: only one can be active at a time
        let activeHslMode: 'hue' | 'saturation' | 'lightness' | 'all' = 'hue';

        const updateHslToggleUI = () => {
            hueToggleBtn.class.remove('active');
            satToggleBtn.class.remove('active');
            lightToggleBtn.class.remove('active');
            allToggleBtn.class.remove('active');

            // Show titles only in "all" mode
            const showTitles = activeHslMode === 'all';
            hslTitles.forEach((t) => {
                t.hidden = !showTitles;
            });

            if (activeHslMode === 'hue') {
                hueToggleBtn.class.add('active');
                hueSection.section.hidden = false;
                satSection.section.hidden = true;
                lightSection.section.hidden = true;
            } else if (activeHslMode === 'saturation') {
                satToggleBtn.class.add('active');
                hueSection.section.hidden = true;
                satSection.section.hidden = false;
                lightSection.section.hidden = true;
            } else if (activeHslMode === 'lightness') {
                lightToggleBtn.class.add('active');
                hueSection.section.hidden = true;
                satSection.section.hidden = true;
                lightSection.section.hidden = false;
            } else {
                allToggleBtn.class.add('active');
                hueSection.section.hidden = false;
                satSection.section.hidden = false;
                lightSection.section.hidden = false;
            }
        };

        hueToggleBtn.on('click', () => {
            activeHslMode = 'hue'; updateHslToggleUI();
        });
        satToggleBtn.on('click', () => {
            activeHslMode = 'saturation'; updateHslToggleUI();
        });
        lightToggleBtn.on('click', () => {
            activeHslMode = 'lightness'; updateHslToggleUI();
        });
        allToggleBtn.on('click', () => {
            activeHslMode = 'all'; updateHslToggleUI();
        });

        // Default: show hue only
        updateHslToggleUI();

        this.append(header);
        this.append(tintRow);
        this.append(temperatureRow);
        this.append(saturationRow);
        this.append(brightnessRow);
        this.append(blackPointRow);
        this.append(whitePointRow);
        this.append(transparencyRow);
        this.append(lutRow);
        this.append(lutIntensityRow);
        this.append(hslToggleContainer);
        hslSections.forEach(s => this.append(s));

        // handle ui updates

        let suppress = false;
        let selected: Splat = null;
        let selectedShape: SphereShape | BoxShape | BlockingPlane | null = null;
        let op: SetSplatColorAdjustmentOp = null;

        const updateUIFromState = (splat: Splat) => {
            if (suppress) return;
            suppress = true;
            tintPicker.value = splat ? [splat.tintClr.r, splat.tintClr.g, splat.tintClr.b] : [1, 1, 1];
            temperatureSlider.value = splat ? splat.temperature : 0;
            saturationSlider.value = splat ? splat.saturation : 0;
            brightnessSlider.value = splat ? splat.brightness : 0;
            blackPointSlider.value = splat ? splat.blackPoint : 0;
            whitePointSlider.value = splat ? splat.whitePoint : 1;
            transparencySlider.value = splat ? Math.log(splat.transparency) : 0;
            // LUT: reflect preset id or default
            if (splat && splat.lut) {
                lutSelect.value = splat.lut.presetId ?? defaultLutFile;
            } else {
                lutSelect.value = defaultLutFile;
            }
            lutIntensitySlider.value = splat ? splat.lutIntensity : 1;
            // HSL mixer: slider values are in degrees/percent, stored normalized
            for (let i = 0; i < 8; i++) {
                hslHueSliders[i].value = splat ? splat.hslHueShifts[i] * 360 : 0;
                hslSatSliders[i].value = splat ? splat.hslSatShifts[i] * 100 : 0;
                hslLightSliders[i].value = splat ? splat.hslLightShifts[i] * 100 : 0;
            }
            suppress = false;
        };

        const updateShapeUIFromState = (shape: SphereShape | BoxShape | BlockingPlane | null) => {
            if (suppress) return;
            suppress = true;
            if (shape) {
                tintPicker.value = [shape.color.r, shape.color.g, shape.color.b];
            } else {
                tintPicker.value = [1, 1, 1];
            }
            // Hide splat-specific controls when shape is selected
            const isShape = !!shape;
            temperatureRow.hidden = isShape;
            saturationRow.hidden = isShape;
            brightnessRow.hidden = isShape;
            blackPointRow.hidden = isShape;
            whitePointRow.hidden = isShape;
            transparencyRow.hidden = isShape;
            lutRow.hidden = isShape;
            hslSections.forEach((s) => {
                s.hidden = isShape;
            });
            suppress = false;
        };

        const startShapeOp = () => {
            if (selectedShape) {
                // Directly modify shape color, no undo op for now
                // Could add ShapeColorOp later if needed
            }
        };

        const endShapeOp = () => {
            // No undo op registration for shape color
        };

        const start = () => {
            if (selected) {
                op = new SetSplatColorAdjustmentOp({
                    splat: selected,
                    newState: {
                        tintClr: selected.tintClr.clone(),
                        temperature: selected.temperature,
                        saturation: selected.saturation,
                        brightness: selected.brightness,
                        blackPoint: selected.blackPoint,
                        whitePoint: selected.whitePoint,
                        transparency: selected.transparency,
                        hslHueShifts: Array.from(selected.hslHueShifts),
                        hslSatShifts: Array.from(selected.hslSatShifts),
                        hslLightShifts: Array.from(selected.hslLightShifts),
                        lut: selected.lut,
                        lutIntensity: selected.lutIntensity
                    },
                    oldState: {
                        tintClr: selected.tintClr.clone(),
                        temperature: selected.temperature,
                        saturation: selected.saturation,
                        brightness: selected.brightness,
                        blackPoint: selected.blackPoint,
                        whitePoint: selected.whitePoint,
                        transparency: selected.transparency,
                        hslHueShifts: Array.from(selected.hslHueShifts),
                        hslSatShifts: Array.from(selected.hslSatShifts),
                        hslLightShifts: Array.from(selected.hslLightShifts),
                        lut: selected.lut,
                        lutIntensity: selected.lutIntensity
                    }
                });
            }
        };

        const end = () => {
            if (op) {
                const { newState } = op;
                newState.tintClr.set(tintPicker.value[0], tintPicker.value[1], tintPicker.value[2]);
                newState.temperature = temperatureSlider.value;
                newState.saturation = saturationSlider.value;
                newState.brightness = brightnessSlider.value;
                newState.blackPoint = blackPointSlider.value;
                newState.whitePoint = whitePointSlider.value;
                newState.transparency = Math.exp(transparencySlider.value);
                newState.hslHueShifts = hslHueSliders.map(s => s.value / 360);
                newState.hslSatShifts = hslSatSliders.map(s => s.value / 100);
                newState.hslLightShifts = hslLightSliders.map(s => s.value / 100);
                newState.lutIntensity = lutIntensitySlider.value;
                events.fire('edit.add', op);
                op = null;
            }
        };

        const updateOp = (setFunc: (op: SetSplatColorAdjustmentOp) => void) => {
            if (!suppress) {
                suppress = true;
                if (op) {
                    setFunc(op);
                    op.do();
                } else if (selected) {
                    start();
                    setFunc(op);
                    op.do();
                    end();
                }
                suppress = false;
            }
        };

        // 行级撤回：创建一个只修改单个参数的 op（oldState=当前值，newState=当前值+恢复项）
        // 'edit.add' 会调用 op.do() 将 newState 应用到 splat，并注册到撤销历史。
        const revertParam = (setFunc: (newState: any) => void) => {
            if (!selected) return;
            const revertOp = new SetSplatColorAdjustmentOp({
                splat: selected,
                newState: {
                    tintClr: selected.tintClr.clone(),
                    temperature: selected.temperature,
                    saturation: selected.saturation,
                    brightness: selected.brightness,
                    blackPoint: selected.blackPoint,
                    whitePoint: selected.whitePoint,
                    transparency: selected.transparency,
                    hslHueShifts: Array.from(selected.hslHueShifts),
                    hslSatShifts: Array.from(selected.hslSatShifts),
                    hslLightShifts: Array.from(selected.hslLightShifts),
                    lut: selected.lut,
                    lutIntensity: selected.lutIntensity
                },
                oldState: {
                    tintClr: selected.tintClr.clone(),
                    temperature: selected.temperature,
                    saturation: selected.saturation,
                    brightness: selected.brightness,
                    blackPoint: selected.blackPoint,
                    whitePoint: selected.whitePoint,
                    transparency: selected.transparency,
                    hslHueShifts: Array.from(selected.hslHueShifts),
                    hslSatShifts: Array.from(selected.hslSatShifts),
                    hslLightShifts: Array.from(selected.hslLightShifts),
                    lut: selected.lut,
                    lutIntensity: selected.lutIntensity
                }
            });
            setFunc(revertOp.newState);
            events.fire('edit.add', revertOp);
        };

        [temperatureSlider, saturationSlider, brightnessSlider, blackPointSlider, whitePointSlider, transparencySlider, lutIntensitySlider].forEach((slider) => {
            slider.on('slide:start', start);
            slider.on('slide:end', end);
        });

        // HSL mixer slider events
        [...hslHueSliders, ...hslSatSliders, ...hslLightSliders].forEach((slider) => {
            slider.on('slide:start', start);
            slider.on('slide:end', end);
        });
        hslHueSliders.forEach((slider, i) => {
            slider.on('change', (value: number) => {
                updateOp((op) => {
                    if (!op.newState.hslHueShifts) op.newState.hslHueShifts = new Array(8).fill(0);
                    op.newState.hslHueShifts[i] = value / 360;
                });
            });
        });
        hslSatSliders.forEach((slider, i) => {
            slider.on('change', (value: number) => {
                updateOp((op) => {
                    if (!op.newState.hslSatShifts) op.newState.hslSatShifts = new Array(8).fill(0);
                    op.newState.hslSatShifts[i] = value / 100;
                });
            });
        });
        hslLightSliders.forEach((slider, i) => {
            slider.on('change', (value: number) => {
                updateOp((op) => {
                    if (!op.newState.hslLightShifts) op.newState.hslLightShifts = new Array(8).fill(0);
                    op.newState.hslLightShifts[i] = value / 100;
                });
            });
        });
        tintPicker.on('picker:color:start', () => {
            if (selectedShape) {
                startShapeOp();
            } else {
                start();
            }
        });
        tintPicker.on('picker:color:end', () => {
            if (selectedShape) {
                endShapeOp();
            } else {
                end();
            }
        });

        tintPicker.on('change', (value: number[]) => {
            // Handle shape color change
            if (selectedShape) {
                selectedShape.color = new Color(value[0], value[1], value[2]);
                return;
            }
            // Handle splat color change
            updateOp((op) => {
                op.newState.tintClr.set(value[0], value[1], value[2]);
            });
        });

        temperatureSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.temperature = value;
            });
        });

        saturationSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.saturation = value;
            });
        });

        brightnessSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.brightness = value;
            });
        });

        blackPointSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.blackPoint = value;
            });

            if (value > whitePointSlider.value) {
                whitePointSlider.value = value;
            }
        });

        whitePointSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.whitePoint = value;
            });

            if (value < blackPointSlider.value) {
                blackPointSlider.value = value;
            }
        });

        transparencySlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.transparency = Math.exp(value);
            });
        });

        // LUT intensity slider
        lutIntensitySlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.lutIntensity = value;
            });
        });

        // LUT preset dropdown: dynamic list from static/luts/
        lutSelect.on('change', async (value: string) => {
            if (!selected || suppress) return;
            // LUT from static/luts/<filename>
            const name = value.replace(/\.png$/i, '');
            try {
                const lut = await GaussianLUT.fromUrl(`${lutBaseUrl()}/static/luts/${value}`, name, value);
                start();
                if (op) {
                    op.newState.lut = lut;
                    if (op.newState.lutIntensity === 0) {
                        op.newState.lutIntensity = 1;
                        suppress = true;
                        lutIntensitySlider.value = 1;
                        suppress = false;
                    }
                    op.do();
                }
                end();
            } catch (e) {
                console.error('[color-panel] LUT load failed:', e);
                updateUIFromState(selected);
            }
        });

        // LUT custom file load button
        lutLoadBtn.on('click', async () => {
            if (!selected) return;
            const file = await pickLutFile();
            if (!file) return;
            try {
                const lut = await GaussianLUT.fromFile(file);
                // apply directly; splat.lut event → updateUIFromState syncs the dropdown
                start();
                if (op) {
                    op.newState.lut = lut;
                    if (op.newState.lutIntensity === 0) {
                        op.newState.lutIntensity = 1;
                        suppress = true;
                        lutIntensitySlider.value = 1;
                        suppress = false;
                    }
                    op.do();
                }
                end();
            } catch (e) {
                console.error('[color-panel] LUT custom load failed:', e);
            }
        });

        // Download 默认.png as a LUT template, saved as Base_lut.png to user-chosen path
        lutDownloadBtn.on('click', async () => {
            try {
                const resp = await fetch(`${lutBaseUrl()}/static/luts/${defaultLutFile}`);
                const blob = await resp.blob();
                const arrayBuffer = await blob.arrayBuffer();
                const uint8 = new Uint8Array(arrayBuffer);

                const electronAPI = (window as any).electronAPI;
                if (electronAPI?.saveFileDialog) {
                    // Electron: native save dialog + streaming write
                    const filePath = await electronAPI.saveFileDialog({
                        title: '保存 LUT 模板',
                        defaultPath: 'Base_lut.png',
                        filters: [{ name: 'PNG Image', extensions: ['png'] }]
                    });
                    if (!filePath) return; // user cancelled
                    const streamId = await electronAPI.writeStreamOpen(filePath);
                    await electronAPI.writeStreamChunk(streamId, uint8);
                    await electronAPI.writeStreamClose(streamId);
                } else if (window.showSaveFilePicker) {
                    // Browser with File System Access API
                    const handle = await window.showSaveFilePicker({
                        suggestedName: 'Base_lut.png',
                        types: [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }]
                    });
                    const writable = await handle.createWritable();
                    await writable.write(uint8);
                    await writable.close();
                } else {
                    // Browser fallback: trigger download
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'Base_lut.png';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }
            } catch (e) {
                console.error('[color-panel] LUT template download failed:', e);
            }
        });

        reset.on('click', () => {
            if (selectedShape) {
                selectedShape.color = new Color(1, 1, 1);
                updateShapeUIFromState(selectedShape);
            } else if (selected) {
                const op = new SetSplatColorAdjustmentOp({
                    splat: selected,
                    newState: {
                        tintClr: new Color(1, 1, 1),
                        temperature: 0,
                        saturation: 1,
                        brightness: 0,
                        blackPoint: 0,
                        whitePoint: 1,
                        transparency: 1,
                        hslHueShifts: new Array(8).fill(0),
                        hslSatShifts: new Array(8).fill(0),
                        hslLightShifts: new Array(8).fill(0),
                        lut: null,
                        lutIntensity: 1
                    },
                    oldState: {
                        tintClr: selected.tintClr.clone(),
                        temperature: selected.temperature,
                        saturation: selected.saturation,
                        brightness: selected.brightness,
                        blackPoint: selected.blackPoint,
                        whitePoint: selected.whitePoint,
                        transparency: selected.transparency,
                        hslHueShifts: Array.from(selected.hslHueShifts),
                        hslSatShifts: Array.from(selected.hslSatShifts),
                        hslLightShifts: Array.from(selected.hslLightShifts),
                        lut: selected.lut,
                        lutIntensity: selected.lutIntensity
                    }
                });

                events.fire('edit.add', op);
            }
        });

        events.on('selection.changed', (element: Element) => {
            if (element instanceof Splat) {
                selected = element;
                updateUIFromState(selected);
            } else {
                selected = null;
                updateUIFromState(null);
            }
        });

        events.on('selection.shapeChanged', (element: Element) => {
            if (element instanceof SphereShape || element instanceof BoxShape || element instanceof BlockingPlane) {
                selectedShape = element as SphereShape | BoxShape | BlockingPlane;
                updateShapeUIFromState(selectedShape);
            } else {
                selectedShape = null;
                updateShapeUIFromState(null);
            }
        });

        events.on('splat.tintClr', updateUIFromState);
        events.on('splat.temperature', updateUIFromState);
        events.on('splat.saturation', updateUIFromState);
        events.on('splat.brightness', updateUIFromState);
        events.on('splat.blackPoint', updateUIFromState);
        events.on('splat.whitePoint', updateUIFromState);
        events.on('splat.transparency', updateUIFromState);
        events.on('splat.hslHueShifts', updateUIFromState);
        events.on('splat.hslSatShifts', updateUIFromState);
        events.on('splat.hslLightShifts', updateUIFromState);
        events.on('splat.lut', updateUIFromState);
        events.on('splat.lutIntensity', updateUIFromState);

        tooltips.register(lutLoadBtn, '导入LUT', 'bottom');
        tooltips.register(lutDownloadBtn, '下载LUT模板', 'bottom');
        tooltips.register(reset, localize('panel.colors.reset'), 'bottom');

        // MyFancySliderInput._updateHandle already self-heals via a
        // ResizeObserver, so handles center correctly once laid out.
        // Keep an explicit refresh as a belt-and-braces fallback for
        // panel show / scrollbar changes.
        const allSliders = [
            temperatureSlider, saturationSlider, brightnessSlider,
            blackPointSlider, whitePointSlider, transparencySlider,
            lutIntensitySlider,
            ...hslHueSliders, ...hslSatSliders, ...hslLightSliders
        ];
        const refreshSliderHandles = () => {
            allSliders.forEach((s: any) => s._updateHandle(s.value));
        };
        requestAnimationFrame(refreshSliderHandles);

        // handle panel visibility (skip in embedded mode, managed by scene-panel)

        if (!embedded) {
            const setVisible = (visible: boolean) => {
                if (visible === this.hidden) {
                    this.hidden = !visible;
                    events.fire('colorPanel.visible', visible);
                    if (visible) {
                        requestAnimationFrame(refreshSliderHandles);
                        setTimeout(refreshSliderHandles, 100);
                    }
                }
            };

            events.function('colorPanel.visible', () => {
                return !this.hidden;
            });

            events.on('colorPanel.setVisible', (visible: boolean) => {
                setVisible(visible);
            });

            events.on('colorPanel.toggleVisible', () => {
                setVisible(this.hidden);
            });

            events.on('viewPanel.visible', (visible: boolean) => {
                if (visible) {
                    setVisible(false);
                }
            });

            // Detect vertical scrollbar presence + refresh slider handles
            const checkScrollbar = () => {
                const hasVerticalScrollbar = this.dom.scrollHeight > this.dom.clientHeight;
                this.dom.classList.toggle('has-scrollbar', hasVerticalScrollbar);
                refreshSliderHandles();
            };
            const observer = new ResizeObserver(checkScrollbar);
            observer.observe(this.dom);
            checkScrollbar();
        }
    }
}

export { ColorPanel };
