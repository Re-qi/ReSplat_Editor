import { BooleanInput, Button, ColorPicker, Container, Element, Label, SelectInput, SliderInput, TextInput } from '@playcanvas/pcui';

import { Pose } from '../camera-poses';
import { localize } from './localization';
import { Events } from '../events';
import { ExportType, SceneExportOptions } from '../file-handler';
import { AnimTrack, ExperienceSettings, defaultPostEffectSettings } from '../splat-serialize';
import sceneExport from './svg/export.svg';

const createSvg = (svgString: string, args = {}) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new Element({
        dom: new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement,
        ...args
    });
};

const removeKnownExtension = (filename: string) => {
    // remove known extensions (ordered from longest to shortest for compound extensions)
    const knownExtensions = [
        '.compressed.ply',
        '.ksplat',
        '.splat',
        '.html',
        '.lcc2',
        '.ply',
        '.sog',
        '.spz',
        '.lcc',
        '.zip'
    ];

    for (let i = 0; i < knownExtensions.length; ++i) {
        const ext = knownExtensions[i];
        if (filename.endsWith(ext)) {
            return filename.slice(0, -ext.length);
        }
    }

    return filename;
};

class ExportPopup extends Container {
    show: (exportType: ExportType, splatNames: string[], showFilenameEdit: boolean, hasNonLcc: boolean) => Promise<null | SceneExportOptions>;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        args = {
            id: 'export-popup',
            hidden: true,
            tabIndex: -1,
            ...args
        };

        super(args);

        // UI

        const dialog = new Container({
            id: 'dialog'
        });

        // header

        const header = new Container({
            id: 'header'
        });

        const headerText = new Label({
            id: 'header',
            text: localize('popup.export.header')
        });

        header.append(createSvg(sceneExport, {
            id: 'icon'
        }));

        header.append(headerText);

        // content

        const content = new Container({ id: 'content' });

        // type

        const viewerTypeRow = new Container({
            class: 'row'
        });

        const viewerTypeLabel = new Label({
            class: 'label',
            text: localize('popup.export.type')
        });

        const viewerTypeSelect = new SelectInput({
            class: 'select',
            defaultValue: 'html',
            options: [
                { v: 'html', t: localize('popup.export.html') },
                { v: 'zip', t: localize('popup.export.package') }
            ]
        });

        viewerTypeRow.append(viewerTypeLabel);
        viewerTypeRow.append(viewerTypeSelect);

        // viewer: animation

        const animationLabel = new Label({ class: 'label', text: localize('popup.export.animation') });
        const animationToggle = new BooleanInput({ class: 'boolean', type: 'toggle', value: false });
        const animationRow = new Container({ class: 'row' });
        animationRow.append(animationLabel);
        animationRow.append(animationToggle);

        // viewer: loop mode

        const loopLabel = new Label({ class: 'label', text: localize('popup.export.loop-mode') });
        const loopSelect = new SelectInput({
            class: 'select',
            defaultValue: 'repeat',
            options: [
                { v: 'none', t: localize('popup.export.loop-mode.none') },
                { v: 'repeat', t: localize('popup.export.loop-mode.repeat') },
                { v: 'pingpong', t: localize('popup.export.loop-mode.pingpong') }
            ]
        });
        const loopRow = new Container({ class: 'row' });
        loopRow.append(loopLabel);
        loopRow.append(loopSelect);

        // viewer: clear color

        const colorRow = new Container({
            class: 'row'
        });

        const colorLabel = new Label({
            class: 'label',
            text: localize('popup.export.background-color')
        });

        const colorPicker = new ColorPicker({
            class: 'color-picker',
            value: [1, 1, 1, 1]
        });

        colorRow.append(colorLabel);
        colorRow.append(colorPicker);

        // viewer: fov

        const fovRow = new Container({
            class: 'row'
        });

        const fovLabel = new Label({
            class: 'label',
            text: localize('popup.export.fov')
        });

        const fovSlider = new SliderInput({
            class: 'slider',
            min: 10,
            max: 120,
            precision: 0,
            value: 60
        });

        fovRow.append(fovLabel);
        fovRow.append(fovSlider);

        // viewer: camera start position

        const startRow = new Container({
            class: 'row'
        });

        const startLabel = new Label({
            class: 'label',
            text: localize('popup.export.start-position')
        });

        const startSelect = new SelectInput({
            class: 'select',
            defaultValue: 'viewport',
            options: [
                { v: 'default', t: localize('popup.export.default') },
                { v: 'viewport', t: localize('popup.export.viewport') },
                { v: 'pose', t: localize('popup.export.pose-camera') }
            ]
        });

        startRow.append(startLabel);
        startRow.append(startSelect);

        // compress

        const compressRow = new Container({
            class: 'row'
        });

        const compressLabel = new Label({
            class: 'label',
            text: localize('popup.export.compress-ply')
        });

        const compressBoolean = new BooleanInput({
            class: 'boolean',
            type: 'toggle'
        });

        compressRow.append(compressLabel);
        compressRow.append(compressBoolean);

        // splats

        const splatsRow = new Container({
            class: 'row'
        });

        const splatsLabel = new Label({
            class: 'label',
            text: localize('popup.export.splats-select')
        });

        const splatsSelect = new SelectInput({
            class: 'select',
            defaultValue: 'all',
            options: [
                { v: 'all', t: localize('popup.export.splats-select.all') }
            ]
        });

        splatsRow.append(splatsLabel);
        splatsRow.append(splatsSelect);

        // spherical harmonic bands

        const bandsRow = new Container({
            class: 'row'
        });

        const bandsLabel = new Label({
            class: 'label',
            text: localize('popup.export.sh-bands')
        });

        const bandsSlider = new SliderInput({
            class: 'slider',
            min: 0,
            max: 3,
            precision: 0,
            value: 3
        });

        bandsRow.append(bandsLabel);
        bandsRow.append(bandsSlider);

        // sog iterations

        const iterationsRow = new Container({
            class: 'row'
        });

        const iterationsLabel = new Label({
            class: 'label',
            text: localize('popup.export.iterations')
        });

        const iterationsSlider = new SliderInput({
            class: 'slider',
            min: 0,
            max: 20,
            precision: 0,
            value: 10
        });

        iterationsRow.append(iterationsLabel);
        iterationsRow.append(iterationsSlider);

        // lcc2 lod levels (Phase 2: multi-level LOD generation). 1 = single
        // LOD (Phase 1 behavior); >1 builds an adaptive hybrid tree of that
        // depth with 1/2^k per-level downsampling. The adaptive tree chains
        // small cells (LOD link, childNum=1) and splits large ones (octree,
        // childNum=2..8), so node count grows LINEARLY in L — safe for the UE
        // plugin up to the EndLevel cap of 20. See splat-serialize.ts
        // (buildAdaptiveLcc2Tree) for details.

        const lodRow = new Container({
            class: 'row'
        });

        const lodLabel = new Label({
            class: 'label',
            text: localize('popup.export.lod-levels')
        });

        const lodSlider = new SliderInput({
            class: 'slider',
            min: 1,
            max: 20,
            precision: 0,
            value: 6
        });

        lodRow.append(lodLabel);
        lodRow.append(lodSlider);

        // lcc2 simplification method. 'nanogs' = training-free greedy merge
        // (better coarse-LOD quality, slower); 'uniform' = stride sampling
        // (fast, legacy). Browser path auto-downgrades to uniform above 2M
        // splats for main-thread safety; the backend worker path has no such
        // guard. See plan §4.4 / src/nanogs/README.md (CC BY-NC 4.0).

        const simplifyRow = new Container({
            class: 'row'
        });

        const simplifyLabel = new Label({
            class: 'label',
            text: localize('popup.export.simplify-method')
        });

        const simplifySelect = new SelectInput({
            class: 'select',
            defaultValue: 'nanogs',
            options: [
                { v: 'nanogs', t: localize('popup.export.simplify-method.nanogs') },
                { v: 'uniform', t: localize('popup.export.simplify-method.uniform') }
            ]
        });

        simplifyRow.append(simplifyLabel);
        simplifyRow.append(simplifySelect);

        // Web version note: intelligent (NanoGS) simplification runs on the
        // browser main thread and is capped at 2M splats (NANOGS_BROWSER_MAX in
        // splat-serialize.ts) — above that it silently falls back to uniform.
        // The desktop build routes large scenes to the backend worker (no cap),
        // so web users are pointed to the app. "软件版" is a link that opens the
        // download dialog. Hidden on Electron / non-lcc2.
        const simplifyHint = new Label({ class: 'hint' });
        simplifyHint.dom.innerHTML = localize('popup.export.simplify-method.web-note').replace(
            '{software}',
            `<span class="hint-link">${localize('popup.export.simplify-method.web-note-link')}</span>`
        );
        simplifyHint.dom.querySelector('.hint-link')?.addEventListener('click', () => {
            events.fire('downloadPopup.show');
        });

        // The web note only shows while intelligent simplification is selected
        // (it warns that NanoGS caps at 2M splats on the web). Toggled by the
        // select and by reset() (which also hides it for non-lcc2 / desktop).
        let hintContextVisible = false;
        const updateHintVisibility = () => {
            simplifyHint.hidden = !(hintContextVisible && simplifySelect.value === 'nanogs');
        };
        simplifySelect.on('change', updateHintVisibility);

        // filename

        const filenameRow = new Container({
            class: 'row'
        });

        const filenameLabel = new Label({
            class: 'label',
            text: localize('popup.export.filename')
        });

        const filenameEntry = new TextInput({
            class: 'text-input'
        });

        filenameRow.append(filenameLabel);
        filenameRow.append(filenameEntry);

        // content

        content.append(viewerTypeRow);
        content.append(animationRow);
        content.append(loopRow);
        content.append(colorRow);
        content.append(fovRow);
        content.append(startRow);
        content.append(compressRow);
        content.append(splatsRow);
        content.append(bandsRow);
        content.append(iterationsRow);
        content.append(lodRow);
        content.append(simplifyRow);
        content.append(simplifyHint);
        content.append(filenameRow);

        // footer

        const footer = new Container({ id: 'footer' });

        const cancelButton = new Button({
            class: 'button',
            text: localize('popup.cancel')
        });

        const exportButton = new Button({
            class: 'button',
            text: localize('popup.export')
        });

        footer.append(cancelButton);
        footer.append(exportButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);

        this.append(dialog);

        // handlers

        let onCancel: () => void;
        let onExport: () => void;

        cancelButton.on('click', () => onCancel());
        exportButton.on('click', () => onExport());

        const keydown = (e: KeyboardEvent) => {
            switch (e.key) {
                case 'Escape':
                    onCancel();
                    break;
                case 'Enter':
                    if (!e.shiftKey) onExport();
                    break;
                default:
                    e.stopPropagation();
                    break;
            }
        };

        const updateExtension = (ext: string) => {
            filenameEntry.value = removeKnownExtension(filenameEntry.value) + ext;
        };

        compressBoolean.on('change', () => {
            updateExtension(compressBoolean.value ? '.compressed.ply' : '.ply');
        });

        viewerTypeSelect.on('change', () => {
            updateExtension(viewerTypeSelect.value === 'html' ? '.html' : '.zip');
        });

        animationToggle.on('change', (value: boolean) => {
            loopSelect.enabled = value;
        });

        const reset = (exportType: ExportType, splatNames: string[], hasPoses: boolean, hasNonLcc: boolean) => {
            const allRows: (Container | Label)[] = [
                viewerTypeRow, animationRow, loopRow, colorRow, fovRow, startRow, compressRow, splatsRow, bandsRow, iterationsRow, lodRow, simplifyRow, simplifyHint, filenameRow
            ];

            const activeRows = {
                ply: [compressRow, splatsRow, bandsRow, filenameRow],
                standardPly: [splatsRow, bandsRow, filenameRow],
                splat: [splatsRow, filenameRow],
                sog: [splatsRow, bandsRow, iterationsRow, filenameRow],
                // LOD levels & simplification only apply when the scene contains
                // non-LCC source files (LCC/LCC2 files already carry their own
                // LOD hierarchy, so the export re-uses it instead of regenerating).
                lcc2: [splatsRow, bandsRow, ...(hasNonLcc ? [lodRow, simplifyRow, simplifyHint] : []), filenameRow],
                viewer: [viewerTypeRow, animationRow, loopRow, colorRow, fovRow, startRow, splatsRow, bandsRow, filenameRow]
            }[exportType] as (Container | Label)[];

            allRows.forEach((r) => {
                r.hidden = activeRows.indexOf(r) === -1;
            });

            // The NanoGS main-thread cap only applies to the browser; the
            // desktop backend worker has no cap, so the web note stays hidden
            // in the desktop build. On the web it only appears while the user
            // has selected intelligent simplification (not uniform).
            hintContextVisible = !(window as any).electronAPI?.isElectron && activeRows.indexOf(simplifyHint) !== -1;
            updateHintVisibility();

            // update splat list
            splatsSelect.options = [
                {
                    v: 'all',
                    t: localize('popup.export.splats-select.all')
                },
                ...splatNames.map((s, i) => ({ v: i.toFixed(0), t: s }))
            ];
            splatsSelect.value = 'all';
            splatsSelect.enabled = splatNames.length > 1;

            bandsSlider.value = events.invoke('view.bands');

            // ply
            compressBoolean.value = false;

            // sog
            // Default >0: splat-transform's shN k-means skips its Lloyd loop at
            // 0 iterations, so every splat quantizes to the same SH centroid and
            // view-dependent lighting breaks (blocks render black/white).
            iterationsSlider.value = 10;

            // lcc2
            lodSlider.value = 6;
            simplifySelect.value = 'nanogs';

            // filename
            filenameEntry.value = splatNames[0];
            switch (exportType) {
                case 'ply':
                case 'standardPly':
                    updateExtension('.ply');
                    break;
                case 'splat':
                    updateExtension('.splat');
                    break;
                case 'sog':
                    updateExtension('.sog');
                    break;
                case 'lcc2':
                    updateExtension('.lcc2');
                    break;
                case 'viewer':
                    updateExtension(viewerTypeSelect.value === 'html' ? '.html' : '.zip');
                    break;
            }

            // viewer
            const bgClr = events.invoke('bgClr');

            animationToggle.value = hasPoses;
            animationToggle.enabled = hasPoses;
            loopSelect.value = 'repeat';
            loopSelect.enabled = hasPoses;

            startSelect.value = hasPoses ? 'pose' : 'viewport';
            startSelect.disabledOptions = hasPoses ? {} : { 'pose': startSelect.options[2].t };

            colorPicker.value = [bgClr.r, bgClr.g, bgClr.b];

            fovSlider.value = events.invoke('camera.fov');
        };

        this.show = (exportType: ExportType, splatNames: string[], showFilenameEdit: boolean, hasNonLcc: boolean) => {
            const frames = events.invoke('timeline.frames');
            const frameRate = events.invoke('timeline.frameRate');
            const smoothness = events.invoke('timeline.smoothness');
            const orderedPoses = (events.invoke('camera.poses') as Pose[])
            .slice()
            .filter(p => p.frame >= 0 && p.frame < frames)
            .sort((a, b) => a.frame - b.frame);

            reset(exportType, splatNames, orderedPoses.length > 0, hasNonLcc);

            // filename is only shown in safari where file picker is not supported
            filenameRow.hidden = !showFilenameEdit;

            this.hidden = false;
            this.dom.addEventListener('keydown', keydown);
            this.dom.focus();

            const assemblePlyOptions = () : SceneExportOptions => {
                return {
                    filename: filenameEntry.value,
                    splatIdx: splatsSelect.value === 'all' ? 'all' : parseInt(splatsSelect.value, 10),
                    serializeSettings: {
                        maxSHBands: bandsSlider.value
                    },
                    compressedPly: compressBoolean.value
                };
            };

            const assembleSplatOptions = () : SceneExportOptions => {
                return {
                    filename: filenameEntry.value,
                    splatIdx: splatsSelect.value === 'all' ? 'all' : parseInt(splatsSelect.value, 10),
                    serializeSettings: { }
                };
            };

            const assembleSogOptions = () : SceneExportOptions => {
                return {
                    filename: filenameEntry.value,
                    splatIdx: splatsSelect.value === 'all' ? 'all' : parseInt(splatsSelect.value, 10),
                    serializeSettings: {
                        maxSHBands: bandsSlider.value
                    },
                    sogIterations: iterationsSlider.value
                };
            };

            // LCC2 options: splat selection, SH bands, LOD levels, simplification
            // method, filename. simplifyMethod defaults to 'nanogs' (intelligent);
            // the browser path auto-downgrades to 'uniform' for large scenes.
            // When the scene is all multi-LOD LCC/LCC2 the LOD/simplify rows are
            // hidden — omit the settings so export reuses the source's own LOD
            // count instead of the (hidden) slider value.
            const assembleLcc2Options = () : SceneExportOptions => {
                const opts: SceneExportOptions = {
                    filename: filenameEntry.value,
                    splatIdx: splatsSelect.value === 'all' ? 'all' : parseInt(splatsSelect.value, 10),
                    serializeSettings: {
                        maxSHBands: bandsSlider.value
                    }
                };
                if (hasNonLcc) {
                    opts.lodLevels = lodSlider.value;
                    opts.simplifyMethod = simplifySelect.value as 'nanogs' | 'uniform';
                }
                return opts;
            };

            const assembleViewerOptions = () : SceneExportOptions => {
                const fov = fovSlider.value;

                // use current viewport as start pose
                const pose = events.invoke('camera.getPose');
                const p = pose?.position;
                const t = pose?.target;
                const cameras = (p && t) ? [{
                    initial: {
                        position: [p.x, p.y, p.z] as [number, number, number],
                        target: [t.x, t.y, t.z] as [number, number, number],
                        fov
                    }
                }] : [];

                const includeAnimation = animationToggle.value;
                const animTracks: AnimTrack[] = [];

                if (includeAnimation && orderedPoses.length > 0) {
                    const times: number[] = [];
                    const position: number[] = [];
                    const target: number[] = [];
                    const fovKeys: number[] = [];
                    for (let i = 0; i < orderedPoses.length; ++i) {
                        const op = orderedPoses[i];
                        times.push(op.frame);
                        position.push(op.position.x, op.position.y, op.position.z);
                        target.push(op.target.x, op.target.y, op.target.z);
                        fovKeys.push(op.fov ?? fov);
                    }

                    animTracks.push({
                        name: 'cameraAnim',
                        duration: frames / frameRate,
                        frameRate,
                        loopMode: loopSelect.value as 'none' | 'repeat' | 'pingpong',
                        interpolation: 'spline',
                        smoothness,
                        keyframes: {
                            times,
                            values: { position, target, fov: fovKeys }
                        }
                    });
                }

                const bgColor = colorPicker.value.slice(0, 3) as [number, number, number];

                const experienceSettings: ExperienceSettings = {
                    version: 2,
                    tonemapping: 'none',
                    highPrecisionRendering: false,
                    background: { color: bgColor },
                    postEffectSettings: defaultPostEffectSettings,
                    animTracks,
                    cameras,
                    annotations: [],
                    startMode: includeAnimation ? 'animTrack' : 'default'
                };

                return {
                    filename: filenameEntry.value,
                    splatIdx: splatsSelect.value === 'all' ? 'all' : parseInt(splatsSelect.value, 10),
                    serializeSettings: {
                        maxSHBands: bandsSlider.value
                    },
                    viewerExportSettings: {
                        type: viewerTypeSelect.value,
                        experienceSettings
                    }
                };
            };

            return new Promise<null | SceneExportOptions>((resolve) => {
                onCancel = () => {
                    resolve(null);
                };

                onExport = () => {
                    switch (exportType) {
                        case 'ply':
                        case 'standardPly':
                            resolve(assemblePlyOptions());
                            break;
                        case 'splat':
                            resolve(assembleSplatOptions());
                            break;
                        case 'sog':
                            resolve(assembleSogOptions());
                            break;
                        case 'lcc2':
                            resolve(assembleLcc2Options());
                            break;
                        case 'viewer':
                            resolve(assembleViewerOptions());
                            break;
                    }
                };
            }).finally(() => {
                this.dom.removeEventListener('keydown', keydown);
                this.hide();
            });
        };

        this.hide = () => {
            this.hidden = true;
        };

        this.destroy = () => {
            this.hide();
            super.destroy();
        };
    }
}

export { ExportPopup };
