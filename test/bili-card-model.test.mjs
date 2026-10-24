/**
 * selftest-bili-card-model.mjs —— buildBiliCardModel 的自测
 *
 * 只 import 被测模块和 bili-settings.js(交叉比对用);不联网、不读写文件。
 * 全部通过退出码 0,有失败退出码 1;每条用例一行输出。
 */
import { buildBiliCardModel } from '../lib/bili-card-model.js'
import { describeCredentialCard } from '../lib/bili-settings.js'

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

// ── 1 三入参全缺 ──
{
  const result = buildBiliCardModel({})
  report('1 三个入参全缺 → ok:true、tone:none、banner 空串、hasCredential:false、fields 长度 3',
    result.ok === true && result.status.tone === 'none' && result.banner === '' &&
      result.hasCredential === false && result.fields.length === 3,
    JSON.stringify(result))
}

// ── 2 可用、还剩 180 天 ──
{
  const result = buildBiliCardModel({
    validation: { ok: true, usable: true, expired: false, daysLeft: 180, missing: [], reason: '' },
  })
  report('2 可用、180 天 → tone:ok、文案含 180.0、hasCredential:true、clear 可点、scan.label 重新扫码',
    result.status.tone === 'ok' && result.status.text.includes('180.0') &&
      result.hasCredential === true && result.buttons.clear.enabled === true &&
      result.buttons.scan.label === '重新扫码',
    JSON.stringify(result))
}

// ── 3 没有凭证 ──
{
  const result = buildBiliCardModel({ validation: null })
  report('3 没有凭证 → hasCredential:false、clear.enabled:false、scan.label 扫码登录',
    result.hasCredential === false && result.buttons.clear.enabled === false &&
      result.buttons.scan.label === '扫码登录',
    JSON.stringify(result))
}

// ── 4 一个字段越界 ──
{
  const result = buildBiliCardModel({ config: { peekCount: 2, asrAutoLimitMin: 10, qn: '64' } })
  report('4 peekCount=2(越界)→ 该字段 error 非空,其余两个字段 error 为空(互不影响)',
    result.fields[0].error.length > 0 && result.fields[0].value === 2 &&
      result.fields[1].error === '' && result.fields[2].error === '',
    JSON.stringify(result.fields))
}

// ── 5 config 缺键 ──
{
  const result = buildBiliCardModel({ config: { peekCount: 8 } })
  report('5 config 缺键 → 缺的字段用默认值(asrAutoLimitMin:10、qn:"64"),error 为空',
    result.fields[0].value === 8 && result.fields[1].value === 10 && result.fields[2].value === '64' &&
      result.fields.every((field) => field.error === ''),
    JSON.stringify(result.fields))
}

// ── 6 忙相位:不许再点扫码 ──
{
  const expectations = [
    ['generating', '正在生成二维码…'],
    ['waiting', '请用 B 站手机客户端扫这个二维码'],
    ['scanned', '已扫码，请在手机上点「确认登录」'],
  ]
  const allMatch = expectations.every(([phase, banner]) => {
    const result = buildBiliCardModel({ login: { phase } })
    return result.buttons.scan.enabled === false && result.banner === banner
  })
  report('6 generating/waiting/scanned → scan.enabled 全 false,banner 分别是那三句(逐字)',
    allMatch,
    JSON.stringify(expectations.map(([phase]) => buildBiliCardModel({ login: { phase } }).banner)))
}

// ── 7 error 相位 ──
{
  const withReason = buildBiliCardModel({ login: { phase: 'error', reason: '被风控' } })
  const noReason = buildBiliCardModel({ login: { phase: 'error', reason: '' } })
  report("7 phase:error + reason:被风控 → scan.enabled:true、banner 含「被风控」;reason 空 → 「登录出错」",
    withReason.buttons.scan.enabled === true && withReason.banner.includes('被风控') &&
      noReason.banner === '登录出错',
    `${withReason.banner} | ${noReason.banner}`)
}

// ── 8 success 相位 ──
{
  const result = buildBiliCardModel({ login: { phase: 'success' } })
  report('8 phase:success → banner 含「登录成功」、scan.enabled:true',
    result.banner.includes('登录成功') && result.buttons.scan.enabled === true,
    JSON.stringify(result.banner))
}

// ── 9 login 为 null / 垃圾 phase ──
{
  const nullLogin = buildBiliCardModel({ login: null })
  const garbagePhase = buildBiliCardModel({ login: { phase: 'zzz' } })
  const expiredBanner = buildBiliCardModel({ login: { phase: 'expired' } })
  report('9 login:null / phase 垃圾 → 按 idle 处理(scan 可点、banner 空);补验 expired 的横幅',
    nullLogin.buttons.scan.enabled === true && nullLogin.banner === '' &&
      garbagePhase.buttons.scan.enabled === true && garbagePhase.banner === '' &&
      expiredBanner.banner === '二维码过期了，点「重新扫码」再来一次',
    `${nullLogin.banner}|${garbagePhase.banner}|${expiredBanner.banner}`)
}

// ── 10 非法 input ──
{
  const nullInput = buildBiliCardModel(null)
  const arrayInput = buildBiliCardModel([])
  report('10 input 传 null / 数组 → ok:false',
    nullInput.ok === false && arrayInput.ok === false,
    `${JSON.stringify(nullInput)} ${JSON.stringify(arrayInput)}`)
}

// ── 11(自加)交叉比对:本模块重写的 status 与 bili-settings.js 的实现不许漂移 ──
{
  const battery = [
    null,
    { ok: false, reason: '结构不认识' },
    { ok: true, usable: false, expired: true, daysLeft: -1, missing: [], reason: '凭证已过期' },
    { ok: true, usable: false, expired: false, daysLeft: null, missing: ['SESSDATA'], reason: '凭证不完整:缺 SESSDATA' },
    { ok: true, usable: true, expired: false, daysLeft: null, missing: [], reason: '' },
    { ok: true, usable: true, expired: false, daysLeft: 180, missing: [], reason: '' },
    { ok: true, usable: true, expired: false, daysLeft: 5, missing: [], reason: '' },
    { ok: true, usable: true, expired: false, daysLeft: 7, missing: [], reason: '' },
    { ok: true, usable: true, expired: false, daysLeft: 7.1, missing: [], reason: '' },
    { ok: true, usable: true, expired: false, daysLeft: 0, missing: [], reason: '' },
  ]
  const noDrift = battery.every((validation) => {
    const mine = buildBiliCardModel({ validation }).status
    const reference = describeCredentialCard(validation)
    return mine.text === reference.text && mine.tone === reference.tone &&
      mine.daysLeft === reference.daysLeft && mine.actionLabel === reference.actionLabel
  })
  report('11(自加)交叉比对:重写的 status 与 bili-settings.js 的 describeCredentialCard 十种输入全一致',
    noDrift,
    '')
}

// ── 12(自加)形状与顺序 ──
{
  const result = buildBiliCardModel({ config: { qn: '80', peekCount: 4 } })
  const keys = result.fields.map((field) => field.key).join(',')
  const peek = result.fields[0]
  const qn = result.fields[2]
  const shapeOk = result.fields.every(
    (field) => (typeof field.value === 'number' || typeof field.value === 'string') &&
      typeof field.error === 'string' && typeof field.label === 'string',
  )
  report('12(自加)fields 固定顺序;unit/min/max/options 按定义透传(qn.unit:null、options 数组;int.options:null);value 永远数字或字符串;refresh 恒可点',
    keys === 'peekCount,asrAutoLimitMin,qn' &&
      qn.unit === null && Array.isArray(qn.options) && qn.options.join(',') === '32,64,80' &&
      peek.options === null && peek.unit === '帧' &&
      shapeOk && result.buttons.refresh.enabled === true,
    JSON.stringify(result.fields))
}

console.log(`\n共 ${totalCount} 项,失败 ${failedCount} 项`)
process.exitCode = failedCount === 0 ? 0 : 1
