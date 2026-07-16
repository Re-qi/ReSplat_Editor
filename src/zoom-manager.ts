/**
 * UI Zoom Manager
 *
 * Implements Ctrl+MouseWheel zoom for UI elements using the browser's
 * native zoom factor (via Electron's webContents.setZoomFactor).
 * The 3D viewport (#canvas, #tools-container) is counter-zoomed so
 * it remains visually unaffected.
 */

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.05;
const DEFAULT_ZOOM = 1.0;

// Elements that belong to the 3D viewport and should NOT trigger UI zoom
const VIEWPORT_SELECTORS = ['#canvas', '#tools-container'];

class ZoomManager {
    private currentZoom: number = DEFAULT_ZOOM;
    private wheelHandler: ((e: WheelEvent) => void) | null = null;

    constructor() {
        if (!this.isElectron()) return;
        this.init();
    }

    private isElectron(): boolean {
        return (window as any).electronAPI?.isElectron === true;
    }

    private async init() {
        try {
            this.currentZoom = await (window as any).electronAPI.getZoomFactor();
        } catch (_e) {
            this.currentZoom = DEFAULT_ZOOM;
        }

        this.updateViewportCompensation();
        this.attachListeners();
    }

    /** Check if an element belongs to the 3D viewport area */
    private isViewportElement(target: HTMLElement): boolean {
        for (const selector of VIEWPORT_SELECTORS) {
            const el = document.querySelector(selector) as HTMLElement | null;
            if (el && (target === el || el.contains(target))) {
                return true;
            }
        }
        return false;
    }

    private handleWheel = (e: WheelEvent) => {
        // Require Ctrl key (not Meta/Cmd alone)
        if (!e.ctrlKey && !e.metaKey) return;

        // Skip text input fields (user is typing, not zooming UI)
        const target = e.target as HTMLElement;
        if (target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target instanceof HTMLSelectElement) {
            return;
        }

        // Skip if the mouse is over the 3D viewport (canvas or tools overlay)
        if (this.isViewportElement(target)) return;

        e.preventDefault();
        e.stopPropagation();

        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.currentZoom + delta));

        if (newZoom !== this.currentZoom) {
            this.currentZoom = newZoom;
            this.applyZoom();
        }
    };

    private handleKeyDown = (e: KeyboardEvent) => {
        // Ctrl+0 resets zoom to default — prevent browser default to stay in sync
        if ((e.ctrlKey || e.metaKey) && e.key === '0') {
            const target = e.target as HTMLElement;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

            e.preventDefault();
            if (this.currentZoom !== DEFAULT_ZOOM) {
                this.currentZoom = DEFAULT_ZOOM;
                this.applyZoom();
            }
        }
    };

    private async applyZoom() {
        try {
            await (window as any).electronAPI.setZoomFactor(this.currentZoom);
        } catch (_e) {
            // Fallback: if IPC fails, apply CSS zoom directly
            document.documentElement.style.setProperty('--ui-zoom', String(this.currentZoom));
        }
        this.updateViewportCompensation();
    }

    /** Counter-zoom the canvas and tools overlay to cancel out the browser zoom */
    private updateViewportCompensation() {
        const inverseZoom = 1 / this.currentZoom;
        for (const selector of VIEWPORT_SELECTORS) {
            const el = document.querySelector(selector) as HTMLElement | null;
            if (el) {
                el.style.zoom = String(inverseZoom);
            }
        }
    }

    private attachListeners() {
        // Capture phase: intercept before other handlers (e.g. PCUI sliders
        // that call stopPropagation) so we always see the event first.
        this.wheelHandler = this.handleWheel;
        document.addEventListener('wheel', this.wheelHandler, { passive: false, capture: true });

        // Keydown for Ctrl+0 reset
        document.addEventListener('keydown', this.handleKeyDown, true);
    }

    destroy() {
        if (this.wheelHandler) {
            document.removeEventListener('wheel', this.wheelHandler, { capture: true });
            this.wheelHandler = null;
        }
        document.removeEventListener('keydown', this.handleKeyDown, true);

        // Reset viewport compensation
        for (const selector of VIEWPORT_SELECTORS) {
            const el = document.querySelector(selector) as HTMLElement | null;
            if (el) {
                el.style.zoom = '';
            }
        }
    }
}

export { ZoomManager };
