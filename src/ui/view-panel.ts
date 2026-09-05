import { BooleanInput, ColorPicker, Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';
import { Color } from 'playcanvas';

import { Events } from '../events';
import type { GridPlane } from '../infinite-grid';
import { ShortcutManager } from '../shortcut-manager';
import { i18n, localize, formatTooltipWithShortcut } from './localization';
import cornerUpLeftSvg from './svg/corner-up-left.svg';
import iterationCwSvg from './svg/iteration-cw.svg';
import { Tooltips } from './tooltips';

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

class ViewPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args: any = {}) {
        const embedded = args.embedded;
        args = {
            ...args,
            id: 'view-panel',
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
            text: '\uE403',
            class: 'panel-header-icon'
        });

        const label = new Label({
            text: localize('panel.view-options'),
            class: 'panel-header-label'
        });

        header.append(icon);
        header.append(label);

        // reset button
        const resetBtn = new Container({
            class: 'panel-header-button'
        });
        resetBtn.dom.appendChild(createSvg(iterationCwSvg));

        resetBtn.on('click', () => {
            events.fire('setBgClr', new Color(30 / 255, 30 / 255, 30 / 255));
            events.fire('setSelectedClr', new Color(1, 1, 0, 120 / 255));
            events.fire('setUnselectedClr', new Color(0, 0, 1, 0.3137));
            events.fire('setLockedClr', new Color(0, 0, 0, 0.3137));
            events.fire('camera.setTonemapping', 'linear');
            events.fire('camera.setFovDolly', false);
            events.fire('camera.setFov', 75);
            events.fire('view.setBands', 3);
            events.fire('camera.setFlySpeed', 1);
            events.fire('camera.setSplatSize', 2);
            events.fire('view.setCentersUseGaussianColor', false);
            events.fire('view.setOutlineSelection', false);
            events.fire('grid.setVisible', true);
            events.fire('grid.setPlane', 'xz');
            events.fire('camera.setBound', true);
            events.fire('camera.setBoundDimensions', false);
            events.fire('camera.setShowPoses', false);
            languageSelection.value = 'auto';
            i18n.setLanguage(null);
        });

        header.append(resetBtn);

        // language

        const languageRow = new Container({
            class: 'view-panel-row'
        });

        const languageLabel = new Label({
            class: 'view-panel-row-label'
        });
        i18n.bindText(languageLabel, 'panel.settings.language');

        const languageSelection = new SelectInput({
            class: 'view-panel-row-select',
            defaultValue: i18n.storedLanguage ?? 'auto'
        });
        i18n.bindOptions(languageSelection, () => [
            { v: 'auto', t: i18n.t('panel.settings.language.auto') },
            ...i18n.languages.map(language => ({ v: language.code, t: language.name }))
        ]);
        languageSelection.on('change', (value: string) => {
            i18n.setLanguage(value === 'auto' ? null : value);
        });

        languageRow.append(languageLabel);
        languageRow.append(languageSelection);

        // colors

        const clrRow = new Container({
            class: 'view-panel-row'
        });

        const clrLabel = new Label({
            text: localize('panel.view-options.colors'),
            class: 'view-panel-row-label'
        });

        const clrPickers = new Container({
            class: 'view-panel-row-pickers'
        });

        const bgClrPicker = new ColorPicker({
            class: 'view-panel-row-picker',
            channels: 3,
            value: [0, 0, 0]
        });

        const selectedClrPicker = new ColorPicker({
            class: 'view-panel-row-picker',
            channels: 4,
            value: [0, 0, 0, 0.502]
        });

        const unselectedClrPicker = new ColorPicker({
            class: 'view-panel-row-picker',
            channels: 4,
            value: [0, 0, 0, 0.502]
        });

        const lockedClrPicker = new ColorPicker({
            class: 'view-panel-row-picker',
            channels: 4,
            value: [0, 0, 0, 0.502]
        });

        const toArray = (clr: Color) => {
            return [clr.r, clr.g, clr.b, clr.a];
        };

        events.on('bgClr', (clr: Color) => {
            bgClrPicker.value = toArray(clr);
        });

        events.on('selectedClr', (clr: Color) => {
            selectedClrPicker.value = toArray(clr);
        });

        events.on('unselectedClr', (clr: Color) => {
            unselectedClrPicker.value = toArray(clr);
        });

        events.on('lockedClr', (clr: Color) => {
            lockedClrPicker.value = toArray(clr);
        });

        clrPickers.append(bgClrPicker);
        clrPickers.append(selectedClrPicker);
        clrPickers.append(unselectedClrPicker);
        clrPickers.append(lockedClrPicker);

        // 撤回：恢复4个颜色到初始值
        const clrRevert = createRevertBtn(() => {
            events.fire('setBgClr', new Color(30 / 255, 30 / 255, 30 / 255));
            events.fire('setSelectedClr', new Color(1, 1, 0, 120 / 255));
            events.fire('setUnselectedClr', new Color(0, 0, 1, 0.3137));
            events.fire('setLockedClr', new Color(0, 0, 0, 0.3137));
        });
        tooltips.register(clrRevert, '恢复默认值', 'bottom');

        clrRow.append(clrLabel);
        clrRow.append(clrPickers);
        clrRow.append(clrRevert);

        // tonemapping

        const tonemappingRow = new Container({
            class: 'view-panel-row'
        });

        const tonemappingLabel = new Label({
            text: localize('panel.view-options.tonemapping'),
            class: 'view-panel-row-label'
        });

        const tonemappingSelection = new SelectInput({
            class: 'view-panel-row-select',
            defaultValue: 'linear',
            options: [
                { v: 'linear', t: localize('panel.view-options.tonemapping.linear') },
                { v: 'neutral', t: localize('panel.view-options.tonemapping.neutral') },
                { v: 'aces', t: localize('panel.view-options.tonemapping.aces') },
                { v: 'aces2', t: localize('panel.view-options.tonemapping.aces2') },
                { v: 'filmic', t: localize('panel.view-options.tonemapping.filmic') },
                { v: 'hejl', t: localize('panel.view-options.tonemapping.hejl') }
            ]
        });

        tonemappingRow.append(tonemappingLabel);
        tonemappingRow.append(tonemappingSelection);

        // 撤回：恢复色调映射到 linear
        const tonemappingRevert = createRevertBtn(() => {
            events.fire('camera.setTonemapping', 'linear');
        });
        tooltips.register(tonemappingRevert, '恢复默认值', 'bottom');
        tonemappingRow.append(tonemappingRevert);

        // camera fov

        const fovRow = new Container({
            class: 'view-panel-row'
        });

        const fovLabel = new Label({
            text: localize('panel.view-options.fov'),
            class: 'view-panel-row-label'
        });

        const fovSlider = new SliderInput({
            class: 'view-panel-row-slider',
            min: 10,
            max: 120,
            precision: 1,
            value: 60
        });

        fovRow.append(fovLabel);
        fovRow.append(fovSlider);

        // 撤回：恢复视场角到 75
        const fovRevert = createRevertBtn(() => {
            events.fire('camera.setFov', 75);
        });
        tooltips.register(fovRevert, '恢复默认值', 'bottom');
        fovRow.append(fovRevert);

        // fov auto dolly

        const fovDollyRow = new Container({
            class: 'view-panel-row'
        });

        const fovDollyLabel = new Label({
            class: 'view-panel-row-label'
        });
        i18n.bindText(fovDollyLabel, 'panel.settings.fov-dolly');

        const fovDollyToggle = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: false
        });

        fovDollyRow.append(fovDollyLabel);
        fovDollyRow.append(fovDollyToggle);

        // sh bands
        const shBandsRow = new Container({
            class: 'view-panel-row'
        });

        const shBandsLabel = new Label({
            text: localize('panel.view-options.sh-bands'),
            class: 'view-panel-row-label'
        });

        const shBandsSlider = new SliderInput({
            class: 'view-panel-row-slider',
            min: 0,
            max: 3,
            precision: 0,
            value: 3
        });

        shBandsRow.append(shBandsLabel);
        shBandsRow.append(shBandsSlider);

        // 撤回：恢复 SH 阶数到 3
        const shBandsRevert = createRevertBtn(() => {
            events.fire('view.setBands', 3);
        });
        tooltips.register(shBandsRevert, '恢复默认值', 'bottom');
        shBandsRow.append(shBandsRevert);

        // camera fly speed

        const cameraFlySpeedRow = new Container({
            class: 'view-panel-row'
        });

        const cameraFlySpeedLabel = new Label({
            text: localize('panel.view-options.fly-speed'),
            class: 'view-panel-row-label'
        });

        const cameraFlySpeedSlider = new SliderInput({
            class: 'view-panel-row-slider',
            min: 0.1,
            max: 100,
            sliderMax: 100,
            precision: 1,
            value: 1
        });

        cameraFlySpeedRow.append(cameraFlySpeedLabel);
        cameraFlySpeedRow.append(cameraFlySpeedSlider);

        // 撤回：恢复飞行速度到 1
        const cameraFlySpeedRevert = createRevertBtn(() => {
            events.fire('camera.setFlySpeed', 1);
        });
        tooltips.register(cameraFlySpeedRevert, '恢复默认值', 'bottom');
        cameraFlySpeedRow.append(cameraFlySpeedRevert);

        // centers size

        const centersSizeRow = new Container({
            class: 'view-panel-row'
        });

        const centersSizeLabel = new Label({
            text: localize('panel.view-options.centers-size'),
            class: 'view-panel-row-label'
        });

        const centersSizeSlider = new SliderInput({
            class: 'view-panel-row-slider',
            min: 0,
            max: 10,
            precision: 1,
            value: 2
        });

        centersSizeRow.append(centersSizeLabel);
        centersSizeRow.append(centersSizeSlider);

        // 撤回：恢复点中心大小到 2
        const centersSizeRevert = createRevertBtn(() => {
            events.fire('camera.setSplatSize', 2);
        });
        tooltips.register(centersSizeRevert, '恢复默认值', 'bottom');
        centersSizeRow.append(centersSizeRevert);

        // centers gaussian color
        const centersColorRow = new Container({
            class: 'view-panel-row'
        });

        const centersColorLabel = new Label({
            text: localize('panel.view-options.centers-gaussian-color'),
            class: 'view-panel-row-label'
        });

        const centersColorToggle = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: false
        });

        centersColorRow.append(centersColorLabel);
        centersColorRow.append(centersColorToggle);

        // outline selection

        const outlineSelectionRow = new Container({
            class: 'view-panel-row'
        });

        const outlineSelectionLabel = new Label({
            text: localize('panel.view-options.outline-selection'),
            class: 'view-panel-row-label'
        });

        const outlineSelectionToggle = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: false
        });

        outlineSelectionRow.append(outlineSelectionLabel);
        outlineSelectionRow.append(outlineSelectionToggle);

        // show grid

        const showGridRow = new Container({
            class: 'view-panel-row'
        });

        const showGridLabel = new Label({
            text: localize('panel.view-options.show-grid'),
            class: 'view-panel-row-label'
        });

        const showGridToggle = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: true
        });

        showGridRow.append(showGridLabel);
        showGridRow.append(showGridToggle);

        // grid plane

        const gridPlaneRow = new Container({
            class: 'view-panel-row'
        });

        const gridPlaneLabel = new Label({
            class: 'view-panel-row-label'
        });
        i18n.bindText(gridPlaneLabel, 'panel.settings.grid-plane');

        const gridPlaneSelection = new SelectInput({
            class: 'view-panel-row-select',
            defaultValue: 'xz',
            options: [
                { v: 'xz', t: 'XZ' },
                { v: 'xy', t: 'XY' },
                { v: 'yz', t: 'YZ' }
            ]
        });

        gridPlaneRow.append(gridPlaneLabel);
        gridPlaneRow.append(gridPlaneSelection);

        // show bound

        const showBoundRow = new Container({
            class: 'view-panel-row'
        });

        const showBoundLabel = new Label({
            text: localize('panel.view-options.show-bound'),
            class: 'view-panel-row-label'
        });

        const showBoundToggle = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: true
        });

        showBoundRow.append(showBoundLabel);
        showBoundRow.append(showBoundToggle);

        // show dimensions

        const showBoundDimensionsRow = new Container({
            class: 'view-panel-row'
        });

        const showBoundDimensionsLabel = new Label({
            text: localize('panel.view-options.show-bound-dimensions'),
            class: 'view-panel-row-label'
        });

        const showBoundDimensionsToggle = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: false
        });

        showBoundDimensionsRow.append(showBoundDimensionsLabel);
        showBoundDimensionsRow.append(showBoundDimensionsToggle);

        // show camera poses

        const showCameraPosesRow = new Container({
            class: 'view-panel-row'
        });

        const showCameraPosesLabel = new Label({
            text: localize('panel.view-options.show-camera-poses'),
            class: 'view-panel-row-label'
        });

        const showCameraPosesToggle = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: false
        });

        showCameraPosesRow.append(showCameraPosesLabel);
        showCameraPosesRow.append(showCameraPosesToggle);

        // developer console (Electron only)
        const isElectron = !!(window as any).electronAPI?.isElectron;
        let devConsoleRow: Container | null = null;
        if (isElectron) {
            devConsoleRow = new Container({
                class: 'view-panel-row'
            });

            const devConsoleLabel = new Label({
                text: localize('panel.view-options.dev-console'),
                class: 'view-panel-row-label'
            });

            const devConsoleToggle = new BooleanInput({
                type: 'toggle',
                class: 'view-panel-row-toggle',
                value: false
            });

            devConsoleToggle.on('change', () => {
                const api = (window as any).electronAPI;
                if (devConsoleToggle.value) {
                    api.openDevTools();
                } else {
                    api.closeDevTools();
                }
            });

            devConsoleRow.append(devConsoleLabel);
            devConsoleRow.append(devConsoleToggle);
        }

        this.append(header);
        this.append(languageRow);
        this.append(clrRow);
        this.append(tonemappingRow);
        this.append(fovRow);
        this.append(fovDollyRow);
        this.append(shBandsRow);
        this.append(cameraFlySpeedRow);
        this.append(centersSizeRow);
        this.append(centersColorRow);
        this.append(outlineSelectionRow);
        this.append(showGridRow);
        this.append(gridPlaneRow);
        this.append(showBoundRow);
        this.append(showBoundDimensionsRow);
        this.append(showCameraPosesRow);
        if (devConsoleRow) this.append(devConsoleRow);

        // handle panel visibility (skip in embedded mode, managed by scene-panel)

        if (!embedded) {
            const setVisible = (visible: boolean) => {
                if (visible === this.hidden) {
                    this.hidden = !visible;
                    events.fire('viewPanel.visible', visible);
                }
            };

            events.function('viewPanel.visible', () => {
                return !this.hidden;
            });

            events.on('viewPanel.setVisible', (visible: boolean) => {
                setVisible(visible);
            });

            events.on('viewPanel.toggleVisible', () => {
                setVisible(this.hidden);
            });

            events.on('colorPanel.visible', (visible: boolean) => {
                if (visible) {
                    setVisible(false);
                }
            });
        }

        // sh bands

        events.on('view.bands', (bands: number) => {
            shBandsSlider.value = bands;
        });

        shBandsSlider.on('change', (value: number) => {
            events.fire('view.setBands', value);
        });

        // splat size

        events.on('camera.splatSize', (value: number) => {
            centersSizeSlider.value = value;
        });

        centersSizeSlider.on('change', (value: number) => {
            events.fire('camera.setSplatSize', value);
            events.fire('camera.setOverlay', true);
            events.fire('camera.setMode', 'centers');
        });

        // centers gaussian color
        events.on('view.centersUseGaussianColor', (value: boolean) => {
            centersColorToggle.value = value;
        });

        centersColorToggle.on('change', (value: boolean) => {
            events.fire('view.setCentersUseGaussianColor', value);
        });

        // camera speed

        let suppressChange = false;

        events.on('camera.flySpeed', (value: number) => {
            suppressChange = true;
            cameraFlySpeedSlider.value = value;
            cameraFlySpeedSlider.step = value > 20 ? 10 : 1;
            suppressChange = false;
        });

        cameraFlySpeedSlider.on('change', (value: number) => {
            if (suppressChange) return;
            events.fire('camera.setFlySpeed', value);
        });

        // fov auto dolly

        events.on('camera.fovDolly', (value: boolean) => {
            fovDollyToggle.value = value;
        });

        fovDollyToggle.on('change', (value: boolean) => {
            events.fire('camera.setFovDolly', value);
        });

        // outline selection

        events.on('view.outlineSelection', (value: boolean) => {
            outlineSelectionToggle.value = value;
        });

        outlineSelectionToggle.on('change', (value: boolean) => {
            events.fire('view.setOutlineSelection', value);
        });

        // show grid

        events.on('grid.visible', (visible: boolean) => {
            showGridToggle.value = visible;
        });

        showGridToggle.on('change', () => {
            events.fire('grid.setVisible', showGridToggle.value);
        });

        // grid plane

        events.on('grid.plane', (plane: GridPlane) => {
            gridPlaneSelection.value = plane;
        });

        gridPlaneSelection.on('change', (value: GridPlane) => {
            events.fire('grid.setPlane', value);
        });

        // show bound

        events.on('camera.bound', (visible: boolean) => {
            showBoundToggle.value = visible;
        });

        showBoundToggle.on('change', () => {
            events.fire('camera.setBound', showBoundToggle.value);
        });

        // show dimensions

        events.on('camera.boundDimensions', (visible: boolean) => {
            showBoundDimensionsToggle.value = visible;
        });

        showBoundDimensionsToggle.on('change', () => {
            events.fire('camera.setBoundDimensions', showBoundDimensionsToggle.value);
        });

        // show camera poses

        events.on('camera.showPoses', (visible: boolean) => {
            showCameraPosesToggle.value = visible;
        });

        showCameraPosesToggle.on('change', () => {
            events.fire('camera.setShowPoses', showCameraPosesToggle.value);
        });

        // background color

        bgClrPicker.on('change', (value: number[]) => {
            events.fire('setBgClr', new Color(value[0], value[1], value[2]));
        });

        selectedClrPicker.on('change', (value: number[]) => {
            events.fire('setSelectedClr', new Color(value[0], value[1], value[2], value[3]));
        });

        unselectedClrPicker.on('change', (value: number[]) => {
            events.fire('setUnselectedClr', new Color(value[0], value[1], value[2], value[3]));
        });

        lockedClrPicker.on('change', (value: number[]) => {
            events.fire('setLockedClr', new Color(value[0], value[1], value[2], value[3]));
        });

        // camera fov

        events.on('camera.fov', (fov: number) => {
            fovSlider.value = fov;
        });

        fovSlider.on('change', (value: number) => {
            events.fire('camera.setFov', value);
        });

        // tonemapping

        events.on('camera.tonemapping', (tonemapping: string) => {
            tonemappingSelection.value = tonemapping;
        });

        tonemappingSelection.on('change', (value: string) => {
            events.fire('camera.setTonemapping', value);
        });

        // tooltips
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const shortcut = shortcutManager.formatShortcut('grid.toggleVisible');
        tooltips.register(showGridLabel, formatTooltipWithShortcut(localize('panel.view-options.show-grid'), shortcut), 'bottom');
        tooltips.register(bgClrPicker, localize('panel.view-options.background-color'), 'bottom');
        tooltips.register(selectedClrPicker, localize('panel.view-options.selected-color'), 'bottom');
        tooltips.register(unselectedClrPicker, localize('panel.view-options.unselected-color'), 'bottom');
        tooltips.register(lockedClrPicker, localize('panel.view-options.locked-color'), 'bottom');

        // Detect vertical scrollbar presence
        const checkScrollbar = () => {
            const hasVerticalScrollbar = this.dom.scrollHeight > this.dom.clientHeight;
            this.dom.classList.toggle('has-scrollbar', hasVerticalScrollbar);
        };
        const observer = new ResizeObserver(checkScrollbar);
        observer.observe(this.dom);
        checkScrollbar();
    }
}

export { ViewPanel };
