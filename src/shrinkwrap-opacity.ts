// A dense shrinkwrapped image has many overlapping Gaussian footprints. Treat
// the slider as the desired composite opacity and invert alpha compositing to
// obtain the lower per-Gaussian opacity needed for a perceptually useful range.
const shrinkwrapOpacityLayers = 12;

const shrinkwrapSplatOpacity = (compositeOpacity: number) => {
    const desired = Math.min(0.9999, Math.max(0, compositeOpacity));
    return 1 - Math.pow(1 - desired, 1 / shrinkwrapOpacityLayers);
};

export { shrinkwrapOpacityLayers, shrinkwrapSplatOpacity };
