'use strict'

// 最小 preload：为将来扩展保留的桥接点。当前壳不需要向页面暴露任何 Node 能力。
// 页面（dsh Web UI）直接走 HTTP/WebSocket 与本地服务通信，无需 IPC。
