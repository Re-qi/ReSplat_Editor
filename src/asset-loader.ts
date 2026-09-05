import { ReadFileSystem } from '@playcanvas/splat-transform';
import { AppBase, Asset, GSplatResource, Quat } from 'playcanvas';

import { BackendClient, lodNeedsBackend } from './backend';
import { Events } from './events';
import { defaultLodIndex, loadGSplatData, loadSogDecimated, validateGSplatData } from './io';
import { LodEditLog } from './lod-edit-log';
import { PagedLodEditSession } from './paged-lod-edit';
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

            // A non-zero LOD is always a proxy for the paged LOD0 editor. Keep
            // the old mode popup for compatibility, but it no longer disables
            // the exact LOD0 edit path. LOD0 itself remains the ordinary
            // direct-import path.
            if (capturedNumLods > 1 && capturedLodCounts) {
                splat.lccFilePath = filename;
                splat.lccFileSystem = fileSystem;
                splat.lodCounts = capturedLodCounts;
                splat.currentLodIndex = pickedLod;
                splat.lodEditLog = new LodEditLog();

                if (pickedLod > 0 && containerFilePath) {
                    try {
                        const manifest = await BackendClient.openLodEdit(containerFilePath, pickedLod);
                        splat.pagedLodDescriptor = {
                            version: manifest.version,
                            sourceFingerprint: manifest.sourceFingerprint,
                            sourcePath: manifest.sourcePath,
                            proxyLod: manifest.proxyLod
                        };
                        splat.pagedLodEditSession = new PagedLodEditSession(splat, manifest);
                    } catch (error) {
                        // Do not silently present a non-zero import as an
                        // exact editor when the local paging backend failed.
                        // This feature is intentionally desktop/local-only.
                        console.error('[asset-loader] Failed to open paged LOD0 session', error);
                        splat.destroy();
                        throw error;
                    }
                }
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
