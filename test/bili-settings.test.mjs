/**
 * selftest-bili-settings.mjs —— describeCredentialCard / validateBiliField / buildBiliPatch 的自测
 *
 * 只 import 被测模块;不联网、不读写文件。
 * 全部通过退出码 0,有失败退出码 1;每条用例一行输出。
 */
import { describeCredentialCard, BILI_FIELDS, validateBiliField, buildBiliPatch } from '../lib/bili-settings.js'

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

// ── describeCredentialCard ──
{
  const noCredential = describeCredentialCard(null)
  const garbage = describeCredentialCard(42)
  report("1 describeCredentialCard(null / 非对象)→ tone:'none'、文案「未配置登录态」、按钮「扫码登录」、daysLeft:null",
    noCredential.ok === true && noCredential.tone === 'none' && noCredential.text === '未配置登录态' &&
      noCredential.daysLeft === null && noCredential.actionLabel === '扫码登录' &&
      garbage.tone === 'none',
    `${JSON.stringify(noCredential)} ${JSON.stringify(garbage)}`)
}
{
  const result = describeCredentialCard({ ok: true, usable: false, expired: true, daysLeft: -2, missing: [], reason: '凭证已过期' })
  report('2 已过期 → tone:error、文案含「过期」、按钮「重新登录」',
    result.tone === 'error' && result.text.includes('过期') && result.actionLabel === '重新登录',
    JSON.stringify(result))
}
{
  const result = describeCredentialCard({ ok: true, usable: false, expired: false, daysLeft: null, missing: ['SESSDATA'], reason: '凭证不完整:缺 SESSDATA' })
  report('3 usable:false → tone:error、文案含「不完整」(与 credential.js 的 reason 同串)',
    result.tone === 'error' && result.text.includes('不完整') && result.text.includes('SESSDATA'),
    JSON.stringify(result))
}
{
  const result = describeCredentialCard({ ok: true, usable: true, expired: false, daysLeft: 180, missing: [], reason: '' })
  report('4 daysLeft 180 → tone:ok、文案含「180.0」',
    result.tone === 'ok' && result.text.includes('180.0') && result.daysLeft === 180,
    JSON.stringify(result))
}
{
  const result = describeCredentialCard({ ok: true, usable: true, expired: false, daysLeft: 5, missing: [], reason: '' })
  report('5 daysLeft 5 → tone:warn、文案含「快过期」',
    result.tone === 'warn' && result.text.includes('快过期'),
    JSON.stringify(result))
}
{
  const seven = describeCredentialCard({ ok: true, usable: true, expired: false, daysLeft: 7, missing: [], reason: '' })
  const sevenPointOne = describeCredentialCard({ ok: true, usable: true, expired: false, daysLeft: 7.1, missing: [], reason: '' })
  report('6 边界:daysLeft 恰为 7 → warn(边界含);7.1 → ok',
    seven.tone === 'warn' && sevenPointOne.tone === 'ok',
    `${seven.tone} ${sevenPointOne.tone}`)
}
{
  const result = describeCredentialCard({ ok: true, usable: true, expired: false, daysLeft: null, missing: [], reason: '' })
  report('7 可用且 daysLeft 为 null → tone:ok、文案「登录态正常」且不含「天」',
    result.tone === 'ok' && result.text === '登录态正常' && !result.text.includes('天'),
    JSON.stringify(result))
}
{
  const zero = describeCredentialCard({ ok: true, usable: true, expired: false, daysLeft: 0, missing: [], reason: '' })
  const readFail = describeCredentialCard({ ok: false, reason: '结构不认识' })
  report('8(自加)daysLeft≤0 但没标过期 → warn「登录态可能已过期」;ok:false → error「凭证读取失败」',
    zero.tone === 'warn' && zero.text === '登录态可能已过期' &&
      readFail.tone === 'error' && readFail.text === '凭证读取失败',
    `${JSON.stringify(zero)} ${JSON.stringify(readFail)}`)
}

// ── validateBiliField ──
{
  const six = validateBiliField('peekCount', 6)
  const three = validateBiliField('peekCount', 3)
  const nine = validateBiliField('peekCount', 9)
  const two = validateBiliField('peekCount', 2)
  const ten = validateBiliField('peekCount', 10)
  report('9 peekCount:6/3/9 通过(值为数字);2/10 失败且 error 里带范围和当前值',
    six.ok === true && six.value === 6 && three.ok === true && three.value === 3 && nine.ok === true &&
      two.ok === false && two.error.includes('3') && two.error.includes('9') && two.error.includes('2') &&
      ten.ok === false && ten.error.includes('10'),
    `${JSON.stringify(six)} ${JSON.stringify(two)} ${JSON.stringify(ten)}`)
}
{
  const numericString = validateBiliField('peekCount', '6')
  const fractional = validateBiliField('peekCount', '6.5')
  const garbage = validateBiliField('peekCount', 'abc')
  const booleanValue = validateBiliField('peekCount', true)
  report("10 peekCount:'6' 通过(数字字符串归一成 6);'6.5'(非整数)/'abc'/true 失败",
    numericString.ok === true && numericString.value === 6 &&
      fractional.ok === false && garbage.ok === false && booleanValue.ok === false,
    `${JSON.stringify(numericString)} ${JSON.stringify(fractional)} ${JSON.stringify(garbage)} ${JSON.stringify(booleanValue)}`)
}
{
  const valid = validateBiliField('qn', '64')
  const invalid = validateBiliField('qn', '1080')
  const numberValue = validateBiliField('qn', 64)
  report("11 qn:'64' 通过;'1080' 失败且 error 列出允许值;数字 64 也失败(严格字符串比较)",
    valid.ok === true && valid.value === '64' &&
      invalid.ok === false && invalid.error.includes('32') && invalid.error.includes('80') &&
      numberValue.ok === false,
    `${JSON.stringify(valid)} ${JSON.stringify(invalid)} ${JSON.stringify(numberValue)}`)
}
{
  const unknown = validateBiliField('nope', 1)
  const empty = validateBiliField('peekCount', null)
  const undefinedValue = validateBiliField('peekCount', undefined)
  const emptyString = validateBiliField('peekCount', '')
  report('12 未知 key / null / undefined / 空串 → 全部失败(空值不兜默认值)',
    unknown.ok === false && unknown.error.includes('未知字段') &&
      empty.ok === false && undefinedValue.ok === false && emptyString.ok === false,
    `${JSON.stringify(unknown)} ${JSON.stringify(empty)}`)
}

// ── buildBiliPatch ──
{
  const result = buildBiliPatch({ peekCount: 6 }, { peekCount: 8 })
  report('13 {peekCount:6}→{peekCount:8} → patch:{peekCount:8}、changed:["peekCount"]、errors:[]',
    result.ok === true && JSON.stringify(result.patch) === JSON.stringify({ peekCount: 8 }) &&
      JSON.stringify(result.changed) === JSON.stringify(['peekCount']) && result.errors.length === 0,
    JSON.stringify(result))
}
{
  const result = buildBiliPatch({ peekCount: 6 }, { peekCount: 6 })
  report('14 值没变 → patch:{}、changed:[]、仍 ok:true',
    result.ok === true && JSON.stringify(result.patch) === '{}' && result.changed.length === 0 && result.errors.length === 0,
    JSON.stringify(result))
}
{
  const result = buildBiliPatch({}, { peekCount: 2, qn: '80' })
  report('15 一个错不拖累另一个:peekCount=2 进 errors,qn=’80‘ 进 patch',
    result.ok === true && result.errors.length === 1 && result.errors[0].key === 'peekCount' &&
      result.patch.qn === '80' && result.changed.length === 1,
    JSON.stringify(result))
}
{
  const nullCurrent = buildBiliPatch(null, {})
  const badNext = buildBiliPatch({}, 'x')
  const arrayCurrent = buildBiliPatch([], {})
  report('16 current/next 不是对象(null、字符串、数组)→ ok:false',
    nullCurrent.ok === false && badNext.ok === false && arrayCurrent.ok === false,
    `${JSON.stringify(nullCurrent)} ${JSON.stringify(badNext)} ${JSON.stringify(arrayCurrent)}`)
}
{
  const current = { peekCount: 6, asrAutoLimitMin: 10, qn: '64' }
  // 故意按乱序传键,验证 changed 跟字段表走、不跟键序走
  const scrambled = buildBiliPatch(current, { qn: '80', peekCount: 4, asrAutoLimitMin: 20 })
  const normalized = buildBiliPatch({ peekCount: 6 }, { peekCount: '6' })
  report('17(自加)changed 按 BILI_FIELDS 固定顺序(乱序键不影响);数字字符串归一后等于原值不算改动',
    scrambled.ok === true &&
      JSON.stringify(scrambled.changed) === JSON.stringify(['peekCount', 'asrAutoLimitMin', 'qn']) &&
      normalized.ok === true && JSON.stringify(normalized.patch) === '{}' && normalized.changed.length === 0,
    `${JSON.stringify(scrambled)} ${JSON.stringify(normalized)}`)
}
{
  const result = buildBiliPatch({ peekCount: 6, asrAutoLimitMin: 10, qn: '64' }, { peekCount: 0, asrAutoLimitMin: 0 })
  const fieldCount = BILI_FIELDS.length
  report('18(自加)全部字段失败且 next 非空 → 仍 ok:true、errors 两条、patch 为空;BILI_FIELDS 恰好三个字段',
    result.ok === true && result.errors.length === 2 && result.errors.every((entry) => entry.error.length > 0) &&
      JSON.stringify(result.patch) === '{}' && fieldCount === 3,
    JSON.stringify(result))
}

console.log(`\n共 ${totalCount} 项,失败 ${failedCount} 项`)
process.exitCode = failedCount === 0 ? 0 : 1
