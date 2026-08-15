'use strict'

// 会话管理窗口的 preload：通过 contextBridge 暴露安全 API
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sessionsAPI', {
  // 列出所有会话 [{ id, workspace, modified, sizeKB, current }]
  list: () => ipcRenderer.invoke('sessions:list'),
  // 删除指定会话，返回 { ok, error? }
  remove: (id) => ipcRenderer.invoke('sessions:remove', id),
})
