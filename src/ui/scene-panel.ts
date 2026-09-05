import { Container, Label } from '@playcanvas/pcui';

import { ColorPanel } from './color-panel';
import { Events } from '../events';
import { localize } from './localization';
import { LodSwitcher } from './lod-switcher';
import { PaintLayerPanel } from './paint-layer-panel';
import { PaintPalette } from './paint-palette';
import { PointCloudGroup } from './point-cloud-group';
import { SplatList } from './splat-list';
import { Tooltips } from './tooltips';
import { Transform } from './transform';
import { addVerticalListResizeHandle } from './vertical-list-resize';
import { ViewPanel } from './view-panel';
import { WrapperList } from './wrapper-list';

class ScenePanel extends Container {
    constructor(events: Events, tooltips: Tooltips, canvasContainer: Container, args = {}) {
        args = {
            ...args,
            id: 'scene-panel',
            class: 'panel'
        };

        super(args);

        // stop pointer events bubpling
        ['pointerdown', 'pointerup', 'pointermove', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });
        // wheel: stopPropagation but allow default scrolling (passive: true)
        this.dom.addEventListener('wheel', (event: Event) => event.stopPropagation(), { passive: true });


        const sceneHeader = new Container({
            class: 'panel-header'
        });

        const sceneIcon = new Label({
            text: '\uE344',
            class: 'panel-header-icon'
        });

        const sceneLabel = new Label({
            text: localize('panel.scene-manager'),
            class: 'panel-header-label'
        });

        sceneHeader.append(sceneIcon);
        sceneHeader.append(sceneLabel);

        const splatList = new SplatList(events, tooltips);

        const splatListContainer = new Container({
            class: 'splat-list-container'
        });
        splatListContainer.append(splatList);

        // --- Point Cloud Group ---
        const pointCloudGroup = new PointCloudGroup(events, tooltips, canvasContainer);

        const transformHeader = new Container({
            class: 'panel-header'
        });

        const transformIcon = new Label({
            text: '\uE111',
            class: 'panel-header-icon'
        });

        const transformLabel = new Label({
            text: localize('panel.scene-manager.transform'),
            class: 'panel-header-label'
        });

        transformHeader.append(transformIcon);
        transformHeader.append(transformLabel);

        // --- Color Panel (embedded) ---
        const embeddedColorPanel = new ColorPanel(events, tooltips, {
            embedded: true
        });

        const colorSection = new Container({
            id: 'scene-color-section'
        });
        colorSection.append(embeddedColorPanel);
        colorSection.hidden = true;

        // --- View Panel (embedded) ---
        const embeddedViewPanel = new ViewPanel(events, tooltips, {
            embedded: true
        });

        const viewSection = new Container({
            id: 'scene-view-section'
        });
        viewSection.append(embeddedViewPanel);
        viewSection.hidden = true;

        const paintPalette = new PaintPalette(events, tooltips);
        const paintLayerPanel = new PaintLayerPanel(events, tooltips);

        this.append(sceneHeader);
        this.append(splatListContainer);
        addVerticalListResizeHandle(splatListContainer.dom);
        this.append(new LodSwitcher(events));
        this.append(pointCloudGroup);
        this.append(new WrapperList(events));
        this.append(transformHeader);
        this.append(new Transform(events, tooltips));
        this.append(paintPalette);
        this.append(paintLayerPanel);
        this.append(colorSection);
        this.append(viewSection);

        let colorVisible = false;
        let viewVisible = false;

        const updateSectionVisibility = () => {
            const colorDisplayed = colorVisible;
            const viewDisplayed = viewVisible;
            colorSection.hidden = !colorDisplayed;
            viewSection.hidden = !viewDisplayed;
            events.fire('colorPanel.displayVisible', colorDisplayed);
            events.fire('viewPanel.displayVisible', viewDisplayed);
        };

        const updateModeLayout = (mode: 'edit' | 'paint') => {
            const painting = mode === 'paint';
            this.dom.classList.toggle('paint-mode', painting);
            paintPalette.hidden = !painting;
            paintLayerPanel.hidden = !painting;
            updateSectionVisibility();
        };
        events.on('mode.changed', updateModeLayout);
        const initialMode = events.functions.has('mode.active') ? (events.invoke('mode.active') as 'edit' | 'paint') : 'edit';
        updateModeLayout(initialMode ?? 'edit');

        // Toggle color section visibility while preserving its state across mode changes.
        events.on('colorPanel.toggleVisible', () => {
            colorVisible = !colorVisible;
            if (colorVisible) {
                events.fire('colorPanel.shown');
            }
            updateSectionVisibility();
            events.fire('colorPanel.visible', colorVisible);
        });

        // Toggle view section visibility independently of the color section.
        events.on('viewPanel.toggleVisible', () => {
            viewVisible = !viewVisible;
            updateSectionVisibility();
            events.fire('viewPanel.visible', viewVisible);
            if (!viewVisible) events.fire('colorPanel.visible', colorVisible);
        });
        events.on('viewPanel.visible', (visible: boolean) => {
            viewVisible = visible;
            updateSectionVisibility();
        });

        events.on('scenePanel.toggle', () => {
            this.dom.classList.toggle('collapsed');
            const viewModeToggle = document.getElementById('view-mode-toggle');
            const modeSwitch = document.getElementById('mode-switch');
            const overlayToggle = document.getElementById('overlay-toggle');
            const cameraModeSwitch = document.getElementById('camera-mode-switch');
            const viewCube = document.getElementById('view-cube-container');
            if (viewModeToggle) {
                viewModeToggle.classList.toggle('scene-collapsed');
            }
            if (modeSwitch) {
                modeSwitch.classList.toggle('scene-collapsed');
            }
            if (overlayToggle) {
                overlayToggle.classList.toggle('scene-collapsed');
            }
            if (cameraModeSwitch) {
                cameraModeSwitch.classList.toggle('scene-collapsed');
            }
            if (viewCube) {
                viewCube.classList.toggle('scene-collapsed');
            }
        });

        // Detect vertical scrollbar presence
        const syncScrollbarClass = (hasScrollbar: boolean) => {
            const viewModeToggle = document.getElementById('view-mode-toggle');
            const modeSwitch = document.getElementById('mode-switch');
            const overlayToggle = document.getElementById('overlay-toggle');
            const cameraModeSwitch = document.getElementById('camera-mode-switch');
            const viewCube = document.getElementById('view-cube-container');
            if (viewModeToggle) {
                viewModeToggle.classList.toggle('scene-has-scrollbar', hasScrollbar);
            }
            if (modeSwitch) {
                modeSwitch.classList.toggle('scene-has-scrollbar', hasScrollbar);
            }
            if (overlayToggle) {
                overlayToggle.classList.toggle('scene-has-scrollbar', hasScrollbar);
            }
            if (cameraModeSwitch) {
                cameraModeSwitch.classList.toggle('scene-has-scrollbar', hasScrollbar);
            }
            if (viewCube) {
                viewCube.classList.toggle('scene-has-scrollbar', hasScrollbar);
            }
        };

        const scrollEl = this.dom;
        const checkScrollbar = () => {
            const hasVerticalScrollbar = scrollEl.scrollHeight > scrollEl.clientHeight;
            scrollEl.classList.toggle('has-scrollbar', hasVerticalScrollbar);
            syncScrollbarClass(hasVerticalScrollbar);
        };

        const observer = new ResizeObserver(checkScrollbar);
        observer.observe(scrollEl);
        checkScrollbar();
    }
}

export { ScenePanel };
