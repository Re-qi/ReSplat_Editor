// Ported from NanoGS (https://github.com/RongLiu-Leo/NanoGS) — CC BY-NC 4.0.
// Public entry for the NanoGS TypeScript port. See src/nanogs/README.md for
// attribution and license. This code is NOT released under the project CC BY 4.0
// license; it remains under CC BY-NC 4.0 (NonCommercial). Commercial use
// requires a separate license from NanoGS authors.

export type { RunParams, CostParams } from './params';
export type { SplatAttrs, SimplifyOpts } from './simplify';
export {
    simplifyNode,
    simplifyProgressive,
    simplify,
    defaultSimplifyOpts,
    NANOGS_NODE_CAP,
    NANOGS_NODE_MIN,
    knnUndirectedEdges,
    edgeCosts,
    greedyPairsFromEdges,
    pruneByOpacity
} from './simplify';
export { momentMatching, mergePairs } from './merge';
export type { ColumnLookup, NativeSimplifyFn, NativeSimplifyResult } from './lcc-glue';
export {
    nodeAttrsFromColumns,
    nodeAttrsToColumns,
    simplifyNodeBatched,
    partitionSpatially,
    setNativeImpl,
    getNativeImpl
} from './lcc-glue';
export { fullCostPairs } from './cost';
export { knnIndices } from './knn';
