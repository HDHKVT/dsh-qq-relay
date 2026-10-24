/**
 * login-machine.js —— 扫码登录的状态机(纯 reducer,一个导出)
 *
 * 负责:界面上要跟的那几个相位之间的全部转移(loginReducer)。
 *      判轮询状态在 bili-login.js、节奏与话术在 login-flow.js、抠 cookie 在 bili-login.js,
 *      本模块只做状态转移,不碰网络、时钟(时间一律由事件注入)、文件。
 * 边界(两条顶层纪律):
 *   ① 纯函数——合法转移返回新对象,绝不原地改传入的 state;
 *      非法转移原样返回,输入本就合法时返回**同一个引用**,
 *      界面靠"引用没变"跳过无意义的重渲染。
 *   ② 拿不准的转移一律原样返回——不自创相位、不自创事件类型。
 */

const PHASES = ['idle', 'generating', 'waiting', 'scanned', 'success', 'expired', 'error']

function textOrEmpty(value) {
  return typeof value === 'string' ? value : ''
}

/** 全字段归零的地面态,可按需覆盖个别字段 */
function freshState(patch) {
  return { phase: 'idle', qrKey: '', qrUrl: '', reason: '', attempts: 0, startedAtMs: 0, ...patch }
}

/** 任意输入归一成合法状态:字符串补空、attempts 归为非负整数;
 *  不认识的 phase 归 idle——它是 cancel/reset 的去处,天然的地面态 */
function canonicalState(raw) {
  const attempts = Number(raw?.attempts)
  return {
    phase: PHASES.includes(raw?.phase) ? raw.phase : 'idle',
    qrKey: textOrEmpty(raw?.qrKey),
    qrUrl: textOrEmpty(raw?.qrUrl),
    reason: textOrEmpty(raw?.reason),
    attempts: Number.isFinite(attempts) ? Math.max(0, Math.trunc(attempts)) : 0,
    startedAtMs: Number.isFinite(raw?.startedAtMs) ? raw.startedAtMs : 0,
  }
}

/** 输入已经是合法形状时直接用、不复制——"原样返回"才能保持同一个引用 */
function isCanonicalState(raw) {
  return PHASES.includes(raw?.phase) &&
    typeof raw.qrKey === 'string' && typeof raw.qrUrl === 'string' && typeof raw.reason === 'string' &&
    Number.isInteger(raw.attempts) && raw.attempts >= 0 &&
    typeof raw.startedAtMs === 'number' && Number.isFinite(raw.startedAtMs)
}

export function loginReducer(state, event) {
  // 入口先归一:合法输入保引用,非法输入整理成合法的——输出永远是合法状态(规则 7)
  const base = isCanonicalState(state) ? state : canonicalState(state)
  // 事件不是对象(含数组、null)→ 原样返回
  if (!event || typeof event !== 'object' || Array.isArray(event)) return base

  switch (event.type) {
    case 'generate-start':
      // 已在生成中,重复的 start 不重置——连点不该把流程打断重来
      if (base.phase === 'generating') return base
      return freshState({ phase: 'generating' })

    case 'generate-ok': {
      // 迟到的成功响应不许把界面拉回等待态、不许重置计时
      if (base.phase !== 'generating') return base
      return freshState({
        phase: 'waiting',
        qrKey: textOrEmpty(event.qrKey),
        qrUrl: textOrEmpty(event.qrUrl),
        startedAtMs: Number.isFinite(event.nowMs) ? event.nowMs : 0,
      })
    }

    case 'generate-fail': {
      if (base.phase !== 'generating') return base
      const reason = typeof event.reason === 'string' && event.reason !== ''
        ? event.reason
        : '生成二维码失败'
      return freshState({ phase: 'error', reason })
    }

    case 'poll': {
      // 只有等待/已扫两态吃轮询结果——取消之后的迟到轮询不许改状态
      if (base.phase !== 'waiting' && base.phase !== 'scanned') return base
      const pollResult = event.pollResult
      if (!pollResult || typeof pollResult !== 'object' || Array.isArray(pollResult)) return base
      if (pollResult.ok === false) {
        return { ...base, phase: 'error', reason: textOrEmpty(pollResult.reason) }
      }
      switch (pollResult.state) {
        case 'pending':
          return { ...base, phase: 'waiting', attempts: base.attempts + 1 }
        case 'scanned':
          return { ...base, phase: 'scanned', attempts: base.attempts + 1 }
        case 'confirmed':
          // 码已作废,界面上不该再显示
          return { ...base, phase: 'success', qrKey: '', qrUrl: '' }
        case 'expired':
          return { ...base, phase: 'expired', qrKey: '', qrUrl: '' }
        case 'error':
          return { ...base, phase: 'error', reason: textOrEmpty(pollResult.reason) }
        default:
          // 不认识的轮询状态:拿不准,原样返回
          return base
      }
    }

    case 'cancel':
    case 'reset':
      return freshState({})

    default:
      // 未知事件:拿不准,原样返回
      return base
  }
}
