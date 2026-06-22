import { MemoryFileSystem } from '@playcanvas/splat-transform';
import { Color, Mat4, path, Texture, Vec3, Vec4 } from 'playcanvas';

import { BlockingPlane } from './blocking-plane';
import { BoxShape } from './box-shape';
import { EditHistory } from './edit-history';
import { SelectAllOp, SelectNoneOp, SelectInvertOp, SelectOp, HideSelectionOp, UnhideAllOp, DeleteSelectionOp, ResetOp, MultiOp, AddSplatOp, MergeOp } from './edit-ops';
import { Element, ElementType } from './element';
import { Events } from './events';
import { MappedReadFileSystem } from './io';
import { Scene } from './scene';
import { Splat } from './splat';
import { serializePly } from './splat-serialize';
import { SphereShape } from './sphere-shape';

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

// register for editor and scene events
const registerEditorEvents = (events: Events, editHistory: EditHistory, scene: Scene) => {
    const vec = new Vec3();
    const vec2 = new Vec3();
    const vec4 = new Vec4();
    const mat = new Mat4();
    const SH_C0 = 0.28209479177387814;

    const decodeColorChannel = (value: number) => {
        return Math.min(1, Math.max(0, 0.5 + value * SH_C0));
    };

    // Helper function to check if a point is blocked by any blocking plane
    const isPointBlocked = (point: Vec3, cameraPos: Vec3): boolean => {
        const blockingPlanes = events.invoke('blockingPlanes.get') as BlockingPlane[];
        if (!blockingPlanes || blockingPlanes.length === 0) {
            return false;
        }

        // Create ray from camera to point
        const direction = new Vec3().sub2(point, cameraPos).normalize();
        const distanceToPoint = point.distance(cameraPos);

        for (const plane of blockingPlanes) {
            const planePos = plane.getPlanePosition();
            const planeNormal = plane.getPlaneNormal();

            // Ray-plane intersection
            const denominator = planeNormal.dot(direction);
            if (Math.abs(denominator) > 1e-6) {
                const t = planeNormal.dot(new Vec3().sub2(planePos, cameraPos)) / denominator;
                // Check if intersection is between camera and point
                if (t > 0 && t < distanceToPoint) {
                    // Check if intersection point is within plane bounds
                    const intersectionPoint = new Vec3().add2(cameraPos, direction.clone().mulScalar(t));

                    // Transform to plane's local space
                    const planeTransform = plane.pivot.getWorldTransform();
                    const invMatrix = new Mat4().copy(planeTransform).invert();
                    const localIntersection = invMatrix.transformPoint(intersectionPoint);

                    // Check if within plane bounds (local x and z)
                    // After inverse world transform, coords are relative to original 1x1 plane geometry
                    if (Math.abs(localIntersection.x) <= 0.5 && Math.abs(localIntersection.z) <= 0.5) {
                        return true;
                    }
                }
            }
        }

        return false;
    };

    // get the list of selected splats (currently limited to just a single one)
    const selectedSplats = () => {
        const selected = events.invoke('splatSelection');
        return (selected instanceof Splat && selected.visible) ? [selected] : [];
    };

    let lastExportCursor = 0;

    // add unsaved changes warning message.
    window.addEventListener('beforeunload', (e) => {
        if (!events.invoke('scene.dirty')) {
            // if the undo cursor matches last export, then we have no unsaved changes
            return undefined;
        }

        const msg = 'You have unsaved changes. Are you sure you want to leave?';
        e.returnValue = msg;
        return msg;
    });

    events.function('targetSize', () => {
        return scene.targetSize;
    });

    events.on('scene.clear', () => {
        scene.clear();
        editHistory.clear();
        lastExportCursor = 0;
    });

    // When a splat is removed from the scene, remove all edit operations that reference it
    events.on('scene.elementRemoved', (element: Element) => {
        if (element.type === ElementType.splat) {
            editHistory.removeForSplat(element as Splat);
        }
    });

    events.function('scene.dirty', () => {
        return editHistory.cursor !== lastExportCursor;
    });

    events.on('doc.saved', () => {
        lastExportCursor = editHistory.cursor;
    });

    // force render on some events

    [
        'camera.mode', 'camera.overlay', 'camera.splatSize', 'view.outlineSelection',
        'view.centersUseGaussianColor', 'view.bands', 'camera.bound', 'camera.boundDimensions', 'camera.showPoses',
        'selection.changed', 'tool.coordSpace', 'pointCloudGroup.activeGroup'
    ].forEach((eventName) => {
        events.on(eventName, () => {
            scene.forceRender = true;
        });
    });

    // grid.visible

    const setGridVisible = (visible: boolean) => {
        if (visible !== scene.grid.visible) {
            scene.grid.visible = visible;
            events.fire('grid.visible', visible);
        }
    };

    events.function('grid.visible', () => {
        return scene.grid.visible;
    });

    events.on('grid.setVisible', (visible: boolean) => {
        setGridVisible(visible);
    });

    events.on('grid.toggleVisible', () => {
        setGridVisible(!scene.grid.visible);
    });

    setGridVisible(scene.config.show.grid);

    // camera.fov

    const setCameraFov = (fov: number) => {
        if (fov !== scene.camera.fov) {
            scene.camera.fov = fov;
            events.fire('camera.fov', scene.camera.fov);
        }
    };

    events.function('camera.fov', () => {
        return scene.camera.fov;
    });

    events.on('camera.setFov', (fov: number) => {
        setCameraFov(fov);
    });

    // camera.tonemapping

    events.function('camera.tonemapping', () => {
        return scene.camera.tonemapping;
    });

    events.on('camera.setTonemapping', (value: string) => {
        scene.camera.tonemapping = value;
    });

    // camera.bound

    let bound = scene.config.show.bound;

    const setBoundVisible = (visible: boolean) => {
        if (visible !== bound) {
            bound = visible;
            events.fire('camera.bound', bound);
        }
    };

    events.function('camera.bound', () => {
        return bound;
    });

    events.on('camera.setBound', (value: boolean) => {
        setBoundVisible(value);
    });

    events.on('camera.toggleBound', () => {
        setBoundVisible(!events.invoke('camera.bound'));
    });

    // camera.boundDimensions

    let boundDimensions = scene.config.show.boundDimensions;

    const setBoundDimensionsVisible = (visible: boolean) => {
        if (visible !== boundDimensions) {
            boundDimensions = visible;
            events.fire('camera.boundDimensions', boundDimensions);
        }
    };

    events.function('camera.boundDimensions', () => {
        return boundDimensions;
    });

    events.on('camera.setBoundDimensions', (value: boolean) => {
        setBoundDimensionsVisible(value);
    });

    events.on('camera.toggleBoundDimensions', () => {
        setBoundDimensionsVisible(!events.invoke('camera.boundDimensions'));
    });

    // camera.showPoses

    let showPoses = scene.config.show.cameraPoses;

    const setShowPoses = (visible: boolean) => {
        if (visible !== showPoses) {
            showPoses = visible;
            events.fire('camera.showPoses', showPoses);
        }
    };

    events.function('camera.showPoses', () => {
        return showPoses;
    });

    events.on('camera.setShowPoses', (value: boolean) => {
        setShowPoses(value);
    });

    events.on('camera.toggleShowPoses', () => {
        setShowPoses(!events.invoke('camera.showPoses'));
    });

    // camera.focus

    events.on('camera.focus', () => {
        const splat = selectedSplats()[0];
        if (splat) {
            // use current bounds (caller should have awaited the operation that changed data)
            const bound = splat.numSelected > 0 ?
                splat.selectionBound :
                splat.localBound;
            vec.copy(bound.center);

            const worldTransform = splat.worldTransform;
            worldTransform.transformPoint(vec, vec);
            worldTransform.getScale(vec2);

            scene.camera.focus({
                focalPoint: vec,
                radius: bound.halfExtents.length() * vec2.x,
                speed: 1
            });
        }
    });

    events.on('camera.reset', () => {
        const { initialAzim, initialElev, initialZoom } = scene.config.controls;
        const x = Math.sin(initialAzim * Math.PI / 180) * Math.cos(initialElev * Math.PI / 180);
        const y = -Math.sin(initialElev * Math.PI / 180);
        const z = Math.cos(initialAzim * Math.PI / 180) * Math.cos(initialElev * Math.PI / 180);
        const zoom = initialZoom;

        scene.camera.setPose(new Vec3(x * zoom, y * zoom, z * zoom), new Vec3(0, 0, 0));
    });

    // handle camera align events
    events.on('camera.align', (axis: string) => {
        switch (axis) {
            case 'px': scene.camera.setAzimElev(90, 0); break;
            case 'py': scene.camera.setAzimElev(0, -90); break;
            case 'pz': scene.camera.setAzimElev(0, 0); break;
            case 'nx': scene.camera.setAzimElev(270, 0); break;
            case 'ny': scene.camera.setAzimElev(0, 90); break;
            case 'nz': scene.camera.setAzimElev(180, 0); break;
        }

        // switch to ortho mode
        scene.camera.ortho = true;
    });

    // returns true if the selected splat has selected gaussians
    events.function('selection.splats', () => {
        const splat = events.invoke('splatSelection') as Splat;
        return splat?.numSelected > 0;
    });

    // returns true if any splat is selected (regardless of gaussian selection)
    events.function('selection.hasSplat', () => {
        const splat = events.invoke('splatSelection') as Splat;
        return splat instanceof Splat;
    });

    events.on('select.all', () => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new SelectAllOp(splat));
        });
    });

    events.on('select.none', () => {
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        splats.forEach((splat) => {
            events.fire('edit.add', new SelectNoneOp(splat));
        });
    });

    events.on('select.invert', () => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new SelectInvertOp(splat));
        });
    });

    events.on('select.mask', (op: 'add'|'remove'|'set', mask: Uint8Array | Uint32Array) => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new SelectOp(splat, op, mask));
        });
    });

    const intersectCenters = async (splat: Splat, op: 'add'|'remove'|'set', options: any) => {
        // run the GPU intersect inside one queued task so the gpu readback is
        // ordered relative to other queued history ops (rapid drag + undo,
        // drag-while-camera-settling, etc).
        return scene.commandQueue.enqueue(async () => {
            const data = await scene.dataProcessor.intersect(options, splat);

            // Apply blocking plane filter to GPU intersection results
            const blockingPlanes = events.invoke('blockingPlanes.get') as BlockingPlane[];
            if (blockingPlanes && blockingPlanes.length > 0) {
                const splatData = splat.splatData;
                const x = splatData.getProp('x') as Float32Array;
                const y = splatData.getProp('y') as Float32Array;
                const z = splatData.getProp('z') as Float32Array;
                if (x && y && z) {
                    const cameraPos = scene.camera.position;
                    const worldPos = new Vec3();
                    // Mask-based result — filter out blocked splats
                    for (let i = 0; i < data.length; i++) {
                        if (data[i] === 255) {
                            worldPos.set(x[i], y[i], z[i]);
                            splat.worldTransform.transformPoint(worldPos, worldPos);
                            if (isPointBlocked(worldPos, cameraPos)) {
                                data[i] = 0;
                            }
                        }
                    }
                }
            }

            // SelectOp consumes `data` synchronously in its constructor
            // (IndexRanges.fromPredicate iterates immediately), so we can
            // return the buffer to the pool as soon as the op is constructed.
            events.fire('edit.add', new SelectOp(splat, op, data));
            scene.dataProcessor.releaseMask(data);
        });
    };

    // Helper: get GPU intersect options for a selected bound shape (BoxShape or SphereShape)
    const getBoundIntersectOptions = (selection: BoxShape | SphereShape) => {
        if (selection instanceof BoxShape) {
            const p = selection.pivot.getPosition();
            const r = selection.pivot.getLocalRotation();
            return {
                box: { x: p.x, y: p.y, z: p.z, lenx: selection.lenX, leny: selection.lenY, lenz: selection.lenZ, rx: r.x, ry: r.y, rz: r.z, rw: r.w }
            };
        } else {
            const p = selection.pivot.getPosition();
            const r = selection.pivot.getLocalRotation();
            return {
                sphere: { x: p.x, y: p.y, z: p.z, radiusX: selection.radiusX, radiusY: selection.radiusY, radiusZ: selection.radiusZ, rx: r.x, ry: r.y, rz: r.z, rw: r.w }
            };
        }
    };

    events.on('select.bySphere', async (op: 'add'|'remove'|'set', sphere: number[]) => {
        const allSplats = scene.getElementsByType(ElementType.splat) as Splat[];
        for (const splat of allSplats) {
            if (splat.visible) {
                await intersectCenters(splat, op, {
                    sphere: { x: sphere[0], y: sphere[1], z: sphere[2], radiusX: sphere[3], radiusY: sphere[4], radiusZ: sphere[5], rx: sphere[6], ry: sphere[7], rz: sphere[8], rw: sphere[9] }
                });
            }
        }
    });

    events.on('select.byBox', async (op: 'add'|'remove'|'set', box: number[]) => {
        const allSplats = scene.getElementsByType(ElementType.splat) as Splat[];
        for (const splat of allSplats) {
            if (splat.visible) {
                await intersectCenters(splat, op, {
                    box: { x: box[0], y: box[1], z: box[2], lenx: box[3], leny: box[4], lenz: box[5], rx: box[6], ry: box[7], rz: box[8], rw: box[9] }
                });
            }
        }
    });

    events.function('select.rect', async (op: 'add'|'remove'|'set', rect: any) => {
        const mode = events.invoke('camera.mode');
        const overlay = events.invoke('camera.overlay');
        const { width, height } = scene.targetSize;

        for (const splat of selectedSplats()) {
            if (mode === 'centers' || overlay) {
                const splatData = splat.splatData;
                const x = splatData.getProp('x');
                const y = splatData.getProp('y');
                const z = splatData.getProp('z');

                const camera = scene.camera.camera;
                const cameraPos = scene.camera.position;
                const worldPos = new Vec3();

                // calculate final matrix
                mat.mul2(camera.camera._viewProjMat, splat.worldTransform);

                const numSplats = splatData.numSplats;
                const mask = new Uint8Array(numSplats);
                
                // Convert normalized rect to pixel coordinates
                const sx1 = rect.start.x * width;
                const sy1 = rect.start.y * height;
                const sx2 = rect.end.x * width;
                const sy2 = rect.end.y * height;
                const minX = Math.min(sx1, sx2);
                const maxX = Math.max(sx1, sx2);
                const minY = Math.min(sy1, sy2);
                const maxY = Math.max(sy1, sy2);

                for (let i = 0; i < numSplats; i++) {
                    vec4.set(x[i], y[i], z[i], 1.0);
                    mat.transformVec4(vec4, vec4);
                    const px = (vec4.x / vec4.w * 0.5 + 0.5) * width;
                    const py = (-vec4.y / vec4.w * 0.5 + 0.5) * height;
                    
                    if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
                        // Check if splat is blocked by any blocking plane
                        worldPos.set(x[i], y[i], z[i]);
                        splat.worldTransform.transformPoint(worldPos, worldPos);
                        if (!isPointBlocked(worldPos, cameraPos)) {
                            mask[i] = 255;
                        }
                    }
                }

                events.fire('edit.add', new SelectOp(splat, op, mask));
            } else {
                scene.camera.pickPrep(splat, op);
                const pick = await scene.camera.pickRect(
                    rect.start.x,
                    rect.start.y,
                    rect.end.x - rect.start.x,
                    rect.end.y - rect.start.y
                );

                // Filter out blocked points
                const cameraPos = scene.camera.position;
                const worldPos = new Vec3();
                const x = splat.splatData.getProp('x');
                const y = splat.splatData.getProp('y');
                const z = splat.splatData.getProp('z');
                
                const filteredIds = new Set<number>();
                const uniqueIds = new Set(pick);
                
                for (const pickId of uniqueIds) {
                    if (pickId !== undefined && pickId !== 0xffffffff && x && y && z && pickId < x.length) {
                        worldPos.set(x[pickId], y[pickId], z[pickId]);
                        splat.worldTransform.transformPoint(worldPos, worldPos);
                        if (!isPointBlocked(worldPos, cameraPos)) {
                            filteredIds.add(pickId);
                        }
                    }
                }

                const sortedIds = new Uint32Array(filteredIds).sort();
                events.fire('edit.add', new SelectOp(splat, op, sortedIds));
            }
        }
    });

    let maskTexture: Texture = null;

    events.function('select.byMask', async (op: 'add'|'remove'|'set', canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) => {
        const mode = events.invoke('camera.mode');
        const overlay = events.invoke('camera.overlay');

        // When a bound shape is selected, restrict flood fill to points inside the shape
        const shapeSel = events.invoke('shapeSelection');
        const boundOptions = (shapeSel instanceof BoxShape || shapeSel instanceof SphereShape)
            ? getBoundIntersectOptions(shapeSel) : null;

        for (const splat of selectedSplats()) {
            if (mode === 'centers' || overlay) {
                // create mask texture
                if (!maskTexture || maskTexture.width !== canvas.width || maskTexture.height !== canvas.height) {
                    if (maskTexture) {
                        maskTexture.destroy();
                    }
                    maskTexture = new Texture(scene.graphicsDevice);
                }
                maskTexture.setSource(canvas);

                if (boundOptions) {
                    // Two-pass: flood mask AND bound mask
                    scene.commandQueue.enqueue(async () => {
                        const floodData = await scene.dataProcessor.intersect({ mask: maskTexture }, splat);
                        const boundData = await scene.dataProcessor.intersect(boundOptions, splat);
                        for (let i = 0; i < floodData.length; i++) {
                            floodData[i] = floodData[i] && boundData[i];
                        }
                        scene.dataProcessor.releaseMask(boundData);
                        events.fire('edit.add', new SelectOp(splat, op, floodData));
                        scene.dataProcessor.releaseMask(floodData);
                    });
                } else {
                    await intersectCenters(splat, op, {
                        mask: maskTexture
                    });
                }
            } else {
                const mask = context.getImageData(0, 0, canvas.width, canvas.height);

                // calculate mask bound so we limit pixel operations
                let mx0 = mask.width - 1;
                let my0 = mask.height - 1;
                let mx1 = 0;
                let my1 = 0;
                for (let y = 0; y < mask.height; ++y) {
                    for (let x = 0; x < mask.width; ++x) {
                        if (mask.data[(y * mask.width + x) * 4 + 3] === 255) {
                            mx0 = Math.min(mx0, x);
                            my0 = Math.min(my0, y);
                            mx1 = Math.max(mx1, x);
                            my1 = Math.max(my1, y);
                        }
                    }
                }

                // Convert mask bounds to normalized coordinates
                const nx0 = mx0 / mask.width;
                const ny0 = my0 / mask.height;
                const nx1 = (mx1 + 1) / mask.width;
                const ny1 = (my1 + 1) / mask.height;
                const nw = nx1 - nx0;
                const nh = ny1 - ny0;

                scene.camera.pickPrep(splat, op);
                const pick = await scene.camera.pickRect(nx0, ny0, nw, nh);

                // Calculate actual pixel dimensions for iteration
                const { width, height } = scene.targetSize;

                // Convert normalized coordinates to render target pixels
                const px = Math.floor(nx0 * width);
                const py = Math.floor(ny0 * height);
                const pw = Math.max(1, Math.ceil((nx0 + nw) * width) - px);
                const ph = Math.max(1, Math.ceil((ny0 + nh) * height) - py);

                const selected = new Set<number>();
                for (let y = 0; y < ph; ++y) {
                    for (let x = 0; x < pw; ++x) {
                        const mx = Math.floor((nx0 + x / width) * mask.width);
                        const my = Math.floor((ny0 + y / height) * mask.height);
                        if (mask.data[(my * mask.width + mx) * 4] === 255) {
                            selected.add(pick[(ph - 1 - y) * pw + x]);
                        }
                    }
                }

                // Filter out splats blocked by blocking planes
                const blockingPlanes = events.invoke('blockingPlanes.get') as BlockingPlane[];
                if (blockingPlanes && blockingPlanes.length > 0) {
                    const cameraPos = scene.camera.position;
                    const worldPos = new Vec3();
                    const x = splat.splatData.getProp('x') as Float32Array;
                    const y = splat.splatData.getProp('y') as Float32Array;
                    const z = splat.splatData.getProp('z') as Float32Array;
                    if (x && y && z) {
                        for (const pickId of selected) {
                            if (pickId !== undefined && pickId !== 0xffffffff && pickId < x.length) {
                                worldPos.set(x[pickId], y[pickId], z[pickId]);
                                splat.worldTransform.transformPoint(worldPos, worldPos);
                                if (isPointBlocked(worldPos, cameraPos)) {
                                    selected.delete(pickId);
                                }
                            }
                        }
                    }
                }

                // If a bound shape is selected, filter selected points to only those inside the shape
                if (boundOptions) {
                    const numSplats = splat.splatData.numSplats;
                    const selectedMask = new Uint8Array(numSplats);
                    for (const id of selected) {
                        if (id < numSplats) selectedMask[id] = 255;
                    }
                    const boundMask = await scene.dataProcessor.intersect(boundOptions, splat);
                    for (let i = 0; i < numSplats; i++) {
                        selectedMask[i] = selectedMask[i] && boundMask[i];
                    }
                    scene.dataProcessor.releaseMask(boundMask);
                    // Rebuild selected set from filtered mask
                    selected.clear();
                    for (let i = 0; i < numSplats; i++) {
                        if (selectedMask[i] === 255) selected.add(i);
                    }
                }

                const sortedIds = new Uint32Array(selected).sort();
                events.fire('edit.add', new SelectOp(splat, op, sortedIds));
            }
        }
    });

    events.function('select.point', async (op: 'add'|'remove'|'set', point: { x: number, y: number }) => {
        const { width, height } = scene.targetSize;
        const mode = events.invoke('camera.mode');
        const overlay = events.invoke('camera.overlay');

        for (const splat of selectedSplats()) {
            const splatData = splat.splatData;

            if (mode === 'centers' || overlay) {
                const x = splatData.getProp('x');
                const y = splatData.getProp('y');
                const z = splatData.getProp('z');

                const splatSize = events.invoke('camera.splatSize');
                const camera = scene.camera.camera;
                const sx = point.x * width;
                const sy = point.y * height;

                // calculate final matrix
                mat.mul2(camera.camera._viewProjMat, splat.worldTransform);

                // materialize hits into an owned mask. SelectOp consumes a
                // committed snapshot rather than a closure so we never have to
                // worry about state shifting between capture and apply.
                const numSplats = splatData.numSplats;
                const mask = new Uint8Array(numSplats);
                const cameraPos = scene.camera.position;
                const worldPos = new Vec3();
                for (let i = 0; i < numSplats; i++) {
                    vec4.set(x[i], y[i], z[i], 1.0);
                    mat.transformVec4(vec4, vec4);
                    const px = (vec4.x / vec4.w * 0.5 + 0.5) * width;
                    const py = (-vec4.y / vec4.w * 0.5 + 0.5) * height;
                    if (Math.abs(px - sx) < splatSize && Math.abs(py - sy) < splatSize) {
                        // Check if splat is blocked by any blocking plane
                        worldPos.set(x[i], y[i], z[i]);
                        splat.worldTransform.transformPoint(worldPos, worldPos);
                        if (!isPointBlocked(worldPos, cameraPos)) {
                            mask[i] = 255;
                        }
                    }
                }

                events.fire('edit.add', new SelectOp(splat, op, mask));
            } else {
                scene.camera.pickPrep(splat, op);

                // Use normalized coordinates with minimal size for single pixel pick
                const pickResult = await scene.camera.pickRect(
                    point.x,
                    point.y,
                    1 / width,
                    1 / height
                );
                const pickId = pickResult[0];
                // Check if picked splat is blocked by any blocking plane
                if (pickId !== undefined && pickId !== 0xffffffff) {
                    const x = splat.splatData.getProp('x');
                    const y = splat.splatData.getProp('y');
                    const z = splat.splatData.getProp('z');
                    if (x && y && z && pickId < x.length) {
                        const worldPos = new Vec3(x[pickId], y[pickId], z[pickId]);
                        splat.worldTransform.transformPoint(worldPos, worldPos);
                        const cameraPos = scene.camera.position;
                        if (isPointBlocked(worldPos, cameraPos)) {
                            events.fire('edit.add', new SelectOp(splat, op, new Uint32Array([])));
                            return;
                        }
                    }
                }
                events.fire('edit.add', new SelectOp(splat, op, new Uint32Array([pickId])));
            }
        }
    });

    // Eyedropper selection with SelectOp so undo/redo and selection state updates remain consistent.
    // Threshold acts as a per-channel absolute difference: 0 only matches identical colors while 1 matches everything.
    // TO DO:
    // -  alternative distance metrics such as HSV.
    // -  alternative UI for threshold, two handles for min/max?
    events.function('select.colorMatch', async (op: 'add'|'remove'|'set', point: { x: number, y: number }, threshold = 0) => {
        const splats = selectedSplats();
        const targetSize = scene.targetSize;
        if (!splats.length || !targetSize || !point) {
            return;
        }

        const { width, height } = targetSize;
        if (!width || !height) {
            return;
        }

        // When a bound shape is selected, only match colors within the shape
        const shapeSel = events.invoke('shapeSelection');
        const boundOptions = (shapeSel instanceof BoxShape || shapeSel instanceof SphereShape)
            ? getBoundIntersectOptions(shapeSel) : null;

        // Clamp normalized coordinates to valid range
        const nx = Math.max(0, Math.min(1, point.x));
        const ny = Math.max(0, Math.min(1, point.y));
        const colorThreshold = Math.min(1, Math.max(0, Number.isFinite(threshold) ? threshold : 0));

        for (const splat of splats) {
            scene.camera.pickPrep(splat, 'set');
            // Use normalized coordinates with minimal size for single pixel pick
            const pickBuffer = await scene.camera.pickRect(nx, ny, 1 / width, 1 / height);
            const pickId = pickBuffer?.[0];
            if (pickId === undefined || pickId === 0xffffffff) {
                continue;
            }

            const reds = splat.splatData.getProp('f_dc_0') as Float32Array;
            const greens = splat.splatData.getProp('f_dc_1') as Float32Array;
            const blues = splat.splatData.getProp('f_dc_2') as Float32Array;
            // validate pickId and color channels exist
            if (!reds || !greens || !blues || pickId < 0 || pickId >= reds.length) {
                continue;
            }
            // decode color channels for the reference pixel
            const refR = decodeColorChannel(reds[pickId]);
            const refG = decodeColorChannel(greens[pickId]);
            const refB = decodeColorChannel(blues[pickId]);

            // materialize hits into an owned mask up front; SelectOp consumes
            // a committed snapshot.
            const numSplats = splat.splatData.numSplats;
            const mask = new Uint8Array(numSplats);
            for (let i = 0; i < numSplats; i++) {
                if (Math.abs(decodeColorChannel(reds[i]) - refR) <= colorThreshold &&
                    Math.abs(decodeColorChannel(greens[i]) - refG) <= colorThreshold &&
                    Math.abs(decodeColorChannel(blues[i]) - refB) <= colorThreshold) {
                    mask[i] = 255;
                }
            }

            // If a bound shape is selected, only keep points inside it
            if (boundOptions) {
                const boundMask = await scene.dataProcessor.intersect(boundOptions, splat);
                for (let i = 0; i < numSplats; i++) {
                    mask[i] = mask[i] && boundMask[i];
                }
                scene.dataProcessor.releaseMask(boundMask);
            }

            events.fire('edit.add', new SelectOp(splat, op, mask));
        }
    });

    events.on('select.hide', () => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new HideSelectionOp(splat));
        });
    });

    events.on('select.unhide', () => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new UnhideAllOp(splat));
        });
    });

    events.on('select.delete', () => {
        // Don't delete gaussians when measure tool is active (backspace deletes measure points instead)
        if (events.invoke('tool.active') === 'measure') {
            return;
        }

        // Check if a box or sphere shape is selected
        const shapeSel = events.invoke('shapeSelection');
        if (shapeSel instanceof BoxShape || shapeSel instanceof SphereShape) {
            // Get the shape's bounding box
            const shapeBound = shapeSel.worldBound;
            if (!shapeBound) return;

            // Delete all splats within the shape's bounding box
            const allSplats = scene.getElementsByType(ElementType.splat) as Splat[];
            for (const splat of allSplats) {
                if (!splat.visible) continue;

                // Use the shape's parameters for intersection
                let intersectOptions: any;
                if (shapeSel instanceof BoxShape) {
                    const p = shapeSel.pivot.getPosition();
                    const r = shapeSel.pivot.getLocalRotation();
                    intersectOptions = {
                        box: { x: p.x, y: p.y, z: p.z, lenx: shapeSel.lenX, leny: shapeSel.lenY, lenz: shapeSel.lenZ, rx: r.x, ry: r.y, rz: r.z, rw: r.w }
                    };
                } else if (shapeSel instanceof SphereShape) {
                    const p = shapeSel.pivot.getPosition();
                    const r = shapeSel.pivot.getLocalRotation();
                    intersectOptions = {
                        sphere: { x: p.x, y: p.y, z: p.z, radiusX: shapeSel.radiusX, radiusY: shapeSel.radiusY, radiusZ: shapeSel.radiusZ, rx: r.x, ry: r.y, rz: r.z, rw: r.w }
                    };
                }

                if (intersectOptions) {
                    // First select all points within the shape
                    scene.commandQueue.enqueue(async () => {
                        const data = await scene.dataProcessor.intersect(intersectOptions, splat);
                        // Then delete the selected points
                        events.fire('edit.add', new SelectOp(splat, 'set', data));
                        scene.dataProcessor.releaseMask(data);
                        // Now delete the selection
                        editHistory.add(new DeleteSelectionOp(splat));
                    });
                }
            }
            return;
        }

        selectedSplats().forEach((splat) => {
            editHistory.add(new DeleteSelectionOp(splat));
        });
    });

    // Opacity threshold selection - selects all points with opacity below the given threshold
    // This is useful for data cleanup by selecting low-opacity points that are barely visible
    // When a bound shape (BoxShape/SphereShape) is selected, only points inside the shape are affected
    events.on('select.opacityThreshold', (op: 'add'|'remove'|'set', threshold: number) => {
        const splats = selectedSplats();
        if (!splats.length) {
            return;
        }

        const opacityThreshold = Math.min(1, Math.max(0, Number.isFinite(threshold) ? threshold : 0));
        const shapeSel = events.invoke('shapeSelection');
        const boundOptions = (shapeSel instanceof BoxShape || shapeSel instanceof SphereShape)
            ? getBoundIntersectOptions(shapeSel) : null;

        splats.forEach((splat) => {
            const opacities = splat.splatData.getProp('opacity') as Float32Array;
            if (!opacities) {
                return;
            }

            const numSplats = splat.splatData.numSplats;
            const mask = new Uint8Array(numSplats);
            for (let i = 0; i < numSplats; i++) {
                // Convert logit to probability using sigmoid function
                const opacity = 1 / (1 + Math.exp(-opacities[i]));
                mask[i] = opacity < opacityThreshold ? 255 : 0;
            }

            if (boundOptions) {
                scene.commandQueue.enqueue(async () => {
                    const data = await scene.dataProcessor.intersect(boundOptions, splat);
                    for (let i = 0; i < numSplats; i++) {
                        mask[i] = mask[i] && data[i];
                    }
                    scene.dataProcessor.releaseMask(data);
                    events.fire('edit.add', new SelectOp(splat, op, mask));
                });
            } else {
                events.fire('edit.add', new SelectOp(splat, op, mask));
            }
        });
    });

    // Size threshold selection - selects all points with total size (x+y+z) below the given threshold
    // This is useful for data cleanup by selecting tiny splats that contribute little to the visual quality
    // When a bound shape (BoxShape/SphereShape) is selected, only points inside the shape are affected
    events.on('select.sizeThreshold', (op: 'add'|'remove'|'set', threshold: number, direction: 'leq'|'geq' = 'leq') => {
        const splats = selectedSplats();
        if (!splats.length) {
            return;
        }

        const sizeThreshold = Math.max(0, Number.isFinite(threshold) ? threshold : 0);
        const shapeSel = events.invoke('shapeSelection');
        const boundOptions = (shapeSel instanceof BoxShape || shapeSel instanceof SphereShape)
            ? getBoundIntersectOptions(shapeSel) : null;

        splats.forEach((splat) => {
            const sizeX = splat.splatData.getProp('scale_0') as Float32Array;
            const sizeY = splat.splatData.getProp('scale_1') as Float32Array;
            const sizeZ = splat.splatData.getProp('scale_2') as Float32Array;

            if (!sizeX || !sizeY || !sizeZ) {
                return;
            }

            const numSplats = splat.splatData.numSplats;
            const mask = new Uint8Array(numSplats);
            for (let i = 0; i < numSplats; i++) {
                // Convert scale values from log space to actual size and sum them
                const totalSize = Math.exp(sizeX[i]) + Math.exp(sizeY[i]) + Math.exp(sizeZ[i]);
                if (direction === 'leq') {
                    mask[i] = totalSize <= sizeThreshold ? 255 : 0;
                } else {
                    mask[i] = totalSize >= sizeThreshold ? 255 : 0;
                }
            }

            if (boundOptions) {
                scene.commandQueue.enqueue(async () => {
                    const data = await scene.dataProcessor.intersect(boundOptions, splat);
                    for (let i = 0; i < numSplats; i++) {
                        mask[i] = mask[i] && data[i];
                    }
                    scene.dataProcessor.releaseMask(data);
                    events.fire('edit.add', new SelectOp(splat, op, mask));
                });
            } else {
                events.fire('edit.add', new SelectOp(splat, op, mask));
            }
        });
    });

    const performSelectionFunc = async (func: 'duplicate' | 'separate') => {
        const splats = selectedSplats();
        if (splats.length === 0) return;

        const hasGaussianSelection = splats[0].numSelected > 0;

        // For separate, we need gaussian-level selection
        if (func === 'separate' && !hasGaussianSelection) return;

        const memFs = new MemoryFileSystem();

        await serializePly(splats, {
            maxSHBands: 3,
            selected: hasGaussianSelection
        }, memFs);

        const data = memFs.results.get('output.ply');

        if (data) {
            const splat = splats[0];

            // wrap PLY in a blob and load it
            const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' });
            const filename = `${removeExtension(splat.filename)}.ply`;
            const fileSystem = new MappedReadFileSystem();
            fileSystem.addFile(filename, blob);
            const copy = await scene.assetLoader.load(filename, fileSystem);

            if (func === 'separate') {
                editHistory.add(new MultiOp([
                    new DeleteSelectionOp(splat),
                    new AddSplatOp(scene, copy)
                ]));
            } else {
                editHistory.add(new AddSplatOp(scene, copy));
            }
        }
    };

    // duplicate the current selection
    events.on('select.duplicate', async () => {
        await performSelectionFunc('duplicate');
    });

    events.on('select.separate', async () => {
        await performSelectionFunc('separate');
    });

    // Merge multiple selected splat files into one
    events.on('select.merge', async () => {
        const multiSelected = events.invoke('multiSplatSelection') as Splat[];
        if (multiSelected.length < 2) return;

        const memFs = new MemoryFileSystem();

        // Serialize all selected splats into a single PLY file
        await serializePly(multiSelected, {
            maxSHBands: 3
        }, memFs);

        const data = memFs.results.get('output.ply');
        if (!data) return;

        // Create a merged filename from the first splat
        const firstName = removeExtension(multiSelected[0].filename);
        const mergedFilename = `${firstName}_merged.ply`;

        // Create MergeOp and add to history
        const mergeOp = new MergeOp(scene, multiSelected, mergedFilename, data);
        await editHistory.add(mergeOp);

        // Clear multi-selection and select the new merged splat
        events.fire('selection.clearMultiSplat');
        events.fire('selection', mergeOp.mergedSplat);
    });

    events.on('scene.reset', () => {
        selectedSplats().forEach((splat) => {
            editHistory.add(new ResetOp(splat));
        });
    });

    // camera mode (visual: centers/rings)

    let activeMode = 'splat';

    const setCameraMode = (mode: string) => {
        if (mode !== activeMode) {
            activeMode = mode;
            events.fire('camera.mode', activeMode);
        }
    };

    events.function('camera.mode', () => {
        return activeMode;
    });

    events.on('camera.setMode', (mode: string) => {
        setCameraMode(mode);
    });

    events.on('camera.toggleMode', () => {
        setCameraMode(events.invoke('camera.mode') === 'centers' ? 'rings' : 'centers');
    });

    events.on('camera.cycleMode', () => {
        const modes = ['splat', 'centers', 'rings'];
        const currentIndex = modes.indexOf(activeMode);
        const nextIndex = (currentIndex + 1) % modes.length;
        setCameraMode(modes[nextIndex]);
    });

    // camera control mode (orbit/fly)

    let controlMode: 'orbit' | 'fly' = 'orbit';

    const setControlMode = (mode: 'orbit' | 'fly') => {
        if (mode !== controlMode) {
            controlMode = mode;
            scene.camera.controlMode = mode;
            events.fire('camera.controlMode', controlMode);
        }
    };

    events.function('camera.controlMode', () => {
        return controlMode;
    });

    events.on('camera.setControlMode', (mode: 'orbit' | 'fly') => {
        setControlMode(mode);
    });

    events.on('camera.toggleControlMode', () => {
        setControlMode(controlMode === 'orbit' ? 'fly' : 'orbit');
    });

    // camera overlay

    let cameraOverlay = scene.config.camera.overlay;

    const setCameraOverlay = (enabled: boolean) => {
        if (enabled !== cameraOverlay) {
            cameraOverlay = enabled;
            events.fire('camera.overlay', cameraOverlay);
        }
    };

    events.function('camera.overlay', () => {
        return cameraOverlay;
    });

    events.on('camera.setOverlay', (value: boolean) => {
        setCameraOverlay(value);
    });

    events.on('camera.toggleOverlay', () => {
        setCameraOverlay(!events.invoke('camera.overlay'));
    });

    // splat size

    let splatSize = 2;

    const setSplatSize = (value: number) => {
        if (value !== splatSize) {
            splatSize = value;
            events.fire('camera.splatSize', splatSize);
        }
    };

    events.function('camera.splatSize', () => {
        return splatSize;
    });

    events.on('camera.setSplatSize', (value: number) => {
        setSplatSize(value);
    });

    // camera fly speed

    const setFlySpeed = (value: number) => {
        if (value !== scene.camera.flySpeed) {
            scene.camera.flySpeed = value;
            events.fire('camera.flySpeed', value);
        }
    };

    events.function('camera.flySpeed', () => {
        return scene.camera.flySpeed;
    });

    events.on('camera.setFlySpeed', (value: number) => {
        setFlySpeed(value);
    });

    // outline selection

    let outlineSelection = false;

    const setOutlineSelection = (value: boolean) => {
        if (value !== outlineSelection) {
            outlineSelection = value;
            events.fire('view.outlineSelection', outlineSelection);
        }
    };

    events.function('view.outlineSelection', () => {
        return outlineSelection;
    });

    events.on('view.setOutlineSelection', (value: boolean) => {
        setOutlineSelection(value);
    });

    // view spherical harmonic bands

    let viewBands = scene.config.show.shBands;

    const setViewBands = (value: number) => {
        if (value !== viewBands) {
            viewBands = value;
            events.fire('view.bands', viewBands);
        }
    };

    events.function('view.bands', () => {
        return viewBands;
    });

    events.on('view.setBands', (value: number) => {
        setViewBands(value);
    });

    // view depth cycle length (fmod range for depth mode)

    let depthCycleLength = 50;

    const setDepthCycleLength = (value: number) => {
        const clamped = Math.max(1, Math.min(100, Math.round(value)));
        if (clamped !== depthCycleLength) {
            depthCycleLength = clamped;
            events.fire('view.depthCycleLength', depthCycleLength);
            scene.forceRender = true;
        }
    };

    events.function('view.depthCycleLength', () => {
        return depthCycleLength;
    });

    events.on('view.setDepthCycleLength', (value: number) => {
        setDepthCycleLength(value);
    });

    events.fire('view.depthCycleLength', depthCycleLength);

    // centers gaussian color toggle
    let centersUseGaussianColor = false;
    events.function('view.centersUseGaussianColor', () => centersUseGaussianColor);
    events.on('view.setCentersUseGaussianColor', (value: boolean) => {
        centersUseGaussianColor = value;
        events.fire('view.centersUseGaussianColor', value);
    });

    events.function('camera.getPose', () => {
        const camera = scene.camera;
        const position = camera.position;
        const focalPoint = camera.focalPoint;
        return {
            position: { x: position.x, y: position.y, z: position.z },
            target: { x: focalPoint.x, y: focalPoint.y, z: focalPoint.z },
            fov: camera.fov
        };
    });

    events.on('camera.setPose', (pose: { position: Vec3, target: Vec3, fov?: number }, speed = 1) => {
        // assign fov before setPose so distance is computed using the new fovFactor
        if (pose.fov !== undefined) {
            scene.camera.fov = pose.fov;
            events.fire('camera.fov', pose.fov);
        }
        scene.camera.setPose(pose.position, pose.target, speed);
    });

    // hack: fire events to initialize UI
    events.fire('camera.fov', scene.camera.fov);
    events.fire('camera.overlay', cameraOverlay);
    events.fire('view.bands', viewBands);

    // doc serialization
    events.function('docSerialize.view', () => {
        const packC = (c: Color) => [c.r, c.g, c.b, c.a];
        return {
            bgColor: packC(events.invoke('bgClr')),
            selectedColor: packC(events.invoke('selectedClr')),
            unselectedColor: packC(events.invoke('unselectedClr')),
            lockedColor: packC(events.invoke('lockedClr')),
            shBands: events.invoke('view.bands'),
            centersSize: events.invoke('camera.splatSize'),
            outlineSelection: events.invoke('view.outlineSelection'),
            showGrid: events.invoke('grid.visible'),
            showBound: events.invoke('camera.bound'),
            showBoundDimensions: events.invoke('camera.boundDimensions'),
            showCameraPoses: events.invoke('camera.showPoses'),
            flySpeed: events.invoke('camera.flySpeed'),
            depthCycleLength: events.invoke('view.depthCycleLength')
        };
    });

    events.function('docDeserialize.view', (docView: any) => {
        events.fire('setBgClr', new Color(docView.bgColor));
        events.fire('setSelectedClr', new Color(docView.selectedColor));
        events.fire('setUnselectedClr', new Color(docView.unselectedColor));
        events.fire('setLockedClr', new Color(docView.lockedColor));
        events.fire('view.setBands', docView.shBands);
        events.fire('camera.setSplatSize', docView.centersSize);
        events.fire('view.setOutlineSelection', docView.outlineSelection);
        events.fire('grid.setVisible', docView.showGrid);
        events.fire('camera.setBound', docView.showBound);
        events.fire('camera.setBoundDimensions', docView.showBoundDimensions ?? false);
        events.fire('camera.setShowPoses', docView.showCameraPoses ?? false);
        events.fire('camera.setFlySpeed', docView.flySpeed);
        if (docView.depthCycleLength !== undefined) {
            events.fire('view.setDepthCycleLength', docView.depthCycleLength);
        }
    });
};

export { registerEditorEvents };
