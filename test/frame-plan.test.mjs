/**
 * selftest-frame-plan.mjs —— parseTimecode / planFrameRequests / locateSubtitleLine 的自测
 *
 * 只 import 被测模块;不联网、不读写文件。
 * 全部通过退出码 0,有失败退出码 1;每条用例一行输出。
 */
import { parseTimecode, planFrameRequests, locateSubtitleLine } from '../lib/frame-plan.js'

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

const secondsOf = (input) => {
  const result = parseTimecode(input)
  return result.ok ? result.seconds : `!${result.reason}`
}

// ── parseTimecode ──
{
  report('1 723→723;"723"→723;"12:03"→723;"1:02:03"→3723',
    secondsOf(723) === 723 && secondsOf('723') === 723 && secondsOf('12:03') === 723 && secondsOf('1:02:03') === 3723,
    `${secondsOf(723)} ${secondsOf('723')} ${secondsOf('12:03')} ${secondsOf('1:02:03')}`)
}
{
  const withDecimal = parseTimecode('12:03.5')
  const fullWidthColon = parseTimecode('12：03')
  const numberRounded = parseTimecode(723.4567)
  report('2 "12:03.5"→723.5;全角冒号"12：03"→723;数字输入也按三位小数取整(723.4567→723.457)',
    withDecimal.ok === true && withDecimal.seconds === 723.5 &&
      fullWidthColon.ok === true && fullWidthColon.seconds === 723 &&
      numberRounded.ok === true && numberRounded.seconds === 723.457,
    `${JSON.stringify(withDecimal)} ${JSON.stringify(fullWidthColon)} ${JSON.stringify(numberRounded)}`)
}
{
  const badInputs = ['12:', ':03', '1:2:3:4', '1:2:3:4:5:5:5:5:5:5', 'abc', '', '-5', NaN, null, true]
  const allRejected = badInputs.every((bad) => {
    const result = parseTimecode(bad)
    return result.ok === false && typeof result.reason === 'string' && result.reason.length > 0
  })
  report('3 空段、段数超 3、垃圾、空串、负数、NaN、非数字类型 → 全部 ok:false 且 reason 非空',
    allRejected,
    badInputs.map((bad) => `${String(bad)}=${parseTimecode(bad).ok}`).join(' '))
}
{
  const over59 = parseTimecode('12:60')
  const longHours = parseTimecode('99:59:59')
  report('4 "12:60"(秒超 59)→ ok:false;"99:59:59" → 合法,359999 秒',
    over59.ok === false && longHours.ok === true && longHours.seconds === 359999,
    `${JSON.stringify(over59)} ${JSON.stringify(longHours)}`)
}
{
  const result = parseTimecode('1.5:30')
  report('5 "1.5:30"(小数不在最后一段)→ ok:false',
    result.ok === false && result.reason.length > 0,
    JSON.stringify(result))
}

// ── planFrameRequests ──
{
  // 验收原文写 duration:600,但 12:03=723 秒会被规则 4 钳成 10:00,与验收期望的「12:03」
  // 自相矛盾(规则 4 与验收 13 都要求钳制)——这里用 800 秒片长保住本意,矛盾已列进交付说明
  const result = planFrameRequests({ durationSeconds: 800, times: ['12:03', '00:00'] })
  report('6 ["12:03","00:00"](片长 800)→ 2 个目标、升序、标签 00:00 与 12:03、dropped=0、rejected 空',
    result.ok === true && result.targets.length === 2 &&
      result.targets[0].seconds === 0 && result.targets[0].label === '00:00' &&
      result.targets[1].seconds === 723 && result.targets[1].label === '12:03' &&
      result.dropped === 0 && result.rejected.length === 0,
    JSON.stringify(result))
}
{
  const sameTime = planFrameRequests({ durationSeconds: 800, times: ['12:03', 723] })
  const nearTime = planFrameRequests({ durationSeconds: 800, times: [723, 723.3] })
  report('7 完全相同("12:03" 与 723)→ 1 个;相差 0.3 秒(723 与 723.3)→ 也去重成 1 个',
    sameTime.ok === true && sameTime.targets.length === 1 && sameTime.targets[0].seconds === 723 &&
      nearTime.ok === true && nearTime.targets.length === 1,
    `相同=${JSON.stringify(sameTime)} 相近=${JSON.stringify(nearTime)}`)
}
{
  const middle = planFrameRequests({ durationSeconds: 100, times: [5], offsetsSeconds: [-1, 0, 1] })
  const atZero = planFrameRequests({ durationSeconds: 100, times: [0], offsetsSeconds: [-1, 0, 1] })
  report('8 偏移展开:中间时刻 5±1 秒 → 3 个目标;0 秒时刻展开后钳到非负(-1 并入 0,容差去重后 [0,1])',
    middle.ok === true && middle.targets.length === 3 &&
      middle.targets.map((target) => target.seconds).join(',') === '4,5,6' &&
      atZero.ok === true && atZero.targets.every((target) => target.seconds >= 0) &&
      atZero.targets.map((target) => target.seconds).join(',') === '0,1',
    `中间=${JSON.stringify(middle)} 零=${JSON.stringify(atZero)}`)
}
{
  const result = planFrameRequests({ durationSeconds: 600, times: ['12:03', 'abc', '00:30'] })
  report('9 混入非法值:好的进计划、坏的进 rejected(带原始输入),整体仍 ok:true',
    result.ok === true && result.targets.length === 2 &&
      result.rejected.length === 1 && result.rejected[0].input === 'abc' && result.rejected[0].reason.length > 0,
    JSON.stringify(result))
}
{
  const result = planFrameRequests({ durationSeconds: 600, times: ['abc', ''] })
  report('10 全部非法 → ok:false,reason 说明全部解析失败',
    result.ok === false && result.reason.includes('全部'),
    JSON.stringify(result))
}
{
  const twentyTimes = Array.from({ length: 20 }, (_, index) => (index + 1) * 10)
  const result = planFrameRequests({ durationSeconds: 600, times: twentyTimes, maxFrames: 5 })
  const secondsList = result.ok ? result.targets.map((target) => target.seconds) : []
  const ascending = secondsList.every((value, index) => index === 0 || secondsList[index - 1] < value)
  report('11 20 个时刻、上限 5 → 留 5 个、dropped=15、首(10)尾(200)都还在、升序',
    result.ok === true && result.targets.length === 5 && result.dropped === 15 &&
      secondsList[0] === 10 && secondsList[secondsList.length - 1] === 200 && ascending,
    JSON.stringify(result))
}
{
  const result = planFrameRequests({ durationSeconds: 100, times: [200] })
  report('12 超过片长的时刻(200 秒、片长 100)→ 钳到 100',
    result.ok === true && result.targets.length === 1 && result.targets[0].seconds === 100,
    JSON.stringify(result))
}

// ── locateSubtitleLine ──
{
  const result = locateSubtitleLine([{ from: 10, to: 20, content: '甲句' }], 15)
  report('13 落在句中(问 15,句 10–20)→ 命中,from/to 原样带回',
    result.ok === true && result.found === true && result.text === '甲句' && result.from === 10 && result.to === 20,
    JSON.stringify(result))
}
{
  const result = locateSubtitleLine([
    { from: 10, to: 20, content: '甲句' },
    { from: 25, to: 30, content: '乙句' },
  ], 22)
  report('14 落在空隙(问 22)→ 取最近的前一句(10–20),found 仍为 true',
    result.ok === true && result.found === true && result.text === '甲句' && result.from === 10 && result.to === 20,
    JSON.stringify(result))
}
{
  const result = locateSubtitleLine([{ from: 10, to: 20, content: '甲句' }], 3)
  report('15 比第一句还早(问 3)→ found:false、text 空串、from/to 为 null',
    result.ok === true && result.found === false && result.text === '' && result.from === null && result.to === null,
    JSON.stringify(result))
}
{
  const withDirty = locateSubtitleLine([
    { from: 5 },
    { to: 9, content: '缺 from' },
    { from: 10, to: 20, content: '好句' },
  ], 12)
  const notArray = locateSubtitleLine('nope', 12)
  const badSeconds = locateSubtitleLine([{ from: 10, to: 20, content: 'x' }], Number.NaN)
  report('16 脏条目跳过不报错(仍命中好句);body 不是数组 / seconds 非有限数 → ok:false',
    withDirty.ok === true && withDirty.found === true && withDirty.text === '好句' &&
      notArray.ok === false && badSeconds.ok === false,
    `脏=${JSON.stringify(withDirty)} 非数组=${JSON.stringify(notArray)} 坏秒=${JSON.stringify(badSeconds)}`)
}

console.log(`\n共 ${totalCount} 项,失败 ${failedCount} 项`)
process.exitCode = failedCount === 0 ? 0 : 1
