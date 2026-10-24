/**
 * login-flow.js —— 扫码登录的节奏与话术(纯函数,两个导出)
 *
 * 负责:①决定下一次轮询等多久、什么时候放弃(nextPollDelay);
 *      ②把轮询状态翻成给人读的一句话(describeLoginState)。
 * 不负责:网络请求、二维码渲染(交给 Python 侧的库)、拼界面——黛丝侧的活。
 * 边界:不读时钟、不计时、不重试,一切时间与次数都由调用方传进来。
 */

const POLL_STATES = ['pending', 'scanned', 'confirmed', 'expired', 'error']
const DEFAULT_BASE_DELAY_MS = 1500
const DEFAULT_SCANNED_DELAY_MS = 4000
const DEFAULT_TIMEOUT_MS = 180000
/** 次数硬顶:防止实现层的 bug 把轮询变成死循环,300 次 × 1.5 秒也已远超 3 分钟 */
const MAX_ATTEMPTS = 300

/** 三个节奏参数只认正整数;其余(0、负数、小数、非数字)一律退回默认值 */
function positiveIntegerOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

export function nextPollDelay(input) {
  const failure = (reason) => ({ ok: false, reason })

  const state = input?.state
  if (!POLL_STATES.includes(state)) return failure('state 不是五个轮询状态之一')

  // elapsedMs 不可信(非有限数或负数)按 0 处理:刚起步,不该因为脏数据放弃
  const elapsedMs = Number.isFinite(input?.elapsedMs) && input.elapsedMs > 0 ? input.elapsedMs : 0
  const attempts = Number.isFinite(input?.attempts) ? input.attempts : 0
  const baseDelayMs = positiveIntegerOr(input?.baseDelayMs, DEFAULT_BASE_DELAY_MS)
  const scannedDelayMs = positiveIntegerOr(input?.scannedDelayMs, DEFAULT_SCANNED_DELAY_MS)
  const timeoutMs = positiveIntegerOr(input?.timeoutMs, DEFAULT_TIMEOUT_MS)

  const giveUp = (reason) => ({ ok: true, delayMs: 0, giveUp: true, reason })

  // 终止状态的判定先于超时:成功就是成功,不能被「等太久」改写成超时
  if (state === 'confirmed') return giveUp('登录成功')
  if (state === 'expired') return giveUp('二维码已过期')
  if (state === 'error') return giveUp('登录出错')
  if (elapsedMs >= timeoutMs) return giveUp('等待超时')
  if (attempts >= MAX_ATTEMPTS) return giveUp('轮询次数过多')

  if (state === 'pending') return { ok: true, delayMs: baseDelayMs, giveUp: false, reason: '' }
  // 已扫码说明人正在手机上操作,没必要 1.5 秒一次地催
  return { ok: true, delayMs: scannedDelayMs, giveUp: false, reason: '' }
}

export function describeLoginState(input) {
  const failure = (reason) => ({ ok: false, reason })

  const state = input?.state
  if (!POLL_STATES.includes(state)) return failure('state 不是五个轮询状态之一')

  if (state === 'pending') {
    return { ok: true, text: '请用 B 站手机客户端扫这个二维码', terminal: false, retryable: false }
  }
  if (state === 'scanned') {
    return { ok: true, text: '已扫码，请在手机上点「确认登录」', terminal: false, retryable: false }
  }
  if (state === 'confirmed') {
    const nickname = typeof input.nickname === 'string' && input.nickname !== '' ? input.nickname : '你'
    return { ok: true, text: `登录成功，欢迎回来，${nickname}`, terminal: true, retryable: false }
  }
  if (state === 'expired') {
    return { ok: true, text: '二维码过期了，点一下刷新再扫一次', terminal: true, retryable: true }
  }
  const reason = typeof input.reason === 'string' && input.reason !== '' ? input.reason : '未知原因'
  return { ok: true, text: `登录失败：${reason}`, terminal: true, retryable: true }
}
