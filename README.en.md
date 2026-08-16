# dsh-desktop

[English](README.en.md) | [中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-43-blue)](https://www.electronjs.org/)
[![dsh](https://img.shields.io/badge/dsh-0.1.0--rc.6-purple)](https://github.com/deepseek-ai/deepseek-harness)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6)]()
[![Build](https://github.com/ReachGa0/dsh-desktop/actions/workflows/build.yml/badge.svg)](https://github.com/ReachGa0/dsh-desktop/actions)
[![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-listed-8A2BE2)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

An **Electron desktop shell** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): double-click an icon and get a standalone window running `dsh web` — no terminal, no manual commands, no browser tab juggling. **Region screenshot to ask the AI**, system tray, session manager, auto environment setup.

Pure shell — it **does not modify dsh itself**. The server reuses your globally installed `@deepseek-ai/dsh`.

## ✨ Features

- 📸 **Region screenshot → ask AI**: one-click capture → full-screen overlay with real-time selection (GPU-accelerated, 8-direction handles to fine-tune) → auto-pastes into the chat → the AI answers from the image; the chat window hides itself during capture
- 🗂️ **Session manager**: `Alt → File → Session Manager…` lists every session, delete with one click (permanently removes chat history)
- 🪟 **Standalone window**: native desktop window loading the Harness Web UI
- 🍱 **System tray**: closing the window minimizes to the tray; right-click to show or quit
- 🔄 **Easy reload**: `F5` / `Ctrl+R` / floating button — load new plugins without restarting the window
- 🧭 **Auto environment setup**: on first launch it detects Node.js / dsh and guides a one-click install — friendly to non-technical users
- 🔧 **Configurable port**: `npm start -- --port 3081` when 3080 is taken
- 🧠 **Smart reuse**: reuses an already-running dsh service instead of starting a duplicate
- 🧹 **Clean shutdown**: only kills the dsh process tree it started — never an external service
- 🔒 **Single instance**: prevents double-launch conflicts
- 🎨 **Hardened**: `contextIsolation` + `sandbox` + no Node integration; external links open in your system browser
- 📦 **One-click installer**: `npm run dist` produces an NSIS setup

## How it works

1. On startup, probes whether a dsh service is already listening on `127.0.0.1:3080`;
2. If not, spawns `dsh web --port 3080` automatically (logs to `%APPDATA%/DeepSeek Harness Desktop/dsh.log`);
3. Once ready, opens an Electron window loading the Web UI;
4. When the window closes, kills only the dsh process tree it started (an externally started service is never touched).

## 📸 Region screenshot

1. Click the **📸** button (bottom-right) — the chat window auto-hides
2. **Drag to select** an area on the full-screen overlay (live preview; drag the 8 handles to fine-tune after drawing)
3. Click **✔ OK** (or double-click / Enter) — the chat window restores
4. The screenshot lands in the chat box automatically → type a question → the AI answers from the image

> Pair with a vision bridge like [ModLens](https://www.npmjs.com/package/@liustack/modlens) so text-only DeepSeek models can read images too.

## Prerequisites

- Node.js ≥ 22 (v24 verified)
- Globally installed dsh: `npm i -g @deepseek-ai/dsh` (0.1.0-rc.6 verified)
- To override the dsh binary path, set the `DSH_BIN` environment variable (e.g. point it at a source build of `apps/cli/src/bin.ts`)

## Install & run

```sh
cd dsh-desktop
npm install
npm start
```

> If the Electron binary download is slow or fails (common on some networks), use a mirror:
> ```sh
> set "ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/"
> npm install
> ```

**Use a different port** (when 3080 is taken):

```sh
npm start -- --port 3081
```

On first launch: go to **Settings → Models**, enter your DeepSeek API Key, then pick a workspace.

## Package an installer

```sh
npm run dist
```

Output lands in `release/`: `dsh-desktop-<version>-setup.exe` (NSIS installer).

Custom icon: drop an `assets/icon.ico` (≥256×256) and add `"icon": "assets/icon.ico"` under `build.win` in `package.json`.

## Troubleshooting

- **Launch fails / error dialog**: check `%APPDATA%/DeepSeek Harness Desktop/dsh.log`; make sure `dsh --version` works.
- **Port already in use**: run `npm start -- --port <new-port>` instead.
- **After upgrading dsh**: just re-run `npm i -g @deepseek-ai/dsh` — the shell needs no changes.
- **Screenshot not in the chat box**: click the input and press `Ctrl+V` (the image is already on your clipboard).
- **Closing the window doesn't quit**: that's the tray — right-click the tray icon and choose "Quit".

## Contributing

Issues and PRs are welcome! The project is tiny — all the code lives in `src/`.

## License

[MIT](LICENSE)
