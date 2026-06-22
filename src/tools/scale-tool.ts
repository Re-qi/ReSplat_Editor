import { ScaleGizmo } from 'playcanvas';

import { TransformTool } from './transform-tool';
import { Events } from '../events';
import { Scene } from '../scene';
import { BoxShape } from '../box-shape';
import { BlockingPlane } from '../blocking-plane';
import { SphereShape } from '../sphere-shape';
import { Splat } from '../splat';

class ScaleTool extends TransformTool {
    constructor(events: Events, scene: Scene) {
        const gizmo = new ScaleGizmo(scene.camera.camera, scene.gizmoLayer);

        // set lower bound on scale
        gizmo.lowerBoundScale.set(1e-6, 1e-6, 1e-6);

        const nonUniformAxes = ['x', 'y', 'z', 'yz', 'xz', 'xy'] as const;

        // Force local coordinate space for BlockingPlane
        const forceLocalCoordSpace = () => {
            const shapeSel = events.invoke('shapeSelection');
            if (shapeSel instanceof BlockingPlane) {
                (gizmo as any)._coordSpace = 'local';
                (gizmo as any)._updateRotation();
            }
        };

        const updateScaleShapes = () => {
            const shapeSel = events.invoke('shapeSelection');
            const isShape = shapeSel instanceof BoxShape || shapeSel instanceof SphereShape || shapeSel instanceof BlockingPlane;
            const splatSel = events.invoke('splatSelection');
            const isSplat = splatSel instanceof Splat;
            nonUniformAxes.forEach((axis) => {
                gizmo.enableShape(axis, isShape || isSplat);
            });
            // Force local coord space for BlockingPlane
            forceLocalCoordSpace();
        };

        // update when selection changes
        events.on('selection.changed', updateScaleShapes);
        events.on('selection.shapeChanged', updateScaleShapes);

        // Override coord space change for BlockingPlane
        events.on('tool.coordSpace', () => {
            // Wait for the base class to handle it, then override if needed
            setTimeout(forceLocalCoordSpace, 0);
        });

        super(gizmo, events, scene);
    }
}

export { ScaleTool };
