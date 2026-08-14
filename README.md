# dsh-desktop

[中文](README.md) | [English](README.en.md)

DeepSeek Harness 的 Electron 桌面壳：打开一个独立窗口运行 `dsh web`，不用每次开终端、敲命令、再切浏览器。

纯壳，**不改动 dsh 本身**。服务端复用全局安装的 `@deepseek-ai/dsh`。

## 原理

1. 启动时探测 `127.0.0.1:3080` 是否已有 dsh 服务；
2. 没有 → 自动执行 `dsh web --port 3080`（日志在 `%APPDATA%/DeepSeek Harness Desktop/dsh.log`）；
3. 就绪后打开 Electron 窗口加载 Web UI；
4. 关窗口 → 自动杀掉由本壳启动的 dsh 进程树（手动起的外部服务不会被误杀）。

## 前提

- Node.js ≥ 22（本机 v24 满足）
- 全局安装 dsh：`npm i -g @deepseek-ai/dsh`（本机已有 0.1.0-rc.6）
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

首次打开后：**设置 → 模型 → 填入 DeepSeek API Key**，然后选择工作区即可使用。

## 打包成安装程序

```sh
npm run dist
```

产物在 `release/` 下：`dsh-desktop-0.1.0-setup.exe`（NSIS 安装包）。

自定义图标：放一个 `assets/icon.ico`（≥256×256），并在 `package.json` 的 `build.win` 里加 `"icon": "assets/icon.ico"`。

## 常见问题

- **启动失败弹窗**：看 `%APPDATA%/DeepSeek Harness Desktop/dsh.log`；确认 `dsh --version` 可用。
- **端口被占**：如果 3080 被别的程序占用，目前壳固定用 3080（与 dsh 默认一致）。可自行改 `src/main.js` 里的 `DEFAULT_PORT`。
- **改了 dsh 版本**：重新 `npm i -g @deepseek-ai/dsh` 即可，壳无需改动。