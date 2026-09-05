type PaintParameterAdjustmentAxis = 'horizontal' | 'vertical';

const paintParameterAdjustment = (
    startX: number,
    startY: number,
    clientX: number,
    clientY: number,
    lockedAxis: PaintParameterAdjustmentAxis | null,
    axisLockThreshold = 3
) => {
    const horizontal = clientX - startX;
    const vertical = startY - clientY;
    const axis = lockedAxis ?? (
        Math.max(Math.abs(horizontal), Math.abs(vertical)) >= axisLockThreshold ?
            (Math.abs(horizontal) >= Math.abs(vertical) ? 'horizontal' : 'vertical') : null
    );

    return {
        axis,
        delta: axis === 'horizontal' ? horizontal : (axis === 'vertical' ? vertical : 0)
    };
};

export { PaintParameterAdjustmentAxis, paintParameterAdjustment };
