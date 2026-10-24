/**
 * selftest-subtitle-to-text.mjs —— subtitleToText 的自测
 *
 * 只 import 被测模块;不联网、不读写文件。
 * 全部通过退出码 0,有失败退出码 1;每条用例一行输出。
 * (命名沿用前一模块的约定:不动已交付的 selftest.mjs。)
 */
import { subtitleToText } from '../lib/subtitle-to-text.js'

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

// ── 1 常规三段中文 ──
{
  const payload = {
    body: [
      { from: 0, to: 2.53, content: '大家好' },
      { from: 2.53, to: 6.1, content: '今天聊聊步兵战车' },
      { from: 6.1, to: 9, content: '这期就到这儿' },
    ],
  }
  const result = subtitleToText(payload)
  report(
    '1 常规三段中文 → 拼成一句,total=3 kept=3 dropped=0 chars=17',
    result.ok === true && result.text === '大家好今天聊聊步兵战车这期就到这儿' &&
      result.stats.total === 3 && result.stats.kept === 3 && result.stats.dropped === 0 &&
      result.stats.chars === 17 && result.stats.truncated === false,
    `ok=${result.ok} text=${JSON.stringify(result.text)} stats=${JSON.stringify(result.stats)}`,
  )
}

// ── 2 相邻重复 / 非相邻不误伤 ──
{
  const adjacent = subtitleToText({
    body: [
      { from: 0, to: 1, content: '重复的话' },
      { from: 1, to: 2, content: '重复的话' },
      { from: 2, to: 3, content: '后面是新内容' },
    ],
  })
  const separated = subtitleToText({
    body: [
      { from: 0, to: 1, content: '甲段' },
      { from: 1, to: 2, content: '乙段' },
      { from: 2, to: 3, content: '甲段' },
    ],
  })
  report(
    '2 相邻重复(A,A,B)只留一个 A,dropped=1;隔开的重复(A,B,A)不去重',
    adjacent.ok === true && adjacent.text === '重复的话后面是新内容' && adjacent.stats.dropped === 1 && adjacent.stats.kept === 2 &&
      separated.ok === true && separated.text === '甲段乙段甲段' && separated.stats.dropped === 0,
    `相邻=${JSON.stringify(adjacent)} 隔开=${JSON.stringify(separated)}`,
  )
}

// ── 3 空白、纯标点、换行压缩 ──
{
  const result = subtitleToText({
    body: [
      { from: 0, to: 1, content: '   ' },
      { from: 1, to: 2, content: '。。。' },
      { from: 2, to: 3, content: '第一行\n第二行' },
    ],
  })
  report(
    '3 空白与纯标点被丢弃(dropped=2);换行压成空格',
    result.ok === true && result.text === '第一行 第二行' &&
      result.stats.dropped === 2 && result.stats.kept === 1 && result.stats.chars === 7,
    `ok=${result.ok} text=${JSON.stringify(result.text)} stats=${JSON.stringify(result.stats)}`,
  )
}

// ── 4 英文相邻补空格 ──
{
  const result = subtitleToText({
    body: [
      { from: 0, to: 1, content: 'hello' },
      { from: 1, to: 2, content: 'world' },
    ],
  })
  report(
    '4 英文相邻:hello + world → 「hello world」(恰一个空格)',
    result.ok === true && result.text === 'hello world' && result.stats.chars === 11,
    `ok=${result.ok} text=${JSON.stringify(result.text)}`,
  )
}

// ── 5 中英交界不补空格 ──
{
  const chineseThenEnglish = subtitleToText({
    body: [
      { from: 0, to: 1, content: '你好' },
      { from: 1, to: 2, content: 'world' },
    ],
  })
  const asciiEndChineseStart = subtitleToText({
    body: [
      { from: 0, to: 1, content: '版本2.0' },
      { from: 1, to: 2, content: '发布' },
    ],
  })
  report(
    '5 中英交界不补空格:「你好world」;数字结尾接中文也不补:「版本2.0发布」',
    chineseThenEnglish.ok === true && chineseThenEnglish.text === '你好world' &&
      asciiEndChineseStart.ok === true && asciiEndChineseStart.text === '版本2.0发布',
    `前者=${JSON.stringify(chineseThenEnglish.ok ? chineseThenEnglish.text : chineseThenEnglish.reason)} 后者=${JSON.stringify(asciiEndChineseStart.ok ? asciiEndChineseStart.text : asciiEndChineseStart.reason)}`,
  )
}

// ── 6 时间轴模式 ──
{
  const result = subtitleToText(
    {
      body: [
        { from: 0, to: 1, content: '甲' },
        { from: 65, to: 66, content: '乙' },
        { from: 3661, to: 3662, content: '丙' },
      ],
    },
    { timecodes: true },
  )
  report(
    '6 时间轴:from 0/65/3661 → [00:00] / [01:05] / [1:01:01],一行一句',
    result.ok === true && result.text === '[00:00] 甲\n[01:05] 乙\n[1:01:01] 丙' &&
      result.stats.chars === 31 && result.stats.truncated === false,
    `ok=${result.ok} text=${JSON.stringify(result.text)} stats=${JSON.stringify(result.stats)}`,
  )
}

// ── 7 超预算截断(普通模式) ──
{
  // 100 条、每条 50 字、互不重复(尾部编号),合计 5000 字;条间不产生空格
  const body = Array.from({ length: 100 }, (_, index) => ({
    from: index,
    to: index + 1,
    content: '字'.repeat(47) + String(index).padStart(3, '0'),
  }))
  const result = subtitleToText({ body })
  const marker = '（已截断，原文共 5000 字）'
  report(
    '7 正文 5000 字、预算 4000:截到 4000 + 标注,truncated=true,kept/dropped 不受截断影响',
    result.ok === true && result.stats.chars === 5000 && result.stats.truncated === true &&
      result.stats.kept === 100 && result.stats.dropped === 0 &&
      result.text.length === 4000 + marker.length && result.text.endsWith(marker),
    `ok=${result.ok} stats=${JSON.stringify(result.stats)} 文长=${result.ok ? result.text.length : 0}`,
  )
}

// ── 8 脏数据单条跳过 ──
{
  const result = subtitleToText({
    body: [
      { from: 0, to: 1, content: '第一条' },
      { from: 1, to: 2, content: '第二条' },
      { from: 2, to: 3 },
      { from: '两点', to: 4, content: '第四条' },
      { from: 4, to: 5, content: '第五条' },
    ],
  })
  report(
    '8 第三条缺 content、第四条 from 是字符串 → 各自跳过,其余正常,dropped=2',
    result.ok === true && result.text === '第一条第二条第五条' &&
      result.stats.total === 5 && result.stats.kept === 3 && result.stats.dropped === 2,
    `ok=${result.ok} text=${JSON.stringify(result.text)} stats=${JSON.stringify(result.stats)}`,
  )
}

// ── 9 非法输入(每条一行) ──
{
  const invalidCases = [
    ['9a payload 为 null', subtitleToText(null)],
    ['9b body 不是数组', subtitleToText({ body: 'nope' })],
    ['9c body 为空数组(没有字幕)', subtitleToText({ body: [] })],
    ['9d maxChars = 0', subtitleToText({ body: [{ from: 0, to: 1, content: 'x' }] }, { maxChars: 0 })],
    ['9e maxChars = 3.5', subtitleToText({ body: [{ from: 0, to: 1, content: 'x' }] }, { maxChars: 3.5 })],
  ]
  for (const [name, result] of invalidCases) {
    const noSubtitleCase = name.includes('空数组')
    report(
      name,
      result.ok === false && typeof result.reason === 'string' && result.reason.length > 0 && !('text' in result) &&
        (!noSubtitleCase || result.reason.includes('字幕')),
      `ok=${result.ok} reason=${JSON.stringify(result.reason)}`,
    )
  }
}

// ── 10 时间轴模式下的整行截断 ──
{
  const payload = {
    body: [
      { from: 1, to: 2, content: '甲'.repeat(4) },
      { from: 65, to: 66, content: '乙'.repeat(4) },
    ],
  }
  const marker = (count) => `（已截断，原文共 ${count} 字）`
  const exactFit = subtitleToText(payload, { timecodes: true, maxChars: 12 })
  const midLine = subtitleToText(payload, { timecodes: true, maxChars: 15 })
  const allFit = subtitleToText(payload, { timecodes: true, maxChars: 25 })
  const wholeLinesOnly = (result) => {
    if (result.ok !== true) return false
    return result.text.split('\n').every((line) => line === '[00:01] 甲甲甲甲' || line === '[01:05] 乙乙乙乙' || line === marker(25))
  }
  report(
    '10 时间轴截断按整行:预算 12(恰好一行)/15(卡在第二行中间)都不出半行,预算 25 全放下',
    exactFit.ok === true && exactFit.text === '[00:01] 甲甲甲甲\n' + marker(25) && exactFit.stats.truncated === true &&
      midLine.ok === true && midLine.text === '[00:01] 甲甲甲甲\n' + marker(25) && !midLine.text.includes('[01:05]') &&
      allFit.ok === true && allFit.text === '[00:01] 甲甲甲甲\n[01:05] 乙乙乙乙' && allFit.stats.truncated === false &&
      wholeLinesOnly(exactFit) && wholeLinesOnly(midLine) && wholeLinesOnly(allFit),
    `12=${JSON.stringify(exactFit.ok ? exactFit.text : exactFit.reason)} 15=${JSON.stringify(midLine.ok ? midLine.text : midLine.reason)} 25=${JSON.stringify(allFit.ok ? allFit.text : allFit.reason)}`,
  )
}

console.log(`\n共 ${totalCount} 项,失败 ${failedCount} 项`)
process.exitCode = failedCount === 0 ? 0 : 1
