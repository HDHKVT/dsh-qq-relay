/**
 * bili-settings.js —— B 站设置卡的纯逻辑(三个导出)
 *
 * 负责:①登录态卡片显示什么、什么语气(describeCredentialCard);
 *      ②三个设置字段的定义与逐字段校验(BILI_FIELDS / validateBiliField);
 *      ③把表单里的改动打包成 patch、逐条报错(buildBiliPatch)。
 * 不负责:React 渲染、RPC、存盘、网络——黛丝侧的活。
 * 边界:校验失败的 error 永远带"范围 + 当前值",界面能逐字段标错;
 *      空值不兜默认值——表单空着就是没填,替用户猜一个值比报错更坏。
 */

/** 与 credential.js 里 validateCredential 的 reason 一字不差(含半角冒号),方便界面对账 */
const INCOMPLETE_TEXT = '凭证不完整:缺 SESSDATA'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function describeCredentialCard(validation) {
  // 没凭证(或传进来的根本不是 validateCredential 的返回)是一等状态,不是错误
  if (!isPlainObject(validation)) {
    return { ok: true, text: '未配置登录态', tone: 'none', daysLeft: null, actionLabel: '扫码登录' }
  }
  // daysLeft 先归一:非有限数当 null,后面每条规则就不必各自防御垃圾值
  const daysLeft = Number.isFinite(validation.daysLeft) ? validation.daysLeft : null

  if (validation.ok === false) {
    return { ok: true, text: '凭证读取失败', tone: 'error', daysLeft, actionLabel: '重新登录' }
  }
  if (validation.expired === true) {
    return { ok: true, text: '凭证已过期，请重新登录', tone: 'error', daysLeft, actionLabel: '重新登录' }
  }
  if (validation.usable !== true) {
    return { ok: true, text: INCOMPLETE_TEXT, tone: 'error', daysLeft, actionLabel: '重新登录' }
  }
  if (daysLeft === null) {
    return { ok: true, text: '登录态正常', tone: 'ok', daysLeft: null, actionLabel: '重新登录' }
  }
  if (daysLeft > 7) {
    return { ok: true, text: `登录态正常，还剩 ${daysLeft.toFixed(1)} 天`, tone: 'ok', daysLeft, actionLabel: '重新登录' }
  }
  if (daysLeft > 0) {
    return { ok: true, text: `登录态正常，还剩 ${daysLeft.toFixed(1)} 天（快过期了）`, tone: 'warn', daysLeft, actionLabel: '重新登录' }
  }
  // 走到这里:usable、没标过期,但天数已不剩——数据自相矛盾,提醒"可能已过期"而不是判死
  return { ok: true, text: '登录态可能已过期', tone: 'warn', daysLeft, actionLabel: '重新登录' }
}

/** 字段表:int 给 min/max,enum 给 options,不适用的槽位放 null——形状恒定,界面好遍历 */
export const BILI_FIELDS = [
  { key: 'peekCount', type: 'int', label: '看图抽帧数', unit: '帧', min: 3, max: 9, options: null, def: 6 },
  { key: 'asrAutoLimitMin', type: 'int', label: '自动转写上限', unit: '分钟', min: 1, max: 60, options: null, def: 10 },
  { key: 'qn', type: 'enum', label: '画质档位', unit: '', min: null, max: null, options: ['32', '64', '80'], def: '64' },
]

export function validateBiliField(key, value) {
  const field = BILI_FIELDS.find((entry) => entry.key === key)
  if (field === undefined) {
    return { ok: false, error: `未知字段「${String(key)}」——B 站设置卡只认 peekCount / asrAutoLimitMin / qn` }
  }
  if (value === null || value === undefined || value === '') {
    return { ok: false, error: `「${field.label}」没填——表单空着就是没填,不替你兜默认值` }
  }
  if (field.type === 'int') {
    if (typeof value !== 'number' && typeof value !== 'string') {
      return { ok: false, error: `「${field.label}」只接受数字或数字字符串,当前是 ${String(value)}` }
    }
    const numbered = Number(value)
    if (!Number.isInteger(numbered) || numbered < field.min || numbered > field.max) {
      return { ok: false, error: `「${field.label}」只接受 ${field.min}–${field.max} 的整数,当前是 ${String(value)}` }
    }
    return { ok: true, value: numbered }
  }
  // enum 用严格比较:数字 64 不等于字符串 '64',混过去界面就存了个错类型
  if (!field.options.includes(value)) {
    return { ok: false, error: `「${field.label}」只能是 ${field.options.join(' / ')} 之一,当前是 ${String(value)}` }
  }
  return { ok: true, value }
}

export function buildBiliPatch(current, next) {
  const failure = (reason) => ({ ok: false, reason })

  if (!isPlainObject(current) || !isPlainObject(next)) {
    return failure('current 或 next 不是对象')
  }
  const patch = {}
  const errors = []
  const changedKeys = new Set()
  // 只遍历 next 里出现的键:表单没动的字段不该进 patch
  for (const key of Object.keys(next)) {
    const validated = validateBiliField(key, next[key])
    if (validated.ok !== true) {
      // 一个字段出错不拖累别的:界面要能把错误逐条标出来
      errors.push({ key, error: validated.error })
      continue
    }
    if (current[key] !== validated.value) {
      patch[key] = validated.value
      changedKeys.add(key)
    }
  }
  // changed 按 BILI_FIELDS 的固定顺序收,不受 next 的键序影响
  const changed = BILI_FIELDS.filter((field) => changedKeys.has(field.key)).map((field) => field.key)
  return { ok: true, patch, changed, errors }
}
