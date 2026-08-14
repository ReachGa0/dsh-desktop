# dsh-desktop

[English](README.en.md) | [中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-43-blue)](https://www.electronjs.org/)
[![dsh](https://img.shields.io/badge/dsh-0.1.0--rc.6-purple)](https://github.com/deepseek-ai/deepseek-harness)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6)]()
[![Build](https://github.com/ReachGa0/dsh-desktop/actions/workflows/build.yml/badge.svg)](https://github.com/ReachGa0/dsh-desktop/actions)

An **Electron desktop shell** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): double-click an icon and get a standalone window running `dsh web` — no terminal, no manual commands, no browser tab juggling.

Pure shell — it **does not modify dsh itself**. The server reuses your globally installed `@deepseek-ai/dsh`.

## ✨ Features

- 🪟 **Standalone window**: native desktop window loading the Harness Web UI
- 🍱 **System tray**: closing the window minimizes to the tray; right-click to show or quit
- 🧭 **Auto environment setup**: on first launch it detects Node.js / dsh and guides a one-click install — friendly to non-technical users
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

## Screenshots

> Coming soon — feel free to submit a screenshot via PR or Issue.

## Package an installer

```sh
npm run dist
```

Output lands in `release/`: `dsh-desktop-0.1.0-setup.exe` (NSIS installer).

Custom icon: drop an `assets/icon.ico` (≥256×256) and add `"icon": "assets/icon.ico"` under `build.win` in `package.json`.

## Troubleshooting

- **Launch fails / error dialog**: check `%APPDATA%/DeepSeek Harness Desktop/dsh.log`; make sure `dsh --version` works.
- **Port already in use**: run `npm start -- --port <new-port>` instead.
- **After upgrading dsh**: just re-run `npm i -g @deepseek-ai/dsh` — the shell needs no changes.

## Contributing

Issues and PRs are welcome! The project is tiny — all the code lives in `src/`.

## License

[MIT](LICENSE)
