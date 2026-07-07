import { Container, Label } from '@playcanvas/pcui';
import { Mat4, path, Vec3 } from 'playcanvas';

import { DataPanel } from './data-panel';
import { Events } from '../events';
import { AboutPopup } from './about-popup';
import { BottomToolbar } from './bottom-toolbar';
import { CameraModeSwitch } from './camera-mode-switch';
import { ExportPopup } from './export-popup';
import { FixPlyDialog } from './fix-ply-dialog';
import { ImageSettingsDialog } from './image-settings-dialog';
import { localize } from './localization';
import { Menu } from './menu';
import { ModeSwitch } from './mode-switch';
import { ModeToggle } from './mode-toggle';
import { OverlayToggle } from './overlay-toggle';
// import logo from './playcanvas-logo.png';
import { Popup, ShowOptions } from './popup';
import { Progress } from './progress';
import { ScenePanel } from './scene-panel';
import { ShortcutsPopup } from './shortcuts-popup';
import { Spinner } from './spinner';
import { StatusBar } from './status-bar';
import { TimelinePanel } from './timeline-panel';
import { Tooltips } from './tooltips';
import { VideoSettingsDialog } from './video-settings-dialog';
import { ViewCube } from './view-cube';
import { version } from '../../package.json';

// ts compiler and vscode find this type, but eslint does not
type FilePickerAcceptType = unknown;

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

class EditorUI {
    appContainer: Container;
    topContainer: Container;
    canvasContainer: Container;
    toolsContainer: Container;
    canvas: HTMLCanvasElement;
    popup: Popup;

    constructor(events: Events) {
        // favicon
        // const link = document.createElement('link');
        // link.rel = 'icon';
        // link.href = logo;
        // document.head.appendChild(link);

        // app
        const appContainer = new Container({
            id: 'app-container'
        });

        // editor
        const editorContainer = new Container({
            id: 'editor-container'
        });

        // tooltips container
        const tooltipsContainer = new Container({
            id: 'tooltips-container'
        });

        // top container
        const topContainer = new Container({
            id: 'top-container'
        });

        // canvas
        const canvas = document.createElement('canvas');
        canvas.id = 'canvas';

        // app label
        const appLabel = new Label({
            id: 'app-label',
            text: `RESPLAT v${version}`
        });

        // operation log label
        const operationLogLabel = new Label({
            id: 'operation-log-label',
            text: ''
        });

        // Track last operation name for undo display
        let lastOperationName = '';
        let lastImportFileName = '';

        const updateOperationLog = (message: string) => {
            operationLogLabel.text = message;
        };

        // cursor label
        const cursorLabel = new Label({
            id: 'cursor-label'
        });

        let fullprecision = '';

        events.on('camera.focalPointPicked', (details: { position: Vec3 }) => {
            cursorLabel.text = `${details.position.x.toFixed(2)}, ${details.position.y.toFixed(2)}, ${details.position.z.toFixed(2)}`;
            fullprecision = `${details.position.x}, ${details.position.y}, ${details.position.z}`;
        });

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            cursorLabel.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        cursorLabel.dom.addEventListener('pointerdown', () => {
            navigator.clipboard.writeText(fullprecision);

            const orig = cursorLabel.text;
            cursorLabel.text = localize('cursor.copied');
            setTimeout(() => {
                cursorLabel.text = orig;
            }, 1000);
        });

        // canvas container
        const canvasContainer = new Container({
            id: 'canvas-container'
        });

        // tools container
        const toolsContainer = new Container({
            id: 'tools-container'
        });

        // tooltips
        const tooltips = new Tooltips();
        tooltipsContainer.append(tooltips);

        // bottom toolbar
        const scenePanel = new ScenePanel(events, tooltips, canvasContainer);
        const bottomToolbar = new BottomToolbar(events, tooltips);
        const modeToggle = new ModeToggle(events, tooltips);
        const modeSwitch = new ModeSwitch(events, tooltips);
        const overlayToggle = new OverlayToggle(events, tooltips);
        const cameraModeSwitch = new CameraModeSwitch(events, tooltips);
        const menu = new Menu(events, tooltips);

        canvasContainer.dom.appendChild(canvas);
        canvasContainer.append(appLabel);
        canvasContainer.append(operationLogLabel);
        canvasContainer.append(cursorLabel);
        canvasContainer.append(toolsContainer);
        canvasContainer.append(scenePanel);
        canvasContainer.append(bottomToolbar);
        canvasContainer.append(modeToggle);
        canvasContainer.append(overlayToggle);
        canvasContainer.append(cameraModeSwitch);
        canvasContainer.append(modeSwitch);
        canvasContainer.append(menu);

        // view axes container
        const viewCube = new ViewCube(events);
        canvasContainer.append(viewCube);
        events.on('prerender', (cameraMatrix: Mat4) => {
            viewCube.update(cameraMatrix);
        });

        // main container
        const mainContainer = new Container({
            id: 'main-container'
        });

        const timelinePanel = new TimelinePanel(events, tooltips);
        const dataPanel = new DataPanel(events, tooltips);
        const statusBar = new StatusBar(events, tooltips);

        timelinePanel.hidden = true;

        mainContainer.append(canvasContainer);
        mainContainer.append(timelinePanel);
        mainContainer.append(dataPanel);
        mainContainer.append(statusBar);

        // Wire up status bar panel toggles
        events.on('statusBar.panelChanged', (panel: string | null) => {
            timelinePanel.hidden = panel !== 'timeline';
            dataPanel.hidden = panel !== 'splatData';
        });

        editorContainer.append(mainContainer);

        tooltips.register(cursorLabel, localize('cursor.click-to-copy'), 'bottom');

        // message popup
        const popup = new Popup(tooltips);

        // shortcuts popup
        const shortcutsPopup = new ShortcutsPopup(events);

        // export popup
        const exportPopup = new ExportPopup(events);

        // image settings
        const imageSettingsDialog = new ImageSettingsDialog(events);

        // video settings
        const videoSettingsDialog = new VideoSettingsDialog(events);

        // about popup
        const aboutPopup = new AboutPopup();

        // fix ply dialog
        const fixPlyDialog = new FixPlyDialog(events);

        topContainer.append(popup);
        topContainer.append(exportPopup);
        topContainer.append(fixPlyDialog);
        topContainer.append(imageSettingsDialog);
        topContainer.append(videoSettingsDialog);
        topContainer.append(shortcutsPopup);
        topContainer.append(aboutPopup);

        appContainer.append(editorContainer);
        appContainer.append(topContainer);
        appContainer.append(tooltipsContainer);

        this.appContainer = appContainer;
        this.topContainer = topContainer;
        this.canvasContainer = canvasContainer;
        this.toolsContainer = toolsContainer;
        this.canvas = canvas;
        this.popup = popup;

        document.body.appendChild(appContainer.dom);
        document.body.setAttribute('tabIndex', '-1');

        events.on('show.shortcuts', () => {
            shortcutsPopup.hidden = false;
        });

        events.function('show.exportPopup', (exportType, splatNames: [string], showFilenameEdit: boolean) => {
            return exportPopup.show(exportType, splatNames, showFilenameEdit);
        });

        events.function('show.fixPlyDialog', () => {
            return fixPlyDialog.show();
        });

        events.function('show.imageSettingsDialog', async () => {
            const imageSettings = await imageSettingsDialog.show();

            if (imageSettings) {
                await events.invoke('render.image', imageSettings);
            }
        });

        events.function('show.videoSettingsDialog', async () => {
            const videoSettings = await videoSettingsDialog.show();

            if (videoSettings) {

                try {
                    const docName = events.invoke('doc.name');

                    // Determine file extension and mime type based on format
                    let fileExtension: string;
                    let filePickerTypes: FilePickerAcceptType[];

                    // Codec name mapping for display
                    const codecNames: Record<string, string> = {
                        'h264': 'H.264',
                        'h265': 'H.265',
                        'vp9': 'VP9',
                        'av1': 'AV1'
                    };
                    const codecName = codecNames[videoSettings.codec] || videoSettings.codec.toUpperCase();

                    if (videoSettings.format === 'webm') {
                        fileExtension = '.webm';
                        filePickerTypes = [{
                            description: `WebM Video (${codecName})`,
                            accept: { 'video/webm': ['.webm'] }
                        }];
                    } else if (videoSettings.format === 'mov') {
                        fileExtension = '.mov';
                        filePickerTypes = [{
                            description: `MOV Video (${codecName})`,
                            accept: { 'video/quicktime': ['.mov'] }
                        }];
                    } else if (videoSettings.format === 'mkv') {
                        fileExtension = '.mkv';
                        filePickerTypes = [{
                            description: `MKV Video (${codecName})`,
                            accept: { 'video/x-matroska': ['.mkv'] }
                        }];
                    } else {
                        fileExtension = '.mp4';
                        filePickerTypes = [{
                            description: `MP4 Video (${codecName})`,
                            accept: { 'video/mp4': ['.mp4'] }
                        }];
                    }

                    const suggested = `${removeExtension(docName ?? 'ReSplat')}${fileExtension}`;

                    let writable;
                    let fileHandle: FileSystemFileHandle | undefined;

                    if (window.showSaveFilePicker) {
                        fileHandle = await window.showSaveFilePicker({
                            id: 'ReSplatVideoFileExport',
                            types: filePickerTypes,
                            suggestedName: suggested
                        });

                        writable = await fileHandle.createWritable();
                    }

                    const result = await events.invoke('render.video', videoSettings, writable);

                    // if the render was cancelled, remove the empty file left on disk
                    if (result === false && fileHandle?.remove) {
                        await fileHandle.remove();
                    }
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') {
                        // user cancelled save dialog
                        return;
                    }

                    await events.invoke('showPopup', {
                        type: 'error',
                        header: 'Failed to render video',
                        message: `'${error.message ?? error}'`
                    });
                }
            }
        });

        events.on('show.about', () => {
            aboutPopup.hidden = false;
        });

        events.function('showPopup', (options: ShowOptions) => {
            return this.popup.show(options);
        });

        // spinner with reference counting to handle nested operations
        const spinner = new Spinner();
        topContainer.append(spinner);

        let spinnerCount = 0;

        events.on('startSpinner', () => {
            spinnerCount++;
            if (spinnerCount === 1) {
                spinner.hidden = false;
            }
        });

        events.on('stopSpinner', () => {
            spinnerCount = Math.max(0, spinnerCount - 1);
            if (spinnerCount === 0) {
                spinner.hidden = true;
            }
        });

        // progress

        const progress = new Progress();

        topContainer.append(progress);

        events.on('progressStart', (header: string, cancellable?: boolean) => {
            progress.hidden = false;
            progress.setHeader(header);
            progress.setText('');
            progress.setProgress(0);
            progress.showCancelButton(!!cancellable);
            progress.onCancel = cancellable ? () => events.fire('progressCancel') : null;
        });

        events.on('progressUpdate', (options: { text?: string, progress?: number }) => {
            if (options.text !== undefined) {
                progress.setText(options.text);
            }
            if (options.progress !== undefined) {
                progress.setProgress(options.progress);
            }
        });

        events.on('progressEnd', () => {
            progress.hidden = true;
            progress.showCancelButton(false);
            progress.onCancel = null;
        });

        // initialize canvas to correct size before creating graphics device etc
        const pixelRatio = window.devicePixelRatio;
        canvas.width = Math.ceil(canvasContainer.dom.offsetWidth * pixelRatio);
        canvas.height = Math.ceil(canvasContainer.dom.offsetHeight * pixelRatio);

        ['contextmenu', 'gesturestart', 'gesturechange', 'gestureend'].forEach((event) => {
            document.addEventListener(event, (e) => {
                e.preventDefault();
            }, true);
        });

        // whenever the canvas container is clicked, set keyboard focus on the body
        canvasContainer.dom.addEventListener('pointerdown', (event: PointerEvent) => {
            // set focus on the body if user is busy pressing on the canvas or a child of the tools
            // element
            if (event.target === canvas || toolsContainer.dom.contains(event.target as Node)) {
                document.body.focus();
            }
        }, true);

        // Track if current operation is an import to avoid duplicate logging
        let isImportOperation = false;

        // Listen to operation events
        events.on('edit.add', (editOp: any) => {
            if (editOp.name && editOp.name !== 'addSplat' && editOp.name !== 'addShape') {
                let displayName: string;
                if (editOp.name === 'multiOp') {
                    const tool = events.invoke('tool.active') as string;
                    displayName = getToolDisplayName(tool);
                } else {
                    displayName = getOperationDisplayName(editOp.name);
                }
                lastOperationName = displayName;
                updateOperationLog(displayName);
            } else if (editOp.name === 'addSplat') {
                isImportOperation = true;
                // Try to get filename from splat
                if (editOp.splat && editOp.splat.filename) {
                    lastImportFileName = editOp.splat.filename;
                }
            }
        });

        // Listen to element added events for import operations
        events.on('scene.elementAdded', (element: any) => {
            if (element && element.constructor && element.constructor.name === 'Splat' && isImportOperation) {
                const fileName = element.filename || lastImportFileName || '文件';
                updateOperationLog(`新建：${fileName}`);
                lastOperationName = `新建：${fileName}`;
                isImportOperation = false;
                lastImportFileName = '';
            }
        });

        events.on('edit.undo', () => {
            updateOperationLog(`撤回：${lastOperationName}`);
        });

        events.on('edit.redo', () => {
            updateOperationLog('重做');
        });

        events.on('sphereSelection.create', () => {
            updateOperationLog('新建包裹球');
            lastOperationName = '新建包裹球';
        });

        events.on('boxSelection.create', () => {
            updateOperationLog('新建包裹盒');
            lastOperationName = '新建包裹盒';
        });

        events.on('blockingPlane.create', () => {
            updateOperationLog('新建阻挡平面');
            lastOperationName = '新建阻挡平面';
        });

        events.on('select.all', () => {
            updateOperationLog('全选');
            lastOperationName = '全选';
        });

        events.on('select.none', () => {
            updateOperationLog('取消选择');
            lastOperationName = '取消选择';
        });

        events.on('select.invert', () => {
            updateOperationLog('反选');
            lastOperationName = '反选';
        });

        events.on('select.delete', () => {
            updateOperationLog('删除选中');
            lastOperationName = '删除选中';
        });

        events.on('select.duplicate', () => {
            updateOperationLog('复制选中');
            lastOperationName = '复制选中';
        });

        events.on('select.separate', () => {
            updateOperationLog('分离选中');
            lastOperationName = '分离选中';
        });

        events.on('select.merge', () => {
            updateOperationLog('合并选中');
            lastOperationName = '合并选中';
        });

        events.on('select.hide', () => {
            updateOperationLog('隐藏选中');
            lastOperationName = '隐藏选中';
        });

        events.on('select.unhide', () => {
            updateOperationLog('显示全部');
            lastOperationName = '显示全部';
        });

        // Helper function to get display names for operations
        const getOperationDisplayName = (opName: string): string => {
            const opDisplayNames: Record<string, string> = {
                'selectAll': '全选',
                'selectNone': '取消选择',
                'selectInvert': '反选',
                'selectOp': '选择',
                'hideSelection': '隐藏选中',
                'unhideAll': '显示全部',
                'deleteSelection': '删除选中',
                'splatsTransform': '变换选中',
                'setPivot': '设置枢轴',
                'addSplat': '新建包裹球',
                'splatRename': '重命名',
                'addGroup': '新建点云组',
                'deleteGroup': '删除分组',
                'modifyGroupRanges': '修改分组',
                'entityTransform': '实体变换',
                'merge': '合并',
                'stateOp': '状态操作',
                'addShape': '新建包裹球',
                'reset': '重置',
                'animTrackEdit': '动画轨道编辑'
            };
            return opDisplayNames[opName] || opName;
        };

        // Helper function to get display names for transform tools
        const getToolDisplayName = (tool: string): string => {
            const toolDisplayNames: Record<string, string> = {
                'move': '移动',
                'rotate': '旋转',
                'scale': '缩放'
            };
            return toolDisplayNames[tool] || '变换';
        };
    }
}

export { EditorUI };
