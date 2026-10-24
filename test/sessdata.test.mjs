/**
 * selftest-sessdata.mjs —— parseSessdataExpiry / redactCredential 的自测
 *
 * 只 import 被测模块;不联网、不读写文件。
 * 全部通过退出码 0,有失败退出码 1;每条用例一行输出。
 */
import { parseSessdataExpiry, redactCredential } from '../lib/sessdata.js'

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

// ── parseSessdataExpiry ──
{
  const result = parseSessdataExpiry('0123abcd%2C1800000000%2C70201%2Aabc')
  report("1 真实样本(带 %2C/%2A 编码)→ expiresAtMs === 1800000000000",
    result.ok === true && result.expiresAtMs === 1800000000000,
    JSON.stringify(result))
}
{
  const result = parseSessdataExpiry('0123abcd,1800000000,70201')
  report('2 已解码的裸逗号形式 → 同样结果(两种编码都认)',
    result.ok === true && result.expiresAtMs === 1800000000000,
    JSON.stringify(result))
}
{
  const result = parseSessdataExpiry('abc,1800000000')
  report('3 只有两段 → 第 2 段就是过期时间,仍能解析',
    result.ok === true && result.expiresAtMs === 1800000000000,
    JSON.stringify(result))
}
{
  const result = parseSessdataExpiry('abc123')
  report('4 没有逗号 → ok:false,reason 含「过期」二字',
    result.ok === false && result.reason.includes('过期'),
    JSON.stringify(result))
}
{
  const result = parseSessdataExpiry('abc,xyz,123')
  report('5 第 2 段不是数字 → ok:false',
    result.ok === false && String(result.reason).length > 0,
    JSON.stringify(result))
}
{
  const result = parseSessdataExpiry('abc,1800000000000')
  report('6 第 2 段是毫秒(1800000000000)→ 落在 2100 年之外,ok:false,reason 含「不合理」',
    result.ok === false && result.reason.includes('不合理'),
    JSON.stringify(result))
}
{
  const shapes = ['', null, 42]
  const allRejected = shapes.every((shape) => parseSessdataExpiry(shape).ok === false)
  report("7 '' / null / 42 → 全部 ok:false",
    allRejected,
    shapes.map((shape) => parseSessdataExpiry(shape).ok).join(','))
}
{
  const result = parseSessdataExpiry('abc%ZZ,1800000000')
  report("8 坏编码 'abc%ZZ,…'(decodeURIComponent 会抛)→ 不抛异常,按原串解析成功",
    result.ok === true && result.expiresAtMs === 1800000000000,
    JSON.stringify(result))
}

// ── redactCredential ──
{
  const longValue = 'A2c4' + 'm'.repeat(213) + 'Z9x8'
  const result = redactCredential({ SESSDATA: longValue })
  report('9 221 字符真实长度 → 前 4 后 4 中间 ***,输出不包含原值',
    result.ok === true && result.text === 'SESSDATA=A2c4***Z9x8' && !result.text.includes(longValue),
    JSON.stringify(result))
}
{
  const result = redactCredential({ bili_jct: 'abc123' })
  report('10 短值(≤8 字符)→ 整个变成 ***',
    result.ok === true && result.text === 'bili_jct=***',
    JSON.stringify(result))
}
{
  const cookies = {
    buvid3: 'XY7890abc123456def',
    SESSDATA: '0123abcd,1800000000,70201xxxx',
    DedeUserID__ckMd5: 'abcdef0123456789',
    bili_jct: 'jj1234567890',
    DedeUserID: '123456789',
  }
  const result = redactCredential(cookies)
  report('11 五个字段齐全(故意乱序传入)→ 按固定顺序输出、分隔是「; 」',
    result.ok === true &&
      result.text === 'SESSDATA=0123***xxxx; bili_jct=jj12***7890; DedeUserID=1234***6789; DedeUserID__ckMd5=abcd***6789; buvid3=XY78***6def',
    JSON.stringify(result))
}
{
  const partial = redactCredential({ SESSDATA: '', bili_jct: 'x' })
  const allEmpty = redactCredential({ SESSDATA: '', bili_jct: '', DedeUserID: '' })
  report('12 空值和缺失字段被跳过;全空 → ok:false',
    partial.ok === true && partial.text === 'bili_jct=***' &&
      allEmpty.ok === false && allEmpty.reason.includes('脱敏'),
    `部分=${JSON.stringify(partial)} 全空=${JSON.stringify(allEmpty)}`)
}
{
  const nullCookies = redactCredential(null)
  const arrayCookies = redactCredential([])
  report('13 cookies 传 null / 数组 → ok:false',
    nullCookies.ok === false && arrayCookies.ok === false,
    `${JSON.stringify(nullCookies)} ${JSON.stringify(arrayCookies)}`)
}
{
  // 自己加的一条:锁死契约规则 6 的硬要求——值恰好长得像自己的脱敏产物时,
  // 常规格式会把原值原样吐出来,必须整体打码兜底
  const pathological = redactCredential({ SESSDATA: 'abcd***fghi' })
  const duplicated = redactCredential({ SESSDATA: 'abcd***fghiXX', bili_jct: 'abcd***fghiXX' })
  report('14 病理值自检:值长得像自己的脱敏产物 / 两字段同值 → 输出仍不含完整原值',
    pathological.ok === true && !pathological.text.includes('abcd***fghi') &&
      duplicated.ok === true && !duplicated.text.includes('abcd***fghiXX'),
    `${JSON.stringify(pathological)} ${JSON.stringify(duplicated)}`)
}

console.log(`\n共 ${totalCount} 项,失败 ${failedCount} 项`)
process.exitCode = failedCount === 0 ? 0 : 1
