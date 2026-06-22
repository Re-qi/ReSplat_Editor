import { Button, Container, NumericInput } from '@playcanvas/pcui';
import { WebPCodec } from '@playcanvas/splat-transform';
import { Color, createGraphicsDevice, Mat4, Vec3, Quat } from 'playcanvas';

import { BlockingPlane } from './blocking-plane';
import { registerCameraPosesEvents } from './camera-poses';
import { CommandQueue } from './command-queue';
import { registerDocEvents } from './doc';
import { EditHistory } from './edit-history';
import { AddShapeOp, SelectOp } from './edit-ops';
import { ElementType } from './element';
import { registerEditorEvents } from './editor';
import { Events } from './events';
import { initFileHandler } from './file-handler';
import { registerIframeApi } from './iframe-api';
import { registerPlyFixerEvents } from './ply-fixer';
import { registerPlySequenceEvents } from './ply-sequence';
import { registerRenderEvents } from './render';
import { Scene } from './scene';
import { getSceneConfig } from './scene-config';
import { Splat } from './splat';
import { registerSelectionEvents } from './selection';
import { ShortcutManager } from './shortcut-manager';
import { registerTimelineEvents } from './timeline';
import { BoxSelection } from './tools/box-selection';
import { BrushSelection } from './tools/brush-selection';
import { EyedropperSelection } from './tools/eyedropper-selection';
import { FloodSelection } from './tools/flood-selection';
import { LassoSelection } from './tools/lasso-selection';
import { MeasureTool } from './tools/measure-tool';
import { MoveTool } from './tools/move-tool';
import { OpacitySelection } from './tools/opacity-selection';
import { PolygonSelection } from './tools/polygon-selection';
import { RectSelection } from './tools/rect-selection';
import { RotateTool } from './tools/rotate-tool';
import { ScaleTool } from './tools/scale-tool';
import { SizeSelection } from './tools/size-selection';
import { SphereSelection } from './tools/sphere-selection';
import { ToolManager } from './tools/tool-manager';
import { registerTrackManagerEvents } from './track-manager';
import { registerTransformHandlerEvents } from './transform-handler';
import { BoundDimensionsOverlay } from './ui/bound-dimensions-overlay';
import { EditorUI } from './ui/editor';
import { localizeInit, localize } from './ui/localization';
import { MenuPanel, MenuItem } from './ui/menu-panel';
import sphereSvg from './ui/svg/select-sphere.svg';
import boxSvg from './ui/svg/show-hide-splats.svg';
import squareXSvg from './ui/svg/square-x.svg';

declare global {
    interface LaunchParams {
        readonly files: FileSystemFileHandle[];
    }

    interface Window {
        launchQueue: {
            setConsumer: (callback: (launchParams: LaunchParams) => void) => void;
        };
        scene: Scene;
    }
}

const getURLArgs = () => {
    // extract settings from command line in non-prod builds only
    const config = {};

    const apply = (key: string, value: string) => {
        let obj: any = config;
        key.split('.').forEach((k, i, a) => {
            if (i === a.length - 1) {
                obj[k] = value;
            } else {
                if (!obj.hasOwnProperty(k)) {
                    obj[k] = {};
                }
                obj = obj[k];
            }
        });
    };

    const params = new URLSearchParams(window.location.search.slice(1));
    params.forEach((value: string, key: string) => {
        apply(key, value);
    });

    return config;
};

const main = async () => {
    // Patch requestPointerLock to silently fail in environments where it's
    // not allowed (e.g. IDE preview iframes) to avoid SecurityError spam
    const origRequestPointerLock = HTMLElement.prototype.requestPointerLock;
    HTMLElement.prototype.requestPointerLock = function (...args) {
        try {
            return origRequestPointerLock.apply(this, args);
        } catch (e) {
            // Silently ignore SecurityError in restricted contexts
        }
    };

    // root events object
    const events = new Events();

    // url
    const url = new URL(window.location.href);

    // shared command queue for all async splat work (GPU readbacks + history mutations).
    // every consumer that needs ordering relative to other commands enqueues here.
    const commandQueue = new CommandQueue();

    // edit history (uses the shared queue internally)
    const editHistory = new EditHistory(events, commandQueue);

    // expose the queue as an event for any module that needs to serialise async work
    // alongside history mutations.
    events.function('queue', (fn: () => Promise<void> | void) => commandQueue.enqueue(fn));

    // init localization
    await localizeInit();

    // Configure WebP WASM for SOG format (used for both reading and writing)
    WebPCodec.wasmUrl = new URL('static/lib/webp/webp.wasm', document.baseURI).toString();

    // register events that only need the events object (before UI is created)
    registerTimelineEvents(events);
    registerCameraPosesEvents(events);
    registerTrackManagerEvents(events);
    registerTransformHandlerEvents(events);
    registerPlyFixerEvents(events);
    registerPlySequenceEvents(events);
    registerIframeApi(events);

    // Track mouse button state for conditional shortcut handling
    // Must be registered BEFORE shortcut-manager so capture phase fires first
    // Use capture phase to ensure we receive mousedown even when PCUI components
    // call stopPropagation() on their mousedown events (e.g. SliderInput, SelectInput)
    let mouseButtonsPressed = 0;
    events.function('mouse.buttonsPressed', () => mouseButtonsPressed);
    const flyKeyState: Record<string, boolean> = {};
    const releaseFlyKeys = () => {
        if (flyKeyState['w']) {
            flyKeyState['w'] = false;
            events.fire('camera.fly.forward', false);
        }
        if (flyKeyState['a']) {
            flyKeyState['a'] = false;
            events.fire('camera.fly.left', false);
        }
        if (flyKeyState['s']) {
            flyKeyState['s'] = false;
            events.fire('camera.fly.backward', false);
        }
        if (flyKeyState['d']) {
            flyKeyState['d'] = false;
            events.fire('camera.fly.right', false);
        }
        if (flyKeyState['q']) {
            flyKeyState['q'] = false;
            events.fire('camera.fly.down', false);
        }
        if (flyKeyState['e']) {
            flyKeyState['e'] = false;
            events.fire('camera.fly.up', false);
        }
    };
    // Track mouse button state using window-level pointer events with capture phase.
    // window is the highest element in the DOM tree; capture phase on window ensures
    // this fires before ANY other handler (including PCUI on document/body).
    // Using e.buttons reads the hardware button bitmap directly — more reliable than
    // manual increment/decrement which can get out of sync.
    window.addEventListener('pointerdown', (e: PointerEvent) => {
        if (e.pointerType === 'mouse') {
            mouseButtonsPressed = e.buttons;
        }
    }, true);
    window.addEventListener('pointerup', (e: PointerEvent) => {
        if (e.pointerType === 'mouse') {
            mouseButtonsPressed = e.buttons;
            if (mouseButtonsPressed === 0) {
                releaseFlyKeys();
            }
        }
    }, true);
    // Fallback: sync button state from pointermove.
    // PCUI's orbit/pan handlers may call stopPropagation on pointermove,
    // so we register on window in capture phase to always receive it.
    window.addEventListener('pointermove', (e: PointerEvent) => {
        if (e.pointerType === 'mouse') {
            mouseButtonsPressed = e.buttons;
        }
    }, true);
    // Reset mouse state when the pointer leaves the window to prevent stuck state
    document.addEventListener('mouseleave', () => {
        mouseButtonsPressed = 0;
        releaseFlyKeys();
    }, true);
    window.addEventListener('blur', () => {
        mouseButtonsPressed = 0;
        releaseFlyKeys();
    });

    // Intercept WASDQE keys in capture phase to conditionally switch tools or block camera fly
    // When no mouse button pressed → switch tools (W/E/R/Q) or block camera fly (A/S/D)
    // When mouse button pressed → camera fly controls
    const toolShortcutKeys: Record<string, string> = {
        'w': 'tool.move',
        'e': 'tool.rotate',
        'r': 'tool.scale',
        'q': 'tool.rectSelection'
    };

    // Keys to block when no mouse is pressed (camera fly keys)
    const cameraFlyKeys = new Set(['w', 'a', 's', 'd', 'q', 'e', 'r']);

    // Register capture phase handler BEFORE shortcut-manager
    document.addEventListener('keydown', (e) => {
        // Skip if focus is on text input fields (but allow buttons, containers, canvas, body)
        const target = e.target as HTMLElement;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
        if (e.repeat) return;

        const key = e.key.toLowerCase();
        if (!cameraFlyKeys.has(key)) return;

        // Let Ctrl+modified keys pass through to shortcut manager
        if (e.ctrlKey || e.metaKey) return;

        e.preventDefault();
        e.stopPropagation();

        if (mouseButtonsPressed === 0) {
            // No mouse pressed → switch tool or block
            if (key in toolShortcutKeys) {
                events.fire(toolShortcutKeys[key]);
            }
            // A/S/D are blocked when no mouse pressed
        } else {
            // Mouse pressed → camera fly control
            if (key === 'w') {
                flyKeyState['w'] = true;
                events.fire('camera.fly.forward', true);
            } else if (key === 'a') {
                flyKeyState['a'] = true;
                events.fire('camera.fly.left', true);
            } else if (key === 's') {
                flyKeyState['s'] = true;
                events.fire('camera.fly.backward', true);
            } else if (key === 'd') {
                flyKeyState['d'] = true;
                events.fire('camera.fly.right', true);
            } else if (key === 'q') {
                flyKeyState['q'] = true;
                events.fire('camera.fly.down', true);
            } else if (key === 'e') {
                flyKeyState['e'] = true;
                events.fire('camera.fly.up', true);
            }
            // R/Q do nothing when mouse is pressed
        }
    }, true);

    document.addEventListener('keyup', (e) => {
        const target = e.target as HTMLElement;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;

        const key = e.key.toLowerCase();
        if (!cameraFlyKeys.has(key)) return;

        // Let Ctrl+modified keys pass through
        if (e.ctrlKey || e.metaKey) return;

        e.preventDefault();
        e.stopPropagation();

        if (key === 'w' && flyKeyState['w']) {
            flyKeyState['w'] = false;
            events.fire('camera.fly.forward', false);
        } else if (key === 'a' && flyKeyState['a']) {
            flyKeyState['a'] = false;
            events.fire('camera.fly.left', false);
        } else if (key === 's' && flyKeyState['s']) {
            flyKeyState['s'] = false;
            events.fire('camera.fly.backward', false);
        } else if (key === 'd' && flyKeyState['d']) {
            flyKeyState['d'] = false;
            events.fire('camera.fly.right', false);
        } else if (key === 'q' && flyKeyState['q']) {
            flyKeyState['q'] = false;
            events.fire('camera.fly.down', false);
        } else if (key === 'e' && flyKeyState['e']) {
            flyKeyState['e'] = false;
            events.fire('camera.fly.up', false);
        }
    }, true);

    // initialize shortcuts
    const shortcutManager = new ShortcutManager(events);
    events.function('shortcutManager', () => shortcutManager);

    // editor ui
    const editorUI = new EditorUI(events);

    // create the graphics device
    const graphicsDevice = await createGraphicsDevice(editorUI.canvas, {
        deviceTypes: ['webgl2'],
        antialias: false,
        depth: false,
        stencil: false,
        xrCompatible: false,
        powerPreference: 'high-performance'
    });

    const overrides = [
        getURLArgs()
    ];

    // resolve scene config
    const sceneConfig = getSceneConfig(overrides);

    // construct the manager
    const scene = new Scene(
        events,
        sceneConfig,
        editorUI.canvas,
        graphicsDevice,
        commandQueue
    );

    // colors
    const bgClr = new Color();
    const selectedClr = new Color();
    const unselectedClr = new Color();
    const lockedClr = new Color();
    
    // display mode: color or depth
    let displayMode: 'color' | 'depth' = 'color';

    const setClr = (target: Color, value: Color, event: string) => {
        if (!target.equals(value)) {
            target.copy(value);
            events.fire(event, target);
        }
    };

    const setBgClr = (clr: Color) => {
        setClr(bgClr, clr, 'bgClr');
    };
    const setSelectedClr = (clr: Color) => {
        setClr(selectedClr, clr, 'selectedClr');
    };
    const setUnselectedClr = (clr: Color) => {
        setClr(unselectedClr, clr, 'unselectedClr');
    };
    const setLockedClr = (clr: Color) => {
        setClr(lockedClr, clr, 'lockedClr');
    };

    events.on('setBgClr', (clr: Color) => {
        setBgClr(clr);
    });
    events.on('setSelectedClr', (clr: Color) => {
        setSelectedClr(clr);
    });
    events.on('setUnselectedClr', (clr: Color) => {
        setUnselectedClr(clr);
    });
    events.on('setLockedClr', (clr: Color) => {
        setLockedClr(clr);
    });

    events.function('bgClr', () => {
        return bgClr;
    });
    events.function('selectedClr', () => {
        return selectedClr;
    });
    events.function('unselectedClr', () => {
        return unselectedClr;
    });
    events.function('lockedClr', () => {
        return lockedClr;
    });
    
    // display mode
    events.on('view.displayMode', (mode: 'color' | 'depth') => {
        displayMode = mode;
        scene.forceRender = true;
    });
    
    events.function('view.displayMode', () => {
        return displayMode;
    });

    events.on('bgClr', (clr: Color) => {
        const cnv = (v: number) => `${Math.max(0, Math.min(255, (v * 255))).toFixed(0)}`;
        document.body.style.backgroundColor = `rgba(${cnv(clr.r)},${cnv(clr.g)},${cnv(clr.b)},1)`;
    });
    events.on('selectedClr', (_clr: Color) => {
        scene.forceRender = true;
    });
    events.on('unselectedClr', (_clr: Color) => {
        scene.forceRender = true;
    });
    events.on('lockedClr', (_clr: Color) => {
        scene.forceRender = true;
    });

    // initialize colors from application config
    const toColor = (value: { r: number, g: number, b: number, a: number }) => {
        return new Color(value.r, value.g, value.b, value.a);
    };
    setBgClr(toColor(sceneConfig.bgClr));
    setSelectedClr(toColor(sceneConfig.selectedClr));
    setUnselectedClr(toColor(sceneConfig.unselectedClr));
    setLockedClr(toColor(sceneConfig.lockedClr));

    // create the mask selection canvas
    const maskCanvas = document.createElement('canvas');
    const maskContext = maskCanvas.getContext('2d');
    maskCanvas.setAttribute('id', 'mask-canvas');
    maskContext.globalCompositeOperation = 'copy';

    const mask = {
        canvas: maskCanvas,
        context: maskContext
    };

    // tool manager
    const toolManager = new ToolManager(events);
    toolManager.register('rectSelection', new RectSelection(events, editorUI.toolsContainer.dom));
    toolManager.register('brushSelection', new BrushSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('floodSelection', new FloodSelection(events, editorUI.toolsContainer.dom, mask, editorUI.canvasContainer));
    toolManager.register('polygonSelection', new PolygonSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('lassoSelection', new LassoSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('sphereSelection', new SphereSelection(events, scene, editorUI.canvasContainer));
    toolManager.register('boxSelection', new BoxSelection(events, scene, editorUI.canvasContainer));
    toolManager.register('eyedropperSelection', new EyedropperSelection(events, editorUI.toolsContainer.dom, editorUI.canvasContainer));
    toolManager.register('opacitySelection', new OpacitySelection(events, editorUI.toolsContainer.dom, editorUI.canvasContainer));
    toolManager.register('sizeSelection', new SizeSelection(events, editorUI.toolsContainer.dom, editorUI.canvasContainer));
    toolManager.register('move', new MoveTool(events, scene));
    toolManager.register('rotate', new RotateTool(events, scene));
    toolManager.register('scale', new ScaleTool(events, scene));
    toolManager.register('measure', new MeasureTool(events, scene, editorUI.toolsContainer.dom, editorUI.canvasContainer));

    // Activate move tool by default so gizmo always shows for scene manager selection
    events.fire('tool.move');

    new BoundDimensionsOverlay(events, scene, editorUI.canvasContainer);

    // Blocking plane management
    const blockingPlanes: BlockingPlane[] = [];
    let currentPlane: BlockingPlane | null = null;

    events.on('blockingPlane.create', () => {
        const plane = new BlockingPlane();
        scene.add(plane);
        blockingPlanes.push(plane);
        currentPlane = plane;

        // Position plane in front of camera
        const cameraPos = scene.camera.position.clone();
        const cameraForward = scene.camera.forward.clone();
        const planePos = cameraPos.add(cameraForward.clone().mulScalar(5));
        plane.pivot.setPosition(planePos);

        // Orient plane to face camera:
        // PlayCanvas plane primitive is flat on XZ plane with normal along local Y (up).
        // We need to rotate so local Y aligns with camera forward direction.
        // Build rotation from forward vector, then tilt -90° around local X to stand up.
        const forward = scene.camera.forward.clone();
        const up = new Vec3(0, 1, 0);
        const rotMatrix = new Mat4().setLookAt(new Vec3(), forward, up);
        const cameraRot = new Quat().setFromMat4(rotMatrix);
        const tiltQuat = new Quat().setFromEulerAngles(-90, 0, 0);
        const planeRot = new Quat();
        planeRot.mul2(cameraRot, tiltQuat);
        plane.pivot.setRotation(planeRot);

        plane.updateBound();

        const op = new AddShapeOp({
            scene,
            shape: plane,
            shapes: blockingPlanes,
            currentShape: currentPlane,
            setCurrentShape: (shape) => {
                currentPlane = shape as BlockingPlane | null;
            },
            skipDo: true
        });
        events.fire('edit.add', op);
    });

    events.on('scene.elementRemoved', (element: any) => {
        if (element instanceof BlockingPlane) {
            const idx = blockingPlanes.indexOf(element);
            if (idx !== -1) {
                blockingPlanes.splice(idx, 1);
                if (currentPlane === element) {
                    currentPlane = null;
                }
            }
        }
    });

    // Expose blocking planes for selection tools
    events.function('blockingPlanes.get', () => blockingPlanes);

    // Blocking plane toolbar
    const blockingPlaneToolbar = new Container({
        class: 'select-toolbar',
        hidden: true
    });

    // Tools that have their own select-toolbar and would visually overlap with the wrapper toolbar
    const toolsWithToolbar = new Set(['opacitySelection', 'sizeSelection', 'eyedropperSelection', 'floodSelection', 'measure']);
    let blockingPlaneToolbarHiddenByOtherTool = false;

    blockingPlaneToolbar.dom.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
    });

    const followButton = new Button({ text: localize('toolbar.blocking-plane.follow'), class: 'select-toolbar-button' });
    const selectBackButton = new Button({ text: localize('toolbar.blocking-plane.select-back'), class: 'select-toolbar-button' });
    const distanceInput = new NumericInput({
        class: 'select-toolbar-input',
        placeholder: localize('toolbar.blocking-plane.distance'),
        hideSlider: false,
        precision: 1,
        step: 0.1,
        min: 2,
        max: 100,
        value: 5,
        hidden: true
    });

    blockingPlaneToolbar.append(followButton);
    blockingPlaneToolbar.append(distanceInput);
    blockingPlaneToolbar.append(selectBackButton);

    editorUI.canvasContainer.append(blockingPlaneToolbar);

    // Helper to move blocking plane in front of camera
    const movePlaneInFrontOfCamera = (plane: BlockingPlane, distance: number) => {
        const cameraPos = scene.camera.position.clone();
        const cameraForward = scene.camera.forward.clone();
        const planePos = cameraPos.add(cameraForward.clone().mulScalar(distance));
        plane.pivot.setPosition(planePos);

        // Orient plane to face camera
        const forward = scene.camera.forward.clone();
        const up = new Vec3(0, 1, 0);
        const rotMatrix = new Mat4().setLookAt(new Vec3(), forward, up);
        const cameraRot = new Quat().setFromMat4(rotMatrix);
        const tiltQuat = new Quat().setFromEulerAngles(-90, 0, 0);
        const planeRot = new Quat();
        planeRot.mul2(cameraRot, tiltQuat);
        plane.pivot.setRotation(planeRot);

        plane.updateBound();
    };

    // Follow mode state
    let followPlane: BlockingPlane | null = null;
    let followDistance = 5;

    const setFollowMode = (plane: BlockingPlane | null) => {
        followPlane = plane;
        if (plane) {
            followButton.class.add('active');
            distanceInput.hidden = false;
            // Hide transform gizmo when following
            events.fire('gizmo.hide');
        } else {
            followButton.class.remove('active');
            distanceInput.hidden = true;
            // Show transform gizmo when not following
            events.fire('gizmo.show');
        }
    };

    // Follow button: toggle follow mode, snap to distance
    followButton.dom.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const sel = events.invoke('shapeSelection') as any;
        if (sel instanceof BlockingPlane) {
            if (followPlane === sel) {
                // Toggle off
                setFollowMode(null);
            } else {
                // Enable follow
                followDistance = distanceInput.value;
                movePlaneInFrontOfCamera(sel, followDistance);
                setFollowMode(sel);
            }
        }
    });

    // Distance input: adjust plane distance
    distanceInput.on('change', (value: number) => {
        followDistance = value;
        const sel = events.invoke('shapeSelection') as any;
        if (sel instanceof BlockingPlane) {
            movePlaneInFrontOfCamera(sel, value);
        }
    });

    // Select back button: select splats behind blocking plane
    selectBackButton.dom.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const sel = events.invoke('shapeSelection') as BlockingPlane;
        if (sel instanceof BlockingPlane) {
            const splats = scene.getElementsByType(ElementType.splat) as Splat[];
            splats.forEach(splat => {
                const x = splat.splatData.getProp('x') as Float32Array;
                const y = splat.splatData.getProp('y') as Float32Array;
                const z = splat.splatData.getProp('z') as Float32Array;
                const mask = new Uint8Array(splat.splatData.numSplats);

                const planePos = sel.getPlanePosition();
                const planeNormal = sel.getPlaneNormal().normalize();
                const cameraPos = scene.camera.position;
                const cameraToPlaneDir = planePos.clone().sub(cameraPos).normalize();
                const dotProduct = planeNormal.dot(cameraToPlaneDir);
                const isFrontFacing = dotProduct > 0;
                const targetSide = isFrontFacing ? 1 : -1;

                for (let i = 0; i < splat.splatData.numSplats; i++) {
                    const splatPos = new Vec3(x[i], y[i], z[i]);
                    splat.worldTransform.transformPoint(splatPos, splatPos);

                    const splatToPlane = splatPos.clone().sub(planePos);
                    const distance = planeNormal.dot(splatToPlane);

                    if (distance * targetSide > 0.01) {
                        mask[i] = 255;
                    }
                }

                events.fire('edit.add', new SelectOp(splat, 'add', mask));
            });
        }
    });

    // Update loop: follow camera when follow mode is active
    scene.app.on('update', () => {
        if (followPlane && followPlane === events.invoke('shapeSelection')) {
            movePlaneInFrontOfCamera(followPlane, followDistance);
        } else if (followPlane) {
            // Plane was deselected, stop following
            setFollowMode(null);
        }
    });

    // Show/hide toolbar based on blocking plane selection
    // When hidden by another tool, don't show until that tool deactivates
    events.on('selection.shapeChanged', (selection: any) => {
        if (selection instanceof BlockingPlane) {
            if (!blockingPlaneToolbarHiddenByOtherTool) {
                blockingPlaneToolbar.hidden = false;
            }
        } else {
            blockingPlaneToolbar.hidden = true;
            setFollowMode(null);
        }
    });

    // Hide blocking plane toolbar when a toolbar-owning tool activates
    events.on('tool.activated', (toolName: string) => {
        if (toolName && toolsWithToolbar.has(toolName)) {
            blockingPlaneToolbar.hidden = true;
            blockingPlaneToolbarHiddenByOtherTool = true;
        }
    });

    // Show blocking plane toolbar when a toolbar-owning tool deactivates
    events.on('tool.deactivated', (toolName: string) => {
        if (blockingPlaneToolbarHiddenByOtherTool && toolName && toolsWithToolbar.has(toolName)) {
            blockingPlaneToolbarHiddenByOtherTool = false;
            const sel = events.invoke('shapeSelection') as any;
            if (sel instanceof BlockingPlane) {
                blockingPlaneToolbar.hidden = false;
            }
        }
    });

    // Context menu for right-click on 3D viewport
    const createSvgElement = (svgString: string) => {
        const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
        const svg = new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        return svg;
    };

    const contextMenuItems: MenuItem[] = [
        {
            text: localize('context-menu.sphere'),
            icon: createSvgElement(sphereSvg),
            onSelect: () => {
                events.fire('sphereSelection.create');
            }
        },
        {
            text: localize('context-menu.box'),
            icon: createSvgElement(boxSvg),
            onSelect: () => {
                events.fire('boxSelection.create');
            }
        },
        {
            text: localize('context-menu.blocking-plane'),
            icon: createSvgElement(squareXSvg),
            onSelect: () => {
                events.fire('blockingPlane.create');
            }
        }
    ];

    const contextMenu = new MenuPanel(contextMenuItems, {
        class: 'context-menu'
    });
    document.body.appendChild(contextMenu.dom);

    // Track right-click drag to distinguish click from drag
    let rightClickStart = { x: 0, y: 0 };
    let hasDragged = false;
    const dragThreshold = 5; // pixels

    editorUI.canvasContainer.dom.addEventListener('pointerdown', (e: PointerEvent) => {
        if (e.button === 2) { // right button
            rightClickStart = { x: e.clientX, y: e.clientY };
            hasDragged = false;
        }
    });

    editorUI.canvasContainer.dom.addEventListener('pointermove', (e: PointerEvent) => {
        if (e.buttons === 2) { // right button held
            const dx = e.clientX - rightClickStart.x;
            const dy = e.clientY - rightClickStart.y;
            if (Math.sqrt(dx * dx + dy * dy) > dragThreshold) {
                hasDragged = true;
            }
        }
    });

    // Right-click on canvas container to show context menu (only if no drag and shift not held)
    editorUI.canvasContainer.dom.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        if (!hasDragged && !e.shiftKey) {
            events.fire('contextMenu.addShape', e.clientX, e.clientY);
        }
    });

    events.on('contextMenu.addShape', (x: number, y: number) => {
        contextMenu.dom.style.left = `${x}px`;
        contextMenu.dom.style.top = `${y}px`;
        contextMenu.hidden = false;
    });

    // Close context menu when clicking outside
    document.addEventListener('pointerdown', (e) => {
        if (!contextMenu.dom.contains(e.target as Node)) {
            contextMenu.hidden = true;
        }
    });

    editorUI.toolsContainer.dom.appendChild(maskCanvas);

    window.scene = scene;

    // register events that need scene or other dependencies
    registerEditorEvents(events, editHistory, scene);
    registerSelectionEvents(events, scene);
    registerDocEvents(scene, events);
    registerRenderEvents(scene, events);
    initFileHandler(scene, events, editorUI.appContainer.dom);

    // load async models
    scene.start();

    // handle load params
    const loadList = url.searchParams.getAll('load');
    const filenameList = url.searchParams.getAll('filename');
    for (const [i, value] of loadList.entries()) {
        const decoded = decodeURIComponent(value);
        const filename = i < filenameList.length ?
            decodeURIComponent(filenameList[i]) :
            decoded.split('/').pop();

        await events.invoke('import', [{
            filename,
            url: decoded
        }]);
    }


    // handle OS-based file association in PWA mode
    if ('launchQueue' in window) {
        window.launchQueue.setConsumer(async (launchParams: LaunchParams) => {
            for (const file of launchParams.files) {
                await events.invoke('import', [{
                    filename: file.name,
                    contents: await file.getFile()
                }]);
            }
        });
    }
};

export { main };
