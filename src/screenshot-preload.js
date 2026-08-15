'use strict'

// 选区截图窗口的 preload：把主进程的 IPC 桥接给页面（contextBridge 隔离）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__screenshot', {
  // 订阅截图数据（主进程发来的 dataURL）
  onData: (cb) => {
    ipcRenderer.on('screenshot:data', (_e, dataUrl) => cb(dataUrl))
  },
  // 提交选区（页面坐标）
  done: (rect) => ipcRenderer.send('screenshot:done', rect),
  // 取消
  cancel: () => ipcRenderer.send('screenshot:cancel'),
})
