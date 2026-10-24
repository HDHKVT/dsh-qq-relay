/**
 * bili-login.js —— 扫码登录里不联网的那一半(纯函数,四个导出)
 *
 * 登录整条链:要二维码(网络)→ 轮询状态(网络)→ 拿 cookie → 存盘 → 定期体检。
 * 本模块只做「解释返回、抠 cookie、拼请求头、判新鲜度」;两次网络请求由黛丝侧实现。
 *
 * ⚠️ 全文件的铁律:cookie 的值一律原样保留,百分号编码(%2C 这类)绝不解码——
 *    URLSearchParams 和 decodeURIComponent 都会解码,所以查询串必须手工切。
 */

/** 契约规定的「认识的 cookie」:抠登录凭证时收这五个(注意 sid 在列、buvid3 不在) */
const EXTRACTABLE_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']
/** 拼请求头时用这五个、按此固定顺序(buvid3 在列、sid 不在:发请求用不上 sid) */
const HEADER_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3']

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function interpretQrPoll(payload) {
  const failure = (reason) => ({ ok: false, reason })

  if (!isPlainObject(payload) || !Number.isFinite(payload.code)) {
    return failure('payload 结构不认识:不是对象,或外层 code 不是数字')
  }
  if (payload.code !== 0) return failure(`外层 code 是 ${payload.code},不是 0`)
  if (!isPlainObject(payload.data)) return failure('外层 code 为 0,但 data 不是对象')

  // 🔴 这个接口的真坑:外层 code 永远是 0,真正状态在内层 data.code。
  //    只看外层会一直以为成功、空转轮询到超时——契约按内层判断。
  const innerCode = payload.data.code
  const rawStateCode = Number.isFinite(innerCode) ? innerCode : null
  if (innerCode === 86101) return { ok: true, state: 'pending', redirectUrl: '', rawStateCode, reason: '' }
  if (innerCode === 86090) return { ok: true, state: 'scanned', redirectUrl: '', rawStateCode, reason: '' }
  if (innerCode === 0) {
    return {
      ok: true,
      state: 'confirmed',
      redirectUrl: typeof payload.data.url === 'string' ? payload.data.url : '',
      rawStateCode,
      reason: '',
    }
  }
  if (innerCode === 86038) return { ok: true, state: 'expired', redirectUrl: '', rawStateCode, reason: '' }
  return { ok: true, state: 'error', redirectUrl: '', rawStateCode, reason: `内层状态码 ${String(innerCode)} 不在已知列表里` }
}

/** Set-Cookie 一条只认第一个 name=value,后面的 Path/Expires/HttpOnly 一概忽略 */
function firstPairOfSetCookieHeader(headerLine) {
  const firstSegment = String(headerLine).split(';')[0].trim()
  const equalsIndex = firstSegment.indexOf('=')
  if (equalsIndex <= 0) return null
  return { name: firstSegment.slice(0, equalsIndex), value: firstSegment.slice(equalsIndex + 1) }
}

/** 从 URL 里手工切查询串(不解码):取第一个 '?' 之后、'#' 之前,再按 '&' 与第一个 '=' 拆 */
function queryPairsOfUrl(rawUrl) {
  const withoutFragment = String(rawUrl).split('#')[0]
  const questionIndex = withoutFragment.indexOf('?')
  if (questionIndex < 0) return []
  const pairs = []
  for (const piece of withoutFragment.slice(questionIndex + 1).split('&')) {
    const equalsIndex = piece.indexOf('=')
    if (equalsIndex <= 0) continue
    pairs.push({ name: piece.slice(0, equalsIndex), value: piece.slice(equalsIndex + 1) })
  }
  return pairs
}

export function extractLoginCookies(input) {
  const failure = (reason) => ({ ok: false, reason })

  // 先收 Set-Cookie 那份,再让 redirectUrl 盖上去——契约规定 URL 来的优先
  const cookies = {}
  const headerLines = Array.isArray(input?.setCookieHeaders) ? input.setCookieHeaders : []
  for (const headerLine of headerLines) {
    if (typeof headerLine !== 'string') continue
    const pair = firstPairOfSetCookieHeader(headerLine)
    // 值为空串视同没拿到:空 cookie 什么都干不了,还会把 missing 判断搅浑
    if (pair && EXTRACTABLE_COOKIES.includes(pair.name) && pair.value !== '') cookies[pair.name] = pair.value
  }
  if (typeof input?.redirectUrl === 'string') {
    for (const pair of queryPairsOfUrl(input.redirectUrl)) {
      if (EXTRACTABLE_COOKIES.includes(pair.name) && pair.value !== '') cookies[pair.name] = pair.value
    }
  }

  if (!cookies.SESSDATA) {
    return failure('没拿到 SESSDATA(redirectUrl 和 Set-Cookie 里都没有它),登录无从谈起')
  }
  const missing = EXTRACTABLE_COOKIES.filter((name) => !cookies[name])
  return { ok: true, cookies, missing }
}

export function buildCookieHeader(cookies) {
  const parts = []
  for (const name of HEADER_COOKIES) {
    // 非字符串的值当不存在:cookie 头里只能放字符串,数字硬拼进去就是坏头
    if (typeof cookies?.[name] === 'string' && cookies[name] !== '') {
      parts.push(`${name}=${cookies[name]}`)
    }
  }
  if (parts.length === 0) return { ok: false, reason: '五个字段一个都没有,拼不出 Cookie 头' }
  return { ok: true, header: parts.join('; ') }
}

export function credentialHealth(credential, nowMs) {
  // 拿不到可信的「现在」就没法体检:直接判死,让调用方提醒用户重登,胜过拿错时间瞎猜
  if (!Number.isFinite(nowMs)) return { ok: true, fresh: false, daysLeft: null }
  const expiresAtMs = credential?.expiresAtMs
  // 没有过期时间就「不知道」:不知道不判死,当还新鲜(契约口径)
  if (!Number.isFinite(expiresAtMs)) return { ok: true, fresh: true, daysLeft: null }
  const rawDaysLeft = (expiresAtMs - nowMs) / 86400000
  // fresh 用原始值判、daysLeft 只做展示取整:过期前 50 秒内会出现 fresh:true + daysLeft:0.0
  // 的组合——取整值不该反过来决定死活
  return { ok: true, fresh: rawDaysLeft > 0, daysLeft: Math.round(rawDaysLeft * 10) / 10 }
}
