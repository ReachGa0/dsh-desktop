'use strict'

// 引导窗口（setup.html）的 preload：通过 contextBridge 暴露安全 API
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('setupAPI', {
  // 返回环境检测结果 { node: {ok,version,error}, dsh: {ok,version,error} }
  check: () => ipcRenderer.invoke('setup:check'),
  // 自动安装 dsh，返回 { ok, error? }
  installDsh: () => ipcRenderer.invoke('setup:install-dsh'),
  // 安装过程的输出行（事件流）
  onInstallLog: (cb) => {
    const listener = (_event, line) => cb(line)
    ipcRenderer.on('setup:install-log', listener)
  },
  // 打开 Node.js 下载页
  openNode: () => ipcRenderer.invoke('setup:open-node'),
  // 打开 DeepSeek 开放平台（API Key 指引）
  openSettings: () => ipcRenderer.invoke('setup:open-settings'),
  // 环境就绪，关闭引导窗口继续
  finish: () => ipcRenderer.invoke('setup:finish'),
})
