/**
 * B 站「故事板」（进度条缩略图的雪碧图）取用：稿件信息 + 故事板元数据 + 拼图下载。
 *
 * 分工：
 *   本文件只管**联网和落盘**——问 B 站要数据、把拼图下载到本地。
 *   「该从哪一格裁、裁多少像素」由 `plan-storyboard-frames.js`（纯函数）算，
 *   本文件不掺和抽样策略。
 *
 * 边界：
 *   - 只用公开接口，匿名可拿；字幕接口要登录态，不在这里做。
 *   - 不解析图片、不裁图（那是 `video/storyboard_crop.py` 的事）。
 *   - 失败一律 throw，由调用方决定怎么降级。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const HEADERS = { 'user-agent': UA, referer: 'https://www.bilibili.com/' }
/** 单张拼图的体积上限：正常都是几百 KB，超过这个数说明请求被劫持或者拿错了东西 */
const MAX_SPRITE_BYTES = 20 * 1024 * 1024

/** `//host/x.jpg` → `https://host/x.jpg`；已经是 http(s) 的原样返回。 */
function absoluteUrl(url) {
  const text = String(url || '')
  if (text.startsWith('//')) return `https:${text}`
  return text
}

/**
 * 稿件信息：标题、UP 主、简介、时长、aid/cid。
 * 比 `bilibili.js` 的 `fetchMeta` 多要了 owner 和 desc——观看包要拿去组装文本。
 *
 * @param {string} bvid
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{bvid:string, aid:number, cid:number, title:string, uploader:string,
 *   description:string, duration:number, url:string}>}
 */
export async function fetchVideoBrief(bvid, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
    headers: HEADERS,
  })
  const json = await res.json()
  if (!json || json.code !== 0 || !json.data) {
    throw new Error(`取稿件信息失败：${(json && json.message) || '响应异常'}（${json && json.code}）`)
  }
  const data = json.data
  return {
    bvid: String(data.bvid || bvid),
    aid: Number(data.aid || 0),
    cid: Number(data.cid || 0),
    title: String(data.title || bvid),
    uploader: String((data.owner && data.owner.name) || ''),
    upMid: Number((data.owner && data.owner.mid) || 0),
    description: String(data.desc || ''),
    duration: Number(data.duration || 0),
    url: `https://www.bilibili.com/video/${String(data.bvid || bvid)}`,
  }
}

/**
 * 故事板元数据。字段含义（实测）：
 *   img_x_len / img_y_len  —— 每张拼图的横/纵格数
 *   img_x_size / img_y_size —— 单格宽高（常见 480×270）
 *   image[]                —— 拼图地址，按顺序
 *   index[]                —— 每格对应的时间（秒）；**首项是占位符**，真实值从下标 1 起
 *
 * @param {number} aid
 * @param {number} cid
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{columns:number, rows:number, cellWidth:number, cellHeight:number,
 *   imageUrls:string[], cellTimes:number[], sheets:number}>}
 */
export async function fetchStoryboardMeta(aid, cid, fetchImpl = fetch) {
  const res = await fetchImpl(
    `https://api.bilibili.com/x/player/videoshot?aid=${encodeURIComponent(aid)}&cid=${encodeURIComponent(cid)}&index=1`,
    { headers: HEADERS },
  )
  const json = await res.json()
  if (!json || json.code !== 0 || !json.data) {
    throw new Error(`取故事板失败：${(json && json.message) || '响应异常'}（${json && json.code}）`)
  }
  const data = json.data
  const images = Array.isArray(data.image) ? data.image.map(absoluteUrl).filter((url) => url !== '') : []
  if (images.length === 0) throw new Error('这个故事板没有图片地址（可能是很新的视频还没生成）')

  const columns = Number(data.img_x_len || 0)
  const rows = Number(data.img_y_len || 0)
  const cellWidth = Number(data.img_x_size || 0)
  const cellHeight = Number(data.img_y_size || 0)
  if (!(columns > 0 && rows > 0 && cellWidth > 0 && cellHeight > 0)) {
    throw new Error(`故事板几何信息不完整（${columns}×${rows} 格，单格 ${cellWidth}×${cellHeight}）`)
  }

  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    imageUrls: images,
    cellTimes: Array.isArray(data.index) ? data.index.map((value) => Number(value)).filter((n) => Number.isFinite(n)) : [],
    sheets: images.length,
  }
}

/**
 * 下载一张拼图到本地。
 * @param {string} url
 * @param {string} destPath
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{path:string, bytes:number}>}
 */
export async function downloadSprite(url, destPath, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`拼图下载失败：HTTP ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length === 0) throw new Error('拼图下载回来是空的')
  if (buffer.length > MAX_SPRITE_BYTES) {
    throw new Error(`拼图异常大（${Math.round(buffer.length / 1024 / 1024)}MB），放弃`)
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(destPath, buffer)
  return { path: destPath, bytes: buffer.length }
}
