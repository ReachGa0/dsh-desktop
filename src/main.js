'use strict'

/**
 * dsh-desktop — Electron 壳，包装 DeepSeek Harness Web UI。
 *
 * 职责：
 *   1. 探测 127.0.0.1:3080 是否已有 dsh 服务在跑；
 *   2. 没有则启动全局 `dsh web --port 3080`（日志写入 userData/dsh.log）；
 *   3. 等服务就绪后打开 BrowserWindow 加载 Web UI；
 *   4. 窗口退出时，只杀掉由本壳启动的 dsh 进程树；
 *   5. 单实例锁，防止双开。
 *
 * 不修改 dsh 任何代码；服务端用全局安装的 dsh（可用 DSH_BIN 环境变量覆盖路径）。
 */

const { app, BrowserWindow, dialog, shell, Tray, Menu, nativeImage, ipcMain } = require('electron')
const { spawn, execFile } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_PORT = 3080
const START_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 500
const LOG_PREFIX = '[dsh-desktop]'

/** 解析端口：优先命令行 --port <n>，否则用默认值。 */
function resolvePort() {
  const idx = process.argv.indexOf('--port')
  if (idx !== -1 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1])
    if (Number.isInteger(n) && n > 0 && n < 65536) return n
    console.warn(LOG_PREFIX, `invalid --port value "${process.argv[idx + 1]}", fallback to ${DEFAULT_PORT}`)
  }
  return DEFAULT_PORT
}

let mainWindow = null
let ownedDsh = null // 本壳启动的 dsh 子进程；null 表示复用了外部已有服务
let tray = null // 系统托盘
let isQuitting = false // 用户从托盘选择退出时置 true，放行窗口关闭
let setupWindow = null // 首次环境引导窗口

/* ------------------------------------------------------------------ *
 * 工具：日志
 * ------------------------------------------------------------------ */

function log(...args) {
  console.log(LOG_PREFIX, ...args)
}

/* ------------------------------------------------------------------ *
 * 工具：探测 / 等待 HTTP 服务
 * ------------------------------------------------------------------ */

function probe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: timeoutMs },
      (res) => {
        res.resume()
        resolve(true)
      }
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

/** 轮询直到服务就绪或超时。 */
async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(port)) return true
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return false
}

/* ------------------------------------------------------------------ *
 * dsh 服务进程管理
 * ------------------------------------------------------------------ */

/** 解析 dsh 可执行文件：优先 DSH_BIN，否则走 PATH（Windows 下是 dsh.cmd）。 */
function resolveDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN
  // 全局 npm 安装的常见位置
  if (process.env.APPDATA) {
    const global = path.join(process.env.APPDATA, 'npm', 'dsh.cmd')
    if (fs.existsSync(global)) return global
  }
  return 'dsh.cmd'
}

/** 启动 dsh web，日志追加到 userData/dsh.log。返回子进程。 */
function startDsh(port) {
  const bin = resolveDshBin()
  const logFile = path.join(app.getPath('userData'), 'dsh.log')
  const out = fs.openSync(logFile, 'a')
  // shell:true 时把参数拼进命令字符串（参数均为常量），避免 DEP0190 警告
  const cmd = `"${bin}" web --port ${port}`
  const child = spawn(cmd, {
    shell: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: { ...process.env },
  })
  log(`spawned dsh: ${cmd} (pid ${child.pid})`)
  log(`dsh log: ${logFile}`)
  child.on('exit', (code, signal) => {
    log(`dsh exited: code=${code} signal=${signal}`)
    if (ownedDsh === child) ownedDsh = null
  })
  child.on('error', (err) => {
    log(`dsh spawn error: ${err.message}`)
  })
  return child
}

/** 杀掉进程树（Windows 用 taskkill /T 覆盖子孙进程），带超时兜底。 */
function killProcessTree(pid) {
  return new Promise((resolve) => {
    execFile(
      'taskkill',
      ['/pid', String(pid), '/T', '/F'],
      { windowsHide: true },
      () => resolve() // 无论成败都继续退出流程
    )
    setTimeout(resolve, 2000)
  })
}

async function shutdownOwnedDsh() {
  if (ownedDsh && ownedDsh.pid) {
    const pid = ownedDsh.pid
    ownedDsh = null
    await killProcessTree(pid)
    log(`killed owned dsh pid ${pid}`)
  }
}

/* ------------------------------------------------------------------ *
 * 环境检测与首次引导
 * ------------------------------------------------------------------ */

/** 执行一条命令并收集输出（Windows 下经 shell 运行，参数均为常量）。 */
function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const full = args.length ? `"${cmd}" ${args.join(' ')}` : `"${cmd}"`
    const child = spawn(full, { shell: true, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve({ code, out: out.trim() }))
  })
}

/** 检测 Node.js 与 dsh 是否可用。 */
async function checkEnvironment() {
  const node = await runCmd('node', ['--version'])
  const dshBin = resolveDshBin()
  const dsh = await runCmd(dshBin, ['--version'])
  return {
    node:
      node && node.code === 0
        ? { ok: true, version: node.out.replace(/^v/i, '') }
        : { ok: false, error: '未检测到 Node.js，请先安装（≥ 22）' },
    dsh:
      dsh && dsh.code === 0
        ? { ok: true, version: (dsh.out.split('\n')[0] || 'dsh').trim() }
        : { ok: false, error: `未检测到 dsh（${dshBin}），点击右侧按钮自动安装` },
  }
}

/** 自动安装 dsh（npm 全局安装），输出流式回传引导窗口。 */
function installDsh() {
  return new Promise((resolve) => {
    const child = spawn('npm.cmd', ['i', '-g', '@deepseek-ai/dsh'], { shell: true, windowsHide: true })
    const send = (line) => {
      if (setupWindow && !setupWindow.isDestroyed()) {
        setupWindow.webContents.send('setup:install-log', line)
      }
    }
    child.stdout.on('data', (d) => send(d.toString().trim()))
    child.stderr.on('data', (d) => send(d.toString().trim()))
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('close', (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: `npm 退出码 ${code}` })
    )
  })
}

/** 打开首次环境引导窗口；resolve('ready')=环境就绪，resolve('closed')=用户关闭。 */
function startSetupFlow() {
  return new Promise((resolve) => {
    setupWindow = new BrowserWindow({
      width: 580,
      height: 660,
      resizable: false,
      maximizable: false,
      minimizable: false,
      title: 'DeepSeek Harness 环境设置',
      autoHideMenuBar: true,
      icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'setup-preload.js'),
      },
    })
    setupWindow.setMenuBarVisibility(false)
    setupWindow.loadFile(path.join(__dirname, 'setup.html'))
    setupWindow.on('closed', () => {
      setupWindow = null
      resolve('closed')
    })

    ipcMain.removeHandler('setup:check')
    ipcMain.removeHandler('setup:install-dsh')
    ipcMain.removeHandler('setup:open-node')
    ipcMain.removeHandler('setup:open-settings')
    ipcMain.removeHandler('setup:finish')

    ipcMain.handle('setup:check', () => checkEnvironment())
    ipcMain.handle('setup:install-dsh', () => installDsh())
    ipcMain.handle('setup:open-node', () => shell.openExternal('https://nodejs.org'))
    ipcMain.handle('setup:open-settings', () => shell.openExternal('https://platform.deepseek.com'))
    ipcMain.handle('setup:finish', async () => {
      const env = await checkEnvironment()
      if (env.node.ok && env.dsh.ok) {
        if (setupWindow && !setupWindow.isDestroyed()) setupWindow.destroy()
        resolve('ready')
        return { ok: true }
      }
      return { ok: false, env }
    })
  })
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  mainWindow.loadURL(url)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // F5 刷新（Ctrl+R 由应用菜单 accelerator 提供）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F5') {
      event.preventDefault()
      mainWindow.webContents.reload()
    }
  })
  // 关窗口 → 最小化到托盘（不退出应用）；从托盘菜单选"退出"才真正退出
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow.hide()
      log('window hidden to tray')
    }
  })

  // 外部链接（非本机）用系统浏览器打开，不在壳内导航
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://127.0.0.1') || target.startsWith('http://localhost')) {
      return { action: 'allow' }
    }
    shell.openExternal(target)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault()
      shell.openExternal(target)
    }
  })
}

/* ------------------------------------------------------------------ *
 * 系统托盘
 * ------------------------------------------------------------------ */

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMainWindow },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ])
  )
  tray.on('double-click', showMainWindow)
}

function showMainWindow() {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

/* ------------------------------------------------------------------ *
 * 应用菜单（autoHideMenuBar 下按 Alt 显示；快捷键始终生效）
 * ------------------------------------------------------------------ */

function createApplicationMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '退出',
          accelerator: 'Alt+F4',
          click: () => {
            isQuitting = true
            app.quit()
          },
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '重新加载',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (mainWindow) mainWindow.webContents.reload()
          },
        },
        {
          label: '强制重新加载（清缓存）',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            if (mainWindow) mainWindow.webContents.reloadIgnoringCache()
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        {
          label: '开发者工具',
          accelerator: 'F12',
          click: () => {
            if (mainWindow) mainWindow.webContents.toggleDevTools()
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ------------------------------------------------------------------ *
 * 应用生命周期
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // 0) 环境检查：Node / dsh 缺失时先走引导窗口
    let env = await checkEnvironment()
    if (!env.node.ok || !env.dsh.ok) {
      const result = await startSetupFlow()
      if (result !== 'ready') {
        // 用户关闭引导窗口 → 退出
        app.quit()
        return
      }
      env = await checkEnvironment()
      if (!env.node.ok || !env.dsh.ok) {
        app.quit()
        return
      }
    }

    // 1) 已有服务（可能是用户手动起的 dsh web）→ 直接复用
    let port = resolvePort()
    let external = await probe(port)
    if (!external) {
      // 2) 没有 → 自己启动，等就绪
      ownedDsh = startDsh(port)
      const ready = await waitForServer(port, START_TIMEOUT_MS)
      if (!ready) {
        const logFile = path.join(app.getPath('userData'), 'dsh.log')
        dialog.showErrorBox(
          'DeepSeek Harness 启动失败',
          `dsh web 在 ${START_TIMEOUT_MS / 1000}s 内没有就绪。\n\n` +
            `日志文件：${logFile}\n\n` +
            '请确认已全局安装 dsh（npm i -g @deepseek-ai/dsh），或用 DSH_BIN 指定路径。\n' +
            `若端口 ${port} 被其他程序占用，可换端口启动：dsh-desktop --port <新端口>`
        )
        await shutdownOwnedDsh()
        app.quit()
        return
      }
    }

    createWindow(`http://127.0.0.1:${port}`)
    createTray()
    createApplicationMenu()
    // preload 注入的悬浮刷新按钮 → 重新加载页面
    ipcMain.on('dsh-desktop:reload', () => {
      if (mainWindow) mainWindow.webContents.reload()
    })
    if (external) log('reusing external dsh service on port ' + port)
  })

  // 托盘常驻：窗口关闭不退出应用；只有用户从托盘选"退出"才真正退出
  app.on('window-all-closed', () => {
    if (isQuitting) {
      shutdownOwnedDsh().finally(() => app.quit())
    }
  })

  app.on('before-quit', (event) => {
    // 防止退出竞态：先杀掉子进程再放行
    if (ownedDsh) {
      event.preventDefault()
      shutdownOwnedDsh().finally(() => app.quit())
    }
  })
}
