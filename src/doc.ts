import { ZipFileSystem, ZipReadFileSystem, ReadFileSystem, ReadSource } from '@playcanvas/splat-transform';

import { BlockingPlane } from './blocking-plane';
import { BoxShape } from './box-shape';
import { EditHistory } from './edit-history';
import { Element } from './element';
import { Events } from './events';
import { BrowserFileSystem, BlobReadSource, DecompressingReadSource, TeeReadStream, ZstdWriter, GZipWriter, isZstdSupported } from './io';
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
    const loadDocument = async (file: File) => {
        events.fire('startSpinner');
        events.fire('spinnerText', '正在打开工程...');

        // Create streaming ZIP reader from the file
        const blobSource = new BlobReadSource(file);
        const zipFs = new ZipReadFileSystem(blobSource);

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

            for (let i = 0; i < document.splats.length; ++i) {
                const splatSettings = document.splats[i];

                // load compressed PLY via streaming decompression (avoids OOM for large files)
                const ext = isZstdSupported() ? '.ply.zst' : '.ply.gz';
                const algo = isZstdSupported() ? 'zstd' : 'gzip';
                const compressedSource = await zipFs.createSource(`splat_${i}${ext}`);

                // TeeReadStream: simultaneously caches compressed data for instant
                // re-save while streaming to the decompressor — pipelines the I/O
                // and decompression instead of sequential read-then-decompress.
                const cacheChunks: Uint8Array[] = [];
                const teeStream = new TeeReadStream(compressedSource.read(), cacheChunks);
                loadingCache.set(i, cacheChunks);

                const teeSource: ReadSource = {
                    size: compressedSource.size,
                    seekable: false,
                    read() {
                        return teeStream;
                    },
                    close() {
                        teeStream.close();
                        compressedSource.close();
                    }
                };

                const decompressingSource = new DecompressingReadSource(teeSource, algo);

                // create a simple filesystem wrapper for the decompressing source
                const plyFs: ReadFileSystem = {
                    createSource: (filename: string) => {
                        if (filename === `splat_${i}.ply`) {
                            return Promise.resolve(decompressingSource);
                        }
                        return Promise.reject(new Error(`File not found: ${filename}`));
                    }
                };

                const splat = await scene.assetLoader.load(`splat_${i}.ply`, plyFs, false, true);
                await scene.add(splat);

                // Restore entity transform from doc.json (no longer baked into PLY).
                // editHistory replay will handle intermediate transform states.
                splat.docDeserialize(splatSettings);
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

            // restore edit history (must await since it goes through commandQueue)
            if (document.editHistory) {
                await editHistory.deserialize(document.editHistory, scene);
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

            // Serialize point cloud groups for each splat
            const groups: { name: string; indices: number[] }[][] = splats.map((s) => {
                const splatGroups = events.invoke('pointCloudGroup.getGroupsForSplat', s) as { name: string; indices: Uint32Array }[];
                return splatGroups.map(g => ({ name: g.name, indices: Array.from(g.indices) }));
            });

            // determine compression format
            const useZstd = isZstdSupported();
            const format = useZstd ? 'ply-zstd' : 'ply-gzip';

            const document = {
                version: 1,
                camera: scene.camera.docSerialize(),
                view: events.invoke('docSerialize.view'),
                poseSets: events.invoke('docSerialize.poseSets'),
                timeline: events.invoke('docSerialize.timeline'),
                splats: splats.map(s => s.docSerialize()),
                groups: groups,
                shapes: scene.elements
                .filter(e => e.docSerialize() !== null)
                .map(e => e.docSerialize()),
                editHistory: editHistory.serialize()
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
                        }
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
    events.function('doc.load', async (file: File, handle?: FileSystemFileHandle) => {
        if (!events.invoke('scene.empty') && !await getResetConfirmation()) {
            return false;
        }

        await loadDocument(file);

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
