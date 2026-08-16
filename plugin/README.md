# dsh-desktop-windows-launcher

A [dsh](https://github.com/deepseek-ai/dsh) plugin that launches the
**[dsh-desktop](https://github.com/ReachGa0/dsh-desktop)** Windows shell from
the conversation, via a `desktop_launch` tool.

dsh-desktop is a standalone Electron desktop app around the DSH web UI —
double-click to run, region screenshot with GPU-accelerated selection that
auto-pastes into the chat, system tray, session manager, auto environment
setup. This plugin finds the installed exe and starts it; when the app is not
installed it returns the latest GitHub Release download link.

## Install

```sh
dsh plugin add dsh-desktop-windows-launcher
```

or from the repo subdirectory:

```sh
dsh plugin add github:ReachGa0/dsh-desktop#path:/plugin
```

## Usage

Ask the model to "open the desktop app" / 「打开桌面端」 — it calls
`desktop_launch`, which starts the installed app or hands back the download
link.

## Requirements

- Windows (the shell is Windows-only)
- The dsh-desktop app installed (installer from GitHub Releases), or access to
  download it

## License

MIT
