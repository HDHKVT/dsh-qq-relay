/**
 * 直连 QQ：token + 网关 + 心跳 + 重连（Task 3）。
 *
 * 只做“把事件接出来”这一件事 —— 不认识会话、不认识 owner、不投递。
 * 投递策略在 `index.js`（Task 4），回信在 `lib/qq-reply.js`（Task 5）。
 *
 * 协议来源：本机小屋引擎的 Rust 实现（`黛丝QQ小屋\rust\daisy-qq`），
 * 每一步都和它对齐：`op 10 Hello → op 2 identify`、`op 1` 心跳带 `lastSeq`、
 * `op 7/9` 重连、`4013/4014/4914/4915` 是致命关闭码（重连没用）。
 *
 * 可测性：WebSocket / fetch / 定时器 / 时钟全部可注入 ⇒ 单测里没有网络。
 */

const TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken'
const GATEWAY_URL = 'https://api.sgroup.qq.com/gateway'
const SEND_BASE = 'https://api.bot.qq.com/v2/users'
/** 4013 无效 intent / 4014 intent 无权限 / 4914 已下架 / 4915 已封禁 */
const FATAL_CLOSE = new Set([4013, 4014, 4914, 4915])
/** 重连退避（毫秒），最后一档封顶 */
const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000]
/** 群的 @ 消息事件类型；v1 只处理私聊，但要能认出来并说明“暂不支持” */
export const GROUP_AT = 'GROUP_AT_MESSAGE_CREATE'
export const C2C = 'C2C_MESSAGE_CREATE'

/** 拿 access_token（有效期通常 7200 秒） */
export async function fetchAccessToken({ appId, appSecret, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
  })
  const body = await response.json().catch(() => null)
  if (!body || typeof body.access_token !== 'string' || body.access_token === '') {
    throw new Error(`拿 access_token 失败：HTTP ${response.status} ${JSON.stringify(body)}`)
  }
  const expiresIn = Number(body.expires_in)
  return { token: body.access_token, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200 }
}

/** 拿网关地址（`wss://api.sgroup.qq.com/websocket/`） */
export async function fetchGatewayUrl({ token, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(GATEWAY_URL, { headers: { Authorization: `QQBot ${token}` } })
  const body = await response.json().catch(() => null)
  if (!body || typeof body.url !== 'string' || body.url === '') {
    throw new Error(`拿网关地址失败：HTTP ${response.status} ${JSON.stringify(body)}`)
  }
  return body.url
}

/**
 * 建一个直连传输。
 *
 * @param {object} options
 * @param {{appId: string, appSecret: string, ownerId: string, intents: number}} options.config
 * @param {(event: {type: string, openid: string, text: string, msgId: string, at: number}) => void} [options.onEvent]
 * @param {(line: string) => void} [options.log]
 * @param {typeof WebSocket} [options.WebSocketImpl] - 单测注入假实现
 * @param {typeof fetch} [options.fetchImpl]
 * @param {{setInterval: Function, clearInterval: Function, setTimeout: Function, clearTimeout: Function}} [options.timers]
 * @param {() => number} [options.now]
 * @returns {{start: () => Promise<void>, stop: () => void, state: () => object}}
 */
export function createDirect(options) {
  const {
    config,
    onEvent = () => {},
    log = () => {},
    WebSocketImpl = globalThis.WebSocket,
    fetchImpl = globalThis.fetch,
    timers = { setInterval, clearInterval, setTimeout, clearTimeout },
    now = Date.now,
  } = options

  let socket = null
  let heartbeatTimer = null
  let reconnectTimer = null
  let stopped = true
  let lastSeq = null
  let heartbeatMs = null
  let attempt = 0
  let phase = 'idle'
  let lastError = ''
  let token = ''
  let tokenExpiresAt = 0

  const state = () => ({ phase, attempt, lastError, lastSeq, connected: phase === 'ready' })

  function send(payload) {
    try { socket.send(JSON.stringify(payload)) } catch (error) { log(`[ws] 发送失败：${String((error && error.message) || error)}`) }
  }

  async function ensureToken() {
    if (token && now() < tokenExpiresAt - 60_000) return token
    const got = await fetchAccessToken({ appId: config.appId, appSecret: config.appSecret, fetchImpl })
    token = got.token
    tokenExpiresAt = now() + got.expiresIn * 1000
    log('[auth] 拿到 access_token')
    return token
  }

  function scheduleReconnect(reason) {
    if (stopped) return
    attempt += 1
    const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]
    phase = 'reconnecting'
    log(`[ws] ${reason} ⇒ ${Math.round(delay / 1000)} 秒后重连（第 ${attempt} 次）`)
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null
      connect().catch((error) => {
        lastError = String((error && error.message) || error)
        log(`[ws] 重连失败：${lastError}`)
        scheduleReconnect('重连抛错')
      })
    }, delay)
  }

  function handleFrame(frame) {
    if (typeof frame.s === 'number') lastSeq = frame.s
    if (frame.op === 10) {
      const interval = frame.d && frame.d.heartbeat_interval
      if (typeof interval === 'number' && interval > 0) {
        heartbeatMs = interval
        if (heartbeatTimer) timers.clearInterval(heartbeatTimer)
        heartbeatTimer = timers.setInterval(() => send({ op: 1, d: lastSeq }), interval)
      }
      send({
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: config.intents,
          shard: [0, 1],
          properties: { $os: 'windows', $browser: 'dsh', $device: 'dsh' },
        },
      })
      phase = 'identifying'
      log('[ws] Hello 到了，已发送 identify')
      return
    }
    if (frame.op === 11) return // 心跳 ack
    if (frame.op === 7) { log('[ws] 服务端要求重连（op 7）'); closeAndReconnect('服务端要求重连'); return }
    if (frame.op === 9) { log('[ws] 会话失效（op 9），清空 seq 重连'); lastSeq = null; closeAndReconnect('会话失效'); return }
    if (frame.op !== 0) return

    if (frame.t === 'READY') {
      phase = 'ready'
      attempt = 0
      lastError = ''
      log('[ws] 鉴权成功（READY）')
      return
    }
    if (frame.t === C2C || frame.t === GROUP_AT) {
      const d = frame.d || {}
      const author = d.author || {}
      const openid = d.group_openid && frame.t === GROUP_AT ? d.group_openid : author.user_openid || author.member_openid || ''
      const event = {
        type: frame.t,
        openid,
        text: typeof d.content === 'string' ? d.content.trim() : '',
        msgId: typeof d.id === 'string' ? d.id : '',
        // 🖼 图片走 `attachments[]`（URL 带签名、会过期 ⇒ 上层收到就得立刻下）；
        //    `msg_elements[]` 是引擎那边的后备来源（它的地址字段也叫 `content`）
        attachments: Array.isArray(d.attachments) ? d.attachments : [],
        msgElements: Array.isArray(d.msg_elements) ? d.msg_elements : [],
        at: now(),
      }
      try { onEvent(event) } catch (error) { log(`[ws] onEvent 抛错：${String((error && error.message) || error)}`) }
    }
  }

  function closeAndReconnect(reason) {
    try { if (socket) socket.close() } catch { /* 忽略 */ }
    socket = null
    if (heartbeatTimer) { timers.clearInterval(heartbeatTimer); heartbeatTimer = null }
    scheduleReconnect(reason)
  }

  async function connect() {
    phase = 'connecting'
    const accessToken = await ensureToken()
    const url = await fetchGatewayUrl({ token: accessToken, fetchImpl })
    log(`[ws] 连接 ${url}`)
    const ws = new WebSocketImpl(url)
    socket = ws
    ws.onopen = () => log('[ws] 已连上，等 Hello')
    ws.onmessage = (event) => {
      let frame
      try { frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch {
        log('[ws] 收到非 JSON 帧，忽略')
        return
      }
      try { handleFrame(frame) } catch (error) { log(`[ws] 处理帧失败：${String((error && error.message) || error)}`) }
    }
    ws.onerror = () => log('[ws] 连接报错')
    ws.onclose = (event) => {
      if (socket !== ws) return
      socket = null
      if (heartbeatTimer) { timers.clearInterval(heartbeatTimer); heartbeatTimer = null }
      if (stopped) { phase = 'closed'; return }
      const code = Number(event && event.code)
      if (FATAL_CLOSE.has(code)) {
        stopped = true
        phase = 'closed'
        lastError = `致命关闭码 ${code}（${code === 4013 ? 'intent 无效' : code === 4014 ? 'intent 无权限，回 QQ 后台开「接收所有消息」' : code === 4914 ? '机器人已下架' : '机器人已封禁'}）`
        log(`[ws] ${lastError}`)
        return
      }
      lastError = `连接断开 code=${code}`
      scheduleReconnect(lastError)
    }
  }

  return {
    async start() {
      if (!config || !config.appId || !config.appSecret) {
        lastError = '缺 appId / appSecret，直连没有启动'
        log(`[ws] ${lastError}`)
        phase = 'closed'
        return
      }
      stopped = false
      attempt = 0
      try {
        await connect()
      } catch (error) {
        lastError = String((error && error.message) || error)
        log(`[ws] 首次连接失败：${lastError}`)
        scheduleReconnect(lastError)
      }
    },
    stop() {
      stopped = true
      phase = 'closed'
      if (reconnectTimer) { timers.clearTimeout(reconnectTimer); reconnectTimer = null }
      if (heartbeatTimer) { timers.clearInterval(heartbeatTimer); heartbeatTimer = null }
      try { if (socket) socket.close() } catch { /* 忽略 */ }
      socket = null
    },
    state,
    /**
     * 给某个 openid 发一条私聊（被动回复：要带对方那条消息的 msgId）。
     *
     * @param {string} openid - 对方的 user_openid
     * @param {string} text - 纯文本正文（调用方负责切片）
     * @param {string} msgId - 触发这条回复的入站消息 id
     * @param {number} [seq] - 同一条 msgId 的多片回复要递增，避免被去重
     * @returns {Promise<object>} 对端返回体
     */
    async send(openid, text, msgId, seq = 1) {
      const accessToken = await ensureToken()
      const url = `${SEND_BASE}/${encodeURIComponent(openid)}/messages`
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `QQBot ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content: text, msg_type: 0, msg_id: msgId, msg_seq: seq }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(`发 QQ 失败：HTTP ${response.status} ${JSON.stringify(body)}`)
      }
      return body
    },

    /**
     * 给某个 openid 发一张图（阶段 4，2026-10-18）。
     *
     * 两步：先 `POST /files` 把图**传上去**拿 `file_info`，再 `msg_type: 7` 发出去。
     * 传图用 `file_data`（base64）——我们的图都在本地，没有公网 URL 可用。
     *
     * @param {string} openid
     * @param {Buffer} bytes
     * @param {string} [filename]
     * @param {string} [msgId] - 有就带上（被动回复），没有就走主动消息
     * @param {string} [caption] - 配文；只有 `send.captionMode = merge` 时才塞进图片消息
     * @returns {Promise<object>}
     */
    async sendImage(openid, bytes, filename = 'image.png', msgId = '', caption = '') {
      const accessToken = await ensureToken()
      const uploadUrl = `${SEND_BASE}/${encodeURIComponent(openid)}/files`
      const uploaded = await fetchImpl(uploadUrl, {
        method: 'POST',
        headers: { Authorization: `QQBot ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ file_type: 1, file_data: Buffer.from(bytes).toString('base64'), srv_send_msg: false }),
      })
      const uploadBody = await uploaded.json().catch(() => null)
      if (!uploaded.ok || !uploadBody || !uploadBody.file_info) {
        throw new Error(`传图失败：HTTP ${uploaded.status} ${JSON.stringify(uploadBody)}`)
      }
      // 空 content 会把气泡撑出空白；只有**明确要合并的配文**才传
      const payload = { msg_type: 7, media: { file_info: uploadBody.file_info } }
      const text = String(caption || '').trim()
      if (text !== '') payload.content = text
      if (msgId) { payload.msg_id = msgId; payload.msg_seq = 2 }
      const response = await fetchImpl(`${SEND_BASE}/${encodeURIComponent(openid)}/messages`, {
        method: 'POST',
        headers: { Authorization: `QQBot ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(`发图失败：HTTP ${response.status} ${JSON.stringify(body)}`)
      }
      return { ...body, filename }
    },

    /**
     * 给某个 openid 发一个**文件**（阶段 6，2026-10-18）。
     *
     * 和发图同一套两步走，差别只在 `file_type: 4` + 带上 `file_name`：
     * QQ 会把它显示成“文件”，点开下载，不按图片预览。
     *
     * @param {string} openid
     * @param {Buffer} bytes
     * @param {string} filename
     * @param {string} [msgId] - 有就带上（被动回复）
     * @param {string} [caption] - 可选配文（并进同一条）
     * @returns {Promise<object>}
     */
    async sendFile(openid, bytes, filename, msgId = '', caption = '') {
      const accessToken = await ensureToken()
      const uploadUrl = `${SEND_BASE}/${encodeURIComponent(openid)}/files`
      const uploaded = await fetchImpl(uploadUrl, {
        method: 'POST',
        headers: { Authorization: `QQBot ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          file_type: 4,
          file_name: filename,
          file_data: Buffer.from(bytes).toString('base64'),
          srv_send_msg: false,
        }),
      })
      const uploadBody = await uploaded.json().catch(() => null)
      if (!uploaded.ok || !uploadBody || !uploadBody.file_info) {
        throw new Error(`传文件失败：HTTP ${uploaded.status} ${JSON.stringify(uploadBody)}`)
      }
      const payload = { msg_type: 7, media: { file_info: uploadBody.file_info } }
      const text = String(caption || '').trim()
      if (text !== '') payload.content = text
      if (msgId) { payload.msg_id = msgId; payload.msg_seq = 2 }
      const response = await fetchImpl(`${SEND_BASE}/${encodeURIComponent(openid)}/messages`, {
        method: 'POST',
        headers: { Authorization: `QQBot ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(`发文件失败：HTTP ${response.status} ${JSON.stringify(body)}`)
      }
      return { ...body, filename }
    },
  }
}
