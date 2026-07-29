import { ReadFileSystem } from '@playcanvas/splat-transform';
import { AppBase, Asset, GSplatResource } from 'playcanvas';

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
        decimatePercent?: number
    ) {
        if (!animationFrame) {
            this.events.fire('startSpinner');
        }

        // Multi-LOD metadata captured from pickLod callback (only populated
        // when loadGSplatData actually invokes pickLod, i.e. file has >1 LOD).
        let capturedLodCounts: number[] | null = null;
        let capturedNumLods = 1;
        let pickedLod = 0;

        try {
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
                        },
                        warning: {
                            text: localize('popup.lod-upload-note'),
                            link: `${window.location.origin}/upload`
                        }
                    });
                    if (result.action === 'ok') {
                        pickedLod = parseInt(result.value, 10);
                        return pickedLod;
                    }
                    return null;
                } finally {
                    this.events.fire('startSpinner');
                }
            };

            // Use stride-sampled loading when decimatePercent is specified
            const result = decimatePercent != null ?
                await loadSogDecimated(filename, fileSystem, decimatePercent).then(r => ({ gsplatData: r.gsplatData, transform: r.transform })) :
                await loadGSplatData(filename, fileSystem, skipReorder || animationFrame, animationFrame ? undefined : pickLod);
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

            // When the file was multi-LOD, attach LCC metadata so cross-LOD
            // editing (LOD switch, LCC2 export) is enabled. lccFileSystem is
            // runtime-only (not serialized); doc.ts rebuilds it on .respproj load.
            if (capturedNumLods > 1 && capturedLodCounts) {
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
