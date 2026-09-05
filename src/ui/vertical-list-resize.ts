interface VerticalListResizeOptions {
    disableWhenEmpty?: boolean;
    minHeight?: number;
    maxHeight?: number;
}

const addVerticalListResizeHandle = (
    list: HTMLElement,
    { disableWhenEmpty = false, minHeight, maxHeight = window.innerHeight }: VerticalListResizeOptions = {}
) => {
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'vertical-list-resize-handle';
    resizeHandle.setAttribute('aria-hidden', 'true');
    list.insertAdjacentElement('afterend', resizeHandle);

    let activePointerId: number | null = null;
    let startY = 0;
    let startHeight = 0;

    const stopResizing = () => {
        if (activePointerId === null) return;

        const pointerId = activePointerId;
        activePointerId = null;
        document.documentElement.classList.remove('vertical-list-resizing');

        if (resizeHandle.hasPointerCapture(pointerId)) {
            resizeHandle.releasePointerCapture(pointerId);
        }
    };

    resizeHandle.addEventListener('pointerdown', (event: PointerEvent) => {
        if (!event.isPrimary || event.button !== 0) return;

        activePointerId = event.pointerId;
        startY = event.clientY;
        startHeight = list.getBoundingClientRect().height;
        resizeHandle.setPointerCapture(event.pointerId);
        document.documentElement.classList.add('vertical-list-resizing');
        event.preventDefault();
    });

    resizeHandle.addEventListener('pointermove', (event: PointerEvent) => {
        if (activePointerId === null) return;

        const computedMinHeight = Number.parseFloat(getComputedStyle(list).minHeight);
        const resolvedMinHeight = minHeight ?? Math.max(24, Number.isFinite(computedMinHeight) ? computedMinHeight : 0);
        const newHeight = Math.max(
            resolvedMinHeight,
            Math.min(maxHeight, startHeight + event.clientY - startY)
        );

        list.style.height = `${newHeight}px`;
        list.style.maxHeight = 'none';
    });

    resizeHandle.addEventListener('pointerup', stopResizing);
    resizeHandle.addEventListener('pointercancel', stopResizing);
    resizeHandle.addEventListener('lostpointercapture', stopResizing);

    if (disableWhenEmpty) {
        const syncEmptyState = () => {
            const empty = list.childElementCount === 0;
            resizeHandle.hidden = empty;

            if (empty) {
                stopResizing();
                list.style.removeProperty('height');
                list.style.removeProperty('max-height');
            }
        };

        new MutationObserver(syncEmptyState).observe(list, { childList: true });
        syncEmptyState();
    }
};

export { addVerticalListResizeHandle };
