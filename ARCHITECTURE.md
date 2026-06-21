# ReSplat 软件架构图

## 1. 顶层架构总览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              浏览器 (Browser)                                │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                         入口层 (Entry Layer)                            │  │
│  │  src/index.ts ──> src/main.ts                                          │  │
│  │  职责: 版本日志、i18n 初始化、组装所有子系统、注入 Events 总线          │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                      │                                       │
│                                      ▼                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                    事件总线 (Event Bus) — src/events.ts                 │  │
│  │  extends playcanvas.EventHandler + functions Map                       │  │
│  │  两种通道: events.on/fire (事件) | events.function/invoke (RPC)        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                      │                                       │
│        ┌─────────────────┬──────────┴───────────┬─────────────────┐         │
│        ▼                 ▼                      ▼                 ▼         │
│  ┌──────────┐    ┌──────────────┐      ┌──────────────┐   ┌──────────┐     │
│  │ 渲染核心  │    │  编辑/历史    │      │   IO 序列化   │   │   UI 层   │     │
│  │ (Render)  │    │  (Edit/Undo) │      │  (IO/Ser)    │   │  (PCUI)  │     │
│  └──────────┘    └──────────────┘      └──────────────┘   └──────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 2. 核心子系统分层

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          UI 层 (src/ui/*)                                    │
│  基于 @playcanvas/pcui 构建                                                  │
│                                                                             │
│  EditorUI ─┬─ Menu / MenuPanel       (顶部菜单)                              │
│            ├─ ScenePanel             (左侧: SplatList/Transform/Color/View)  │
│            ├─ BottomToolbar          (底部工具栏: 选择/变换工具)              │
│            ├─ RightToolbar           (右侧: 相机重置/框选)                    │
│            ├─ ModeToggle/Switch      (显示模式切换)                          │
│            ├─ ViewCube               (视角立方体)                            │
│            ├─ TimelinePanel          (时间轴/关键帧)                         │
│            ├─ DataPanel/Histogram    (Splat 数据直方图)                      │
│            ├─ StatusBar              (状态栏: 统计/面板切换)                  │
│            └─ Popups: ShortcutsPopup / ExportPopup / FixPlyDialog /          │
│                      ImageSettingsDialog / VideoSettingsDialog / AboutPopup │
│                                                                             │
│  本地化: src/ui/localization.ts (i18next + 9 种语言)                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ events.fire / events.invoke
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       业务逻辑层 (src/*.ts)                                  │
│                                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐   │
│  │ Scene            │  │ EditHistory      │  │ ToolManager              │   │
│  │ src/scene.ts     │  │ src/edit-history │  │ src/tools/tool-manager   │   │
│  │ 持有 PCApp/相机/ │  │ .ts              │  │ .ts                      │   │
│  │ Layer/Element[]  │  │ history[]+cursor │  │ tools Map + active       │   │
│  └──────────────────┘  └──────────────────┘  └──────────────────────────┘   │
│          │                      │                       │                  │
│          │                      │ enqueue               │ activate         │
│          ▼                      ▼                       ▼                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐   │
│  │ Element 体系     │  │ CommandQueue     │  │ Tools (14 种)            │   │
│  │ src/element.ts   │  │ src/command-     │  │ src/tools/*.ts           │   │
│  │  ├ Splat         │  │ queue.ts         │  │  选择类: Rect/Lasso/     │   │
│  │  ├ Camera        │  │ 全局 FIFO 串行化 │  │    Polygon/Brush/Flood/  │   │
│  │  ├ BlockingPlane │  │ GPU 读回 + 历史  │  │    Sphere/Box/Eyedropper │   │
│  │  ├ BoxShape      │  │ 变更都走同一队列 │  │    Opacity/Size          │   │
│  │  └ SphereShape   │  └──────────────────┘  │  变换类: Move/Rotate/    │   │
│  └──────────────────┘                          │    Scale                 │   │
│                                                │  测量类: Measure         │   │
│                                                └──────────────────────────┘   │
│                                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐   │
│  │ Selection        │  │ Doc              │  │ Render                   │   │
│  │ src/selection.ts │  │ src/doc.ts       │  │ src/render.ts            │   │
│  │ splat/shape 双选 │  │ .ssproj 文档管理 │  │ 图像/视频导出            │   │
│  │ 多选 Set<Splat>  │  │ File System API  │  │ mediabunny 编码          │   │
│  └──────────────────┘  └──────────────────┘  └──────────────────────────┘   │
│                                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐   │
│  │ Timeline         │  │ TrackManager     │  │ ShortcutManager          │   │
│  │ src/timeline.ts  │  │ src/track-       │  │ src/shortcut-manager.ts  │   │
│  │ 帧/帧率/平滑度   │  │ manager.ts       │  │ defaultShortcuts 绑定表  │   │
│  │ 播放控制         │  │ AnimTrack 编辑   │  │ Shortcuts 键盘监听       │   │
│  └──────────────────┘  └──────────────────┘  └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    渲染 & 数据处理层 (GPU)                                   │
│                                                                             │
│  ┌──────────────────────┐    ┌──────────────────────────────────────────┐   │
│  │ PlayCanvas Engine    │    │ DataProcessor (src/data-processor/)      │   │
│  │ src/pc-app.ts        │    │  ├ Intersect    (mask 与 splat 中心求交) │   │
│  │  ├ GraphicsDevice    │    │  ├ CalcBound    (选中/可见包围盒)        │   │
│  │  ├ ComponentSystems: │    │  ├ CalcPositions(世界坐标位置)           │   │
│  │  │  GSplat/Camera/   │    │  ├ CalcHistogram(属性直方图)             │   │
│  │  │  Render/Light/Anim│    │  ├ SelectByRange(范围选择 mask)          │   │
│  │  ├ Layer: world/     │    │  └ BufferPool   (读回缓冲池复用)         │   │
│  │  │  splat/gizmo      │    └──────────────────────────────────────────┘   │
│  │  └ AssetLoader       │                                                    │
│  └──────────────────────┘    ┌──────────────────────────────────────────┐   │
│                              │ Shaders (src/shaders/*.ts)                │   │
│  ┌──────────────────────┐    │  splat / blit / bound / box-shape /      │   │
│  │ Camera               │    │  sphere-shape / blocking-plane /         │   │
│  │ src/camera.ts        │    │  histogram / intersection / outline /    │   │
│  │  ├ PointerController │    │  infinite-grid / position / select-by-   │   │
│  │  ├ Picker (GPU 拾取) │    │  range / splat-overlay / splat-value /   │   │
│  │  ├ TweenValue        │    │  debug                                  │   │
│  │  └ RenderPass        │    └──────────────────────────────────────────┘   │
│  └──────────────────────┘                                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       IO & 序列化层 (src/io/)                                │
│                                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐   │
│  │ Read             │  │ Write            │  │ Splat Serialize          │   │
│  │ src/io/read/     │  │ src/io/write/    │  │ src/splat-serialize.ts   │   │
│  │  ├ loader.ts     │  │  ├ browser-fs.ts │  │  ├ PLY (压缩/标准)       │   │
│  │  ├ file-systems  │  │  ├ writer.ts     │  │  ├ Splat / SOG           │   │
│  │  └ index.ts      │  │  └ index.ts      │  │  └ Viewer (HTML/ZIP)     │   │
│  └──────────────────┘  └──────────────────┘  └──────────────────────────┘   │
│                                                                             │
│  依赖: @playcanvas/splat-transform (格式转换/LOD/排序)                       │
│  依赖: lodepng.wasm / webp.wasm (图像编解码)                                 │
│  依赖: mediabunny (视频编码: H.264/H.265/VP9/AV1)                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 3. 核心数据流

### 3.1 加载流

```
【加载流】
用户拖拽/打开文件
    │
    ▼
file-handler.ts / doc.ts  ──>  IO/read/loader.ts
    │                            │
    │                            │  readFile() + sortMortonOrder()
    │                            ▼
    │                    @playcanvas/splat-transform
    │                            │
    │                            ▼  DataTable → GSplatData
    ▼
Scene.add(Splat)  ──>  Splat 构造 (state texture / transform texture)
    │
    ▼
events.fire('splat.added')  ──>  UI 更新 (SplatList / ScenePanel / StatusBar)
```

### 3.2 编辑流

```
【编辑流】
用户操作 (鼠标/快捷键)
    │
    ▼
Tool.activate()  ──>  生成 mask (DataProcessor.intersect/selectByRange)
    │
    ▼
events.fire('edit.add', EditOp)
    │
    ▼
EditHistory.add(op)  ──>  CommandQueue.enqueue(串行化)
    │
    ▼
op.do()  ──>  Splat.state.setBits/clearBits  ──>  Splat.updateState()
    │                                            ──>  Splat.updatePositions()
    ▼
events.fire('splat.changed')  ──>  Scene.forceRender  ──>  GPU 重绘
```

### 3.3 撤销/重做流

```
【撤销/重做流】
Ctrl+Z / Ctrl+Shift+Z
    │
    ▼
events.fire('edit.undo'/'edit.redo')
    │
    ▼
EditHistory.undo()/redo()  ──>  CommandQueue.enqueue
    │
    ▼
op.undo()/op.do()  ──>  Splat 状态恢复  ──>  GPU 重绘
```

### 3.4 导出流

```
【导出流】
用户选择导出格式
    │
    ▼
file-handler.ts / render.ts
    │
    ├─> PLY/Splat/SOG: splat-serialize.ts  ──>  IO/write  ──>  文件下载
    │
    └─> 视频: render.ts  ──>  逐帧渲染 + mediabunny 编码  ──>  文件下载
         │
         └─> 图像: PngCompressor (lodepng.wasm)
```

### 3.5 动画流

```
【动画流】
时间轴播放
    │
    ▼
Timeline.togglePlay  ──>  每帧 events.fire('timeline.frame')
    │
    ▼
Camera.animTrack.evaluate(frame)  ──>  Camera 插值  ──>  Scene.forceRender
    │
    ▼
关键帧操作 (Enter/Shift+Enter)
    │
    ▼
TrackManager  ──>  AnimTrackEditOp  ──>  EditHistory (可撤销)
```

## 4. 关键模块交互关系

```
                    ┌──────────────────────────────────┐
                    │           Events 总线             │
                    │  (events.on/fire/function/invoke) │
                    └──────────────────────────────────┘
                          ▲           ▲           ▲
                          │           │           │
              ┌───────────┘           │           └───────────┐
              │                       │                       │
              │ register              │ register              │ register
              │                       │                       │
     ┌────────┴────────┐    ┌─────────┴─────────┐   ┌─────────┴──────────┐
     │ registerDoc     │    │ registerEditor    │   │ registerSelection  │
     │ Events          │    │ Events            │   │ Events             │
     │ (doc.ts)        │    │ (editor.ts)       │   │ (selection.ts)     │
     └────────┬────────┘    └─────────┬─────────┘   └─────────┬──────────┘
              │                       │                       │
              │                       │ 调用                  │ 调用
              ▼                       ▼                       ▼
     ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
     │ Scene          │      │ EditHistory    │      │ Splat          │
     │ - elements[]   │◀─────│ - history[]    │─────▶│ - splatData    │
     │ - camera       │      │ - cursor       │      │ - state        │
     │ - app (PCApp)  │      │ - commandQueue │      │ - transformTex │
     └────────┬───────┘      └────────┬───────┘      └────────┬───────┘
              │                       │                       │
              │                       │ enqueue               │ updateState
              ▼                       ▼                       ▼
     ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
     │ DataProcessor  │      │ CommandQueue   │      │ SplatState     │
     │ (GPU passes)   │      │ (FIFO 串行)    │      │ (CPU+GPU 镜像) │
     └────────────────┘      └────────────────┘      └────────────────┘
              │
              ▼
     ┌────────────────┐
     │ BufferPool     │  (mask 缓冲复用, 调用者负责 releaseMask)
     └────────────────┘
```

## 5. 核心实现路径速查

| 功能 | 入口文件 | 关键调用链 |
|---|---|---|
| 加载 PLY/Splat/SOG | `src/file-handler.ts` | `drop-handler` → `io/read/loader.ts` → `splat-transform.readFile` → `Scene.add(Splat)` |
| 矩形选择 | `src/tools/rect-selection.ts` | `RectSelection` → `DataProcessor.intersect` → `EditHistory.add(SelectOp)` → `Splat.state.setBits` |
| 移动 Splat | `src/tools/move-tool.ts` | `MoveTool` → `SplatsTransformOp` → `Splat.transformPalette` → `Splat.updatePositions` |
| 撤销/重做 | `src/edit-history.ts` | `events.fire('edit.undo')` → `EditHistory.undo` → `CommandQueue.enqueue` → `op.undo()` |
| 导出 PLY | `src/splat-serialize.ts` | `serializePly` → `io/write` → `BrowserFileSystem` → `showSaveFilePicker` |
| 渲染视频 | `src/render.ts` | `render.video` → 逐帧 `Scene.render` → `mediabunny` 编码 → 文件写入 |
| 快捷键分发 | `src/shortcut-manager.ts` | `defaultShortcuts` → `Shortcuts.register` → `document.keydown` → `events.fire(eventId)` |
| WASDQE 条件拦截 | `src/main.ts#L222-L261` | `document.keydown`(capture) → 检查 `mouseButtonsPressed` → 工具切换 or 飞行控制 |
| 时间轴动画 | `src/timeline.ts` + `src/anim/spline.ts` | `timeline.frame` → `AnimTrack.evaluate` → `Camera` 插值 |
| iframe API | `src/iframe-api.ts` | `window.message` 监听 → `events.invoke('scene.dirty')` → `postMessage` 回复 |

## 6. 技术栈依赖

| 层级 | 依赖 | 用途 |
|---|---|---|
| 引擎 | `playcanvas` 2.18.2 | WebGL2 渲染、GSplat、相机、拾取 |
| UI | `@playcanvas/pcui` 6.1.4 | UI 组件库 |
| 格式转换 | `@playcanvas/splat-transform` 2.3.1 | PLY/SOG 读写、LOD、Morton 排序 |
| 视频编码 | `mediabunny` 1.45.3 | MP4/WebM/MOV/MKV 编码 |
| i18n | `i18next` + http-backend + language-detector | 9 种语言本地化 |
| 构建 | `rollup` 4.60.4 + TypeScript 6.0.3 + sass | 打包编译 |
| WASM | `lodepng.wasm` / `webp.wasm` | PNG/WebP 编解码 |

## 7. 核心组件功能说明

### 7.1 Events 事件总线

- **文件**: `src/events.ts`
- **职责**: 全局通信中枢，所有模块通过事件总线解耦
- **两种通道**:
  - `events.on(event, handler)` / `events.fire(event, ...args)` — 事件发布/订阅
  - `events.function(name, fn)` / `events.invoke(name, ...args)` — RPC 函数调用（支持返回值）

### 7.2 Scene 场景管理

- **文件**: `src/scene.ts`
- **职责**: 持有所有场景元素、图层、相机
- **核心属性**:
  - `elements: Element[]` — 所有场景元素
  - `app: PCApp` — PlayCanvas 应用实例
  - `camera: Camera` — 相机控制
  - `sceneState: SceneState[]` — 场景状态（当前/快照）
  - `worldLayer / splatLayer / gizmoLayer` — 渲染图层

### 7.3 Element 元素体系

- **文件**: `src/element.ts`
- **基类**: 所有场景元素继承自 `Element`
- **子类**:
  - `Splat` — 3D 高斯点云
  - `Camera` — 相机
  - `BlockingPlane` — 遮挡平面
  - `BoxShape` / `SphereShape` — 选择形状

### 7.4 EditHistory 编辑历史

- **文件**: `src/edit-history.ts`
- **职责**: 管理撤销/重做栈
- **关键机制**:
  - `history: EditOp[]` — 操作历史栈
  - `cursor: number` — 当前光标位置
  - 所有操作通过 `CommandQueue` 串行化执行

### 7.5 CommandQueue 命令队列

- **文件**: `src/command-queue.ts`
- **职责**: 全局 FIFO 串行化队列
- **用途**: GPU 读回、历史变更等异步操作统一排队，保证执行顺序

### 7.6 ToolManager 工具管理

- **文件**: `src/tools/tool-manager.ts`
- **职责**: 管理 14 种工具的注册、激活、切换
- **工具分类**:
  - 选择类: Rect / Lasso / Polygon / Brush / Flood / Sphere / Box / Eyedropper / Opacity / Size
  - 变换类: Move / Rotate / Scale
  - 测量类: Measure

### 7.7 DataProcessor 数据处理器

- **文件**: `src/data-processor/index.ts`
- **职责**: GPU 加速的 Splat 数据处理
- **核心方法**:
  - `intersect()` — mask 与 splat 中心求交
  - `calcBound()` — 计算选中/可见包围盒
  - `calcPositions()` — 计算世界坐标位置
  - `calcHistogram()` — 计算属性直方图
  - `selectByRange()` — 范围选择 mask

### 7.8 ShortcutManager 快捷键管理

- **文件**: `src/shortcut-manager.ts`
- **职责**: 管理所有键盘快捷键绑定
- **机制**:
  - `defaultShortcuts` — 默认快捷键绑定表
  - 支持 Mac/Windows 不同修饰键符号显示
  - 通过 `Shortcuts` 类注册键盘监听

### 7.9 Timeline 时间轴

- **文件**: `src/timeline.ts`
- **职责**: 管理动画播放状态
- **核心属性**:
  - `frames` — 总帧数
  - `frameRate` — 帧率
  - `smoothness` — 平滑度
  - 播放控制: 播放/暂停/上一帧/下一帧

### 7.10 TrackManager 轨道管理

- **文件**: `src/track-manager.ts`
- **职责**: 管理动画轨道和关键帧
- **机制**:
  - 获取当前激活的 `AnimTrack`
  - 关键帧操作（添加/删除/移动/复制）包装为可撤销的 `EditOp`

## 8. 关键业务流程说明

### 8.1 文件加载流程

1. 用户通过拖拽或文件选择器触发加载
2. `file-handler.ts` 识别文件类型（PLY/Splat/SOG/SSPROJ 等）
3. `io/read/loader.ts` 使用 `@playcanvas/splat-transform` 读取文件
4. 转换为 `GSplatData` 并构造 `Splat` 对象
5. 添加到 `Scene`，触发 UI 更新

### 8.2 选择操作流程

1. 用户激活选择工具（如矩形选择）
2. 工具收集用户输入（鼠标拖拽区域）
3. `DataProcessor.intersect()` 计算选中的 Splat 索引
4. 生成 `SelectOp` 并添加到 `EditHistory`
5. `Splat.state.setBits()` 更新选中状态
6. GPU 重绘显示选中效果

### 8.3 变换操作流程

1. 用户激活变换工具（移动/旋转/缩放）
2. 用户通过 Gizmo 交互
3. 生成 `SplatsTransformOp`
4. 更新 `Splat.transformPalette`
5. `Splat.updatePositions()` 重新计算位置
6. GPU 重绘

### 8.4 撤销/重做流程

1. 用户触发 Ctrl+Z / Ctrl+Shift+Z
2. `EditHistory.undo()/redo()` 移动光标
3. 通过 `CommandQueue` 串行化执行
4. 调用 `op.undo()` 或 `op.do()`
5. 恢复 Splat 状态
6. GPU 重绘

### 8.5 导出流程

1. 用户选择导出格式（PLY/Splat/SOG/视频等）
2. `file-handler.ts` 或 `render.ts` 处理
3. `splat-serialize.ts` 序列化数据
4. 通过 `io/write` 写入文件
5. 触发浏览器下载

### 8.6 动画播放流程

1. 用户点击播放按钮
2. `Timeline` 开始逐帧推进
3. 每帧触发 `timeline.frame` 事件
4. `Camera.animTrack.evaluate(frame)` 计算相机状态
5. 相机插值更新
6. `Scene.forceRender` 触发重绘

## 9. 架构设计特点

### 9.1 事件驱动解耦

所有模块通过 `Events` 总线通信，无直接依赖。新增功能只需注册新事件监听，不影响现有代码。

### 9.2 命令模式支持撤销

所有编辑操作实现 `EditOp` 接口（`do()` / `undo()`），统一由 `EditHistory` 管理，支持完整的撤销/重做。

### 9.3 GPU 加速数据处理

`DataProcessor` 使用 WebGL shader 进行大规模 Splat 计算（包围盒、直方图、范围选择等），性能优异。

### 9.4 命令队列保证一致性

`CommandQueue` 全局 FIFO 队列确保 GPU 读回、历史变更等异步操作按序执行，避免竞态条件。

### 9.5 工具系统可扩展

`ToolManager` 支持动态注册工具，每种工具独立实现 `activate()` / `deactivate()`，易于扩展新工具。

### 9.6 快捷键集中管理

`ShortcutManager` 集中管理所有快捷键绑定，支持 Mac/Windows 差异，便于维护和自定义。
