/**
 * selftest-login-machine.mjs —— loginReducer 的自测
 *
 * 只 import 被测模块;不联网、不读写文件。
 * 全部通过退出码 0,有失败退出码 1;每条用例一行输出。
 */
import { loginReducer } from '../lib/login-machine.js'

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

const idleState = () => ({ phase: 'idle', qrKey: '', qrUrl: '', reason: '', attempts: 0, startedAtMs: 0 })
const pollEvent = (pollState, extra = {}) => ({
  type: 'poll',
  pollResult: { ok: true, state: pollState, redirectUrl: '', rawStateCode: 0, reason: '', ...extra },
  nowMs: 0,
})
const isLegal = (state) =>
  ['idle', 'generating', 'waiting', 'scanned', 'success', 'expired', 'error'].includes(state.phase) &&
  typeof state.qrKey === 'string' && typeof state.qrUrl === 'string' && typeof state.reason === 'string' &&
  Number.isInteger(state.attempts) && state.attempts >= 0 && typeof state.startedAtMs === 'number'

// 常用的中间态,用真实事件序列搭出来
const generating = loginReducer(idleState(), { type: 'generate-start' })
const waiting = loginReducer(generating, { type: 'generate-ok', qrKey: 'k1', qrUrl: 'u1', nowMs: 5000 })
const scanned = loginReducer(waiting, pollEvent('scanned'))

// ── 1 基本转移 ──
{
  const result = loginReducer(idleState(), { type: 'generate-start' })
  report('1 idle + generate-start → generating,其余字段全清',
    result.phase === 'generating' && result.qrKey === '' && result.qrUrl === '' &&
      result.reason === '' && result.attempts === 0 && result.startedAtMs === 0,
    JSON.stringify(result))
}
{
  const result = loginReducer(generating, { type: 'generate-ok', qrKey: 'k1', qrUrl: 'u1', nowMs: 5000 })
  report('2 generating + generate-ok → waiting,qrKey/qrUrl 写入、attempts=0、startedAtMs=5000',
    result.phase === 'waiting' && result.qrKey === 'k1' && result.qrUrl === 'u1' &&
      result.attempts === 0 && result.startedAtMs === 5000 && result.reason === '',
    JSON.stringify(result))
}
{
  const result = loginReducer(waiting, { type: 'generate-ok', qrKey: 'k2', qrUrl: 'u2', nowMs: 9000 })
  report('3 迟到响应:waiting 再收到 generate-ok → 原样返回(同一引用),不重置计时',
    result === waiting && result.phase === 'waiting' && result.startedAtMs === 5000,
    `同一引用=${result === waiting} ${JSON.stringify(result)}`)
}
{
  const emptyReason = loginReducer(generating, { type: 'generate-fail', reason: '' })
  const givenReason = loginReducer(generating, { type: 'generate-fail', reason: '网络断了' })
  report('4 generating + generate-fail → error;reason 空则用「生成二维码失败」,有则原样',
    emptyReason.phase === 'error' && emptyReason.reason === '生成二维码失败' &&
      givenReason.phase === 'error' && givenReason.reason === '网络断了',
    `${JSON.stringify(emptyReason)} ${JSON.stringify(givenReason)}`)
}
{
  const result = loginReducer(waiting, pollEvent('pending'))
  report('5 waiting + poll(pending) → 仍是 waiting,attempts 加一',
    result.phase === 'waiting' && result.attempts === 1 && result.qrKey === 'k1',
    JSON.stringify(result))
}
{
  const toScanned = loginReducer(waiting, pollEvent('scanned'))
  const stayScanned = loginReducer(scanned, pollEvent('scanned'))
  const backToWaiting = loginReducer(scanned, pollEvent('pending'))
  report('6 waiting + poll(scanned) → scanned;scanned 再 poll(scanned) 仍是 scanned(attempts 累加);scanned + poll(pending) 按规则回 waiting',
    toScanned.phase === 'scanned' && toScanned.qrKey === 'k1' &&
      stayScanned.phase === 'scanned' && stayScanned.attempts === scanned.attempts + 1 &&
      backToWaiting.phase === 'waiting',
    `${JSON.stringify(toScanned)} ${JSON.stringify(stayScanned)} ${JSON.stringify(backToWaiting)}`)
}
{
  const result = loginReducer(waiting, pollEvent('confirmed'))
  report('7 waiting + poll(confirmed) → success,qrKey/qrUrl 清空',
    result.phase === 'success' && result.qrKey === '' && result.qrUrl === '',
    JSON.stringify(result))
}
{
  const result = loginReducer(waiting, pollEvent('expired'))
  report('8 waiting + poll(expired) → expired,qrKey 清空',
    result.phase === 'expired' && result.qrKey === '' && result.qrUrl === '',
    JSON.stringify(result))
}
{
  const result = loginReducer(waiting, { type: 'poll', pollResult: { ok: false, reason: '被风控' }, nowMs: 0 })
  report('9 waiting + poll({ok:false, reason:"被风控"}) → error,reason 含「风控」',
    result.phase === 'error' && result.reason.includes('风控'),
    JSON.stringify(result))
}
{
  const fixedIdle = idleState()
  const result = loginReducer(fixedIdle, pollEvent('confirmed'))
  report('10 取消后迟到:idle + poll(confirmed) → 原样返回(同一引用),仍是 idle',
    result === fixedIdle && result.phase === 'idle',
    `同一引用=${result === fixedIdle} phase=${result.phase}`)
}
{
  const messy = loginReducer({ ...scanned, attempts: 7 }, { type: 'cancel' })
  const fromSuccess = loginReducer({ phase: 'success', qrKey: '', qrUrl: '', reason: '', attempts: 3, startedAtMs: 0 }, { type: 'reset' })
  report('11 任意状态 + cancel/reset → idle 全归零(attempts、qrKey、reason、startedAtMs 都清)',
    messy.phase === 'idle' && messy.attempts === 0 && messy.qrKey === '' && messy.reason === '' && messy.startedAtMs === 0 &&
      fromSuccess.phase === 'idle' && fromSuccess.attempts === 0,
    `${JSON.stringify(messy)} ${JSON.stringify(fromSuccess)}`)
}
{
  const state = scanned
  const unknownEvent = loginReducer(state, { type: 'whatever' })
  const nullEvent = loginReducer(state, null)
  report('12 未知事件 / null 事件 → 原样返回(同一引用),phase 不变',
    unknownEvent === state && unknownEvent.phase === 'scanned' && nullEvent === state,
    `${unknownEvent === state} ${nullEvent === state}`)
}

// ── 13 状态合法性(长序列逐个查) ──
{
  const sequence = [
    { type: 'generate-start' },
    { type: 'generate-ok', qrKey: 'k', qrUrl: 'u', nowMs: 100 },
    pollEvent('pending'),
    pollEvent('scanned'),
    pollEvent('confirmed'),
    { type: 'reset' },
    { type: 'generate-start' },
    { type: 'generate-fail', reason: '' },
  ]
  const expectedPhases = ['generating', 'waiting', 'waiting', 'scanned', 'success', 'idle', 'generating', 'error']
  let current = idleState()
  const phases = []
  let allLegal = true
  for (const event of sequence) {
    current = loginReducer(current, event)
    phases.push(current.phase)
    if (!isLegal(current)) allLegal = false
  }
  report('13 长序列:idle→…→error 共 8 步,每步输出都是合法状态,phase 序列符合预期',
    allLegal && phases.join(',') === expectedPhases.join(','),
    `${phases.join(',')} legal=${allLegal}`)
}
{
  const result = loginReducer(generating, { type: 'generate-ok', qrKey: 'k', qrUrl: 'u', nowMs: Number.NaN })
  report('14 generate-ok 的 nowMs 传 NaN → startedAtMs 为 0,不报错',
    result.phase === 'waiting' && result.startedAtMs === 0,
    JSON.stringify(result))
}

// ── 15(自加)不可变性:原对象绝不许被改 ──
{
  const before = loginReducer(generating, { type: 'generate-ok', qrKey: 'kk', qrUrl: 'uu', nowMs: 1 })
  const snapshot = JSON.stringify(before)
  const result = loginReducer(before, pollEvent('confirmed'))
  report('15 不可变性:poll(confirmed) 返回新对象,原 state 逐字节未动',
    result !== before && result.phase === 'success' && JSON.stringify(before) === snapshot,
    `新对象=${result !== before} 原=${JSON.stringify(before)}`)
}
{
  const bogus = { phase: 'bogus', qrKey: 5, qrUrl: null, reason: undefined, attempts: -3, startedAtMs: 'x' }
  const cancelled = loginReducer(bogus, { type: 'cancel' })
  const polled = loginReducer(bogus, pollEvent('confirmed'))
  const started = loginReducer(bogus, { type: 'generate-start' })
  report('16(自加)非法形状的输入也能给出合法输出:cancel→idle;poll→归一后原样(idle);generate-start→generating',
    isLegal(cancelled) && cancelled.phase === 'idle' &&
      isLegal(polled) && polled.phase === 'idle' &&
      isLegal(started) && started.phase === 'generating',
    `${JSON.stringify(cancelled)} ${JSON.stringify(polled)} ${JSON.stringify(started)}`)
}

console.log(`\n共 ${totalCount} 项,失败 ${failedCount} 项`)
process.exitCode = failedCount === 0 ? 0 : 1
