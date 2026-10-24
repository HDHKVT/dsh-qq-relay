import { fileURLToPath } from 'node:url'
/**
 * Task 2 · 设置页测试
 *
 * 验四件事（都对着 bundle 真跑，不重写它的逻辑）：
 *   1. `apply(ctx)` 把页面注册到 `settings.section`，id/order 符合约定
 *   2. 挂载后真的去读了 `qqRelay/config`，并把 AppID / 凭据状态渲染出来
 *   3. 改 AppID 再点「保存」⇒ 只提交改动的字段（`direct.appId`），不把密钥带上去
 *   4. 保存失败时把那句 `why` 原样显示在页面上
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** 极简 hook 调度器：够跑这一页的 useState / useEffect / useCallback。 */
function makeHarness() {
  let slots = []
  let cursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }
      return [slots[index], set]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback(fn) {
      const index = cursor++
      slots[index] = fn
      return fn
    },
    useEffect(fn) {
      const index = cursor++
      if (!(index in slots)) {
        slots[index] = true
        fn()
      }
    },
  }
  return {
    React,
    async render(component, props) {
      cursor = 0
      const tree = component(props)
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
      return tree
    },
  }
}

function* walk(node) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return }
  if (typeof node !== 'object') return
  yield node
  for (const child of node.children ?? []) yield* walk(child)
}

function textOf(tree) {
  let out = ''
  for (const node of walk(tree)) {
    for (const child of node.children ?? []) if (typeof child === 'string') out += ` ${child}`
  }
  return out
}

const harness = makeHarness()
const registrations = []
const calls = []
let snapshot = {
  sessionId: 'session-cur',
  transport: 'mailbox',
  direct: { appId: 'app-1', ownerId: 'owner-1', intents: 33554432, hasSecret: true },
  reply: { maxChars: 900, minGapMs: 2000, hint: true },
  image: { enabled: true, maxMb: 12, retentionDays: 7, dir: '', multi: false, gifFrames: 4 },
}
let updateReply = { saved: true }

const ctx = {
  get: (key) => (key === 'connection' ? { rpc: { call: async (channel, endpoint, payload) => {
    calls.push({ channel, endpoint, payload })
    assert.equal(channel, '/api')
    if (endpoint === 'qqRelay/config') return { ok: true, value: snapshot }
    if (endpoint === 'qqRelay/configUpdate') {
      if (updateReply.saved) {
        const patch = payload.args.patch
        if (patch.direct?.appId) snapshot = { ...snapshot, direct: { ...snapshot.direct, appId: patch.direct.appId } }
        if (patch.transport) snapshot = { ...snapshot, transport: patch.transport }
      }
      return { ok: true, value: updateReply }
    }
    if (endpoint === 'qqRelay/act') return { ok: true, value: { done: true } }
    if (endpoint === 'qqRelay/imageClear') return { ok: true, value: { removed: 2, bytes: 2048, dir: 'D:/x/images/incoming' } }
    if (endpoint === 'qqRelay/openImageDir') return { ok: true, value: { opened: true, dir: 'D:/x/images' } }
    if (endpoint === 'qqRelay/logTail') return { ok: true, value: { path: 'D:/x/probe.log', size: 42, lines: ['[t] hello', '[t] world'] } }
    if (endpoint === 'qqRelay/logClear') return { ok: true, value: { cleared: true, bytes: 2048 } }
    if (endpoint === 'qqRelay/faces') return { ok: true, value: { path: 'D:/x/faces.json', builtin: 120, custom: 0 } }
    if (endpoint === 'qqRelay/facesImport') return { ok: true, value: { ok: true, imported: 3, skipped: 0, path: 'D:/x/faces.json' } }
    if (endpoint === 'qqRelay/facesReset') return { ok: true, value: { ok: true, path: 'D:/x/faces.json' } }
    if (endpoint === 'qqRelay/fileClear') return { ok: true, value: { removed: 1, bytes: 100, dir: 'D:/x/files' } }
    if (endpoint === 'qqRelay/openFileDir') return { ok: true, value: { opened: true, dir: 'D:/x/files' } }
    return { ok: false, error: { code: 'test/unexpected', message: endpoint } }
  } } } : undefined),
  slots: {
    inject: (seat, run) => { registrations.push({ seat, run }); run() },
    register: (options, component) => { registrations[registrations.length - 1].options = options; registrations[registrations.length - 1].component = component },
  },
}

const registrationsSeen = []
// 把 register 记录成独立条目，便于断言
ctx.slots = {
  inject: (seat, run) => {
    const entry = { seat }
    const original = ctx.slots.register
    ctx.slots.register = (options, component) => registrationsSeen.push({ seat, options, component })
    try { run() } finally { ctx.slots.register = original }
  },
  register: () => {},
}

const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (registration) => { sandbox.__reg = registration },
    },
  },
  console,
  setTimeout,
  clearTimeout,
}
vm.createContext(sandbox)
new vm.Script(readFileSync(BUNDLE, 'utf8'), { filename: BUNDLE }).runInContext(sandbox)
// factory 的 require 是同步函数：只允许 react 这一颗种子
const exports = sandbox.__reg.factory((spec) => {
  if (spec === 'react') return harness.React
  throw new Error(`unexpected require: ${spec}`)
})
exports.apply(ctx)

// ---- 1. 注册 ----
const page = registrationsSeen.find((entry) => entry.seat === 'settings.section')
assert.ok(page, 'settings.section 没有注册')
assert.equal(page.options.id, 'qq-relay')
assert.equal(page.options.order, 120, '要排在皮肤管理（115）后面')
assert.equal(page.options.label(), 'QQ 中继')
console.log('page registration ->', JSON.stringify({ id: page.options.id, order: page.options.order }))

// ---- 2. 渲染 ----
const sessions = (selector) => selector({
  ids: ['session-cur'],
  byId: { 'session-cur': { retainedBy: { mainView: 1 } } },
})
let tree = await harness.render(page.component, { useSessions: sessions, close() {} })
// 第一次渲染时 `useEffect` 里的 load() 还没回来；再渲染一次看结果
tree = await harness.render(page.component, { useSessions: sessions, close() {} })
assert.match(textOf(tree), /QQ 中继/)
const appIdShown = [...walk(tree)].find((node) => node.props && node.props.value === 'app-1')
assert.ok(appIdShown, 'AppID 要从快照里显示出来')
assert.match(textOf(tree), /凭据已配置/, '有密钥时要显示“已配置”，而不是明文')
// 链路 / 界面两张卡已经按需求删掉；登录卡标题改成说清楚是登录机器人
assert.match(textOf(tree), /QQ 机器人登录/, '登录卡标题要写明是 QQ 机器人登录');
assert.doesNotMatch(textOf(tree), /消息从哪来/, '链路设置应该已经去掉');
assert.doesNotMatch(textOf(tree), /会话卡片/, '界面设置应该已经去掉');
assert.match(textOf(tree), /要点一次下面的「保存」才生效/, '登录区要说明“填完要点保存”')
console.log('rendered ->', textOf(tree).replace(/\s+/g, ' ').trim().slice(0, 160))

// ---- 3. 改 AppID → 保存只提交改动字段 ----
const appIdInput = [...walk(tree)].find((node) => node.props && node.props.value === 'app-1' && typeof node.props.onChange === 'function')
assert.ok(appIdInput, '没找到 AppID 输入框')
appIdInput.props.onChange('app-2')
tree = await harness.render(page.component, { useSessions: sessions, close() {} })
const saveButton = [...walk(tree)].find((node) => (node.children ?? []).includes('保存'))
assert.ok(saveButton, '没找到「保存」按钮')
await saveButton.props.onClick()
const updateCall = calls.find((call) => call.endpoint === 'qqRelay/configUpdate')
assert.ok(updateCall, '保存没有调用 configUpdate')
assert.deepEqual(JSON.parse(JSON.stringify(updateCall.payload.args)), { patch: { direct: { appId: 'app-2' } } },
  '只该提交改动的 appId；密钥空着不能出现在 patch 里')
console.log('update payload ->', JSON.stringify(updateCall.payload.args))

// ---- 4. 保存失败要显示 why ----
updateReply = { saved: false, why: 'direct.appSecret 太长（上限 128）' }
// 先改一个字段（否则保存会正确地报“没有改动”，根本不会发请求）
const ownerInput = [...walk(tree)].find((node) => node.props && node.props.value === 'owner-1' && typeof node.props.onChange === 'function')
assert.ok(ownerInput, '没找到 Owner 输入框')
ownerInput.props.onChange('owner-2')
tree = await harness.render(page.component, { useSessions: sessions, close() {} })
const saveAgain = [...walk(tree)].find((node) => (node.children ?? []).includes('保存'))
await saveAgain.props.onClick()
const failedTree = await harness.render(page.component, { useSessions: sessions, close() {} })
assert.match(textOf(failedTree), /direct\.appSecret 太长/, '失败原因要原样显示')
console.log('failure surfaced -> OK')

// ---- 5. 图库：「清空」按钮真的走 RPC 并回显结果 ----
{
  tree = await harness.render(page.component, { useSessions: sessions, close() {} })
  const clearButton = [...walk(tree)].find((node) => (node.children ?? []).includes('清空临时图库的所有图片'))
  assert.ok(clearButton, '没找到「清空临时图库的所有图片」按钮')
  await clearButton.props.onClick()
  const afterClear = await harness.render(page.component, { useSessions: sessions, close() {} })
  assert.ok(calls.some((call) => call.endpoint === 'qqRelay/imageClear'), '清空没有调用 RPC')
  assert.match(textOf(afterClear), /已清空：2 个/, '要把删掉的个数回显出来')
  console.log('image clear -> OK')
}

// ---- 6. 日志：能看到尾巴、能清空 ----
{
  tree = await harness.render(page.component, { useSessions: sessions, close() {} })
  tree = await harness.render(page.component, { useSessions: sessions, close() {} })
  assert.match(textOf(tree), /\[t\] hello/, '日志尾巴要显示出来')
  assert.match(textOf(tree), /probe\.log/, '要显示日志路径')
  const logClear = [...walk(tree)].find((node) => (node.children ?? []).includes('清空'))
  assert.ok(logClear, '没找到日志的「清空」按钮')
  await logClear.props.onClick()
  const afterLogClear = await harness.render(page.component, { useSessions: sessions, close() {} })
  assert.match(textOf(afterLogClear), /日志已清空/, '清空后要回显结果')
  console.log('log tail + clear -> OK')
}

// ---- 7. 表情表：能看到条数、能点「导入」 ----
{
  tree = await harness.render(page.component, { useSessions: sessions, close() {} })
  tree = await harness.render(page.component, { useSessions: sessions, close() {} })
  assert.match(textOf(tree), /内置 120 条/, '要显示内置表条数')
  const importButton = [...walk(tree)].find((node) => (node.children ?? []).includes('导入'))
  assert.ok(importButton, '没找到「导入」按钮')
  await importButton.props.onClick()
  const afterImport = await harness.render(page.component, { useSessions: sessions, close() {} })
  assert.ok(calls.some((call) => call.endpoint === 'qqRelay/facesImport'), '导入没有调用 RPC')
  assert.match(textOf(afterImport), /已导入 3 条/, '导入结果要回显')
  console.log('faces import -> OK')
}

// ---- 8. 文件：能清空、能回显 ----
{
  tree = await harness.render(page.component, { useSessions: sessions, close() {} })
  const fileClear = [...walk(tree)].find((node) => (node.children ?? []).includes('清空文件'))
  assert.ok(fileClear, '没找到「清空文件」按钮')
  await fileClear.props.onClick()
  const afterFileClear = await harness.render(page.component, { useSessions: sessions, close() {} })
  assert.ok(calls.some((call) => call.endpoint === 'qqRelay/fileClear'), '清空文件没有调用 RPC')
  assert.match(textOf(afterFileClear), /已清空：1 个文件/, '要回显删掉几个')
  console.log('file clear -> OK')
}

// ---- 9. 回执：开关、范围、文案都在 ----
{
  tree = await harness.render(page.component, { useSessions: sessions, close() {} })
  tree = await harness.render(page.component, { useSessions: sessions, close() {} })
  assert.match(textOf(tree), /回执/, '要有回执那一块')
  const ackInput = [...walk(tree)].find((node) => typeof (node.props && node.props.value) === 'string' && node.props.value.includes('收到啦'))
  assert.ok(ackInput, '回执文案输入框要带默认文案')
  const mediaChoice = [...walk(tree)].find((node) => (node.children ?? []).includes("只图片和文件"))
  assert.ok(mediaChoice, '要有「只图片和文件」选项')
  const mergeChoice = [...walk(tree)].find((node) => (node.children ?? []).includes("并进同一条"))
  const separateChoice = [...walk(tree)].find((node) => (node.children ?? []).includes("分开两条"))
  assert.ok(mergeChoice && separateChoice, '要有「发图配文」的两个选项')
  const captionField = [...walk(tree)].find((node) => node.props && node.props.label === 'DSH 主动发图配文')
  assert.ok(captionField, '标题要叫「DSH 主动发图配文」')
  assert.match(textOf(tree), /分开两条：先发一条纯图/, '两种模式都要有文字说明')
  const stickerField = [...walk(tree)].find((node) => node.props && node.props.label === '表情包暗号')
  assert.ok(stickerField, '要有「表情包暗号」设置项')
  const stickerInput = [...walk(tree)].find((node) => node.props && node.props.value === '存表情包')
  assert.ok(stickerInput, '暗号默认值要显示出来')
  const byQuoteField = [...walk(tree)].find((node) => node.props && node.props.label === '引用 + 暗号')
  const byAttachField = [...walk(tree)].find((node) => node.props && node.props.label === '直发图 + 暗号')
  assert.ok(byQuoteField && byAttachField, '两条收图路都要有开关')
  const byRecentField = [...walk(tree)].find((node) => node.props && node.props.label === '最近一张图 + 暗号')
  assert.ok(byRecentField, '「最近一张图」的兜底开关也要在')
  const sendFileField = [...walk(tree)].find((node) => node.props && node.props.label === '发文件上限（MB）')
  assert.ok(sendFileField, '要有「发文件上限」设置项')
  const freqField = [...walk(tree)].find((node) => node.props && node.props.label === '主动发表情包的频率')
  assert.ok(freqField, '要有「主动发表情包的频率」设置项')
  const oftenChoice = [...walk(tree)].find((node) => (node.children ?? []).includes('常发'))
  assert.ok(oftenChoice, '频率要有「常发」这一档')
  const stickerCard = [...walk(tree)].find((node) => (node.children ?? []).includes('表情包'))
  assert.ok(stickerCard, '表情包要独立成一张卡（和图片并列）')
  console.log('ack settings -> OK')
}

console.log('settings-page.test.mjs: all assertions passed')
