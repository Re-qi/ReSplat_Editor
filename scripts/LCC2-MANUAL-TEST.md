# LCC2 导出 — 阶段一人工验证手册

> 本文档对应 `.trae/specs/export-lcc2-format/tasks.md` Task 7 的**人工**子项
> （7.2 `.sog` 可解码 / 7.3 ReSplat 回环 / 7.4 XGRIDS 工具 / 7.5 双路生成）。
> 自动化部分（7.1 结构校验脚本 + 全量 lint/tsc/build）已完成并通过，见下方
> "已自动完成" 一节。以下步骤需用户在带 WebGPU 的 Electron/Chromium 中执行。

## 前置（已自动完成，无需人工）

- `npx eslint src` → 0 错误（16 条与 LCC2 无关的既有 "unused eslint-disable" 警告）。
- `npx tsc --noEmit` → 0 错误。
- `npm run build`（rollup -c）→ 成功生成 `dist/`。
- `node -c electron/main.cjs` / `node -c electron/preload.cjs` → 语法 OK。
- 结构校验脚本 `scripts/validate-lcc2.mjs` 对参考样本
  `D:\CodeProjects\ReSplat\数据\LCC\雕像群\雕像群.lcc2` 输出 **PASS**
  （6 级 / totalSplats=20730096 / lodSplats=[10536201,5267602,2631012,1313429,655272,326580]）。
- 集成接线已确认：`serializeLcc2`/`Lcc2ExportOptions` 自 `src/splat-serialize.ts`
  导出；`createDirectoryFileSystem` 经 `src/io/write/index.ts` 再导出并被
  `src/file-handler.ts` 引用；`ExportType`/`FileType` 含 `'lcc2'`；
  `filePickerTypes.lcc2` 存在；菜单 → export-popup → `scene.export` →
  `scene.write` → `serializeLcc2` 链路类型连贯；`electronAPI` 的
  `mkdir`/`writeStreamOpen`/`writeStreamChunk`/`writeStreamClose`/`unlink`
  在 `global.d.ts` 声明并与 `electron/preload.cjs`、`electron/main.cjs` 一致。

## 步骤 1：构建并启动 Electron

```powershell
npm run electron:dev   # = npm run build && electron .
```

> 也可分两步：`npm run build` 然后 `npx electron .`。
> 需要可用 WebGPU（SOG k-means 在 GPU 上跑），启动后控制台应打印
> `[electron] WebGPU available: true`。

## 步骤 2：加载中小规模场景

拖入或打开一个 **中小规模** PLY/SOG 场景（点数 ≤ 几十万）。
> 阶段一避免使用 10.5M 的参考 `雕像群`：splat-transform 的 SOG 编码
> （GPU k-means + WebP）对 >15M 点 / 59 属性场景极慢或会失败，这是已知风险，
> 留待阶段二（`.spz` 或后端加速）。

## 步骤 3：导出 LCC2

菜单 **文件 → 导出 → LCC2** → 在导出弹窗中设置 splat 选择 / SH bands /
SOG iterations / 文件名 → 确认 → 在弹出的目录选择器中选一个**空输出目录**。
导出器会在该目录写：
- `<name>.lcc2`（元数据，单层树 `totalLevels:1`）
- `data/3dgs/<name>_lod0.sog`（PLY 空间 chunk）

观察导出进度对话框正常结束、无报错。

## 步骤 4：结构校验（自动脚本）

```powershell
node scripts/validate-lcc2.mjs "<输出目录>\<name>.lcc2"
```

期望：**=== RESULT: PASS ===**（8 项检查全 PASS）。
任何 FAIL 请把整段输出回报——脚本已对参考样本验证正确，FAIL 通常意味着
导出产物真有结构问题。

## 步骤 5：ReSplat 回环导入（关键 — 朝向检查）

把导出的 `<name>.lcc2` **目录**拖回 ReSplat 窗口。期望：
- 单 LOD（`totalLevels:1`）**不弹出**层级选择对话框（多级才会弹）。
- 场景正常加载并渲染。
- **朝向必须与 LCC2 约定一致**（与直接导入参考 `雕像群.lcc2` 时的朝向同构），
  **不能**出现上下颠倒 / 镜像 / 双重翻转。

> 若朝向异常（双重翻转）：根因在 `src/splat-serialize.ts` 中 `serializeLcc2`
> 调用的 `extractDataTable` 的 `Transform` 标注（见 spec "坐标变换一致性"）。
> 导出侧 chunk 数据应为 PLY 空间，`readLcc2` 读取时叠加
> `LCC2_TRANSFORM = fromEulers(90,0,180)`。如需调整，改 `extractDataTable`
> 的 Transform 标签后重测，并回报用户。

## 步骤 6：XGRIDS Lixel CyberColor 工具打开（人工）

将导出的 `<name>.lcc2` 目录在 **XGRIDS Lixel CyberColor** 工具中打开，
确认能正常加载与渲染。（此项仅人工可验，自动化无法触达。）

## 步骤 7：浏览器路径（Chromium）

```powershell
npm run develop   # rollup watch + serve dist -l 3000
```

在 **Chromium 系**浏览器打开 `http://localhost:3000/`，加载场景后
**文件 → 导出 → LCC2**：
- 支持 `showDirectoryPicker`（Chrome/Edge）→ 选目录，直接写目录树
  （`<name>.lcc2` + `data/3dgs/*.sog`）。
- 不支持（Firefox/Safari）→ 回退为下载 `<name>.zip`（内存中 `MemoryFileSystem`
  + `ZipFileSystem` 打包）。

两条路径产物均可用步骤 4 的脚本校验（zip 需先解压）。

## checklist.md 阶段一对照

| checklist 项 | 状态 |
|---|---|
| 导出菜单含 LCC2 项、空场景禁用 | ✅ 自动（代码已确认） |
| ExportType/FileType 含 `'lcc2'`、filePickerTypes.lcc2 | ✅ 自动 |
| Electron fs:mkdir + 流式写 IPC，preload 暴露 | ✅ 自动 |
| DirectoryFileSystem 实现 FileSystem 接口 | ✅ 自动 |
| Electron 走 openFolderDialog + 直接写目录 | ⬜ 待人工（步骤 1/3） |
| 浏览器 showDirectoryPicker 写目录 / 不支持回退 ZIP | ⬜ 待人工（步骤 7） |
| serializeLcc2 复用 serializeSog 写 .sog | ✅ 自动（代码已确认） |
| .sog chunk 处于 PLY 空间 | ⬜ 待人工（步骤 5 朝向 + 6 XGRIDS） |
| XXX.lcc2 JSON 符合 v0.0.3，字段齐全 | ✅ 自动（校验脚本） |
| 单层树 root→leaf "0_0" 正确 | ✅ 自动（校验脚本 4a） |
| fileType 由 maxSHBands 判定 | ✅ 自动（代码已确认） |
| boundingBox 与 chunk 坐标一致 | ⬜ 待人工（步骤 5/6） |
| scene.write 新增 'lcc2' 分支用 DirectoryFileSystem | ✅ 自动（代码已确认） |
| 结构校验通过 | ✅ 自动（脚本对参考 PASS） |
| .sog 可被 readSog 解码、点数=count、SH 一致 | ⬜ 待人工（步骤 5 回环） |
| 回环朝向正确 | ⬜ 待人工（步骤 5） |
| 单 LOD 不弹层级选择、加载渲染正常 | ⬜ 待人工（步骤 5） |
| Electron + 浏览器两路径生成完整目录 | ⬜ 待人工（步骤 3/7） |
| XGRIDS 工具可打开渲染 | ⬜ 待人工（步骤 6） |
| 本地化文案中英文齐全 | ✅ 自动（代码已确认） |
| ESLint 无错误、工程约定 | ✅ 自动 |
