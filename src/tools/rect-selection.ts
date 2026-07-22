import { Events } from '../events';

class RectSelection {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, parent: HTMLElement) {
        // create svg
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('tool-svg', 'hidden');
        svg.id = 'rect-select-svg';
        parent.appendChild(svg);

        // create rect element
        const rect = document.createElementNS(svg.namespaceURI, 'rect') as SVGRectElement;
        svg.appendChild(rect);

        const start = { x: 0, y: 0 };
        const end = { x: 0, y: 0 };
        let dragId: number | undefined;
        let dragMoved = false;

        const updateRect = () => {
            const x = Math.min(start.x, end.x);
            const y = Math.min(start.y, end.y);
            const width = Math.abs(start.x - end.x);
            const height = Math.abs(start.y - end.y);

            rect.setAttribute('x', x.toString());
            rect.setAttribute('y', y.toString());
            rect.setAttribute('width', width.toString());
            rect.setAttribute('height', height.toString());
        };

        const getPos = (e: PointerEvent) => {
            const rect = parent.getBoundingClientRect();
            let x = e.clientX - rect.left;
            let y = e.clientY - rect.top;
            // Compensate for CSS zoom on the tools container
            // (ZoomManager applies counter-zoom to cancel browser zoom)
            if (rect.width > 0 && rect.height > 0) {
                x *= parent.offsetWidth / rect.width;
                y *= parent.offsetHeight / rect.height;
            }
            return { x, y };
        };

        const pointerdown = (e: PointerEvent) => {
            if (dragId === undefined && (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary)) {
                e.preventDefault();
                e.stopPropagation();

                dragId = e.pointerId;
                dragMoved = false;
                parent.setPointerCapture(dragId);

                const pos = getPos(e);
                start.x = end.x = pos.x;
                start.y = end.y = pos.y;

                updateRect();

                svg.classList.remove('hidden');
            }
        };

        const pointermove = (e: PointerEvent) => {
            if (e.pointerId === dragId) {
                e.preventDefault();
                e.stopPropagation();

                dragMoved = true;
                const pos = getPos(e);
                end.x = pos.x;
                end.y = pos.y;

                updateRect();
            }
        };

        const dragEnd = () => {
            parent.releasePointerCapture(dragId);
            dragId = undefined;
            svg.classList.add('hidden');
        };

        const pointerup = async (e: PointerEvent) => {
            if (e.pointerId === dragId) {
                e.preventDefault();
                e.stopPropagation();

                const w = parent.clientWidth;
                const h = parent.clientHeight;

                if (dragMoved) {
                    // rect select - wait for selection to complete before hiding rect
                    await events.invoke(
                        'select.rect',
                        e.shiftKey ? 'add' : (e.ctrlKey ? 'remove' : 'set'), {
                            start: { x: Math.min(start.x, end.x) / w, y: Math.min(start.y, end.y) / h },
                            end: { x: Math.max(start.x, end.x) / w, y: Math.max(start.y, end.y) / h }
                        });
                } else {
                    // pick - wait for selection to complete before hiding rect
                    const pos = getPos(e);
                    await events.invoke(
                        'select.point',
                        e.shiftKey ? 'add' : (e.ctrlKey ? 'remove' : 'set'),
                        { x: pos.x / parent.clientWidth, y: pos.y / parent.clientHeight }
                    );
                }

                dragEnd();
            }
        };

        this.activate = () => {
            parent.style.display = 'block';
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
        };

        this.deactivate = () => {
            if (dragId !== undefined) {
                dragEnd();
            }
            parent.style.display = 'none';
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
        };
    }

    destroy() {

    }
}

export { RectSelection };
