# Promotion Copy (English)

> For: Reddit (r/electron, r/selfhosted, r/LocalLLaMA), Hacker News, X/Twitter
> Pick a title, copy the body.

---

## Title options

1. I built an Electron shell for DeepSeek Harness — double-click to launch, no terminal needed
2. dsh-desktop: a standalone desktop window for DeepSeek Harness (dsh web)
3. Show HN: Electron wrapper that turns `dsh web` into a double-clickable desktop app

---

## Body

DeepSeek recently released [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a capable local agent workbench. The official UX is terminal + browser, which gets tedious for daily use.

So I wrapped it in an Electron shell: **[dsh-desktop](https://github.com/ReachGa0/dsh-desktop)**

Double-click → it spawns `dsh web` automatically → you get a standalone window. No terminal, no commands, no browser juggling.

**Design highlights:**

- 🧠 **Smart reuse** — reuses an already-running dsh service on :3080 instead of starting a duplicate
- 🧹 **Clean shutdown** — kills only the process tree it spawned; never an externally started service
- 🔒 **Single-instance lock** + hardened webPreferences (contextIsolation / sandbox / no nodeIntegration)
- 📦 **One-command installer** — `npm run dist` produces an NSIS setup
- 🔧 **Configurable port** — `npm start -- --port 3081` when 3080 is taken

**Pure shell, zero intrusion:** it never touches dsh's code; the server side reuses your global `@deepseek-ai/dsh`, so upgrading dsh needs no shell changes.

Tiny codebase (two source files), MIT licensed. Issues, PRs and stars are welcome ⭐

https://github.com/ReachGa0/dsh-desktop

---

## Posting tips

- **r/electron**: add a screenshot if you have one; mention Electron 43
- **Hacker News**: use title option 3 ("Show HN:"), be ready for feedback on the Electron footprint
- **X**: tag @deepseek_ai and attach a short screen recording
