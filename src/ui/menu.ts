import { Button, Container, Element, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { recentFiles } from '../recent-files';
import { ShortcutManager } from '../shortcut-manager';
import { localize } from './localization';
import { MenuPanel, MenuItem } from './menu-panel';
import boltIcon from './svg/bolt.svg';
import selectDelete from './svg/delete.svg';
import sceneExport from './svg/export.svg';
import sceneImport from './svg/import.svg';
import iterationCw from './svg/iteration-cw.svg';
import lockKeyholeOpen from './svg/lock-keyhole-open.svg';
import lockKeyhole from './svg/lock-keyhole.svg';
import sceneNew from './svg/new.svg';
import sceneOpen from './svg/open.svg';
import sceneSave from './svg/save.svg';
import selectAll from './svg/select-all.svg';
import selectDuplicate from './svg/select-duplicate.svg';
import selectInverse from './svg/select-inverse.svg';
import selectNone from './svg/select-none.svg';
import selectSeparate from './svg/select-separate.svg';
import squaresUnite from './svg/squares-unite.svg';
import wrenchIcon from './svg/wrench.svg';
import { Tooltips } from './tooltips';
import { openUrl } from '../open-url';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    const svg = new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    return new Element({ dom: svg });
};

const getOpenRecentItems = async (events: Events) => {
    const files = await recentFiles.get();
    const items: MenuItem[] = files.map((file) => {
        return {
            text: file.name,
            onSelect: () => events.invoke('doc.openRecent', file.handle)
        };
    });

    if (items.length > 0) {
        items.push({}); // separator
        items.push({
            text: localize('menu.file.open-recent.clear'),
            icon: createSvg(selectDelete),
            onSelect: () => recentFiles.clear()
        });
    }

    return items;
};

class Menu extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'menu'
        };

        super(args);

        const menubar = new Container({
            id: 'menu-bar'
        });

        menubar.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const scene = new Label({
            text: localize('menu.file'),
            class: 'menu-option'
        });

        const render = new Label({
            text: localize('menu.render'),
            class: 'menu-option'
        });

        const selection = new Label({
            text: localize('menu.select'),
            class: 'menu-option'
        });

        const help = new Label({
            text: localize('menu.help'),
            class: 'menu-option'
        });

        const buttonsContainer = new Container({
            id: 'menu-bar-options'
        });
        buttonsContainer.append(scene);
        buttonsContainer.append(selection);
        buttonsContainer.append(render);
        buttonsContainer.append(help);

        const viewOptions = new Button({
            id: 'menu-bar-options-btn'
        });

        // Replace icon font with SVG
        const boltSvg = createSvg(boltIcon);
        viewOptions.dom.appendChild(boltSvg.dom);

        buttonsContainer.append(viewOptions);

        tooltips.register(viewOptions, localize('tooltip.right-toolbar.view-options'), 'bottom');

        viewOptions.on('click', () => events.fire('viewPanel.toggleVisible'));

        events.on('viewPanel.visible', (visible: boolean) => {
            viewOptions.class[visible ? 'add' : 'remove']('active');
        });

        menubar.append(buttonsContainer);

        // Get the shortcut manager for displaying keyboard shortcuts
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');

        const exportMenuPanel = new MenuPanel([{
            text: localize('menu.file.export.ply'),
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'ply')
        }, {
            text: localize('menu.file.export.standard-ply'),
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'standardPly')
        }, {
            text: localize('menu.file.export.splat'),
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'splat')
        }, {
            text: localize('menu.file.export.sog'),
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'sog')
        }, {
            // separator
        }, {
            text: localize('menu.file.export.viewer', { ellipsis: true }),
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'viewer')
        }]);

        const openRecentMenuPanel = new MenuPanel([]);

        const fileMenuPanel = new MenuPanel([{
            text: localize('menu.file.new'),
            icon: createSvg(sceneNew),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('doc.new')
        }, {
            text: localize('menu.file.open'),
            icon: createSvg(sceneOpen),
            onSelect: async () => {
                await events.invoke('doc.open');
            }
        }, {
            text: localize('menu.file.open-recent'),
            icon: createSvg(sceneOpen),
            subMenu: openRecentMenuPanel,
            isEnabled: async () => {
                // refresh open recent menu items when the parent menu is opened
                try {
                    const items = await getOpenRecentItems(events);
                    openRecentMenuPanel.setItems(items);
                    return items.length > 0;
                } catch (error) {
                    console.error('Failed to load recent files:', error);
                    return false;
                }
            }
        }, {
            // separator
        }, {
            text: localize('menu.file.save'),
            icon: createSvg(sceneSave),
            isEnabled: () => events.invoke('doc.name'),
            onSelect: async () => await events.invoke('doc.save')
        }, {
            text: localize('menu.file.save-as', { ellipsis: true }),
            icon: createSvg(sceneSave),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: async () => await events.invoke('doc.saveAs')
        }, {
            // separator
        }, {
            text: localize('menu.file.import', { ellipsis: true }),
            icon: createSvg(sceneImport),
            onSelect: async () => {
                await events.invoke('scene.import');
            }
        }, {
            text: localize('menu.file.export'),
            icon: createSvg(sceneExport),
            subMenu: exportMenuPanel
        }, {
            text: localize('menu.file.fix-ply', { ellipsis: true }),
            icon: createSvg(wrenchIcon),
            onSelect: async () => await events.invoke('ply.fix')
        }]);

        const selectionMenuPanel = new MenuPanel([{
            text: localize('menu.select.all'),
            icon: createSvg(selectAll),
            extra: shortcutManager.formatShortcut('select.all'),
            onSelect: () => events.fire('select.all')
        }, {
            text: localize('menu.select.none'),
            icon: createSvg(selectNone),
            extra: shortcutManager.formatShortcut('select.none'),
            onSelect: () => events.fire('select.none')
        }, {
            text: localize('menu.select.invert'),
            icon: createSvg(selectInverse),
            extra: shortcutManager.formatShortcut('select.invert'),
            onSelect: () => events.fire('select.invert')
        }, {
            // separator
        }, {
            text: localize('menu.select.lock'),
            icon: createSvg(lockKeyhole),
            extra: shortcutManager.formatShortcut('select.hide'),
            isEnabled: () => events.invoke('selection.splats'),
            onSelect: () => events.fire('select.hide')
        }, {
            text: localize('menu.select.unlock'),
            icon: createSvg(lockKeyholeOpen),
            extra: shortcutManager.formatShortcut('select.unhide'),
            onSelect: () => events.fire('select.unhide')
        }, {
            text: localize('menu.select.delete'),
            icon: createSvg(selectDelete),
            extra: shortcutManager.formatShortcut('select.delete'),
            isEnabled: () => events.invoke('selection.splats'),
            onSelect: () => events.fire('select.delete')
        }, {
            text: localize('menu.select.reset'),
            icon: createSvg(iterationCw),
            onSelect: () => events.fire('scene.reset')
        }, {
            // separator
        }, {
            text: localize('menu.select.duplicate'),
            icon: createSvg(selectDuplicate),
            extra: shortcutManager.formatShortcut('select.duplicate'),
            isEnabled: () => events.invoke('selection.hasSplat'),
            onSelect: () => events.fire('select.duplicate')
        }, {
            text: localize('menu.select.separate'),
            icon: createSvg(selectSeparate),
            extra: shortcutManager.formatShortcut('select.separate'),
            isEnabled: () => events.invoke('selection.splats'),
            onSelect: () => events.fire('select.separate')
        }, {
            text: localize('menu.select.merge'),
            icon: createSvg(squaresUnite),
            extra: shortcutManager.formatShortcut('select.merge'),
            isEnabled: () => events.invoke('multiSplatSelection.count') >= 2,
            onSelect: () => events.fire('select.merge')
        }]);

        const renderMenuPanel = new MenuPanel([{
            text: localize('menu.render.image', { ellipsis: true }),
            icon: createSvg(sceneExport),
            onSelect: async () => await events.invoke('show.imageSettingsDialog')
        }, {
            text: localize('menu.render.video', { ellipsis: true }),
            icon: createSvg(sceneExport),
            onSelect: async () => await events.invoke('show.videoSettingsDialog')
        }]);

        const videoTutorialsMenuPanel = new MenuPanel([{
            text: localize('menu.help.video-tutorials.basics'),
            icon: 'E261',
            onSelect: () => openUrl('https://www.bilibili.com/video/BV1ZXTC63Ema/?spm_id_from=333.1387.homepage.video_card.click')
        }, {
            text: localize('menu.help.video-tutorials.in-depth'),
            icon: 'E261',
            onSelect: () => openUrl('https://www.bilibili.com/video/BV1v6Nu6vEgE?spm_id_from=333.788.videopod.sections&vd_source=f154045dbf2add36b59ecb76904972d2')
        }]);

        const helpMenuPanel = new MenuPanel([{
            text: localize('menu.help.video-tutorials'),
            icon: 'E261',
            subMenu: videoTutorialsMenuPanel
        }, {
            text: localize('menu.help.user-guide'),
            icon: 'E232',
            onSelect: () => openUrl('https://my.feishu.cn/wiki/Zi4QwJ3Alin6oLkazSGcRywKnBf?from=from_copylink')
        }, {
            text: localize('menu.help.shortcuts'),
            icon: 'E136',
            onSelect: () => events.fire('show.shortcuts')
        }, {
            // separator
        }, {
            text: localize('menu.help.github-repo'),
            icon: 'E259',
            onSelect: () => openUrl('https://github.com/Re-qi/ReSplat')
        }, {
            text: localize('menu.help.log-issue'),
            icon: 'E336',
            onSelect: () => openUrl('https://github.com/Re-qi/ReSplat/discussions')
        }, {
            // separator
        }, {
            text: localize('menu.help.about'),
            icon: 'E138',
            onSelect: () => events.fire('show.about')
        }]);

        this.append(menubar);
        this.append(fileMenuPanel);
        this.append(openRecentMenuPanel);
        this.append(exportMenuPanel);
        this.append(selectionMenuPanel);
        this.append(renderMenuPanel);
        this.append(videoTutorialsMenuPanel);
        this.append(helpMenuPanel);

        const options: { dom: HTMLElement, menuPanel: MenuPanel }[] = [{
            dom: scene.dom,
            menuPanel: fileMenuPanel
        }, {
            dom: selection.dom,
            menuPanel: selectionMenuPanel
        }, {
            dom: render.dom,
            menuPanel: renderMenuPanel
        }, {
            dom: help.dom,
            menuPanel: helpMenuPanel
        }];

        options.forEach((option) => {
            const activate = () => {
                option.menuPanel.position(option.dom, 'bottom', 2);
                options.forEach((opt) => {
                    opt.menuPanel.hidden = opt !== option;
                });
            };

            option.dom.addEventListener('pointerdown', () => {
                if (!option.menuPanel.hidden) {
                    option.menuPanel.hidden = true;
                } else {
                    activate();
                }
            });

            option.dom.addEventListener('pointerenter', () => {
                if (!options.every(opt => opt.menuPanel.hidden)) {
                    activate();
                }
            });
        });

        const checkEvent = (event: PointerEvent) => {
            if (!this.dom.contains(event.target as Node)) {
                options.forEach((opt) => {
                    opt.menuPanel.hidden = true;
                });
            }
        };

        window.addEventListener('pointerdown', checkEvent, true);
        window.addEventListener('pointerup', checkEvent, true);
    }
}

export { Menu };
