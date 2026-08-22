# Debug Session: browser-import-lag

**状态**: [CLOSED]
**创建时间**: 2026-08-08
**症状**: 浏览器导入任何高斯文件后持续卡顿（FPS 低）；Electron 正常
**复现步骤**: 打开浏览器版应用 → 导入高斯文件 → 旋转/缩放相机 → 持续卡顿

## 环境
- OS: Windows
- 浏览器: (待用户确认)
- 应用: ReSplat (supersplat-2.27.0 base, PlayCanvas 2.18.2)
- Electron 正常, 浏览器卡顿

## 结论 (2026-08-08 实测)

**根因（最终确认）：Trae CN 的 GPU 进程强制 `--use-angle=swiftshader-webgl`，导致内置浏览器所有 WebGL（含 ReSplat）走 SwiftShader 纯软件渲染，比硬件慢约 40 倍。非应用逻辑/版本问题。**

证据：
- 控制台日志（Trae 内置浏览器）：`[ReSplat] WebGL renderer: ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)`
- Trae CN GPU 进程命令行：`--type=gpu-process ... --use-gl=angle --use-angle=swiftshader-webgl`（应用内置，argv.json/快捷方式均无此配置）
- TRAE SOLO CN GPU 进程**无** swiftshader 参数 → 硬件加速，不卡
- `c:\Users\123\.trae-cn\argv.json` 无 `disable-hardware-acceleration`

**实测（同一 release 构建、50k 合成高斯）**：
| 渲染环境 | 渲染器 | 导入后帧耗时 |
|---|---|---|
| Edge 硬件 GL | NVIDIA RTX 5060 Ti D3D11 | 17.6ms (57fps) |
| 强制软件 GL (模拟 Trae 内置浏览器) | SwiftShader (Subzero) | **3776ms (0.3fps)** |

- 空闲时 60fps、renderNextFrame=false、sorter worker 健康（1-2ms）、无内存压力 → 假设 A/B/D/E 均排除。
- 旧版 1.2.4（备份）与新版 1.2.7 帧耗时几乎一致 → 非版本回归。

### 建议
- 交互式编辑请使用 **Edge 浏览器 / Electron**（硬件加速）。
- Trae 内置浏览器因内置 swiftshader-webgl 参数无法用于 GPU 重负载应用。

### 已实施修复 (2026-08-08)
在 `src/main.ts` 启动时检测 WebGL 渲染器（`WEBGL_debug_renderer_info`）：
- 检测到软件渲染（SwiftShader/llvmpipe）→ 控制台输出 + 弹窗提示"开启硬件加速或改用 Edge/Electron"。
- 注：曾尝试自动 `pixelScale=2` 降分辨率，用户反馈视口变糊且对软件渲染帮助有限，**已撤销**，仅保留检测+提示。
- 新增 locale 键：`popup.software-rendering.title/message`（en/zh-CN）。

### 说明
- 当前 dist 已用 `npm run build` 重建为 release（之前是 develop 的 debug 引擎构建 playcanvas.dbg）。
- 临时调试文件（scripts/diag-*.cjs、.diag-edge-profile、%TEMP%\resplat-temp\diag_*.ply）已清理。
