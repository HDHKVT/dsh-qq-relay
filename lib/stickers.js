/**
 * 表情包仓库（阶段 5，2026-10-18）。
 *
 * 约定：**引用一张图 + 说暗号**（默认“存表情包”）⇒ 把那张图/动图原样存进
 * `images\stickers\`，名字由黛丝自己起（先用临时名，之后可改名）。
 * 目录里放一份 `index.json`（名字 → 文件/类型/大小/时间），方便列和发。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sniffMime } from './vision.js'

const EXT_OF = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/**
 * 暗号消息从哪儿取图：引用里的（`byQuote`）优先，其次是本条自带的附件（`byAttach`）。
 * 两条路可以同时开着；都不给图就返回 null。
 *
 * @param {{attachments?: Array<object>, msgElements?: Array<object>}} event
 * @param {{byQuote?: boolean, byAttach?: boolean}} [options]
 * @returns {{url: string, kind: 'quote'|'attach'} | null}
 */
export function pickStickerSource(event, options = {}) {
  const { byQuote = true, byAttach = true } = options
  const elements = Array.isArray(event && event.msgElements) ? event.msgElements : []
  if (byQuote) {
    const replyEl = elements.find((el) => el && (el.message_type === 103 || String(el.msg_idx || '').startsWith('REFIDX_')))
    const images = replyEl && Array.isArray(replyEl.attachments) ? replyEl.attachments : []
    const hit = images.find((it) => it && typeof it.url === 'string' && it.url !== '' && String(it.content_type || '').startsWith('image/'))
    if (hit) return { url: hit.url, kind: 'quote' }
  }
  if (byAttach) {
    const own = (Array.isArray(event && event.attachments) ? event.attachments : [])
      .find((it) => it && typeof it.url === 'string' && it.url !== '' && String(it.content_type || '').startsWith('image/'))
    if (own) return { url: own.url, kind: 'attach' }
  }
  return null
}

/** 表情包目录（`sticker.dir` 为空 ⇒ `<插件数据目录>\images\stickers`） */
export function stickerDirOf(baseDir, config) {
  const custom = config && config.sticker && typeof config.sticker.dir === 'string' ? config.sticker.dir.trim() : ''
  return custom !== '' ? custom : join(baseDir, 'images', 'stickers')
}

/** 名字清洗：只留中文、字母、数字、下划线和短横，限 24 字 */
export function cleanStickerName(name) {
  const raw = String(name || '')
    .replace(/[\\/:*?"<>|.\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
  return raw === '' ? `表情_${Date.now().toString(36)}` : raw
}

function indexPath(dir) {
  return join(dir, 'index.json')
}

/** 读索引（坏文件当空表，不抛） */
export function loadIndex(dir) {
  try {
    const raw = JSON.parse(readFileSync(indexPath(dir), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/** 原子写索引 */
export function saveIndex(dir, index) {
  mkdirSync(dir, { recursive: true })
  const target = indexPath(dir)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8')
  renameSync(tmp, target)
}

/**
 * 存一张表情包。重名会自动加序号，绝不覆盖。
 * @param {string} dir
 * @param {{bytes: Buffer, name: string, sourceMsgId?: string, at?: number}} input
 * @returns {{ok: true, name: string, path: string} | {ok: false, why: string}}
 */
export function addSticker(dir, input) {
  try {
    const mime = sniffMime(input.bytes)
    if (!mime) return { ok: false, why: '不是认识的图片格式（png/jpeg/gif/webp）' }
    const ext = EXT_OF[mime]
    mkdirSync(dir, { recursive: true })
    const index = loadIndex(dir)
    const base = cleanStickerName(input.name)
    let name = base
    for (let n = 2; existsSync(join(dir, `${name}.${ext}`)) || name in index; n += 1) name = `${base}_${n}`
    const path = join(dir, `${name}.${ext}`)
    writeFileSync(path, input.bytes)
    index[name] = {
      file: `${name}.${ext}`,
      mime,
      bytes: input.bytes.length,
      at: input.at || Date.now(),
      source: input.sourceMsgId || '',
    }
    saveIndex(dir, index)
    return { ok: true, name, path }
  } catch (error) {
    return { ok: false, why: String((error && error.message) || error) }
  }
}

/**
 * 改名（同时改文件与索引）。
 * @param {string} dir
 * @param {string} oldName
 * @param {string} newName
 * @returns {{ok: true, name: string, path: string} | {ok: false, why: string}}
 */
export function renameSticker(dir, oldName, newName) {
  try {
    const index = loadIndex(dir)
    const entry = index[oldName]
    if (!entry) return { ok: false, why: `没有这条表情：${oldName}` }
    const next = cleanStickerName(newName)
    if (next === oldName) return { ok: true, name: oldName, path: join(dir, entry.file) }
    if (index[next] || existsSync(join(dir, `${next}.${entry.file.split('.').pop()}`))) {
      return { ok: false, why: `名字已被占用：${next}` }
    }
    const ext = entry.file.split('.').pop()
    const from = join(dir, entry.file)
    const to = join(dir, `${next}.${ext}`)
    renameSync(from, to)
    delete index[oldName]
    index[next] = { ...entry, file: `${next}.${ext}` }
    saveIndex(dir, index)
    return { ok: true, name: next, path: to }
  } catch (error) {
    return { ok: false, why: String((error && error.message) || error) }
  }
}

/** 删除一条表情（同时删文件与索引） */
export function removeSticker(dir, name) {
  const index = loadIndex(dir)
  const entry = index[name]
  if (!entry) return { ok: false, why: `没有这条表情：${name}` }
  try { unlinkSync(join(dir, entry.file)) } catch { /* 文件可能已不在 */ }
  delete index[name]
  saveIndex(dir, index)
  return { ok: true, name }
}

/** 列出来（按加入时间倒序） */
export function listStickers(dir) {
  const index = loadIndex(dir)
  return Object.entries(index)
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => (b.at || 0) - (a.at || 0))
}

/** 找一条表情的绝对路径 */
export function stickerPath(dir, name) {
  const entry = loadIndex(dir)[name]
  if (!entry) return null
  const path = join(dir, entry.file)
  return existsSync(path) ? path : null
}

/** 目录里有哪些图片文件（索引丢了也能兜底列出来） */
export function looseStickerFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /\.(png|jpe?g|gif|webp)$/i.test(name))
    .map((name) => {
      const path = join(dir, name)
      let size = 0
      try { size = statSync(path).size } catch { /* 忽略 */ }
      return { file: name, bytes: size }
    })
}
