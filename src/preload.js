'use strict'

// 统一 preload：按页面协议分派逻辑。
//   http/https → DSH Web 应用页：注入底部工具条（截图 + 刷新）
//   file://    → 连接页（connect.html）：本机连接 / 远程地址输入 / 自动重试
//   data:      → 更新进度页等临时页：不做任何事
//
// 注意：BrowserWindow 只能绑定一个 preload，而连接页与应用页共用同一个窗口，
// 因此两套逻辑必须合流于此，靠 location.protocol 区分。

const { ipcRenderer } = require('electron')

const protocol = location.protocol

/* ------------------------------------------------------------------ *
 * 应用页（http/https）：底部工具条
 * ------------------------------------------------------------------ */

if (protocol === 'http:' || protocol === 'https:') {
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
}

/* ------------------------------------------------------------------ *
 * 连接页（file://）
 * ------------------------------------------------------------------ */

if (protocol === 'file:') {
  window.addEventListener('DOMContentLoaded', async () => {
    const $ = (id) => document.getElementById(id)
    const addr = $('addr')
    const status = $('status')
    const hint = $('hint')
    const btnGo = $('btn-go')
    const btnLocal = $('btn-local')
    const localLabel = btnLocal.textContent
    const btnCancel = $('btn-cancel')
    const autoWrap = $('auto-wrap')
    const auto = $('auto')

    let busy = false
    let retryTimer = null

    function setStatus(cls, text) {
      status.className = cls
      status.textContent = text
    }

    let state
    try { state = await ipcRenderer.invoke('connect:state') } catch { state = { mode: 'first', url: '', error: '' } }

    addr.value = state.url || ''
    if (state.error) setStatus('err', state.error)
    if (state.mode === 'first') hint.textContent = '首次使用：点「本机连接」自动启动本机 dsh；或输入远程地址（局域网 IP 自动用 http，域名自动用 https）'
    if (state.mode === 'offline') hint.textContent = '与服务器的连接中断了。服务器恢复后可自动重连，也可以改连其他地址（如本机）'
    if (state.mode === 'switch') hint.textContent = '当前已连接。换一个地址并连接成功后即完成切换；点「本机连接」回到本机模式'
    if (state.mode === 'offline') autoWrap.style.display = 'flex'
    else autoWrap.style.display = 'none'
    if (state.mode !== 'switch') btnCancel.style.display = 'none'
    else btnCancel.addEventListener('click', () => ipcRenderer.send('connect:cancel'))

    function stopAutoRetry() {
      if (retryTimer) { clearInterval(retryTimer); retryTimer = null }
    }

    // 远程地址：探测 → 连接
    async function tryConnect(silent) {
      if (busy) return false
      const val = addr.value.trim()
      if (!val) {
        if (!silent) setStatus('err', '请输入服务器地址')
        return false
      }
      busy = true
      btnGo.disabled = true
      btnGo.textContent = silent ? btnGo.textContent : '连接中…'
      if (!silent) setStatus('muted', `正在探测 ${val} …`)
      let r
      try { r = await ipcRenderer.invoke('connect:attempt', val) } catch (e) { r = { ok: false, error: String(e) } }
      busy = false
      btnGo.disabled = false
      btnGo.textContent = '连 接'
      if (!r || !r.ok) {
        setStatus('err', (r && r.error) || '连接失败')
        return false
      }
      stopAutoRetry()
      setStatus('ok', `已连接 ${r.url}，正在进入…`)
      return true
    }

    // 本机连接：环境引导（如需）→ 探测/启动本机 dsh → 进入应用
    async function connectLocal() {
      if (busy) return
      busy = true
      btnLocal.disabled = true
      btnGo.disabled = true
      btnLocal.textContent = '连接中…（首次可能需要安装环境）'
      setStatus('muted', '正在连接本机：检查环境 → 启动 dsh 服务…')
      let r
      try { r = await ipcRenderer.invoke('connect:local') } catch (e) { r = { ok: false, error: String(e) } }
      busy = false
      btnLocal.disabled = false
      btnGo.disabled = false
      btnLocal.textContent = localLabel
      if (!r || !r.ok) {
        setStatus('err', (r && r.error) || '本机连接失败')
        return
      }
      stopAutoRetry()
      setStatus('ok', `已连接 ${r.url}，正在进入…`)
    }

    btnGo.addEventListener('click', () => tryConnect(false))
    addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryConnect(false) })
    btnLocal.addEventListener('click', connectLocal)

    auto.addEventListener('change', () => { auto.checked ? startAutoRetry() : stopAutoRetry() })
    function startAutoRetry() {
      stopAutoRetry()
      retryTimer = setInterval(async () => {
        if (!busy && auto.checked) await tryConnect(true)
      }, 8000)
    }
    if (state.mode === 'offline') startAutoRetry()
  })
}
