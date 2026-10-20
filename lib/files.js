/**
 * 非图片文件：挑出来 → 下载（带体积/超时闸）→ 落盘 `files\` → 按天清（阶段 3，2026-10-18）。
 *
 * 为什么单独一层：图有“像素要进会话”的问题（要 base64、要拼动图），文件没有；
 * 文件只需要**存下来 + 告诉会话它在哪**，剩下交给会用文件工具的自己去读。
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** 默认上限 20 MB；设置页可改 */
export const MAX_FILE_BYTES_DEFAULT = 20 * 1024 * 1024

/**
 * 从一条事件里挑出第一个**非图片**附件。
 * 图片走 `vision.js` 那条路；这里只收“文件”。
 * @param {{attachments?: Array<object>, msgElements?: Array<object>}} event
 * @returns {{url: string, filename: string, contentType: string} | null}
 */
export function pickFile(event) {
  const list = [
    ...(Array.isArray(event && event.attachments) ? event.attachments : []),
    ...(Array.isArray(event && event.msgElements) ? event.msgElements : []),
  ]
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    // 只认**真的带下载地址**的附件：`url` 字段、http(s) 协议、类型是 file*
    // （2026-10-18 真机：表情元素 content 里是一段 <faceType=…>，曾被当成“文件 URL”去下载）
    const raw = typeof item.url === 'string' && item.url !== '' ? item.url : ''
    if (!raw || !/^https?:\/\//i.test(raw)) continue
    const contentType = typeof item.content_type === 'string' ? item.content_type : ''
    if (contentType.startsWith('image/')) continue // 图片不归这里管
    if (contentType !== '' && !contentType.startsWith('file')) continue
    return { url: raw, filename: typeof item.filename === 'string' ? item.filename : '', contentType }
  }
  return null
}

/**
 * 下载一个文件（不嗅类型 —— 文件就是文件）。
 * @param {string} url
 * @param {{fetchImpl?: Function, maxBytes?: number, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: true, bytes: Buffer} | {ok: false, reason: 'network'|'timeout'|'too-large', detail: string}>}
 */
export async function downloadFile(url, options = {}) {
  const { fetchImpl = globalThis.fetch, maxBytes = MAX_FILE_BYTES_DEFAULT, timeoutMs = 30_000 } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response || response.ok !== true) {
      return { ok: false, reason: 'network', detail: `HTTP ${response ? response.status : '(无响应)'}` }
    }
    const declared = Number((response.headers && response.headers.get && response.headers.get('content-length')) || 0)
    if (declared > maxBytes) return { ok: false, reason: 'too-large', detail: `${declared} 字节` }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxBytes) return { ok: false, reason: 'too-large', detail: `${bytes.length} 字节` }
    return { ok: true, bytes }
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return { ok: false, reason: 'timeout', detail: `超过 ${timeoutMs}ms` }
    }
    return { ok: false, reason: 'network', detail: String((error && error.message) || error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 去掉路径分隔符与 Windows 非法字符，留个能看懂的名字 */
export function sanitizeName(name) {
  const raw = String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\.\.+/g, '.').trim()
  return raw === '' ? 'file.bin' : raw.slice(0, 80)
}

function stampOf(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 原子落盘 + 侧车 JSON。
 * @param {string} dir - `files\`
 * @param {{bytes: Buffer, filename: string, msgId: string, at?: number}} input
 * @returns {{ok: true, path: string, name: string} | {ok: false, why: string}}
 */
export function saveFile(dir, input) {
  try {
    const { bytes, filename, msgId, at = Date.now() } = input
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const safe = sanitizeName(filename)
    const tail = String(msgId || '').replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'xxxxxx'
    const name = `${stampOf(new Date(at))}-${tail}-${safe}`
    const target = join(dir, name)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, bytes)
    renameSync(tmp, target)
    writeFileSync(`${target}.json`, JSON.stringify({
      messageId: msgId,
      at,
      bytes: bytes.length,
      name: safe,
      source: 'qq-direct',
    }, null, 2), 'utf8')
    return { ok: true, path: target, name }
  } catch (error) {
    return { ok: false, why: String((error && error.message) || error) }
  }
}

/** 删除超期文件（含侧车）；`days <= 0` 不清理 */
export function pruneFiles(dir, retentionDays, now = Date.now()) {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) return 0
  if (!existsSync(dir)) return 0
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  let removed = 0
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile() || statSync(file).mtimeMs >= cutoff) continue
      unlinkSync(file)
      if (!name.endsWith('.json')) removed += 1
    } catch { /* 单个失败不影响其它 */ }
  }
  return removed
}

/** 立刻清空 */
export function clearFiles(dir) {
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
    } catch { /* 忽略 */ }
  }
  return { removed, bytes }
}

/** 文件目录（`file.dir` 为空 ⇒ `<插件数据目录>\files`） */
export function filesDirOf(baseDir, config) {
  const custom = config && config.file && typeof config.file.dir === 'string' ? config.file.dir.trim() : ''
  return custom !== '' ? custom : join(baseDir, 'files')
}

/** B 站下载目录（`video.biliDir` 为空 ⇒ `<插件数据目录>\bili`） */
export function biliDirOf(baseDir, config) {
  const custom = config && config.video && typeof config.video.biliDir === 'string' ? config.video.biliDir.trim() : ''
  return custom !== '' ? custom : join(baseDir, 'bili')
}
