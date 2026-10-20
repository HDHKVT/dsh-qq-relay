/**
 * 图片的收、存、清（阶段 2 · Task 7）。
 *
 * 边界刻意划得很窄：这里**不碰 GIF 解码、不碰会话投递**，只管
 *   ① 从事件里挑出那张图 → ② 下载（带体积/超时闸）→ ③ 按文件头认类型
 *   ④ 原子落盘 + 侧车 JSON → ⑤ 按天数清理 / 清空
 *
 * 三条硬规矩：
 * - **先看 Content-Length，再读 body**：不能让一张 50MB 的图先进内存再拒绝。
 * - **类型看文件头**：QQ 给的 `content_type` 与扩展名都会骗人。
 * - **落盘失败不算投递失败**：图该进会话还是进，只是要说明没存下来。
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** 默认上限 12 MB（与引擎 `MAX_IMAGE_BYTES` 对齐）；设置页可改 */
export const MAX_IMAGE_BYTES_DEFAULT = 12 * 1024 * 1024

const EXT_OF = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/**
 * 按文件头认类型（只认会话吃得下的四种）。
 * @param {Uint8Array|Buffer} bytes
 * @returns {'image/png'|'image/jpeg'|'image/gif'|'image/webp'|null}
 */
export function sniffMime(bytes) {
  if (!bytes || bytes.length < 12) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

/**
 * 把一条事件里所有“可能是图”的附件摊平：
 * `attachments[]` + `msg_elements[]`（元素自己带 `content`）+ **元素里嵌套的 `attachments[]`**。
 *
 * 最后那条是 2026-10-18 真机补的：有的图（尤其动图）不在顶层 `attachments`，
 * 而是塞在 `msgElements[i].attachments` 里，只认顶层就会“图丢了”。
 *
 * @param {{attachments?: Array<object>, msgElements?: Array<object>}} event
 * @returns {Array<{url: string, filename: string, contentType: string}>}
 */
export function imageCandidates(event) {
  const out = []
  const add = (item, url, from) => {
    if (!item || typeof item !== 'object') return
    if (typeof url !== 'string' || url === '') return
    const contentType = typeof item.content_type === 'string' ? item.content_type : ''
    if (!contentType.startsWith('image/')) return
    out.push({ url, filename: typeof item.filename === 'string' ? item.filename : '', contentType, from })
  }
  for (const item of Array.isArray(event && event.attachments) ? event.attachments : []) {
    add(item, item && typeof item.url === 'string' ? item.url : '', 'top')
  }
  for (const element of Array.isArray(event && event.msgElements) ? event.msgElements : []) {
    if (!element || typeof element !== 'object') continue
    add(element, typeof element.content === 'string' ? element.content : '', 'element')
    for (const nested of Array.isArray(element.attachments) ? element.attachments : []) {
      add(nested, nested && typeof nested.url === 'string' ? nested.url : '', 'nested')
    }
  }
  return out
}

/**
 * 引用信息（2026-10-18 真机样本）：
 * 被引用的那条以 `msgElements[]` 里的一个元素出现 —— `message_type: 103`、
 * `msg_idx` 以 `REFIDX_` 开头，`content` 是被引用消息的文字（可能只是一段表情标记），
 * 图则挂在它的 `attachments[]` 里。
 *
 * @param {{msgElements?: Array<object>}} event
 * @returns {{text: string, imageCount: number} | null}
 */
export function quoteInfo(event) {
  const elements = Array.isArray(event && event.msgElements) ? event.msgElements : []
  for (const element of elements) {
    if (!element || typeof element !== 'object') continue
    const idx = typeof element.msg_idx === 'string' ? element.msg_idx : ''
    const isReply = element.message_type === 103 || idx.startsWith('REFIDX_')
    if (!isReply) continue
    const images = (Array.isArray(element.attachments) ? element.attachments : [])
      .filter((item) => item && String(item.content_type || '').startsWith('image/')).length
    return { text: typeof element.content === 'string' ? element.content : '', imageCount: images }
  }
  return null
}

/**
 * 从一条事件里挑出第一张图。
 * @param {{attachments?: Array<object>, msgElements?: Array<object>}} event
 * @returns {{url: string, filename: string, contentType: string} | null}
 */
export function pickImage(event) {
  const list = imageCandidates(event)
  return list.length > 0 ? list[0] : null
}

/**
 * 多图模式：把一条消息里的图**全部**挑出来（默认最多 20 张，防手滑）。
 * 顺序与引擎一致：`attachments[]` 在前，`msg_elements[]` 在后。
 * @param {{attachments?: Array<object>, msgElements?: Array<object>}} event
 * @param {number} [limit]
 * @returns {Array<{url: string, filename: string, contentType: string}>}
 */
export function pickImages(event, limit = 20) {
  const out = []
  const seen = new Set()
  for (const item of imageCandidates(event)) {
    if (out.length >= limit) break
    if (seen.has(item.url)) continue
    seen.add(item.url)
    out.push(item)
  }
  return out
}

/**
 * 下载一张图。
 *
 * @param {string} url
 * @param {{fetchImpl?: Function, maxBytes?: number, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: true, bytes: Buffer, mime: string} | {ok: false, reason: 'network'|'timeout'|'too-large'|'unsupported', detail: string}>}
 */
export async function downloadImage(url, options = {}) {
  const { fetchImpl = globalThis.fetch, maxBytes = MAX_IMAGE_BYTES_DEFAULT, timeoutMs = 15_000 } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response || response.ok !== true) {
      return { ok: false, reason: 'network', detail: `HTTP ${response ? response.status : '(无响应)'}` }
    }
    const declared = Number((response.headers && response.headers.get && response.headers.get('content-length')) || 0)
    if (declared > maxBytes) {
      // 先按声明拒绝：body 一个字节都不读
      return { ok: false, reason: 'too-large', detail: `${declared} 字节 > ${maxBytes}` }
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxBytes) {
      return { ok: false, reason: 'too-large', detail: `${bytes.length} 字节 > ${maxBytes}` }
    }
    const mime = sniffMime(bytes)
    if (!mime) return { ok: false, reason: 'unsupported', detail: '文件头不是 png/jpeg/gif/webp' }
    return { ok: true, bytes, mime }
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return { ok: false, reason: 'timeout', detail: `超过 ${timeoutMs}ms` }
    }
    return { ok: false, reason: 'network', detail: String((error && error.message) || error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 图库根目录（`image.dir` 为空 ⇒ `<插件数据目录>\images`） */
export function imageDirOf(baseDir, config) {
  const custom = config && config.image && typeof config.image.dir === 'string' ? config.image.dir.trim() : ''
  return custom !== '' ? custom : join(baseDir, 'images')
}

export const incomingDirOf = (root) => join(root, 'incoming')
export const stickersDirOf = (root) => join(root, 'stickers')

/** `20261018-003512`：本地时间的紧凑戳 */
function stampOf(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 把 msgId 里不适合当文件名的字符去掉，取后 6 位 */
function tailOf(msgId) {
  const clean = String(msgId || '').replace(/[^A-Za-z0-9]/g, '')
  return (clean.slice(-6) || 'xxxxxx')
}

/**
 * 原子落盘 + 侧车 JSON。
 * @param {string} dir - `incoming\`
 * @param {{bytes: Buffer, mime: string, msgId: string, at?: number, seq?: number, tag?: string}} input
 * @returns {{ok: true, path: string} | {ok: false, why: string}}
 */
export function saveImage(dir, input) {
  try {
    const { bytes, mime, msgId, at = Date.now(), seq = 1, tag = '' } = input
    const ext = EXT_OF[mime]
    if (!ext) return { ok: false, why: `不认识的类型 ${mime}` }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const name = `${stampOf(new Date(at))}-${tailOf(msgId)}-${seq}${tag ? `-${tag}` : ''}.${ext}`
    const target = join(dir, name)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, bytes)
    renameSync(tmp, target)
    writeFileSync(`${target}.json`, JSON.stringify({
      messageId: msgId,
      at,
      mime,
      bytes: bytes.length,
      source: 'qq-direct',
    }, null, 2), 'utf8')
    return { ok: true, path: target }
  } catch (error) {
    return { ok: false, why: String((error && error.message) || error) }
  }
}

/**
 * 删掉 `incoming\` 里超过 `retentionDays` 的文件（含侧车）。
 * @param {string} dir
 * @param {number} retentionDays - `<= 0` 表示不清理（调用方本来也不该落盘）
 * @param {number} [now]
 * @returns {number} 删掉的**图片**个数
 */
export function pruneIncoming(dir, retentionDays, now = Date.now()) {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) return 0
  if (!existsSync(dir)) return 0
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  let removed = 0
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      if (statSync(file).mtimeMs >= cutoff) continue
      unlinkSync(file)
      if (!name.endsWith('.json')) removed += 1
    } catch { /* 单个文件删不掉不影响其它的 */ }
  }
  return removed
}

/**
 * 立刻清空 `incoming\`（设置页「清空」按钮）。
 * @param {string} dir
 * @returns {{removed: number, bytes: number}}
 */
export function clearIncoming(dir) {
  if (!existsSync(dir)) return { removed: 0, bytes: 0 }
  let removed = 0
  let bytes = 0
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      bytes += statSync(file).size
      unlinkSync(file)
      if (!name.endsWith('.json')) removed += 1
    } catch { /* 忽略单个失败 */ }
  }
  return { removed, bytes }
}
