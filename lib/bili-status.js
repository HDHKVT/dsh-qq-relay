/**
 * bili-status.js —— 解释 B 站返回的东西(纯函数,两个导出)
 *
 * 负责:①把「一次 B 站请求的结局」翻译成统一错误码(classifyBiliFailure);
 *      ②判读 nav 接口返回、回答「这份凭证还活着吗」(interpretNavResponse)。
 *      两者同属「解释返回」,契约要求放在一个文件里。
 * 不负责:发请求、重试、日志——调用方(黛丝侧)的事。
 * 风控纪律:retryable:true 只给网络层;风控与「数据为空」永远不可重试,
 *          别让调用方有理由对着 -412 轰炸。
 */

/** 这些 apiCode 是 B 站的风控/拒绝码:撞到只能停,重试只会更糟 */
const RISK_CONTROL_API_CODES = [-412, -352, -403, -799]

/** 契约里两个函数都要用的「是个普通对象」判断:数组不算 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function classifyBiliFailure(outcome) {
  // apiCode 先归一:不是有限数字(含缺失、NaN、字符串)一律记 null,后面统一判断
  const apiCode = Number.isFinite(outcome?.apiCode) ? outcome.apiCode : null
  const classified = (code, retryable) => ({ ok: true, code, retryable, apiCode })

  // ① 网络层标注永远最优先:请求根本没到 B 站的话,手里的任何 code 都不可信
  if (outcome?.networkError === true) return classified('network', true)
  // ② 5xx 是 B 站服务端自己病了,与风控无关——全函数里唯一值得重试的一类
  const httpStatus = outcome?.httpStatus
  if (typeof httpStatus === 'number' && Number.isFinite(httpStatus) && httpStatus >= 500 && httpStatus <= 599) {
    return classified('network', true)
  }
  if (apiCode === -101) return classified('no-cookie', false)
  if (apiCode !== null && RISK_CONTROL_API_CODES.includes(apiCode)) return classified('blocked', false)
  if (apiCode !== null && apiCode !== 0) return classified('api-error', false)
  if (apiCode === 0) return classified(outcome?.emptyData === true ? 'no-data' : 'bad-shape', false)
  // 什么线索都没有(比如传了 {}):既不能赖网络也不能赖 B 站,只能认结构不明
  return classified('bad-shape', false)
}

export function interpretNavResponse(payload) {
  const failure = (reason) => ({ ok: false, reason })

  if (!isPlainObject(payload) || !Number.isFinite(payload.code)) {
    return failure('payload 结构不认识:不是对象,或 code 不是数字')
  }
  // -101 是 nav 的「未登录」专用码,凭证失效时也是它
  if (payload.code === -101) {
    return { ok: true, loggedIn: false, nickname: '', mid: null, reason: '未登录或凭证已失效' }
  }
  if (payload.code === 0) {
    if (payload.data?.isLogin === true) {
      return {
        ok: true,
        loggedIn: true,
        // 字段类型不对就给安全值:昵称给空串、mid 给 null,不因脏数据报错
        nickname: typeof payload.data.uname === 'string' ? payload.data.uname : '',
        mid: Number.isFinite(payload.data.mid) ? payload.data.mid : null,
        reason: '',
      }
    }
    return { ok: true, loggedIn: false, nickname: '', mid: null, reason: '接口正常但未登录' }
  }
  return failure(`nav 返回了未约定的 code:${payload.code}`)
}
