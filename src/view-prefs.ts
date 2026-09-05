import { Color } from 'playcanvas';

import { Events } from './events';

const STORAGE_KEY = 'resplat-view-prefs';

// read preferences from localStorage
const loadViewPrefs = (): Record<string, any> | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
};

// write preferences to localStorage
const saveViewPrefs = (prefs: Record<string, any>): void => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
        // quota exceeded, silently ignore
    }
};

// pack Color to number array
const packC = (c: Color) => [c.r, c.g, c.b, c.a];

// collect all current view prefs from the editor state
const collectViewPrefs = (events: Events): Record<string, any> => {
    return {
        bgColor: packC(events.invoke('bgClr')),
        selectedColor: packC(events.invoke('selectedClr')),
        unselectedColor: packC(events.invoke('unselectedClr')),
        lockedColor: packC(events.invoke('lockedClr')),
        tonemapping: events.invoke('camera.tonemapping'),
        fov: events.invoke('camera.fov'),
        fovDolly: events.invoke('camera.fovDolly'),
        shBands: events.invoke('view.bands'),
        flySpeed: events.invoke('camera.flySpeed'),
        centersSize: events.invoke('camera.splatSize'),
        centersUseGaussianColor: events.invoke('view.centersUseGaussianColor'),
        outlineSelection: events.invoke('view.outlineSelection'),
        gridPlane: events.invoke('grid.plane'),
        showBoundDimensions: events.invoke('camera.boundDimensions'),
        showCameraPoses: events.invoke('camera.showPoses')
    };
};

// apply saved preferences to the editor via events
const applyViewPrefs = (events: Events, prefs: Record<string, any>): void => {
    if (prefs.bgColor) {
        events.fire('setBgClr', new Color(prefs.bgColor[0], prefs.bgColor[1], prefs.bgColor[2]));
    }
    if (prefs.selectedColor) {
        // restore user-set alpha if it was saved as 0 (G-pressed presentation mode)
        const alpha = prefs.selectedColor[3] || 1;
        events.fire('setSelectedClr', new Color(prefs.selectedColor[0], prefs.selectedColor[1], prefs.selectedColor[2], alpha));
    }
    if (prefs.unselectedColor) {
        events.fire('setUnselectedClr', new Color(prefs.unselectedColor[0], prefs.unselectedColor[1], prefs.unselectedColor[2], prefs.unselectedColor[3]));
    }
    if (prefs.lockedColor) {
        events.fire('setLockedClr', new Color(prefs.lockedColor[0], prefs.lockedColor[1], prefs.lockedColor[2], prefs.lockedColor[3]));
    }
    if (prefs.tonemapping !== undefined) {
        events.fire('camera.setTonemapping', prefs.tonemapping);
    }
    if (prefs.fovDolly !== undefined) {
        events.fire('camera.setFovDolly', prefs.fovDolly);
    }
    if (prefs.fov !== undefined) {
        events.fire('camera.setFov', prefs.fov);
    }
    if (prefs.shBands !== undefined) {
        events.fire('view.setBands', prefs.shBands);
    }
    if (prefs.flySpeed !== undefined) {
        events.fire('camera.setFlySpeed', prefs.flySpeed);
    }
    if (prefs.centersSize !== undefined) {
        events.fire('camera.setSplatSize', prefs.centersSize);
    }
    if (prefs.centersUseGaussianColor !== undefined) {
        events.fire('view.setCentersUseGaussianColor', prefs.centersUseGaussianColor);
    }
    if (prefs.outlineSelection !== undefined) {
        events.fire('view.setOutlineSelection', prefs.outlineSelection);
    }
    if (prefs.gridPlane === 'xz' || prefs.gridPlane === 'xy' || prefs.gridPlane === 'yz') {
        events.fire('grid.setPlane', prefs.gridPlane);
    }
    if (prefs.showBoundDimensions !== undefined) {
        events.fire('camera.setBoundDimensions', prefs.showBoundDimensions);
    }
    if (prefs.showCameraPoses !== undefined) {
        events.fire('camera.setShowPoses', prefs.showCameraPoses);
    }
};

export { loadViewPrefs, saveViewPrefs, collectViewPrefs, applyViewPrefs };
