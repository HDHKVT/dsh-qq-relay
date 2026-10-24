/**
 * credential.js —— 登录凭证的归一与校验(纯函数,两个导出)
 *
 * 负责:①把历史上各种形状的凭证(裸值 / cookie 头片段 / 完整 cookie 头 / 对象 /
 *        带 cookie 字段的对象)归一成标准 record(normalizeCredential);
 *      ②回答「这份凭证现在还能不能用」——只看结构与时间,不问网络(validateCredential)。
 * 不负责:凭证活没活着要问 B 站(nav 的判读在 bili-status.js)、存盘、二维码。
 * 边界:值一律原样保留,百分号编码(%2C)绝不解码——解码了 cookie 就不对了。
 * ⚠️ 全部模块里唯一的非纯触碰:validateCredential 的 nowMs 缺失时兜底 Date.now(),
 *    这是契约 14.2 第 7 条明写允许的;除此之外不碰时钟,时间一律由调用方注入。
 */

/** 认识的字段只有五个;missing 的输出顺序也固定按这个 */
const KNOWN_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3']

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** cookie 头解析:按 ; 切段、每段取第一个 name=value;
 *  不认识的字段、空段、值为空的段一律丢弃——宁缺毋滥,坏字段不该进凭证文件 */
function mergeCookieHeader(header, cookies) {
  for (const segment of String(header).split(';')) {
    const trimmed = segment.trim()
    const equalsIndex = trimmed.indexOf('=')
    if (equalsIndex <= 0) continue
    const name = trimmed.slice(0, equalsIndex)
    const value = trimmed.slice(equalsIndex + 1)
    if (KNOWN_COOKIES.includes(name) && value !== '') cookies[name] = value
  }
}

/** 有限数原样保留,其余(缺失/NaN/字符串)归 null——时间字段脏了宁可当不知道 */
function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null
}

export function normalizeCredential(raw, options) {
  const failure = (reason) => ({ ok: false, reason })

  const cookies = {}
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    // 含 = 才可能是「名=值」形状;不含 = 的整串就是 SESSDATA 的值
    // (SESSDATA 值本身是百分号编码的,不会带裸 =)
    if (trimmed.includes('=')) {
      mergeCookieHeader(trimmed, cookies)
    } else if (trimmed !== '') {
      cookies.SESSDATA = trimmed
    }
  } else if (isPlainObject(raw)) {
    // 带 cookie 字符串字段的对象:先解析那份,再让对象自身的字段覆盖上去
    if (typeof raw.cookie === 'string' && raw.cookie.includes('=')) {
      mergeCookieHeader(raw.cookie, cookies)
    }
    for (const name of KNOWN_COOKIES) {
      // 空串视同没提供、不参与覆盖——与「值为空不算拿到」的既有口径一致
      if (typeof raw[name] === 'string' && raw[name] !== '') cookies[name] = raw[name]
    }
  } else {
    return failure('凭证形状不认识:只接受字符串或对象')
  }

  if (typeof cookies.SESSDATA !== 'string' || cookies.SESSDATA === '') {
    return failure('凭证不完整:缺 SESSDATA')
  }
  return {
    ok: true,
    record: {
      cookies,
      savedAtMs: finiteOrNull(options?.savedAtMs),
      expiresAtMs: finiteOrNull(options?.expiresAtMs),
    },
  }
}

export function validateCredential(record, options) {
  const failure = (reason) => ({ ok: false, reason })

  if (!isPlainObject(record) || !isPlainObject(record.cookies)) {
    return failure('record 不是对象,或 record.cookies 不是对象')
  }
  // nowMs 坏值的兜底是契约明写的;这是本文件唯一的时钟触碰
  const providedNowMs = options?.nowMs
  const nowMs = Number.isFinite(providedNowMs) ? providedNowMs : Date.now()
  const expiresAtMs = finiteOrNull(record.expiresAtMs)

  const missing = KNOWN_COOKIES.filter(
    (name) => typeof record.cookies[name] !== 'string' || record.cookies[name] === '',
  )
  const daysLeft = expiresAtMs === null
    ? null
    : Math.round(((expiresAtMs - nowMs) / 86400000) * 10) / 10

  // 过期的判定优先于缺字段:都过期了,再说「还缺 bili_jct」只会误导排障方向
  if (expiresAtMs !== null && expiresAtMs <= nowMs) {
    return { ok: true, usable: false, expired: true, missing, daysLeft, reason: '凭证已过期' }
  }
  const usable = !missing.includes('SESSDATA')
  return {
    ok: true,
    usable,
    expired: false,
    missing,
    daysLeft,
    reason: usable ? '' : '凭证不完整:缺 SESSDATA',
  }
}
