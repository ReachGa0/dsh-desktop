// dsh-desktop-launcher: launch the dsh-desktop Windows shell from the DSH
// conversation. The shell is the standalone Electron app (region screenshot,
// system tray, session manager); this plugin only needs to find and start its
// installed exe, or point the user at the latest GitHub Release when it is
// missing. Loaded via cordis.patch.yml (see package.json dsh.bundle).
//
// Zero runtime dependencies: the tool definition is a raw JSON-Schema tool
// registered through ctx.tools, and all effects use node builtins only —
// mirroring the @liustack/modlens dsh plugin pattern.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-desktop-launcher'
export const inject = ['tools']

const PKG_DIR = dirname(fileURLToPath(import.meta.url))

// Install layouts dsh-desktop supports (electron-builder NSIS defaults and
// the per-user/per-machine variants). Checked in order; first hit wins.
function candidateInstallDirs() {
  const dirs = []
  const localAppData = process.env.LOCALAPPDATA || ''
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files'
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
  if (localAppData) dirs.push(join(localAppData, 'Programs', 'dsh-desktop'))
  if (localAppData) dirs.push(join(localAppData, 'Programs', 'DeepSeek Harness Desktop'))
  if (programFiles) dirs.push(join(programFiles, 'dsh-desktop'))
  if (programFiles) dirs.push(join(programFiles, 'DeepSeek Harness Desktop'))
  if (programFilesX86) dirs.push(join(programFilesX86, 'dsh-desktop'))
  if (programFilesX86) dirs.push(join(programFilesX86, 'DeepSeek Harness Desktop'))
  return dirs
}

const EXE_NAMES = ['DeepSeek Harness Desktop.exe', 'dsh-desktop.exe']

/** Absolute path of the installed exe, or null when not found. */
export function findInstalledExe() {
  if (process.platform !== 'win32') return null
  for (const dir of candidateInstallDirs()) {
    for (const exe of EXE_NAMES) {
      const p = join(dir, exe)
      if (existsSync(p)) return p
    }
  }
  return null
}

/** Launch an exe detached (start.exe is the reliable Windows way). */
function launch(exePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/c', 'start', '', `"${exePath}"`], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', reject)
    child.on('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** True when a local dsh web server answers on the given port. */
const DOWNLOAD_URL = 'https://github.com/ReachGa0/dsh-desktop/releases/latest'

/**
 * Build the desktop_launch tool. Split from apply so tests can drive the
 * helpers without a running registry.
 */
export function buildDesktopTool() {
  return {
    name: 'desktop_launch',
    description:
      'Launch the dsh-desktop Windows shell (Electron desktop app around the DSH web UI: region screenshot, system tray, session manager). ' +
      'When the app is already installed it is started immediately; when it is missing, returns the download link to the latest GitHub Release. ' +
      'Use when the user wants to open or install the desktop app.',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['launched', 'missing', 'windows-only'],
            required: true,
            description: 'Outcome of this call.',
          },
          exePath: { type: 'string', description: 'Absolute path of the launched exe (status=launched).' },
          downloadUrl: { type: 'string', description: 'Latest release URL (status=missing).' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value
        if (v.status === 'launched') return [{ type: 'text', text: `dsh-desktop launched: ${v.exePath}` }]
        if (v.status === 'missing') {
          return [{ type: 'text', text: `dsh-desktop not installed. Download: ${v.downloadUrl}` }]
        }
        return [{ type: 'text', text: 'dsh-desktop is Windows-only.' }]
      },
      presentationMeta: (_args, value) => value,
    },
    timeoutMs: 30_000,
    presentCall: () => ({ card: 'generic', title: '启动 dsh-desktop 桌面端', kind: 'execute' }),
    presentResult: (_args, result) => {
      const meta = result?.meta
      if (meta?.status === 'launched') {
        return { card: 'generic', title: '桌面端已启动', content: [{ type: 'text', text: meta.exePath }] }
      }
      if (meta?.status === 'missing') {
        return {
          card: 'generic',
          title: '未检测到桌面端',
          content: [{ type: 'text', text: `下载地址：${meta.downloadUrl}` }],
        }
      }
      return { card: 'generic', title: '仅支持 Windows', content: [{ type: 'text', text: 'dsh-desktop 仅支持 Windows。' }] }
    },
    async execute() {
      if (process.platform !== 'win32') {
        return { status: 'windows-only' }
      }
      const exePath = findInstalledExe()
      if (exePath) {
        await launch(exePath)
        return { status: 'launched', exePath }
      }
      return { status: 'missing', downloadUrl: DOWNLOAD_URL }
    },
  }
}

/** Apply the plugin to its Cordis context. */
export function apply(ctx) {
  ctx.tools.register(buildDesktopTool())
}
