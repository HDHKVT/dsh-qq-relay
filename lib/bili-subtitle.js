/**
 * B 站字幕取用（2026-10-24）。
 *
 * 分工：
 *   本文件负责「拿」——用登录态问 B 站要字幕地址、下载 JSON；
 *   「怎么把 JSON 变成文字」交给 `subtitle-to-text.js`（纯函数）。
 *
 * 为什么要登录态：
 *   实测匿名请求 `/x/player/wbi/v2` 会返回 code 0 但 subtitles 为空数组
 *   （10 条热门视频全空），带了 SESSDATA 才有字幕轨。cookie 从
 *   独立的 `credential.json` 来（2026-10-25 从 relay.json 搬出），过期要重新扫码。
 *
 * ⚠️ 失败必须分类，不能一句「没拿到」了事：
 *   风控拦截（-412 等）和「这条视频真没字幕」是完全不同的结论。混在一起，
 *   上层会把每一条都当成「无字幕」跳过，报告看着正常、实际什么都没看。
 *   所以这里返回 `code`，让调用方据此决定说什么话。
 *
 * 边界：
 *   - 只用标准库，不新增依赖。
 *   - 不自动重试：同一个请求失败就停，重试只会让风控更确信这是机器。
 *   - 日志里不许出现带签名的字幕地址（那是临时凭据）。
 */

import { fetchWbiKeys, mixinKeyOf, encodeWbi } from './bilibili.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** B 站的风控/限流返回码：出现这些就别再试了，等一段时间自然恢复。 */
const RISK_CODES = new Set([-412, -352, -403, -799])

/** 挑一条字幕轨：优先中文，其次第一条。B 站会给 `ai-zh`（AI 生成）和 `zh-CN`（人工）。 */
function pickTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null
  const chinese = tracks.find((track) => String(track.lan || '').toLowerCase().startsWith('zh'))
  const aiChinese = tracks.find((track) => String(track.lan || '').toLowerCase().includes('zh'))
  return chinese || aiChinese || tracks[0]
}

/** `//host/x.json` → `https://host/x.json` */
function absoluteUrl(url) {
  const text = String(url || '')
  return text.startsWith('//') ? `https:${text}` : text
}

/**
 * 取一条视频的字幕 JSON。
 *
 * 失败时 `code` 的取值：
 *   'no-cookie' —— 没配置登录态，根本没资格要字幕
 *   'blocked'   —— B 站风控/限流挡回来了（带 apiCode）
 *   'no-track'  —— 请求成功，但这条视频确实没有字幕轨
 *   'network'   —— 网络层失败
 *   'bad-shape' —— 拿到的东西结构不认识
 *
 * @param {object} options
 * @param {number} options.aid
 * @param {number} options.cid
 * @param {string} options.cookie    SESSDATA 等登录 cookie（可为空，空则基本拿不到）
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ok:true, payload:object, lan:string, lanDoc:string, url:string}
 *   | {ok:false, code:string, apiCode?:number, why:string}>}
 */
export async function fetchSubtitle({ aid, cid, cookie = '', fetchImpl = fetch }) {
  if (!cookie) {
    return { ok: false, code: 'no-cookie', why: '还没有登录 B 站（设置页 → 登录 → B 站登录），匿名拿不到字幕' }
  }

  let query
  try {
    const orig = await fetchWbiKeys(fetchImpl)
    query = encodeWbi({ aid, cid }, mixinKeyOf(orig))
  } catch (error) {
    return { ok: false, code: 'network', why: `取 wbi 签名失败：${String((error && error.message) || error)}` }
  }

  const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie }
  let listJson
  try {
    const res = await fetchImpl(`https://api.bilibili.com/x/player/wbi/v2?${query}`, { headers })
    listJson = await res.json()
  } catch (error) {
    return { ok: false, code: 'network', why: `请求字幕列表失败：${String((error && error.message) || error)}` }
  }
  if (!listJson || typeof listJson.code !== 'number') {
    return { ok: false, code: 'bad-shape', why: '字幕列表返回的结构不认识（没有 code 字段）' }
  }
  if (listJson.code !== 0) {
    const apiCode = listJson.code
    const blocked = RISK_CODES.has(apiCode)
    return {
      ok: false,
      code: blocked ? 'blocked' : 'bad-shape',
      apiCode,
      why: `${blocked ? '被风控/限流拦截' : '接口报错'}：${listJson.message || '无消息'}（${apiCode}）`,
    }
  }

  const tracks = listJson.data && listJson.data.subtitle && listJson.data.subtitle.subtitles
  const track = pickTrack(tracks)
  if (!track || !track.subtitle_url) {
    return { ok: false, code: 'no-track', why: '这条视频没有字幕轨（请求成功，确实没有）' }
  }

  const url = absoluteUrl(track.subtitle_url)
  let payload
  try {
    const res = await fetchImpl(url, { headers })
    payload = await res.json()
  } catch (error) {
    return { ok: false, code: 'network', why: `下载字幕失败：${String((error && error.message) || error)}` }
  }
  if (!payload || !Array.isArray(payload.body)) {
    return { ok: false, code: 'bad-shape', why: '字幕文件结构不认识（没有 body 数组）' }
  }

  return {
    ok: true,
    payload,
    lan: String(track.lan || ''),
    lanDoc: String(track.lan_doc || ''),
    url,
  }
}
