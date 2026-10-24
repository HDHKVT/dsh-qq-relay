/**
 * selftest.mjs —— planStoryboardFrames 的自测
 *
 * 只 import 被测模块;不联网、不读写文件。
 * 全部通过退出码 0,有失败退出码 1;每条用例一行输出。
 */
import { planStoryboardFrames } from '../lib/plan-storyboard-frames.js'

let totalCount = 0
let failedCount = 0

function report(name, passed, detail) {
  totalCount += 1
  if (passed) {
    console.log(`✓ ${name}`)
  } else {
    failedCount += 1
    console.log(`✗ ${name} - 实际:${detail ?? '(未提供)'}`)
  }
}

/** [0, step, 2*step, ...] 共 count 个;整数步进,避免浮点累积漂移 */
function timesEvery(step, count) {
  return Array.from({ length: count }, (_, index) => index * step)
}

function strictlyAscending(frames) {
  return frames.every((frame, index) => index === 0 || frames[index - 1].timeSeconds < frame.timeSeconds)
}

function coordsWithinSheet(frames, columns, rows, cellWidth, cellHeight) {
  const sheetWidth = columns * cellWidth
  const sheetHeight = rows * cellHeight
  return frames.every((frame) =>
    frame.x >= 0 && frame.y >= 0 &&
    frame.x + frame.w <= sheetWidth && frame.y + frame.h <= sheetHeight &&
    frame.w === cellWidth && frame.h === cellHeight)
}

// 用例 1/2/6/9/10 共用的几何:188 秒、10×10 格、单格 480×270、一张拼图
const GEOMETRY = { columns: 10, rows: 10, cellWidth: 480, cellHeight: 270, imageUrls: ['sheet-0.jpg'] }

// ── 1 常规 ──
{
  const meta = { durationSeconds: 188, ...GEOMETRY, cellTimes: [0, ...timesEvery(5, 38)] }
  const result = planStoryboardFrames(meta, { count: 6 })
  const frames = result.ok ? result.frames : []
  report(
    '1 常规:188 秒单拼图真实时间轴,count=6 → 6 帧、时间递增、坐标全在 4800×2700 内',
    result.ok === true && result.unitInferred === 's' && frames.length === 6 &&
      strictlyAscending(frames) && coordsWithinSheet(frames, 10, 10, 480, 270) &&
      frames.every((frame) => frame.imageUrl === 'sheet-0.jpg'),
    `ok=${result.ok} unit=${result.unitInferred} 帧数=${frames.length} frames=${JSON.stringify(frames)}`,
  )
}

// ── 2 空时间轴 ──
{
  const meta = { durationSeconds: 188, ...GEOMETRY, cellTimes: [] }
  const result = planStoryboardFrames(meta, { count: 6 })
  const frames = result.ok ? result.frames : []
  report(
    '2 空时间轴:按总时长均匀推算,仍返回 6 帧',
    result.ok === true && result.unitInferred === 's' && frames.length === 6 &&
      strictlyAscending(frames) && coordsWithinSheet(frames, 10, 10, 480, 270),
    `ok=${result.ok} 帧数=${frames.length} frames=${JSON.stringify(frames)}`,
  )
}

// ── 3 极短视频,去重生效 ──
{
  const meta = { durationSeconds: 3, columns: 3, rows: 1, cellWidth: 160, cellHeight: 90, imageUrls: ['only.jpg'], cellTimes: [] }
  const result = planStoryboardFrames(meta, { count: 6 })
  const frames = result.ok ? result.frames : []
  report(
    '3 极短视频(3 秒、仅 3 格):目标点大量落同格,去重后帧数 < 6 且不报错',
    result.ok === true && frames.length > 0 && frames.length < 6 &&
      strictlyAscending(frames) && coordsWithinSheet(frames, 3, 1, 160, 90),
    `ok=${result.ok} 帧数=${frames.length} frames=${JSON.stringify(frames)}`,
  )
}

// ── 4 多张拼图 ──
{
  const meta = {
    durationSeconds: 1000, columns: 10, rows: 10, cellWidth: 480, cellHeight: 270,
    imageUrls: ['sheet-a.jpg', 'sheet-b.jpg'], cellTimes: [0, ...timesEvery(5, 200)],
  }
  const result = planStoryboardFrames(meta, { count: 6 })
  const frames = result.ok ? result.frames : []
  const lastFrame = frames[frames.length - 1]
  report(
    '4 两张拼图:后半段帧的 imageUrl 指向第二张,末帧坐标按全局格号换算(x=0, y=2430, t=950)',
    result.ok === true && result.unitInferred === 's' && frames.length === 6 &&
      frames.slice(3).every((frame) => frame.imageUrl === 'sheet-b.jpg') &&
      lastFrame.x === 0 && lastFrame.y === 2430 && lastFrame.timeSeconds === 950,
    `ok=${result.ok} 帧数=${frames.length} 末帧=${JSON.stringify(lastFrame)}`,
  )
}

// ── 5 非法输入(每条一行) ──
{
  const base = { durationSeconds: 188, ...GEOMETRY, cellTimes: [0, ...timesEvery(5, 38)] }
  const invalidCases = [
    ['5a meta 为空对象(字段全缺)', planStoryboardFrames({}, { count: 6 })],
    ['5b columns = 0', planStoryboardFrames({ ...base, columns: 0 }, { count: 6 })],
    ['5c imageUrls 为空数组', planStoryboardFrames({ ...base, imageUrls: [] }, { count: 6 })],
    ['5d imageUrls 不是数组', planStoryboardFrames({ ...base, imageUrls: 'sheet-0.jpg' }, { count: 6 })],
    ['5e count = 0', planStoryboardFrames(base, { count: 0 })],
    ['5f count = NaN', planStoryboardFrames(base, { count: Number.NaN })],
    ['5g cellTimes 不是数组', planStoryboardFrames({ ...base, cellTimes: 'nope' }, { count: 6 })],
    ['5h cellTimes 混入非数字', planStoryboardFrames({ ...base, cellTimes: [0, 0, 5, 'x'] }, { count: 6 })],
    ['5i 时间轴格数超出拼图总格数', planStoryboardFrames(
      { durationSeconds: 40, columns: 2, rows: 1, cellWidth: 160, cellHeight: 90, imageUrls: ['only.jpg'], cellTimes: [0, 0, 10, 20, 30, 40] },
      { count: 6 })],
  ]
  for (const [name, result] of invalidCases) {
    report(
      name,
      result.ok === false && typeof result.reason === 'string' && result.reason.length > 0 && !('frames' in result),
      `ok=${result.ok} reason=${JSON.stringify(result.reason)}`,
    )
  }
}

// ── 6 毫秒误判 ──
{
  const milliseconds = { durationSeconds: 188, ...GEOMETRY, cellTimes: [0, ...timesEvery(5000, 38)] }
  const result = planStoryboardFrames(milliseconds, { count: 6 })
  const frames = result.ok ? result.frames : []
  const inRange = frames.every((frame) => frame.timeSeconds >= 0 && frame.timeSeconds <= 188)
  const notCollapsed = frames.length === 6 && strictlyAscending(frames)
  // 同一份数据换成秒制再跑一遍,两者产出必须完全一致
  const secondsVersion = planStoryboardFrames({ durationSeconds: 188, ...GEOMETRY, cellTimes: [0, ...timesEvery(5, 38)] }, { count: 6 })
  const sameAsSeconds = JSON.stringify(frames) === JSON.stringify(secondsVersion.ok ? secondsVersion.frames : null)
  report(
    "6 毫秒时间戳:unitInferred='ms',帧落在 0~188 秒、不塌到第一格,且与秒制结果完全一致",
    result.ok === true && result.unitInferred === 'ms' && inRange && notCollapsed && sameAsSeconds,
    `ok=${result.ok} unit=${result.unitInferred} 帧数=${frames.length} frames=${JSON.stringify(frames)}`,
  )
}

// ── 7 空时间轴 + 多张拼图 ──
{
  const meta = {
    durationSeconds: 60, columns: 3, rows: 2, cellWidth: 480, cellHeight: 270,
    imageUrls: ['sheet-a.jpg', 'sheet-b.jpg'], cellTimes: [],
  }
  const result = planStoryboardFrames(meta, { count: 6 })
  const frames = result.ok ? result.frames : []
  report(
    '7 空时间轴 + 两张拼图:count 取满时,后半段帧的 imageUrl 必须指向第二张',
    result.ok === true && frames.length === 6 &&
      frames.slice(3).every((frame) => frame.imageUrl === 'sheet-b.jpg') &&
      strictlyAscending(frames),
    `ok=${result.ok} 帧数=${frames.length} frames=${JSON.stringify(frames)}`,
  )
}

// ── 8 长视频不误判(反向锁死绝对阈值) ──
{
  const meta = {
    durationSeconds: 21600, columns: 10, rows: 10, cellWidth: 480, cellHeight: 270,
    imageUrls: ['sheet-0.jpg', 'sheet-1.jpg', 'sheet-2.jpg', 'sheet-3.jpg', 'sheet-4.jpg', 'sheet-5.jpg', 'sheet-6.jpg', 'sheet-7.jpg'],
    cellTimes: [0, ...timesEvery(30, 720)],
  }
  const result = planStoryboardFrames(meta, { count: 6 })
  const frames = result.ok ? result.frames : []
  report(
    "8 长视频(6 小时)秒制时间戳:unitInferred 必须是 's',帧正常分布、不塌到第一格",
    result.ok === true && result.unitInferred === 's' && frames.length === 6 &&
      strictlyAscending(frames) && frames[0].timeSeconds > 0,
    `ok=${result.ok} unit=${result.unitInferred} 帧数=${frames.length} frames=${JSON.stringify(frames)}`,
  )
}

// ── 9 占位符非 0 ──
{
  const withZero = planStoryboardFrames({ durationSeconds: 188, ...GEOMETRY, cellTimes: [0, ...timesEvery(5, 38)] }, { count: 6 })
  const withMinusOne = planStoryboardFrames({ durationSeconds: 188, ...GEOMETRY, cellTimes: [-1, ...timesEvery(5, 38)] }, { count: 6 })
  report(
    '9 占位符改成 -1:输出与占位符为 0 时完全一致',
    withZero.ok === true && withMinusOne.ok === true && JSON.stringify(withZero) === JSON.stringify(withMinusOne),
    `零占位=${JSON.stringify(withZero)} 负一占位=${JSON.stringify(withMinusOne)}`,
  )
}

// ── 10 count = 1 取区间中点 ──
{
  const result = planStoryboardFrames({ durationSeconds: 188, ...GEOMETRY, cellTimes: [0, ...timesEvery(5, 38)] }, { count: 1 })
  const frames = result.ok ? result.frames : []
  report(
    '10 count=1:取区间中点(94 秒),仅 1 帧,映射到最近的 95 秒格',
    result.ok === true && frames.length === 1 && frames[0].timeSeconds === 95,
    `ok=${result.ok} 帧数=${frames.length} frames=${JSON.stringify(frames)}`,
  )
}

console.log(`\n共 ${totalCount} 项,失败 ${failedCount} 项`)
process.exitCode = failedCount === 0 ? 0 : 1
