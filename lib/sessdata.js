/**
 * sessdata.js —— 从 SESSDATA 里读过期时间 + 凭证脱敏(纯函数,两个导出)
 *
 * 负责:①把 SESSDATA 值里自带的 Unix 秒级过期时间读出来(parseSessdataExpiry);
 *      ②把凭证翻成可以进日志/诊断的安全文本(redactCredential)。
 * 不负责:文件读写、权限、网络——黛丝侧的活。
 * 边界:本模块是全项目**唯一允许百分号解码**的地方——因为要解析值的内部结构
 *      (%2C 分隔的段),而不是把值原样回写;解码只用于"看",绝不产出解码后的凭证。
 */

/** 认识的五个字段;脱敏输出顺序也固定按这个 */
const KNOWN_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3']

/** 合理性窗口:2000-01-01 与 2100-01-01 的 Unix 毫秒值。
 *  把毫秒当秒传进来会大到 2100 之后,太早的也不像真凭证——宁可读不出,不许猜。 */
const MIN_REASONABLE_MS = 946684800000
const MAX_REASONABLE_MS = 4102444800000

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseSessdataExpiry(sessdata) {
  const failure = (reason) => ({ ok: false, reason })

  if (typeof sessdata !== 'string') return failure('SESSDATA 的值必须是字符串')
  const trimmed = sessdata.trim()
  if (trimmed === '') return failure('SESSDATA 的值是空的')

  // 解码才能看见 %2C 分隔的内部结构;坏编码(如 %ZZ)会让 decodeURIComponent 抛异常,
  // 接住后按原串继续试——读不出过期时间不该炸掉调用方
  let decoded = trimmed
  try {
    decoded = decodeURIComponent(trimmed)
  } catch {
    decoded = trimmed
  }

  const segments = decoded.split(',')
  if (segments.length < 2) {
    return failure('这条 SESSDATA 里没有过期时间(逗号分段不足两段,是老格式)')
  }
  const stampSegment = segments[1]
  if (!/^\d+$/.test(stampSegment)) {
    return failure(`第 2 段「${stampSegment}」不是纯数字,读不出过期时间`)
  }
  const expiresAtMs = Number(stampSegment) * 1000
  if (expiresAtMs < MIN_REASONABLE_MS || expiresAtMs > MAX_REASONABLE_MS) {
    return failure(`时间戳不合理(${stampSegment} 秒不在 2000-01-01 与 2100-01-01 之间,疑似把毫秒当秒传了)`)
  }
  return { ok: true, expiresAtMs }
}

/** 短值整体打码;长值保头尾各 4 字——够认出是哪一份凭证,不够拼回原值 */
function maskValue(value) {
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}***${value.slice(-4)}`
}

export function redactCredential(cookies) {
  const failure = (reason) => ({ ok: false, reason })

  if (!isPlainObject(cookies)) return failure('cookies 不是对象')

  const present = []
  for (const name of KNOWN_COOKIES) {
    const value = cookies[name]
    // 非字符串与空串都按"没有这项"处理:脱敏输出里不该出现空占位
    if (typeof value !== 'string' || value === '') continue
    present.push({ name, value })
  }
  if (present.length === 0) return failure('没有可脱敏的凭证字段')

  const parts = present.map((entry) => `${entry.name}=${maskValue(entry.value)}`)
  let text = parts.join('; ')
  // 契约的硬要求兜底:极端构造的值(恰好长得像自己的脱敏产物,如 "abcd***fghi",
  // 或两个字段的值相同)会让上面的格式把完整原值吐进输出——发现包含就整项打成 ***
  for (let index = 0; index < present.length; index += 1) {
    if (text.includes(present[index].value)) {
      parts[index] = `${present[index].name}=***`
      text = parts.join('; ')
    }
  }
  return { ok: true, text }
}
