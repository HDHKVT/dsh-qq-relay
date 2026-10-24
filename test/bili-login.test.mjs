/**
 * selftest-bili-login.mjs —— interpretQrPoll / extractLoginCookies / buildCookieHeader / credentialHealth 的自测
 *
 * 只 import 被测模块;不联网、不读写文件。
 * 全部通过退出码 0,有失败退出码 1;每条用例一行输出。
 */
import { interpretQrPoll, extractLoginCookies, buildCookieHeader, credentialHealth } from '../lib/bili-login.js'

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

const qrPayload = (innerCode, extraData = {}) => ({
  code: 0,
  message: '0',
  data: { code: innerCode, message: '', ...extraData },
})

// ── 接口一:interpretQrPoll ──
{
  const pending = interpretQrPoll(qrPayload(86101))
  const scanned = interpretQrPoll(qrPayload(86090))
  const expired = interpretQrPoll(qrPayload(86038))
  report('1 内层 86101→pending;86090→scanned;86038→expired(rawStateCode 各自回填)',
    pending.state === 'pending' && pending.rawStateCode === 86101 &&
      scanned.state === 'scanned' && expired.state === 'expired' && expired.rawStateCode === 86038,
    `86101=${JSON.stringify(pending)} 86090=${JSON.stringify(scanned)} 86038=${JSON.stringify(expired)}`)
}
{
  const confirmedUrl = 'https://passport.biligame.com/crossDomain?SESSDATA=xxx&bili_jct=yyy'
  const result = interpretQrPoll(qrPayload(0, { url: confirmedUrl, refresh_token: 'abcdef', timestamp: 1790000000000 }))
  report('2 内层 0 且带 url → confirmed,redirectUrl 原样带回',
    result.ok === true && result.state === 'confirmed' && result.redirectUrl === confirmedUrl && result.rawStateCode === 0,
    JSON.stringify(result))
}
{
  const result = interpretQrPoll({ code: 0, message: '0', data: { code: 86101, message: '' } })
  report('3 坑位测试:外层 0 + 内层 86101 → 必须 pending,不许 confirmed',
    result.ok === true && result.state === 'pending' && result.state !== 'confirmed' && result.redirectUrl === '',
    JSON.stringify(result))
}
{
  const result = interpretQrPoll({ code: -101, data: { code: 0 } })
  report('4 外层 code:-101 → ok:false',
    result.ok === false && String(result.reason).length > 0,
    JSON.stringify(result))
}
{
  const result = interpretQrPoll({ code: 0 })
  report('5 data 缺失 → ok:false',
    result.ok === false && String(result.reason).length > 0,
    JSON.stringify(result))
}
{
  const result = interpretQrPoll(qrPayload(12345))
  report('6 内层未知码 12345 → state:error,rawStateCode:12345',
    result.ok === true && result.state === 'error' && result.rawStateCode === 12345 && result.reason.includes('12345'),
    JSON.stringify(result))
}

// ── 接口二:extractLoginCookies ──
{
  const result = extractLoginCookies({
    redirectUrl: 'https://passport.biligame.com/crossDomain?SESSDATA=url%2Csess&bili_jct=urljct',
  })
  report('7 只给 redirectUrl(SESSDATA+bili_jct)→ 两个都拿到且 %2C 原样保留,missing 是其余三个',
    result.ok === true && result.cookies.SESSDATA === 'url%2Csess' && result.cookies.bili_jct === 'urljct' &&
      JSON.stringify(result.missing) === JSON.stringify(['DedeUserID', 'DedeUserID__ckMd5', 'sid']),
    JSON.stringify(result))
}
{
  const result = extractLoginCookies({
    setCookieHeaders: [
      'SESSDATA=abc%2Cdef; Path=/; Expires=Fri, 01 Jan 2027 00:00:00 GMT; HttpOnly',
      'DedeUserID=42; Path=/',
    ],
  })
  report('8 只给两条 Set-Cookie → 正确解析 name=value,Path/Expires/HttpOnly 全忽略,%2C 不解码',
    result.ok === true && result.cookies.SESSDATA === 'abc%2Cdef' && result.cookies.DedeUserID === '42' &&
      result.missing.includes('bili_jct'),
    JSON.stringify(result))
}
{
  const result = extractLoginCookies({
    redirectUrl: 'https://passport.biligame.com/crossDomain?SESSDATA=fromUrl',
    setCookieHeaders: ['SESSDATA=fromHeader; Path=/'],
  })
  report('9 两边都有 SESSDATA 且值不同 → 取 redirectUrl 那份',
    result.ok === true && result.cookies.SESSDATA === 'fromUrl',
    JSON.stringify(result))
}
{
  const result = extractLoginCookies({ setCookieHeaders: ['bili_jct=x; Path=/' ] })
  const alsoFromUrl = extractLoginCookies({ redirectUrl: 'https://host/crossDomain?bili_jct=y' })
  report('10 SESSDATA 缺失(Set-Cookie 版和 redirectUrl 版)→ 都是 ok:false',
    result.ok === false && String(result.reason).length > 0 && alsoFromUrl.ok === false,
    `header=${JSON.stringify(result)} url=${JSON.stringify(alsoFromUrl)}`)
}
{
  const result = extractLoginCookies(null)
  report('11 input 为 null → 也按 SESSDATA 缺失处理,ok:false 不抛错',
    result.ok === false,
    JSON.stringify(result))
}

// ── 接口三:buildCookieHeader ──
{
  const result = buildCookieHeader({ buvid3: 'bbb', SESSDATA: 'sss', bili_jct: 'jjj' })
  report('12 三字段乱序传入 → 按固定顺序输出,分隔是「; 」',
    result.ok === true && result.header === 'SESSDATA=sss; bili_jct=jjj; buvid3=bbb',
    JSON.stringify(result))
}
{
  const empty = buildCookieHeader({})
  const withBlank = buildCookieHeader({ SESSDATA: '', bili_jct: 'jjj' })
  report('13 空对象 → ok:false;空串字段被跳过',
    empty.ok === false && withBlank.ok === true && withBlank.header === 'bili_jct=jjj',
    `空=${JSON.stringify(empty)} 空串=${JSON.stringify(withBlank)}`)
}

// ── 接口四:credentialHealth ──
{
  const nowMs = 1000000000000
  const result = credentialHealth({ expiresAtMs: nowMs + 30 * 86400000, savedAtMs: nowMs - 86400000 }, nowMs)
  report('14 30 天后过期 → fresh:true,daysLeft:30.0',
    result.ok === true && result.fresh === true && result.daysLeft === 30,
    JSON.stringify(result))
}
{
  const nowMs = 1000000000000
  const result = credentialHealth({ expiresAtMs: nowMs - 86400000 }, nowMs)
  report('15 已过期一天 → fresh:false,daysLeft 为负(-1.0)',
    result.ok === true && result.fresh === false && result.daysLeft === -1,
    JSON.stringify(result))
}
{
  const noExpiry = credentialHealth({ savedAtMs: 'garbage' }, 1000000000000)
  const badNow = credentialHealth({ expiresAtMs: 2000000000000 }, Number.NaN)
  report('16 没有 expiresAtMs → fresh:true,daysLeft:null;nowMs=NaN → fresh:false',
    noExpiry.ok === true && noExpiry.fresh === true && noExpiry.daysLeft === null &&
      badNow.ok === true && badNow.fresh === false && badNow.daysLeft === null,
    `无过期=${JSON.stringify(noExpiry)} 坏now=${JSON.stringify(badNow)}`)
}

console.log(`\n共 ${totalCount} 项,失败 ${failedCount} 项`)
process.exitCode = failedCount === 0 ? 0 : 1
