// Ported from NanoGS (https://github.com/RongLiu-Leo/NanoGS) — CC BY-NC 4.0.
// Original: src/nanogs/utils/params.py
// See src/nanogs/README.md for attribution and license. This file is NOT
// released under the project CC BY 4.0 license; it remains under CC BY-NC 4.0
// (NonCommercial). Commercial use requires a separate license from NanoGS authors.

// Run-time parameters for the simplification loop. Mirrors RunParams in params.py.
export interface RunParams {
    // Fraction of splats to keep, in (0, 1). Original uses this as the target
    // ratio against the pre-prune splat count.
    ratio: number;
    // Max merges per pass as a ratio of the original splat count (0.01–0.5).
    mergeCap: number;
    // k for KNN candidates.
    k: number;
    // Prune splats with opacity below this before merging.
    opacityThreshold: number;
}

// Cost-function parameters. Mirrors CostParams in params.py, with the optional
// knobs that full_cost_pairs reads via getattr.
export interface CostParams {
    // Geometry term weight in merge cost.
    lamGeo: number;
    // Spherical-harmonics term weight in merge cost.
    lamSh: number;
    // Number of deterministic MC samples (defaults to 1, matching Python).
    nMc?: number;
    // RNG seed for the deterministic MC samples (defaults to 0).
    seed?: number;
    // Scalar variance jitter to keep covariances SPD (defaults to 1e-8).
    epsCov?: number;
}

export const defaultCostParams = (overrides: Partial<CostParams> = {}): CostParams => ({
    lamGeo: 1.0,
    lamSh: 1.0,
    nMc: 1,
    seed: 0,
    epsCov: 1e-8,
    ...overrides
});

export const defaultRunParams = (overrides: Partial<RunParams> = {}): RunParams => ({
    ratio: 0.5,
    mergeCap: 0.5,
    k: 16,
    opacityThreshold: 0.1,
    ...overrides
});
