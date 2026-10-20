/**
 * 会话 → QQ：把“由 QQ 触发的那一轮”的最终答复发回去（Task 5）。
 *
 * 关联办法（不靠模型自觉、也不靠猜）：
 *   1. 收到 `turn/start {turn}` ⇒ 记住“当前 turn”
 *   2. 收到 `user/message`，且 `source.kind === 'user'` 且 `source.rpcId` 以
 *      `qq-direct-` 开头 ⇒ 把「当前 turn → 这个 requestId」记下来
 *   3. 同一 turn 里的 `assistant/message`：**只收没有 tool-call 块的那种**，
 *      并保留最后一条（工具调用之后的终稿）
 *   4. `turn/end` ⇒ 发出去，然后清掉这一轮
 *
 * 为什么要 turn 这一步：`assistant/message` 不带 rpcId，只带 turn；
 * 而 `user/message` 带 rpcId、不带 turn —— 两半在 `turn/start` 那里对上。
 */

const QQ_DIRECT_PREFIX = 'qq-direct-'

/** 去掉 QQ 不渲染的 Markdown 记号（实测星号会原样显示）。 */
export function plainForQq(text) {
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim()
}

/**
 * 按上限切片：优先在换行/句末切，单片不超过 `maxChars`。
 * @param {string} text
 * @param {number} maxChars
 * @param {number} maxParts
 * @returns {string[]}
 */
export function chunkText(text, maxChars, maxParts = 3) {
  const body = String(text || '')
  if (body === '') return []
  const parts = []
  let rest = body
  while (rest !== '' && parts.length < maxParts) {
    if (rest.length <= maxChars) { parts.push(rest); rest = ''; break }
    const window = rest.slice(0, maxChars)
    let cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('；'), window.lastIndexOf('  '))
    if (cut < maxChars * 0.4) cut = maxChars
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest !== '' && parts.length === maxParts) {
    parts[maxParts - 1] = `${parts[maxParts - 1].slice(0, Math.max(0, maxChars - 12))}…（还有没发完）`
  }
  return parts.filter((part) => part !== '')
}

/**
 * 订阅会话事件，把 QQ 触发回合的终稿发回 QQ。
 *
 * @param {object} ctx - 插件上下文（只要 `on`）
 * @param {object} options
 * @param {(openid: string, text: string, msgId: string, seq: number) => Promise<unknown>} options.send
 * @param {(requestId: string) => ({openid: string, msgId: string} | null)} options.resolveRequest
 * @param {() => number} [options.maxChars] - 每次发送时现读（设置页改完立即生效）
 * @param {(line: string) => void} [options.log]
 * @returns {() => void} 取消订阅
 */
export function bindReplyForward(ctx, options) {
  const { send, resolveRequest, maxChars = () => 900, log = () => {} } = options
  /** sessionId → 当前 turn（由 turn/start 更新） */
  const currentTurn = new Map()
  /** `${sessionId}:${turn}` → { requestId, openid, msgId } */
  const turnOwner = new Map()
  /** `${sessionId}:${turn}` → 终稿文本 */
  const candidate = new Map()

  const keyOf = (sessionId, turn) => `${sessionId}:${turn}`
  const sessionIdOf = (session) => {
    try {
      return (session && session.header && session.header.id) || (session && session.id) || ''
    } catch { return '' }
  }

  function onEvent(session, event) {
    if (!event || typeof event.type !== 'string') return
    const sessionId = sessionIdOf(session)
    if (!sessionId) return

    if (event.type === 'turn/start') {
      currentTurn.set(sessionId, event.data && event.data.turn)
      return
    }

    if (event.type === 'user/message') {
      const source = event.data && event.data.source
      const rpcId = source && source.kind === 'user' ? source.rpcId : undefined
      if (typeof rpcId !== 'string' || !rpcId.startsWith(QQ_DIRECT_PREFIX)) return
      const turn = currentTurn.get(sessionId)
      const who = resolveRequest(rpcId)
      if (turn === undefined || !who) {
        log(`[reply] 这条 QQ 消息没有对应的待发回合（rpcId=${rpcId}），不转发`)
        return
      }
      turnOwner.set(keyOf(sessionId, turn), { requestId: rpcId, ...who })
      return
    }

    if (event.type === 'assistant/message') {
      const data = event.data || {}
      const key = keyOf(sessionId, data.turn)
      if (!turnOwner.has(key)) return
      const blocks = (data.message && data.message.content) || []
      if (blocks.some((block) => block && block.type === 'tool-call')) return
      const text = blocks
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
      if (text.trim() === '') return
      candidate.set(key, text)
      return
    }

    if (event.type === 'turn/end') {
      const turn = event.data && event.data.turn
      const key = keyOf(sessionId, turn)
      const owner = turnOwner.get(key)
      if (!owner) return
      const text = candidate.get(key)
      turnOwner.delete(key)
      candidate.delete(key)
      if (!text) return
      const parts = chunkText(plainForQq(text), Math.max(50, Number(maxChars()) || 900))
      if (parts.length === 0) return
      Promise.resolve()
        .then(async () => {
          for (let i = 0; i < parts.length; i += 1) {
            await send(owner.openid, parts[i], owner.msgId, i + 1)
          }
          log(`[reply] 已发回 QQ（${parts.length} 条，msgId=${owner.msgId}）`)
        })
        .catch((error) => log(`[reply] 发回 QQ 失败：${String((error && error.message) || error)}`))
    }
  }

  const off = ctx.on('session/event', onEvent)
  return () => { try { if (typeof off === 'function') off() } catch { /* 忽略 */ } }
}
