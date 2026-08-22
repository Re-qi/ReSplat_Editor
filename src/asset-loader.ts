import { ReadFileSystem } from '@playcanvas/splat-transform';
import { AppBase, Asset, GSplatResource, Quat } from 'playcanvas';

import { BackendClient, lodNeedsBackend } from './backend';
import { Events } from './events';
import { defaultLodIndex, loadGSplatData, loadSogDecimated, validateGSplatData } from './io';
import { LodEditLog } from './lod-edit-log';
import { Splat } from './splat';
import { localize } from './ui/localization';

// handles loading gsplat assets using splat-transform
class AssetLoader {
    app: AppBase;
    events: Events;

    constructor(app: AppBase, events: Events) {
        this.app = app;
        this.events = events;
    }

    async load(
        filename: string,
        fileSystem: ReadFileSystem,
        animationFrame?: boolean,
        skipReorder?: boolean,
        decimatePercent?: number,
        containerFilePath?: string
    ) {
        if (!animationFrame) {
            this.events.fire('startSpinner');
        }

        // Multi-LOD metadata captured from pickLod callback (only populated
        // when loadGSplatData actually invokes pickLod, i.e. file has >1 LOD).
        let capturedLodCounts: number[] | null = null;
        let capturedNumLods = 1;
        let pickedLod = 0;
        // When true, the user chose to edit only a single LOD: the picked LOD
        // is loaded standalone and no cross-LOD metadata is attached (no LOD
        // switching, no edit propagation, no multi-LOD LCC2 export).
        let singleLodMode = false;
        // When >= 0, the user picked a LOD whose quality table exceeds the
        // renderer heap — it is loaded through the backend instead of
        // materializing the raw multi-GB container in the renderer.
        let backendLod = -1;

        try {
            console.log(`[asset-loader] load: filename=${filename}, containerFilePath=${containerFilePath ?? 'undefined'}`);
            // ask the user which LOD to load when the file contains multiple,
            // pausing the spinner while the popup is up
            const pickLod = async (lodCounts: readonly number[]) => {
                capturedLodCounts = [...lodCounts];
                capturedNumLods = lodCounts.length;
                this.events.fire('stopSpinner');
                try {
                    // For LCC files, first ask whether to edit a single LOD
                    // (standalone) or multiple LODs (cross-LOD editing). Other
                    // multi-LOD files skip this and go straight to LOD select.
                    const lowerFilename = filename.toLowerCase();
                    const isLcc = lowerFilename.endsWith('.lcc') || lowerFilename.endsWith('.lcc2');
                    if (isLcc) {
                        const modeResult = await this.events.invoke('showPopup', {
                            type: 'okcancel',
                            header: localize('popup.lod-mode-header'),
                            message: localize('popup.lod-mode-message'),
                            icon: false,
                            okText: localize('popup.lod-mode-single'),
                            cancelText: localize('popup.lod-mode-multi'),
                            warning: {
                                text: localize('popup.lod-mode-note')
                            }
                        });
                        // OK = single LOD (standalone), Cancel = multi LOD
                        // (cross-LOD editing). Both are valid choices; neither
                        // aborts the load.
                        singleLodMode = modeResult.action === 'ok';
                    }

                    const result = await this.events.invoke('showPopup', {
                        type: 'okcancel',
                        header: localize('popup.load-options-header'),
                        message: localize('popup.lod-select-message'),
                        icon: false,
                        select: {
                            value: String(defaultLodIndex(lodCounts)),
                            options: lodCounts.map((count, i) => ({
                                v: String(i),
                                t: `LOD ${i} (${count.toLocaleString()} ${localize('popup.lod-select-splats')})`
                            }))
                        }
                    });
                    if (result.action === 'ok') {
                        pickedLod = parseInt(result.value, 10);
                        console.log(`[asset-loader] pickLod: pickedLod=${pickedLod}, containerFilePath=${containerFilePath ?? 'undefined'}, lodNeedsBackend=${lodNeedsBackend(lodCounts[pickedLod])}`);
                        // Oversized LOD: route through the backend (compressed-ply
                        // preview) like the LOD switcher — the renderer cannot
                        // materialize its quality table within the V8 heap.
                        // Return null to cancel the direct load — the outer code
                        // checks backendLod and routes through the backend instead.
                        if (containerFilePath && lodNeedsBackend(lodCounts[pickedLod])) {
                            console.warn(`[import] Routing LOD ${pickedLod} (${lodCounts[pickedLod].toLocaleString()} splats) through backend`);
                            backendLod = pickedLod;
                            return null;
                        }
                        return pickedLod;
                    }
                    return null;
                } finally {
                    this.events.fire('startSpinner');
                }
            };

            // Use stride-sampled loading when decimatePercent is specified
            let result;
            if (!result) {
                result = decimatePercent != null ?
                    await loadSogDecimated(filename, fileSystem, decimatePercent).then(r => ({ gsplatData: r.gsplatData, transform: r.transform })) :
                    await loadGSplatData(filename, fileSystem, skipReorder || animationFrame, animationFrame ? undefined : pickLod);
            }
            // If loadGSplatData returned null but backendLod was set by pickLod,
            // route through the backend (compressed-ply preview).
            if (!result && backendLod >= 0) {
                const preview = await BackendClient.loadLodPreview(containerFilePath, backendLod);
                if (preview) {
                    result = {
                        gsplatData: preview.gsplatData,
                        // Import has no old splat to inherit a rotation from, so
                        // use the source transform rotation reported by the backend
                        // (the compressed-ply reader tags PLY, which differs from
                        // the LCC/LCC2 space the other levels render in).
                        transform: { rotation: preview.rotation ?? new Quat() }
                    };
                }
            }
            if (!result) {
                // user cancelled LOD selection
                return null;
            }
            const { gsplatData, transform } = result;
            validateGSplatData(gsplatData);

            const asset = new Asset(filename, 'gsplat', { url: `local-asset-${Date.now()}`, filename });
            this.app.assets.add(asset);
            asset.resource = new GSplatResource(this.app.graphicsDevice, gsplatData);

            const splat = new Splat(asset, transform.rotation);

            // When the file was multi-LOD and the user chose multi-LOD editing,
            // attach LCC metadata so cross-LOD editing (LOD switch, LCC2 export)
            // is enabled. lccFileSystem is runtime-only (not serialized);
            // doc.ts rebuilds it on .respproj load. In single-LOD mode the splat
            // is left standalone (no metadata attached).
            if (!singleLodMode && capturedNumLods > 1 && capturedLodCounts) {
                splat.lccFilePath = filename;
                splat.lccFileSystem = fileSystem;
                splat.lodCounts = capturedLodCounts;
                splat.currentLodIndex = pickedLod;
                splat.lodEditLog = new LodEditLog();
            }

            return splat;
        } finally {
            if (!animationFrame) {
                this.events.fire('stopSpinner');
            }
        }
    }
}

export { AssetLoader };
