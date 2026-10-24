/**
 * selftest-bili-status.mjs —— classifyBiliFailure / interpretNavResponse 的自测
 *
 * 只 import 被测模块;不联网、不读写文件。
 * 全部通过退出码 0,有失败退出码 1;每条用例一行输出。
 * (命名沿用既定约定:不动前三个模块的自测文件。)
 */
import { classifyBiliFailure, interpretNavResponse } from '../lib/bili-status.js'

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

// ── 接口一:classifyBiliFailure ──
{
  const result = classifyBiliFailure({ networkError: true })
  report('1 {networkError:true} → network + retryable:true',
    result.ok === true && result.code === 'network' && result.retryable === true,
    JSON.stringify(result))
}
{
  const result = classifyBiliFailure({ httpStatus: 502 })
  report('2 {httpStatus:502} → network + retryable:true',
    result.ok === true && result.code === 'network' && result.retryable === true,
    JSON.stringify(result))
}
{
  const result = classifyBiliFailure({ httpStatus: 200, apiCode: -101 })
  report('3 {httpStatus:200, apiCode:-101} → no-cookie',
    result.ok === true && result.code === 'no-cookie' && result.retryable === false,
    JSON.stringify(result))
}
{
  const result = classifyBiliFailure({ httpStatus: 200, apiCode: -412 })
  report('4 {httpStatus:200, apiCode:-412} → blocked + retryable:false',
    result.ok === true && result.code === 'blocked' && result.retryable === false,
    JSON.stringify(result))
}
{
  const results = [-352, -403, -799].map((apiCode) => classifyBiliFailure({ httpStatus: 200, apiCode }))
  report('5 -352 / -403 / -799 逐个验 → 都是 blocked',
    results.every((result) => result.ok === true && result.code === 'blocked' && result.retryable === false),
    JSON.stringify(results))
}
{
  const result = classifyBiliFailure({ apiCode: -400 })
  report('6 {apiCode:-400}(没给 httpStatus)→ api-error,apiCode 原样带回',
    result.ok === true && result.code === 'api-error' && result.apiCode === -400 && result.retryable === false,
    JSON.stringify(result))
}
{
  const withData = classifyBiliFailure({ apiCode: 0, emptyData: true })
  const withoutData = classifyBiliFailure({ apiCode: 0, emptyData: false })
  report('7 {apiCode:0} + emptyData → no-data;emptyData:false → bad-shape',
    withData.ok === true && withData.code === 'no-data' && withoutData.ok === true && withoutData.code === 'bad-shape',
    `true=${JSON.stringify(withData)} false=${JSON.stringify(withoutData)}`)
}
{
  const result = classifyBiliFailure({})
  report('8 {}(什么都没给)→ bad-shape,apiCode 为 null',
    result.ok === true && result.code === 'bad-shape' && result.apiCode === null && result.retryable === false,
    JSON.stringify(result))
}
{
  const result = classifyBiliFailure({ networkError: true, apiCode: -412 })
  report('9 优先级:networkError 与 apiCode:-412 同时给 → 必须是 network,不许是 blocked',
    result.ok === true && result.code === 'network' && result.retryable === true,
    JSON.stringify(result))
}
{
  const result = classifyBiliFailure({ httpStatus: 503, apiCode: -352 })
  report('10 优先级补验:5xx 与风控码同时给 → network',
    result.ok === true && result.code === 'network',
    JSON.stringify(result))
}

// ── 接口二:interpretNavResponse ──
{
  const result = interpretNavResponse({ code: 0, data: { isLogin: true, uname: '小明', mid: 12345 } })
  report('11 正常登录:loggedIn:true,昵称「小明」,mid=12345',
    result.ok === true && result.loggedIn === true && result.nickname === '小明' && result.mid === 12345,
    JSON.stringify(result))
}
{
  const result = interpretNavResponse({ code: -101, message: '账号未登录' })
  report('12 未登录(code:-101)→ ok:true, loggedIn:false,reason 逐字是「未登录或凭证已失效」',
    result.ok === true && result.loggedIn === false && result.reason === '未登录或凭证已失效',
    JSON.stringify(result))
}
{
  const result = interpretNavResponse({ code: 0, data: { isLogin: false } })
  report('13 code:0 但 isLogin:false → loggedIn:false,reason 是「接口正常但未登录」',
    result.ok === true && result.loggedIn === false && result.reason === '接口正常但未登录',
    JSON.stringify(result))
}
{
  const result = interpretNavResponse({ code: 0, data: { isLogin: true, uname: 123, mid: 'abc' } })
  report('14 字段类型脏(uname=123, mid="abc")→ 昵称空串、mid=null,不报错,loggedIn 仍为 true',
    result.ok === true && result.loggedIn === true && result.nickname === '' && result.mid === null,
    JSON.stringify(result))
}
{
  const nullPayload = interpretNavResponse(null)
  const emptyPayload = interpretNavResponse({})
  report('15 null 或 {} → ok:false,reason 非空',
    nullPayload.ok === false && String(nullPayload.reason).length > 0 &&
      emptyPayload.ok === false && String(emptyPayload.reason).length > 0,
    `null=${JSON.stringify(nullPayload)} {}=${JSON.stringify(emptyPayload)}`)
}
{
  const result = interpretNavResponse({ code: -500 })
  report('16 code:-500 → ok:false,reason 里带「-500」',
    result.ok === false && result.reason.includes('-500'),
    JSON.stringify(result))
}

console.log(`\n共 ${totalCount} 项,失败 ${failedCount} 项`)
process.exitCode = failedCount === 0 ? 0 : 1
