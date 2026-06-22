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
        }
    };

    const setShapeSelection = (element: Element | null) => {
        if (!element || element.visible) {
            const prev = shapeSelection;
            shapeSelection = element;
            if (element) lastSelected = 'shape';
            events.fire('selection.shapeChanged', shapeSelection, prev);
        }
    };

    events.on('selection', (element: Element | null) => {
        if (element instanceof Splat) {
            setSplatSelection(element);
        } else if (isShape(element)) {
            setShapeSelection(element);
        } else if (element === null) {
            // Clear both
            setSplatSelection(null);
            setShapeSelection(null);
        }
    });

    events.on('selection.clearSplat', () => {
        setSplatSelection(null);
        multiSplatSelection.clear();
        events.fire('multiSplatSelection.changed');
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
            setSplatSelection(splats.length === 1 ? null : splats.find(v => v !== element) ?? null);
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
};

export { registerSelectionEvents };
