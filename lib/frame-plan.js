/**
 * frame-plan.js —— 按时刻抽帧的三件纯逻辑
 *
 * 负责:①把各种写法的「时刻」解析成秒(parseTimecode);
 *      ②把一批时刻整理成去重、排序、限额的抽帧计划(planFrameRequests);
 *      ③把时刻对到字幕行上,给抽出的图配文字(locateSubtitleLine)。
 * 不负责:网络请求、调 Python 解码、存盘——全部由黛丝侧完成。
 * 边界:只认半角数字与(归一后的)半角冒号;全角数字刻意不认,
 *      转换会掩盖用户输入问题(契约 11.1 规则 3 的明确选择)。
 */

/** 去重容差:相差不足 0.5 秒视为同一帧;恰好 0.5 算不同帧 */
const DEDUPE_TOLERANCE_SECONDS = 0.5

/** 秒 → 时间码标签:不足 1 小时 mm:ss,满 1 小时 h:mm:ss,秒四舍五入到整秒。
 *  与 build-watch-package.js 里的同名函数刻意保持重复而不是 import:
 *  每个模块独立交付、独立被审,不该互相产生依赖。 */
function formatTimeCode(totalSeconds) {
  const wholeSeconds = Math.round(totalSeconds)
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  const seconds = wholeSeconds % 60
  const twoDigits = (value) => String(value).padStart(2, '0')
  if (hours > 0) return `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`
  return `${twoDigits(minutes)}:${twoDigits(seconds)}`
}

export function parseTimecode(input) {
  const failure = (reason) => ({ ok: false, reason })

  if (typeof input === 'number') {
    // 0 秒是合法时刻,只有负数和非有限数才拒
    if (!Number.isFinite(input) || input < 0) return failure('数字必须是有限的非负数(0 秒是合法时刻)')
    return { ok: true, seconds: Math.round(input * 1000) / 1000 }
  }
  if (typeof input !== 'string') return failure('只接受数字或字符串')
  const trimmed = input.trim()
  if (trimmed === '') return failure('空字符串不是时刻')

  // 只归一全角冒号这一种;全角数字留给失败路径去暴露
  const segments = trimmed.replace(/：/g, ':').split(':')
  const partCount = segments.length
  if (partCount > 3) return failure(`按冒号切成了 ${partCount} 段,只能是 1~3 段`)

  // 段名从右往左数:最后一段永远是「秒」
  const segmentName = (index) => ['时', '分', '秒'][partCount - 1 - index]
  const values = []
  for (let index = 0; index < partCount; index += 1) {
    const segment = segments[index]
    const name = segmentName(index)
    if (segment === '') return failure(`第 ${index + 1} 段(${name})是空的`)
    const isFirst = index === 0
    const isLast = index === partCount - 1
    if (isLast) {
      // 最后一段:整数或最多三位小数
      if (!/^\d+(\.\d{1,3})?$/.test(segment)) {
        if (/^\d+\.\d+$/.test(segment)) return failure(`第 ${index + 1} 段(${name})「${segment}」的小数超过三位`)
        return failure(`第 ${index + 1} 段(${name})「${segment}」不是合法的秒数`)
      }
      // 多段时最后一段也受 0–59 约束;单段(纯秒数)没有上限
      const value = Number(segment)
      if (partCount > 1 && value > 59) return failure(`第 ${index + 1} 段(${name})「${segment}」超出 0–59`)
      values.push(value)
    } else if (isFirst) {
      // 第一段(时或分):整数即可,>= 0,无上限——「99:59:59」必须合法
      if (!/^\d+$/.test(segment)) {
        if (/^\d+\.\d+$/.test(segment)) return failure(`第 ${index + 1} 段(${name})「${segment}」不允许小数(小数只能在最后一段)`)
        return failure(`第 ${index + 1} 段(${name})「${segment}」不是整数`)
      }
      values.push(Number(segment))
    } else {
      // 中间段(三段式里的「分」):0–59 的整数
      if (!/^\d+$/.test(segment)) {
        if (/^\d+\.\d+$/.test(segment)) return failure(`第 ${index + 1} 段(${name})「${segment}」不允许小数(小数只能在最后一段)`)
        return failure(`第 ${index + 1} 段(${name})「${segment}」不是整数`)
      }
      const value = Number(segment)
      if (value > 59) return failure(`第 ${index + 1} 段(${name})「${segment}」超出 0–59`)
      values.push(value)
    }
  }

  // [时,分,秒] 从左到右每段乘一次 60,正好等价于 时×3600+分×60+秒
  let totalSeconds = 0
  for (const value of values) totalSeconds = totalSeconds * 60 + value
  return { ok: true, seconds: Math.round(totalSeconds * 1000) / 1000 }
}

export function planFrameRequests(input) {
  const failure = (reason) => ({ ok: false, reason })

  const durationSeconds = input?.durationSeconds
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return failure('durationSeconds 不是有限正数')
  if (!Array.isArray(input?.times) || input.times.length === 0) return failure('times 不是数组或为空')

  // offsets/maxFrames 的垃圾值契约没列为错误,按「退回默认」处理,不让计划整体失败
  let offsets = Array.isArray(input?.offsetsSeconds) ? input.offsetsSeconds.filter((value) => Number.isFinite(value)) : []
  if (offsets.length === 0) offsets = [0]
  const maxFrames = Number.isInteger(input?.maxFrames) && input.maxFrames > 0 ? input.maxFrames : 12

  const rejected = []
  // 先按「输入出现顺序」收集并去重(保留先出现的),排序放在去重之后——契约规则 5→6 的顺序
  const keptSeconds = []
  for (const rawTime of input.times) {
    const parsed = parseTimecode(rawTime)
    if (parsed.ok !== true) {
      rejected.push({ input: rawTime, reason: parsed.reason })
      continue
    }
    for (const offset of offsets) {
      // 展开后钳进片长:时刻可以超片长,帧不能
      const seconds = Math.min(durationSeconds, Math.max(0, parsed.seconds + offset))
      const duplicate = keptSeconds.some((kept) => Math.abs(kept - seconds) < DEDUPE_TOLERANCE_SECONDS)
      if (!duplicate) keptSeconds.push(seconds)
    }
  }

  if (keptSeconds.length === 0) {
    return failure('全部时刻都解析失败,没有一个可用目标')
  }

  keptSeconds.sort((left, right) => left - right)

  // 超上限从中间往两边砍:反复拿掉正中那个,首尾永远轮不到被砍(偶数长度取上中位)
  let dropped = 0
  while (keptSeconds.length > maxFrames) {
    keptSeconds.splice(Math.floor(keptSeconds.length / 2), 1)
    dropped += 1
  }

  const targets = keptSeconds.map((seconds) => ({ seconds, label: formatTimeCode(seconds) }))
  return { ok: true, targets, dropped, rejected }
}

export function locateSubtitleLine(body, seconds) {
  const failure = (reason) => ({ ok: false, reason })

  if (!Array.isArray(body)) return failure('body 不是数组')
  if (!Number.isFinite(seconds)) return failure('seconds 不是有限数')

  let nearestPrevious = null
  for (const entry of body) {
    const from = entry?.from
    const to = entry?.to
    const content = entry?.content
    // 脏条目(缺字段或类型不对)跳过:定位不该被一条脏字幕拖垮
    if (!Number.isFinite(from) || !Number.isFinite(to) || typeof content !== 'string') continue
    // 命中多条时取第一条:body 顺序扫描,命中即返回
    if (from <= seconds && seconds <= to) {
      return { ok: true, found: true, text: content, from, to }
    }
    if (to <= seconds && (nearestPrevious === null || to > nearestPrevious.to)) {
      nearestPrevious = { text: content, from, to }
    }
  }

  // 「最近的前一句」也算找到——只是对照用,不是没找到
  if (nearestPrevious !== null) {
    return { ok: true, found: true, text: nearestPrevious.text, from: nearestPrevious.from, to: nearestPrevious.to }
  }
  return { ok: true, found: false, text: '', from: null, to: null }
}
