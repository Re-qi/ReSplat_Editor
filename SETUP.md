# ReSplat 本地开发环境配置指南

## 环境要求

- [Node.js](https://nodejs.org/) >= 20.19.0

## 安装步骤

### 1. 安装依赖

在项目根目录下执行：

```sh
npm install
```

### 2. 启动开发服务器

```sh
npm run develop
```

该命令会同时启动两个进程：

- **Rollup 编译** — 监听源代码变动并自动重新构建
- **静态文件服务器** — 在 `http://localhost:3000` 提供页面访问

看到以下输出即表示启动成功：

```
INFO  Accepting connections at http://localhost:3000
created dist in ...s
```

### 3. 打开页面

在浏览器中访问：

```
http://localhost:3000
```

## 日常开发流程

1. 确保开发服务器正在运行（`npm run develop`）
2. 编辑 `src/` 目录下的 TypeScript 或 SCSS 文件
3. Rollup 会自动检测变更并重新编译，终端会显示 `created dist in ...s`
4. **刷新浏览器页面** 即可看到修改效果

## 常见问题

### Service Worker 缓存导致页面不更新

ReSplat 使用了 Service Worker 进行缓存。如果修改代码后发现页面没有更新，请执行**强制刷新**：

| 操作系统 | 快捷键 |
|---------|--------|
| Windows / Linux | `Ctrl + Shift + R` 或 `Ctrl + F5` |
| macOS | `Cmd + Shift + R` |

或者在浏览器开发者工具中：

1. 按 `F12` 打开开发者工具
2. 右键点击刷新按钮 → **清空缓存并硬性重新加载**

### 修改 SCSS 后样式未更新

Rollup 只有在检测到文件变化时才会重新编译。如果 SCSS 没有变化但需要重编，可以：
- 手动修改任意文件让 Rollup 触发重新编译，然后刷新浏览器

### 端口被占用

默认端口为 3000。如果该端口已被占用，可以修改 `serve` 命令指定其他端口：

```sh
npx serve dist -C -l 3001
```

## 快速命令参考

| 命令 | 说明 |
|------|------|
| `npm run develop` | 启动开发服务器（构建 + 热重载） |
| `npm run build` | 仅构建生产版本 |
| `npm run watch` | 仅监听并重新编译 |
| `npm run serve` | 仅启动静态文件服务器 |
| `npm run lint` | 运行 ESLint 代码检查 |
