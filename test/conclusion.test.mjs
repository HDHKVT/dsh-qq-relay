/**
 * selftest-conclusion.mjs —— parseVideoConclusion / pickFrameTargets 的自测
 *
 * 只 import 被测模块;不联网、不读写文件。
 * 全部通过退出码 0,有失败退出码 1;每条用例一行输出。
 */
import { parseVideoConclusion, pickFrameTargets } from '../lib/conclusion.js'

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

/** 验收 1 说「2 个 section」,契约示例 JSON 只有 1 个——测试按验收口径构造 2 个 */
const twoSections = {
  summary: '库克15年领导苹果从濒临破产到市值超5万亿美元',
  outline: [
    {
      title: '库克时代苹果转型与挑战',
      timestamp: 1,
      part_outline: [
        { timestamp: 25, content: '库克首任CEO发布iPhone 4s平淡升级' },
        { timestamp: 84, content: '库克15年重构苹果供应链' },
      ],
    },
    {
      title: '市值与供应链',
      part_outline: [
        { timestamp: 200, content: '第二部分要点一' },
        { timestamp: 300, content: '第二部分要点二' },
      ],
    },
  ],
}

const parsedOf = (points) => ({
  ok: true,
  summary: '',
  sections: [{ title: '节', points: points.map((seconds) => ({ timeSeconds: seconds, content: `第${seconds}秒的要点` })) }],
  pointCount: points.length,
})

// ── parseVideoConclusion ──
{
  const result = parseVideoConclusion(twoSections)
  const firstSectionPoints = result.ok ? result.sections[0].points : []
  report('1 正常输入:summary 原样、2 个 section、pointCount=4、节内要点升序',
    result.ok === true && result.summary === twoSections.summary &&
      result.sections.length === 2 && result.pointCount === 4 &&
      result.sections[0].title === '库克时代苹果转型与挑战' &&
      firstSectionPoints.map((point) => point.timeSeconds).join(',') === '25,84',
    JSON.stringify(result))
}
{
  const unwrapped = parseVideoConclusion({ model_result: twoSections })
  const direct = parseVideoConclusion(twoSections)
  report('1b 传 data(带 model_result 一层)与直接传 model_result,输出完全一致',
    unwrapped.ok === true && JSON.stringify(unwrapped) === JSON.stringify(direct),
    JSON.stringify(unwrapped))
}
{
  const missingSummary = parseVideoConclusion({ outline: twoSections.outline })
  const wrongTypeSummary = parseVideoConclusion({ summary: 123, outline: twoSections.outline })
  report('2 summary 缺失/不是字符串 → 空串,sections 照常解析,ok:true',
    missingSummary.ok === true && missingSummary.summary === '' && missingSummary.sections.length === 2 &&
      wrongTypeSummary.ok === true && wrongTypeSummary.summary === '',
    `缺=${JSON.stringify(missingSummary.ok)} 坏类型=${JSON.stringify(wrongTypeSummary.summary)}`)
}
{
  const result = parseVideoConclusion({ summary: '只有摘要', outline: 'nope' })
  report('3 outline 不是数组 → sections 为空数组、ok:true',
    result.ok === true && Array.isArray(result.sections) && result.sections.length === 0 && result.pointCount === 0,
    JSON.stringify(result))
}
{
  const result = parseVideoConclusion({
    outline: [{
      title: '脏数据节',
      part_outline: [
        { timestamp: '25', content: '时间戳是字符串' },
        { timestamp: 30, content: '' },
        { timestamp: 40, content: '好的要点' },
      ],
    }],
  })
  report('4 时间戳字符串与空 content 的要点被丢掉,其余正常',
    result.ok === true && result.pointCount === 1 &&
      result.sections[0].points[0].timeSeconds === 40 && result.sections[0].points[0].content === '好的要点',
    JSON.stringify(result))
}
{
  // 契约示例的 3、1、2 是连续整数,任意相邻两条都差 1 秒、必被规则 7 去重,
  // 无法单独验证排序——这里用间隔开的 30、10、20 验证排序本身
  const result = parseVideoConclusion({
    outline: [{
      part_outline: [
        { timestamp: 30, content: '三十' },
        { timestamp: 10, content: '十' },
        { timestamp: 20, content: '二十' },
      ],
    }],
  })
  report('5 要点乱序(30、10、20,间隔大于容差)→ 输出按时间升序 10,20,30',
    result.ok === true && result.sections[0].points.map((point) => point.timeSeconds).join(',') === '10,20,30',
    JSON.stringify(result))
}
{
  const result = parseVideoConclusion({
    outline: [{
      part_outline: [
        { timestamp: 5, content: '第一条' },
        { timestamp: 6, content: '第二条' },
      ],
    }],
  })
  report('6 同节相差 1 秒(≤ 容差)→ 去重成一条,保留先出现的「第一条」',
    result.ok === true && result.pointCount === 1 && result.sections[0].points[0].content === '第一条',
    JSON.stringify(result))
}
{
  const nullPayload = parseVideoConclusion(null)
  const arrayPayload = parseVideoConclusion([])
  report('7 payload 为 null / [] → ok:false',
    nullPayload.ok === false && arrayPayload.ok === false &&
      String(nullPayload.reason).length > 0 && String(arrayPayload.reason).length > 0,
    `null=${JSON.stringify(nullPayload)} []=${JSON.stringify(arrayPayload)}`)
}

// ── pickFrameTargets ──
{
  const result = pickFrameTargets({ conclusion: parsedOf([60, 10, 50, 20, 40, 30]), durationSeconds: 100 })
  report('8 只给 conclusion(6 要点)、limit 默认 6 → 6 个点全来自 outline、升序、dropped=0',
    result.ok === true && result.targets.length === 6 && result.dropped === 0 &&
      result.targets.every((target) => target.source === 'outline') &&
      result.targets.map((target) => target.seconds).join(',') === '10,20,30,40,50,60' &&
      result.targets[0].label === '00:10',
    JSON.stringify(result))
}
{
  const result = pickFrameTargets({
    viewPoints: [
      { from: 50, to: 60, content: '第三章' },
      { from: 5, to: 9, content: '第一章' },
      { from: 80, to: 90, content: '第四章' },
    ],
    durationSeconds: 100,
  })
  report('9 只给 viewPoints(3 章)→ 3 个点全来自 chapter、时间为各章 from 升序',
    result.ok === true && result.targets.length === 3 && result.dropped === 0 &&
      result.targets.every((target) => target.source === 'chapter') &&
      result.targets.map((target) => target.seconds).join(',') === '5,50,80' &&
      result.targets[0].note === '第一章',
    JSON.stringify(result))
}
{
  const result = pickFrameTargets({
    conclusion: parsedOf([10, 20]),
    viewPoints: [
      { from: 30, to: 40, content: '章一' },
      { from: 45, to: 50, content: '章二' },
      { from: 55, to: 60, content: '章三' },
    ],
    durationSeconds: 100,
    limit: 4,
  })
  report('10 两者都给:大纲 2 点 + limit 4 → 前 2 个 outline、后 2 个 chapter(章节超名额也均匀挑:取 30 与 55,中间 45 让位)',
    result.ok === true && result.targets.length === 4 &&
      result.targets.map((target) => target.source).join(',') === 'outline,outline,chapter,chapter' &&
      result.targets.map((target) => target.seconds).join(',') === '10,20,30,55' &&
      result.dropped === 1,
    JSON.stringify(result))
}
{
  const result = pickFrameTargets({
    conclusion: parsedOf([100]),
    viewPoints: [{ from: 101, to: 120, content: '近的章节' }],
    durationSeconds: 200,
  })
  report('11 去重:大纲点 100 与章节起点 101 相差 1 秒(≤2)→ 只留 outline,dropped≥1',
    result.ok === true && result.targets.length === 1 && result.targets[0].source === 'outline' &&
      result.targets[0].seconds === 100 && result.dropped >= 1,
    JSON.stringify(result))
}
{
  const result = pickFrameTargets({ conclusion: parsedOf([9999]), durationSeconds: 600 })
  report('12 钳制:大纲点 9999 秒、片长 600 → 输出 600、标签 10:00',
    result.ok === true && result.targets.length === 1 && result.targets[0].seconds === 600 &&
      result.targets[0].label === '10:00',
    JSON.stringify(result))
}
{
  const bothEmpty = pickFrameTargets({ durationSeconds: 100 })
  const explicitEmpty = pickFrameTargets({ conclusion: null, viewPoints: [], durationSeconds: 100 })
  report('13 两者都空 → ok:true、targets:[]、dropped:0(不算失败)',
    bothEmpty.ok === true && bothEmpty.targets.length === 0 && bothEmpty.dropped === 0 &&
      explicitEmpty.ok === true && explicitEmpty.targets.length === 0,
    `空=${JSON.stringify(bothEmpty)} 显式空=${JSON.stringify(explicitEmpty)}`)
}
{
  const zero = pickFrameTargets({ conclusion: parsedOf([10, 20, 30, 40, 50, 60, 70, 80]), durationSeconds: 100, limit: 0 })
  const negative = pickFrameTargets({ conclusion: parsedOf([10, 20, 30, 40, 50, 60, 70, 80]), durationSeconds: 100, limit: -3 })
  report('14 limit 传 0 或负数 → 退回 6(8 个候选 → 留 6、dropped=2),不报错',
    zero.ok === true && zero.targets.length === 6 && zero.dropped === 2 &&
      negative.ok === true && negative.targets.length === 6,
    `零=${JSON.stringify(zero)} 负=${JSON.stringify(negative)}`)
}
{
  const result = pickFrameTargets({ durationSeconds: 0 })
  report('15 durationSeconds 传 0 → ok:false',
    result.ok === false && String(result.reason).length > 0,
    JSON.stringify(result))
}
{
  const fifteen = Array.from({ length: 15 }, (_, index) => index * 100)
  const result = pickFrameTargets({ conclusion: parsedOf(fifteen), durationSeconds: 1500, limit: 6 })
  const secondsList = result.ok ? result.targets.map((target) => target.seconds) : []
  report('16 均匀挑选:15 个等间隔要点(0..1400)、limit 6 → 下标 0,3,6,8,11,14(即 0/300/600/800/1100/1400),首尾都在,不许是前 6 个连续',
    result.ok === true && JSON.stringify(secondsList) === JSON.stringify([0, 300, 600, 800, 1100, 1400]) &&
      result.dropped === 9 && result.targets.every((target) => target.source === 'outline') &&
      JSON.stringify(secondsList) !== JSON.stringify([0, 100, 200, 300, 400, 500]),
    JSON.stringify(result))
}
{
  // 15 个候选里 201 与 200、902 与 900 相差 ≤2 秒,先被并掉 → 实际 13 个候选再均匀挑
  const withNearPairs = [0, 100, 200, 201, 400, 500, 600, 700, 800, 900, 902, 1000, 1100, 1200, 1400]
  const result = pickFrameTargets({ conclusion: parsedOf(withNearPairs), durationSeconds: 1500, limit: 6 })
  const secondsList = result.ok ? result.targets.map((target) => target.seconds) : []
  report('17 均匀挑选 + 去重:15 并成 13 → 按 13 个的均匀下标(0,2,5,7,10,12)挑,首尾仍在,dropped=2(去重)+7(上限)',
    result.ok === true && JSON.stringify(secondsList) === JSON.stringify([0, 200, 600, 800, 1100, 1400]) &&
      result.dropped === 9 &&
      secondsList[0] === 0 && secondsList[secondsList.length - 1] === 1400,
    JSON.stringify(result))
}

console.log(`\n共 ${totalCount} 项,失败 ${failedCount} 项`)
process.exitCode = failedCount === 0 ? 0 : 1
