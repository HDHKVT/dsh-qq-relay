/**
 * selftest-credential.mjs —— normalizeCredential / validateCredential 的自测
 *
 * 只 import 被测模块;不联网、不读写文件。
 * 全部通过退出码 0,有失败退出码 1;每条用例一行输出。
 */
import { normalizeCredential, validateCredential } from '../lib/credential.js'

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

// ── normalizeCredential ──
{
  const fragment = normalizeCredential('SESSDATA=abc%2C123')
  const longValue = 'a%2Cb'.repeat(5000)
  const long = normalizeCredential(`SESSDATA=${longValue}`)
  report("1 'SESSDATA=abc%2C123' → cookies.SESSDATA 原样(没解码);5000+ 字符长值同样往返",
    fragment.ok === true && fragment.record.cookies.SESSDATA === 'abc%2C123' &&
      long.ok === true && long.record.cookies.SESSDATA === longValue,
    `${JSON.stringify(fragment)} 长值ok=${long.ok}`)
}
{
  const result = normalizeCredential('abc%2C123')
  report("2 'abc%2C123'(不含 =)→ 整串当作 SESSDATA 的值",
    result.ok === true && result.record.cookies.SESSDATA === 'abc%2C123',
    JSON.stringify(result))
}
{
  const result = normalizeCredential('SESSDATA=abc; bili_jct=jj; DedeUserID=42; 未知字段=x')
  const keys = result.ok ? Object.keys(result.record.cookies).sort() : []
  report('3 完整 cookie 头:三个认识的字段都在,未知字段被丢掉',
    result.ok === true && keys.join(',') === 'DedeUserID,SESSDATA,bili_jct' &&
      result.record.cookies.DedeUserID === '42',
    JSON.stringify(result))
}
{
  const result = normalizeCredential({ SESSDATA: 'abc', bili_jct: 'jj' })
  report('4 对象形式 {SESSDATA, bili_jct} → 两个字段都在',
    result.ok === true && result.record.cookies.SESSDATA === 'abc' && result.record.cookies.bili_jct === 'jj',
    JSON.stringify(result))
}
{
  const result = normalizeCredential({ cookie: 'SESSDATA=abc' })
  report("5 {cookie:'SESSDATA=abc'} → 从 cookie 字段里解析出来",
    result.ok === true && result.record.cookies.SESSDATA === 'abc',
    JSON.stringify(result))
}
{
  const result = normalizeCredential({ cookie: 'SESSDATA=abc; bili_jct=jj', SESSDATA: 'xyz' })
  report('6 对象同时有 cookie 字段和自身 SESSDATA 且值不同 → 对象上的覆盖 cookie 里解析出的',
    result.ok === true && result.record.cookies.SESSDATA === 'xyz' && result.record.cookies.bili_jct === 'jj',
    JSON.stringify(result))
}
{
  const result = normalizeCredential('bili_jct=jj')
  report("7 'bili_jct=jj'(没有 SESSDATA)→ ok:false,reason 含「SESSDATA」",
    result.ok === false && result.reason.includes('SESSDATA'),
    JSON.stringify(result))
}
{
  const shapes = [null, undefined, 42, [], true]
  const allRejected = shapes.every((shape) => {
    const result = normalizeCredential(shape)
    return result.ok === false && String(result.reason).length > 0
  })
  report('8 null / undefined / 42 / [] / true → 全部 ok:false',
    allRejected,
    shapes.map((shape) => normalizeCredential(shape).ok).join(','))
}
{
  const badTimes = normalizeCredential({ SESSDATA: 'abc' }, { savedAtMs: 'x', expiresAtMs: 'y' })
  const goodTimes = normalizeCredential({ SESSDATA: 'abc' }, { savedAtMs: 123, expiresAtMs: 456 })
  report('9 savedAtMs/expiresAtMs 传字符串 → 存 null 不报错;传数字 → 原样保留',
    badTimes.ok === true && badTimes.record.savedAtMs === null && badTimes.record.expiresAtMs === null &&
      goodTimes.ok === true && goodTimes.record.savedAtMs === 123 && goodTimes.record.expiresAtMs === 456,
    `${JSON.stringify(badTimes)} ${JSON.stringify(goodTimes)}`)
}

// ── validateCredential ──
{
  const result = validateCredential({
    cookies: { SESSDATA: 'a', bili_jct: 'j', DedeUserID: '1', DedeUserID__ckMd5: 'm', buvid3: 'b' },
  }, { nowMs: 1000000 })
  report('10 完整记录、无过期时间 → usable:true、expired:false、missing:[]、daysLeft:null',
    result.ok === true && result.usable === true && result.expired === false &&
      result.missing.length === 0 && result.daysLeft === null && result.reason === '',
    JSON.stringify(result))
}
{
  const result = validateCredential({ cookies: { SESSDATA: 'a' } }, { nowMs: 1000000 })
  report('11 只有 SESSDATA → usable:true,missing 是其余四个且按固定顺序',
    result.ok === true && result.usable === true &&
      JSON.stringify(result.missing) === JSON.stringify(['bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3']),
    JSON.stringify(result))
}
{
  const result = validateCredential({ cookies: { bili_jct: 'j' } }, { nowMs: 1000000 })
  report('12 缺 SESSDATA → usable:false、reason 含「SESSDATA」',
    result.ok === true && result.usable === false && result.reason.includes('SESSDATA'),
    JSON.stringify(result))
}
{
  // 故意让这份过期凭证同时也缺 SESSDATA,验证「过期优先于缺字段」的口径
  const result = validateCredential(
    { cookies: { bili_jct: 'j' }, expiresAtMs: 1000 },
    { nowMs: 5000 },
  )
  report('13 已过期(且同时缺 SESSDATA)→ expired:true、usable:false、reason 是「凭证已过期」,不再提缺字段',
    result.ok === true && result.expired === true && result.usable === false &&
      result.reason === '凭证已过期' && !result.reason.includes('缺'),
    JSON.stringify(result))
}
{
  const nowMs = 1000000000000
  const result = validateCredential(
    { cookies: { SESSDATA: 'a' }, expiresAtMs: nowMs + 30 * 86400000 },
    { nowMs },
  )
  report('14 30 天后过期 → daysLeft:30.0、usable:true、expired:false',
    result.ok === true && result.daysLeft === 30 && result.usable === true && result.expired === false,
    JSON.stringify(result))
}
{
  const noCookies = validateCredential({}, { nowMs: 1000 })
  const badCookies = validateCredential({ cookies: 'x' }, { nowMs: 1000 })
  const nullRecord = validateCredential(null, { nowMs: 1000 })
  report('15 record 不是对象 / record.cookies 不是对象 → ok:false',
    noCookies.ok === false && badCookies.ok === false && nullRecord.ok === false,
    `${JSON.stringify(noCookies)} ${JSON.stringify(badCookies)} ${JSON.stringify(nullRecord)}`)
}
{
  const result = validateCredential({ cookies: { SESSDATA: 'a' } }, { nowMs: Number.NaN })
  report('16 nowMs 传 NaN → 退回 Date.now(),不报错,结论照常可用',
    result.ok === true && result.usable === true && result.daysLeft === null,
    JSON.stringify(result))
}

console.log(`\n共 ${totalCount} 项,失败 ${failedCount} 项`)
process.exitCode = failedCount === 0 ? 0 : 1
