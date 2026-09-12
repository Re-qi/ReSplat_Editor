# NanoGS — TypeScript Port (Adapted Material)

This directory contains a **TypeScript port** of the [NanoGS](https://github.com/RongLiu-Leo/NanoGS)
algorithm ("Training-Free Gaussian Splat Simplification"), used by ReSplat's
LCC2 multi-LOD export to replace uniform-stride subsampling with quality-preserving
greedy merge simplification.

## ⚠️ License — CC BY-NC 4.0

The code in this directory is **Adapted Material** derived from NanoGS, which is
licensed under **Creative Commons Attribution-NonCommercial 4.0 International
(CC BY-NC 4.0)**. The full license text is in [`LICENSE-NANOGS.txt`](./LICENSE-NANOGS.txt).

> **This directory's code is NOT released under the project's CC BY 4.0 license.**
> It remains under CC BY-NC 4.0. The NonCommercial (NC) restriction applies:
> it may not be used for purposes primarily directed towards commercial
> advantage or monetary compensation. For any commercial use, a separate
> commercial license must be obtained from the NanoGS authors.

### Attribution

- **Creators / Rights holders:** Butian Xiong, Rong Liu, Tiantian Zhou, Meida Chen,
  Zhiwen Fan, Andrew Feng.
- **Original source:** https://github.com/RongLiu-Leo/NanoGS
- **License:** CC BY-NC 4.0 — https://creativecommons.org/licenses/by-nc/4.0/
- **Paper:** "NanoGS: Training-Free Gaussian Splat Simplification", arXiv:2603.16103
  — https://arxiv.org/abs/2603.16103

### Modifications

This TypeScript port modifies the original Python implementation as follows:

1. **Language:** Translated from Python (numpy / scipy) to TypeScript using
   `Float32Array` / typed arrays. See per-file headers for the original Python
   source each file corresponds to.
2. **KNN:** Replaced `scipy.spatial.cKDTree` with a self-contained 3D KD-tree
   implementation (`knn.ts`).
3. **Linear algebra:** Replaced numpy batch ops with hand-written typed-array
   kernels; the 3×3 symmetric eigendecomposition (originally `numpy.linalg.eigh`)
   uses a closed-form / Jacobi solver.
4. **Multi-LOD extension:** Added `simplifyProgressive` / `simplifyNode` in
   `simplify.ts` to emit multiple ratio-snapshot LOD levels from a single merge
   pass (original only produced a single simplified output). The core
   `full_cost_pairs` / `moment_matching` / greedy-pair logic is preserved.
5. **Opacity pruning:** Skipped at the per-node entry point (`simplifyNode`)
   because source PLY data is already validated; the original `prune_by_opacity`
   is retained in `simplify.ts` for parity with the reference CLI path.

The algorithmic behavior (cost function, moment-matching merge, greedy disjoint
pair selection) is intentionally preserved for numerical parity with the
reference. Any further modifications should be recorded here.

## Citation

```bibtex
@misc{xiong2026nanogstrainingfreegaussiansplat,
    title={NanoGS: Training-Free Gaussian Splat Simplification},
    author={Butian Xiong and Rong Liu and Tiantian Zhou and Meida Chen and Zhiwen Fan and Andrew Feng},
    year={2026},
    eprint={2603.16103},
    archivePrefix={arXiv},
    primaryClass={cs.CV},
    url={https://arxiv.org/abs/2603.16103}
}
```

## Files

| File | Original Python source |
|---|---|
| `params.ts` | `src/nanogs/utils/params.py` |
| `splat-utils.ts` | `src/nanogs/utils/splat_utils.py` |
| `cost.ts` | `src/nanogs/utils/cost.py` (`full_cost_pairs`) |
| `merge.ts` | `src/nanogs/utils/merge.py` |
| `knn.ts` | replaces `scipy.spatial.cKDTree` usage in `simplification.py` |
| `simplify.ts` | `src/nanogs/simplification.py` (+ multi-LOD extension) |
