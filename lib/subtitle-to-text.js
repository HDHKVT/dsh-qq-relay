/**
 * subtitle-to-text.js —— B 站字幕 JSON → 纯文本(纯函数)
 *
 * 负责:把字幕 JSON 的 body 数组逐条清洗(去首尾空白、换行压成空格、丢无效条目
 *      与相邻重复),再拼成给模型读的纯文本;支持时间轴模式和字数预算。
 * 不负责:下载字幕、决定「无字幕时怎么办」——body 为空按契约返回 ok:false,
 *        由调用方走它自己的「无字幕」分支。
 * 边界:body 条目里用不到的字段(sid/music/location 等)一律忽略,绝不因不认识而报错;
 *      单条字段不合法只丢那一条,不炸整体——这是契约的明确要求,不是防御性编程。
 */

/** 秒 → 时间码:不足 1 小时 mm:ss,满 1 小时 h:mm:ss,四舍五入到整秒。
 *  与 build-watch-package.js 里的同名函数刻意保持重复而不是 import:
 *  两个模块各自独立交付、独立被审,不该互相产生依赖。 */
function formatTimeCode(totalSeconds) {
  const wholeSeconds = Math.round(totalSeconds)
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  const seconds = wholeSeconds % 60
  const twoDigits = (value) => String(value).padStart(2, '0')
  if (hours > 0) return `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`
  return `${twoDigits(minutes)}:${twoDigits(seconds)}`
}

/** 清洗后还有没有「内容」:不含任何 Unicode 字母或数字(\p{L}\p{N})就视为纯标点/符号。
 *  契约说「只由标点/空白组成」,Unicode 类别是能想到的最不挑语言的说法。 */
function hasLetterOrDigit(text) {
  return /[\p{L}\p{N}]/u.test(text)
}

/** 单条 content 清洗:换行(含 \r)压成一个空格,再去首尾空白。
 *  普通空格、制表符不动——契约只要求处理换行。 */
function cleanContent(rawContent) {
  return rawContent.replace(/[\r\n]+/g, ' ').trim()
}

/** 相邻拼接:前一段末尾与后一段开头**都是** ASCII 字母/数字才补一个空格,
 *  中文之间直接相连(契约规则 4,防英文粘词,也防中文被塞空格)。 */
function appendSegment(accumulated, nextContent) {
  const asciiBoundary = /[0-9A-Za-z]$/.test(accumulated) && /^[0-9A-Za-z]/.test(nextContent)
  return asciiBoundary ? `${accumulated} ${nextContent}` : `${accumulated}${nextContent}`
}

function truncationMarker(originalChars) {
  return `（已截断，原文共 ${originalChars} 字）`
}

export function subtitleToText(payload, options) {
  const failure = (reason) => ({ ok: false, reason })

  const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
  if (!isPlainObject(payload)) return failure('payload 不是对象')
  if (!Array.isArray(payload.body)) return failure('payload.body 不是数组')
  // 空 body 单独给一句更明确的话:调用方要靠它分流到「无字幕」分支
  if (payload.body.length === 0) return failure('payload.body 是空数组：没有字幕，请走「无字幕」分支')

  const maxChars = options?.maxChars ?? 4000
  if (!Number.isInteger(maxChars) || maxChars <= 0) return failure('options.maxChars 不是正整数')
  const withTimecodes = Boolean(options?.timecodes)

  const segments = []
  let dropped = 0
  let lastKeptContent = ''
  for (const entry of payload.body) {
    // 契约规则 3:字段不合法只丢这一条。四种丢弃原因共用一个计数器,顺序不影响结果
    if (typeof entry?.content !== 'string' || !Number.isFinite(entry?.from) || !Number.isFinite(entry?.to)) {
      dropped += 1
      continue
    }
    const content = cleanContent(entry.content)
    if (content === '' || !hasLetterOrDigit(content) || content === lastKeptContent) {
      dropped += 1
      continue
    }
    lastKeptContent = content
    segments.push({ from: entry.from, content })
  }

  const stats = { total: payload.body.length, kept: segments.length, dropped }

  if (withTimecodes) {
    const lines = segments.map((segment) => `[${formatTimeCode(segment.from)}] ${segment.content}`)
    const fullText = lines.join('\n')
    stats.chars = fullText.length
    if (fullText.length <= maxChars) {
      stats.truncated = false
      return { ok: true, text: fullText, stats }
    }
    // 契约规则 7:截断按整行算,不许把一行劈成两半。字幕按时间排序,
    // 所以从头整行累积,放不下的那行起全部丢弃——不跳过长行去捡后面的短行
    const keptLines = []
    let usedChars = 0
    for (const line of lines) {
      const cost = keptLines.length === 0 ? line.length : line.length + 1
      if (usedChars + cost > maxChars) break
      keptLines.push(line)
      usedChars += cost
    }
    stats.truncated = true
    // 一行都放不下时只剩标注本身;标注不计入预算(契约「截到 maxChars 后追加」的字面顺序)
    const text = keptLines.length === 0 ? truncationMarker(fullText.length) : `${keptLines.join('\n')}\n${truncationMarker(fullText.length)}`
    return { ok: true, text, stats }
  }

  let text = ''
  for (const segment of segments) {
    text = text === '' ? segment.content : appendSegment(text, segment.content)
  }
  stats.chars = text.length
  stats.truncated = text.length > maxChars
  if (stats.truncated) {
    text = text.slice(0, maxChars) + truncationMarker(stats.chars)
  }
  return { ok: true, text, stats }
}
