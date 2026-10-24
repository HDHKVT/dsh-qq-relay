/**
 * bili-card-model.js —— B 站设置卡的「数据模型」(纯函数,一个导出)
 *
 * 负责:把「什么状态下哪个按钮能点、哪个字段有错、横幅说什么」全部算成一个纯对象,
 *      JSX 只管照着渲染,不再出现层层嵌套的三元表达式(buildBiliCardModel)。
 * 不负责:React、RPC、网络、存盘——黛丝侧的活。
 * 边界(契约的明确要求):**不 import** describeCredentialCard / BILI_FIELDS / validateBiliField /
 *      login-machine——17.x 那套文案规则、字段表、校验规则在本文件里**刻意重写一份**,
 *      两个模块各自独立交付、独立被审;两份实现的同步由 selftest 里的交叉比对兜着。
 */

const INCOMPLETE_TEXT = '凭证不完整:缺 SESSDATA'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 17.1 的八条规则,在本文件里的重写份——规则顺序即优先级,与 bili-settings.js 保持一致 */
function credentialCardStatus(validation) {
  if (!isPlainObject(validation)) {
    return { text: '未配置登录态', tone: 'none', daysLeft: null, actionLabel: '扫码登录' }
  }
  const daysLeft = Number.isFinite(validation.daysLeft) ? validation.daysLeft : null
  if (validation.ok === false) {
    return { text: '凭证读取失败', tone: 'error', daysLeft, actionLabel: '重新登录' }
  }
  if (validation.expired === true) {
    return { text: '凭证已过期，请重新登录', tone: 'error', daysLeft, actionLabel: '重新登录' }
  }
  if (validation.usable !== true) {
    return { text: INCOMPLETE_TEXT, tone: 'error', daysLeft, actionLabel: '重新登录' }
  }
  if (daysLeft === null) {
    return { text: '登录态正常', tone: 'ok', daysLeft: null, actionLabel: '重新登录' }
  }
  if (daysLeft > 7) {
    return { text: `登录态正常，还剩 ${daysLeft.toFixed(1)} 天`, tone: 'ok', daysLeft, actionLabel: '重新登录' }
  }
  if (daysLeft > 0) {
    return { text: `登录态正常，还剩 ${daysLeft.toFixed(1)} 天（快过期了）`, tone: 'warn', daysLeft, actionLabel: '重新登录' }
  }
  return { text: '登录态可能已过期', tone: 'warn', daysLeft, actionLabel: '重新登录' }
}

/** 17.2 字段表的重写份;qn 的 unit 用 null(契约:不适用的槽位给 null) */
const FIELD_DEFINITIONS = [
  { key: 'peekCount', type: 'int', label: '看图抽帧数', unit: '帧', min: 3, max: 9, options: null, def: 6 },
  { key: 'asrAutoLimitMin', type: 'int', label: '自动转写上限', unit: '分钟', min: 1, max: 60, options: null, def: 10 },
  { key: 'qn', type: 'enum', label: '画质档位', unit: null, min: null, max: null, options: ['32', '64', '80'], def: '64' },
]

/** 17.2 校验规则的重写份:通过给空串,失败给带范围和当前值的人话 */
function fieldError(definition, value) {
  if (definition.type === 'int') {
    if (typeof value !== 'number' && typeof value !== 'string') {
      return `「${definition.label}」只接受数字或数字字符串，当前是 ${String(value)}`
    }
    const numbered = Number(value)
    if (!Number.isInteger(numbered) || numbered < definition.min || numbered > definition.max) {
      return `「${definition.label}」只接受 ${definition.min}–${definition.max} 的整数，当前是 ${String(value)}`
    }
    return ''
  }
  // enum 用严格比较:数字 64 不等于字符串 '64'
  if (!definition.options.includes(value)) {
    return `「${definition.label}」只能是 ${definition.options.join(' / ')} 之一，当前是 ${String(value)}`
  }
  return ''
}

/** 正在走扫码流程的三个相位:这时不许再点「扫码」,否则会打断进行中的流程 */
const BUSY_PHASES = ['generating', 'waiting', 'scanned']

const PHASE_BANNERS = {
  generating: '正在生成二维码…',
  waiting: '请用 B 站手机客户端扫这个二维码',
  scanned: '已扫码，请在手机上点「确认登录」',
  success: '登录成功，凭证已保存',
  expired: '二维码过期了，点「重新扫码」再来一次',
}

function loginBanner(login) {
  const phase = login?.phase
  if (phase === 'error') {
    const reason = typeof login.reason === 'string' && login.reason !== '' ? login.reason : ''
    // 没有原因就不带冒号,免得界面出现一句悬空的「登录出错：」
    return reason === '' ? '登录出错' : `登录出错：${reason}`
  }
  // idle / 缺省 / 非法 phase 都没有横幅;hasOwnProperty 防垃圾字符串撞上原型链的键
  return Object.hasOwn(PHASE_BANNERS, phase) ? PHASE_BANNERS[phase] : ''
}

export function buildBiliCardModel(input) {
  if (!isPlainObject(input)) return { ok: false, reason: 'input 不是对象' }

  const validation = isPlainObject(input.validation) ? input.validation : null
  const config = isPlainObject(input.config) ? input.config : {}
  const login = isPlainObject(input.login) ? input.login : null

  const status = credentialCardStatus(validation)
  const hasCredential = validation !== null && validation.usable === true

  const fields = FIELD_DEFINITIONS.map((definition) => {
    const rawValue = config[definition.key]
    // value 永远是数字或字符串:不是(含缺失/null/对象)就用 def 兜,表单才有东西可显示
    const value = typeof rawValue === 'number' || typeof rawValue === 'string' ? rawValue : definition.def
    return {
      key: definition.key,
      label: definition.label,
      value,
      unit: definition.unit,
      min: definition.min,
      max: definition.max,
      options: definition.options,
      error: fieldError(definition, value),
    }
  })

  const phase = typeof login?.phase === 'string' ? login.phase : 'idle'
  return {
    ok: true,
    status,
    fields,
    buttons: {
      scan: {
        enabled: !BUSY_PHASES.includes(phase),
        label: hasCredential ? '重新扫码' : '扫码登录',
      },
      refresh: { enabled: true },
      clear: { enabled: hasCredential },
    },
    banner: loginBanner(login),
    hasCredential,
  }
}
