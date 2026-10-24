/**
 * plan-storyboard-frames.js —— 故事板抽样规划(纯函数)
 *
 * 负责:给定视频故事板(若干张雪碧图拼成的缩略图集)的几何信息与时间轴,
 *      算出「抽样看这个视频」应取的格:每格所在拼图、裁切坐标、对应时间。
 * 不负责:下载图片、裁切图像、联网、读写文件——全部由调用方完成。
 * 边界:不改入参;非法输入一律返回 { ok: false, reason },绝不抛错。
 */

/**
 * 毫秒判据必须用「相对时长的比值」:长视频的正常秒数本身就很大,
 * 任何绝对阈值都会把 6 小时视频的秒数误判成毫秒,导致所有帧塌到第一格。
 */
const MILLIS_RATIO = 1.5

/** 在 [start, end] 区间内均匀取 count 个时间点;count 为 1 时取区间中点。 */
function planTargetTimes(start, end, count) {
  if (count === 1) return [(start + end) / 2]
  const targets = []
  for (let index = 0; index < count; index += 1) {
    targets.push(start + ((end - start) * index) / (count - 1))
  }
  return targets
}

/** 在升序时间表里二分找最接近 target 的格号。
 *  times[格号] 就是该格的时间;升序是 B 站故事板数据的既成事实,本模块不负责验证。 */
function nearestCellIndex(target, times) {
  let low = 0
  let high = times.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (times[middle] < target) low = middle + 1
    else high = middle
  }
  // low 是第一个 >= target 的位置;它与前一格谁离 target 更近就取谁
  if (low > 0 && Math.abs(times[low - 1] - target) <= Math.abs(times[low] - target)) {
    return low - 1
  }
  return low
}

export function planStoryboardFrames(meta, options) {
  const failure = (reason) => ({ ok: false, reason })

  for (const field of ['durationSeconds', 'columns', 'rows', 'cellWidth', 'cellHeight']) {
    const value = meta?.[field]
    if (!Number.isFinite(value) || value <= 0) {
      return failure(`meta.${field} 缺失或不是大于 0 的数字`)
    }
  }
  if (!Array.isArray(meta.imageUrls) || meta.imageUrls.length === 0) {
    return failure('meta.imageUrls 不是数组或长度为 0')
  }
  const count = options?.count ?? 6
  if (!Number.isFinite(count) || count <= 0) {
    return failure('options.count 不是有限数字或 ≤ 0')
  }
  if (!Array.isArray(meta.cellTimes) || meta.cellTimes.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return failure('meta.cellTimes 不是数字数组')
  }

  const { durationSeconds, columns, rows, cellWidth, cellHeight, imageUrls, cellTimes } = meta
  const startRatio = options?.startRatio ?? 0.05
  const endRatio = options?.endRatio ?? 0.95
  const cellsPerSheet = columns * rows
  const totalCells = imageUrls.length * cellsPerSheet

  // 时间单位归一:只统计下标 1 起的真实值——首项是占位符,不许依赖它恰好是 0
  const realTimes = cellTimes.slice(1)
  let unitInferred = 's'
  let timesInSeconds = realTimes
  if (realTimes.length > 0) {
    let maxRealTime = realTimes[0]
    for (const value of realTimes) {
      if (value > maxRealTime) maxRealTime = value
    }
    if (maxRealTime > durationSeconds * MILLIS_RATIO) {
      unitInferred = 'ms'
      timesInSeconds = realTimes.map((value) => value / 1000)
    }
  }

  // 空时间轴(或只剩占位符)时按总时长均匀推算。分母必须是全部拼图加起来的
  // 总格数:只除单张格数的话,第二张拼图的时间会全部超出视频时长、永远取不到。
  const useUniformTimes = timesInSeconds.length === 0
  const uniformCellDuration = durationSeconds / totalCells

  // 契约只要求 count 为有限正数;遇到非整数向下取整并至少保留 1 帧,避免返回空结果
  const frameCount = Math.max(1, Math.floor(count))
  const targets = planTargetTimes(durationSeconds * startRatio, durationSeconds * endRatio, frameCount)

  const chosenCells = new Map()
  for (const target of targets) {
    let cellIndex
    if (useUniformTimes) {
      cellIndex = Math.round(target / uniformCellDuration)
      // endRatio 接近 1 时四舍五入可能顶到总格数;钳回界内,保证坐标不越界
      if (cellIndex < 0) cellIndex = 0
      if (cellIndex > totalCells - 1) cellIndex = totalCells - 1
    } else {
      cellIndex = nearestCellIndex(target, timesInSeconds)
      if (cellIndex > totalCells - 1) {
        return failure(`时间轴第 ${cellIndex} 格超出拼图总格数 ${totalCells},cellTimes 与拼图几何不一致`)
      }
    }
    if (!chosenCells.has(cellIndex)) {
      const cellTime = useUniformTimes ? cellIndex * uniformCellDuration : timesInSeconds[cellIndex]
      chosenCells.set(cellIndex, cellTime)
    }
  }

  const frames = [...chosenCells.entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([cellIndex, cellTime]) => {
      const sheetIndex = Math.floor(cellIndex / cellsPerSheet)
      const localIndex = cellIndex % cellsPerSheet
      return {
        imageUrl: imageUrls[sheetIndex],
        x: (localIndex % columns) * cellWidth,
        y: Math.floor(localIndex / columns) * cellHeight,
        w: cellWidth,
        h: cellHeight,
        timeSeconds: Math.round(cellTime * 10) / 10,
      }
    })

  return { ok: true, unitInferred, frames }
}
