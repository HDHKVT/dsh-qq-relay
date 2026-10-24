// dsh-qq-relay —【第 0/1/2 步】
//
// 第 0 步：插件能不能拿到 sessionController？                      → 能（冷启动要用 ctx.inject）
// 第 1 步：投一条进指定会话                                        → 成功（accepted:true，目标会话真跑了回合）
// 第 2 步：把"手动请求文件"换成**工作区里的信箱**（本文件）
//          inbox\ 里有 *.json 就投，投完归档到 done\ / failed\
//          ⚠️ 仍然不接引擎、不接 QQ（那是第 3 步）；信箱里的文件由人手动放。
//
// 配置：D:\dsh-plugins\_media\dsh-qq-relay\relay.json
//   { "sessionId": "session-…",            // 必填：锁定哪条会话（= 将来"锁定按钮"写的东西）
//     "mailbox": "D:\\…\\daisy-mailbox" }  // 可选：手工指定信箱根；不填就自己找
//
// 自己找的路子（按顺序）：
//   ① 配置里的 mailbox
//   ② sessionController.list() 里那条会话的 cwd + \daisy-mailbox      ← 优先，最干净
//   ③ 兜底：读会话头 ~/.dsh/sessions/*/<sessionId>/session.v4.jsonl.zstd 第一行（Node 24 自带 zstd）
//
// 信箱结构：<root>\{inbox,done,failed}
//   谁用谁建：inbox 由"投递方"（将来是引擎）建；done/failed 由本插件建。
//   读的时候用 fs.watch 事件 + 60 秒兜底轮询 ⇒ 信箱空着时基本不碰磁盘。
//
// 一切结果都写在自己的数据目录里（不动工作区里别的文件）。

import { mkdirSync, writeFileSync, appendFileSync, readFileSync, renameSync, existsSync, readdirSync, watch, statSync, copyFileSync, unlinkSync, linkSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, basename, resolve, isAbsolute, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { readConfig, writeConfig, publicConfig } from './lib/config.js'
import { createDirect } from './lib/qq-direct.js'
import { makeDeduper, deliverEvent, bindPrompt, stripFaces } from './lib/delivery.js'
import { bindReplyForward } from './lib/qq-reply.js'
import { pickImage, pickImages, imageCandidates, quoteInfo, downloadImage, saveImage, pruneIncoming, clearIncoming, imageDirOf, incomingDirOf, stickersDirOf, sniffMime } from './lib/vision.js'
import { montage } from './lib/gif.js'
import { setCustomFaces, customFaceCount, FACE_NAMES } from './lib/qq-faces.js'
import { createImageBatcher } from './lib/batch.js'
import { pickFile, downloadFile, saveFile, pruneFiles, clearFiles, filesDirOf, biliDirOf } from './lib/files.js'
import { ackKind, shouldAck, renderAck } from './lib/ack.js'
import { addSticker, stickerDirOf, pickStickerSource, listStickers, stickerPath, renameSticker, removeSticker } from './lib/stickers.js'
import { runVideoProcessor, checkVideoSize, ensureAsciiInput } from './lib/video.js'
import { downloadBili, findBiliLink } from './lib/bilibili.js'
import { peekBili, prunePeekDirs } from './lib/bili-peek.js'
import { grabBiliFrames } from './lib/bili-frame.js'
import { readCredential, writeCredential, migrateFromConfig, credentialPathOf, cookieHeaderOf, clearCredential } from './lib/credential-store.js'
import { startQrLogin, pollQrLogin, saveLoginCredential } from './lib/bili-login-service.js'
import { describeLoginState } from './lib/login-flow.js'
import { buildBiliCardModel } from './lib/bili-card-model.js'

export const name = 'dsh-qq-relay'
export const inject = []

// v8 = 第 6 期 v2（**把图当像素投进会话**：读 `images[]` → base64 → `{type:'image'}` 块）。
// 为什么跳到 8：文档里那个"v7 定点修复"当时没跟着跳号，这里避开 7 免得两边对不上。
const CODE_VERSION = 8
// 插件的用户数据目录（relay.json / 日志 / 探针报告）。
// 默认 = `D:\dsh-plugins\_media\dsh-qq-relay`（v5 之前的实际位置），
// 但**允许环境变量改写**：自检用它把整个数据目录指到夹具里 ⇒ 一个字节都不碰真配置。
// ⚠️ 模块顶层求值 ⇒ 必须在 import 之前设好。
const BASE = process.env.DSH_QQ_RELAY_BASE || 'D:\\dsh-plugins\\_media\\dsh-qq-relay'
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(BASE, 'relay.json')
const LOG = join(BASE, 'probe.log')
/** 自定义表情表（id → 名字）；表在插件数据目录里，跟着插件走 */
const FACES_FILE = join(BASE, 'faces.json')

const MAILBOX_DIRNAME = 'daisy-mailbox'
const MAX_PER_MINUTE = 10
const MAX_FILE_BYTES = 256 * 1024
/** 🖼 v2：**单张图**交给会话的上限。
 *  比引擎那边的落盘上限（12MB）紧一点：这一层是"真要塞进请求体"的最后一道闸，
 *  超了就整封进 `failed/` **并说明**（绝不静默丢）。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const POLL_MS = 60_000
const PROMPT_TIMEOUT_MS = 15_000

/** 声明文件放哪：插件与引擎的**会合点**（默认 = 小屋应用目录，引擎的家、零猜测）。
 *  可用 `relay.json` 的 `declarationDir` 覆盖；环境变量 `DSH_QQ_RELAY_DECL_DIR`
 *  再兜一层（自检用，免得误碰真的 `%LOCALAPPDATA%\DaisyQQCottage\`）。 */
const DECLARATION_DIR_DEFAULT =
  process.env.DSH_QQ_RELAY_DECL_DIR || join(process.env.LOCALAPPDATA || '', 'DaisyQQCottage')
/** 小屋应用目录（引擎的家：`mailbox.json` 声明与 `data\settings.json` 都在它下面）。
 *  ⚠️ 做成**函数**（每次现读环境变量）：自检靠 `DSH_QQ_RELAY_APP_DIR` 指到临时目录，
 *  免得误改真的 `settings.json` ✓（模块顶层读的话，测试来不及覆盖）。 */
function appDirOf() {
  return process.env.DSH_QQ_RELAY_APP_DIR || DECLARATION_DIR_DEFAULT
}
/** 声明里的 owner —— **必须**与引擎期望的一致，否则引擎会当成"别人抢了信箱"而拒收 */
const DECLARATION_OWNER = 'dsh-plugin:dsh-qq-relay'
/** 心跳间隔：引擎那边 **180 秒**算过期 ⇒ 30 秒一跳足够稳 */
const HEARTBEAT_MS = 30_000
/** 投递成功后给主人的那句回执（引擎按 `relayAck` 决定发不发） */
const RECEIPT_TEXT = '（已交给会话）'

const KNOWN = ['sessionController', 'sandboxPolicy', 'tools', 'agents', 'settings']

// ---------- 小工具 ----------
function ensureDir(dir) { try { mkdirSync(dir, { recursive: true }) } catch { /* 不能因记日志而拖垮宿主 */ } }
function log(line) { try { ensureDir(BASE); appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`) } catch { /* 同上 */ } }
/**
 * 启动时**只打一行**。其余全部进 probe.log —— 启动台是给人看的，
 * 十几行状态会把真正的报警淹掉（2026-10-18 主人提的）。
 */
let announced = false
function announceStartup() {
  if (announced) return
  announced = true
  try {
    const cfg = readConfig(BASE)
    const lock = cfg.sessionId ? `锁定 ${String(cfg.sessionId).slice(0, 24)}` : '未锁定会话'
    console.log(`[dsh-qq-relay] ready · transport=${cfg.transport} · ${lock} · 详情见 probe.log`)
  } catch { /* 打日志失败也不拖垮宿主 */ }
}

/** 日志超过 2MB 就轮转一份；历史只留最近两份。 */
const LOG_MAX_BYTES = 2 * 1024 * 1024
function rotateLogIfBig() {
  try {
    if (!existsSync(LOG) || statSync(LOG).size < LOG_MAX_BYTES) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    renameSync(LOG, `${LOG}.${stamp}`)
    const histories = readdirSync(BASE).filter((name) => name.startsWith('probe.log.') && !name.endsWith('.bak')).sort()
    while (histories.length > 2) {
      const oldest = histories.shift()
      try { unlinkSync(join(BASE, oldest)) } catch { /* 忽略 */ }
    }
  } catch { /* 轮转失败不影响启动 */ }
}

/** 启动时把 `faces.json` 读进内存（没有就用内置表）。 */
function loadCustomFaces() {
  const raw = readJson(FACES_FILE)
  if (raw) setCustomFaces(raw)
  return customFaceCount()
}

function nameChain(obj) {
  const names = new Set()
  try {
    let cur = obj, depth = 0
    while (cur && cur !== Object.prototype && depth < 6) {
      for (const n of Object.getOwnPropertyNames(cur)) names.add(n)
      cur = Object.getPrototypeOf(cur); depth += 1
    }
  } catch { /* 代理对象可能拒绝 */ }
  return [...names].sort()
}

function describe(label, value) {
  const out = { label, present: value !== undefined && value !== null }
  if (!out.present) return out
  try {
    out.typeof = typeof value
    out.ctor = (value && value.constructor && value.constructor.name) || null
    const names = nameChain(value)
    out.memberCount = names.length
    out.members = {}
    for (const m of names.slice(0, 80)) { try { out.members[m] = typeof value[m] } catch { out.members[m] = '<throws>' } }
  } catch (e) { out.describeError = String((e && e.message) || e) }
  return out
}

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }

/** 兜底：直接从会话头里读 cwd（Node 24 自带 zstd，不用外部工具） */
function cwdFromSessionHeader(sessionId) {
  try {
    const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
    const root = join(home, 'sessions')
    if (!existsSync(root)) return { ok: false, why: 'sessions 目录不存在' }
    for (const bucket of readdirSync(root)) {
      const file = join(root, bucket, sessionId, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const first = zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n')[0]
      const header = JSON.parse(first)
      if (header && header.cwd) return { ok: true, cwd: header.cwd, from: `header:${bucket}` }
    }
    return { ok: false, why: '没找到该会话的会话头' }
  } catch (e) { return { ok: false, why: String((e && e.message) || e) } }
}

/** 原子写一个小 JSON（先 `.tmp` 再改名）。
 *  读者是**另一个进程**（引擎）：半截 JSON 会被它当成"没有声明"，所以必须原子。 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * 发布**声明**：告诉引擎"信箱在哪"以及"我还活着"（心跳）。
 *
 * 引擎靠它决定：往哪个目录投、要不要在 QQ 上提醒"收件方好像不在"。
 * ⚠️ 心跳**必须**持续刷新 —— 停了引擎就会认为收件方不在（那是**有意**的设计：失败要吵）。
 */
function publishDeclaration(dir, mailbox, sessionId, at) {
  const now = Date.now()
  writeJsonAtomic(join(dir, 'mailbox.json'), {
    protocol: 1,
    owner: DECLARATION_OWNER,
    mailbox,
    sessionId,
    heartbeat: now,
    at: at ?? now,
  })
}

/** 往 `outbox\` 写一条回执（引擎会按 `relayAck` 决定发不发它）。
 *  文件名照契约：`<yyyymmdd>-<hhmmss>-<6位随机>.json`（引擎按名字排序即时间序）。 */
function writeReceipt(outboxDir, inboxId, text) {
  ensureDir(outboxDir)
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const salt = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
  const file = join(outboxDir, `${stamp}-${salt}.json`)
  writeJsonAtomic(file, {
    protocol: 1,
    id: `receipt-${inboxId || salt}`,
    at: Date.now(),
    kind: 'text',
    text,
    replyTo: inboxId ?? null,
  })
  return file
}

// ---------- 工具版要用的几件小事（锁定会话 / 看状态 / 切引擎模式）----------

/**
 * 当前该用哪个 B 站 cookie：
 *   独立凭证文件优先（搬过去之后的主路径），没有才退回 relay.json 里的旧字段。
 */
function currentBiliCookie(cfg) {
  const stored = readCredential(BASE)
  if (stored.ok) {
    const header = cookieHeaderOf(stored.record)
    if (header !== '') return header
  }
  return cfg.video.biliCookie || ''
}

/** 秒 → mm:ss（不足 1 小时）/ h:mm:ss；bili_frame 的输出用 */
function formatStampOf(seconds) {
  const total = Math.round(Number(seconds) || 0)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const two = (value) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${two(minutes)}:${two(secs)}`
}

/** 工具的输出契约（照 dsh-ops 的形状：`{content:[…], structuredContent?}`） */
const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    properties: { content: { type: 'array', items: {} }, structuredContent: {} },
    required: ['content'],
    additionalProperties: false,
  },
  render: (_args, value) => (value && Array.isArray(value.content) ? value.content : []),
}

/** 小屋引擎读设置的地方（`<appDir>\data\settings.json`） */
function settingsPathOf(appDir) {
  return join(appDir, 'data', 'settings.json')
}

/** 读引擎当前的 QQ 模式（读不到/认不出 ⇒ 按 answer 报） */
function readEngineMode(appDir) {
  const settings = readJson(settingsPathOf(appDir)) || {}
  const raw = String(settings.qqMode ?? '').trim().toLowerCase()
  return raw === 'relay' ? 'relay' : 'answer'
}

/** 改引擎的 QQ 模式：**原子写 + 留一份 `.bak`**（引擎每条消息前重读 ⇒ 立刻生效、不用重启） */
function writeEngineMode(appDir, mode) {
  const file = settingsPathOf(appDir)
  const before = readJson(file) || {}
  ensureDir(join(appDir, 'data'))
  if (existsSync(file)) copyFileSync(file, `${file}.bak`)
  writeJsonAtomic(file, { ...before, qqMode: mode })
  return file
}

/** 写锁定配置（**保留**已有的 mailbox / declarationDir / hint 等键） */
function writeLockFile(lockFile, sessionId) {
  const before = readJson(lockFile) || {}
  writeJsonAtomic(lockFile, { ...before, sessionId })
  return lockFile
}

/** 从工具调用的 `exec` 里取"当前是哪条会话" */
function sessionIdOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  if (!session) return null
  return (
    (session.header && (session.header.id || session.header.sessionId)) ||
    session.id ||
    session.sessionId ||
    null
  )
}

/**
 * 状态装配（工具 `relay_status` 与浏览器卡片**读同一份实现** ⇒ 两边永远不会说两套话）。
 *
 * @param resolved - `{mailbox, how}` 或 null（还没定位到工作区）。
 * @param runStats - `{processed, errors}` 本次运行的计数。
 * @returns 纯数据快照（Remote 直接把它交给浏览器）。
 */
function readRelayState(resolved, runStats) {
  const cfg = readJson(CONFIG) || {}
  const appDir = appDirOf()
  const now = Date.now()
  // 声明可能写在 ①relay.json 的 declarationDir ②环境变量 ③appDir 里 ——
  // 顺序与 `startMailbox` 的发布顺序**一致**，取第一个真存在的（读不到就说读不到）。
  const declCandidates = [
    cfg.declarationDir,
    process.env.DSH_QQ_RELAY_DECL_DIR,
    appDir,
  ].filter((d) => typeof d === 'string' && d.length > 0)
  const declDirs = [...new Set(declCandidates.map((d) => join(d, 'mailbox.json')))]
  const declFile = declDirs.find((file) => existsSync(file)) || declDirs[declDirs.length - 1]
  const decl = readJson(declFile)
  const heartbeatAgeSec = decl && decl.heartbeat ? Math.round((now - decl.heartbeat) / 1000) : null
  const countIn = (dir) => {
    try { return readdirSync(dir).filter((n) => n.endsWith('.json')).length } catch { return 0 }
  }
  const mailbox = (resolved && resolved.mailbox) || (decl && decl.mailbox) || null
  return {
    protocol: 1,
    codeVersion: CODE_VERSION,
    at: now,
    sessionId: cfg.sessionId || null,
    hint: cfg.hint !== false,
    transport: cfg.transport === 'direct' ? 'direct' : 'mailbox',
    direct: (runStats && runStats.direct) || null,
    engineMode: readEngineMode(appDir),
    appDir,
    declaration: {
      path: declFile,
      published: existsSync(declFile),
      owner: decl ? decl.owner ?? null : null,
      heartbeatAgeSec,
      fresh: heartbeatAgeSec !== null && heartbeatAgeSec <= 180,
    },
    mailbox: {
      root: mailbox,
      how: (resolved && resolved.how) || (decl ? 'declaration' : null),
      inbox: mailbox ? countIn(join(mailbox, 'inbox')) : null,
      outbox: mailbox ? countIn(join(mailbox, 'outbox')) : null,
      done: mailbox ? countIn(join(mailbox, 'done')) : null,
      failed: mailbox ? countIn(join(mailbox, 'failed')) : null,
      sent: mailbox ? countIn(join(mailbox, 'sent')) : null,
    },
    runStats: {
      processed: (runStats && runStats.processed) || 0,
      errors: (runStats && runStats.errors) || 0,
    },
  }
}

/** 把状态快照铺成给人看的多行文本（工具的输出；卡片用结构化字段自己排版）。 */
function stateText(state) {
  const decl = state.declaration
  const mb = state.mailbox
  const lines = [
    '锁定会话：' + (state.sessionId || '（没锁 —— relay.json 里没有 sessionId）'),
    '信箱：' + (mb.root || '（还没定位到）') + (mb.root ? '   ← ' + mb.how : ''),
    '声明：' + (decl.published
      ? decl.path + '（心跳 ' + decl.heartbeatAgeSec + ' 秒前' + (decl.fresh ? ' ✓' : ' ⚠️ 已过期') + '）'
      : '（还没发布）'),
    '引擎 QQ 模式：' + state.engineMode + (state.engineMode === 'relay' ? ' ✓' : '（= 引擎自己答；要用中继得切 relay）'),
  ]
  if (mb.root) {
    lines.push('信箱条数：inbox ' + mb.inbox + ' · done ' + mb.done + ' · failed ' + mb.failed
      + ' · outbox ' + mb.outbox + ' · sent ' + mb.sent)
  }
  lines.push('本次运行：投递 ' + state.runStats.processed + ' 条 · 报错 ' + state.runStats.errors + ' 条')
  return lines.join('\n')
}

// ======================= 浏览器腿 → 宿主腿 的通道（v6 新增）=======================
//
// 姿势（只读调研 + 真机安装包实测，细节见 test/host-behaviour.test.mjs 与 README）：
//   **客户端** `ctx.connection.rpc.call('/api', '<ns>/<method>', { args: {…} })`
//   → Connection 把包投给宿主的 `/api` 拦截器
//   → **宿主** `TypertGatewayService`（profile 里那行 `typert-gateway`）用
//     `claimsEndpoint()` 认出这个端点，再走 **SRC 模式**（源码反射）派发到我们注册的
//     Cordis 服务方法上。
//
// 为什么能"零构建、零新依赖"就通：SRC 模式是官方给"从未有过严格定义"的端点留的
// 开发兜底 —— 它**从方法源码里解析参数名**（`methodParameterNames()`），
// 只要求每个参数是唯一的裸标识符（不许解构 / 默认值 / rest）。
// 所以这里只需要三样东西，全部可以照抄、不需要代码生成：
//   ① 服务的 `typertRemote` 绑定（`{service, serviceKey, namespace}`，冻结）
//   ② 类原型上的方法标记（`version:1` + `methods:[{method, invocation:{kind:'direct'}}]`）
//   ③ 服务本身是个**普通对象**，用 `ctx.provide(serviceKey, obj)` 挂上
//      ⇒ 连 cordis / typert-protocol 都不用 import（它们的 ESM 入口按裸名从这个
//      插件的真实路径解析不到；实测 `createRequire(profile)` 能解析，
//      但普通对象这条路更短、更稳，也避免了重复模块实例）。
//
// 两个"抄来的字符串"由 test/host-behaviour.test.mjs 对照**真安装包**守卫：
// 一旦 DSH 改了标记键或绑定形状，那个测试会红（它会 import 真实
// `dsh-api-gateway`，让真网关认领并派发这两个端点）。

/** 宿主侧 Remote 服务（浏览器腿唯一调得到的入口）。 */
const REMOTE_SERVICE_KEY = 'qqRelayRemote'
/** 线上命名空间：端点 = `qqRelay/status`、`qqRelay/act`。 */
const REMOTE_NAMESPACE = 'qqRelay'
/** 抄自 `@deepseek-ai/dsh-typert-protocol` 的标记键（`REMOTE_METHOD_DESCRIPTOR`）。 */
const REMOTE_METHOD_DESCRIPTOR_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'
/** SRC 模式从**源码**里解析参数名：只留唯一的裸标识符（见 methodParameterNames）。 */
/** 待确认的扫码登录（一次只跟一个码）。生成后放这里，check 时用。 */
let pendingQr = null
/** 扫码登录当前相位（给设置卡用；工具和界面共用一份） */
let loginPhase = 'idle'
let loginReason = ''

const REMOTE_METHOD_NAMES = ['status', 'act', 'config', 'configUpdate', 'biliCard', 'biliLoginStart', 'biliLoginPoll', 'biliLogout', 'imageClear', 'openImageDir', 'logTail', 'logClear', 'faces', 'facesImport', 'facesReset', 'fileClear', 'openFileDir', 'videoClear', 'openVideoDir', 'biliClear', 'openBiliDir']
/** 状态快照的短缓存：心跳每 30 秒刷新一次声明，卡片 10 秒轮询 ⇒ 30 秒够用。 */
const REMOTE_STATUS_TTL_MS = 30_000

/**
 * 建宿主侧 Remote 服务对象。
 *
 * ⚠️ 它**只读地**导出状态、"转发地"执行动作：真正的锁定/解锁/切模式实现仍然是
 * `apply()` 里那三个（工具用的同一份）⇒ 加这条路**不改任何既有语义**。
 *
 * @param runtime - `apply()` 提供的回调：`status() / act(args)`。
 * @returns 可直接 `ctx.provide()` 的服务对象。
 */
function createRemoteService(runtime) {
  let cache = null
  let cachedAt = 0

  class QqRelayRemote {}

  QqRelayRemote.prototype.status = function status() {
    const now = Date.now()
    if (cache && now - cachedAt < REMOTE_STATUS_TTL_MS) return cache
    cache = runtime.status()
    cachedAt = now
    return cache
  }

  QqRelayRemote.prototype.act = function act(args) {
    return runtime.act(args)
  }

  /** 设置页读到的快照：**密钥只回“有没有”**（见 lib/config.js 的 publicConfig）。 */
  QqRelayRemote.prototype.config = function config() {
    return runtime.config()
  }

  /** B 站设置卡的数据模型（登录态 + 三个字段 + 按钮可用性）。 */
  QqRelayRemote.prototype.biliCard = function biliCard() {
    return runtime.biliCard()
  }

  /** 生成扫码登录的二维码，回 data URL 给浏览器直接显示。 */
  QqRelayRemote.prototype.biliLoginStart = function biliLoginStart() {
    return runtime.biliLoginStart()
  }

  /** 查一次扫码状态；确认了就存凭证。 */
  QqRelayRemote.prototype.biliLoginPoll = function biliLoginPoll() {
    return runtime.biliLoginPoll()
  }

  /** 退出登录：删掉凭证文件。 */
  QqRelayRemote.prototype.biliLogout = function biliLogout() {
    return runtime.biliLogout()
  }

  /** 设置页保存：返回 `{ saved, why? }`；校验失败不抛异常，让界面把原因原样显示。 */
  QqRelayRemote.prototype.configUpdate = function configUpdate(patch) {
    return runtime.configUpdate(patch)
  }

  /** 清空 `images\incoming\`（设置页「清空」按钮）。 */
  QqRelayRemote.prototype.imageClear = function imageClear() {
    return runtime.imageClear()
  }

  /** 在图库里打开图库目录（宿主侧 explorer.exe）。 */
  QqRelayRemote.prototype.openImageDir = function openImageDir() {
    return runtime.openImageDir()
  }

  /** 清空文件目录。 */
  QqRelayRemote.prototype.fileClear = function fileClear() {
    return runtime.fileClear()
  }

  /** 打开文件目录。 */
  QqRelayRemote.prototype.openFileDir = function openFileDir() {
    return runtime.openFileDir()
  }

  /** 清空视频缓存（`video-cache\`）。 */
  QqRelayRemote.prototype.videoClear = function videoClear() {
    return runtime.videoClear()
  }

  /** 打开视频缓存目录。 */
  QqRelayRemote.prototype.openVideoDir = function openVideoDir() {
    return runtime.openVideoDir()
  }

  /** 清空 B 站下载目录。 */
  QqRelayRemote.prototype.biliClear = function biliClear() {
    return runtime.biliClear()
  }

  /** 打开 B 站下载目录。 */
  QqRelayRemote.prototype.openBiliDir = function openBiliDir() {
    return runtime.openBiliDir()
  }

  /** 读日志尾巴（设置页「日志」一节）。 */
  QqRelayRemote.prototype.logTail = function logTail(lines) {
    return runtime.logTail(lines)
  }

  /** 清空日志（会先留一份 `.bak`）。 */
  QqRelayRemote.prototype.logClear = function logClear() {
    return runtime.logClear()
  }

  /** 表情表信息（内置几条 / 自定义几条 / 文件在哪）。 */
  QqRelayRemote.prototype.faces = function faces() {
    return runtime.faces()
  }

  /** 导入一份自定义表情表（JSON 文件路径）。 */
  QqRelayRemote.prototype.facesImport = function facesImport(file) {
    return runtime.facesImport(file)
  }

  /** 恢复内置表（删掉 faces.json）。 */
  QqRelayRemote.prototype.facesReset = function facesReset() {
    return runtime.facesReset()
  }

  // ② 方法标记：等价于给这两个方法各打一个 `@Remote`（见文件头注释）。
  Object.defineProperty(QqRelayRemote.prototype, REMOTE_METHOD_DESCRIPTOR_KEY, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(REMOTE_METHOD_NAMES.map((method) => Object.freeze({
        method,
        invocation: Object.freeze({ kind: 'direct' }),
      }))),
    }),
  })

  const service = new QqRelayRemote()
  // ① 绑定：`service` 必须**恒等于**被注册的那个对象（网关会按同一性校验）。
  service.typertRemote = Object.freeze({
    service,
    serviceKey: REMOTE_SERVICE_KEY,
    namespace: REMOTE_NAMESPACE,
  })
  /** 让下一次 `status()` 必读磁盘（锁定/解锁/切模式之后调用）。 */
  service.invalidate = () => { cache = null; cachedAt = 0 }
  return service
}

export function apply(ctx, rowConfig = {}) {
  rotateLogIfBig()
  loadCustomFaces()
  // 登录凭证从 relay.json 搬进独立文件（只搬一次；已有文件就不动）
  try {
    const migrated = migrateFromConfig(BASE, readConfig(BASE))
    if (migrated.migrated) log(`[cred] ${migrated.why} → ${migrated.path}`)
  } catch (error) {
    log(`[cred] 凭证搬迁失败（不影响启动）：${String((error && error.message) || error)}`)
  }
  const at = new Date().toISOString()
  const report = {
    step: 'probe+mailbox', codeVersion: CODE_VERSION, at,
    node: process.version, platform: `${process.platform}-${process.arch}`,
    cwd: process.cwd(), rowConfig,
    ctxApi: {}, atApply: [], inject: { registered: false, fired: false },
    relay: { config: null, resolved: null, watching: null, processed: [], errors: [] },
    notes: [],
  }

  log(`apply() called — codeVersion=${CODE_VERSION}, node ${process.version}, host cwd ${process.cwd()}`)
  log(`loaded (codeVersion=${CODE_VERSION}, probe+mailbox)`)

  try {
    report.ctxApi.ownKeys = Object.getOwnPropertyNames(ctx).sort()
    report.ctxApi.getIsFunction = typeof ctx.get === 'function'
    report.ctxApi.injectIsFunction = typeof ctx.inject === 'function'
    report.ctxApi.onIsFunction = typeof ctx.on === 'function'
  } catch (e) { report.ctxApi.error = String((e && e.message) || e) }

  for (const n of KNOWN) {
    try { report.atApply.push(describe(n, ctx.get(n))) }
    catch (e) { report.atApply.push({ label: n, getThrew: String((e && e.message) || e) }) }
  }
  log(`services visible at apply: ${report.atApply.filter((s) => s.present).map((s) => s.label).join(',') || 'none (冷启动正常)'}`)

  // ---- 等会话服务就绪：冷启动下 apply 那一刻它是空的（实测）----
  let watcher = null
  let pollTimer = null
  let heartbeatTimer = null
  let disposed = false
  let currentSvc = null
  let toolDisposers = []
  let remoteService = null
  /** 🆕 直连传输（transport=direct 时才起）；探针阶段只记日志，不投递。 */
  let direct = null
  /** 🆕 连发多图的合并器（见 lib/batch.js） */
  let imageBatcher = null
  /** 🆕 requestId → {openid, msgId}：回信时要知道这条该发给谁。 */
  const pendingReplies = new Map()
  /**
   * 🆕 直连投递用的取消信号。
   *
   * 🔴 **必须传**：`session/prompt` 的实现会无条件读 `signal.throwIfAborted()`
   * （2026-10-17 真机踩过：不传 → `Cannot read properties of undefined (reading 'throwIfAborted')`，
   * 而 QQ 那边表现为“没回复”）。信箱那条腿一直传着 `controller.signal`，所以没暴露。
   */
  const promptAbort = new AbortController()
  /** 🆕 取消 `session/event` 订阅（dispose 时调）。 */
  let unbindReply = null

  // 🆕 v6：注册宿主侧 Remote 服务（浏览器卡片的后端）。**只追加，不动既有行为**：
  //   开启失败也只记一笔 —— 信箱与四个工具照旧跑（远程通道是"锦上添花"的那条腿）。
  try {
    remoteService = createRemoteService({
      status: () => readRelayState(report.relay.resolved, {
        processed: report.relay.processed.length,
        errors: report.relay.errors.length,
        direct: direct ? direct.state() : null,
      }),
      act: (args) => localAction(args),
      config: () => publicConfig(readConfig(BASE)),
      configUpdate: (patch) => {
        const before = readConfig(BASE)
        const result = writeConfig(BASE, patch)
        if (!result.ok) return { saved: false, why: result.why }
        const after = readConfig(BASE)
        // 传输改了 ⇒ 立刻换腿（停掉旧的、起新的），不用重启 DSH
        if (before.transport !== after.transport) {
          try { applyTransportConfig() } catch (e) { log(`[transport] 切换失败：${String((e && e.message) || e)}`) }
        }
        // 下一轮读状态要看到新值（状态快照有 30 秒缓存）
        try { if (remoteService && typeof remoteService.invalidate === 'function') remoteService.invalidate() } catch { /* 忽略 */ }
        return { saved: true }
      },
      biliLogout: () => {
        const got = clearCredential(BASE)
        pendingQr = null
        loginPhase = 'idle'
        loginReason = ''
        if (!got.ok) return { ok: false, why: got.why }
        log(`[login] 凭证已清除${got.removed ? '' : '（本来就没有）'}`)
        return { ok: true, removed: Boolean(got.removed) }
      },
      biliCard: () => {
        const stored = readCredential(BASE)
        return buildBiliCardModel({
          validation: stored.ok ? stored.validation : null,
          config: readConfig(BASE).video,
          login: { phase: loginPhase, reason: loginReason },
        })
      },
      biliLoginStart: async () => {
        try {
          const cfg = readConfig(BASE)
          const pythonPath = cfg.video.python || join(PLUGIN_DIR, 'video', '.venv', 'Scripts', 'python.exe')
          const qrScript = join(PLUGIN_DIR, 'video', 'qr_render.py')
          const dir = join(BASE, 'qr')
          const got = await startQrLogin({ dir, pythonPath, qrScript })
          if (!got.ok) { loginPhase = 'error'; loginReason = got.why; return { ok: false, why: got.why } }
          pendingQr = { key: got.qrKey, startedAtMs: Date.now() }
          loginPhase = 'waiting'; loginReason = ''
          const base64 = readFileSync(got.pngPath).toString('base64')
          log('[login] 界面生成了二维码')
          return { ok: true, dataUrl: `data:image/png;base64,${base64}`, key: got.qrKey, qrUrl: got.qrUrl }
        } catch (error) {
          const message = String((error && error.message) || error)
          loginPhase = 'error'; loginReason = message
          return { ok: false, why: message }
        }
      },
      biliLoginPoll: async () => {
        if (!pendingQr || !pendingQr.key) return { ok: false, state: 'idle', text: '还没有生成二维码' }
        const verdict = await pollQrLogin({ qrKey: pendingQr.key })
        if (!verdict.ok) {
          loginPhase = 'error'; loginReason = verdict.reason || ''
          return { ok: false, state: 'error', text: `轮询失败：${verdict.reason || '未知原因'}` }
        }
        if (verdict.state === 'confirmed') {
          const saved = saveLoginCredential({ baseDir: BASE, pollResult: verdict })
          loginPhase = 'success'; loginReason = ''
          pendingQr = null
          if (!saved.ok) {
            loginPhase = 'error'; loginReason = saved.why
            return { ok: false, state: 'error', text: `登录成功但保存失败：${saved.why}` }
          }
          log('[login] 界面扫码登录成功，凭证已更新')
          return { ok: true, state: 'confirmed', text: '登录成功，凭证已保存' }
        }
        if (verdict.state === 'pending') { loginPhase = 'waiting' }
        else if (verdict.state === 'scanned') { loginPhase = 'scanned' }
        else if (verdict.state === 'expired') { loginPhase = 'expired'; loginReason = ''; pendingQr = null }
        else { loginPhase = 'error'; loginReason = verdict.reason || ''; pendingQr = null }
        const view = describeLoginState({ state: verdict.state, reason: verdict.reason })
        return { ok: true, state: verdict.state, text: view.ok ? view.text : String(verdict.state) }
      },
      imageClear: () => {
        const cfg = readConfig(BASE)
        const dir = incomingDirOf(imageDirOf(BASE, cfg))
        const result = clearIncoming(dir)
        log(`[image] 清空 incoming：${result.removed} 个 / ${Math.round(result.bytes / 1024)}KB`)
        return { ...result, dir }
      },
      openImageDir: () => {
        const cfg = readConfig(BASE)
        const dir = imageDirOf(BASE, cfg)
        try {
          // 两个子目录一起建出来：incoming（临时、按天清）+ stickers（以后的永久区）
          mkdirSync(incomingDirOf(dir), { recursive: true })
          mkdirSync(stickersDirOf(dir), { recursive: true })
          const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' })
          child.unref()
          return { opened: true, dir }
        } catch (error) {
          return { opened: false, why: String((error && error.message) || error), dir }
        }
      },
      /** 清空文件目录（`files\`）。 */
      fileClear: () => {
        const cfg = readConfig(BASE)
        const dir = filesDirOf(BASE, cfg)
        const result = clearFiles(dir)
        log(`[file] 清空 files：${result.removed} 个 / ${Math.round(result.bytes / 1024)}KB`)
        return { ...result, dir }
      },
      /** 打开文件目录。 */
      openFileDir: () => {
        const cfg = readConfig(BASE)
        const dir = filesDirOf(BASE, cfg)
        try {
          mkdirSync(dir, { recursive: true })
          const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' })
          child.unref()
          return { opened: true, dir }
        } catch (error) {
          return { opened: false, why: String((error && error.message) || error), dir }
        }
      },
      /** 清空视频缓存（`video-cache\`，里面是每次的拼图与 result.json）。 */
      videoClear: () => {
        const cfg = readConfig(BASE)
        const dir = cfg.video.outDir || join(BASE, 'video-cache')
        let removed = 0
        let bytes = 0
        const walk = (target) => {
          for (const name of readdirSync(target)) {
            const child = join(target, name)
            const info = statSync(child)
            if (info.isDirectory()) walk(child)
            else { bytes += info.size; removed += 1 }
          }
        }
        try { if (existsSync(dir)) walk(dir) } catch (error) { log(`[video] 统计缓存失败：${String((error && error.message) || error)}`) }
        try {
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
        } catch (error) {
          const why = String((error && error.message) || error)
          log(`[video] 清空缓存失败：${why}`)
          return { removed: 0, bytes: 0, dir, ok: false, why }
        }
        log(`[video] 清空缓存：${removed} 个 / ${Math.round(bytes / 1024)}KB`)
        return { removed, bytes, dir, ok: true }
      },
      /** 打开视频缓存目录。 */
      openVideoDir: () => {
        const cfg = readConfig(BASE)
        const dir = cfg.video.outDir || join(BASE, 'video-cache')
        try {
          mkdirSync(dir, { recursive: true })
          const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' })
          child.unref()
          return { opened: true, dir }
        } catch (error) {
          return { opened: false, why: String((error && error.message) || error), dir }
        }
      },
      /** 清空 B 站下载目录。 */
      biliClear: () => {
        const cfg = readConfig(BASE)
        const dir = biliDirOf(BASE, cfg)
        const result = clearFiles(dir)
        log(`[bili] 清空下载目录：${result.removed} 个 / ${Math.round(result.bytes / 1024 / 1024)}MB`)
        return { ...result, dir }
      },
      /** 打开 B 站下载目录。 */
      openBiliDir: () => {
        const cfg = readConfig(BASE)
        const dir = biliDirOf(BASE, cfg)
        try {
          mkdirSync(dir, { recursive: true })
          const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' })
          child.unref()
          return { opened: true, dir }
        } catch (error) {
          return { opened: false, why: String((error && error.message) || error), dir }
        }
      },
      /** 读日志尾巴（设置页「日志」一节直接用）。 */
      logTail: (lines) => {
        const want = Math.max(1, Math.min(2000, Number(lines) || 200))
        try {
          const text = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
          const all = text.split('\n').filter((line) => line !== '')
          return { path: LOG, size: text.length, lines: all.slice(-want) }
        } catch (error) {
          return { path: LOG, size: 0, lines: [], error: String((error && error.message) || error) }
        }
      },
      /** 清空日志：先留一份 `.bak`，再截断。 */
      logClear: () => {
        try {
          const size = existsSync(LOG) ? statSync(LOG).size : 0
          if (size > 0) copyFileSync(LOG, `${LOG}.bak`)
          writeFileSync(LOG, '', 'utf8')
          return { cleared: true, bytes: size }
        } catch (error) {
          return { cleared: false, bytes: 0, error: String((error && error.message) || error) }
        }
      },
      /** 表情表现状：内置多少、自定义多少、文件在哪。 */
      faces: () => ({
        path: FACES_FILE,
        builtin: Object.keys(FACE_NAMES).length,
        custom: customFaceCount(),
      }),
      /** 从 JSON 文件导入自定义表情表（id → 名字），落盘成 faces.json。 */
      facesImport: (file) => {
        try {
          const target = typeof file === 'string' && file.trim() !== '' ? file.trim() : FACES_FILE
          const raw = JSON.parse(readFileSync(target, 'utf8'))
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return { ok: false, why: '文件内容必须是一个 JSON 对象：{"478": "名字"}' }
          }
          const normalized = {}
          let skipped = 0
          for (const [key, value] of Object.entries(raw)) {
            const id = Number(key)
            const name = typeof value === 'string' ? value.trim() : ''
            if (!Number.isInteger(id) || id < 0 || id > 99999 || name === '' || name.length > 24) { skipped += 1; continue }
            normalized[String(id)] = name
          }
          if (Object.keys(normalized).length === 0) {
            return { ok: false, why: '一条可用的条目都没有（键要是数字，值要是名字）' }
          }
          ensureDir(BASE)
          try { if (existsSync(FACES_FILE)) copyFileSync(FACES_FILE, `${FACES_FILE}.bak`) } catch { /* 忽略 */ }
          writeFileSync(FACES_FILE, JSON.stringify(normalized, null, 2), 'utf8')
          setCustomFaces(normalized)
          log(`[faces] 导入 ${Object.keys(normalized).length} 条（跳过 ${skipped} 条）← ${target}`)
          return { ok: true, imported: Object.keys(normalized).length, skipped, path: FACES_FILE }
        } catch (error) {
          return { ok: false, why: String((error && error.message) || error) }
        }
      },
      /** 恢复内置表（删掉 faces.json，留一份 .bak）。 */
      facesReset: () => {
        try {
          if (existsSync(FACES_FILE)) {
            try { copyFileSync(FACES_FILE, `${FACES_FILE}.bak`) } catch { /* 忽略 */ }
            unlinkSync(FACES_FILE)
          }
          setCustomFaces({})
          log('[faces] 已恢复内置表')
          return { ok: true, path: FACES_FILE }
        } catch (error) {
          return { ok: false, why: String((error && error.message) || error) }
        }
      },
    })
    if (typeof ctx.provide !== 'function') throw new Error('ctx.provide 不是函数')
    ctx.provide(REMOTE_SERVICE_KEY, remoteService)
    report.remote = { serviceKey: REMOTE_SERVICE_KEY, namespace: REMOTE_NAMESPACE, methods: REMOTE_METHOD_NAMES.slice() }
    log(`remote service registered: ${REMOTE_NAMESPACE}/{${REMOTE_METHOD_NAMES.join(',')}} as ctx.${REMOTE_SERVICE_KEY}`)
  } catch (e) {
    const m = String((e && e.message) || e)
    report.remote = { error: m }
    report.relay.errors.push(`注册 Remote 服务失败：${m}`)
    log(`register remote service failed: ${m}`)
  }

  try {
    ctx.inject(['sessionController'], (scoped) => {
      report.inject.fired = true
      report.inject.firedAt = new Date().toISOString()
      log('ctx.inject(sessionController) fired — 开始处理信箱')
      const svc = (scoped && typeof scoped.get === 'function' ? scoped.get('sessionController') : null) || ctx.get('sessionController')
      currentSvc = svc
      try { report.inject.service = describe('sessionController', svc) } catch { /* 忽略 */ }
      // 🆕 v5：注册四个工具（锁定会话 / 解锁 / 看状态 / 切引擎模式）—— 宿主侧那半条腿的"按钮后端"
      try { registerTools((scoped && scoped.get && scoped.get('tools')) || ctx.get('tools'), scoped || ctx) } catch (e) {
        const m = String((e && e.message) || e)
        report.relay.errors.push(`注册工具失败：${m}`); log(`registerTools failed: ${m}`)
      }
      // 开机按配置只起一条腿：direct 时不起信箱（否则同一句话会被投两次）
      const bootTransport = readConfig(BASE).transport
      if (bootTransport === 'mailbox') {
        Promise.resolve()
          .then(() => startMailbox(svc, report))
          .catch((e) => {
            const m = String((e && e.message) || e)
            report.relay.errors.push(m); log(`startMailbox threw: ${m}`)
          })
          .finally(() => flush('mailbox'))
      } else {
        log('[mailbox] transport=direct ⇒ 不启动信箱腿（同一条消息不许投两次）')
      }
      // 🆕 直连传输（Task 3：探针阶段 —— 只记日志，不投递；投递在 Task 4 接上）
      startDirectTransport(report)
    })
  } catch (e) { report.inject.error = String((e && e.message) || e) }

  /**
   * 🆕 直连传输（Task 3 + Task 4）：`transport === "direct"` 时起一条 QQ 长连接，
   * 并把**主人的私聊**投进锁定会话。
   *
   * 判定在 `lib/delivery.js`（纯函数，单测钉住）；这里只负责取配置、拿会话服务、
   * 调 `prompt`，以及把每个“没投”的原因写进日志 —— 不静默。
   * @param {object} rep - apply 的报告对象
   */
  function startDirectTransport(rep) {
    try {
      const cfg = readConfig(BASE)
      if (cfg.transport !== 'direct') {
        log('[direct] transport=mailbox ⇒ 不启动直连')
        return
      }
      if (direct) {
        log('[direct] 已经起着了，不重复连')
        return
      }
      if (!cfg.direct.appId || !cfg.direct.appSecret) {
        const why = 'transport=direct，但缺 appId / appSecret（去「设置 → QQ 中继」填）'
        rep.relay.errors.push(why); log(`[direct] ${why}`)
        return
      }

      /** 去重集合：QQ 会重推，重连还会补发 */
      const seen = makeDeduper(200)
      /** 最近一张收到的图（给“先发图、再说暗号”兜底用） */
      let lastImage = null

      /**
       * 连发多张图会被 QQ 拆成多条消息（实测 0.5 秒内四条）⇒ 攒一小会儿再投，
       * 会话里看到的是一轮「N 张图」而不是四次排队。
       */
      const batcher = createImageBatcher({
        windowMs: () => readConfig(BASE).image.batchMs,
        // 不再按 4 张就切：一次发多少就合成多少（20 只是防手滑的上限）
        max: 20,
        onBatch: (merged) => { deliver(merged).catch(() => {}) },
      })
      imageBatcher = batcher

      /**
       * 回执：主人发来东西后，先回一句“收到了”，别让对面干等。
       * 只认主人；`mode=media` 时只对图片/文件发；1.2 秒内不重复发（连发防刷屏）。
       */
      let lastAckAt = 0
      function maybeAck(cfg, event, hasImage, hasFile) {
        try {
          const ack = cfg.ack
          if (!ack || ack.enabled !== true) return
          if (!cfg.direct.ownerId || event.openid !== cfg.direct.ownerId) return
          if (seen.has(event.msgId)) return
          if (!shouldAck(ack, { hasImage, hasFile })) return
          if (Date.now() - lastAckAt < 1200) return
          lastAckAt = Date.now()
          const text = renderAck(ack.text, ackKind(hasImage, hasFile))
          if (!direct || typeof direct.send !== 'function') return
          log(`[ack] 回执：${text}`)
          // msg_seq 用 99：正式回复从 1 开始编号，错开才不会撞（撞了 QQ 会判重复）
          Promise.resolve(direct.send(event.openid, text, event.msgId, 99)).catch((error) => {
            log(`[ack] 回执没发出去：${String((error && error.message) || error)}`)
          })
        } catch (error) {
          log(`[ack] 回执出错（不影响投递）：${String((error && error.message) || error)}`)
        }
      }

      /**
       * 🧩 表情包：说暗号（`sticker.trigger`）⇒ 把图收进 `images\stickers\`。
       * 取图三条路（可同时开）：
       *   1. 引用里的那张（byQuote）；
       *   2. 本条自带的图（byAttach）；
       *   3. **最近刚收到的那张**（byRecent）——QQ 常把文字和图拆成两条发，引用也常只有索引，
       *      所以留一条“刚发过的图”兜底：先发图、再说暗号，就能收。
       * 名字先用临时名，等会话里（我）看到图后用 `sticker_name` 改名。
       */
      async function maybeSaveSticker(cfg, event) {
        try {
          if (!cfg.sticker || cfg.sticker.enabled !== true) return ''
          const trigger = String(cfg.sticker.trigger || '').trim()
          if (trigger === '' || !String(event.text || '').includes(trigger)) return ''
          const source = pickStickerSource(event, {
            byQuote: cfg.sticker.byQuote !== false,
            byAttach: cfg.sticker.byAttach !== false,
          })
          let bytes = null
          if (source) {
            const got = await downloadImage(source.url, { maxBytes: cfg.image.maxMb * 1024 * 1024 })
            if (!got.ok) return `表情包没存下来：${got.reason === 'too-large' ? '图太大' : got.reason === 'timeout' ? '下载超时' : '下载失败'}`
            bytes = got.bytes
          } else if (
            cfg.sticker.byRecent !== false
            && lastImage
            && Date.now() - lastImage.at <= (cfg.sticker.recentMs || 120000)
          ) {
            bytes = readFileSync(lastImage.path)
            log(`[sticker] 用最近那张图：${lastImage.path}`)
          }
          if (!bytes) return '暗号收到了，但没找到可收的图（先发图再说暗号，或引用一张图）'
          const dir = stickerDirOf(BASE, cfg)
          const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
          const saved = addSticker(dir, { bytes, name: `表情_${stamp}`, sourceMsgId: event.msgId })
          if (!saved.ok) return `表情包没存下来：${saved.why}`
          log(`[sticker] 收下 ${saved.path}（${Math.round(bytes.length / 1024)}KB）`)
          return `已收进表情包：${saved.name}（${Math.round(bytes.length / 1024)}KB），想改名就跟我说`
        } catch (error) {
          const message = String((error && error.message) || error)
          log(`[sticker] 出错：${message}`)
          return `表情包出错：${message}`
        }
      }

      /**
       * 一条事件到了：判定 → 投递 → 记账。
       * @param {{type: string, openid: string, text: string, msgId: string}} event
       */
      /**
       * 把“看起来不普通”的消息结构写进日志（引用回复、非图片元素等）。
       * 平时不发；只在出现引用/未知元素时留一行，方便按真机数据接线。
       */
      function logEventShape(event) {
        try {
          const reference = event.message_reference || event.messageReference || event.referenced_message || event.quote || null
          const elements = Array.isArray(event.msgElements) ? event.msgElements : []
          const odd = elements.filter((el) => !String((el && el.content_type) || '').startsWith('image/'))
          if (!reference && odd.length === 0) return
          const shape = {
            keys: Object.keys(event),
            reference,
            // 整段元素只留前 700 字：够看清字段名与嵌套结构，又不至于把日志撑爆
            elements: elements.map((el) => ({ type: el.content_type, json: JSON.stringify(el).slice(0, 700) })),
            attachments: (Array.isArray(event.attachments) ? event.attachments : []).map((a) => ({ type: a.content_type, json: JSON.stringify(a).slice(0, 400) })),
          }
          log(`[event] 结构（引用/非图片元素）：${JSON.stringify(shape).slice(0, 1800)}`)
        } catch { /* 记日志失败不影响投递 */ }
      }

      async function deliver(event) {
        const now = readConfig(BASE) // 设置页改完立即生效：每条消息都重读
        logEventShape(event)
        maybeAck(now, event, Boolean(pickImage(event)), Boolean(pickFile(event)))
        // 🧩 表情包：引用一张图 + 说暗号 ⇒ 收进 stickers\
        const stickerNote = await maybeSaveSticker(now, event)
        const outcome = await deliverEvent({
          event,
          config: {
            ownerId: now.direct.ownerId,
            sessionId: now.sessionId,
            hint: now.reply.hint,
            maxChars: now.reply.maxChars,
            stickerFrequency: now.sticker.frequency,
          },
          deduper: seen,
          prompt: bindPrompt(currentSvc, promptAbort.signal),
          prepareImage: (ev) => prepareImage(ev),
          prepareFile: (ev) => prepareFile(ev),
          extraNote: stickerNote,
          log: (line) => log(line),
        })
        if (outcome.delivered) {
          // 记下“这条该回给谁”，回信时按 requestId 找回来（10 分钟没等到回复就清掉）
          const stamp = Date.now()
          pendingReplies.set(outcome.requestId, { openid: event.openid, msgId: event.msgId, at: stamp })
          for (const [key, value] of pendingReplies) {
            if (stamp - value.at > 10 * 60_000) pendingReplies.delete(key)
          }
          rep.relay.processed.push({ at: new Date().toISOString(), source: 'direct', msgId: event.msgId })
        } else if (outcome.error) {
          rep.relay.errors.push(`直连投递失败：${outcome.error}`)
        }
      }

      /**
       * 🖼 图在**过了门之后**才处理：下载 → 动图拼图 → 落盘。
       * 任何一步失败都只返回 `error`（文字照发 + 正文注明），绝不吞掉整条消息。
       */
      async function prepareImage(event) {
        const now = readConfig(BASE)
        if (!now.image.enabled) return null
        // 2026-10-18：不再分“全看 / 只第一张”，一律全看（上限 20 张，防手滑）
        const picked = pickImages(event, 20)
        if (picked.length === 0) return null
        const limit = now.image.maxMb * 1024 * 1024
        const dir = incomingDirOf(imageDirOf(BASE, now))
        const images = []
        const problems = []
        let gifNote = ''
        for (let i = 0; i < picked.length; i += 1) {
          const got = await downloadImage(picked[i].url, { maxBytes: limit })
          if (!got.ok) {
            problems.push(got.reason === 'too-large'
              ? `第 ${i + 1} 张太大（上限 ${now.image.maxMb}MB）`
              : got.reason === 'timeout' ? `第 ${i + 1} 张下载超时`
                : got.reason === 'unsupported' ? `第 ${i + 1} 张认不出格式`
                  : `第 ${i + 1} 张下载失败（${got.detail}）`)
            continue
          }
          let bytes = got.bytes
          let mime = got.mime
          if (mime === 'image/gif') {
            const made = montage(bytes, now.image.gifFrames)
            if (made) {
              bytes = made.png
              mime = 'image/png'
              gifNote = `动图：取了 ${made.frames.length} 帧拼成一张`
            } else {
              gifNote = gifNote || '动图没能拼图，按原图发出'
            }
          }
          if (now.image.retentionDays > 0) {
            const saved = saveImage(dir, { bytes, mime, msgId: event.msgId, at: Date.now(), seq: i + 1, tag: 'frames' })
            if (!saved.ok) problems.push(`第 ${i + 1} 张没存下来：${saved.why}`)
            else lastImage = { path: saved.path, at: Date.now() }
            // 🎞 动图的**原文件**也留一份：拼图是给我看的，原图是用来（原样）发回 QQ 的
            if (got.mime === 'image/gif') {
              const keep = saveImage(dir, { bytes: got.bytes, mime: 'image/gif', msgId: event.msgId, at: Date.now(), seq: i + 1 })
              if (keep.ok) {
                gifNote = `${gifNote ? `${gifNote}；` : ''}原图已存 ${keep.path}`
                lastImage = { path: keep.path, at: Date.now() }
              } else problems.push(`第 ${i + 1} 张动图原文件没存下来：${keep.why}`)
            }
          }
          images.push({ mediaType: mime, data: bytes.toString('base64') })
        }
        if (now.image.retentionDays > 0) pruneIncoming(dir, now.image.retentionDays)
        const notes = []
        // 引用（真机样本：message_type 103 + REFIDX_…，被引用的图挂在元素 attachments 里）
        const quoted = quoteInfo(event)
        if (quoted) {
          const shown = stripFaces(quoted.text).text
          const bits = []
          if (shown) bits.push(shown)
          if (quoted.imageCount > 0) bits.push(`带 ${quoted.imageCount} 张图`)
          notes.push(`引用了${bits.length > 0 ? `：${bits.join('，')}` : '一条消息'}`)
        }
        if (images.length > 1) notes.push(`共 ${images.length} 张图`)
        if (gifNote) notes.push(gifNote)
        log(`[image] 投递 ${images.length} 张${notes.length ? ` · ${notes.join('；')}` : ''}${problems.length ? ` · 问题 ${problems.length} 条` : ''}`)
        if (images.length === 0) return { error: problems.join('；') || '没有可用的图' }
        return { images, note: notes.join('；'), error: problems.length ? problems.join('；') : '' }
      }

      /**
       * 📎 文件：下载 → 落 `files\` → 给会话一句「存到哪儿」。
       * 文件不进 prompt 的内容块（那不是图片），让会话自己用文件工具读。
       */
      async function prepareFile(event) {
        const now = readConfig(BASE)
        if (!now.file.enabled) return null
        const picked = pickFile(event)
        if (!picked) return null
        // 视频比普通文件大得多：走 video.maxMb（默认 2048）和更长的下载超时
        const looksVideo = String(picked.contentType || '').startsWith('video/')
          || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(picked.filename || '')
        const maxMb = looksVideo ? now.video.maxMb : now.file.maxMb
        const timeoutMs = looksVideo ? 300_000 : 30_000
        const got = await downloadFile(picked.url, { maxBytes: maxMb * 1024 * 1024, timeoutMs })
        if (!got.ok) {
          const why = got.reason === 'too-large'
            ? `${looksVideo ? '视频' : '文件'}太大（上限 ${maxMb}MB）`
            : got.reason === 'timeout' ? '下载超时' : `下载失败（${got.detail}）`
          log(`[file] ${why}`)
          return { error: why }
        }
        const kb = Math.max(1, Math.round(got.bytes.length / 1024))
        const shown = picked.filename || '（没名字）'
        if (now.file.retentionDays > 0) {
          const dir = filesDirOf(BASE, now)
          const saved = saveFile(dir, { bytes: got.bytes, filename: picked.filename, msgId: event.msgId })
          if (!saved.ok) {
            log(`[file] 存不下来：${saved.why}`)
            return { note: `发来文件：${shown}（${kb}KB，没存下来：${saved.why}）` }
          }
          pruneFiles(dir, now.file.retentionDays)
          log(`[file] 已存 ${saved.path}（${kb}KB）`)
          // 🎬 视频：告诉会话“这东西能分析”，别让它当成普通附件晾着
          const isVideo = String(picked.contentType || '').startsWith('video/') || /\.(mp4|mov|mkv|webm|avi)$/i.test(saved.path)
          if (isVideo && now.video.enabled) {
            return { note: `发来视频：${shown}（${kb}KB，已存到 ${saved.path}）；可用 analyze_video 分析` }
          }
          return { note: `发来文件：${shown}（${kb}KB，已存到 ${saved.path}）` }
        }
        log(`[file] 不落盘（retentionDays=0）：${shown}（${kb}KB）`)
        return { note: `发来文件：${shown}（${kb}KB，按设置未落盘）` }
      }

      direct = createDirect({
        config: cfg.direct,
        onEvent: (event) => {
          // 纯图消息先攒一攒（连发多张时合成一轮）；其余立刻投
          if (!batcher.offer(event)) deliver(event).catch(() => {})
        },
        log: (line) => log(line),
      })

      // 回信：只认 qq-direct- 触发的回合（见 lib/qq-reply.js）
      try {
        unbindReply = bindReplyForward(ctx, {
          send: (openid, text, msgId, seq) => direct.send(openid, text, msgId, seq),
          resolveRequest: (requestId) => pendingReplies.get(requestId) || null,
          maxChars: () => readConfig(BASE).reply.maxChars,
          log: (line) => log(line),
        })
      } catch (e) {
        const m = String((e && e.message) || e)
        rep.relay.errors.push(`回信订阅失败：${m}`); log(`[reply] 订阅失败：${m}`)
      }
      log('[reply] 已订阅 session/event：只转发 qq-direct- 触发回合的终稿')

      Promise.resolve(direct.start())
        .then(() => log('[direct] 传输已启动（收到主人私聊 → 投进锁定会话）'))
        .catch((e) => {
          const m = String((e && e.message) || e)
          rep.relay.errors.push(`直连启动失败：${m}`); log(`[direct] 启动失败：${m}`)
        })
    } catch (e) {
      const m = String((e && e.message) || e)
      rep.relay.errors.push(`直连启动失败：${m}`); log(`[direct] 启动失败：${m}`)
    }
  }

  /** 按当前配置切换传输（Task 6）。幂等：已经是目标状态就什么都不做。 */
  function applyTransportConfig() {
    const cfg = readConfig(BASE)
    if (cfg.transport === 'direct') {
      // 先停信箱腿，避免两条链路同时投递（同一句话投两次是最糟的重复）
      try { if (watcher) { watcher.close(); watcher = null } } catch { /* 忽略 */ }
      try { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null } } catch { /* 忽略 */ }
      if (!direct) startDirectTransport(report)
      return
    }
    try { if (direct) { direct.stop(); direct = null } } catch { /* 忽略 */ }
    try { if (imageBatcher) { imageBatcher.dispose(); imageBatcher = null } } catch { /* 忽略 */ }
    try { if (unbindReply) { unbindReply(); unbindReply = null } } catch { /* 忽略 */ }
    pendingReplies.clear()
    if (!watcher && currentSvc) {
      Promise.resolve()
        .then(() => startMailbox(currentSvc, report))
        .catch((e) => log(`[mailbox] 切回信箱失败：${String((e && e.message) || e)}`))
    }
  }

  // ---- dispose：把 watcher / 定时器 / 工具注册收干净（常驻插件的基本功）----
  try {
    ctx.on('dispose', () => {
      disposed = true
      try { if (watcher) watcher.close() } catch { /* 忽略 */ }
      try { if (pollTimer) clearTimeout(pollTimer) } catch { /* 忽略 */ }
      try { if (heartbeatTimer) clearInterval(heartbeatTimer) } catch { /* 忽略 */ }
      for (const dispose of toolDisposers) { try { dispose() } catch { /* 忽略 */ } }
      toolDisposers = []
      try { if (direct) direct.stop() } catch { /* 忽略 */ }
      direct = null
      try { if (imageBatcher) imageBatcher.dispose() } catch { /* 忽略 */ }
      imageBatcher = null
      try { if (unbindReply) unbindReply() } catch { /* 忽略 */ }
      unbindReply = null
      try { promptAbort.abort() } catch { /* 忽略 */ }
      pendingReplies.clear()
      // 📌 **故意不删声明文件**：心跳停了，引擎就看得见"收件方不在"（比删掉更有信息量）
      log('dispose: watcher/timer/tools closed（声明文件留着，让引擎按心跳判"不在"）')
    })
  } catch (e) { report.notes.push(`ctx.on('dispose') 注册失败：${String((e && e.message) || e)}`) }

  /** 重新起一遍信箱机制（锁定的会话刚被工具改了 ⇒ 要按新配置重来）。 */
  async function restartMailbox(reason) {
    try { if (watcher) { watcher.close(); watcher = null } } catch { /* 忽略 */ }
    try { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null } } catch { /* 忽略 */ }
    try { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null } } catch { /* 忽略 */ }
    report.relay.resolved = null
    report.relay.watching = null
    log(`restartMailbox(${reason})`)
    // 🔴 直连模式下不许把信箱腿拉起来：锁定会话只改 `sessionId`，与传输无关。
    //    2026-10-17 真机踩过：切成 direct 之后点「锁定当前会话」又 watch 上了 inbox。
    if (readConfig(BASE).transport === 'direct') {
      log('[mailbox] 当前是 direct ⇒ 锁定只写 sessionId，不启动信箱腿')
      return
    }
    if (!disposed && currentSvc) await startMailbox(currentSvc, report)
  }

  /** 一行状态（工具 `relay_status` 用；也顺手写进日志）。 */
  function statusText() {
    const base = stateText(readRelayState(report.relay.resolved, {
      processed: report.relay.processed.length,
      errors: report.relay.errors.length,
    }))
    return base + '\n' + credentialLine()
  }

  /**
   * B 站登录态那一行：能不能用、还剩多少天。
   * 用户应该一眼看到"快过期了"，而不是等某天字幕突然取不到。
   */
  function credentialLine() {
    const stored = readCredential(BASE)
    if (!stored.ok) return `B 站登录态：未配置（${stored.why}）`
    const check = stored.validation
    if (!check.usable) return `B 站登录态：不可用（${check.reason}）`
    const left = check.daysLeft === null ? '过期时间未知' : `还剩 ${Math.round(check.daysLeft)} 天`
    const warn = check.daysLeft !== null && check.daysLeft <= 7 ? '｜⚠️ 快过期了，请重新登录' : ''
    return `B 站登录态：可用，${left}${warn}`
  }

  // ---- 三个动作的**唯一实现**：工具与浏览器按钮都调这里（语义不会分叉）----

  /** 锁定到一条会话（默认 = 调用它的那条）。返回 `{ok, text}`。 */
  async function localLock(target) {
    const sessionId = String(target || '').trim()
    if (!sessionId) {
      return { ok: false, text: '拿不到会话 id（exec 里没有 agent.session）⇒ 请显式给 sessionId。' }
    }
    writeLockFile(CONFIG, sessionId)
    await restartMailbox('lock')
    invalidateRemote()
    log('[lock] → ' + sessionId)
    log('[lock] → ' + sessionId)
    return { ok: true, text: '已锁定 → ' + sessionId + '\n' + statusText(), sessionId }
  }

  /** 解除锁定。**不动引擎的 qqMode**（那条语义归 relay_engine / action=mode）。 */
  async function localUnlock() {
    const before = readJson(CONFIG) || {}
    const was = before.sessionId || '（本来就没锁）'
    writeJsonAtomic(CONFIG, { ...before, sessionId: null })
    await restartMailbox('unlock')
    invalidateRemote()
    const mode = readEngineMode(appDirOf())
    const text = '已解锁（原来是 ' + was + '）\n'
      + (mode === 'relay'
        ? '⚠️ 引擎仍是 relay 模式 ⇒ 它还会往信箱投（我们不再取）。要彻底停下：relay_engine(mode=answer)。'
        : '引擎是 answer 模式 ⇒ 本来也没在投。')
    log('[unlock]')
    log('[unlock]（原 ' + was + '）')
    return { ok: true, text, was }
  }

  /** 切引擎的 QQ 模式（relay / answer）。 */
  function localSetEngineMode(mode) {
    const m = String(mode || '').toLowerCase()
    if (m !== 'relay' && m !== 'answer') {
      return { ok: false, text: 'mode 只能是 relay 或 answer（收到：' + m + '）' }
    }
    const file = writeEngineMode(appDirOf(), m)
    invalidateRemote()
    log('[engine] → ' + m)
    log('[engine] → ' + m)
    return { ok: true, text: '引擎 QQ 模式 → ' + m + '（写了 ' + file + '，备份 ' + file + '.bak）\n' + statusText(), mode: m }
  }

  /** 让下一张卡片必读磁盘（动作改了锁定/模式之后调）。 */
  function invalidateRemote() {
    try { if (remoteService && typeof remoteService.invalidate === 'function') remoteService.invalidate() } catch { /* 忽略 */ }
  }

  /**
   * 浏览器卡片唯一的动作入口（Remote 的 `qqRelay/act`）。
   *
   * 线上形状：`{ args: { args: { action, sessionId?, mode? } } }`（SRC 模式要求
   * 参数名与实参名一一对应；这里方法有**一个**参数 `args`）。返回纯数据，
   * 出错**不抛**，而是 `{ok:false,text}` ⇒ 卡片必须把它显示出来（不许静默）。
   *
   * @param raw - 线上传下来的那个对象。
   * @returns `{ok, text, ...}`。
   */
  async function localAction(raw) {
    const args = (raw && typeof raw === 'object') ? raw : {}
    const action = String(args.action || '').trim()
    try {
      if (action === 'lock') {
        const target = String(args.sessionId || '').trim() || (readJson(CONFIG) || {}).sessionId
        if (!target) return { ok: false, action, text: '没有可锁的会话：卡片要传 sessionId，而 relay.json 里也还没有 sessionId。' }
        return { ok: true, action, ...(await localLock(target)) }
      }
      if (action === 'unlock') return { ok: true, action, ...(await localUnlock()) }
      if (action === 'mode') return { ok: true, action, ...localSetEngineMode(args.mode) }
      return { ok: false, action, text: '不认识的 action：' + JSON.stringify(action) + '（只认 lock / unlock / mode）' }
    } catch (e) {
      const m = String((e && e.message) || e)
      report.relay.errors.push(`远程动作 ${action} 失败：${m}`)
      log(`remote action ${action} failed: ${m}`)
      return { ok: false, action, text: '动作执行失败：' + m }
    }
  }

  /**
   * 把一份视频结果按页切成文字（避免一次塞几千字进上下文）。
   * @param {{durationSeconds:number, subtitles:Array<{time:string,text:string}>, mode?:string, model?:string}} result
   * @param {number} from
   * @param {number} limit
   * @param {string[]} images - 只有第一页才带拼图
   */
  function pageOf(result, from, limit, images) {
    const subtitles = Array.isArray(result.subtitles) ? result.subtitles : []
    const slice = subtitles.slice(from, from + limit)
    const next = from + slice.length
    const modeNote = result.mode ? `，模式 ${result.mode}${result.model ? ` / ${basename(String(result.model))}` : ''}` : ''
    const head = subtitles.length === 0
      ? `视频时长 ${Math.round(result.durationSeconds)} 秒，没有识别到语音（可能是纯音乐/无人声）${modeNote}。`
      : `视频时长 ${Math.round(result.durationSeconds)} 秒，字幕 ${subtitles.length} 条${modeNote}；这页是第 ${from + 1}~${next} 条。`
    const lines = slice.map((item) => `[${item.time}] ${item.text}`)
    const more = next < subtitles.length
      ? `\n\n还有 ${subtitles.length - next} 条，继续看就再调 analyze_video(path, from=${next})。`
      : '\n\n（字幕到此为止）'
    const audioNote = result.media === 'audio' ? String.fromCharCode(10) + '（这条是音频，没有画面）' : ''
    const imageBlock = images.length > 0
      ? `\n\n拼图路径（用 read_image 逐张看）：\n${images.join('\n')}`
      : ''
    let body = `${head}\n\n${lines.join('\n')}${more}${imageBlock}`
    if (body.length > 8000) body = `${body.slice(0, 8000)}\n…（这页太长，截断了；把 limit 调小再翻）`
    return body
  }

  /** 注册四个工具（宿主侧那半条腿的"按钮后端"）。 */
  function registerTools(tools, scopedCtx) {
    if (!tools || typeof tools.register !== 'function') {
      throw new Error('拿不到 tools 服务（register 不是函数）')
    }
    const defs = [
      {
        name: 'relay_status',
        description: '查看"信箱中继"的状态：锁定哪条会话 / 信箱在哪 / 声明与心跳是否新鲜 / 引擎的 QQ 模式 / 各目录条数。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: TOOL_OUTPUT,
        execute: async () => {
          const text = statusText()
          log('[tool] relay_status\n' + text)
          return { content: [{ type: 'text', text }] }
        },
      },
      {
        name: 'relay_lock',
        description: '把"信箱中继"锁定到一条会话（默认 = 调用它的这条会话）：之后 QQ 上主人的消息会投进那条会话。会立刻发布声明并开始监听信箱。',
        parameters: {
          type: 'object',
          properties: { sessionId: { type: 'string', description: '要锁定的会话 id（省略 = 当前这条）' } },
          additionalProperties: false,
        },
        output: TOOL_OUTPUT,
        execute: async (args, exec) => {
          const target = String((args && args.sessionId) || sessionIdOf(exec) || '')
          const out = await localLock(target)
          log('[tool] relay_lock\n' + out.text)
          return { content: [{ type: 'text', text: out.text }] }
        },
      },
      {
        name: 'relay_unlock',
        description: '解除锁定（停止把 QQ 消息投进会话）。⚠️ 引擎那边的 QQ 模式不会跟着变：要彻底停下再用 relay_engine 切成 answer。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: TOOL_OUTPUT,
        execute: async () => {
          const out = await localUnlock()
          log('[tool] relay_unlock\n' + out.text)
          return { content: [{ type: 'text', text: out.text }] }
        },
      },
      {
        name: 'relay_engine',
        description: '把"小屋引擎"的 QQ 模式切成 relay（主人私聊转进信箱）或 answer（引擎自己答）。原子改 <小屋>\\data\\settings.json（留 .bak）；引擎每条消息前重读 ⇒ 立刻生效、不用重启。',
        parameters: {
          type: 'object',
          properties: { mode: { type: 'string', enum: ['relay', 'answer'], description: 'relay = 转进信箱；answer = 引擎自己答' } },
          required: ['mode'],
          additionalProperties: false,
        },
        output: TOOL_OUTPUT,
        execute: async (args) => {
          const out = localSetEngineMode(args && args.mode)
          log('[tool] relay_engine\n' + out.text)
          return { content: [{ type: 'text', text: out.text }] }
        },
      },
      {
        name: 'qq_send_image',
        description: '把本地的一张图**发到主人的 QQ**（上行图片，阶段 4）。路径可以是绝对路径，也可以相对插件数据目录。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '图片路径（png/jpeg/gif/webp），相对路径以插件数据目录为基准' },
            caption: { type: 'string', description: '可选的配文（发在图片后面）' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        output: TOOL_OUTPUT,
        execute: async (args) => {
          const reply = (text) => ({ content: [{ type: 'text', text }] })
          try {
            const raw = String((args && args.path) || '').trim()
            if (raw === '') return reply('没给路径')
            const target = isAbsolute(raw) ? raw : resolve(BASE, raw)
            const cfg = readConfig(BASE)
            if (cfg.transport !== 'direct') return reply('当前不是直连模式（transport=mailbox），发不了图')
            if (!cfg.direct.ownerId) return reply('还没配 ownerId，不知道发给谁')
            if (!direct || typeof direct.sendImage !== 'function') return reply('直连还没起来（看日志 / 先点「重读」）')
            const bytes = readFileSync(target)
            const mime = sniffMime(bytes)
            if (!mime) return reply(`不是认识的图片格式：${target}`)
            const kb = Math.max(1, Math.round(bytes.length / 1024))
            const caption = args && typeof args.caption === 'string' ? args.caption.trim() : ''
            // 配文放哪：merge = 塞进图片消息（一个气泡）；separate = 图一条、文字一条
            if (caption !== '' && cfg.send.captionMode === 'merge') {
              await direct.sendImage(cfg.direct.ownerId, bytes, basename(target), '', caption)
            } else {
              await direct.sendImage(cfg.direct.ownerId, bytes, basename(target))
              if (caption !== '') await direct.send(cfg.direct.ownerId, caption, '', 1)
            }
            log(`[tool] qq_send_image ${target}（${kb}KB）${caption ? `，带配文（${cfg.send.captionMode}）` : ''}`)
            return reply(`已发到 QQ：${basename(target)}（${kb}KB）`)
          } catch (error) {
            const message = String((error && error.message) || error)
            log(`[tool] qq_send_image 失败：${message}`)
            return reply(`发图失败：${message}`)
          }
        },
      },
      {
        name: 'qq_send_file',
        description: '把本地的一个文件（Word/PDF/压缩包…）发到主人 QQ。路径可以是绝对路径，也可以相对插件数据目录。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径；相对路径以插件数据目录为基准' },
            caption: { type: 'string', description: '可选配文（并进同一条文件消息）' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        output: TOOL_OUTPUT,
        execute: async (args) => {
          const reply = (text) => ({ content: [{ type: 'text', text }] })
          try {
            const raw = String((args && args.path) || '').trim()
            if (raw === '') return reply('没给路径')
            const target = isAbsolute(raw) ? raw : resolve(BASE, raw)
            const cfg = readConfig(BASE)
            if (cfg.transport !== 'direct') return reply('当前不是直连模式（transport=mailbox），发不了文件')
            if (!cfg.direct.ownerId) return reply('还没配 ownerId，不知道发给谁')
            if (!direct || typeof direct.sendFile !== 'function') return reply('直连还没起来（看日志 / 先点「重读」）')
            if (!existsSync(target)) return reply(`文件不存在：${target}`)
            const stat = statSync(target)
            if (!stat.isFile()) return reply(`不是文件：${target}`)
            const maxBytes = (cfg.send.fileMaxMb || 30) * 1024 * 1024
            if (stat.size > maxBytes) return reply(`文件太大（${Math.round(stat.size / 1024 / 1024)}MB，上限 ${cfg.send.fileMaxMb || 30}MB，可在设置里改）`)
            const bytes = readFileSync(target)
            const kb = Math.max(1, Math.round(bytes.length / 1024))
            const caption = args && typeof args.caption === 'string' ? args.caption.trim() : ''
            await direct.sendFile(cfg.direct.ownerId, bytes, basename(target), '', caption)
            log(`[tool] qq_send_file ${target}（${kb}KB）${caption ? '，带配文' : ''}`)
            return reply(`已发到 QQ：${basename(target)}（${kb}KB）`)
          } catch (error) {
            const message = String((error && error.message) || error)
            log(`[tool] qq_send_file 失败：${message}`)
            return reply(`发文件失败：${message}`)
          }
        },
      },
      {
        name: 'download_bili',
        description: '下载一条 B 站视频到本地（解析 BV/短链/分享文案）。下载完可以接着用 analyze_video 分析它。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'B 站链接、b23 短链，或带链接的整段分享文案' },
            audio_only: { type: 'string', description: 'auto（默认，按分区/标题分诊）| true（只下音频）| false（只下视频）' },
          },
          required: ['url'],
          additionalProperties: false,
        },
        output: TOOL_OUTPUT,
        execute: async (args) => {
          const reply = (text) => ({ content: [{ type: 'text', text }] })
          try {
            const cfg = readConfig(BASE)
            if (!cfg.video.enabled) return reply('视频功能关着（relay.json 里 video.enabled = false）')
            const text = String((args && args.url) || '').trim()
            if (text === '') return reply('没给链接')
            const dir = biliDirOf(BASE, cfg)
            mkdirSync(dir, { recursive: true })
            const audioOnly = ['true', 'false'].includes(String(args.audio_only || '').trim())
              ? String(args.audio_only).trim()
              : 'auto'
            const got = await downloadBili(text, dir, {
              maxMb: cfg.video.maxMb,
              cookie: currentBiliCookie(cfg),
              audioOnly,
              log,
            })
            if (!got.ok) {
              log(`[bili] 失败：${got.why}`)
              return reply(`B 站下载失败：${got.why}`)
            }
            const pruned = pruneFiles(dir, cfg.video.retentionDays)
            if (pruned > 0) log(`[bili] 顺手清掉 ${pruned} 个过期下载`)
            const mb = (got.bytes / 1024 / 1024).toFixed(1)
            log(`[bili] 已下载 ${got.path}（${mb}MB，${got.mediaType}）`)
            const kind = got.mediaType === 'audio' ? '音频' : '视频'
            const notice = got.notice ? String.fromCharCode(10) + got.notice : ''
            return reply(`下载好了（${kind}）：《${got.title}》（${Math.round(got.duration)} 秒，${mb}MB）${notice}\n路径：${got.path}\n\n要文字稿就接着调 analyze_video（它只转写、不出图）。`)
          } catch (error) {
            const message = String((error && error.message) || error)
            log(`[bili] 异常：${message}`)
            return reply(`B 站下载异常：${message}`)
          }
        },
      },
      {
        name: 'bili_login_start',
        description: '生成一张 B 站扫码登录的二维码（两分钟内有效），返回 PNG 路径。把图发给主人扫，扫完再用 bili_login_check 确认。登录成功后会覆盖现有凭证。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: TOOL_OUTPUT,
        execute: async () => {
          const reply = (text) => ({ content: [{ type: 'text', text }] })
          try {
            const cfg = readConfig(BASE)
            const pythonPath = cfg.video.python || join(PLUGIN_DIR, 'video', '.venv', 'Scripts', 'python.exe')
            const qrScript = join(PLUGIN_DIR, 'video', 'qr_render.py')
            const dir = join(BASE, 'qr')
            const got = await startQrLogin({ dir, pythonPath, qrScript })
            if (!got.ok) {
              log(`[login] 生成二维码失败：${got.why}`)
              return reply(`生成二维码失败：${got.why}`)
            }
            pendingQr = { key: got.qrKey, startedAtMs: Date.now() }
            log(`[login] 二维码已生成 key=${got.qrKey.slice(0, 8)}…`)
            return reply([
              '二维码已生成（约两分钟有效），图片在这里：',
              got.pngPath,
              '',
              '把这张图发给主人扫；扫完调 bili_login_check 确认。',
            ].join('\n'))
          } catch (error) {
            const message = String((error && error.message) || error)
            log(`[login] 异常：${message}`)
            return reply(`生成二维码异常：${message}`)
          }
        },
      },
      {
        name: 'bili_login_check',
        description: '查一次扫码登录的结果。返回 pending（还没扫）/ scanned（扫了待确认）/ confirmed（成功，已写入凭证）/ expired（码过期，要重新生成）。不循环、不重试。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: TOOL_OUTPUT,
        execute: async () => {
          const reply = (text) => ({ content: [{ type: 'text', text }] })
          try {
            if (!pendingQr || !pendingQr.key) return reply('还没有生成二维码，先调 bili_login_start')
            const verdict = await pollQrLogin({ qrKey: pendingQr.key })
            if (!verdict.ok) {
              log(`[login] 轮询失败：${verdict.reason}`)
              return reply(`轮询失败：${verdict.reason}`)
            }
            const view = describeLoginState({ state: verdict.state, reason: verdict.reason })
            let line = view.ok ? view.text : `状态：${verdict.state}`
            if (verdict.state === 'confirmed') {
              const saved = saveLoginCredential({ baseDir: BASE, pollResult: verdict })
              if (saved.ok) {
                pendingQr = null
                const stored = readCredential(BASE)
                const left = stored.ok && stored.validation.daysLeft !== null
                  ? `，还剩 ${stored.validation.daysLeft.toFixed(1)} 天`
                  : ''
                line += `\n凭证已保存（${saved.path}）${left}`
                log('[login] 凭证已更新')
              } else {
                line += `\n⚠️ 登录成功但保存失败：${saved.why}`
                log(`[login] 保存失败：${saved.why}`)
              }
            } else if (verdict.state === 'expired' || verdict.state === 'error') {
              pendingQr = null
            }
            return reply(line)
          } catch (error) {
            const message = String((error && error.message) || error)
            log(`[login] 异常：${message}`)
            return reply(`查登录状态异常：${message}`)
          }
        },
      },
      {
        name: 'bili_peek',
        description: 'B 站视频「轻量看」：从故事板缩略图里抽几帧 + 拿稿件信息，输出一段文字和一张总览图路径（图要自己用 read_image 看）。不下载视频、不做转写，几秒出结果，适合判断「这条值不值得点开」。要知道具体讲了什么，接着用 analyze_video。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'B 站链接、BV 号，或带链接的整段分享文案' },
            count: { type: 'integer', description: '抽几帧（默认 6，最多 9）' },
          },
          required: ['url'],
          additionalProperties: false,
        },
        output: TOOL_OUTPUT,
        execute: async (args) => {
          const reply = (text) => ({ content: [{ type: 'text', text }] })
          try {
            const cfg = readConfig(BASE)
            const text = String((args && args.url) || '').trim()
            if (text === '') return reply('没给链接')
            const wanted = Number(args && args.count)
            const preset = Number(cfg.video.peekCount)
            const fallback = Number.isFinite(preset) ? preset : 6
            const count = Number.isFinite(wanted) ? Math.max(1, Math.min(9, Math.floor(wanted))) : fallback
            const workRoot = join(BASE, 'peek')
            mkdirSync(workRoot, { recursive: true })
            const pythonPath = cfg.video.python || join(PLUGIN_DIR, 'video', '.venv', 'Scripts', 'python.exe')
            const scriptPath = join(PLUGIN_DIR, 'video', 'storyboard_crop.py')
            const got = await peekBili({ text, workRoot, pythonPath, scriptPath, count, cookie: currentBiliCookie(cfg), asrModelDir: cfg.video.modelDir || '', asrMode: cfg.video.mode || 'accurate', asrAutoLimitSeconds: (Number(cfg.video.asrAutoLimitMin) || 10) * 60, log })
            if (!got.ok) {
              log(`[peek] 失败：${got.why}`)
              return reply(`轻量看失败：${got.why}`)
            }
            const pruned = prunePeekDirs(workRoot, 3)
            if (pruned > 0) log(`[peek] 顺手清掉 ${pruned} 个过期目录`)
            log(`[tool] bili_peek ${got.frames.length} 帧 -> ${got.dir}`)
            return reply(got.text)
          } catch (error) {
            const message = String((error && error.message) || error)
            log(`[peek] 异常：${message}`)
            return reply(`轻量看异常：${message}`)
          }
        },
      },
      {
        name: 'bili_frame',
        description: '按时刻从 B 站视频里精确抽帧（远程 seek，不下整片，一帧约 2~3 秒，720P）。给 BV 号 + 时刻（"22:13" 或秒数），返回图片路径和该时刻的字幕原文。视频常带画内字幕，可用来校对 AI 字幕的错字——注意 AI 字幕和画内字幕有 3~5 秒时差，校对时给 window=3 取前后窗口。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'B 站链接或 BV 号' },
            times: {
              type: 'array',
              items: { type: 'string' },
              description: '要抽的时刻，如 ["22:13","1350"]；支持 mm:ss 或 h:mm:ss 或纯秒数',
            },
            window: { type: 'integer', description: '每个时刻前后各扩几秒（校对字幕用，默认 0；建议 3）' },
            max_frames: { type: 'integer', description: '最多抽几帧（默认 6，最多 12）' },
          },
          required: ['url', 'times'],
          additionalProperties: false,
        },
        output: TOOL_OUTPUT,
        execute: async (args) => {
          const reply = (text) => ({ content: [{ type: 'text', text }] })
          try {
            const cfg = readConfig(BASE)
            const text = String((args && args.url) || '').trim()
            if (text === '') return reply('没给链接')
            const times = Array.isArray(args && args.times) ? args.times : []
            if (times.length === 0) return reply('没给时刻')
            const wantedWindow = Number(args && args.window)
            const windowSeconds = Number.isFinite(wantedWindow) ? Math.max(0, Math.min(10, Math.floor(wantedWindow))) : 0
            const wantedMax = Number(args && args.max_frames)
            const maxFrames = Number.isFinite(wantedMax) ? Math.max(1, Math.min(12, Math.floor(wantedMax))) : 6
            const workRoot = join(BASE, 'frames')
            mkdirSync(workRoot, { recursive: true })
            const pythonPath = cfg.video.python || join(PLUGIN_DIR, 'video', '.venv', 'Scripts', 'python.exe')
            const scriptPath = join(PLUGIN_DIR, 'video', 'remote_frame.py')
            const got = await grabBiliFrames({
              text, times, workRoot, pythonPath, scriptPath,
              cookie: currentBiliCookie(cfg), window: windowSeconds, maxFrames, qn: Number(cfg.video.qn) || 64, log,
            })
            if (!got.ok) {
              log(`[frame] 失败：${got.why}`)
              return reply(`抽帧失败：${got.why}`)
            }
            const lines = [`《${got.title}》`]
            for (const frame of got.frames) {
              const stamp = formatStampOf(frame.timeSeconds)
              lines.push('')
              lines.push(`[${stamp}] ${frame.path}`)
              if (frame.subtitle) lines.push(`  该时刻字幕：${frame.subtitle}`)
            }
            if (got.errors.length > 0) lines.push('', `【失败】${got.errors.map((e) => `${e.timeSeconds}s ${e.reason}`).join('；')}`)
            lines.push('', '图片用 read_image 看。')
            log(`[tool] bili_frame ${got.frames.length} 帧 -> ${got.dir}`)
            return reply(lines.join('\n'))
          } catch (error) {
            const message = String((error && error.message) || error)
            log(`[frame] 异常：${message}`)
            return reply(`抽帧异常：${message}`)
          }
        },
      },
      {
        name: 'analyze_video',
        description: '把本地音视频文件转成文字（本地 Whisper，不联网）。只做转写、不出图——要看画面用 bili_frame。字幕多时可以分页：再调一次并给 from。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '视频路径（绝对路径，或相对插件数据目录）' },
            from: { type: 'integer', description: '从第几条字幕开始（默认 0；翻页用，翻页不会重新处理视频）' },
            limit: { type: 'integer', description: '这一页返回多少条（默认 80，最多 200）' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        output: TOOL_OUTPUT,
        execute: async (args) => {
          const reply = (text) => ({ content: [{ type: 'text', text }] })
          try {
            const cfg = readConfig(BASE)
            if (!cfg.video.enabled) return reply('视频功能关着（relay.json 里 video.enabled = false）')
            const raw = String((args && args.path) || '').trim()
            if (raw === '') return reply('没给路径')
            const input = isAbsolute(raw) ? raw : resolve(BASE, raw)
            const python = cfg.video.python || join(PLUGIN_DIR, 'video', '.venv', 'Scripts', 'python.exe')
            const script = cfg.video.script || join(PLUGIN_DIR, 'video', 'video_processor.py')
            const size = checkVideoSize(input, cfg.video.maxMb)
            if (!size.ok) return reply(size.why)
            const from = Math.max(0, Number.isInteger(args && args.from) ? args.from : 0)
            const limit = Math.max(1, Math.min(200, Number.isInteger(args && args.limit) ? args.limit : 80))
            const outRoot = cfg.video.outDir || join(BASE, 'video-cache')
            // 同一个视频复用同一个目录：翻页时不再重复跑 Python（准确模式一次要两三分钟）
            const key = createHash('md5').update(input).digest('hex').slice(0, 10)
            const outDir = join(outRoot, key)
            mkdirSync(outDir, { recursive: true })
            const output = join(outDir, 'result.json')
            if (from > 0 && existsSync(output)) {
              const cached = JSON.parse(readFileSync(output, 'utf8'))
              // 缓存里是 Python 的 snake_case，转成 pageOf 认的驼峰
              const mapped = {
                durationSeconds: Number(cached.duration_seconds || 0),
                subtitles: Array.isArray(cached.subtitles)
                  ? cached.subtitles.map((s) => ({ time: s.time, text: s.text }))
                  : [],
                images: [],
                mode: cached.mode,
                model: cached.model,
              }
              return reply(pageOf(mapped, from, limit, []))
            }
            // OpenCV 在 Windows 上对非 ASCII 路径常打不开：交给 lib 做 ASCII 硬链接/副本
            const ascii = ensureAsciiInput(input, outDir, extname(input) || '.mp4')
            if (ascii.mode !== 'as-is') log(`[video] 输入路径含中文，已改用 ASCII ${ascii.mode === 'link' ? '硬链接' : '副本'}喂 OpenCV`)
            else if (ascii.error) log(`[video] ASCII 副本没做成（继续用原路径）：${ascii.error}`)
            log(`[video] 开始：${input}（${(size.bytes / 1024 / 1024).toFixed(1)}MB）python=${python}`)
            const run = await runVideoProcessor({
              python,
              script,
              input: ascii.path,
              output,
              cwd: PLUGIN_DIR,
              extraPath: join(PLUGIN_DIR, 'video', 'bin'),
              hfHome: join(BASE, 'hf-cache'),
              extraArgs: ['--mode', cfg.video.mode, '--model', cfg.video.model, '--model-dir', cfg.video.modelDir, '--max-grid', String(cfg.video.maxGrid)],
              timeoutMs: cfg.video.timeoutSec * 1000,
              log,
            })
            if (!run.ok) {
              log(`[video] 失败：${run.error}`)
              return reply(`视频处理失败：${run.error}`)
            }
            const result = run.result
            return reply(pageOf(result, from, limit, result.images))
          } catch (error) {
            const message = String((error && error.message) || error)
            log(`[video] 异常：${message}`)
            return reply(`视频处理异常：${message}`)
          }
        },
      },
      {
        name: 'sticker_list',
        description: '列出表情包仓库里的条目（名字、大小、类型），看完可以用 sticker_name 改名、sticker_send 发出去。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: TOOL_OUTPUT,
        execute: async () => {
          const cfg = readConfig(BASE)
          const list = listStickers(stickerDirOf(BASE, cfg))
          const text = list.length === 0
            ? '表情包仓库还是空的（引用一张图、说暗号就能收）'
            : list.map((item) => `${item.name}（${Math.max(1, Math.round((item.bytes || 0) / 1024))}KB，${item.mime}）`).join('\n')
          return { content: [{ type: 'text', text }] }
        },
      },
      {
        name: 'sticker_name',
        description: '给表情包改名（名字由黛丝自己起，按画面/情绪起好记的名字）。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '现在叫的名字（sticker_list 里那串）' },
            to: { type: 'string', description: '新名字（中文/字母/数字，≤24 字）' },
          },
          required: ['from', 'to'],
          additionalProperties: false,
        },
        output: TOOL_OUTPUT,
        execute: async (args) => {
          const reply = (text) => ({ content: [{ type: 'text', text }] })
          const cfg = readConfig(BASE)
          const out = renameSticker(stickerDirOf(BASE, cfg), String((args && args.from) || ''), String((args && args.to) || ''))
          if (!out.ok) return reply(`改名失败：${out.why}`)
          log(`[tool] sticker_name ${args.from} → ${out.name}`)
          return reply(`改好了：${out.name}`)
        },
      },
      {
        name: 'sticker_send',
        description: '把表情包里的一条发到主人 QQ（按情景自主选用，不必每句都发）。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '表情包名字（sticker_list 里的）' } },
          required: ['name'],
          additionalProperties: false,
        },
        output: TOOL_OUTPUT,
        execute: async (args, exec) => {
          const reply = (text) => ({ content: [{ type: 'text', text }] })
          try {
            const cfg = readConfig(BASE)
            if (!direct || typeof direct.sendImage !== 'function') return reply('直连还没起来')
            if (!cfg.direct.ownerId) return reply('还没配 ownerId')
            const name = String((args && args.name) || '')
            const path = stickerPath(stickerDirOf(BASE, cfg), name)
            if (!path) return reply(`没有这条表情：${name}`)
            const bytes = readFileSync(path)
            await direct.sendImage(cfg.direct.ownerId, bytes, basename(path))
            log(`[tool] sticker_send ${name}（${path}）`)
            return reply(`已发到 QQ：${name}`)
          } catch (error) {
            const message = String((error && error.message) || error)
            log(`[tool] sticker_send 失败：${message}`)
            return reply(`发失败：${message}`)
          }
        },
      },
    ]
    for (const def of defs) {
      toolDisposers.push(tools.register(def))
    }
    log(`tools registered: ${defs.map((d) => d.name).join(', ')}`)
    log(`tools registered: ${defs.map((d) => d.name).join(', ')}（ctx=${scopedCtx === ctx ? 'root' : 'scoped'}）`)
  }

  async function startMailbox(svc, rep) {
    const cfg = readJson(CONFIG)
    rep.relay.config = cfg ? { sessionId: cfg.sessionId ?? null, mailbox: cfg.mailbox ?? null } : null
    if (!cfg || !cfg.sessionId) {
      const msg = 'relay.json 里没有 sessionId —— 不知道锁定哪条会话，信箱不启动（这是显式的，不是静默）'
      rep.relay.errors.push(msg); log(msg); return
    }
    if (!svc || typeof svc.prompt !== 'function') {
      const msg = 'sessionController 不可用（拿不到 prompt）—— 信箱不启动'
      rep.relay.errors.push(msg); log(msg); return
    }

    // ① 配置 / ② list().cwd / ③ 会话头兜底
    let mailbox = null, how = null
    if (cfg.mailbox) { mailbox = cfg.mailbox; how = 'config' }
    if (!mailbox) {
      try {
        const listed = await svc.list({})
        const items = (listed && listed.items) || []
        rep.relay.listCount = items.length
        rep.relay.listSampleKeys = items[0] ? Object.keys(items[0]) : null
        const mine = items.find((s) => s && s.sessionId === cfg.sessionId)
        rep.relay.sessionFound = Boolean(mine)
        rep.relay.sessionSummary = mine
          ? { sessionId: mine.sessionId, cwd: mine.cwd ?? null, agentAvailable: mine.agentAvailable, running: mine.running, blank: mine.blank }
          : null
        if (mine && mine.cwd) { mailbox = join(mine.cwd, MAILBOX_DIRNAME); how = 'list.cwd' }
      } catch (e) { rep.relay.errors.push(`list() 失败：${String((e && e.message) || e)}`) }
    }
    if (!mailbox) {
      const h = cwdFromSessionHeader(cfg.sessionId)
      if (h.ok) { mailbox = join(h.cwd, MAILBOX_DIRNAME); how = `sessionHeader(${h.from})` }
      else rep.relay.errors.push(`会话头兜底失败：${h.why}`)
    }
    if (!mailbox) { rep.relay.errors.push('定位不到工作区 ⇒ 信箱不启动'); log('cannot locate mailbox'); return }

    rep.relay.resolved = { mailbox, how }
    const dirs = {
      inbox: join(mailbox, 'inbox'),
      outbox: join(mailbox, 'outbox'),   // 🆕 反方向：插件写回执、会话写回信 ⇒ 引擎取走
      done: join(mailbox, 'done'),
      failed: join(mailbox, 'failed'),
    }
    ensureDir(dirs.done); ensureDir(dirs.failed)      // inbox 由"投递方"建（谁用谁建）
    ensureDir(dirs.outbox)                            // outbox 由"写回信的一方"建
    log(`mailbox resolved via ${how}: ${mailbox}`)
    log(`mailbox resolved via ${how}: ${mailbox}`)

    // 🔔 发布声明 + 起心跳：引擎靠它知道"信箱在哪、收件方还在不在"
    //    优先级：relay.json 的 declarationDir → 环境变量（自检/特殊部署用）→ 默认（小屋应用目录）
    const declDir = cfg.declarationDir || process.env.DSH_QQ_RELAY_DECL_DIR || DECLARATION_DIR_DEFAULT
    const declFile = join(declDir, 'mailbox.json')
    try {
      ensureDir(declDir)
      publishDeclaration(declDir, mailbox, cfg.sessionId, at)
      rep.relay.declaration = { path: declFile, everySec: HEARTBEAT_MS / 1000 }
      log(`declaration published: ${declFile}`)
      log(`declaration published: ${declFile}`)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = setInterval(() => {
        try { publishDeclaration(declDir, mailbox, cfg.sessionId, at) }
        catch (e) { log(`heartbeat failed: ${String((e && e.message) || e)}`) }
        invalidateRemote()   // 声明刚刷新 ⇒ 卡片下一次读要拿到新的心跳时间
      }, HEARTBEAT_MS)
      if (heartbeatTimer.unref) heartbeatTimer.unref()
    } catch (e) {
      // 声明发不出去 ⇒ 引擎会按"收件方不在"处理（它照旧投递但在 QQ 上提醒）—— 这里必须留痕
      const msg = `发布声明失败（${declDir}）：${String((e && e.message) || e)}`
      rep.relay.errors.push(msg); log(msg)
    }

    await drain(svc, cfg, dirs, rep)
    invalidateRemote()   // 投递完 ⇒ 条数变了

    function arm() {
      if (disposed) return
      if (existsSync(dirs.inbox)) {
        if (!watcher) {
          try {
            watcher = watch(dirs.inbox, () => {
              // ⚠️ 这里的失败**必须喊出来**：以前写成空 catch ⇒ 出错了屏幕上什么都没有
              //    （2026-10-16 自检真抓到过一次：drain 里一个变量不在作用域，被它吞了）
              drain(svc, cfg, dirs, rep)
                .then(() => flush('drain'))
                .catch((e) => {
                  const m = String((e && e.message) || e)
                  rep.relay.errors.push(`drain 抛错：${m}`)
                  log(`drain threw: ${m}`)
                  log(`drain threw: ${m}`)
                })
            })
            rep.relay.watching = dirs.inbox
            log(`watching ${dirs.inbox}`)
          } catch (e) { rep.relay.errors.push(`fs.watch 失败：${String((e && e.message) || e)}`) }
        }
      } else {
        rep.relay.watching = null
      }
      pollTimer = setTimeout(arm, POLL_MS)
      if (pollTimer.unref) pollTimer.unref()
    }
    arm()
  }

  async function drain(svc, cfg, dirs, rep) {
    if (disposed) return
    let names = []
    try { names = readdirSync(dirs.inbox).filter((n) => n.endsWith('.json')) } catch { return }
    if (!names.length) return

    const now = Date.now()
    rep.relay.rate = (rep.relay.rate || []).filter((t) => now - t < 60_000)
    if (rep.relay.rate.length >= MAX_PER_MINUTE) {
      const msg = `这一分钟已投 ${rep.relay.rate.length} 条，超上限（${MAX_PER_MINUTE}/分钟）⇒ 本轮跳过，文件留在 inbox`
      rep.relay.errors.push(msg); log(msg); return
    }

    for (const name of names.sort()) {
      const src = join(dirs.inbox, name)
      try {
        if (statSync(src).size > MAX_FILE_BYTES) {
          const msg = `${name} 超过 ${MAX_FILE_BYTES} 字节`
          rep.relay.processed.push({ file: name, ok: false, stage: 'too-big', error: msg })
          renameSync(src, join(dirs.failed, `${name}.too-big`))
          rep.relay.errors.push(`${msg} ⇒ 挪进 failed`)
          log(`FAILED ${name}: ${msg}`)
          log(`FAILED file=${name} stage=too-big`)
          continue
        }
      } catch { /* 拿不到大小就继续试 */ }

      // 原子认领：改名（认领后不再以 .json 结尾，不会被重复处理）
      const claimed = join(dirs.inbox, `${name}.claimed-${Date.now()}`)
      try { renameSync(src, claimed) } catch { continue }

      let req = null
      try { req = JSON.parse(readFileSync(claimed, 'utf8')) } catch (e) {
        const msg = String((e && e.message) || e)
        rep.relay.processed.push({ file: name, ok: false, stage: 'parse', error: msg })
        archive(claimed, dirs.failed, { ok: false, stage: 'parse', error: msg })
        log(`FAILED ${name}: JSON 解析失败 — ${msg}`)
        log(`FAILED file=${name} stage=parse error=${msg}`)
        continue
      }
      const sessionId = req.sessionId || cfg.sessionId
      const text = req.text
      // 🖼 v2：**图本身就是内容** ⇒ 没有文字也不算"缺东西"（引擎在带图时会补一句占位话，
      //    但这条腿不该依赖"对方一定会补"；真缺 sessionId 仍然照样退信 ✗）
      const images = Array.isArray(req.images) ? req.images : []
      if (!sessionId || (!text && images.length === 0)) {
        const msg = '缺 sessionId/text'
        rep.relay.processed.push({ file: name, ok: false, stage: 'validate', error: msg })
        archive(claimed, dirs.failed, { ok: false, stage: 'validate', error: msg, request: req })
        log(`FAILED ${name}: ${msg}（sessionId 必须给，或写进 relay.json）`)
        log(`FAILED file=${name} stage=validate error=${msg}`)
        continue
      }

      const mode = req.mode === 'steer' ? 'steer' : 'queue'
      // requestId 优先用**引擎写进信里的 id** ⇒ 会话日志里的 `rpcId` 能端到端对上号 ✓
      const rawId = String(req.id || req.requestId || `auto-${Date.now().toString(36)}`)
      const requestId = rawId.startsWith('qq-') ? rawId : `qq-${rawId}`

      // 📮 附一段**自带的说明**：告诉这条会话"这话来自 QQ、回信该写到哪、什么格式"。
      //    为什么不靠记忆文件：这样**任何**会话（哪怕不是我这个实例、哪怕没有工作区文档）
      //    都能照办 ⇒ 链路不依赖"我记不记得"。（可以用 relay.json 的 hint:false 关掉）
      const hint = cfg.hint === false ? '' :
        `【来自 QQ｜这条是主人从 QQ 发来的】\n` +
        `回信请写到（一个 JSON 文件，名字随便）：${dirs.outbox}\\<任意名>.json\n` +
        `内容：{"protocol":1,"kind":"text","text":"你要说的话"}\n` +
        (images.length
          ? `（这封信带了 ${images.length} 张图 —— **图已经作为图片附件给你了**，就在这条消息里，直接看就行，不用猜。）\n`
          : '') +
        `（写完就用引擎发到 QQ；不写就只有你在 DSH 里说的话，主人在外面收不到。）\n\n`
      const promptText = hint ? `${hint}${String(text)}` : String(text)

      // 🖼 v2：信封带了 `images[]` ⇒ 把**像素**一起交给会话（不再只给识图描述）。
      //    为什么读文件这件事在这里做：信封里只有**路径**（图是引擎落盘在 `<信箱>\media\` 的），
      //    base64 这一步归取件方；`mediaType` **直接用信封给的**（引擎按文件头嗅出来的）
      //    ⇒ 插件**不按扩展名猜**、也不猜内容。
      //    读不到 / 超过 `MAX_IMAGE_BYTES` ⇒ 整封进 `failed/` **并说明**（绝不静默丢）。
      const blocks = [{ type: 'text', text: promptText }]
      const imageProblems = []
      for (const entry of images) {
        const file = entry && typeof entry.path === 'string' ? entry.path : ''
        if (!file) { imageProblems.push('images[] 里有一条没有 path'); continue }
        try {
          const size = statSync(file).size
          if (size > MAX_IMAGE_BYTES) {
            imageProblems.push(`${basename(file)} 有 ${(size / 1024 / 1024).toFixed(1)}MB（${size} 字节），超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限`)
            continue
          }
          const mediaType = String((entry && entry.mediaType) || '').trim()
          if (!mediaType) { imageProblems.push(`${basename(file)} 没给 mediaType（不许猜）`); continue }
          const block = { type: 'image', mediaType, data: readFileSync(file).toString('base64') }
          if (entry && entry.name) block.name = String(entry.name)
          blocks.push(block)
        } catch (e) {
          imageProblems.push(`${file} 读不到：${String((e && e.message) || e)}`)
        }
      }
      if (imageProblems.length) {
        const why = `图没能附给会话：${imageProblems.join('；')}`
        rep.relay.processed.push({ file: name, ok: false, stage: 'images', error: why })
        archive(claimed, dirs.failed, {
          ok: false, stage: 'images', error: why, requestId, sessionId, mode,
          images: images.map((entry) => entry && entry.path),
        })
        log(`FAILED ${name}: ${why}`)
        log(`FAILED file=${name} stage=images error=${why}`)
        // 🔔 **不许静默**：顺手请引擎在 QQ 上告诉主人一句（走 outbox —— 与回执同一条路）
        try { writeReceipt(dirs.outbox, rawId, `（有一张图没能交给会话：${imageProblems[0]}）`)}
        catch (e) { log(`image notice failed: ${String((e && e.message) || e)}`) }
        continue
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PROMPT_TIMEOUT_MS)
      if (timer.unref) timer.unref()

      try {
        // 🖼 v2：content = 一个文字块 + **每张图一个 image 块**（就是上面组装好的 blocks）
        const result = await svc.prompt({ requestId, sessionId, mode, content: blocks }, controller.signal)
        clearTimeout(timer)
        rep.relay.rate.push(Date.now())
        rep.relay.processed.push({ file: name, ok: true, requestId, sessionId, mode, images: blocks.length - 1, result })
        archive(claimed, dirs.done, { ok: true, requestId, sessionId, mode, result })
        log(`SENT ${name} → ${sessionId} (rpcId=${requestId}, accepted=${result && result.accepted})`)
        log(`SENT file=${name} sessionId=${sessionId} rpcId=${requestId}`)

        // 🔔 回执：**投进去了就告诉主人一句**（"没有回执本身就是异常"）。
        //    这里只管**写**；发不发由引擎按 `relayAck` 决定（设置是引擎的，所以开关随信一起来）。
        if (req.ack === false) {
          log(`receipt skipped（信里说 ack=false）file=${name}`)
        } else {
          try {
            const receipt = writeReceipt(dirs.outbox, rawId, RECEIPT_TEXT)
            rep.relay.receipts = (rep.relay.receipts || []).concat([{ file: receipt, replyTo: rawId }])
            log(`receipt → outbox (${basename(receipt)})`)
          } catch (e) {
            const msg = `写回执失败：${String((e && e.message) || e)}`
            rep.relay.errors.push(msg); log(msg)
          }
        }
      } catch (e) {
        clearTimeout(timer)
        const msg = String((e && e.message) || e)
        rep.relay.processed.push({ file: name, ok: false, requestId, sessionId, mode, error: msg })
        archive(claimed, dirs.failed, { ok: false, stage: 'prompt', error: msg, requestId, sessionId, mode })
        log(`FAILED ${name}: ${msg}`)
        log(`FAILED file=${name} error=${msg}`)
      }
    }
  }

  function archive(claimedPath, dir, extra) {
    try {
      ensureDir(dir)
      const base = basename(claimedPath)
      writeFileSync(join(dir, `${base}.result.json`), JSON.stringify({ ...extra, at: new Date().toISOString() }, null, 2), 'utf8')
      renameSync(claimedPath, join(dir, base))
    } catch (e) { log(`archive failed: ${String((e && e.message) || e)}`) }
  }

  flush('apply')
  // 启动台只留这一行（其余状态都在 probe.log 里）
  announceStartup()

  function flush(tag) {
    try {
      ensureDir(BASE)
      const stamp = report.at.replace(/[:.]/g, '-')
      const file = join(BASE, `probe-${stamp}-${tag}.json`)
      writeFileSync(file, JSON.stringify(report, null, 2), 'utf8')
      const resolved = report.relay.resolved ? `${report.relay.resolved.how} → ${report.relay.resolved.mailbox}` : 'none'
      log(`report: ${file} | v${CODE_VERSION} | resolved=${resolved} | processed=${report.relay.processed.length} | errors=${report.relay.errors.length}`)
    } catch (e) { log(`report write failed: ${String((e && e.message) || e)}`) }
  }
}
