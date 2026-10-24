/**
 * conclusion.js —— B 站官方「AI 总结」的解析与抽帧选点(纯函数,两个导出)
 *
 * 负责:①把 conclusion 的 summary/outline 解析干净(parseVideoConclusion);
 *      ②按优先级(大纲要点 > 章节起点)选出抽帧点;候选超预算时按时间轴
 *        均匀铺开(pickFrameTargets),不许取最早的一批——43 分钟的视频
 *        有 15 个大纲要点时,取最早 6 个会让后 25 分钟一个点都没有。
 * 不负责:取数据(网络)、抽帧、渲染——黛丝侧的活。
 * 边界:B 站自己标的时间点比均匀抽样准,本模块只做筛选、去重、排序与均匀挑选,
 *      不发明任何新时间点。
 */

/** 同一节内要点去重容差:相差 ≤1 秒视为重复(契约口径,与选点阶段的 2 秒不同) */
const POINT_DEDUPE_TOLERANCE_SECONDS = 1
/** 选点合并容差:任意两个候选相差 ≤2 秒视为同一处 */
const TARGET_DEDUPE_TOLERANCE_SECONDS = 2

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 秒 → 时间码标签:不足 1 小时 mm:ss,满 1 小时 h:mm:ss,秒四舍五入到整秒。
 *  与前几个模块的同名函数刻意保持重复而不是 import:模块独立交付、独立被审。 */
function formatTimeCode(totalSeconds) {
  const wholeSeconds = Math.round(totalSeconds)
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  const seconds = wholeSeconds % 60
  const twoDigits = (value) => String(value).padStart(2, '0')
  if (hours > 0) return `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`
  return `${twoDigits(minutes)}:${twoDigits(seconds)}`
}

export function parseVideoConclusion(payload) {
  const failure = (reason) => ({ ok: false, reason })
  if (!isPlainObject(payload)) return failure('payload 不是对象')
  // 调用方可能传 data、也可能直接传 model_result:后者自己就有 summary/outline,
  // 前者要把 model_result 剥一层——剥一次两种形状就都通了
  const source = isPlainObject(payload.model_result) ? payload.model_result : payload

  // 摘要保留原文:不裁剪、不压换行(契约规则 2),坏类型给空串而不是报错
  const summary = typeof source.summary === 'string' ? source.summary : ''
  const outline = Array.isArray(source.outline) ? source.outline : []

  const sections = []
  let pointCount = 0
  for (const sectionEntry of outline) {
    const title = typeof sectionEntry?.title === 'string' ? sectionEntry.title : ''
    const partOutline = Array.isArray(sectionEntry?.part_outline) ? sectionEntry.part_outline : []
    const keptPoints = []
    // 去重按输入顺序先到先得,排在这之后——「先出现」指的是原始顺序
    for (const pointEntry of partOutline) {
      const timestamp = pointEntry?.timestamp
      const content = pointEntry?.content
      if (!Number.isFinite(timestamp)) continue
      if (typeof content !== 'string' || content === '') continue
      const timeSeconds = Math.round(timestamp)
      const duplicate = keptPoints.some((kept) => Math.abs(kept.timeSeconds - timeSeconds) <= POINT_DEDUPE_TOLERANCE_SECONDS)
      if (duplicate) continue
      keptPoints.push({ timeSeconds, content })
    }
    keptPoints.sort((left, right) => left.timeSeconds - right.timeSeconds)
    pointCount += keptPoints.length
    sections.push({ title, points: keptPoints })
  }

  return { ok: true, summary, sections, pointCount }
}

/** 均匀挑选下标:round(i×(n-1)/(pick-1)),i 取 0..pick-1,首尾必在、中间铺开。
 *  只在 candidateCount ≥ pickCount 时有意义;n === pick 时公式退化为恒等映射(全取)。
 *  pickCount 为 1 时公式除零,单独按「正中」处理——偶数个候选取上中位,
 *  与 frame-plan 删正中元素的约定同向。 */
function uniformPickIndices(candidateCount, pickCount) {
  if (pickCount <= 0) return []
  if (pickCount === 1) return [Math.round((candidateCount - 1) / 2)]
  const indices = []
  for (let index = 0; index < pickCount; index += 1) {
    indices.push(Math.round((index * (candidateCount - 1)) / (pickCount - 1)))
  }
  return indices
}

export function pickFrameTargets(input) {
  const failure = (reason) => ({ ok: false, reason })

  const durationSeconds = input?.durationSeconds
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return failure('durationSeconds 不是有限正数')
  const limit = Number.isInteger(input?.limit) && input.limit > 0 ? input.limit : 6

  // 两路候选各自收集并先钳进片长(先钳后并:两个超片长的候选会钳到同一秒,
  // 钳完再去重才不会漏掉这种撞车),再各自按秒升序排好
  const clampToDuration = (seconds) => Math.min(durationSeconds, Math.max(0, seconds))
  const outlineCandidates = []
  const conclusion = input?.conclusion
  if (conclusion?.ok === true && Array.isArray(conclusion.sections)) {
    for (const section of conclusion.sections) {
      for (const point of section?.points ?? []) {
        if (!Number.isFinite(point?.timeSeconds)) continue
        outlineCandidates.push({
          seconds: clampToDuration(point.timeSeconds),
          source: 'outline',
          note: typeof point.content === 'string' ? point.content : '',
        })
      }
    }
  }
  const chapterCandidates = []
  const viewPoints = Array.isArray(input?.viewPoints) ? input.viewPoints : []
  for (const chapter of viewPoints) {
    if (!Number.isFinite(chapter?.from)) continue
    chapterCandidates.push({
      seconds: clampToDuration(chapter.from),
      source: 'chapter',
      note: typeof chapter.content === 'string' ? chapter.content : '',
    })
  }
  const bySeconds = (left, right) => left.seconds - right.seconds
  outlineCandidates.sort(bySeconds)
  chapterCandidates.sort(bySeconds)

  const targets = []
  let dropped = 0
  const overlapsAny = (seconds, pool) =>
    pool.some((entry) => Math.abs(entry.seconds - seconds) <= TARGET_DEDUPE_TOLERANCE_SECONDS)

  // 大纲优先:同源去重(保时间靠前的)在前、均匀挑在后(契约规则 6 的顺序)
  const keptOutline = []
  for (const candidate of outlineCandidates) {
    if (overlapsAny(candidate.seconds, keptOutline)) {
      dropped += 1
      continue
    }
    keptOutline.push(candidate)
  }
  const outlinePickCount = Math.min(keptOutline.length, limit)
  for (const index of uniformPickIndices(keptOutline.length, outlinePickCount)) {
    targets.push(keptOutline[index])
  }
  dropped += keptOutline.length - outlinePickCount

  // 名额没被大纲占满才轮到章节:先去掉与已选点(以及同源已保留)撞车的,再按剩余名额均匀挑
  const remainingSlots = limit - targets.length
  if (remainingSlots > 0) {
    const keptChapters = []
    for (const candidate of chapterCandidates) {
      if (overlapsAny(candidate.seconds, targets) || overlapsAny(candidate.seconds, keptChapters)) {
        dropped += 1
        continue
      }
      keptChapters.push(candidate)
    }
    const chapterPickCount = Math.min(keptChapters.length, remainingSlots)
    for (const index of uniformPickIndices(keptChapters.length, chapterPickCount)) {
      targets.push(keptChapters[index])
    }
    dropped += keptChapters.length - chapterPickCount
  } else if (chapterCandidates.length > 0) {
    // 名额已被大纲占满:章节候选一个都没用上,全部算被上限挤掉
    dropped += chapterCandidates.length
  }

  const finalTargets = targets.map((candidate) => ({ ...candidate, label: formatTimeCode(candidate.seconds) }))
  finalTargets.sort(bySeconds)
  return { ok: true, targets: finalTargets, dropped }
}
