import { type FileSystem } from '@playcanvas/splat-transform';
import { path, Quat, Vec3 } from 'playcanvas';

import { BackendClient } from './backend';
import { CreateDropHandler } from './drop-handler';
import { ElementType } from './element';
import { Events } from './events';
import { BrowserFileSystem, MappedReadFileSystem, readSogMeta, readPlyMeta } from './io';
import { createDirectoryFileSystem, DirectoryFileSystem } from './io/write';
import { Scene } from './scene';
import { Splat } from './splat';
import { serializeLcc2, serializeLcc2FromLodLog, serializePly, serializePlyCompressed, serializeStandardPly, SerializeSettings, serializeSog, serializeSplat, serializeViewer, SogSettings, ViewerExportSettings } from './splat-serialize';
import { showDownloadPrompt } from './ui/download-prompt';
import { localize } from './ui/localization';

// ts compiler and vscode find this type, but eslint does not
type FilePickerAcceptType = unknown;

type ExportType = 'ply' | 'standardPly' | 'splat' | 'sog' | 'lcc2' | 'viewer';

type FileType = 'ply' | 'compressedPly' | 'standardPly' | 'splat' | 'sog' | 'lcc2' | 'htmlViewer' | 'packageViewer';

interface SceneExportOptions {
    filename: string;
    splatIdx: 'all' | number;
    serializeSettings: SerializeSettings;

    // ply
    compressedPly?: boolean;

    // sog
    sogIterations?: number;

    // lcc2
    lodLevels?: number;
    simplifyMethod?: 'nanogs' | 'uniform';

    // viewer
    viewerExportSettings?: ViewerExportSettings;
}

const filePickerTypes: { [key: string]: FilePickerAcceptType } = {
    'ply': {
        description: 'Gaussian Splat PLY File',
        accept: {
            'application/ply': ['.ply']
        }
    },
    'compressedPly': {
        description: 'Compressed Gaussian Splat PLY File',
        accept: {
            'application/ply': ['.ply']
        }
    },
    'standardPly': {
        description: 'Standard Gaussian Splat PLY File',
        accept: {
            'application/ply': ['.ply']
        }
    },
    'sog': {
        description: 'SOG Scene',
        accept: {
            'application/x-gaussian-splat': ['.json', '.sog'],
            'image/webp': ['.webp']
        }
    },
    'lcc': {
        description: 'LCC Scene',
        accept: {
            'application/x-lcc': ['.lcc', '.lcc2', '.bin']
        }
    },
    'lcc2': {
        description: 'LCC2 Scene',
        accept: {
            'application/x-lcc': ['.lcc2']
        }
    },
    'splat': {
        description: 'Splat File',
        accept: {
            'application/x-gaussian-splat': ['.splat']
        }
    },
    'ksplat': {
        description: 'KSplat File',
        accept: {
            'application/x-gaussian-splat': ['.ksplat']
        }
    },
    'spz': {
        description: 'SPZ File (Niantic)',
        accept: {
            'application/x-gaussian-splat': ['.spz']
        }
    },
    'indexTxt': {
        description: 'Colmap Poses (Images.txt)',
        accept: {
            'text/plain': ['.txt']
        }
    },
    'htmlViewer': {
        description: 'Viewer HTML',
        accept: {
            'text/html': ['.html']
        }
    },
    'packageViewer': {
        description: 'Viewer ZIP',
        accept: {
            'application/zip': ['.zip']
        }
    }
};

const allImportTypes = {
    description: 'Supported Files',
    accept: {
        'application/ply': ['.ply'],
        'application/x-gaussian-splat': ['.json', '.sog', '.splat', '.ksplat', '.spz'],
        'image/webp': ['.webp'],
        'application/x-lcc': ['.lcc', '.lcc2', '.bin'],
        'text/plain': ['.txt']
    }
};

// determine if all files share a common filename prefix followed by
// a frame number, e.g. "frame0001.ply", "frame0002.ply", etc.
const isPlySequence = (filenames: string[]) => {
    if (filenames.length < 2) {
        return false;
    }

    // eslint-disable-next-line regexp/no-super-linear-backtracking
    const regex = /(.*?)(\d+)(?:\.compressed)?\.ply$/;
    const baseMatch = filenames[0].match(regex);
    if (!baseMatch) {
        return false;
    }

    for (let i = 1; i < filenames.length; i++) {
        const thisMatch = filenames[i].match(regex);
        if (!thisMatch || thisMatch[1] !== baseMatch[1]) {
            return false;
        }
    }

    return true;
};

// SOG has a meta.json file; streamed SOG (ssog) has a lod-meta.json file.
// Matches supersplat's isSog — a ssog directory (lod-meta.json + per-node
// meta.json/webp files) is recognized as a single multi-LOD container.
const isSog = (filenames: string[]) => {
    const count = (extension: string) => filenames.reduce((sum, f) => sum + (f.endsWith(extension) ? 1 : 0), 0);
    return count('lod-meta.json') === 1 || count('meta.json') === 1;
};

// The LCC file contains meta.lcc, index.bin, data.bin and shcoef.bin (optional).
// LCC2 comprises a meta.lcc2 file and .sog/.spz chunk files.
const isLcc = (filenames: string[]) => {
    const count = (extension: string) => filenames.reduce((sum, f) => sum + (f.endsWith(extension) ? 1 : 0), 0);
    return count('.lcc') === 1 || count('.lcc2') === 1;
};

type ImportFile = {
    filename: string;
    url?: string;
    contents?: File | Blob;
    handle?: FileSystemFileHandle;
    filePath?: string;  // Electron: absolute path from File.path extension
};

const SOG_LARGE_COUNT = 15_000_000;
const PLY_MAX_MEMORY_MB = 6_000;    // ~6 GB peak memory; browser V8 heap ~4GB but splat-transform streams

const vec = new Vec3();

// load inria camera poses from json file
const loadCameraPoses = async (file: ImportFile, events: Events) => {
    const response = new Response(file.contents);
    const json = await response.json();

    if (json.length > 0) {
        // sort entries by trailing number if it exists
        const sorter = (a: any, b: any) => {
            const avalue = a.id ?? a.img_name?.match(/\d*$/)?.[0];
            const bvalue = b.id ?? b.img_name?.match(/\d*$/)?.[0];
            return (avalue && bvalue) ? parseInt(avalue, 10) - parseInt(bvalue, 10) : 0;
        };

        json.sort(sorter).forEach((pose: any, i: number) => {
            if (pose.hasOwnProperty('position') && pose.hasOwnProperty('rotation')) {
                const p = new Vec3(pose.position);
                const z = new Vec3(pose.rotation[0][2], pose.rotation[1][2], pose.rotation[2][2]);

                // Use fixed offset along Z-axis direction instead of variable dot product
                vec.copy(z).mulScalar(10).add(p);

                // compute max FOV from intrinsics (vertical or horizontal, whichever is larger)
                let fov = 60;
                if (pose.fx && pose.fy && pose.width && pose.height) {
                    const fovX = 2 * Math.atan(pose.width / (2 * pose.fx)) * (180 / Math.PI);
                    const fovY = 2 * Math.atan(pose.height / (2 * pose.fy)) * (180 / Math.PI);
                    fov = Math.max(fovX, fovY);
                }

                events.fire('camera.addPose', {
                    name: pose.img_name ?? `${file.filename}_${i}`,
                    frame: i,
                    position: new Vec3(-p.x, -p.y, p.z),
                    target: new Vec3(-vec.x, -vec.y, vec.z),
                    fov
                });
            }
        });
    }
};

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

// https://colmap.github.io/format.html#images-txt
const loadImagesTxt = async (file: ImportFile, events: Events) => {
    const response = new Response(file.contents);
    const text = await response.text();

    // split into lines, remove comments and empty lines
    const poses = text.split('\n')
    .map(line => line.trim())
    .filter(line => !line.startsWith('#'))      // remove comments
    .filter((_, i) => i % 2 === 0)              // remove every second line
    .map((line, i) => {
        const parts = line.split(' ');
        if (parts.length !== 10) {
            return null;
        }
        const name = parts[9];
        const order = parseInt(removeExtension(name).match(/\d+$/)?.[0], 10);
        return {
            w: parseFloat(parts[1]),
            x: parseFloat(parts[2]),
            y: parseFloat(parts[3]),
            z: parseFloat(parts[4]),
            tx: parseFloat(parts[5]),
            ty: parseFloat(parts[6]),
            tz: parseFloat(parts[7]),
            name: name ?? `${file.filename}_${i}`,
            order: isFinite(order) ? order : i
        };
    })
    .filter(entry => !!entry)
    .sort((a, b) => (a.order < b.order ? -1 : 1));

    const q = new Quat();
    const t = new Vec3();

    poses.forEach((pose, i) => {
        const { w, x, y, z, tx, ty, tz } = pose;

        q.set(x, y, z, w).normalize().invert();
        t.set(-tx, -ty, -tz);
        q.transformVector(t, t);

        q.transformVector(Vec3.BACK, vec);
        vec.mulScalar(10).add(t);

        events.fire('camera.addPose', {
            name: pose.name,
            frame: i,
            position: new Vec3(-t.x, -t.y, t.z),
            target: new Vec3(-vec.x, -vec.y, vec.z)
        });
    });
};

// Electron-only: when a multi-file container (streamed SOG `lod-meta.json`,
// LCC, LCC2) is dropped/selected without its sibling data files, resolve them
// from the container's directory via the Electron fs bridge (walkDir/readFile
// IPC). In the browser there is no path access, so this is a no-op and the load
// will fail later with a missing-file error.
//
// LCC siblings are flat .bin (index/data/shcoef); LCC2 siblings are .sog/.spz
// chunks nested under data/3dgs/; ssog siblings are per-node meta.json + .webp
// textures nested under 0_0/, 0_1/, … We walk the whole tree and add each
// sibling under its path relative to the container's directory (forward
// slashes) so the loader can resolve it the same way as a folder drop.
const resolveContainerSiblings = async (files: ImportFile[], events: Events): Promise<ImportFile[]> => {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI?.isElectron) return files;

    const containerFile = files.find((f) => {
        const n = f.filename.toLowerCase();
        return n === 'lod-meta.json' || n.endsWith('.lcc') || n.endsWith('.lcc2');
    });
    if (!containerFile?.filePath) return files;

    // Siblings already provided (folder drop / multi-select) — nothing to do.
    const hasSibling = files.some((f) => {
        const n = f.filename.toLowerCase();
        return n !== 'lod-meta.json' && (n.endsWith('.json') || n.endsWith('.webp') || n.endsWith('.bin') || n.endsWith('.sog') || n.endsWith('.spz'));
    });
    if (hasSibling) return files;

    // Derive the dropped file's directory (handle both / and \ separators).
    const fp = containerFile.filePath;
    const lastSep = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'));
    const dirPath = lastSep >= 0 ? fp.substring(0, lastSep) : '';
    if (!dirPath) return files;

    // Actual IPC work follows — keep the user informed.
    events.fire('startSpinner');
    events.fire('spinnerText', localize('popup.lcc-resolving-siblings'));
    try {
        let entries: Array<{ path: string, rel: string }> = [];
        try {
            entries = await electronAPI.walkDir(dirPath);
        } catch (err) {
            console.warn(`[import] resolveContainerSiblings: walkDir failed for ${dirPath}`, err);
            return files;
        }

        const result: ImportFile[] = [...files];
        for (const e of entries) {
            const lower = e.rel.toLowerCase();
            // Container sibling data files only; skip the container meta itself
            // and any unrelated files.
            if (lower.endsWith('lod-meta.json')) continue;
            if (lower.endsWith('.lcc') || lower.endsWith('.lcc2')) continue;
            if (!lower.endsWith('.json') && !lower.endsWith('.webp') && !lower.endsWith('.bin') && !lower.endsWith('.sog') && !lower.endsWith('.spz')) continue;
            try {
                const data: Uint8Array = await electronAPI.readFile(e.path);
                // key by relative path so nested ssog/LCC2 chunks resolve the
                // same way as a folder drop
                result.push({ filename: e.rel, contents: new Blob([data as BlobPart]) });
            } catch (err) {
                console.warn(`[import] resolveContainerSiblings: readFile failed for ${e.rel}`, err);
            }
        }

        console.log(`[import] resolveContainerSiblings: added ${result.length - files.length} sibling(s) from ${dirPath}`);
        return result;
    } finally {
        events.fire('stopSpinner');
    }
};

// initialize file handler events
const initFileHandler = (scene: Scene, events: Events, dropTarget: HTMLElement) => {

    const showLoadError = async (message: string, filename: string) => {
        // Detect memory-related errors and provide helpful guidance
        let enhancedMessage = `${message} while loading '${filename}'`;

        if (message.includes('Array buffer allocation failed')) {
            const ext = filename.toLowerCase().split('.').pop() ?? 'ply';
            enhancedMessage = `加载 '${filename}' 失败: ${message}\n\n` +
                '这通常表示文件超出了浏览器的内存限制（约 4 GB）。' +
                '您可以预处理文件来减少高斯数量：\n' +
                `npx @playcanvas/splat-transform input.${ext} --decimate 25 -o output.sog`;
        }

        await events.invoke('showPopup', {
            type: 'error',
            header: localize('popup.error-loading'),
            message: enhancedMessage
        });
    };

    // import splat model(s) - handles single files, SOG, and LCC formats
    const importSplatModel = async (files: ImportFile[], animationFrame: boolean) => {
        const firstFilename = files[0]?.filename ?? '?';
        console.log(`[import] importSplatModel: ${firstFilename}, filePath=${files[0]?.filePath ?? 'none'}, hasContents=${!!files[0]?.contents}, fileSizeMB=${((files[0]?.contents as File)?.size ?? 0) / (1024 * 1024)}`);
        try {
            const filenames = files.map(f => f.filename.toLowerCase());

            // Determine the main file based on format
            let mainIndex: number;
            if (filenames.some(f => f === 'meta.json' || f === 'lod-meta.json')) {
                mainIndex = filenames.findIndex(f => f === 'meta.json' || f === 'lod-meta.json');
            } else if (filenames.some(f => f.endsWith('.lcc') || f.endsWith('.lcc2'))) {
                mainIndex = filenames.findIndex(f => f.endsWith('.lcc') || f.endsWith('.lcc2'));
            } else {
                mainIndex = 0;  // Single file case
            }

            const mainFile = files[mainIndex];
            const baseUrl = mainFile.url ? new URL('.', new URL(mainFile.url, window.location.href)).href : undefined;

            // Create file system with all local files, falling back to URL loading
            const fileSystem = new MappedReadFileSystem(baseUrl);
            files.forEach((f) => {
                if (f.contents) fileSystem.addFile(f.filename, f.contents);
            });

            // Multi-file container formats must load by their relative name so the
            // library resolves sibling files against the file system's baseUrl
            const lowerMainFilename = mainFile.filename.toLowerCase();
            const isContainer = lowerMainFilename === 'meta.json' || lowerMainFilename === 'lod-meta.json' || lowerMainFilename.endsWith('.lcc') || lowerMainFilename.endsWith('.lcc2');

            // For URL-only single file, use full URL as filename
            const filename = (files.length === 1 && !mainFile.contents && mainFile.url && !isContainer) ?
                mainFile.url :
                mainFile.filename;

            // Pre-check for large SOG files: if online mode, warn user about download size
            const isBackendResult = mainFile.url?.startsWith(`${BackendClient.BASE_URL}/temp/`);
            if (filename.toLowerCase().endsWith('.sog')) {
                const meta = await readSogMeta(fileSystem, filename);
                if (meta && meta.count > SOG_LARGE_COUNT) {
                    const backendAvailable = await BackendClient.isAvailable();
                    if (!backendAvailable) {
                        // Online mode only: warn about large file before attempting load
                        await showDownloadPrompt(events, mainFile.filename, meta.count, meta.estMemMB);
                        return;
                    }
                    // Local mode: proceed directly — browser handles SOG natively
                }
            }

            // Pre-check for large PLY files: read header vertex count before full load
            // Skip for files served by our own backend (already processed)
            if (!isBackendResult && filename.toLowerCase().endsWith('.ply') && !filename.toLowerCase().endsWith('.compressed.ply')) {
                const tMeta = performance.now();
                const meta = await readPlyMeta(fileSystem, filename);
                console.log(`[import] readPlyMeta: ${((performance.now() - tMeta) / 1000).toFixed(1)}s, ${meta?.count?.toLocaleString() ?? '?'} verts, ~${meta?.estMemMB ?? '?'} MB`);
                if (meta && meta.estMemMB > PLY_MAX_MEMORY_MB) {
                    const tCheck = performance.now();
                    const backendAvailable = await BackendClient.isAvailable();
                    console.log(`[import] isAvailable check: ${((performance.now() - tCheck) / 1000).toFixed(1)}s`);

                    if (backendAvailable) {
                        const file = mainFile.contents as File;
                        const filePath = mainFile.filePath;
                        if (!file && !filePath) {
                            // No local file blob or path — fall through to direct load
                            // (e.g. URL-loaded files can't be sent to backend)
                            console.log('[import] No local file/path, falling through to direct load');
                        } else if (filePath) {
                            // Electron: use path-based API to avoid 6GB+ HTTP upload
                            console.log(`[auto-lod] Large PLY detected: ${meta.count.toLocaleString()} Gaussians, ~${meta.estMemMB} MB → compressing (path)`);
                            events.fire('startSpinner');
                            const fileSizeMB = file?.size ? (file.size / (1024 * 1024)).toFixed(0) : '?';
                            events.fire('spinnerText', `正在压缩 (${fileSizeMB} MB)...`);
                            try {
                                const tLod = performance.now();
                                const lodResult = await BackendClient.lodConvertPath(filePath, [100]);
                                console.log(`[auto-lod] Server processing: ${((performance.now() - tLod) / 1000).toFixed(1)}s`);
                                events.fire('spinnerText', '正在加载预览...');
                                await loadLODLevels(lodResult, importFiles, events, mainFile.filename);
                                return;
                            } catch (err) {
                                console.error('[auto-lod] Failed:', err);
                                await events.invoke('showPopup', {
                                    type: 'error',
                                    header: 'LOD 处理失败',
                                    message: `自动分级加载失败: ${err.message || err}`
                                });
                                return;
                            } finally {
                                events.fire('stopSpinner');
                            }
                        } else {
                            // Auto LOD progressive loading — no user prompt.
                            // Upload mode: entire file sent as FormData (slow for large files).
                            console.log(`[auto-lod] Large PLY detected: ${meta.count.toLocaleString()} Gaussians, ~${meta.estMemMB} MB → uploading (${((file?.size ?? 0) / (1024 * 1024)).toFixed(1)} MB)...`);
                            events.fire('startSpinner');
                            const uploadSizeMB = ((file?.size ?? 0) / (1024 * 1024)).toFixed(0);
                            events.fire('spinnerText', `正在上传 (${uploadSizeMB} MB)...`);
                            try {
                                const tLod = performance.now();
                                const lodResult = await BackendClient.lodConvert(file, [100]);
                                console.log(`[auto-lod] Upload + server: ${((performance.now() - tLod) / 1000).toFixed(1)}s`);
                                events.fire('spinnerText', '正在加载预览...');
                                await loadLODLevels(lodResult, importFiles, events, mainFile.filename);
                                return; // LOD loading handles its own scene.add
                            } catch (err) {
                                console.error('[auto-lod] Failed:', err);
                                await events.invoke('showPopup', {
                                    type: 'error',
                                    header: 'LOD 处理失败',
                                    message: `自动分级加载失败: ${err.message || err}`
                                });
                                return;
                            } finally {
                                events.fire('stopSpinner');
                            }
                        }
                    } else {
                        // Online mode: show download prompt
                        await showDownloadPrompt(events, mainFile.filename, meta.count, meta.estMemMB);
                        return;
                    }
                }
            }

            const tLoad = performance.now();
            const model = await scene.assetLoader.load(
                filename, fileSystem, animationFrame, false, undefined
            );
            console.log(`[import] assetLoader.load: ${((performance.now() - tLoad) / 1000).toFixed(1)}s`);
            if (!model) {
                // user cancelled the load (e.g. LOD selection)
                return null;
            }
            const tAdd = performance.now();
            await scene.add(model);
            console.log(`[import] scene.add: ${((performance.now() - tAdd) / 1000).toFixed(1)}s`);
            return model;
        } catch (error) {
            const displayName = files[0]?.filename ?? 'unknown';
            await showLoadError(error.message ?? error, displayName);
        }
    };

    // figure out what the set of files are (ply sequence, document, sog set, ply) and then import them
    const importFiles = async (files: ImportFile[], animationFrame = false) => {
        const filenames = files.map(f => f.filename.toLowerCase());

        const result: Splat[] = [];

        if (isPlySequence(filenames)) {
            // handle ply sequence
            events.fire('plysequence.setFrames', files.map(f => f.contents));
            events.fire('timeline.frame', 0);
        } else if (isSog(filenames) || isLcc(filenames)) {
            // Electron: auto-resolve sibling data files when a single container
            // file (ssog lod-meta.json / .lcc / .lcc2) is dropped without them
            // (browser can't — no path access).
            const resolvedFiles = await resolveContainerSiblings(files, events);
            const model = await importSplatModel(resolvedFiles, animationFrame);
            if (model) {
                model.originalFilePath = files[0].filePath ?? files[0].url ?? files[0].filename;
                result.push(model);
            }
        } else {
            // check for unrecognized file types
            for (let i = 0; i < filenames.length; i++) {
                const filename = filenames[i].toLowerCase();
                if (['.respproj', '.ply', '.splat', '.sog', '.webp', 'images.txt', '.json', '.ksplat', '.spz', '.lcc', '.lcc2'].every(ext => !filename.endsWith(ext))) {
                    await showLoadError('Unrecognized file type', filename);
                    return;
                }
            }

            // handle multiple files as independent imports
            for (let i = 0; i < files.length; i++) {
                const filename = filenames[i].toLowerCase();

                if (filename.endsWith('.respproj')) {
                    // load respproj document
                    await events.invoke('doc.load', files[i].contents ?? (await fetch(files[i].url)).arrayBuffer(), files[i].handle);
                } else if (['.ply', '.splat', '.sog', '.ksplat', '.spz'].some(ext => filename.endsWith(ext))) {
                    // load gaussian splat model
                    const model = await importSplatModel([files[i]], animationFrame);
                    if (model) {
                        model.originalFilePath = files[i].filePath ?? files[i].url ?? files[i].filename;
                        result.push(model);
                    }
                } else if (filename.endsWith('images.txt')) {
                    // load colmap frames
                    await loadImagesTxt(files[i], events);
                } else if (filename.endsWith('.json')) {
                    // load inria camera poses
                    await loadCameraPoses(files[i], events);
                }
            }
        }

        return result;
    };

    events.function('import', (files: ImportFile[], animationFrame = false) => {
        return importFiles(files, animationFrame);
    });

    // create a file selector element
    // In Electron: always use <input type="file"> because File objects get a
    // `path` property — needed for path-based backend APIs that avoid 6GB+ uploads.
    // In browser: only create when showOpenFilePicker is unavailable.
    let fileSelector: HTMLInputElement;
    const isElectron = !!(window as any).electronAPI?.isElectron;
    if (!window.showOpenFilePicker || isElectron) {
        fileSelector = document.createElement('input');
        fileSelector.setAttribute('id', 'file-selector');
        fileSelector.setAttribute('type', 'file');
        fileSelector.setAttribute('accept', '.ply,.splat,meta.json,lod-meta.json,.json,.webp,.respproj,.sog,.lcc,.lcc2,.bin,.txt,.ksplat,.spz');
        fileSelector.setAttribute('multiple', 'true');

        fileSelector.onchange = () => {
            const files = [];
            for (let i = 0; i < fileSelector.files.length; i++) {
                const file = fileSelector.files[i];
                const fp = (file as any).path || (window as any).electronAPI?.getFilePathForFile?.(file);
                console.log(`[import] file picker: ${file.name}, path=${fp ?? 'none'}, sizeMB=${(file.size / (1024 * 1024)).toFixed(1)}`);
                files.push({
                    filename: file.name,
                    contents: file,
                    filePath: fp  // Electron: absolute path via webUtils or File.path
                });
            }
            importFiles(files);
            fileSelector.value = '';
        };
        document.body.append(fileSelector);
    }

    // create the file drag & drop handler
    CreateDropHandler(dropTarget, (entries, shift) => {
        importFiles(entries.map((e) => {
            const fp = (e.file as any).path ||
                (window as any).electronAPI?.getDropFilePath?.(e.filename, e.file.size) ||
                (window as any).electronAPI?.getFilePathForFile?.(e.file);
            console.log(`[import] drop entry: ${e.filename}, path=${fp ?? 'none'}, sizeMB=${(e.file.size / (1024 * 1024)).toFixed(1)}`);
            return {
                filename: e.filename,
                contents: e.file,
                handle: e.handle,
                filePath: fp  // Electron: absolute path via webUtils or File.path
            };
        }));
    });

    // get the list of visible splats containing gaussians
    const getSplats = () => {
        return (scene.getElementsByType(ElementType.splat) as Splat[])
        .filter(splat => splat.visible)
        .filter(splat => splat.numSplats > 0);
    };

    events.function('scene.allSplats', () => {
        return (scene.getElementsByType(ElementType.splat) as Splat[]);
    });

    events.function('scene.splats', () => {
        return getSplats();
    });

    events.function('scene.empty', () => {
        return getSplats().length === 0;
    });

    events.function('scene.import', async () => {
        if (fileSelector) {
            fileSelector.click();
        } else {
            try {
                const handles = await window.showOpenFilePicker({
                    id: 'ReSplatFileImport',
                    multiple: true,
                    excludeAcceptAllOption: false,
                    types: [
                        allImportTypes,
                        filePickerTypes.ply,
                        filePickerTypes.compressedPly,
                        filePickerTypes.splat,
                        filePickerTypes.sog,
                        filePickerTypes.lcc,
                        filePickerTypes.ksplat,
                        filePickerTypes.spz,
                        filePickerTypes.indexTxt
                    ]
                });

                const files = [];
                for (let i = 0; i < handles.length; i++) {
                    files.push({
                        filename: handles[i].name,
                        contents: await handles[i].getFile()
                    });
                }

                importFiles(files);

            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error(error);
                }
            }
        }
    });

    // Import a whole directory (Electron only). Streamed SOG (ssog) and LCC2
    // are directory-based formats — the single-file picker can't select them.
    // walkDir + readFile reads every file (keyed by forward-slash relative
    // path) so isSog/isLcc + MappedReadFileSystem resolve them like a folder
    // drag & drop. In the browser use drag & drop instead.
    events.function('scene.importFolder', async () => {
        const electronAPI = (window as any).electronAPI;
        if (!electronAPI?.isElectron) return;

        const folderPath = await electronAPI.openFolderDialog();
        if (!folderPath) return;

        events.fire('startSpinner');
        events.fire('spinnerText', localize('popup.lcc-resolving-siblings'));
        try {
            const entries: Array<{ path: string, rel: string }> = await electronAPI.walkDir(folderPath);
            const files: ImportFile[] = [];
            for (const e of entries) {
                const lower = e.rel.toLowerCase();
                // Only splat-container payload files — skips license.txt etc.
                if (!lower.endsWith('.json') && !lower.endsWith('.webp') && !lower.endsWith('.bin') && !lower.endsWith('.sog') && !lower.endsWith('.spz')) continue;
                try {
                    const data: Uint8Array = await electronAPI.readFile(e.path);
                    files.push({ filename: e.rel, contents: new Blob([data as BlobPart]) });
                } catch (err) {
                    console.warn(`[import] importFolder: readFile failed for ${e.rel}`, err);
                }
            }
            console.log(`[import] importFolder: ${files.length} file(s) from ${folderPath}`);
            if (files.length === 0) {
                await showLoadError('No supported splat files found', folderPath);
                return;
            }
            await importFiles(files);
        } catch (error) {
            console.error('[import] importFolder failed:', error);
            await showLoadError(error.message ?? error, folderPath);
        } finally {
            events.fire('stopSpinner');
        }
    });

    // Progressive LOD loader: load lowest level first, then replace with higher levels
    const loadLODLevels = async (
        lodResult: { levels: Array<{ level: number; count: number; url: string; sizeBytes: number }> },
        importFn: (files: ImportFile[], animFrame: boolean) => Promise<Splat[]>,
        evts: Events,
        originalFilename: string
    ) => {
        const levels = lodResult.levels.sort((a, b) => a.level - b.level);
        if (levels.length === 0) return;

        // Download helper: XHR with progress callback (blob avoids double download)
        const downloadWithProgress = (url: string, textFn: (pct: number) => string): Promise<Blob> => {
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', url);
                xhr.responseType = 'blob';
                xhr.onprogress = (e) => {
                    if (e.lengthComputable) {
                        evts.fire('spinnerText', textFn(Math.round((e.loaded / e.total) * 100)));
                    }
                };
                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as Blob);
                    else reject(new Error(`HTTP ${xhr.status}`));
                };
                xhr.onerror = () => reject(new Error('Download failed'));
                xhr.send();
            });
        };

        // Load lowest LOD first — this is the fast preview that makes the
        // model interactive. Stop the spinner once the model is visible.
        const preview = levels[0];
        const tPreviewStart = performance.now();
        const previewSizeMB = (preview.sizeBytes / (1024 * 1024)).toFixed(1);
        console.log(`[LOD] Loading preview: ${preview.level}% (${preview.count.toLocaleString()} Gaussians, ${previewSizeMB} MB)`);

        // Download with progress → pass as blob to skip redundant HTTP fetch in loader
        const previewBlob = await downloadWithProgress(
            preview.url,
            pct => `正在加载预览 ${pct}% (${previewSizeMB} MB)`
        );
        console.log(`[LOD] Preview downloaded: ${((performance.now() - tPreviewStart) / 1000).toFixed(1)}s`);
        const tParse = performance.now();

        const models = await importFn([{ filename: `lod_${preview.level}.compressed.ply`, contents: previewBlob }], false);
        console.log(`[LOD] Preview parsed: ${((performance.now() - tParse) / 1000).toFixed(1)}s`);
        let currentModel = models[0];
        if (currentModel) currentModel.name = originalFilename;
        evts.fire('stopSpinner');

        // Load remaining levels in background, replacing each time
        for (let i = 1; i < levels.length; i++) {
            const nextLevel = levels[i];
            const nextSizeMB = (nextLevel.sizeBytes / (1024 * 1024)).toFixed(1);
            const tUpgrade = performance.now();
            console.log(`[LOD] Upgrading to ${nextLevel.level}% (${nextLevel.count.toLocaleString()} Gaussians, ${nextSizeMB} MB)`);
            try {
                const upgradeBlob = await downloadWithProgress(
                    nextLevel.url,
                    pct => `正在下载 ${nextLevel.level}% ${pct}% (${nextSizeMB} MB)`
                );
                const tUpgradeParse = performance.now();
                const nextModels = await importFn([{ filename: `lod_${nextLevel.level}.compressed.ply`, contents: upgradeBlob }], false);
                console.log(`[LOD] Upgrade parsed: ${((performance.now() - tUpgradeParse) / 1000).toFixed(1)}s`);
                const nextModel = nextModels[0];
                if (nextModel) nextModel.name = originalFilename;
                if (nextModel && currentModel) {
                    scene.remove(currentModel);
                    currentModel.destroy();
                    await scene.add(nextModel);
                    currentModel = nextModel;
                }
            } catch (err) {
                console.warn(`[LOD] Failed to load level ${nextLevel.level}%:`, err);
            }
            console.log(`[LOD] Upgrade total: ${((performance.now() - tUpgrade) / 1000).toFixed(1)}s`);
        }
        const totalClient = ((performance.now() - tPreviewStart) / 1000).toFixed(1);
        console.log(`[LOD] All levels loaded (total client: ${totalClient}s)`);
    };

    // open a folder
    events.function('scene.openAnimation', async () => {
        try {
            // Use native folder dialog in Electron
            if (window.electronAPI?.isElectron) {
                const folderPath = await window.electronAPI.openFolderDialog();
                if (!folderPath) return;

                const allPaths = await window.electronAPI.readDir(folderPath);
                const plyPaths = allPaths.filter((p: string) => p.toLowerCase().endsWith('.ply'));
                const files: File[] = [];
                for (const fp of plyPaths) {
                    const buffer = await window.electronAPI.readFile(fp);
                    const name = fp.split(/[\\/]/).pop() || fp;
                    files.push(new File([buffer as BlobPart], name));
                }
                events.fire('plysequence.setFrames', files);
                events.fire('timeline.frame', 0);
                return;
            }

            const handle = await window.showDirectoryPicker({
                id: 'ReSplatFileOpenAnimation',
                mode: 'readwrite'
            });

            if (handle) {
                const files = [];
                for await (const value of handle.values()) {
                    if (value.kind === 'file') {
                        const file = await value.getFile();
                        if (file.name.toLowerCase().endsWith('.ply')) {
                            files.push(file);
                        }
                    }
                }
                events.fire('plysequence.setFrames', files);
                events.fire('timeline.frame', 0);
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error(error);
            }
        }
    });

    events.function('scene.export', async (exportType: ExportType) => {
        const splats = getSplats();

        const hasFilePicker = !!window.showSaveFilePicker;

        // LCC2 is a directory format: the directory picker does not supply a
        // filename, so the popup's filename row (base name) must always be
        // shown. Other formats only show it when no file picker is available.
        const showFilenameEdit = exportType === 'lcc2' || !hasFilePicker;

        // show viewer export options
        const options = await events.invoke('show.exportPopup', exportType, splats.map(s => s.name), showFilenameEdit) as SceneExportOptions;

        // return if user cancelled
        if (!options) {
            return;
        }

        // LCC2 writes a directory tree (XXX.lcc2 + data/3dgs/*.sog), so it
        // skips the single-file showSaveFilePicker and asks the user to pick
        // an output directory instead. createDirectoryFileSystem returns null
        // when the user cancels the directory picker — bail silently, matching
        // how showSaveFilePicker cancellation is handled below.
        if (exportType === 'lcc2') {
            // Warn about SOG encoding performance for very large scenes (>15M
            // splats): splat-transform's GPU k-means + WebP encoding may be
            // extremely slow or fail. Let the user confirm before proceeding.
            const totalSplats = splats.reduce((sum, s) => sum + s.numSplats, 0);
            if (totalSplats > 15_000_000) {
                const result = await events.invoke('showPopup', {
                    type: 'yesno',
                    header: localize('popup.export.lcc2-large-scene-header'),
                    message: `${totalSplats.toLocaleString()} splats\n${localize('popup.export.lcc2-large-scene-warning')}`
                }) as { action: string };
                if (result.action !== 'yes') {
                    return;
                }
            }

            const dirFs = await createDirectoryFileSystem();
            if (!dirFs) {
                return;
            }
            await events.invoke('scene.write', 'lcc2', options, dirFs);
            return;
        }

        const fileType: FileType =
            (exportType === 'viewer') ? (options.viewerExportSettings!.type === 'zip' ? 'packageViewer' : 'htmlViewer') :
                (exportType === 'ply') ? (options.compressedPly ? 'compressedPly' : 'ply') :
                    (exportType === 'standardPly') ? 'standardPly' :
                        (exportType === 'sog') ? 'sog' : 'splat';

        if (hasFilePicker) {
            try {
                const fileHandle = await window.showSaveFilePicker({
                    id: 'ReSplatFileExport',
                    types: [filePickerTypes[fileType]],
                    suggestedName: options.filename
                });
                await events.invoke('scene.write', fileType, options, await fileHandle.createWritable());
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error(error);
                }
            }
        } else {
            await events.invoke('scene.write', fileType, options);
        }
    });

    events.function('scene.write', async (fileType: FileType, options: SceneExportOptions, stream?: FileSystemWritableFileStream | FileSystem) => {
        // SOG, viewer, and LCC2 exports have their own progress UI, other formats use spinner
        const useSpinner = fileType !== 'sog' && fileType !== 'htmlViewer' && fileType !== 'packageViewer' && fileType !== 'lcc2';

        if (useSpinner) {
            events.fire('startSpinner');
        }

        try {
            // setTimeout so spinner/progress has a chance to activate
            await new Promise<void>((resolve) => {
                setTimeout(resolve);
            });

            const { filename, splatIdx, serializeSettings, viewerExportSettings } = options;

            // LCC2 receives a directory-capable FileSystem (DirectoryFileSystem or
            // MemoryFileSystem fallback) directly from scene.export; other formats
            // wrap the single-file picker stream in a BrowserFileSystem.
            const fs: FileSystem = fileType === 'lcc2' ?
                stream as FileSystem :
                new BrowserFileSystem(filename, stream as FileSystemWritableFileStream | undefined);

            const splats = splatIdx === 'all' ? getSplats() : [getSplats()[splatIdx]];

            // Shared SogSettings construction for the 'sog' and 'lcc2' cases —
            // both reuse serializeSog's underlying path (extractDataTable +
            // writeSogInternal), so the settings shape (minOpacity, removeInvalid,
            // iterations, events) must be identical.
            const buildSogSettings = (): SogSettings => ({
                ...serializeSettings,
                minOpacity: 1 / 255,
                removeInvalid: true,
                iterations: options.sogIterations ?? 0,
                events
            });

            switch (fileType) {
                case 'ply':
                    await serializePly(splats, serializeSettings, fs);
                    break;
                case 'compressedPly':
                    serializeSettings.minOpacity = 1 / 255;
                    serializeSettings.removeInvalid = true;
                    await serializePlyCompressed(splats, serializeSettings, fs);
                    break;
                case 'standardPly':
                    await serializeStandardPly(splats, serializeSettings, fs);
                    break;
                case 'splat':
                    await serializeSplat(splats, serializeSettings, fs);
                    break;
                case 'sog':
                    await serializeSog(splats, buildSogSettings(), fs);
                    break;
                case 'lcc2': {
                    const baseName = removeExtension(filename);
                    const totalSplats = splats.reduce((sum, s) => sum + s.numSplats, 0);
                    const outputRoot = (fs as DirectoryFileSystem).getRootPath?.();

                    // Route to backend for large datasets (>10M splats) when a
                    // PLY file path and output directory are available (Electron).
                    const plyPath = splats[0]?.originalFilePath;
                    if (totalSplats > 10_000_000 && plyPath && outputRoot && await BackendClient.isAvailable()) {
                        console.warn(`[LCC2] Routing ${totalSplats.toLocaleString()} splats to backend (${plyPath})`);
                        events.fire('progressStart', 'Exporting LCC2');
                        events.fire('progressUpdate', { text: 'Exporting via backend…', progress: 0 });
                        await BackendClient.lcc2ExportPath(plyPath, outputRoot, {
                            name: baseName,
                            lodLevels: options.lodLevels ?? 1,
                            shBands: serializeSettings.maxSHBands ?? 0,
                            iterations: options.sogIterations ?? 0,
                            simplifyMethod: options.simplifyMethod ?? 'nanogs'
                        }, ({ progress, text }) => {
                            events.fire('progressUpdate', { text, progress });
                        });
                        events.fire('progressEnd');
                        break;
                    }

                    // Multi-LOD path: if the (single) selected splat has a LodEditLog
                    // and a valid LCC source file, stream each LOD from the original
                    // file and replay deletions/transforms. This produces a true
                    // multi-LOD LCC2 where edits are propagated to every level.
                    const multiLodSplat = splats.length === 1 && splats[0].lodEditLog && splats[0].lccFileSystem && splats[0].lccFilePath && splats[0].lodCounts.length >= 2 ? splats[0] : null;

                    if (multiLodSplat) {
                        await serializeLcc2FromLodLog(multiLodSplat, {
                            name: baseName,
                            splatIdx: null,
                            serializeSettings: buildSogSettings(),
                            lodLevels: options.lodLevels ?? 1,
                            splatType: '.sog'
                        }, fs);
                    } else {
                        await serializeLcc2(splats, {
                            name: baseName,
                            splatIdx: null,
                            serializeSettings: buildSogSettings(),
                            lodLevels: options.lodLevels ?? 1,
                            splatType: '.sog',
                            simplifyMethod: options.simplifyMethod ?? 'uniform'
                        }, fs);
                    }
                    break;
                }
                case 'htmlViewer':
                case 'packageViewer':
                    await serializeViewer(splats, serializeSettings, { ...viewerExportSettings!, events }, fs);
                    break;
            }

        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('popup.error-loading'),
                message: `${error.message ?? error} while saving file`
            });
        } finally {
            if (useSpinner) {
                events.fire('stopSpinner');
            }
        }
    });
};

export { initFileHandler, ExportType, SceneExportOptions };
