'use strict'

/**
 * dsh-desktop — Electron 壳，包装 DeepSeek Harness Web UI。
 *
 * 双模式：
 *   - 本机模式（默认）：探测 127.0.0.1:3080 是否已有 dsh 服务在跑；
 *     没有则启动全局 `dsh web --port 3080`（日志写入 userData/dsh.log）；
 *     等服务就绪后打开 BrowserWindow 加载 Web UI；窗口退出时只杀掉由本壳
 *     启动的 dsh 进程树；首次环境缺失时走引导窗口。
 *   - 远程模式（可选）：DSH 跑在远程服务器（NAS / Docker / 内网主机等），
 *     壳作为纯客户端连接任意 http(s) 地址；隐藏本机管理项（会话管理、
 *     重启服务、DSH 更新），断线自动回退连接页。
 *
 * 连接逻辑：
 *   - 目标地址优先级：命令行 --url > 配置文件（userData/config.json 记住上次）
 *   - 首次使用（无保存地址）显示连接页：可选择「本机连接」或输入远程地址；
 *     选「本机连接」完全走上方本机模式流程，现有本地用户零感知
 *   - 远程地址智能补全：局域网 IP / loopback 补 http://，域名补 https://
 *   - 服务器不可达时回到连接页离线模式，可勾选每 8 秒自动重试；
 *     运行中页面加载失败（断网/关机）也自动回到连接页
 *
 * DSH 主动更新（本机模式，仅对由本壳启动的 dsh 生效）：
 *   - 检查 npm 最新版 → 弹窗确认 → npm install -g → 重启托管的 dsh 进程
 *     → 轮询端口就绪 → 自动重连；也可从托盘 / 文件菜单手动触发。
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
const PROBE_URL_TIMEOUT_MS = 5_000

let mainWindow = null
let ownedDsh = null // 本壳启动的 dsh 子进程；null 表示复用了外部已有服务
let tray = null // 系统托盘
let isQuitting = false // 用户从托盘选择退出时置 true，放行窗口关闭
let setupWindow = null // 首次环境引导窗口
let sessionsWin = null // 会话管理窗口
let shotWindow = null // 选区截图窗口
let pendingShot = null // 全屏截图（nativeImage），选区确认后裁剪

/** 当前 DSH 目标（规范化后的完整 URL）；空串表示尚未连接。 */
let target = ''
/** 目标是否为本机（loopback），决定是否展示本机管理功能。 */
let targetIsLocal = false
/** 目标的 HTTP Basic Auth 凭据（从 URL 内嵌提取，如 https://user:pass@host/）；无则 null。 */
let basicAuth = null
/** 连接页当前状态，由 preload 的 file:// 分支经 IPC 读取。 */
let connectState = { mode: 'first', url: '', error: '' }

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
 * 目标地址：解析 / 规范化 / 持久化
 * ------------------------------------------------------------------ */

function hostOf(urlStr) {
  try { return new URL(urlStr).host } catch { return urlStr }
}

function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
}

/**
 * 把用户输入规范成完整 URL：
 *   已带协议           → 原样采用
 *   loopback/内网地址   → 补 http://（局域网自建服务几乎都是明文）
 *   其他（域名等）      → 补 https://（公网默认走加密）
 * 非法输入返回 null。
 * 支持 URL 内嵌 HTTP Basic Auth（https://user:pass@host/）：凭据提取进
 * basicAuth（不进 target，避免泄漏到日志/标题），加载时经 app.on('login')
 * 自动回填；无内嵌凭据时不改动现有 basicAuth（启动恢复场景需要保留）。
 */
function normalizeTarget(raw) {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (!s) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const head = s.split(/[/?#]/)[0]
    const insecure = /^(localhost|127\.|::1|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(head)
    s = (insecure ? 'http://' : 'https://') + s
  }
  try {
    const u = new URL(s)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null
    if (u.username || u.password) {
      basicAuth = {
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
      }
      u.username = ''
      u.password = ''
      return u.toString().replace(/\/$/, '')
    }
    return u.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json')
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch { return {} }
}

function saveConfig(patch) {
  try {
    const next = Object.assign(loadConfig(), patch)
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2))
  } catch (e) { log('save config failed:', e && e.message) }
}

/** 命令行目标：--url <u>（临时生效，不覆盖已保存配置）。--port <n> 仍由 resolvePort() 处理。 */
function resolveCliUrl() {
  const iu = process.argv.indexOf('--url')
  if (iu !== -1 && process.argv[iu + 1]) return process.argv[iu + 1]
  return null
}

/** 应用新目标并按需持久化（凭据与目标成对保存，存在 userData/config.json 本机私有目录）。 */
function applyTarget(urlStr, { persist = true } = {}) {
  target = urlStr
  targetIsLocal = isLocalHost(new URL(urlStr).hostname)
  if (persist) {
    saveConfig({
      url: urlStr,
      // 显式写 null 以覆盖旧凭据（切换到无凭据地址时清掉）
      ...(basicAuth ? { basicAuth } : { basicAuth: null }),
      savedAt: new Date().toISOString(),
    })
  }
  log(`target: ${target} (local=${targetIsLocal}${basicAuth ? ', basicAuth=yes' : ''})`)
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

/** 解析语义化版本号（含可选预发布段 -rc.N / -beta.1 / -alpha 等，如 0.1.1-rc.2）。 */
function parseVersion(v) {
  if (typeof v !== 'string') return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z]+)\.?(\d+)?)?(?:[-+.].*)?$/.exec(v.trim())
  if (!m) return null
  const preRank = m[4] ? { alpha: 0, beta: 1, rc: 2 }[m[4].toLowerCase()] ?? -1 : Infinity
  return [Number(m[1]), Number(m[2]), Number(m[3]), preRank, m[5] ? Number(m[5]) : 0]
}

/** a 比 b 新？都解析失败时返回 false（宁可漏报不可误报）。 */
function isNewer(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return false
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i]
  }
  return false
}

/** 检查更新：查询 GitHub Releases 最新版，若比当前版本新则弹窗提示。
 * 全程静默失败（网络不通 / 解析失败 / 无新版都不打扰用户）。每次会话最多检查一次。 */
let didCheckAppUpdate = false
function checkForUpdatesOnce() {
  if (didCheckAppUpdate) return
  didCheckAppUpdate = true
  checkForUpdates()
}

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

/** 探测本机端口是否有 dsh 服务（轮询等待用）。 */
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

/**
 * 探测一个 http(s) 地址是否可达（远程目标用；任何 HTTP 响应都算活着，
 * 包括网关 401 等）。自签名证书的内网服务放宽 TLS 校验重试一次。
 */
function probeUrl(urlStr, timeoutMs = PROBE_URL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const attempt = (allowBadTls) => {
      let u
      try { u = new URL(urlStr) } catch { return done(false) }
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.get(u, { timeout: timeoutMs, rejectUnauthorized: !allowBadTls }, (res) => {
        res.resume()
        done(true)
      })
      req.on('timeout', () => req.destroy())
      req.on('error', () => {
        if (!allowBadTls && u.protocol === 'https:') attempt(true)
        else done(false)
      })
    }
    attempt(false)
  })
}

/* ------------------------------------------------------------------ *
 * dsh 服务进程管理（本机模式）
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
  // --no-open 关闭 dsh 默认的自动打开浏览器行为（桌面壳自己用 BrowserWindow 加载，不弹浏览器）
  const cmd = `"${bin}" web --port ${port} --no-open`
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
 * DSH 主动更新（仅本机模式，且仅对由本壳启动的 dsh 生效）
 *
 * 流程：检查 npm 最新版 → 弹窗确认 → npm 更新全局包 → 重启本壳托管的
 * dsh 进程 → 轮询端口就绪 → 自动重连。远程模式与外部服务整体禁用。
 * ------------------------------------------------------------------ */

const DSH_NPM_PACKAGE = '@deepseek-ai/dsh'
const DSH_CHECK_TIMEOUT_MS = 30_000
const DSH_INSTALL_TIMEOUT_MS = 300_000
const DSH_RECONNECT_TIMEOUT_MS = 90_000
const DSH_RECONNECT_INTERVAL_MS = 1_500

let updatingDsh = false

/** 读取本机已安装的 DSH 版本（如 "0.1.1-rc.2"）；读不到返回 null。 */
async function getInstalledDshVersion() {
  const r = await runCmd(resolveDshBin(), ['--version'], DSH_CHECK_TIMEOUT_MS)
  if (!r || r.code !== 0) return null
  const m = /\d+\.\d+\.\d+(?:-[A-Za-z]+\.\d+)?/.exec(r.out)
  return m ? m[0] : null
}

/** 查询 npm 上 DSH 最新版本号；失败返回 null。 */
async function getNpmLatestVersion() {
  const r = await runCmd('npm.cmd', ['view', DSH_NPM_PACKAGE, 'version'], DSH_CHECK_TIMEOUT_MS)
  if (!r || r.code !== 0) return null
  const m = /\d+\.\d+\.\d+(?:-[A-Za-z]+\.\d+)?/.exec(r.out)
  return m ? m[0] : null
}

/** 更新期间把主窗口切到轻量进度页，避免暴露连接错误页。 */
function showUpdateSplash(stepText) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const page = `<!doctype html><html><meta charset="utf-8"><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0d1117;color:#e6edf3;font-family:system-ui,'Microsoft YaHei';user-select:none">
  <div style="text-align:center"><div style="font-size:44px;margin-bottom:18px">⬆️</div>
  <div style="font-size:20px;margin-bottom:10px">正在更新 DSH</div>
  <div id="s" style="font-size:13px;color:#8b949e">${stepText}</div>
  <div style="margin-top:22px;font-size:12px;color:#484f58">完成后将自动重连，请勿关闭应用</div></div></body></html>`
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page)).catch(() => {})
}

/** 任务栏进度指示：0-1 确定进度，2 = 不确定态，-1 = 清除。 */
function setUpdateProgress(value) {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(value) } catch { /* ignore */ }
}

/**
 * 执行更新：npm 安装新版 → 校验版本 → 重启本壳托管的 dsh 进程 → 等端口
 * 恢复 → 重载页面。抛错时由调用方负责展示（错误里附带手动修复命令）。
 */
async function performDshUpdate(targetVersion) {
  const steps = [
    `npm 安装 ${DSH_NPM_PACKAGE}@latest（最长 5 分钟）`,
    '校验新版本',
    '重启 dsh 服务',
    '等待服务就绪并重连',
  ]
  log(`dsh update: begin, target=${targetVersion || 'latest'}`)
  showUpdateSplash(steps[0])
  setUpdateProgress(2)

  // 1) npm 全局更新（--no-fund/--no-audit 减少网络依赖与耗时）
  const install = await runCmd('npm.cmd', ['install', '-g', `${DSH_NPM_PACKAGE}@latest`, '--no-fund', '--no-audit'], DSH_INSTALL_TIMEOUT_MS)
  if (!install) {
    throw new Error(`npm 安装超时（${DSH_INSTALL_TIMEOUT_MS / 1000}s）或无法调用 npm。\n可手动执行：npm install -g ${DSH_NPM_PACKAGE}@latest`)
  }
  if (install.code !== 0) {
    throw new Error(`npm 安装失败（exit ${install.code}）：\n${install.out.split('\n').slice(-6).join('\n')}`)
  }
  log('dsh update: npm install done')

  // 2) 校验版本确实换新（npm 偶发装了旧版缓存时能及时发现）
  showUpdateSplash(steps[1])
  const installed = await getInstalledDshVersion()
  log(`dsh update: installed=${installed || '?'}`)
  if (installed && targetVersion && installed !== targetVersion) {
    log('dsh update: version mismatch after install, continuing anyway')
  }

  // 3) 重启本壳托管的 dsh 进程（杀掉旧进程 → 重新拉起）
  showUpdateSplash(steps[2])
  const port = resolvePort()
  await shutdownOwnedDsh()
  isShuttingDownDsh = false // 重置，让后续崩溃自愈逻辑仍生效
  ownedDsh = startDsh(port)

  // 4) 轮询直到服务恢复，然后重载页面
  showUpdateSplash(steps[3])
  const deadline = Date.now() + DSH_RECONNECT_TIMEOUT_MS
  let back = false
  while (Date.now() < deadline) {
    if (await probe(port, 1200)) { back = true; break }
    await new Promise((r) => setTimeout(r, DSH_RECONNECT_INTERVAL_MS))
  }
  setUpdateProgress(-1)
  if (back) {
    loadApp()
  } else {
    log('dsh update: service did not come back within timeout')
  }

  const finalVersion = installed || targetVersion || '最新版'
  if (back) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'info', title: '更新完成',
      message: `DSH 已更新到 ${finalVersion}，服务已重启并重新连接。`,
      buttons: ['好'], noLink: true,
    })
  } else {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning', title: '更新完成，等待服务就绪',
      message: `DSH 已更新到 ${finalVersion}，但服务在 ${Math.round(DSH_RECONNECT_TIMEOUT_MS / 1000)}s 内未恢复。`,
      detail: '可能仍在启动中。稍后按 F5 刷新即可；也可查看日志：' + path.join(app.getPath('userData'), 'dsh.log'),
      buttons: ['好'], noLink: true,
    })
  }
  log(`dsh update: done, version=${finalVersion} reconnected=${back}`)
}

/**
 * 检查并（经确认后）更新 DSH。仅本机模式且 dsh 由本壳托管时可用。
 * @param silent 无新版/无法检测时不弹窗（用于启动时自动检查；发现新版仍会询问）
 */
async function checkDshUpdate(silent = false) {
  if (!targetIsLocal) {
    if (!silent) {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'info', title: '远程模式',
        message: '当前连接的是远程服务器上的 DSH。',
        detail: '「检查 DSH 更新」仅在本机模式下可用。\n远程部署请在服务器上更新（如 docker compose 拉取新镜像后重建容器）。',
        buttons: ['好'], noLink: true,
      })
    }
    return
  }
  if (!ownedDsh) {
    // 外部已有的本机服务（用户手动启动 / WSL 等）：本壳无法安全重启，交还用户
    if (!silent) {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'info', title: '无法自动更新',
        message: '当前使用的是外部已有的 dsh 服务，不是本应用启动的。',
        detail: '请在对应环境手动更新（npm install -g @deepseek-ai/dsh@latest）并重启该服务，然后刷新页面（F5）。',
        buttons: ['好'], noLink: true,
      })
    }
    return
  }
  if (updatingDsh) {
    if (!silent) dialog.showMessageBox(mainWindow || undefined, { type: 'info', message: 'DSH 正在更新中，请稍候。', buttons: ['好'], noLink: true })
    return
  }
  const [current, latest] = await Promise.all([getInstalledDshVersion(), getNpmLatestVersion()])
  log(`dsh update check: current=${current || '?'} latest=${latest || '?'}`)

  if (!current || !latest) {
    if (!silent) {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'warning', title: '无法检查 DSH 更新',
        message: !current ? '未能读取本机安装的 DSH 版本。' : '未能获取 npm 上的最新版本（检查网络）。',
        detail: !current ? `请确认 dsh 可用（${resolveDshBin()} --version）。` : `手动查询：https://www.npmjs.com/package/${DSH_NPM_PACKAGE}`,
        buttons: ['好'], noLink: true,
      })
    }
    return
  }
  if (!isNewer(latest, current)) {
    if (!silent) dialog.showMessageBox(mainWindow || undefined, { type: 'info', title: '已是最新', message: `本机的 DSH（${current}）已是最新版本。`, buttons: ['好'], noLink: true })
    return
  }

  const { response } = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'question', title: '发现 DSH 新版本',
    message: `本机的 DSH 可以更新：${current} → ${latest}`,
    detail: `更新过程约 1-3 分钟：下载安装新包 → 自动重启 dsh 服务 → 自动重连窗口。\n期间 Web 页面会短暂不可用，请勿关闭应用。\n\n手动执行等价于：\n  npm install -g ${DSH_NPM_PACKAGE}@latest`,
    buttons: ['立即更新', '暂不'], defaultId: 0, cancelId: 1, noLink: true,
  })
  if (response === 0) {
    updatingDsh = true
    try {
      await performDshUpdate(latest)
    } catch (e) {
      setUpdateProgress(-1)
      log('dsh update failed:', e && e.message)
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'error', title: 'DSH 更新失败',
        message: '更新过程中出现问题，可稍后重试',
        detail: `${String(e && e.message || e)}\n\n也可手动执行：\n  npm install -g ${DSH_NPM_PACKAGE}@latest\n然后从菜单「重启 dsh 服务」或手动重启后按 F5。`,
        buttons: ['好'], noLink: true,
      })
      loadApp()
    } finally {
      updatingDsh = false
    }
  }
}

/* ------------------------------------------------------------------ *
 * 会话管理（读取/删除 ~/.dsh/sessions 下的会话；仅本机模式入口可见，
 * 远程模式下会话在服务器上，此处列表不适用故隐藏）
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
      const sPath = path.join(root, ws.name, s.name)
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
 * 环境检测与首次引导（本机模式）
 * ------------------------------------------------------------------ */

/**
 * 执行一条命令并收集输出（Windows 下经 shell 运行，参数均为常量）。
 * timeoutMs > 0 时超时返回 null（与 spawn 失败同形，调用方统一处理）。
 */
function runCmd(cmd, args, timeoutMs = 0) {
  return new Promise((resolve) => {
    const full = args.length ? `"${cmd}" ${args.join(' ')}` : `"${cmd}"`
    const child = spawn(full, { shell: true, windowsHide: true })
    let out = ''
    let settled = false
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return
          settled = true
          try { child.kill() } catch { /* ignore */ }
          resolve(null)
        }, timeoutMs)
      : null
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('error', () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code, out: out.trim() })
    })
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

function createWindow(init) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  // init.mode !== 'app' 时先显示连接页（首次使用 / 离线 / 主动切换）
  if (!init || init.mode !== 'app') showConnectPage(init || {})
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // F5 刷新（仅对应用页生效；连接页交给其自身的重试逻辑）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F5') {
      event.preventDefault()
      const cur = mainWindow.webContents.getURL()
      if (target && cur.startsWith(target)) loadApp()
      else if (!cur.startsWith('file://') && !cur.startsWith('data:')) loadApp()
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

  // 外部链接（非当前目标）用系统浏览器打开，不在壳内导航；站内允许弹窗
  mainWindow.webContents.setWindowOpenHandler(({ url: t }) => {
    if (target && t.startsWith(target)) return { action: 'allow' }
    if (/^https?:\/\//i.test(t)) shell.openExternal(t)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, t) => {
    if (t.startsWith('file://') || t.startsWith('data:')) return // 连接页等内部页面
    if (target && t.startsWith(target)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(t)) shell.openExternal(t)
  })

  // 应用页主框架加载失败（远程服务器关机/断网等）→ 回到连接页离线模式
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return // -3 = ERR_ABORTED，多为自身跳转引起
    if (!target || !validatedURL || !validatedURL.startsWith(target)) return
    log(`app page failed to load (${errorCode}): ${errorDesc}`)
    showConnectPage({
      mode: 'offline',
      url: target,
      error: `连接 ${hostOf(target)} 失败（${errorDesc || '错误码 ' + errorCode}）。\n恢复后点「连接」或等待自动重试即可。`,
    })
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
 * 系统托盘 / 应用菜单（按连接模式裁剪）
 * ------------------------------------------------------------------ */

/** 从应用切到连接页（菜单/托盘入口）。 */
function openConnectSettings() {
  showMainWindow()
  showConnectPage({ mode: target ? 'switch' : 'first', url: target })
}

function buildTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png')
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(iconPath))
    tray.on('double-click', showMainWindow)
  }
  tray.setToolTip(target ? `DeepSeek Harness — ${hostOf(target)}` : 'DeepSeek Harness — 未连接')
  const template = [
    { label: '显示主窗口', click: showMainWindow },
    { type: 'separator' },
    { label: target ? `服务器：${hostOf(target)}${targetIsLocal ? '（本机）' : ''}` : '服务器：未连接', enabled: false },
    { label: '连接设置…', click: openConnectSettings },
    ...(targetIsLocal ? [
      { label: '检查 DSH 更新', click: () => checkDshUpdate(false) },
      { label: '重启 dsh 服务', click: () => { restartDshService() } },
    ] : []),
    {
      label: '打开截图目录',
      click: () => {
        const dir = path.join(os.homedir(), '.dsh', 'screenshots')
        fs.mkdirSync(dir, { recursive: true })
        shell.openPath(dir)
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function buildApplicationMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        ...(targetIsLocal ? [{ label: '会话管理…', click: () => openSessionsWindow() }] : []),
        { label: '连接设置…', click: openConnectSettings },
        ...(targetIsLocal ? [
          { label: '检查 DSH 更新…', click: () => checkDshUpdate(false) },
          { label: '重启 dsh 服务…', click: () => restartDshService() },
        ] : []),
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
          click: () => loadApp(),
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

function showMainWindow() {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

/* ------------------------------------------------------------------ *
 * 连接流程
 * ------------------------------------------------------------------ */

/** 回到应用主页面（不能用 reload()——它会把临时页如更新进度页再刷一遍，把人困住）。 */
function loadApp() {
  if (mainWindow && !mainWindow.isDestroyed() && target) mainWindow.loadURL(target).catch(() => {})
}

/** 显示连接页。mode: first=首次使用 / offline=连不上 / switch=从应用主动换服务器 */
function showConnectPage(opts = {}) {
  connectState = {
    mode: opts.mode || 'first',
    url: opts.url || '',
    error: opts.error || '',
  }
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadFile(path.join(__dirname, 'connect.html')).catch(() => {})
}

/** 探测并连接用户输入的远程地址；成功则记住并进入应用。由连接页经 IPC 调用。 */
async function attemptConnect(raw, { persist = true } = {}) {
  const prevAuth = basicAuth
  const t = normalizeTarget(typeof raw === 'string' ? raw : '')
  if (!t) {
    return { ok: false, error: '地址无效：请输入完整地址，如 https://dsh.example.com 或 http://192.168.31.10:3080' }
  }
  // 换主机且新地址未内嵌凭据时清掉旧凭据，避免误发给新主机；
  // 同主机重试（离线自动重连等）保留已保存凭据。
  if (basicAuth === prevAuth && (!target || hostOf(target) !== hostOf(t))) basicAuth = null
  log('probing', t)
  const up = await probeUrl(t)
  if (!up) {
    basicAuth = prevAuth // 连接失败回滚，保持原状态
    return { ok: false, url: t, error: `无法连接 ${t}（无响应或超时）。\n请确认服务已启动、地址与端口正确、本机网络可达该服务器。` }
  }
  applyTarget(t, { persist })
  enterApp()
  return { ok: true, url: t }
}

/** 目标就绪：按模式重建托盘/菜单，进入应用页。 */
function enterApp() {
  connectState = { mode: 'app', url: target, error: '' }
  buildTray()
  buildApplicationMenu()
  loadApp()
}

/**
 * 本机模式启动（连接页「本机连接」与保存过本机地址的启动共用）：
 * 环境检查/引导 → 探测 3080 → 没有则本壳启动 dsh → 进入应用。
 * @returns 是否成功进入应用
 */
async function startLocalMode({ persist = true, fromStartup = false } = {}) {
  // 0) 环境检查：Node / dsh 缺失时先走引导窗口
  let env = await checkEnvironment()
  if (!env.node.ok || !env.dsh.ok) {
    const result = await startSetupFlow()
    if (result !== 'ready') {
      // 用户关闭引导窗口：启动场景退出应用；连接页场景留在连接页
      if (fromStartup) app.quit()
      return false
    }
    env = await checkEnvironment()
    if (!env.node.ok || !env.dsh.ok) {
      if (fromStartup) app.quit()
      return false
    }
  }

  const port = resolvePort()
  applyTarget(`http://127.0.0.1:${port}`, { persist })

  // 1) 已有服务（可能是用户手动起的 dsh web / WSL 等）→ 直接复用
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
      if (fromStartup) {
        await shutdownOwnedDsh()
        app.quit()
      }
      return false
    }
  } else {
    log('reusing external dsh service on port ' + port)
  }

  // 3) 就绪：首次创建窗口（连接页触发时窗口已存在，直接进入）
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ mode: 'app' })
    buildTray()
    buildApplicationMenu()
  }
  enterApp()
  checkForUpdatesOnce()
  // 启动 3s 后静默检查本机 DSH 是否有新版本（仅本机模式实际生效）
  setTimeout(() => checkDshUpdate(true).catch((e) => log('dsh update check error:', e && e.message)), 3_000)
  return true
}

/* ------------------------------------------------------------------ *
 * IPC（工具条 / 截图 / 连接页）
 * ------------------------------------------------------------------ */

function registerIpc() {
  // preload 注入的悬浮刷新按钮 → 重新加载页面
  ipcMain.on('dsh-desktop:reload', () => {
    if (target) loadApp()
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

  // 连接页：读取状态 / 连接远程地址 / 本机连接 / 返回应用
  ipcMain.handle('connect:state', () => ({
    mode: connectState.mode,
    url: connectState.url || '',
    error: connectState.error || '',
  }))
  ipcMain.handle('connect:attempt', (_e, raw) => attemptConnect(raw))
  ipcMain.handle('connect:local', async () => {
    const ok = await startLocalMode({ persist: true })
    return ok
      ? { ok: true, url: target }
      : { ok: false, error: '本机连接未能就绪（详情见弹窗与日志）。可稍后重试，或改用远程地址。' }
  })
  ipcMain.on('connect:cancel', () => { if (target) loadApp() })
}

/* ------------------------------------------------------------------ *
 * 应用生命周期
 * ------------------------------------------------------------------ */

// Windows 任务栏固定/通知规范：AppUserModelID 与打包 appId 保持一致
app.setAppUserModelId('com.dsh.desktop')

// 自建服务常见自签名证书：仅当证书错误发生在「当前目标主机」上时放行，
// 其余一律拒绝（不扩大面）。
app.on('certificate-error', (event, _wc, url, error, _cert, callback) => {
  let u, t
  try { u = new URL(url); t = new URL(target) } catch { callback(false); return }
  if (target && u.host === t.host && u.protocol === 'https:') {
    log(`accepting certificate error on configured host (${error})`)
    event.preventDefault()
    callback(true)
    return
  }
  callback(false)
})

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
    registerIpc()

    // HTTP Basic Auth 自动应答：服务器返回 401 时回填 basicAuth 凭据
    // （凭据来自连接 URL 内嵌的 user:pass@host 形式，见 normalizeTarget）。
    // 每次会话浏览器内核只问一次；凭据仅存内存，不写日志。
    app.on('login', (_event, _webContents, _details, _authInfo, callback) => {
      if (basicAuth) callback(basicAuth.username, basicAuth.password)
      else callback() // 无凭据则取消，交给 401 页面展示
    })

    // 解析初始目标：命令行 --url > 上次保存（config.json）
    const cliUrl = resolveCliUrl()
    const savedUrl = String(loadConfig().url || '')
    // 恢复上次会话保存的 BasicAuth 凭据（URL 未内嵌凭据时使用）
    const savedAuth = loadConfig().basicAuth
    if (savedAuth && typeof savedAuth === 'object' && savedAuth.username) basicAuth = savedAuth
    const candidate = cliUrl ? normalizeTarget(cliUrl) : normalizeTarget(savedUrl)
    log(cliUrl ? `cli target: ${cliUrl}` : `saved target: ${savedUrl || '(none)'}`)

    if (candidate && !isLocalHost(new URL(candidate).hostname)) {
      // ── 远程模式：先探测避免闪一下连接页；可达直接进，不可达离线连接页 ──
      const up = await probeUrl(candidate)
      const init = up
        ? { mode: 'app' }
        : {
            mode: 'offline',
            url: candidate,
            error: `无法连接 ${candidate}（未响应或超时）。\n服务器可能没开机，或网络不可达。恢复后点「连接」，或改用其他地址。`,
          }
      createWindow(init)
      buildTray()
      buildApplicationMenu()
      if (up) {
        applyTarget(candidate, { persist: !cliUrl }) // 命令行临时指定不覆盖已存配置
        enterApp()
      }
      checkForUpdatesOnce()
      return
    }

    if (candidate) {
      // ── 本机模式（保存过本机地址 / --url 指向本机）：走完整本地启动流程 ──
      await startLocalMode({ persist: !cliUrl, fromStartup: true })
      return
    }

    // ── 首次使用（无保存地址）：显示连接页，选择「本机连接」或远程地址 ──
    createWindow({ mode: 'first' })
    buildTray()
    buildApplicationMenu()
    checkForUpdatesOnce()
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
