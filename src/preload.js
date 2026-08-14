'use strict'

// 最小 preload：为将来扩展保留的桥接点 + 注入悬浮刷新按钮。
// 页面（dsh Web UI）直接走 HTTP/WebSocket 与本地服务通信，无需 IPC。

const { ipcRenderer } = require('electron')

// 注入一个悬浮"刷新"按钮（右下角，半透明，鼠标悬停变清晰）
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (!document.body) return
    const btn = document.createElement('button')
    btn.textContent = '⟳'
    btn.title = '刷新页面（等价 F5）'
    btn.style.cssText = `
      position: fixed;
      right: 14px;
      bottom: 14px;
      width: 34px;
      height: 34px;
      border-radius: 10px;
      border: none;
      background: rgba(30, 41, 59, 0.72);
      color: #fff;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
      opacity: 0.45;
      transition: opacity 0.2s;
      z-index: 2147483647;
    `
    btn.onmouseenter = () => (btn.style.opacity = '1')
    btn.onmouseleave = () => (btn.style.opacity = '0.45')
    btn.onclick = () => ipcRenderer.send('dsh-desktop:reload')
    document.body.appendChild(btn)
  }, 1500)
})
