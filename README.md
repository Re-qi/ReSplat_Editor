# ReSplat Editor

> **Powered by [supersplat-2.27.0](https://github.com/playcanvas/supersplat)** — This project is a fork/rebrand of the original SuperSplat editor.

[![Github Release](https://img.shields.io/github/v/release/Re-qi/ReSplat)](https://github.com/Re-qi/ReSplat/releases)
[![License](https://img.shields.io/github/license/Re-qi/ReSplat)](https://github.com/Re-qi/ReSplat/blob/main/LICENSE)

| [在线使用](https://superspl.at/editor) | [用户文档](https://developer.playcanvas.com/user-manual/gaussian-splatting/editing/ReSplat/) | [问题反馈](https://github.com/Re-qi/ReSplat/issues) |

---

## 简介

ReSplat 是一款基于 [SuperSplat](https://github.com/playcanvas/supersplat) 重构的 **3D 高斯点云编辑器**，完全运行在浏览器中，无需安装任何软件即可使用。

本项目在 SuperSplat 的基础上**重新设计了操作逻辑**，吸取了 **Blender** 与 **Unreal Engine** 的交互优点，使高斯点云的编辑体验更加直观高效。

> **语言说明**：开发者母语为中文，因此**中文界面经过完整审核与优化**，其他语言均为机器翻译、未经人工校对，欢迎社区贡献翻译改进。

![ReSplat Editor](https://github.com/user-attachments/assets/b6cbb5cc-d3cc-4385-8c71-ab2807fd4fba)

---

## 特色功能

### 包裹体系统

ReSplat 重构了原版的选择球与选择盒，并新增了阻挡平面，三者统一称为 **包裹体（Wrapper）**。包裹体可以像 Mesh 一样进行移动、旋转、缩放变换，为点云选择提供了灵活的空间约束能力。

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
- **尺寸选择工具** — 根据高斯点的尺寸属性进行范围选择，定位过大或过小的异常点云

### 低精度高斯修复

针对特定场景的修复功能：

- 适用于因空三（空中三角测量）受到 **GPS 屏蔽器**影响而导致坐标精度丢失的高斯文件
- 修复低浮点精度的高斯点在渲染时出现的**闪烁问题**
- 自动检测并修正精度异常的坐标数据

### 丰富的选择工具集

ReSplat 提供 **14 种工具**，覆盖选择、变换、测量三大类：

| 类别 | 工具 |
|------|------|
| **选择类** | 矩形选择、套索选择、多边形选择、画笔选择、填充选择、球体选择、盒体选择、吸管工具、透明度选择、尺寸选择 |
| **变换类** | 移动、旋转、缩放 |
| **测量类** | 距离测量 |

### 动画与时间轴

- 内置时间轴面板，支持**关键帧动画**编辑
- 相机轨迹动画，可创建平滑的飞行路径
- 支持播放、暂停、逐帧控制

### 多格式导入导出

| 格式 | 导入 | 导出 |
|------|:----:|:----:|
| PLY（标准 / 压缩） | ✅ | ✅ |
| Splat | ✅ | ✅ |
| SOG | ✅ | ✅ |
| SSPROJ（项目文件） | ✅ | ✅ |
| 图像（PNG / WebP） | — | ✅ |
| 视频（MP4 / WebM / MOV / MKV） | — | ✅ |

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
   git clone https://github.com/Re-qi/ReSplat.git
   cd ReSplat
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
