import { ZipFileSystem, ZipReadFileSystem, ReadFileSystem } from '@playcanvas/splat-transform';

import { BackendClient } from './backend';
import { BlockingPlane } from './blocking-plane';
import { BoxShape } from './box-shape';
import { EditHistory } from './edit-history';
import { Element } from './element';
import { Events } from './events';
import { BrowserFileSystem, BlobReadSource, createElectronFileReadSource, MappedReadFileSystem, ZstdWriter, GZipWriter, isZstdSupported } from './io';
import { LodEditLog } from './lod-edit-log';
import { PagedLodEditSession } from './paged-lod-edit';
import { recentFiles } from './recent-files';
import { Scene } from './scene';
import { SphereShape } from './sphere-shape';
import { Splat } from './splat';
import { serializePlyToWriter, SerializeSettings } from './splat-serialize';
import { Transform } from './transform';
import { localize } from './ui/localization';

// shape factory for document deserialization
const createShapeFromDoc = (doc: any): Element => {
    switch (doc.shapeType) {
        case 'box': return new BoxShape();
        case 'sphere': return new SphereShape();
        case 'plane': return new BlockingPlane();
        default: return null;
    }
};

// Show a native file picker to relocate a local LCC file after .respproj load.
// Returns null if the user cancels. Uses showOpenFilePicker when available,
// falls back to <input type="file"> (Electron path-based path also works).
const pickLccFile = (ext: `.${string}`): Promise<File | null> => {
    return new Promise((resolve) => {
        if (window.showOpenFilePicker) {
            window.showOpenFilePicker({
                id: 'ReSplatLccRelocate',
                multiple: false,
                types: [{
                    description: 'LCC multi-LOD file',
                    accept: { 'application/x-lcc': [ext] }
                }]
            }).then(async (handles) => {
                if (handles?.length === 1) {
                    resolve(await handles[0].getFile());
                } else {
                    resolve(null);
                }
            }).catch((e: Error) => {
                if (e.name !== 'AbortError') {
                    console.error('[doc] pickLccFile failed:', e);
                }
                resolve(null);
            });
            return;
        }
        // Fallback: <input type="file">
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = ext;
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

// Rebuild a Splat's lccFileSystem after .respproj load. The original LCC file
// may be a URL (online import) or a local file (must be relocated by the user
// since File objects are not serializable). On failure, clears lodEditLog so
// the splat degrades gracefully to single-LOD editing.
const rebuildLccFileSystem = async (splat: Splat, events: Events): Promise<void> => {
    const lccPath = splat.lccFilePath!;
    const lowerPath = lccPath.toLowerCase();

    // URL: derive base URL and use MappedReadFileSystem (no user prompt)
    if (lowerPath.startsWith('http://') || lowerPath.startsWith('https://')) {
        try {
            const baseUrl = new URL('.', lccPath).href;
            splat.lccFileSystem = new MappedReadFileSystem(baseUrl);
            return;
        } catch (e) {
            console.warn(`[doc] Failed to construct URL file system for "${lccPath}": ${(e as Error).message}`);
            splat.lodEditLog = null;
            return;
        }
    }

    // Local file: prompt user to relocate
    const ext = lowerPath.endsWith('.lcc2') ? '.lcc2' : '.lcc';

    try {
        const result = await events.invoke('showPopup', {
            type: 'okcancel',
            header: localize('popup.lcc-relocate-header'),
            message: localize('popup.lcc-relocate-message').replace('{filename}', lccPath),
            icon: false
        });
        if (result.action !== 'ok') {
            splat.lodEditLog = null;
            console.warn(`[doc] User cancelled LCC relocation for "${lccPath}" — multi-LOD editing disabled`);
            return;
        }
    } catch (e) {
        console.warn('[doc] LCC relocation popup failed:', e);
        splat.lodEditLog = null;
        return;
    }

    const file = await pickLccFile(ext);
    if (file) {
        const mapped = new MappedReadFileSystem();
        mapped.addFile(lccPath, file);
        splat.lccFileSystem = mapped;
    } else {
        splat.lodEditLog = null;
        console.warn(`[doc] No LCC file selected — multi-LOD editing disabled for "${lccPath}"`);
    }
};

// Reopen the disk-backed LOD0 paging session after the proxy PLY has been
// restored from the project archive. Only the descriptor and delete patch are
// serialized; page data is always regenerated from the source container.
const rebuildPagedLodSession = async (
    splat: Splat,
    patchEntry: string | null,
    zipFs: ZipReadFileSystem,
    zipEntries: string[],
    electronApi: any
): Promise<void> => {
    const descriptor = splat.pagedLodDescriptor;
    if (!descriptor || descriptor.proxyLod <= 0) return;
    if (!splat.lodEditLog) splat.lodEditLog = new LodEditLog();

    let sourcePath = descriptor.sourcePath;
    if (!sourcePath || !(await electronApi?.fileExists?.(sourcePath))) {
        if (!electronApi?.isElectron) {
            console.warn('[doc] Paged LOD source is not available outside Electron; edit patch kept inactive');
            return;
        }
        const paths = await electronApi.openFileDialog({
            title: '重新定位 LCC/LCC2 源文件',
            filters: [{ name: 'LCC multi-LOD', extensions: ['lcc', 'lcc2'] }]
        });
        sourcePath = paths?.[0] ?? null;
        if (!sourcePath) {
            console.warn('[doc] Paged LOD source relocation cancelled');
            return;
        }
    }

    const manifest = await BackendClient.openLodEdit(sourcePath, descriptor.proxyLod);
    if (manifest.sourceFingerprint !== descriptor.sourceFingerprint) {
        console.warn('[doc] Paged LOD source fingerprint mismatch; patch was not applied');
        return;
    }

    const session = new PagedLodEditSession(splat, manifest);
    if (patchEntry && zipEntries.includes(patchEntry)) {
        const patchSource = await zipFs.createSource(patchEntry);
        let patchBytes = await patchSource.read().readAll();
        patchSource.close();
        if (patchEntry.endsWith('.zst') || patchEntry.endsWith('.gz')) {
            const stream = new DecompressionStream((patchEntry.endsWith('.zst') ? 'zstd' : 'gzip') as any);
            const writer = stream.writable.getWriter();
            await writer.write(patchBytes as any);
            await writer.close();
            const reader = stream.readable.getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
            const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            patchBytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
                patchBytes.set(chunk, offset);
                offset += chunk.length;
            }
        }
        session.deserializePatch(JSON.parse(new TextDecoder().decode(patchBytes)));
    }
    splat.pagedLodEditSession = session;
    splat.pagedLodDescriptor = {
        version: manifest.version,
        sourceFingerprint: manifest.sourceFingerprint,
        sourcePath,
        proxyLod: manifest.proxyLod
    };
};

// ts compiler and vscode find this type, but eslint does not
type FilePickerAcceptType = unknown;

const SuperFileType: FilePickerAcceptType[] = [{
    description: 'ReSplat document',
    accept: {
        'application/x-ReSplat': ['.respproj']
    }
}];

type FileSelectorCallback = (fileList: File) => void;

// helper class to show a file selector dialog.
// used when showOpenFilePicker is not available.
class FileSelector {
    show: (callbackFunc: FileSelectorCallback) => void;

    constructor() {
        const fileSelector = document.createElement('input');
        fileSelector.setAttribute('id', 'document-file-selector');
        fileSelector.setAttribute('type', 'file');
        fileSelector.setAttribute('accept', '.respproj');
        fileSelector.setAttribute('multiple', 'false');

        document.body.append(fileSelector);

        let callbackFunc: FileSelectorCallback = null;

        fileSelector.addEventListener('change', () => {
            callbackFunc(fileSelector.files[0]);
        });

        fileSelector.addEventListener('cancel', () => {
            callbackFunc(null);
        });

        this.show = (func: FileSelectorCallback) => {
            callbackFunc = func;
            fileSelector.click();
        };
    }
}

const registerDocEvents = (scene: Scene, events: Events, editHistory: EditHistory) => {
    // construct the file selector
    const fileSelector = window.showOpenFilePicker ? null : new FileSelector();

    // this file handle is updated as the current document is loaded and saved
    let documentFileHandle: FileSystemFileHandle = null;

    // Cache of compressed PLY data per splat uid — enables instant re-save
    // when splat hasn't changed since last save. Stored as an array of chunks
    // to avoid allocating a single giant ArrayBuffer.
    const _plyCache = new Map<number, Uint8Array[]>();

    // show the user a reset confirmation popup
    const getResetConfirmation = async () => {
        const result = await events.invoke('showPopup', {
            type: 'yesno',
            header: localize('doc.reset'),
            message: localize(events.invoke('scene.dirty') ? 'doc.unsaved-message' : 'doc.reset-message')
        });

        if (result.action !== 'yes') {
            return false;
        }

        return true;
    };

    // reset the scene
    const resetScene = () => {
        events.fire('scene.clear');
        events.fire('camera.reset');
        events.fire('doc.setName', null);
        documentFileHandle = null;
        _plyCache.clear();
    };

    // load the document from the given file
    const loadDocument = async (file: File, filePath?: string) => {
        events.fire('startSpinner');
        events.fire('spinnerText', '正在打开工程...');

        // Electron gives us the original local path. Read the archive by range
        // over IPC so a multi-GB File is never copied into renderer memory.
        const electronApi = (window as any).electronAPI;
        const electronProjectPath = filePath ??
            electronApi?.getFilePathForFile?.(file) ??
            electronApi?.getInputFilePath?.(file.name, file.size);
        const projectSource = electronProjectPath && electronApi?.isElectron ?
            await createElectronFileReadSource(electronProjectPath) :
            new BlobReadSource(file);
        const zipFs = new ZipReadFileSystem(projectSource);

        try {
            // reset the scene
            resetScene();

            // read document.json via streaming (only reads what's needed)
            const docSource = await zipFs.createSource('document.json');
            const docData = await docSource.read().readAll();
            docSource.close();
            const document = JSON.parse(new TextDecoder().decode(docData));

            // run through each splat and load it
            // Also cache raw compressed PLY bytes for instant first-save optimization
            const loadingCache = new Map<number, Uint8Array[]>();

            const zipEntries = await zipFs.list();
            for (let i = 0; i < document.splats.length; ++i) {
                const splatSettings = document.splats[i];

                // Select the format stored in the project instead of assuming
                // the runtime's currently supported compressor matches it.
                const zstdEntry = `splat_${i}.ply.zst`;
                const gzipEntry = `splat_${i}.ply.gz`;
                const entryName = zipEntries.includes(zstdEntry) ? zstdEntry : gzipEntry;
                if (!zipEntries.includes(entryName)) {
                    throw new Error(`Project is missing compressed splat ${i}`);
                }

                let splat: Splat;
                // For local Electron gzip projects, stream extraction to disk
                // in the main process, then let the PLY reader seek the temp
                // file. The old route keeps compressed data + decompressed
                // chunks + a merged buffer alive simultaneously, which makes
                // large projects exceed the renderer heap.
                if (electronProjectPath && electronApi?.isElectron && entryName === gzipEntry) {
                    const extracted = await electronApi.extractProjectGzipEntry(electronProjectPath, entryName);
                    try {
                        const plyFs: ReadFileSystem = {
                            createSource: (filename: string) => {
                                if (filename === `splat_${i}.ply`) {
                                    return createElectronFileReadSource(extracted.path);
                                }
                                return Promise.reject(new Error(`File not found: ${filename}`));
                            }
                        };
                        splat = await scene.assetLoader.load(`splat_${i}.ply`, plyFs, false, true);
                    } finally {
                        await electronApi.unlink(extracted.path);
                    }
                } else {
                    const algo = entryName.endsWith('.zst') ? 'zstd' : 'gzip';
                    const compressedSource = await zipFs.createSource(entryName);

                    // Read compressed data fully and cache for instant first-save
                    const compressedData = await compressedSource.read().readAll();
                    compressedSource.close();
                    loadingCache.set(i, [compressedData]);

                    // Decompress PLY fully into memory — readPly requires a seekable source,
                    // so streaming decompression is not possible in the browser fallback.
                    const ds = new DecompressionStream(algo as any);
                    const writer = ds.writable.getWriter();
                    writer.write(compressedData as any);
                    writer.close();

                    const reader = ds.readable.getReader();
                    const decompressedChunks: Uint8Array[] = [];
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        decompressedChunks.push(value);
                    }

                    // Merge decompressed chunks into a single buffer
                    let totalLen = 0;
                    for (const c of decompressedChunks) totalLen += c.length;
                    const decompressed = new Uint8Array(totalLen);
                    let offset = 0;
                    for (const c of decompressedChunks) {
                        decompressed.set(c, offset);
                        offset += c.length;
                    }

                    // Create seekable source from decompressed PLY data
                    const plyBlob = new Blob([decompressed]);
                    const plyFs: ReadFileSystem = {
                        createSource: (filename: string) => {
                            if (filename === `splat_${i}.ply`) {
                                return Promise.resolve(new BlobReadSource(plyBlob));
                            }
                            return Promise.reject(new Error(`File not found: ${filename}`));
                        }
                    };

                    splat = await scene.assetLoader.load(`splat_${i}.ply`, plyFs, false, true);
                }
                await scene.add(splat);

                // Restore entity transform from doc.json (no longer baked into PLY).
                // editHistory replay will handle intermediate transform states.
                splat.docDeserialize(splatSettings);
                // When the project is opened from a local Electron path, use
                // the project itself as the backend export source. The path
                // serialized inside document.json may point to the machine
                // that originally created the project and is not portable.
                if (electronProjectPath) {
                    splat.originalFilePath = electronProjectPath;
                }

                // LCC multi-LOD: rebuild the runtime lccFileSystem so cross-LOD
                // editing (LOD switch, LCC2 export) can stream other LODs. The
                // fileSystem is runtime-only; on failure lodEditLog is cleared
                // and the splat degrades to single-LOD editing.
                if (splat.lccFilePath) {
                    await rebuildLccFileSystem(splat, events);
                }

                if (splat.pagedLodDescriptor) {
                    const patchEntry = document.pagedLodPatches?.[i] ?? null;
                    try {
                        await rebuildPagedLodSession(splat, patchEntry, zipFs, zipEntries, electronApi);
                    } catch (error) {
                        // Keep the embedded proxy usable even when the source
                        // file is missing or the fingerprint has changed.
                        console.warn('[doc] Failed to restore paged LOD session', error);
                    }
                }
            }

            // FIXME: trigger scene bound calc in a better way
            const tmp = scene.bound;
            if (tmp === null) {
                console.error('this should never fire');
            }

            events.invoke('docDeserialize.timeline', document.timeline);
            events.invoke('docDeserialize.poseSets', document.poseSets, document.camera?.fov);
            events.invoke('docDeserialize.view', document.view);
            scene.camera.docDeserialize(document.camera);

            // restore point cloud groups (must happen before editHistory deserialization
            // so that group ops can reference properly loaded groups)
            if (document.groups) {
                const allSplats = events.invoke('scene.allSplats') as Splat[];
                for (let i = 0; i < document.groups.length && i < allSplats.length; i++) {
                    const splatGroups = document.groups[i];
                    if (splatGroups && splatGroups.length > 0) {
                        const groupsData = splatGroups.map((g: any) => ({
                            name: g.name,
                            indices: new Uint32Array(g.indices)
                        }));
                        events.fire('pointCloudGroup.addGroupsForSplat', allSplats[i], groupsData);
                    }
                }
            }

            // restore shapes (must happen before editHistory deserialization
            // so that AddShapeOp can reference loaded shapes)
            if (document.shapes) {
                let maxUid = 0;
                for (const shapeDoc of document.shapes) {
                    const shape = createShapeFromDoc(shapeDoc);
                    if (shape) {
                        await scene.add(shape);
                        shape.docDeserialize(shapeDoc);
                        maxUid = Math.max(maxUid, shapeDoc.uid);
                    }
                }
                if (maxUid >= Element.getNextUid()) {
                    Element.setNextUid(maxUid + 1);
                }
            }

            if (events.functions.has('paint.layers.deserialize')) {
                events.invoke('paint.layers.deserialize', document.paintLayers, events.invoke('scene.allSplats') as Splat[]);
            }

            // restore edit history (must await since it goes through commandQueue)
            if (document.editHistory) {
                await editHistory.deserialize(document.editHistory, scene);
            }
            if (events.functions.has('paint.layers.finishRestore')) {
                await events.invoke('paint.layers.finishRestore');
            }

            // refresh the pivot to reflect the loaded transform
            const currentSelection = events.invoke('selection');
            if (currentSelection) {
                const pivot = events.invoke('pivot');
                const transform = new Transform();
                const pivotOrigin = events.invoke('pivot.origin');
                currentSelection.getPivot(pivotOrigin, false, transform);
                pivot.place(transform);
            }

            // Populate save cache with compressed PLY data from the loaded document.
            // This enables instant first-save when no modifications have been made.
            const allSplats = events.invoke('scene.allSplats') as Splat[];
            allSplats.forEach((splat, i) => {
                const chunks = loadingCache.get(i);
                if (chunks) {
                    _plyCache.set(splat.uid, chunks);
                    splat.markSaveClean();
                }
            });
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('doc.load-failed'),
                message: `'${error.message ?? error}'`
            });
        } finally {
            // Clean up resources
            zipFs.close();
            events.fire('stopSpinner');
        }
    };

    const saveDocument = async (options: { stream?: FileSystemWritableFileStream, filename?: string }) => {
        events.fire('startSpinner');
        events.fire('spinnerText', '正在保存工程...');

        // First save (no existing project file): show alternating warning
        // that serialization may take a long time.
        let saveMsgInterval: ReturnType<typeof setInterval> | null = null;
        if (!documentFileHandle) {
            let toggle = false;
            saveMsgInterval = setInterval(() => {
                toggle = !toggle;
                events.fire('spinnerText', toggle ? '首次保存可能会很久' : '正在保存工程...');
            }, 5000);
        }

        try {
            const splats = events.invoke('scene.allSplats') as Splat[];

            // Deletes are optimistic in proxy mode, but a project must never
            // serialize before its authoritative LOD0 source rows are known.
            await Promise.all(splats.map(s => s.pagedLodEditSession?.waitForPendingRefinements()));

            // Serialize point cloud groups for each splat
            const groups: { name: string; indices: number[] }[][] = splats.map((s) => {
                const splatGroups = events.invoke('pointCloudGroup.getGroupsForSplat', s) as { name: string; indices: Uint32Array }[];
                return splatGroups.map(g => ({ name: g.name, indices: Array.from(g.indices) }));
            });

            // determine compression format
            const useZstd = isZstdSupported();
            const format = useZstd ? 'ply-zstd' : 'ply-gzip';
            const patchExt = useZstd ? '.bin.zst' : '.bin.gz';

            const document = {
                version: 2,
                camera: scene.camera.docSerialize(),
                view: events.invoke('docSerialize.view'),
                poseSets: events.invoke('docSerialize.poseSets'),
                timeline: events.invoke('docSerialize.timeline'),
                splats: splats.map(s => s.docSerialize()),
                groups: groups,
                shapes: scene.elements
                .filter(e => e.docSerialize() !== null)
                .map(e => e.docSerialize()),
                paintLayers: events.functions.has('paint.layers.serialize') ? events.invoke('paint.layers.serialize') : null,
                editHistory: editHistory.serialize(),
                pagedLodPatches: splats.map((s, i) => {
                    return s.pagedLodEditSession ? `lod-delete-patch-v2_${i}${patchExt}` : null;
                })
            };

            const plySettings: SerializeSettings = {
                keepStateData: false,
                preserveDeleted: true,
                keepWorldTransform: true,
                keepColorTint: false,
                skipPlyRotation: true
            };

            // Create browser filesystem and zip filesystem
            const browserFs = new BrowserFileSystem(options.filename, options.stream);
            const browserWriter = await browserFs.createWriter(options.filename);
            const zipFs = new ZipFileSystem(browserWriter);

            // Write document.json
            const docWriter = await zipFs.createWriter('document.json');
            await docWriter.write(new TextEncoder().encode(JSON.stringify(document)));
            await docWriter.close();

            // Write each splat as compressed PLY — reuse cached data if unchanged
            const serializeStart = performance.now();
            for (let i = 0; i < splats.length; ++i) {
                const splat = splats[i];
                const ext = useZstd ? '.ply.zst' : '.ply.gz';

                let plyChunks: Uint8Array[];
                const cached = _plyCache.get(splat.uid);

                if (cached && !splat.isSaveDirty()) {
                    // Reuse cached compressed PLY chunks — skip serialization entirely
                    plyChunks = cached;
                } else {
                    // Serialize to memory, cache the compressed chunks
                    const chunks: Uint8Array[] = [];
                    const memWriter = {
                        bytesWritten: 0,
                        write(data: Uint8Array) {
                            chunks.push(data);
                            this.bytesWritten += data.length;
                            return Promise.resolve();
                        },
                        close() {
                            return Promise.resolve();
                        },
                        abort() {}
                    };
                    const compressedWriter = useZstd ? new ZstdWriter(memWriter) : new GZipWriter(memWriter);
                    const t0 = performance.now();
                    await serializePlyToWriter([splat], plySettings, compressedWriter);
                    await compressedWriter.close();
                    console.log(`[save] serialize: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
                    _plyCache.set(splat.uid, chunks);
                    splat.markSaveClean();
                    plyChunks = chunks;
                }

                const t0 = performance.now();
                const zipWriter = await zipFs.createWriter(`splat_${i}${ext}`);
                for (const chunk of plyChunks) {
                    await zipWriter.write(chunk);
                }
                await zipWriter.close();
                console.log(`[save] zip+write: ${((performance.now() - t0) / 1000).toFixed(1)}s (${(plyChunks.reduce((s, c) => s + c.length, 0) / 1048576).toFixed(1)} MB)`);

                const session = splat.pagedLodEditSession;
                if (session) {
                    const patchChunks: Uint8Array[] = [];
                    const patchMemoryWriter = {
                        bytesWritten: 0,
                        write(data: Uint8Array) {
                            patchChunks.push(data);
                            this.bytesWritten += data.length;
                            return Promise.resolve();
                        },
                        close() {
                            return Promise.resolve();
                        },
                        abort() {}
                    };
                    const patchCompressor = useZstd ? new ZstdWriter(patchMemoryWriter) : new GZipWriter(patchMemoryWriter);
                    await patchCompressor.write(new TextEncoder().encode(JSON.stringify(session.serializePatch())));
                    await patchCompressor.close();
                    const patchWriter = await zipFs.createWriter(`lod-delete-patch-v2_${i}${patchExt}`);
                    for (const chunk of patchChunks) {
                        await patchWriter.write(chunk);
                    }
                    await patchWriter.close();
                }
            }

            // Close zip (also closes underlying browser writer)
            const t0 = performance.now();
            await zipFs.close();
            console.log(`[save] zip finalize: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
            console.log(`[save] total: ${((performance.now() - serializeStart) / 1000).toFixed(1)}s`);
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('doc.save-failed'),
                message: `'${error.message ?? error}'`
            });
        } finally {
            if (saveMsgInterval) clearInterval(saveMsgInterval);
            events.fire('stopSpinner');
        }
    };

    // handle user requesting a new document
    events.function('doc.new', async () => {
        if (!await getResetConfirmation()) {
            return false;
        }
        resetScene();
        return true;
    });

    // handle document file being dropped
    // NOTE: on chrome it's possible to get the FileSystemFileHandle from the DataTransferItem
    // (which would result in more seamless user experience), but this is not yet supported in
    // other browsers.
    events.function('doc.load', async (file: File, handle?: FileSystemFileHandle, filePath?: string) => {
        if (!events.invoke('scene.empty') && !await getResetConfirmation()) {
            return false;
        }

        await loadDocument(file, filePath);

        events.fire('doc.setName', file.name);

        if (handle) {
            documentFileHandle = handle;
            recentFiles.add(handle);
        }
    });

    events.function('doc.open', async () => {
        if (!events.invoke('scene.empty') && !await getResetConfirmation()) {
            return false;
        }

        if (fileSelector) {
            fileSelector.show(async (file?: File) => {
                if (file) {
                    await loadDocument(file);
                }
            });
        } else {
            try {
                const fileHandles = await window.showOpenFilePicker({
                    id: 'ReSplatDocumentOpen',
                    multiple: false,
                    types: SuperFileType
                });

                if (fileHandles?.length === 1) {
                    const fileHandle = fileHandles[0];

                    // null file handle incase loadDocument fails
                    await loadDocument(await fileHandle.getFile());

                    // store file handle for subsequent saves
                    documentFileHandle = fileHandle;
                    events.fire('doc.setName', fileHandle.name);
                    recentFiles.add(fileHandle);
                }
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error(error);
                }
            }
        }
    });

    events.function('doc.openRecent', async (fileHandle: FileSystemFileHandle) => {
        if (!events.invoke('scene.empty') && !await getResetConfirmation()) {
            return false;
        }

        try {
            if (await fileHandle.queryPermission({ mode: 'read' }) !== 'granted') {
                if (await fileHandle.requestPermission({ mode: 'read' }) !== 'granted') {
                    return false;
                }
            }

            await loadDocument(await fileHandle.getFile());

            // store file handle for subsequent saves
            documentFileHandle = fileHandle;
            events.fire('doc.setName', fileHandle.name);
            recentFiles.add(fileHandle);
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error(error);
                await events.invoke('showPopup', {
                    type: 'error',
                    header: localize('popup.error-loading'),
                    message: `${error.message ?? error}`
                });
            }
        }
    });

    events.function('doc.save', async () => {
        if (documentFileHandle) {
            try {
                await saveDocument({
                    stream: await documentFileHandle.createWritable()
                });
                events.fire('doc.saved');
            } catch (error) {
                if (error.name !== 'AbortError' && error.name !== 'NotAllowedError') {
                    console.error(error);
                }
            }
        } else {
            await events.invoke('doc.saveAs');
        }
    });

    events.function('doc.saveAs', async () => {
        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    id: 'ReSplatDocumentSave',
                    types: SuperFileType,
                    suggestedName: 'scene.respproj'
                });
                await saveDocument({ stream: await handle.createWritable() });
                documentFileHandle = handle;
                events.fire('doc.setName', handle.name);
                events.fire('doc.saved');
                recentFiles.add(handle);
            } catch (error) {
                if (error.name === 'AbortError') {
                    throw error;
                }
                console.error(error);
            }
        } else {
            await saveDocument({
                filename: 'scene.respproj'
            });
            events.fire('doc.saved');
        }
    });

    // doc name

    let docName: string = null;

    const setDocName = (name: string) => {
        if (name !== docName) {
            docName = name;
            events.fire('doc.name', docName);
        }
    };

    events.function('doc.name', () => {
        return docName;
    });

    events.on('doc.setName', (name) => {
        setDocName(name);
    });
};

export { registerDocEvents };
