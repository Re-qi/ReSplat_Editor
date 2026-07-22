import { BlockingPlane } from './blocking-plane';
import { BoxShape } from './box-shape';
import { Element, ElementType } from './element';
import { Events } from './events';
import { Scene } from './scene';
import { SphereShape } from './sphere-shape';
import { Splat } from './splat';

const isShape = (element: Element) => element instanceof SphereShape || element instanceof BoxShape || element instanceof BlockingPlane;

const registerSelectionEvents = (events: Events, scene: Scene) => {
    let splatSelection: Element | null = null;
    let shapeSelection: Element | null = null;
    let lastSelected: 'splat' | 'shape' | null = null;

    // Multi-select state for splats (Ctrl+click)
    const multiSplatSelection = new Set<Splat>();

    // Most recent selection (for backward compatibility)
    const getSelection = (): Element | null => {
        if (lastSelected === 'shape' && shapeSelection) return shapeSelection;
        if (lastSelected === 'splat' && splatSelection) return splatSelection;
        return shapeSelection ?? splatSelection;
    };

    const setSplatSelection = (element: Splat | null) => {
        if (!element || element.visible) {
            const prev = splatSelection;
            splatSelection = element;
            if (element) lastSelected = 'splat';
            events.fire('selection.changed', splatSelection, prev);
            computeCurrent();
        }
    };

    const setShapeSelection = (element: Element | null) => {
        if (!element || element.visible) {
            const prev = shapeSelection;
            shapeSelection = element;
            if (element) lastSelected = 'shape';
            events.fire('selection.shapeChanged', shapeSelection, prev);
            computeCurrent();
        }
    };

    // Compute which element the gizmo currently controls.
    // Priority: active point cloud group > shape > splat.
    // Only one element can be "current" at a time.
    let currentElement: Element | null = null;
    let lastClicked: Element | null = null;
    let prevCurrentElement: Element | null = null;
    const isGroupCurrent = () => {
        return !!events.invoke('pointCloudGroup.activeGroup');
    };

    const logCurrentState = () => {
        const describe = (el: Element | null) => {
            if (!el) return 'none';
            if (el instanceof Splat) return `splat#${el.uid}("${el.name}")`;
            if (el instanceof SphereShape) return `sphere#${el.uid}`;
            if (el instanceof BoxShape) return `box#${el.uid}`;
            if (el instanceof BlockingPlane) return `plane#${el.uid}`;
            return `element#${el.uid}`;
        };
        const isGroup = isGroupCurrent();
        const current = isGroup ? 'group' : describe(currentElement);
        console.log(
            `[current] prev: ${describe(prevCurrentElement)} | ` +
            `clicked: ${describe(lastClicked)} | ` +
            `current: ${current}`
        );
        prevCurrentElement = currentElement;
    };

    const computeCurrent = () => {
        // Group mode: active group + selected gaussians
        if (isGroupCurrent()) {
            currentElement = null;
            events.fire('current.changed', { type: 'group' });
            logCurrentState();
            return;
        }
        // Shape selected
        if (shapeSelection) {
            if (currentElement !== shapeSelection) {
                currentElement = shapeSelection;
                events.fire('current.changed', { type: 'shape', element: shapeSelection });
            }
            logCurrentState();
            return;
        }
        // Splat selected
        if (splatSelection) {
            if (currentElement !== splatSelection) {
                currentElement = splatSelection;
                events.fire('current.changed', { type: 'splat', element: splatSelection });
            }
            logCurrentState();
            return;
        }
        // Nothing selected
        if (currentElement !== null) {
            currentElement = null;
            events.fire('current.changed', null);
        }
        logCurrentState();
    };

    events.on('selection', (element: Element | null) => {
        lastClicked = element;
        if (element instanceof Splat) {
            // Clear shape so the splat can become current (shape always takes
            // priority over splat when both coexist in transform handler).
            setShapeSelection(null);
            setSplatSelection(element);
        } else if (isShape(element)) {
            // Keep splat selected (grey) — only shape becomes current (orange).
            setShapeSelection(element);
        } else if (element === null) {
            setSplatSelection(null);
            setShapeSelection(null);
        }
    });

    events.on('selection.clearSplat', () => {
        setSplatSelection(null);
        multiSplatSelection.clear();
        events.fire('multiSplatSelection.changed');
    });

    events.on('selection.clearShape', () => {
        setShapeSelection(null);
        // If a splat is still selected, switch lastSelected and fire
        // selection.changed so the transform handler updates the pivot
        // and gizmo to the splat's position.
        if (splatSelection) {
            lastSelected = 'splat';
            events.fire('selection.changed', splatSelection, null);
        }
    });

    events.function('selection', () => {
        return getSelection();
    });

    events.function('splatSelection', () => {
        return splatSelection;
    });

    events.function('shapeSelection', () => {
        return shapeSelection;
    });

    // Multi-splat selection functions
    events.function('multiSplatSelection', () => {
        return Array.from(multiSplatSelection);
    });

    events.function('multiSplatSelection.count', () => {
        return multiSplatSelection.size;
    });

    // Toggle a splat in the multi-selection (Ctrl+click)
    events.on('selection.toggleSplat', (splat: Splat) => {
        // If multi-selection is empty but there's a current splat selection,
        // add the current selection to multi-selection first
        if (multiSplatSelection.size === 0 && splatSelection instanceof Splat && splatSelection !== splat) {
            multiSplatSelection.add(splatSelection);
        }

        if (multiSplatSelection.has(splat)) {
            // If this is the only item left, just clear everything
            if (multiSplatSelection.size === 1) {
                multiSplatSelection.clear();
                setSplatSelection(null);
            } else {
                multiSplatSelection.delete(splat);
                // Keep primary selection on the last added splat
                const remaining = Array.from(multiSplatSelection);
                setSplatSelection(remaining[remaining.length - 1]);
            }
        } else {
            multiSplatSelection.add(splat);
            setSplatSelection(splat);
        }
        events.fire('multiSplatSelection.changed');
    });

    // Add a splat to the multi-selection without toggling
    events.on('selection.addSplat', (splat: Splat) => {
        multiSplatSelection.add(splat);
        setSplatSelection(splat);
        events.fire('multiSplatSelection.changed');
    });

    // Add a range of splats to the multi-selection (Ctrl+drag / Shift+click)
    events.on('selection.addSplatRange', (fromSplat: Splat, toSplat: Splat) => {
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        const fromIdx = splats.indexOf(fromSplat);
        const toIdx = splats.indexOf(toSplat);
        if (fromIdx >= 0 && toIdx >= 0) {
            const start = Math.min(fromIdx, toIdx);
            const end = Math.max(fromIdx, toIdx);
            for (let i = start; i <= end; i++) {
                if (splats[i].visible) {
                    multiSplatSelection.add(splats[i]);
                }
            }
            setSplatSelection(toSplat);
            events.fire('multiSplatSelection.changed');
        }
    });

    // Clear multi-selection
    events.on('selection.clearMultiSplat', () => {
        multiSplatSelection.clear();
        events.fire('multiSplatSelection.changed');
    });

    events.on('selection.next', () => {
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        if (splats.length > 1) {
            const idx = splats.indexOf(splatSelection as Splat);
            setSplatSelection(splats[(idx + 1) % splats.length]);
        }
    });

    events.on('scene.elementAdded', (element: Element) => {
        if (element.type === ElementType.splat) {
            // Clear multi-selection and select the newly added splat
            multiSplatSelection.clear();
            setSplatSelection(element as Splat);
            events.fire('multiSplatSelection.changed');
        } else if (isShape(element)) {
            setShapeSelection(element);
        }
    });

    events.on('scene.elementRemoved', (element: Element) => {
        if (element === splatSelection) {
            const splats = scene.getElementsByType(ElementType.splat) as Splat[];
            setSplatSelection(splats.find(v => v !== element) ?? null);
        }
        if (element instanceof Splat && multiSplatSelection.has(element)) {
            multiSplatSelection.delete(element);
            events.fire('multiSplatSelection.changed');
        }
        if (element === shapeSelection) {
            const shapes = scene.getElementsByType(ElementType.debug);
            const filtered = shapes.filter(s => isShape(s));
            setShapeSelection(filtered.length === 0 ? null : filtered.find(v => v !== element) ?? null);
        }
    });

    events.on('splat.visibility', (splat: Splat) => {
        if (splat === splatSelection && !splat.visible) {
            setSplatSelection(null);
        }
        if (multiSplatSelection.has(splat) && !splat.visible) {
            multiSplatSelection.delete(splat);
            events.fire('multiSplatSelection.changed');
        }
    });

    events.on('camera.focalPointPicked', (details: { splat: Splat }) => {
        setSplatSelection(details.splat);
    });

    // Recompute current when gaussian selection changes
    // (e.g. selecting gaussians in a group makes the group "current")
    events.on('splat.stateChanged', () => {
        computeCurrent();
    });
};

export { registerSelectionEvents };
