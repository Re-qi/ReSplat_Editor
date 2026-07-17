# ReSplat Editor

> **Powered by [supersplat-2.27.0](https://github.com/playcanvas/supersplat)** — This project is a fork/rebrand of the original SuperSplat editor.

[![Github Release](https://img.shields.io/github/v/release/Re-qi/ReSplat_Editor)](https://github.com/Re-qi/ReSplat_Editor/releases)
[![License](https://img.shields.io/github/license/Re-qi/ReSplat_Editor)](https://github.com/Re-qi/ReSplat_Editor/blob/main/LICENSE)

| [在线使用](https://re-qi.github.io/ReSplat_Editor/) | [用户文档](https://developer.playcanvas.com/user-manual/gaussian-splatting/editing/ReSplat/) | [问题反馈](https://github.com/Re-qi/ReSplat_Editor/issues) |

---

## 简介

ReSplat 是一款基于 [SuperSplat](https://github.com/playcanvas/supersplat) 重构的 **3D 高斯点云编辑器**，完全运行在浏览器中，无需安装任何软件即可使用。

本项目在 SuperSplat 的基础上**重新设计了操作逻辑**，吸取了 **Blender** 与 **Unreal Engine** 的交互优点，使高斯点云的编辑体验更加直观高效。

> **语言说明**：开发者母语为中文，因此**中文界面经过完整审核与优化**，其他语言均为机器翻译、未经人工校对，欢迎社区贡献翻译改进。

---

## 相比 SuperSplat 的改进

在 SuperSplat 的基础上，ReSplat 做了以下改进：

- **操作逻辑优化**：更符合 DCC 软件用户的操作习惯，降低上手门槛
- **滚轮修复**：解决了网页缩放导致滚轮失效的 Bug
- **深度视图**：新增深度视图模式，方便查看场景纵深信息

---

## 特色功能

### 包裹体系统

ReSplat 重构了原版的选择球与选择盒，并新增了阻挡平面，三者统一称为 **包裹体（Wrapper）**。包裹体可以像 Mesh 一样进行移动、旋转、缩放变换，为点云选择提供了灵活的空间约束能力。

![包裹体](./static/images/包裹体.png)

| 包裹体 | 说明 |
|--------|------|
| **包裹球** | 球形包裹体，选择球内的高斯点云。吸管工具、填充工具、透明度选择工具、尺寸选择工具均可限定为仅操作包裹球内的点云。例如可以在大场景中精确处理树叶内部的白色噪点。 |
| **包裹盒** | 盒形包裹体，功能同包裹球，形状为立方体，适合处理规则区域内的点云。 |
| **阻挡平面** | 无限延伸的平面，可以阻挡框选工具、套索工具、多边形选择工具、画笔工具选择平面**背后**的高斯点云，实现前后遮挡关系下的精确选择。 |

### 点云组

类似于 Blender 的 **顶点组（Vertex Group）** 概念：

- 可以将当前选择的点云**保存为点云组**，方便后续快速重新选择
- 支持对点云组内的点云进行**独立移动、旋转、缩放**等变换操作
- 适用于需要反复编辑同一区域点云的工作流程

### 复制、分离、合并

为更便捷地**拼接高斯点云**而制作的全新功能，突破了 SuperSplat 原版中深度排序对操作的限制：

- **复制** — 复制选中的点云
- **分离** — 将选中的点云从当前 Splat 中分离为独立对象
- **合并** — 将多个 Splat 对象合并为一个

### 透明度选择工具 & 尺寸选择工具

基于 [GaussianSplatEditor](https://github.com/TimChen1383/GaussianSplatEditor) 分支的源码，进行了功能衍生与增强：

- **透明度选择工具** — 根据高斯点的透明度属性进行范围选择，快速筛选出半透明或低不透明度的点云
![GIF演示](./static/images/透明度选择.gif)
- **尺寸选择工具** — 根据高斯点的尺寸属性进行范围选择，定位过大或过小的异常点云
![GIF演示](./static/images/尺寸选择.gif)


### 低精度高斯修复

针对特定场景的修复功能：

- 适用于因空三（空中三角测量）受到 **GPS 屏蔽器**影响而导致坐标精度丢失的高斯文件
- 修复低浮点精度的高斯点在渲染时出现的**闪烁问题**
- 自动检测并修正精度异常的坐标数据


### 多语言支持

基于 i18next 的国际化系统，支持 9 种语言：

中文（简体） · English · 日本語 · 한국어 · Français · Deutsch · Español · Português · Русский

---

## 本地开发

> 详细配置指南请参阅 [SETUP.md](./SETUP.md)

### 环境要求

- [Node.js](https://nodejs.org/) >= 20.19.0

### 快速开始

1. 克隆仓库：

   ```sh
   git clone https://github.com/Re-qi/ReSplat_Editor.git
   cd ReSplat_Editor
   ```

2. 安装依赖：

   ```sh
   npm install
   ```

3. 启动开发服务器：

   ```sh
   npm run develop
   ```

   该命令会同时启动 Rollup 编译（监听模式）和静态文件服务器。

4. 在浏览器中访问 `http://localhost:3000`

源代码变更会被自动检测并重新编译，刷新浏览器即可查看效果。

### 可用命令

| 命令 | 说明 |
|------|------|
| `npm run develop` | 启动开发服务器（构建 + 热重载） |
| `npm run build` | 构建生产版本 |
| `npm run watch` | 仅监听并重新编译 |
| `npm run serve` | 仅启动静态文件服务器 |
| `npm run lint` | 运行 ESLint 代码检查 |

### 常见问题

**页面不更新？** ReSplat 使用了 Service Worker 缓存，请执行强制刷新：
- Windows / Linux：`Ctrl + Shift + R`
- macOS：`Cmd + Shift + R`

---

## 国际化贡献

欢迎帮助改进翻译质量！

1. 在 `static/locales/` 目录下找到对应语言的 JSON 文件
2. 修改或补充翻译内容
3. 如需新增语言，在 `static/locales/` 中添加 `<locale>.json` 文件，并在 `src/ui/localization.ts` 中注册

测试翻译：启动开发服务器后访问 `http://localhost:3000/?lng=<locale>`（如 `?lng=zh-CN`）

---

## 致谢

- [SuperSplat](https://github.com/playcanvas/supersplat) — 原始项目，提供了强大的高斯点云编辑基础
- [GaussianSplatEditor](https://github.com/TimChen1383/GaussianSplatEditor) — 透明度/尺寸选择工具的源码参考
- [PlayCanvas](https://playcanvas.com/) — 优秀的 WebGL 游戏引擎

---

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。

---

---

# English Version

---

## ReSplat Editor

> **Powered by [supersplat-2.27.0](https://github.com/playcanvas/supersplat)** — This project is a fork/rebrand of the original SuperSplat editor.

[![Github Release](https://img.shields.io/github/v/release/Re-qi/ReSplat_Editor)](https://github.com/Re-qi/ReSplat_Editor/releases)
[![License](https://img.shields.io/github/license/Re-qi/ReSplat_Editor)](https://github.com/Re-qi/ReSplat_Editor/blob/main/LICENSE)

| [Live Demo](https://re-qi.github.io/ReSplat_Editor/) | [User Guide](https://developer.playcanvas.com/user-manual/gaussian-splatting/editing/ReSplat/) | [Issues](https://github.com/Re-qi/ReSplat_Editor/issues) |

---

### Introduction

ReSplat is a **3D Gaussian Splat editor** refactored from [SuperSplat](https://github.com/playcanvas/supersplat). It runs entirely in the browser — nothing to download or install.

Building on SuperSplat, this project **redesigns the interaction logic**, drawing on the strengths of both **Blender** and **Unreal Engine** to make Gaussian Splat editing more intuitive and efficient.

> **Language Note**: The developer's native language is Chinese, so the **Chinese UI is fully reviewed and optimized**. Other languages are machine-translated and have not been manually proofread. Community contributions for translation improvements are welcome.

---

### Improvements over SuperSplat

Building on SuperSplat, ReSplat introduces the following improvements:

- **Optimized controls**: Better aligned with DCC software user workflows, lowering the learning curve
- **Scroll wheel fix**: Resolved a bug where browser zoom caused the scroll wheel to stop working
- **Depth view mode**: New depth visualization mode for inspecting scene depth information

---

### Features

#### Wrapper System

ReSplat refactors the original selection sphere and selection box, and adds a new blocking plane. These three are collectively called **Wrappers**. Wrappers can be transformed (moved, rotated, scaled) just like Meshes, providing flexible spatial constraints for point cloud selection.

![Wrappers](./static/images/包裹体.png)

| Wrapper | Description |
|---------|-------------|
| **Wrapper Sphere** | A spherical wrapper for selecting Gaussian points inside the sphere. The eyedropper, fill, opacity selection, and size selection tools can all be constrained to operate only on points inside the wrapper sphere. Useful for precisely handling white noise points inside tree leaves in large scenes. |
| **Wrapper Box** | Same as the wrapper sphere, but with a cuboid shape. Ideal for working with point clouds within regular regions. |
| **Blocking Plane** | An infinite plane that blocks the rectangle selection, lasso selection, polygon selection, and brush tools from selecting Gaussian points **behind** the plane, enabling precise selection under front-to-back occlusion relationships. |

#### Point Cloud Groups

Similar to Blender's **Vertex Group** concept:

- Save the currently selected points as a **Point Cloud Group** for quick re-selection later
- Independently **move, rotate, and scale** points within a group
- Great for workflows that require repeatedly editing the same region of points

#### Duplicate, Split, Merge

Brand-new features designed for more convenient **Gaussian Splat assembly**, overcoming the limitations of SuperSplat's original depth-sorting constraints:

- **Duplicate** — Copy selected points
- **Split** — Separate selected points from the current Splat into an independent object
- **Merge** — Combine multiple Splat objects into one

#### Opacity Selection Tool & Size Selection Tool

Based on source code from the [GaussianSplatEditor](https://github.com/TimChen1383/GaussianSplatEditor) branch, with extended features:

- **Opacity Selection Tool** — Range-select by Gaussian point opacity, quickly filtering semi-transparent or low-opacity points
- **Size Selection Tool** — Range-select by Gaussian point size, locating abnormally large or small points

#### Low-Precision Gaussian Repair

A repair feature for specific scenarios:

- Applicable to Gaussian files that suffered coordinate precision loss due to **GPS jammer interference** during aerial triangulation
- Fixes the **flickering issue** when low-float-precision Gaussians are rendered
- Automatically detects and corrects precision-abnormal coordinate data

#### Rich Selection Toolset

ReSplat provides **14 tools** across three categories: selection, transformation, and measurement.

| Category | Tools |
|----------|-------|
| **Selection** | Rectangle, Lasso, Polygon, Brush, Fill, Sphere, Box, Eyedropper, Opacity, Size |
| **Transform** | Move, Rotate, Scale |
| **Measurement** | Distance |

#### Animation & Timeline

- Built-in timeline panel with **keyframe animation** editing
- Camera trajectory animation for creating smooth flythrough paths
- Play, pause, and frame-by-frame control support

#### Multi-Format Import & Export

| Format | Import | Export |
|--------|:------:|:------:|
| PLY (standard / compressed) | ✅ | ✅ |
| Splat | ✅ | ✅ |
| SOG | ✅ | ✅ |
| SSPROJ (project file) | ✅ | ✅ |
| Images (PNG / WebP) | — | ✅ |
| Video (MP4 / WebM / MOV / MKV) | — | ✅ |

#### Multi-Language Support

i18next-based internationalization system supporting 9 languages:

中文（简体） · English · 日本語 · 한국어 · Français · Deutsch · Español · Português · Русский

---

### Local Development

> For detailed setup instructions, see [SETUP.md](./SETUP.md)

#### Requirements

- [Node.js](https://nodejs.org/) >= 20.19.0

#### Quick Start

1. Clone the repository:

   ```sh
   git clone https://github.com/Re-qi/ReSplat_Editor.git
   cd ReSplat_Editor
   ```

2. Install dependencies:

   ```sh
   npm install
   ```

3. Start the development server:

   ```sh
   npm run develop
   ```

   This starts Rollup compilation (watch mode) and the static file server simultaneously.

4. Open your browser and navigate to `http://localhost:3000`

Source code changes are detected and recompiled automatically — just refresh your browser to see the updates.

#### Available Commands

| Command | Description |
|---------|-------------|
| `npm run develop` | Start the development server (build + hot reload) |
| `npm run build` | Build the production version |
| `npm run watch` | Watch and recompile only |
| `npm run serve` | Start the static file server only |
| `npm run lint` | Run ESLint code checks |

#### FAQ

**Page not updating?** ReSplat uses Service Worker caching. Perform a force refresh:
- Windows / Linux: `Ctrl + Shift + R`
- macOS: `Cmd + Shift + R`

---

### Contributing Translations

Help improve translation quality!

1. Find the corresponding language JSON file in the `static/locales/` directory
2. Edit or add translation entries
3. To add a new language, create a `<locale>.json` file in `static/locales/` and register it in `src/ui/localization.ts`

Test translations: start the dev server and visit `http://localhost:3000/?lng=<locale>` (e.g., `?lng=zh-CN`)

---

### Acknowledgments

- [SuperSplat](https://github.com/playcanvas/supersplat) — The original project, providing a powerful foundation for Gaussian Splat editing
- [GaussianSplatEditor](https://github.com/TimChen1383/GaussianSplatEditor) — Source reference for opacity and size selection tools
- [PlayCanvas](https://playcanvas.com/) — The excellent WebGL game engine

---

### License

This project is open source under the [MIT License](./LICENSE).

