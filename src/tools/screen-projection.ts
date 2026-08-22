import { Vec3 } from 'playcanvas';

import { Camera } from '../camera';

const direction = new Vec3();

const cameraDepth = (camera: Camera, point: Vec3) => {
    direction.sub2(point, camera.position);
    return direction.dot(camera.forward);
};

/**
 * Project an overlay point only when it is in front of the camera's near
 * plane. Perspective division is not meaningful for points behind the
 * camera: their projected coordinates are mirrored to the other side of the
 * viewport, which makes SVG tool markers jump when they leave the viewport.
 */
const projectPoint = (camera: Camera, point: Vec3, screen: Vec3) => {
    if (cameraDepth(camera, point) <= camera.near) {
        return false;
    }

    camera.worldToScreen(point, screen);
    return Number.isFinite(screen.x) && Number.isFinite(screen.y);
};

/**
 * Project a line, clipping it against the camera near plane first. This keeps
 * a measurement/orientation line stable when one endpoint moves behind the
 * camera while still allowing endpoints outside the left/right/top/bottom of
 * the screen (SVG will clip those naturally).
 */
const projectLine = (camera: Camera, start: Vec3, end: Vec3, screenStart: Vec3, screenEnd: Vec3) => {
    const near = camera.near;
    let startDepth = cameraDepth(camera, start);
    let endDepth = cameraDepth(camera, end);

    if (startDepth <= near && endDepth <= near) {
        return false;
    }

    if (startDepth <= near) {
        const t = (near - startDepth) / (endDepth - startDepth);
        start.lerp(start, end, t);
        startDepth = near;
    } else if (endDepth <= near) {
        const t = (near - startDepth) / (endDepth - startDepth);
        end.lerp(start, end, t);
        endDepth = near;
    }

    // Keep the clipped point just inside the frustum. Some projection
    // matrices produce unstable screen values exactly on the near plane.
    if (startDepth === near) {
        direction.sub2(start, camera.position).normalize();
        start.copy(camera.position).add(direction.mulScalar(near * 1.000001));
    }
    if (endDepth === near) {
        direction.sub2(end, camera.position).normalize();
        end.copy(camera.position).add(direction.mulScalar(near * 1.000001));
    }

    return projectPoint(camera, start, screenStart) && projectPoint(camera, end, screenEnd);
};

export { projectLine, projectPoint };
