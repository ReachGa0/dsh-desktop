# dsh-desktop

[中文](README.md) | [English](README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-43-blue)](https://www.electronjs.org/)
[![dsh](https://img.shields.io/badge/dsh-0.1.0--rc.6-purple)](https://github.com/deepseek-ai/deepseek-harness)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6)]()
[![Build](https://github.com/ReachGa0/dsh-desktop/actions/workflows/build.yml/badge.svg)](https://github.com/ReachGa0/dsh-desktop/actions)

DeepSeek Harness 的 **Electron 桌面壳**：双击图标，一个独立窗口运行 `dsh web` —— 不用开终端、不用敲命令、不用切浏览器。

纯壳，**不改动 dsh 本身**。服务端复用全局安装的 `@deepseek-ai/dsh`。

## ✨ 特性

- 🪟 **独立窗口**：原生桌面窗口加载 Harness Web UI，可最小化到任务栏
- 🍱 **系统托盘**：关窗口最小化到托盘常驻，右键菜单可随时显示/退出
- 🧠 **智能复用**：检测到已有的 dsh 服务就直接复用，不重复启动
- 🧹 **干净退出**：关窗口只杀自己启动的 dsh 进程，绝不误杀外部服务
- 🔒 **单实例锁**：防止双开冲突
- 🎨 **安全加固**：`contextIsolation` + `sandbox` + 禁用 Node 集成，外部链接走系统浏览器
- 📦 **一键安装包**：`npm run dist` 生成 NSIS 安装程序

## 原理

1. 启动时探测 `127.0.0.1:3080` 是否已有 dsh 服务；
2. 没有 → 自动执行 `dsh web --port 3080`（日志在 `%APPDATA%/DeepSeek Harness Desktop/dsh.log`）；
3. 就绪后打开 Electron 窗口加载 Web UI；
4. 关窗口 → 自动杀掉由本壳启动的 dsh 进程树（手动起的外部服务不会被误杀）。

## 前提

- Node.js ≥ 22（v24 验证通过）
- 全局安装 dsh：`npm i -g @deepseek-ai/dsh`（0.1.0-rc.6 验证通过）
- 如需覆盖 dsh 路径，设置环境变量 `DSH_BIN`（例如指向源码构建的 `apps/cli/src/bin.ts`）

## 安装与运行

```sh
cd Desktop\deepseek_work\dsh-desktop
npm install
npm start
```

> 国内网络下 Electron 二进制下载可能很慢或失败，用镜像：
> ```sh
> set "ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/"
> npm install
> ```

**换端口**（3080 被占用时）：

```sh
npm start -- --port 3081
```

首次打开后：**设置 → 模型 → 填入 DeepSeek API Key**，然后选择工作区即可使用。

## 截图

> 敬请期待 —— 欢迎提交你的界面截图（PR 或 Issue 均可）。

## 打包成安装程序

```sh
npm run dist
```

产物在 `release/` 下：`dsh-desktop-0.1.0-setup.exe`（NSIS 安装包）。

自定义图标：放一个 `assets/icon.ico`（≥256×256），并在 `package.json` 的 `build.win` 里加 `"icon": "assets/icon.ico"`。

## 常见问题

- **启动失败弹窗**：看 `%APPDATA%/DeepSeek Harness Desktop/dsh.log`；确认 `dsh --version` 可用。
- **端口被占**：用 `npm start -- --port <新端口>` 换一个端口即可。
- **改了 dsh 版本**：重新 `npm i -g @deepseek-ai/dsh` 即可，壳无需改动。

## 贡献

欢迎提 Issue 和 PR！项目很小，代码都在 `src/` 里，容易上手。

## License

[MIT](LICENSE)
