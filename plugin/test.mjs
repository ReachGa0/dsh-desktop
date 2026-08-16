import { name, inject, apply, buildDesktopTool, findInstalledExe } from './lib/index.js'
const registered = []
const ctx = { tools: { register: (t) => registered.push(t) }, logger: { info() {}, warn() {} } }
apply(ctx)
console.log('name:', name)
console.log('inject:', JSON.stringify(inject))
console.log('registered tools:', registered.map((t) => t.name).join(', '))
const tool = buildDesktopTool()
console.log('tool name:', tool.name)
console.log('output schema status enum:', JSON.stringify(tool.output.schema.properties.status.enum))
const exe = findInstalledExe()
console.log('findInstalledExe:', exe ?? '(not installed on this machine)')
