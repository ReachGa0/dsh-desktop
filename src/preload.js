'use strict'

// preload：注入底部工具条（截图 + 刷新）。
// 页面（dsh Web UI）直接走 HTTP/WebSocket 与本地服务通信，无需 IPC。

const { ipcRenderer } = require('electron')

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (!document.body) return

    // 底部工具条容器
    const bar = document.createElement('div')
    bar.style.cssText = `
      position: fixed;
      right: 12px;
      bottom: 12px;
      display: flex;
      gap: 8px;
      z-index: 2147483647;
    `

    const makeBtn = (text, title, onClick) => {
      const b = document.createElement('button')
      b.textContent = text
      b.title = title
      b.style.cssText = `
        width: 34px;
        height: 34px;
        border-radius: 10px;
        border: none;
        background: rgba(30, 41, 59, 0.72);
        color: #fff;
        font-size: 17px;
        line-height: 1;
        cursor: pointer;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
        opacity: 0.45;
        transition: opacity 0.2s;
      `
      b.onmouseenter = () => (b.style.opacity = '1')
      b.onmouseleave = () => (b.style.opacity = '0.45')
      b.onclick = onClick
      return b
    }

    // 截图按钮：截屏 → 剪贴板 → 自动粘贴到聊天框
    const shotBtn = makeBtn('📸', '截图并提问（截取当前屏幕，自动粘贴到聊天框）', () => {
      shotBtn.style.opacity = '1'
      shotBtn.textContent = '⏳'
      ipcRenderer.invoke('dsh-desktop:capture').then((r) => {
        shotBtn.textContent = '📸'
        if (!r || !r.ok) {
          ipcRenderer.send('dsh-desktop:toast', (r && r.error) || '截图失败')
        }
      })
    })

    // 刷新按钮
    const reloadBtn = makeBtn('⟳', '刷新页面（等价 F5）', () => {
      ipcRenderer.send('dsh-desktop:reload')
    })

    bar.appendChild(shotBtn)
    bar.appendChild(reloadBtn)
    document.body.appendChild(bar)
  }, 1500)
})
