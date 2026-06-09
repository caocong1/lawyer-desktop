# QWEN.md

## Project Overview

**lawyer-desktop** 是一个基于 Tauri v2 的桌面应用程序，采用 SolidJS 作为前端框架，Rust 作为后端。项目当前处于初始脚手架阶段，使用官方 `create-tauri-app` 模板生成。

### Tech Stack

| 层级 | 技术 |
|------|------|
| 前端框架 | SolidJS 1.9+ (JSX, signals) |
| 前端语言 | TypeScript 5.6 (strict mode) |
| 构建工具 | Vite 6 |
| 桌面框架 | Tauri 2 |
| 后端语言 | Rust (edition 2021) |
| 包管理器 | Bun |

### Architecture

- **前端** (`src/`) — SolidJS SPA，通过 `@tauri-apps/api` 的 `invoke` 调用 Rust 后端命令
- **后端** (`src-tauri/`) — Rust 应用，通过 `#[tauri::command]` 暴露函数给前端调用
- 前端开发服务器运行在 `localhost:1420`（固定端口）
- 应用标识符：`com.sorawatcher.lawyer-desktop`

## Building and Running

### 开发

```bash
# 启动 Tauri 开发模式（同时启动 Vite 前端 + Rust 后端）
bun run tauri dev

# 仅启动前端 Vite 开发服务器（不含 Rust 后端）
bun run dev
```

### 构建

```bash
# 构建前端
bun run build

# 构建生产版本桌面应用（含 Rust 编译）
bun run tauri build
```

### 预览

```bash
bun run serve
```

## Development Conventions

### TypeScript

- 严格模式已启用（`strict: true`）
- 禁止未使用的局部变量和参数（`noUnusedLocals`, `noUnusedParameters`）
- JSX 使用 `solid-js` 作为 `jsxImportSource`
- 模块解析模式：`bundler`

### Frontend (SolidJS)

- 使用函数式组件 + Signals（`createSignal`）进行状态管理
- 样式文件与组件并列放置（如 `App.tsx` + `App.css`）
- 入口文件：`src/index.tsx`，挂载到 `#root` 元素

### Backend (Rust)

- 库入口：`src-tauri/src/lib.rs`（注册 Tauri commands 和插件）
- 二进制入口：`src-tauri/src/main.rs`（仅调用 `lib::run()`）
- 新增 Tauri command 需在 `lib.rs` 中用 `#[tauri::command]` 定义，并在 `invoke_handler` 中注册

### Recommended IDE

- VS Code + [Tauri extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
