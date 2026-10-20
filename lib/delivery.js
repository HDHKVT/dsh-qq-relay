/**
 * 直连消息的“投不投递”判定（Task 4，纯函数，好在 Node 里直接测）。
 *
 * 判定顺序就是安全顺序：先认事件类型（群聊直接出局），再认人（只认 owner），
 * 再认内容与非空，最后才看有没有锁定的会话。任何一步不过都返回**具体原因**，
 * 让调用方把它写进日志 —— 不静默丢弃。
 *
 * ⚠️ 与旧链路（信箱）的关系：那条路的三道门（主人 + 私聊 + 中继开着）由引擎把，
 * 这条路没有引擎，门就在这儿。
 */
import { pickImage } from './vision.js'
import { pickFile } from './files.js'
import { faceLabel } from './qq-faces.js'

/** 一个带上限的去重集合（QQ 会重推，重连还会补发）。 */
export function makeDeduper(limit = 200) {
  const order = []
  const seen = new Set()
  return {
    has(id) { return seen.has(id) },
    add(id) {
      if (id === '' || seen.has(id)) return
      seen.add(id)
      order.push(id)
      while (order.length > limit) seen.delete(order.shift())
    },
    get size() { return seen.size },
  }
}

/** 原因码 → 给人看的一句话（日志与状态都用它，避免两处文案漂移）。 */
export const REASON_TEXT = {
  'group-unsupported': '群聊消息：v1 只做私聊，暂不投递',
  'owner-unset': '还没配 Owner OpenID（设置 → QQ 中继），谁的消息都不收',
  'not-owner': '不是主人的私聊，忽略',
  'empty': '空消息（或只有附件），没有可投递的文字',
  'no-session': '还没锁定会话（先点「锁定当前会话」）',
  'duplicate': '重复的 msgId，已经投过',
}

/**
 * 去掉 QQ 的**表情标记**（`<faceType=6,faceId="0",ext="…">`），换成可读标签。
 *
 * 为什么要换：它是 QQ 的富文本占位，没有可读文字；原样投进会话就是
 * 「好的哦」后面跟一串代码。换成 `（表情：微笑）` 之后，既清掉了噪音，
 * 又保留了“你发了个什么表情”这条信息（对照表在 `lib/qq-faces.js`）。
 *
 * 只匹配 `faceType=` 开头的尖括号片段，**不碰**正文里的 `a<b`、代码块。
 *
 * @param {string} text
 * @returns {{text: string, hadFace: boolean}}
 */
export function stripFaces(text) {
  const source = typeof text === 'string' ? text : ''
  let hadFace = false
  const cleaned = source.replace(/<faceType=([^,>]*)(?:,faceId="?([^",>]*)"?)?[^>]*>/gi, (_match, faceType, faceId) => {
    hadFace = true
    return faceLabel(faceType, faceId)
  })
  return { text: cleaned.replace(/[ \t]{2,}/g, ' ').trim(), hadFace }
}

/**
 * 决定一条 QQ 事件要不要投进会话。
 *
 * @param {object} input
 * @param {{type: string, openid: string, text: string, msgId: string}} input.event
 * @param {string} input.ownerId - 配置里的 owner openid（空 = 没配）
 * @param {string|null} input.sessionId - 锁定的会话（空 = 没锁）
 * @param {boolean} [input.hint] - 是否在正文前加一行“来自 QQ”的说明
 * @param {number} [input.maxChars] - 只用于说明文案
 * @param {{has: (id: string) => boolean}} [input.deduper]
 * @returns {{deliver: false, reason: string} | {deliver: true, requestId: string, text: string}}
 */
/** 表情包频率 → 给模型看的一句话（每次投递都带上，当行为约束读） */
export const STICKER_FREQ_TEXT = {
  off: '（表情包：关，这轮不要主动发表情包）',
  rare: '（表情包：偶尔，极少主动发；只有特别贴切时才用）',
  normal: '（表情包：正常，合适才发，别硬塞）',
  often: '（表情包：常发，有合适的机会就用）',
}

export function decideDelivery({ event, ownerId, sessionId, hint = true, maxChars = 900, deduper, hasImage = false, hasFile = false, stickerFrequency = 'normal' }) {
  if (!event || event.type !== 'C2C_MESSAGE_CREATE') return { deliver: false, reason: 'group-unsupported' }
  if (!ownerId) return { deliver: false, reason: 'owner-unset' }
  if (event.openid !== ownerId) return { deliver: false, reason: 'not-owner' }
  // 🖼 只有图/只有文件/只有表情也是**合法消息**：正文用一句占位
  const { text: cleaned, hadFace } = stripFaces(event.text)
  const body = cleaned
  if (body === '' && !hasImage && !hasFile && !hadFace) return { deliver: false, reason: 'empty' }
  if (!sessionId) return { deliver: false, reason: 'no-session' }
  if (deduper && deduper.has(event.msgId)) return { deliver: false, reason: 'duplicate' }

  const placeholder = hasImage ? '（发来一张图）' : hasFile ? '（发来文件）' : '（发来一个表情）'
  const stickerLine = STICKER_FREQ_TEXT[stickerFrequency] || STICKER_FREQ_TEXT.normal
  // 🎬 B 站链接：提醒一声，省得我漏掉
  const biliHint = /BV[0-9A-Za-z]{10}|b23\.tv\/|bilibili\.com\/video\//.test(body) && !hasFile
    ? '\n（B 站链接：可用 download_bili 下载后再 analyze_video 分析）'
    : ''
  const head = hint ? `（来自 QQ，回答会原样发回；请用纯文本、${maxChars} 字内）\n${stickerLine}${biliHint}\n` : ''
  return { deliver: true, requestId: `qq-direct-${event.msgId}`, text: `${head}${body || placeholder}` }
}

/**
 * 把宿主的 `prompt(request, signal)` **绑上取消信号**，交给 `deliverEvent`。
 *
 * 为什么要这个薄层：`session/prompt` 的实现会无条件读 `signal.throwIfAborted()`，
 * 少了第二个参数就抛 `Cannot read properties of undefined (reading 'throwIfAborted')`，
 * 而在 QQ 那边看起来只是“没回复”。钉在单测里，免得再犯。
 *
 * @param {{prompt?: Function} | null} svc - `sessionController`
 * @param {AbortSignal} signal
 * @returns {((request: object) => Promise<object>) | undefined}
 */
export function bindPrompt(svc, signal) {
  if (!svc || typeof svc.prompt !== 'function') return undefined
  return (request) => svc.prompt(request, signal)
}

/**
 * 判定 + 真正投递（Task 4 的完整一步，宿主只负责把 `prompt` 接进来）。
 *
 * 为什么把“投”也放进来：这样单测可以直接喂一个假的 prompt，数它被调几次、
 * 参数长什么样 —— 不必起一个宿主、也不必真连 QQ。
 *
 * @param {object} input
 * @param {object} input.event - `createDirect` 交出来的事件
 * @param {{ownerId: string, sessionId: string|null, hint: boolean, maxChars: number}} input.config
 * @param {{has: Function, add: Function}} input.deduper
 * @param {(request: object) => Promise<object>} input.prompt - `sessionController.prompt`
 * @param {(line: string) => void} [input.log]
 * @returns {Promise<{delivered: boolean, reason?: string, error?: string}>}
 */
export async function deliverEvent({ event, config, deduper, prompt, prepareImage, prepareFile, extraNote = '', log = () => {} }) {
  // 🖼 “只有图没有字”也是合法消息：先看一眼有没有图，再进门
  const hasImage = Boolean(pickImage(event))
  const hasFile = Boolean(pickFile(event))
  const decision = decideDelivery({
    event,
    ownerId: config.ownerId,
    sessionId: config.sessionId,
    hint: config.hint,
    maxChars: config.maxChars,
    stickerFrequency: config.stickerFrequency,
    deduper,
    hasImage,
    hasFile,
  })
  if (!decision.deliver) {
    const line = `[direct] 不投递：${REASON_TEXT[decision.reason]}（msgId=${event.msgId || '空'} openid=${event.openid || '空'}）`
    log(line)
    return { delivered: false, reason: decision.reason }
  }
  if (typeof prompt !== 'function') {
    log('[direct] 会话服务还没就绪，这条先不投（不标已读）')
    return { delivered: false, reason: 'no-prompt' }
  }

  // 🖼 图在**过了门之后**才处理：不为陌生人的图花流量
  let images = []
  let imageError = ''
  let fileError = ''
  let note = ''
  if (typeof prepareImage === 'function') {
    try {
      const prepared = await prepareImage(event)
      if (prepared) {
        if (Array.isArray(prepared.images)) images = prepared.images.filter(Boolean)
        else if (prepared.image) images = [prepared.image]
        if (prepared.error) imageError = prepared.error
        if (prepared.note) note = prepared.note
      }
    } catch (error) {
      imageError = `处理图片时抛错：${String((error && error.message) || error)}`
    }
  }

  // 📎 文件也在**过了门之后**才处理
  if (typeof prepareFile === 'function') {
    try {
      const prepared = await prepareFile(event)
      if (prepared) {
        if (prepared.note) note = note ? `${note}；${prepared.note}` : prepared.note
        if (prepared.error) fileError = prepared.error
      }
    } catch (error) {
      fileError = `处理文件时抛错：${String((error && error.message) || error)}`
    }
  }

  const lines = [decision.text]
  if (extraNote) lines.push(`（${extraNote}）`)
  if (note) lines.push(`（${note}）`)
  if (imageError) lines.push(`（图没进来：${imageError}）`)
  if (fileError) lines.push(`（文件没进来：${fileError}）`)
  const content = [{ type: 'text', text: lines.join('\n') }]
  for (const item of images) content.push({ type: 'image', mediaType: item.mediaType, data: item.data })

  try {
    const result = await prompt({
      requestId: decision.requestId,
      sessionId: config.sessionId,
      mode: 'queue',
      content,
    })
    deduper.add(event.msgId)
    log(`[direct] 已投递 ${event.msgId} → ${config.sessionId}（accepted=${Boolean(result && result.accepted)}${images.length > 0 ? `，带图 ${images.length} 张` : ''}）`)
    return { delivered: true, requestId: decision.requestId }
  } catch (error) {
    const message = String((error && error.message) || error)
    log(`[direct] 投递失败 ${event.msgId}：${message}`)
    return { delivered: false, error: message }
  }
}
