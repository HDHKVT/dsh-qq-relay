/**
 * B 站链接解析与下载（2026-10-20）。
 *
 * 只用公开接口，不需要登录：
 *   nav  → 两张公开图的文件名 → mixinKey（wbi 签名）
 *   view → 标题 / cid / 分 P
 *   playurl（fnval=1）→ durl 单文件 mp4（含音轨），**不需要 ffmpeg 合并**
 *
 * 720P 免登录即得；1080P 需要 SESSDATA，而且常切 DASH，本模块不处理 DASH。
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, unlinkSync, renameSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'


const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

const API_HEADERS = { 'user-agent': UA, referer: 'https://www.bilibili.com/' }

/** 只取主机名（日志里不能出现带签名的完整 URL）。 */
export function hostnameOf(url) {
  try { return new URL(url).host } catch { return '(非法 URL)' }
}

/** 从 nav 拿两张图的文件名，拼成 64 字符 orig。 */
export async function fetchWbiKeys(fetchImpl = fetch) {
  const res = await fetchImpl('https://api.bilibili.com/x/web-interface/nav', { headers: { 'user-agent': UA } })
  const json = await res.json()
  // 未登录会返回 -101，但 wbi_img 仍然给，够用
  if (!json || !json.data || !json.data.wbi_img) {
    throw new Error(`取 wbi 密钥失败：${(json && json.message) || '响应异常'}`)
  }
  const imgKey = String(json.data.wbi_img.img_url).split('/').pop().split('.')[0]
  const subKey = String(json.data.wbi_img.sub_url).split('/').pop().split('.')[0]
  return imgKey + subKey
}

/** 按标准表重排 orig，取前 32 位。 */
export function mixinKeyOf(orig) {
  return MIXIN_TAB.map((n) => orig[n]).join('').slice(0, 32)
}

/** 生成 `k=v&…&wts=…&w_rid=…`（值需要过滤 !'()* 再编码）。 */
export function encodeWbi(params, mixinKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const withTime = { ...params, wts: nowSeconds }
  const query = Object.keys(withTime)
    .sort()
    .map((key) => {
      const value = String(withTime[key]).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')
  const wRid = createHash('md5').update(query + mixinKey).digest('hex')
  return `${query}&w_rid=${wRid}`
}

/**
 * 从分享文案/链接里抠出 BV 号与分 P。
 * 支持：BV 号裸串、www.bilibili.com/video/BV…、b23.tv 短链、带文字分享。
 * @param {string} text
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{bvid: string, page: number}>}
 */
export async function resolveShare(text, fetchImpl = fetch) {
  const raw = String(text || '')
  const direct = raw.match(/BV[0-9A-Za-z]{10}/)
  const pageMatch = raw.match(/[?&]p=(\d+)/)
  const page = pageMatch ? Number(pageMatch[1]) : 1
  if (direct) return { bvid: direct[0], page }
  const directAv = raw.match(/\/video\/av(\d+)/)
  if (directAv) return { bvid: await bvidOfAid(directAv[1], fetchImpl), page }

  const shortMatch = raw.match(/https?:\/\/(?:b23\.tv|bili2233\.cn)\/[A-Za-z0-9]+/)
  if (!shortMatch) throw new Error('没找到 B 站链接或 BV 号')
  const shortUrl = shortMatch[0]

  // HEAD 可能被 CDN 拒：先 HEAD（不跟随），失败再 GET（不跟随）
  let location = ''
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetchImpl(shortUrl, { method, redirect: 'manual', headers: { 'user-agent': UA } })
      location = res.headers.get('location') || ''
      if (location !== '') break
    } catch { /* 换下一个方法 */ }
  }
  if (location === '') throw new Error('短链没有跳转地址（可能已失效）')

  const p = location.match(/[?&]p=(\d+)/)
  const bv = location.match(/BV[0-9A-Za-z]{10}/)
  if (bv) return { bvid: bv[0], page: p ? Number(p[1]) : 1 }
  const av = location.match(/\/video\/av(\d+)/)
  if (av) return { bvid: await bvidOfAid(av[1], fetchImpl), page: p ? Number(p[1]) : 1 }
  throw new Error(`短链跳到了一个认不出的地址：${hostnameOf(location)}`)
}

/** av 号 → bvid（老链接、短链常见）。 */
async function bvidOfAid(aid, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.bilibili.com/x/web-interface/view?aid=${encodeURIComponent(aid)}`, {
    headers: { 'user-agent': UA },
  })
  const json = await res.json()
  if (!json || json.code !== 0 || !json.data || !json.data.bvid) {
    throw new Error(`av${aid} 转 BV 失败：${(json && json.message) || '响应异常'}`)
  }
  return json.data.bvid
}

/** 稿件元信息。 */
export async function fetchMeta(bvid, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
    headers: { 'user-agent': UA },
  })
  const json = await res.json()
  if (!json || json.code !== 0 || !json.data) {
    throw new Error(`取视频信息失败：${(json && json.message) || '响应异常'}（${json && json.code}）`)
  }
  return {
    bvid,
    title: String(json.data.title || bvid),
    cid: json.data.cid,
    duration: Number(json.data.duration || 0),
    tid: Number(json.data.tid || 0),
    tname: String(json.data.tname || ''),
    pages: Array.isArray(json.data.pages)
      ? json.data.pages.map((p) => ({ page: p.page, cid: p.cid, part: p.part }))
      : [],
  }
}

/** 取 durl 单文件地址（fnval=1 ⇒ 不分片、不用合并）。 */
export async function fetchPlayUrl(bvid, cid, { qn = 64, cookie = '', audioOnly = false, fetchImpl = fetch } = {}) {
  const orig = await fetchWbiKeys(fetchImpl)
  const mixinKey = mixinKeyOf(orig)
  const query = encodeWbi({ bvid, cid, fnval: audioOnly ? 16 : 1, fnver: 0, fourk: 1, qn }, mixinKey)
  const headers = { ...API_HEADERS }
  if (cookie) headers.cookie = cookie

  const res = await fetchImpl(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, { headers })
  const json = await res.json()
  if (!json || json.code !== 0) {
    throw new Error(`取下载地址失败：${(json && json.message) || '响应异常'}（${json && json.code}）`)
  }
  if (audioOnly) {
    const audio = json.data && json.data.dash && json.data.dash.audio
    if (!Array.isArray(audio) || audio.length === 0) throw new Error('DASH_AUDIO_MISSING')
    const best = [...audio].sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0]
    return { url: best.baseUrl, size: -1, quality: Number(best.id || 0), backups: [], isAudio: true }
  }
  const durl = json.data && json.data.durl
  if (!Array.isArray(durl) || durl.length === 0) throw new Error('接口没给 durl 地址')
  return {
    url: durl[0].url,
    size: Number(durl[0].size || 0),
    quality: Number(json.data.quality || qn),
    backups: Array.isArray(durl[0].backup_url) ? durl[0].backup_url : [],
    isAudio: false,
  }
}

/**
 * 流式下载到 destPath，边下边限大小；失败清掉 .part。
 * @returns {Promise<{ok: true, bytes: number} | {ok: false, why: string}>}
 */
export async function downloadVideo(url, destPath, { maxBytes, fetchImpl = fetch, log = () => {} } = {}) {
  const partPath = `${destPath}.part`
  try {
    const res = await fetchImpl(url, { headers: { ...API_HEADERS } })
    if (!res.ok) return { ok: false, why: `下载请求失败：HTTP ${res.status}` }
    const declared = Number(res.headers.get('content-length') || 0)
    if (maxBytes && declared > maxBytes) {
      return { ok: false, why: `文件 ${(declared / 1024 / 1024).toFixed(1)}MB，超过上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB` }
    }
    if (!res.body) return { ok: false, why: '响应没有 body' }

    let bytes = 0
    const counter = new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength
        if (maxBytes && bytes > maxBytes) {
          controller.error(new Error(`下载超过上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB`))
          return
        }
        controller.enqueue(chunk)
      },
    })
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(partPath))
    renameSync(partPath, destPath)
    return { ok: true, bytes }
  } catch (error) {
    try { if (existsSync(partPath)) unlinkSync(partPath) } catch { /* 忽略 */ }
    return { ok: false, why: `下载中断：${String((error && error.message) || error)}` }
  }
}

/** 文件名安全化（Windows 非法字符 + 长度）。 */
export function safeFileName(title, bvid, page = 0, ext = '.mp4') {
  const cleaned = String(title).replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'video'
  const pagePart = page > 1 ? `-P${page}` : ''
  return `bili-${bvid}${pagePart}-${cleaned}${ext}`
}

/** 把一段文字里的 B 站链接找出来（给消息提示用）。 */
export function findBiliLink(text) {
  const raw = String(text || '')
  if (/BV[0-9A-Za-z]{10}/.test(raw)) return raw.match(/BV[0-9A-Za-z]{10}/)[0]
  const short = raw.match(/https?:\/\/(?:b23\.tv|bili2233\.cn)\/[A-Za-z0-9]+/)
  return short ? short[0] : ''
}

/**
 * 一路做完：解析 → 元信息 → 取地址 → 下载。
 * @returns {Promise<{ok: true, path: string, title: string, duration: number, bytes: number}
 *   | {ok: false, why: string}>}
 */
export async function downloadBili(text, outDir, options = {}) {
  const { maxMb = 2048, cookie = '', audioOnly = 'auto', fetchImpl = fetch, log = () => {} } = options
  try {
    const { bvid, page } = await resolveShare(text, fetchImpl)
    const meta = await fetchMeta(bvid, fetchImpl)
    let cid = meta.cid
    let pageNo = 1
    if (meta.pages.length > 1) {
      const target = meta.pages.find((p) => p.page === page) || meta.pages[0]
      cid = target.cid
      pageNo = target.page
    }

    let isAudio = decideAudioOnly(meta, audioOnly)
    let play
    let notice = ''
    try {
      play = await fetchPlayUrl(bvid, cid, { cookie, audioOnly: isAudio, fetchImpl })
    } catch (error) {
      const message = String((error && error.message) || error)
      if (isAudio && message === 'DASH_AUDIO_MISSING') {
        log(`[bili] 没有独立音轨，回退下载视频`)
        isAudio = false
        play = await fetchPlayUrl(bvid, cid, { cookie, audioOnly: false, fetchImpl })
        notice = '（没有独立音轨，已自动回退为下载视频）'
      } else {
        throw error
      }
    }

    const ext = isAudio ? '.m4a' : '.mp4'
    const name = safeFileName(meta.title, bvid, pageNo, ext)
    const dest = `${outDir}\\${name}`
    log(`[bili] ${bvid} 《${meta.title}》 ${meta.duration}s，${isAudio ? '音频' : '视频'}/${play.quality}，CDN ${hostnameOf(play.url)}`)
    const got = await downloadVideo(play.url, dest, { maxBytes: maxMb * 1024 * 1024, fetchImpl, log })
    if (!got.ok) return got
    return {
      ok: true,
      path: dest,
      title: meta.title,
      duration: meta.duration,
      bytes: got.bytes,
      mediaType: isAudio ? 'audio' : 'video',
      notice,
    }
  } catch (error) {
    return { ok: false, why: String((error && error.message) || error) }
  }
}

/** 音频白名单分区 + 标题关键词；拿不准就下视频。 */
const AUDIO_TIDS = new Set([3, 130, 28, 31, 193, 194])
const AUDIO_KEYWORDS = /电台|播客|podcast|有声|纯享|全曲|ost/i
const VIDEO_EXCLUDE = /纪录片|教程|演示|历史|知识|科技|测评/i

export function decideAudioOnly(meta, setting = 'auto') {
  if (setting === true || setting === 'true') return true
  if (setting === false || setting === 'false') return false
  const title = String(meta.title || '')
  if (VIDEO_EXCLUDE.test(title)) return false
  if (AUDIO_TIDS.has(Number(meta.tid || 0))) return true
  return AUDIO_KEYWORDS.test(title)
}
