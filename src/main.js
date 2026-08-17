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

const { app, BrowserWindow, dialog, shell, Tray, Menu, nativeImage, ipcMain, desktopCapturer, clipboard, screen } = require('electron')
const { spawn, execFile } = require('node:child_process')
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

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
let sessionsWin = null // 会话管理窗口
let shotWindow = null // 选区截图窗口
let pendingShot = null // 全屏截图（nativeImage），选区确认后裁剪

/* ------------------------------------------------------------------ *
 * 工具：日志
 * ------------------------------------------------------------------ */

function log(...args) {
  console.log(LOG_PREFIX, ...args)
}

/** 截图流程日志（追加写入 ~/.dsh/logs/screenshot.log，便于诊断）。 */
function shotLog(...args) {
  try {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}`
    console.log('[shot]', ...args)
    fs.appendFileSync(path.join(os.homedir(), '.dsh', 'logs', 'screenshot.log'), line + '\n')
  } catch { /* 忽略日志错误 */ }
}

/* ------------------------------------------------------------------ *
 * 自动更新检查（启动时异步检测 GitHub Releases 最新版）
 * ------------------------------------------------------------------ */

const REPO = 'ReachGa0/dsh-desktop'
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
const UPDATE_CHECK_TIMEOUT_MS = 10_000

/** GET 一个 JSON（带超时与 UA，GitHub API 要求 UA）。resolve null 表示失败。 */
function fetchJson(url) {
  return new Promise((resolve) => {
    // 首次用系统证书；代理/反代环境证书校验可能失败，降级为不校验重试一次
    // （仅更新检查用，不降低应用其他部分的安全级别）
    const attempt = (rejectUnauthorized) => {
      const req = https.get(
        url,
        { headers: { 'User-Agent': 'dsh-desktop-update-check', Accept: 'application/vnd.github+json' }, timeout: UPDATE_CHECK_TIMEOUT_MS, rejectUnauthorized },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume()
            resolve(null)
            return
          }
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (d) => (body += d))
          res.on('end', () => {
            try { resolve(JSON.parse(body)) } catch { resolve(null) }
          })
        }
      )
      req.on('timeout', () => req.destroy())
      req.on('error', () => {
        // 证书类错误：再试一次宽松模式；其他错误直接放弃
        if (rejectUnauthorized) attempt(false)
        else resolve(null)
      })
    }
    attempt(true)
  })
}

/** 解析语义化版本号 → [major, minor, patch]，失败返回 null。 */
function parseVersion(v) {
  if (typeof v !== 'string') return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** a 比 b 新？都解析失败时返回 false（宁可漏报不可误报）。 */
function isNewer(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i]
  }
  return false
}

/**
 * 检查更新：查询 GitHub Releases 最新版，若比当前版本新则弹窗提示。
 * 全程静默失败（网络不通 / 解析失败 / 无新版都不打扰用户）。
 */
async function checkForUpdates() {
  const current = app.getVersion()
  try {
    const release = await fetchJson(RELEASES_URL)
    if (!release) {
      log('update check: no release data (offline or API error)')
      return
    }
    const latest = release.tag_name
    log(`update check: current=${current} latest=${latest}`)
    if (!isNewer(latest, current)) return
    const name = release.name && release.name !== latest ? `「${release.name}」` : ''
    const detail = (release.body || '').split('\n').slice(0, 6).join('\n').trim()
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'info',
      title: '发现新版本',
      message: `DeepSeek Harness Desktop 有新版本可用（${latest} ${name}）`,
      detail: detail ? `更新内容：\n${detail}\n\n当前版本：${current}` : `当前版本：${current}`,
      buttons: ['前往下载', '以后再说'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (response === 0) {
      shell.openExternal(RELEASES_PAGE)
    }
  } catch (e) {
    log('update check failed:', e && e.message)
  }
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

// 主动关停 dsh 时的标记（杀进程也会触发 exit，需区分「主动关」和「意外崩」）
let isShuttingDownDsh = false
// 已自动重启过一次的标志（同一次会话最多自愈一次，避免崩溃循环）
let didAutoRestartDsh = false

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
    if (ownedDsh !== child) return
    ownedDsh = null
    // 崩溃自愈：本壳启动的 dsh 意外退出（非主动关闭/非退出中）时自动重启一次
    if (!isQuitting && !isShuttingDownDsh) {
      restartOwnedDsh(port, code)
    }
  })
  child.on('error', (err) => {
    log(`dsh spawn error: ${err.message}`)
  })
  return child
}

/** dsh 意外退出后自动重启一次；二次退出则提示用户并放弃。 */
function restartOwnedDsh(port, exitCode) {
  if (didAutoRestartDsh) {
    log('dsh crashed again after auto-restart; giving up')
    const logFile = path.join(app.getPath('userData'), 'dsh.log')
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'error',
      title: 'dsh 服务异常',
      message: 'dsh 服务启动后再次退出，已停止自动重启。',
      detail: `退出码：${exitCode ?? '未知'}\n\n日志文件：${logFile}\n\n请查看日志定位问题，或手动在终端运行 dsh web 排查。`,
      buttons: ['打开日志目录', '知道了'],
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) shell.showItemInFolder(logFile)
    })
    return
  }
  log(`dsh exited unexpectedly (code=${exitCode}); restarting in 3s…`)
  didAutoRestartDsh = true
  setTimeout(() => {
    if (isQuitting) return
    // 重启前再确认端口没有被外部服务接管（避免重复启动）
    probe(port).then((up) => {
      if (up) {
        log('port already serving after crash; not restarting')
        return
      }
      const child = startDsh(port)
      ownedDsh = child
      // 等它就绪；若起不来则等 exit 回调里的二次提示
      waitForServer(port, START_TIMEOUT_MS).then((ready) => {
        if (ready) {
          log('dsh auto-restarted successfully')
          dialog.showMessageBox(mainWindow || undefined, {
            type: 'info',
            title: 'dsh 已自动重启',
            message: 'dsh 服务意外退出，已自动恢复。',
            buttons: ['好'],
            noLink: true,
          }).catch(() => {})
        }
      })
    })
  }, 3000)
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
    isShuttingDownDsh = true
    await killProcessTree(pid)
    log(`killed owned dsh pid ${pid}`)
  }
}

/**
 * 重启 dsh 服务：杀掉当前由本壳启动的 dsh → 重新拉起 → 等就绪 → 刷新页面。
 * 供「重启 dsh 服务」菜单/托盘项使用（后端插件/服务改动后需要）。
 */
async function restartDshService() {
  if (!ownedDsh) {
    log('restart: no owned dsh to restart')
    // 没有自管的 dsh（可能复用了外部服务）→ 无法安全重启，提示用户
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'info',
      title: '无法重启',
      message: '当前使用的是外部已有的 dsh 服务，不是本应用启动的，无法从这里重启。',
      detail: '请在外部终端手动重启该服务，然后刷新页面（F5）。',
      buttons: ['好'],
      noLink: true,
    })
    return
  }
  const port = resolvePort()
  log(`restart: restarting dsh service on port ${port}…`)
  // 先停（标记主动关停，避免触发崩溃自愈逻辑）
  await shutdownOwnedDsh()
  isShuttingDownDsh = false // 重置，让后续退出能触发自愈
  // 重新启动
  ownedDsh = startDsh(port)
  const ready = await waitForServer(port, START_TIMEOUT_MS)
  if (!ready) {
    log('restart: dsh failed to come back')
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'error',
      title: '重启失败',
      message: 'dsh 服务重启后未在预期时间内就绪。',
      detail: `日志文件：${path.join(app.getPath('userData'), 'dsh.log')}`,
      buttons: ['好'],
      noLink: true,
    })
    return
  }
  log('restart: dsh back up; reloading window')
  // 等页面也能加载后刷新
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`http://127.0.0.1:${port}`)
  }
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    title: 'dsh 服务已重启',
    message: 'dsh 服务已重启完成，页面已刷新。',
    buttons: ['好'],
    noLink: true,
  }).catch(() => {})
}

/* ------------------------------------------------------------------ *
 * 会话管理（读取/删除 ~/.dsh/sessions 下的会话）
 * ------------------------------------------------------------------ */

function sessionsRoot() {
  return path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'sessions')
}

/** 将工作区目录名（--C-Users-...-- 编码）还原为可读路径。 */
function decodeWorkspaceName(name) {
  let s = name
  if (s.startsWith('--')) s = s.slice(2)
  if (s.endsWith('--')) s = s.slice(0, -2)
  s = s.replace(/-/g, '\\')
  s = s.replace(/^C\\/, 'C:\\')
  return s
}

/** 列出所有会话。 */
function listSessions() {
  const root = sessionsRoot()
  const list = []
  if (!fs.existsSync(root)) return list
  const workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const ws of workspaces) {
    const wsPath = path.join(root, ws.name)
    const sDirs = fs.readdirSync(wsPath, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('session-'))
    for (const s of sDirs) {
      const sPath = path.join(wsPath, s.name)
      const stat = fs.statSync(sPath)
      let sizeBytes = 0
      const walk = (dir) => {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, f.name)
          if (f.isDirectory()) walk(fp)
          else sizeBytes += fs.statSync(fp).size
        }
      }
      try { walk(sPath) } catch { /* ignore */ }
      list.push({
        id: s.name,
        workspace: decodeWorkspaceName(ws.name),
        modified: stat.mtimeMs,
        sizeKB: Math.round(sizeBytes / 1024),
      })
    }
  }
  return list.sort((a, b) => b.modified - a.modified)
}

/** 删除指定会话（按 id 定位目录并递归删除）。 */
function deleteSession(id) {
  const root = sessionsRoot()
  if (!fs.existsSync(root) || !/^session-[0-9a-f-]+$/i.test(id)) return { ok: false, error: '非法会话 ID' }
  const workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const ws of workspaces) {
    const target = path.join(root, ws.name, id)
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true })
        log(`deleted session ${id} (${ws.name})`)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    }
  }
  return { ok: false, error: '未找到该会话' }
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

/** 打开会话管理窗口。 */
function openSessionsWindow() {
  if (sessionsWin && !sessionsWin.isDestroyed()) {
    sessionsWin.focus()
    return
  }
  sessionsWin = new BrowserWindow({
    width: 620,
    height: 680,
    title: '会话管理 — DeepSeek Harness Desktop',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'sessions-preload.js'),
    },
  })
  sessionsWin.setMenuBarVisibility(false)
  sessionsWin.loadFile(path.join(__dirname, 'sessions.html'))
  sessionsWin.on('closed', () => {
    sessionsWin = null
  })

  ipcMain.removeHandler('sessions:list')
  ipcMain.removeHandler('sessions:remove')
  ipcMain.handle('sessions:list', () => listSessions())
  ipcMain.handle('sessions:remove', (_e, id) => deleteSession(id))
}

/* ------------------------------------------------------------------ *
 * 选区截图窗口
 * ------------------------------------------------------------------ */

function openShotWindow() {
  if (shotWindow && !shotWindow.isDestroyed()) {
    shotWindow.focus()
    return
  }
  // 用显示器精确尺寸铺满屏幕（不用 fullscreen，Windows 上更可靠）
  const display = screen.getPrimaryDisplay()
  const bounds = display.bounds
  shotWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false, // 截图加载完成后再显示，避免黑屏闪烁
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'screenshot-preload.js'),
    },
  })
  shotWindow.setAlwaysOnTop(true, 'screen-saver')
  shotWindow.setBounds(bounds) // 再次确保铺满
  shotWindow.loadFile(path.join(__dirname, 'screenshot.html'))
  shotWindow.webContents.once('did-finish-load', () => {
    if (pendingShot && !shotWindow.isDestroyed()) {
      shotWindow.webContents.send('screenshot:data', pendingShot.toDataURL())
      shotLog('shot: data sent to selector window')
    }
  })
  shotWindow.on('closed', () => {
    shotWindow = null
  })
}

// 截图在选区窗口内加载完成 → 再显示窗口（避免黑屏"小窗口"）
function onShotLoaded() {
  if (shotWindow && !shotWindow.isDestroyed()) {
    shotWindow.show()
    shotWindow.focus()
  }
}

/** 选区确认：裁剪 → 剪贴板 → 恢复主窗口并粘贴。 */
function onShotDone(rect) {
  shotLog('shot: done called', rect ? JSON.stringify(rect) : 'null')
  const image = pendingShot
  pendingShot = null
  if (shotWindow && !shotWindow.isDestroyed()) shotWindow.destroy()
  showMainWindow() // 恢复显示聊天窗口
  if (!image || !rect) {
    shotLog('shot: done skipped (no image or rect)')
    return
  }
  const sf = screen.getPrimaryDisplay().scaleFactor || 1
  const r = {
    x: Math.round(rect.x * sf),
    y: Math.round(rect.y * sf),
    width: Math.round(rect.w * sf),
    height: Math.round(rect.h * sf),
  }
  if (r.width <= 0 || r.height <= 0) {
    shotLog('shot: invalid crop rect after scale')
    return
  }
  const cropped = image.crop(r)
  shotLog('shot: cropped', cropped.getSize().width + 'x' + cropped.getSize().height)
  // 保存到 ~/.dsh/screenshots/（持久保存，方便回顾；同时写剪贴板）
  try {
    const dir = path.join(os.homedir(), '.dsh', 'screenshots')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    fs.writeFileSync(file, cropped.toPNG())
    shotLog('shot: saved', file)
  } catch (e) {
    shotLog('shot: save failed', String(e && e.message || e))
  }
  clipboard.writeImage(cropped)
  shotLog('shot: written to clipboard')
  // 等主窗口就绪后尝试自动粘贴；若聚焦失败则提示手动 Ctrl+V
  if (mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(async () => {
      let focused = false
      try {
        focused = await mainWindow.webContents.executeJavaScript(
          `(() => { const el = document.querySelector('textarea, [contenteditable="true"]'); if (el) { el.focus(); return true } return false })()`
        )
      } catch {
        focused = false
      }
      if (focused) {
        mainWindow.webContents.paste()
      } else {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          message: '截图已复制到剪贴板，请在聊天输入框按 Ctrl+V 粘贴',
          buttons: ['好'],
        })
      }
    }, 400)
  }
}

function onShotCancel() {
  pendingShot = null
  if (shotWindow && !shotWindow.isDestroyed()) shotWindow.destroy()
  showMainWindow() // 恢复显示聊天窗口
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
        label: '打开截图目录',
        click: () => {
          const dir = path.join(os.homedir(), '.dsh', 'screenshots')
          fs.mkdirSync(dir, { recursive: true })
          shell.openPath(dir)
        },
      },
      {
        label: '重启 dsh 服务',
        click: () => { restartDshService() },
      },
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
          label: '会话管理…',
          click: () => openSessionsWindow(),
        },
        {
          label: '重启 dsh 服务…',
          click: () => restartDshService(),
        },
        { type: 'separator' },
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

// Windows 任务栏固定/通知规范：AppUserModelID 与打包 appId 保持一致
app.setAppUserModelId('com.dsh.desktop')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 窗口可能隐藏到了托盘：必须 show() 才能从任务栏图标唤起
    if (mainWindow) {
      mainWindow.show()
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
    // 自动更新检查：不阻塞启动，静默失败
    checkForUpdates()
    // preload 注入的悬浮刷新按钮 → 重新加载页面
    ipcMain.on('dsh-desktop:reload', () => {
      if (mainWindow) mainWindow.webContents.reload()
    })
    // 选区截图：隐藏主窗口 → 截全屏 → 选区窗口 → 裁剪 → 剪贴板 → 粘贴
    ipcMain.handle('dsh-desktop:capture', async () => {
      shotLog('capture: requested')
      try {
        // 先隐藏主窗口，避免截到聊天框本身
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
        await new Promise((r) => setTimeout(r, 250))
        const display = screen.getPrimaryDisplay()
        const sf = display.scaleFactor || 1
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: {
            width: Math.round(display.size.width * sf),
            height: Math.round(display.size.height * sf),
          },
        })
        if (!sources.length) {
          showMainWindow()
          shotLog('capture: no screen source')
          return { ok: false, error: '未找到屏幕源' }
        }
        pendingShot = sources[0].thumbnail
        if (pendingShot.isEmpty()) {
          showMainWindow()
          shotLog('capture: empty thumbnail')
          return { ok: false, error: '截图为空' }
        }
        shotLog('capture: captured', pendingShot.getSize().width + 'x' + pendingShot.getSize().height)
        openShotWindow()
        return { ok: true }
      } catch (e) {
        showMainWindow()
        shotLog('capture: error', String((e && e.message) || e))
        return { ok: false, error: String((e && e.message) || e) }
      }
    })
    // 轻提示（截图失败等）
    ipcMain.on('dsh-desktop:toast', (_e, msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, { type: 'info', message: String(msg), buttons: ['好'] })
      }
    })
    // 选区截图结果
    ipcMain.on('screenshot:done', (_e, rect) => onShotDone(rect))
    ipcMain.on('screenshot:cancel', () => onShotCancel())
    ipcMain.on('screenshot:loaded', () => onShotLoaded())
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
