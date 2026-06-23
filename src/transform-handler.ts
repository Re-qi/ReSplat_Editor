import { Element } from './element';
import { EntityTransformHandler } from './entity-transform-handler';
import { Events } from './events';
import { registerPivotEvents } from './pivot';
import { Splat } from './splat';
import { SplatsTransformHandler } from './splats-transform-handler';

interface TransformHandler {
    activate: () => void;
    deactivate: () => void;
}

const registerTransformHandlerEvents = (events: Events) => {
    const transformHandlers: TransformHandler[] = [];

    const push = (handler: TransformHandler) => {
        if (transformHandlers.length > 0) {
            const transformHandler = transformHandlers[transformHandlers.length - 1];
            transformHandler.deactivate();
        }
        transformHandlers.push(handler);
        handler.activate();
    };

    const pop = () => {
        if (transformHandlers.length > 0) {
            const transformHandler = transformHandlers.pop();
            transformHandler.deactivate();
        }
        if (transformHandlers.length > 0) {
            const transformHandler = transformHandlers[transformHandlers.length - 1];
            transformHandler.activate();
        }
    };

    // bind transform target when selection changes
    const entityTransformHandler = new EntityTransformHandler(events);
    const splatsTransformHandler = new SplatsTransformHandler(events);

    const update = (element: Element | null) => {
        pop();
        if (element) {
            // Check shape selection first: if a shape is selected, always use entity handler
            // (moving the wrapper/blocking-plane itself, never the gaussians inside)
            const shapeSel = events.invoke('shapeSelection') as Element | null;
            if (shapeSel) {
                push(entityTransformHandler);
                return;
            }

            // Only move individual gaussians when a point cloud group is explicitly
            // active (user has selected a group item). Otherwise, treat the splat as a
            // single entity — clicking on a splat-item moves the entire file.
            const splatSel = events.invoke('splatSelection') as Element | null;
            if (splatSel instanceof Splat && splatSel.numSelected > 0 && events.invoke('pointCloudGroup.activeGroup')) {
                push(splatsTransformHandler);
            } else {
                push(entityTransformHandler);
            }
        } else {
            // splat was cleared — fall back to shape selection if present
            const shapeSel = events.invoke('shapeSelection') as Element | null;
            if (shapeSel) {
                push(entityTransformHandler);
            }
        }
    };

    events.on('selection.changed', update);
    events.on('selection.shapeChanged', update);
    events.on('splat.stateChanged', update);

    events.on('transformHandler.push', (handler: TransformHandler) => {
        push(handler);
    });

    events.on('transformHandler.pop', () => {
        pop();
    });

    registerPivotEvents(events);
};

export { registerTransformHandlerEvents, TransformHandler };
