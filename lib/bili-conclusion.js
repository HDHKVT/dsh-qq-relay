/**
 * 取 B 站官方「AI 总结」（2026-10-24）。
 *
 * 返回里有两样东西：
 *   summary —— 一段话摘要
 *   outline —— 若干节，每节下面还有带**时间戳**的要点
 * 那些时间点是 B 站自己标的「内容要点在哪」，比我们自己猜该抽哪一帧准得多。
 *
 * ⚠️ 这个接口会**偶发 -504「服务调用超时」**（实测第一次就撞上、重试一次就好）。
 *    -504 跟风控 -412 不是一回事：它是服务端忙，可以重试一次；
 *    -412 是风控，绝对不能重试。这里只对前者做一次重试。
 */

import { fetchWbiKeys, mixinKeyOf, encodeWbi } from './bilibili.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
/** 服务端忙的返回码：只对这些重试一次 */
const SERVER_BUSY_CODES = new Set([-504, -500, -503])

/**
 * @param {object} options
 * @param {string} options.bvid
 * @param {number} options.cid
 * @param {number} options.upMid   UP 主的 mid（接口要求）
 * @param {string} [options.cookie]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ok:true, data:object, retried:boolean} | {ok:false, why:string, apiCode?:number}>}
 */
export async function fetchVideoConclusion({ bvid, cid, upMid, cookie = '', fetchImpl = fetch }) {
  let query
  try {
    const orig = await fetchWbiKeys(fetchImpl)
    query = encodeWbi({ bvid, cid, up_mid: upMid }, mixinKeyOf(orig))
  } catch (error) {
    return { ok: false, why: `取 wbi 签名失败：${String((error && error.message) || error)}` }
  }

  const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/' }
  if (cookie) headers.cookie = cookie

  let retried = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let json
    try {
      const res = await fetchImpl(`https://api.bilibili.com/x/web-interface/view/conclusion/get?${query}`, { headers })
      json = await res.json()
    } catch (error) {
      return { ok: false, why: `请求总结失败：${String((error && error.message) || error)}` }
    }
    if (json && json.code === 0 && json.data) return { ok: true, data: json.data, retried }

    const apiCode = json && json.code
    // 服务端忙 → 等 1.5 秒重试一次；其余错误（含风控）直接放弃
    if (SERVER_BUSY_CODES.has(apiCode) && attempt === 0) {
      retried = true
      await new Promise((resolve) => setTimeout(resolve, 1500))
      continue
    }
    return {
      ok: false,
      apiCode: Number.isFinite(apiCode) ? apiCode : undefined,
      why: `${(json && json.message) || '响应异常'}（${apiCode}）`,
    }
  }
  return { ok: false, why: '重试后仍然失败' }
}
