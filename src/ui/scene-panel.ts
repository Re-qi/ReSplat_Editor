import { Container, Label } from '@playcanvas/pcui';

import { ColorPanel } from './color-panel';
import { Events } from '../events';
import { localize } from './localization';
import { PointCloudGroup } from './point-cloud-group';
import { SplatList } from './splat-list';
import sceneImportSvg from './svg/import.svg';
import sceneNewSvg from './svg/new.svg';
import soloSvg from './svg/solo.svg';
import { Tooltips } from './tooltips';
import { Transform } from './transform';
import { ViewPanel } from './view-panel';
import { WrapperList } from './wrapper-list';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class ScenePanel extends Container {
    constructor(events: Events, tooltips: Tooltips, canvasContainer: Container, args = {}) {
        args = {
            ...args,
            id: 'scene-panel',
            class: 'panel'
        };

        super(args);

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });



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

        let soloActive = false;

        const soloToggle = new Container({
            class: 'panel-header-button'
        });
        soloToggle.dom.appendChild(createSvg(soloSvg));

        soloToggle.on('click', () => {
            soloActive = !soloActive;
            if (soloActive) {
                soloToggle.class.add('active');
            } else {
                soloToggle.class.remove('active');
            }
            events.fire('scene.solo', soloActive);
        });

        const sceneImport = new Container({
            class: ['panel-header-button', 'scene-import-btn']
        });
        sceneImport.dom.appendChild(createSvg(sceneImportSvg));

        const sceneNew = new Container({
            class: 'panel-header-button'
        });
        sceneNew.dom.appendChild(createSvg(sceneNewSvg));

        sceneHeader.append(sceneIcon);
        sceneHeader.append(sceneLabel);
        sceneHeader.append(soloToggle);
        sceneHeader.append(sceneImport);
        sceneHeader.append(sceneNew);

        sceneImport.on('click', async () => {
            await events.invoke('scene.import');
        });

        sceneNew.on('click', () => {
            events.invoke('doc.new');
        });

        tooltips.register(soloToggle, localize('tooltip.scene.solo'), 'bottom');
        tooltips.register(sceneImport, 'Import Scene', 'bottom');
        tooltips.register(sceneNew, 'New Scene', 'bottom');

        const splatList = new SplatList(events);

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

        this.append(sceneHeader);
        this.append(splatListContainer);
        this.append(pointCloudGroup);
        this.append(new WrapperList(events));
        this.append(transformHeader);
        this.append(new Transform(events));
        this.append(colorSection);
        this.append(viewSection);

        // When color mode is selected from mode-switch, keep color section hidden
        // User needs to click the color mode button again to show it
        events.on('view.displayMode', (mode: string) => {
            if (mode === 'color') {
                colorSection.hidden = true;
            } else {
                colorSection.hidden = true;
            }
        });

        // Toggle color section visibility when clicking color mode button while already active
        events.on('colorPanel.toggleVisible', () => {
            colorSection.hidden = !colorSection.hidden;
        });

        // Toggle view section visibility via menu bar button
        events.on('viewPanel.toggleVisible', () => {
            viewSection.hidden = !viewSection.hidden;
            events.fire('viewPanel.visible', !viewSection.hidden);
        });
        events.on('viewPanel.visible', (visible: boolean) => {
            viewSection.hidden = !visible;
        });

        events.on('scenePanel.toggle', () => {
            this.dom.classList.toggle('collapsed');
            const modeSwitch = document.getElementById('mode-switch');
            const overlayToggle = document.getElementById('overlay-toggle');
            const cameraModeSwitch = document.getElementById('camera-mode-switch');
            const viewCube = document.getElementById('view-cube-container');
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
            const modeSwitch = document.getElementById('mode-switch');
            const overlayToggle = document.getElementById('overlay-toggle');
            const cameraModeSwitch = document.getElementById('camera-mode-switch');
            const viewCube = document.getElementById('view-cube-container');
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
