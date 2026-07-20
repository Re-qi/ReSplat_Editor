import { ZipFileSystem, ZipReadFileSystem, ReadFileSystem } from '@playcanvas/splat-transform';

import { EditHistory } from './edit-history';
import { Events } from './events';
import { BrowserFileSystem, BlobReadSource, DecompressingReadSource, ZstdWriter, GZipWriter, isZstdSupported } from './io';
import { recentFiles } from './recent-files';
import { Scene } from './scene';
import { Splat } from './splat';
import { serializePlyToWriter, SerializeSettings } from './splat-serialize';
import { Transform } from './transform';
import { localize } from './ui/localization';

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
    };

    // load the document from the given file
    const loadDocument = async (file: File) => {
        events.fire('startSpinner');

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
            for (let i = 0; i < document.splats.length; ++i) {
                const splatSettings = document.splats[i];

                // load compressed PLY via streaming decompression (avoids OOM for large files)
                const ext = isZstdSupported() ? '.ply.zst' : '.ply.gz';
                const algo = isZstdSupported() ? 'zstd' : 'gzip';
                const compressedSource = await zipFs.createSource(`splat_${i}${ext}`);
                const decompressingSource = new DecompressingReadSource(compressedSource, algo);

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

                // PLY format bakes world transform into vertex data during save.
                // Save the entity's current transform (set by PLY loader), restore
                // non-transform properties via docDeserialize, then re-apply the
                // PLY rotation so rendering stays correct.
                const savedRot = splat.entity.getLocalRotation().clone();
                splat.docDeserialize({ ...splatSettings, position: [0, 0, 0], rotation: [savedRot.x, savedRot.y, savedRot.z, savedRot.w], scale: [1, 1, 1] });
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
                editHistory: editHistory.serialize()
            };

            const plySettings: SerializeSettings = {
                keepStateData: false,
                preserveDeleted: true,
                keepWorldTransform: false,
                keepColorTint: false,
                skipPlyRotation: false
            };

            // Create browser filesystem and zip filesystem
            const browserFs = new BrowserFileSystem(options.filename, options.stream);
            const browserWriter = await browserFs.createWriter(options.filename);
            const zipFs = new ZipFileSystem(browserWriter);

            // Write document.json
            const docWriter = await zipFs.createWriter('document.json');
            await docWriter.write(new TextEncoder().encode(JSON.stringify(document)));
            await docWriter.close();

            // Write each splat as compressed PLY
            for (let i = 0; i < splats.length; ++i) {
                const ext = useZstd ? '.ply.zst' : '.ply.gz';
                const zipWriter = await zipFs.createWriter(`splat_${i}${ext}`);
                const compressedWriter = useZstd ? new ZstdWriter(zipWriter) : new GZipWriter(zipWriter);
                await serializePlyToWriter([splats[i]], plySettings, compressedWriter);
                await compressedWriter.close();
            }

            // Close zip (also closes underlying browser writer)
            await zipFs.close();
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('doc.save-failed'),
                message: `'${error.message ?? error}'`
            });
        } finally {
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
