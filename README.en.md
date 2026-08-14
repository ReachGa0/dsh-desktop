# dsh-desktop

[English](README.en.md) | [中文](README.md)

An Electron desktop shell for **DeepSeek Harness**: open a standalone window that runs `dsh web` — no terminal, no manual commands, no browser tab juggling.

Pure shell — it **does not modify dsh itself**. The server reuses your globally installed `@deepseek-ai/dsh`.

## How it works

1. On startup, probes whether a dsh service is already listening on `127.0.0.1:3080`;
2. If not, spawns `dsh web --port 3080` automatically (logs to `%APPDATA%/DeepSeek Harness Desktop/dsh.log`);
3. Once ready, opens an Electron window loading the Web UI;
4. When the window closes, kills only the dsh process tree it started (an externally started service is never touched).

## Prerequisites

- Node.js ≥ 22 (v24 verified on our dev machine)
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

On first launch: go to **Settings → Models**, enter your DeepSeek API Key, then pick a workspace.

## Package an installer

```sh
npm run dist
```

Output lands in `release/`: `dsh-desktop-0.1.0-setup.exe` (NSIS installer).

Custom icon: drop an `assets/icon.ico` (≥256×256) and add `"icon": "assets/icon.ico"` under `build.win` in `package.json`.

## Troubleshooting

- **Launch fails / error dialog**: check `%APPDATA%/DeepSeek Harness Desktop/dsh.log`; make sure `dsh --version` works.
- **Port already in use**: the shell currently fixes port 3080 (dsh's default). You can change `DEFAULT_PORT` in `src/main.js`.
- **After upgrading dsh**: just re-run `npm i -g @deepseek-ai/dsh` — the shell needs no changes.
