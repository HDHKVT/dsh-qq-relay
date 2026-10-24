/**
 * selftest-login-flow.mjs —— nextPollDelay / describeLoginState 的自测
 *
 * 只 import 被测模块;不联网、不读写文件。
 * 全部通过退出码 0,有失败退出码 1;每条用例一行输出。
 */
import { nextPollDelay, describeLoginState } from '../lib/login-flow.js'

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

// ── nextPollDelay ──
{
  const result = nextPollDelay({ state: 'pending', elapsedMs: 0 })
  report('1 pending → delayMs 1500、不放弃',
    result.ok === true && result.delayMs === 1500 && result.giveUp === false,
    JSON.stringify(result))
}
{
  const result = nextPollDelay({ state: 'scanned', elapsedMs: 1000 })
  report('2 scanned → delayMs 4000、不放弃',
    result.ok === true && result.delayMs === 4000 && result.giveUp === false,
    JSON.stringify(result))
}
{
  const confirmed = nextPollDelay({ state: 'confirmed', elapsedMs: 5000 })
  const expired = nextPollDelay({ state: 'expired', elapsedMs: 5000 })
  const errored = nextPollDelay({ state: 'error', elapsedMs: 5000 })
  report('3 confirmed / expired / error → 三个都 giveUp:true、delayMs:0、reason 逐字对应',
    confirmed.giveUp === true && confirmed.delayMs === 0 && confirmed.reason === '登录成功' &&
      expired.giveUp === true && expired.delayMs === 0 && expired.reason === '二维码已过期' &&
      errored.giveUp === true && errored.delayMs === 0 && errored.reason === '登录出错',
    `${JSON.stringify(confirmed)} ${JSON.stringify(expired)} ${JSON.stringify(errored)}`)
}
{
  const result = nextPollDelay({ state: 'pending', elapsedMs: 200000 })
  report('4 elapsedMs 超过 timeoutMs(默认 180000)→ 放弃、reason 含「超时」',
    result.ok === true && result.giveUp === true && result.delayMs === 0 && result.reason.includes('超时'),
    JSON.stringify(result))
}
{
  const result = nextPollDelay({ state: 'pending', elapsedMs: 0, attempts: 301 })
  report('5 attempts 超过 300 → 放弃、reason 含「次数」',
    result.ok === true && result.giveUp === true && result.reason.includes('次数'),
    JSON.stringify(result))
}
{
  const zero = nextPollDelay({ state: 'pending', elapsedMs: 0, baseDelayMs: 0 })
  const negative = nextPollDelay({ state: 'pending', elapsedMs: 0, baseDelayMs: -100 })
  const fractional = nextPollDelay({ state: 'pending', elapsedMs: 0, baseDelayMs: 1500.5 })
  report('6 baseDelayMs 传 0 / 负数 / 小数 → 都用默认 1500',
    zero.delayMs === 1500 && negative.delayMs === 1500 && fractional.delayMs === 1500,
    `${zero.delayMs} ${negative.delayMs} ${fractional.delayMs}`)
}
{
  const result = nextPollDelay({ state: 'xxx', elapsedMs: 0 })
  const nullInput = nextPollDelay(null)
  report("7 state 传 'xxx' 或整个 input 为 null → ok:false",
    result.ok === false && String(result.reason).length > 0 && nullInput.ok === false,
    `${JSON.stringify(result)} ${JSON.stringify(nullInput)}`)
}
{
  const result = nextPollDelay({ state: 'pending', elapsedMs: -5 })
  report('8 elapsedMs 传 -5 → 当作 0,不放弃、正常给 1500',
    result.ok === true && result.giveUp === false && result.delayMs === 1500,
    JSON.stringify(result))
}

// ── describeLoginState ──
{
  const pending = describeLoginState({ state: 'pending' })
  const scanned = describeLoginState({ state: 'scanned' })
  const confirmed = describeLoginState({ state: 'confirmed', nickname: '小明' })
  const expired = describeLoginState({ state: 'expired' })
  const errored = describeLoginState({ state: 'error', reason: '网络断了' })
  report('9 五个状态逐字文案(confirmed 带昵称、error 带原因)',
    pending.text === '请用 B 站手机客户端扫这个二维码' &&
      scanned.text === '已扫码，请在手机上点「确认登录」' &&
      confirmed.text === '登录成功，欢迎回来，小明' &&
      expired.text === '二维码过期了，点一下刷新再扫一次' &&
      errored.text === '登录失败：网络断了',
    `${pending.text}|${scanned.text}|${confirmed.text}|${expired.text}|${errored.text}`)
}
{
  const result = describeLoginState({ state: 'confirmed', nickname: '' })
  report('10 confirmed 且昵称是空串 → 「登录成功，欢迎回来，你」',
    result.ok === true && result.text === '登录成功，欢迎回来，你',
    JSON.stringify(result))
}
{
  const result = describeLoginState({ state: 'error' })
  report('11 error 且 reason 为空 → 「登录失败：未知原因」',
    result.ok === true && result.text === '登录失败：未知原因',
    JSON.stringify(result))
}
{
  const states = ['pending', 'scanned', 'confirmed', 'expired', 'error'].map((state) => describeLoginState({ state }))
  const [pending, scanned, confirmed, expired, errored] = states
  report('12 terminal/retryable:仅 confirmed/expired/error 终态;仅 expired/error 可重试',
    pending.terminal === false && pending.retryable === false &&
      scanned.terminal === false && scanned.retryable === false &&
      confirmed.terminal === true && confirmed.retryable === false &&
      expired.terminal === true && expired.retryable === true &&
      errored.terminal === true && errored.retryable === true,
    JSON.stringify(states.map((item) => ({ terminal: item.terminal, retryable: item.retryable }))))
}
{
  const result = describeLoginState({ state: null })
  report('13 state 传 null → ok:false',
    result.ok === false && String(result.reason).length > 0,
    JSON.stringify(result))
}

console.log(`\n共 ${totalCount} 项,失败 ${failedCount} 项`)
process.exitCode = failedCount === 0 ? 0 : 1
