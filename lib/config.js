/**
 * `relay.json` 的**唯一读写入口**（Task 1）。
 *
 * 为什么单独一层：直连 QQ 之后，这个文件里开始放**凭据**（appId / appSecret / ownerId），
 * 于是有三条规矩必须集中在一处：
 *   1. 对外快照（给浏览器）**只回 `hasSecret`**，永远不回明文；
 *   2. 写操作走白名单 + 校验，别让界面把任意键塞进来；
 *   3. 写之前留 `.bak`、写的时候先 `.tmp` 再改名（读者是另一个进程/另一个回合）。
 *
 * ⚠️ 与老代码的关系：`index.js` 里原有的键（`sessionId` / `mailbox` / `declarationDir` / `hint`）
 * 一个都不动；`writeConfig` 合并时把它们**原样保留**。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

/** 缺省值：与计划 §Task 1 完全一致，改这里等于改契约 */
export const DEFAULTS = Object.freeze({
  sessionId: null,
  transport: 'mailbox',
  direct: { appId: '', ownerId: '', intents: 33554432 },
  reply: { maxChars: 900, minGapMs: 2000, hint: true },
  image: { enabled: true, maxMb: 12, retentionDays: 7, dir: '', gifFrames: 4, batchMs: 800 },
  file: { enabled: true, maxMb: 20, retentionDays: 7, dir: '' },
  ack: { enabled: true, mode: 'media', text: '收到啦，正在看你的{what}，稍等一下～' },
  send: { captionMode: 'merge', fileMaxMb: 30 },
  sticker: { enabled: true, trigger: '存表情包', dir: '', byQuote: true, byAttach: true, byRecent: true, recentMs: 120000, frequency: 'normal' },
  video: { enabled: true, python: '', script: '', outDir: '', maxMb: 2048, timeoutSec: 1800, mode: 'accurate', model: 'auto', modelDir: '', maxGrid: 8, biliCookie: '', biliDir: '', retentionDays: 7 },
  ui: { showCard: true },
})

/** 可写的顶层键（老的 mailbox / declarationDir / hint 只保留、不通过这里改） */
const TOP_KEYS = new Set(['sessionId', 'transport', 'direct', 'reply', 'image', 'file', 'ack', 'send', 'sticker', 'video', 'ui'])
const DIRECT_KEYS = new Set(['appId', 'appSecret', 'ownerId', 'intents'])
const REPLY_KEYS = new Set(['maxChars', 'minGapMs', 'hint'])
const IMAGE_KEYS = new Set(['enabled', 'maxMb', 'retentionDays', 'dir', 'gifFrames', 'batchMs'])
const FILE_KEYS = new Set(['enabled', 'maxMb', 'retentionDays', 'dir'])
const ACK_KEYS = new Set(['enabled', 'mode', 'text'])
const STICKER_KEYS = new Set(['enabled', 'trigger', 'dir', 'byQuote', 'byAttach', 'byRecent', 'recentMs', 'frequency'])
const SEND_KEYS = new Set(['captionMode', 'fileMaxMb'])
const VIDEO_KEYS = new Set(['enabled', 'python', 'script', 'outDir', 'maxMb', 'timeoutSec', 'mode', 'model', 'modelDir', 'maxGrid', 'biliCookie', 'biliDir', 'retentionDays'])
const UI_KEYS = new Set(['showCard'])

const LIMITS = {
  appId: 64,
  appSecret: 128,
  ownerId: 128,
  maxChars: [100, 1000],
  minGapMs: [0, 60_000],
  maxMb: [1, 50],
  fileMaxMb: [1, 100],
  ackText: 200,
  trigger: 24,
  retentionDays: [0, 90],
  gifFrames: [2, 8],
  batchMs: [0, 5000],
  dir: 300,
}

const fileOf = (baseDir) => join(baseDir, 'relay.json')

/** 容错读：文件坏了 / 没有 ⇒ 空对象（绝不因为配置坏了拖垮宿主） */
function readRaw(baseDir) {
  try {
    const value = JSON.parse(readFileSync(fileOf(baseDir), 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 字符串字段：必须是非空串且不超上限 */
function checkString(value, name, max, errors) {
  if (typeof value !== 'string') { errors.push(`${name} 必须是字符串`); return false }
  if (value.length > max) { errors.push(`${name} 太长（上限 ${max}）`); return false }
  return true
}

/**
 * 读配置（内部用，**含明文密钥**）。
 * @param {string} baseDir - `relay.json` 所在目录
 * @returns {{sessionId: string|null, transport: 'mailbox'|'direct', direct: {appId: string, appSecret: string, ownerId: string, intents: number}, reply: {maxChars: number, minGapMs: number, hint: boolean}}}
 */
export function readConfig(baseDir) {
  const raw = readRaw(baseDir)
  const direct = isObject(raw.direct) ? raw.direct : {}
  const reply = isObject(raw.reply) ? raw.reply : {}
  const image = isObject(raw.image) ? raw.image : {}
  const file = isObject(raw.file) ? raw.file : {}
  const ack = isObject(raw.ack) ? raw.ack : {}
  const send = isObject(raw.send) ? raw.send : {}
  const sticker = isObject(raw.sticker) ? raw.sticker : {}
  const video = isObject(raw.video) ? raw.video : {}
  const ui = isObject(raw.ui) ? raw.ui : {}
  return {
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null,
    transport: raw.transport === 'direct' ? 'direct' : 'mailbox',
    direct: {
      appId: typeof direct.appId === 'string' ? direct.appId : DEFAULTS.direct.appId,
      appSecret: typeof direct.appSecret === 'string' ? direct.appSecret : '',
      ownerId: typeof direct.ownerId === 'string' ? direct.ownerId : DEFAULTS.direct.ownerId,
      intents: Number.isInteger(direct.intents) ? direct.intents : DEFAULTS.direct.intents,
    },
    reply: {
      maxChars: Number.isInteger(reply.maxChars) ? reply.maxChars : DEFAULTS.reply.maxChars,
      minGapMs: Number.isInteger(reply.minGapMs) ? reply.minGapMs : DEFAULTS.reply.minGapMs,
      hint: typeof reply.hint === 'boolean' ? reply.hint : DEFAULTS.reply.hint,
    },
    image: {
      enabled: typeof image.enabled === 'boolean' ? image.enabled : DEFAULTS.image.enabled,
      maxMb: Number.isInteger(image.maxMb) ? image.maxMb : DEFAULTS.image.maxMb,
      retentionDays: Number.isInteger(image.retentionDays) ? image.retentionDays : DEFAULTS.image.retentionDays,
      dir: typeof image.dir === 'string' ? image.dir : DEFAULTS.image.dir,
      gifFrames: Number.isInteger(image.gifFrames) ? image.gifFrames : DEFAULTS.image.gifFrames,
      batchMs: Number.isInteger(image.batchMs) ? image.batchMs : DEFAULTS.image.batchMs,
    },
    file: {
      enabled: typeof file.enabled === 'boolean' ? file.enabled : DEFAULTS.file.enabled,
      maxMb: Number.isInteger(file.maxMb) ? file.maxMb : DEFAULTS.file.maxMb,
      retentionDays: Number.isInteger(file.retentionDays) ? file.retentionDays : DEFAULTS.file.retentionDays,
      dir: typeof file.dir === 'string' ? file.dir : DEFAULTS.file.dir,
    },
    ack: {
      enabled: typeof ack.enabled === 'boolean' ? ack.enabled : DEFAULTS.ack.enabled,
      mode: ack.mode === 'all' ? 'all' : 'media',
      text: typeof ack.text === 'string' ? ack.text : DEFAULTS.ack.text,
    },
    send: {
      captionMode: send.captionMode === 'separate' ? 'separate' : 'merge',
      fileMaxMb: Number.isInteger(send.fileMaxMb) ? send.fileMaxMb : DEFAULTS.send.fileMaxMb,
    },
    sticker: {
      enabled: typeof sticker.enabled === 'boolean' ? sticker.enabled : DEFAULTS.sticker.enabled,
      trigger: typeof sticker.trigger === 'string' && sticker.trigger.trim() !== '' ? sticker.trigger : DEFAULTS.sticker.trigger,
      dir: typeof sticker.dir === 'string' ? sticker.dir : DEFAULTS.sticker.dir,
      byQuote: typeof sticker.byQuote === 'boolean' ? sticker.byQuote : DEFAULTS.sticker.byQuote,
      byAttach: typeof sticker.byAttach === 'boolean' ? sticker.byAttach : DEFAULTS.sticker.byAttach,
      byRecent: typeof sticker.byRecent === 'boolean' ? sticker.byRecent : DEFAULTS.sticker.byRecent,
      recentMs: Number.isInteger(sticker.recentMs) ? sticker.recentMs : DEFAULTS.sticker.recentMs,
      frequency: ['off', 'rare', 'normal', 'often'].includes(sticker.frequency) ? sticker.frequency : DEFAULTS.sticker.frequency,
    },
    video: {
      enabled: typeof video.enabled === 'boolean' ? video.enabled : DEFAULTS.video.enabled,
      python: typeof video.python === 'string' ? video.python : DEFAULTS.video.python,
      script: typeof video.script === 'string' ? video.script : DEFAULTS.video.script,
      outDir: typeof video.outDir === 'string' ? video.outDir : DEFAULTS.video.outDir,
      maxMb: Number.isInteger(video.maxMb) ? video.maxMb : DEFAULTS.video.maxMb,
      timeoutSec: Number.isInteger(video.timeoutSec) ? video.timeoutSec : DEFAULTS.video.timeoutSec,
      mode: video.mode === 'fast' ? 'fast' : DEFAULTS.video.mode,
      model: ['auto', 'base', 'small', 'medium', 'large-v3-turbo'].includes(video.model) ? video.model : DEFAULTS.video.model,
      modelDir: typeof video.modelDir === 'string' ? video.modelDir : DEFAULTS.video.modelDir,
      biliCookie: typeof video.biliCookie === 'string' ? video.biliCookie : DEFAULTS.video.biliCookie,
      biliDir: typeof video.biliDir === 'string' ? video.biliDir : DEFAULTS.video.biliDir,
      retentionDays: Number.isInteger(video.retentionDays) ? video.retentionDays : DEFAULTS.video.retentionDays,
      maxGrid: Number.isInteger(video.maxGrid) ? video.maxGrid : DEFAULTS.video.maxGrid,
    },
    ui: {
      showCard: typeof ui.showCard === 'boolean' ? ui.showCard : DEFAULTS.ui.showCard,
    },
  }
}

/**
 * 给浏览器的快照：**密钥换成布尔**，其余字段原样。
 * @param {ReturnType<typeof readConfig>} config
 * @returns {object}
 */
export function publicConfig(config) {
  const { sessionId, transport, direct, reply, image, file, ack, send, sticker, video, ui } = config || {}
  return {
    sessionId: sessionId ?? null,
    transport: transport ?? DEFAULTS.transport,
    direct: {
      appId: (direct && direct.appId) || '',
      ownerId: (direct && direct.ownerId) || '',
      intents: (direct && direct.intents) || DEFAULTS.direct.intents,
      hasSecret: Boolean(direct && direct.appSecret),
    },
    reply: { ...DEFAULTS.reply, ...(reply || {}) },
    image: { ...DEFAULTS.image, ...(image || {}) },
    file: { ...DEFAULTS.file, ...(file || {}) },
    ack: { ...DEFAULTS.ack, ...(ack || {}) },
    send: { ...DEFAULTS.send, ...(send || {}) },
    sticker: { ...DEFAULTS.sticker, ...(sticker || {}) },
    video: { ...DEFAULTS.video, ...(video || {}), biliCookie: undefined, hasBiliCookie: Boolean(video && video.biliCookie) },
    ui: { ...DEFAULTS.ui, ...(ui || {}) },
  }
}

/**
 * 合并写（白名单 + 校验 + `.bak` + 原子改名）。
 *
 * `direct.appSecret === ''` 表示“界面没改它”⇒ **保留旧值**，不是清空。
 * @param {string} baseDir
 * @param {object} patch
 * @returns {{ok: true} | {ok: false, why: string}}
 */
export function writeConfig(baseDir, patch) {
  if (!isObject(patch)) return { ok: false, why: 'patch 必须是对象' }
  const unknown = Object.keys(patch).filter((key) => !TOP_KEYS.has(key))
  if (unknown.length > 0) return { ok: false, why: `不认识的键：${unknown.join(', ')}` }

  const errors = []
  const next = readRaw(baseDir)

  if ('sessionId' in patch) {
    const value = patch.sessionId
    if (value !== null && !checkString(value, 'sessionId', 200, errors)) return { ok: false, why: errors.join('；') }
    next.sessionId = value
  }

  if ('transport' in patch) {
    if (patch.transport !== 'mailbox' && patch.transport !== 'direct') {
      return { ok: false, why: 'transport 只认 mailbox 或 direct' }
    }
    next.transport = patch.transport
  }

  if ('direct' in patch) {
    if (!isObject(patch.direct)) return { ok: false, why: 'direct 必须是对象' }
    const bad = Object.keys(patch.direct).filter((key) => !DIRECT_KEYS.has(key))
    if (bad.length > 0) return { ok: false, why: `direct 里不认识的键：${bad.join(', ')}` }
    const merged = { ...(isObject(next.direct) ? next.direct : {}) }
    const incoming = patch.direct
    if ('appId' in incoming && checkString(incoming.appId, 'direct.appId', LIMITS.appId, errors)) merged.appId = incoming.appId
    if ('ownerId' in incoming && checkString(incoming.ownerId, 'direct.ownerId', LIMITS.ownerId, errors)) merged.ownerId = incoming.ownerId
    if ('appSecret' in incoming) {
      if (!checkString(incoming.appSecret, 'direct.appSecret', LIMITS.appSecret, errors)) {
        // 空串是合法输入（= 不修改），但类型必须对
      } else if (incoming.appSecret !== '') {
        merged.appSecret = incoming.appSecret
      }
    }
    if ('intents' in incoming) {
      if (!Number.isInteger(incoming.intents) || incoming.intents <= 0) errors.push('direct.intents 必须是正整数')
      else merged.intents = incoming.intents
    }
    if (errors.length > 0) return { ok: false, why: errors.join('；') }
    next.direct = merged
  }

  if ('reply' in patch) {
    if (!isObject(patch.reply)) return { ok: false, why: 'reply 必须是对象' }
    const bad = Object.keys(patch.reply).filter((key) => !REPLY_KEYS.has(key))
    if (bad.length > 0) return { ok: false, why: `reply 里不认识的键：${bad.join(', ')}` }
    const merged = { ...DEFAULTS.reply, ...(isObject(next.reply) ? next.reply : {}) }
    const incoming = patch.reply
    if ('maxChars' in incoming) {
      const [min, max] = LIMITS.maxChars
      if (!Number.isInteger(incoming.maxChars) || incoming.maxChars < min || incoming.maxChars > max) {
        errors.push(`reply.maxChars 必须是 ${min}~${max} 的整数`)
      } else merged.maxChars = incoming.maxChars
    }
    if ('minGapMs' in incoming) {
      const [min, max] = LIMITS.minGapMs
      if (!Number.isInteger(incoming.minGapMs) || incoming.minGapMs < min || incoming.minGapMs > max) {
        errors.push(`reply.minGapMs 必须是 ${min}~${max} 的整数`)
      } else merged.minGapMs = incoming.minGapMs
    }
    if ('hint' in incoming) {
      if (typeof incoming.hint !== 'boolean') errors.push('reply.hint 必须是布尔')
      else merged.hint = incoming.hint
    }
    if (errors.length > 0) return { ok: false, why: errors.join('；') }
    next.reply = merged
  }

  if ('image' in patch) {
    if (!isObject(patch.image)) return { ok: false, why: 'image 必须是对象' }
    const bad = Object.keys(patch.image).filter((key) => !IMAGE_KEYS.has(key))
    if (bad.length > 0) return { ok: false, why: `image 里不认识的键：${bad.join(', ')}` }
    const merged = { ...DEFAULTS.image, ...(isObject(next.image) ? next.image : {}) }
    const incoming = patch.image
    if ('enabled' in incoming) {
      if (typeof incoming.enabled !== 'boolean') errors.push('image.enabled 必须是布尔')
      else merged.enabled = incoming.enabled
    }
    if ('maxMb' in incoming) {
      const [min, max] = LIMITS.maxMb
      if (!Number.isInteger(incoming.maxMb) || incoming.maxMb < min || incoming.maxMb > max) {
        errors.push(`image.maxMb 必须是 ${min}~${max} 的整数`)
      } else merged.maxMb = incoming.maxMb
    }
    if ('retentionDays' in incoming) {
      const [min, max] = LIMITS.retentionDays
      if (!Number.isInteger(incoming.retentionDays) || incoming.retentionDays < min || incoming.retentionDays > max) {
        errors.push(`image.retentionDays 必须是 ${min}~${max} 的整数（0 = 不落盘）`)
      } else merged.retentionDays = incoming.retentionDays
    }
    if ('dir' in incoming) {
      if (!checkString(incoming.dir, 'image.dir', LIMITS.dir, errors)) {
        // 空串合法（= 用默认目录）
      } else merged.dir = incoming.dir
    }
    if ('gifFrames' in incoming) {
      const [min, max] = LIMITS.gifFrames
      if (!Number.isInteger(incoming.gifFrames) || incoming.gifFrames < min || incoming.gifFrames > max) {
        errors.push(`image.gifFrames 必须是 ${min}~${max} 的整数`)
      } else merged.gifFrames = incoming.gifFrames
    }
    if ('batchMs' in incoming) {
      const [min, max] = LIMITS.batchMs
      if (!Number.isInteger(incoming.batchMs) || incoming.batchMs < min || incoming.batchMs > max) {
        errors.push(`image.batchMs 必须是 ${min}~${max} 的整数（0 = 不合并）`)
      } else merged.batchMs = incoming.batchMs
    }
    if (errors.length > 0) return { ok: false, why: errors.join('；') }
    next.image = merged
  }

  if ('file' in patch) {
    if (!isObject(patch.file)) return { ok: false, why: 'file 必须是对象' }
    const bad = Object.keys(patch.file).filter((key) => !FILE_KEYS.has(key))
    if (bad.length > 0) return { ok: false, why: `file 里不认识的键：${bad.join(', ')}` }
    const merged = { ...DEFAULTS.file, ...(isObject(next.file) ? next.file : {}) }
    const incoming = patch.file
    if ('enabled' in incoming) {
      if (typeof incoming.enabled !== 'boolean') errors.push('file.enabled 必须是布尔')
      else merged.enabled = incoming.enabled
    }
    if ('maxMb' in incoming) {
      const [min, max] = LIMITS.fileMaxMb
      if (!Number.isInteger(incoming.maxMb) || incoming.maxMb < min || incoming.maxMb > max) {
        errors.push(`file.maxMb 必须是 ${min}~${max} 的整数`)
      } else merged.maxMb = incoming.maxMb
    }
    if ('retentionDays' in incoming) {
      const [min, max] = LIMITS.retentionDays
      if (!Number.isInteger(incoming.retentionDays) || incoming.retentionDays < min || incoming.retentionDays > max) {
        errors.push(`file.retentionDays 必须是 ${min}~${max} 的整数（0 = 不落盘）`)
      } else merged.retentionDays = incoming.retentionDays
    }
    if ('dir' in incoming) {
      if (!checkString(incoming.dir, 'file.dir', LIMITS.dir, errors)) {
        // 空串合法
      } else merged.dir = incoming.dir
    }
    if (errors.length > 0) return { ok: false, why: errors.join('；') }
    next.file = merged
  }

  if ('ack' in patch) {
    if (!isObject(patch.ack)) return { ok: false, why: 'ack 必须是对象' }
    const bad = Object.keys(patch.ack).filter((key) => !ACK_KEYS.has(key))
    if (bad.length > 0) return { ok: false, why: `ack 里不认识的键：${bad.join(', ')}` }
    const merged = { ...DEFAULTS.ack, ...(isObject(next.ack) ? next.ack : {}) }
    const incoming = patch.ack
    if ('enabled' in incoming) {
      if (typeof incoming.enabled !== 'boolean') errors.push('ack.enabled 必须是布尔')
      else merged.enabled = incoming.enabled
    }
    if ('mode' in incoming) {
      if (incoming.mode !== 'media' && incoming.mode !== 'all') errors.push('ack.mode 只能是 media 或 all')
      else merged.mode = incoming.mode
    }
    if ('text' in incoming) {
      if (!checkString(incoming.text, 'ack.text', LIMITS.ackText, errors)) {
        // 空串合法（= 不发回执）
      } else merged.text = incoming.text
    }
    if (errors.length > 0) return { ok: false, why: errors.join('；') }
    next.ack = merged
  }

  if ('send' in patch) {
    if (!isObject(patch.send)) return { ok: false, why: 'send 必须是对象' }
    const bad = Object.keys(patch.send).filter((key) => !SEND_KEYS.has(key))
    if (bad.length > 0) return { ok: false, why: `send 里不认识的键：${bad.join(', ')}` }
    const merged = { ...DEFAULTS.send, ...(isObject(next.send) ? next.send : {}) }
    if ('captionMode' in patch.send) {
      if (patch.send.captionMode !== 'merge' && patch.send.captionMode !== 'separate') {
        errors.push('send.captionMode 只能是 merge 或 separate')
      } else merged.captionMode = patch.send.captionMode
    }
    if ('fileMaxMb' in patch.send) {
      if (!Number.isInteger(patch.send.fileMaxMb) || patch.send.fileMaxMb < 1 || patch.send.fileMaxMb > 200) {
        errors.push('send.fileMaxMb 必须是 1~200 的整数')
      } else merged.fileMaxMb = patch.send.fileMaxMb
    }
    if (errors.length > 0) return { ok: false, why: errors.join('；') }
    next.send = merged
  }

  if ('sticker' in patch) {
    if (!isObject(patch.sticker)) return { ok: false, why: 'sticker 必须是对象' }
    const bad = Object.keys(patch.sticker).filter((key) => !STICKER_KEYS.has(key))
    if (bad.length > 0) return { ok: false, why: `sticker 里不认识的键：${bad.join(', ')}` }
    const merged = { ...DEFAULTS.sticker, ...(isObject(next.sticker) ? next.sticker : {}) }
    const incoming = patch.sticker
    if ('enabled' in incoming) {
      if (typeof incoming.enabled !== 'boolean') errors.push('sticker.enabled 必须是布尔')
      else merged.enabled = incoming.enabled
    }
    if ('trigger' in incoming) {
      if (typeof incoming.trigger !== 'string' || incoming.trigger.trim() === '' || incoming.trigger.length > LIMITS.trigger) {
        errors.push(`sticker.trigger 必须是 1~${LIMITS.trigger} 字的非空字符串`)
      } else merged.trigger = incoming.trigger.trim()
    }
    if ('dir' in incoming) {
      if (!checkString(incoming.dir, 'sticker.dir', LIMITS.dir, errors)) {
        // 空串合法
      } else merged.dir = incoming.dir
    }
    for (const key of ['byQuote', 'byAttach', 'byRecent']) {
      if (key in incoming) {
        if (typeof incoming[key] !== 'boolean') errors.push(`sticker.${key} 必须是布尔`)
        else merged[key] = incoming[key]
      }
    }
    if ('recentMs' in incoming) {
      if (!Number.isInteger(incoming.recentMs) || incoming.recentMs < 0 || incoming.recentMs > 600000) {
        errors.push('sticker.recentMs 必须是 0~600000 的整数')
      } else merged.recentMs = incoming.recentMs
    }
    if ('frequency' in incoming) {
      if (!['off', 'rare', 'normal', 'often'].includes(incoming.frequency)) {
        errors.push('sticker.frequency 只能是 off / rare / normal / often')
      } else merged.frequency = incoming.frequency
    }
    if (errors.length > 0) return { ok: false, why: errors.join('；') }
    next.sticker = merged
  }

  if ('ui' in patch) {
    if (!isObject(patch.ui)) return { ok: false, why: 'ui 必须是对象' }
    const bad = Object.keys(patch.ui).filter((key) => !UI_KEYS.has(key))
    if (bad.length > 0) return { ok: false, why: `ui 里不认识的键：${bad.join(', ')}` }
    const merged = { ...DEFAULTS.ui, ...(isObject(next.ui) ? next.ui : {}) }
    if ('showCard' in patch.ui) {
      if (typeof patch.ui.showCard !== 'boolean') errors.push('ui.showCard 必须是布尔')
      else merged.showCard = patch.ui.showCard
    }
    if (errors.length > 0) return { ok: false, why: errors.join('；') }
    next.ui = merged
  }

  if ('video' in patch) {
    if (!isObject(patch.video)) return { ok: false, why: 'video 必须是对象' }
    const bad = Object.keys(patch.video).filter((key) => !VIDEO_KEYS.has(key))
    if (bad.length > 0) return { ok: false, why: `video 里不认识的键：${bad.join(', ')}` }
    const merged = { ...DEFAULTS.video, ...(isObject(next.video) ? next.video : {}) }
    const incoming = patch.video
    if ('enabled' in incoming) {
      if (typeof incoming.enabled !== 'boolean') errors.push('video.enabled 必须是布尔')
      else merged.enabled = incoming.enabled
    }
    for (const key of ['python', 'script', 'outDir']) {
      if (key in incoming) {
        if (typeof incoming[key] !== 'string' || incoming[key].length > 300) errors.push(`video.${key} 必须是字符串（≤300）`)
        else merged[key] = incoming[key]
      }
    }
    if ('maxMb' in incoming) {
      if (!Number.isInteger(incoming.maxMb) || incoming.maxMb < 1 || incoming.maxMb > 4096) errors.push('video.maxMb 必须是 1~4096 的整数')
      else merged.maxMb = incoming.maxMb
    }
    if ('timeoutSec' in incoming) {
      if (!Number.isInteger(incoming.timeoutSec) || incoming.timeoutSec < 10 || incoming.timeoutSec > 7200) errors.push('video.timeoutSec 必须是 10~7200 的整数')
      else merged.timeoutSec = incoming.timeoutSec
    }
    if ('mode' in incoming) {
      if (!['fast', 'accurate'].includes(incoming.mode)) errors.push('video.mode 只能是 fast / accurate')
      else merged.mode = incoming.mode
    }
    if ('model' in incoming) {
      if (!['auto', 'base', 'small', 'medium', 'large-v3-turbo'].includes(incoming.model)) errors.push('video.model 只能是 auto / base / small / medium / large-v3-turbo')
      else merged.model = incoming.model
    }
    if ('biliDir' in incoming) {
      if (typeof incoming.biliDir !== 'string' || incoming.biliDir.length > 300) errors.push('video.biliDir 必须是字符串（≤300）')
      else merged.biliDir = incoming.biliDir
    }
    if ('retentionDays' in incoming) {
      if (!Number.isInteger(incoming.retentionDays) || incoming.retentionDays < 0 || incoming.retentionDays > 365) errors.push('video.retentionDays 必须是 0~365 的整数')
      else merged.retentionDays = incoming.retentionDays
    }
    if ('biliCookie' in incoming) {
      if (typeof incoming.biliCookie !== 'string' || incoming.biliCookie.length > 2000) errors.push('video.biliCookie 必须是字符串（≤2000）')
      else merged.biliCookie = incoming.biliCookie
    }
    if ('modelDir' in incoming) {
      if (typeof incoming.modelDir !== 'string' || incoming.modelDir.length > 300) errors.push('video.modelDir 必须是字符串（≤300）')
      else merged.modelDir = incoming.modelDir
    }
    if ('maxGrid' in incoming) {
      if (!Number.isInteger(incoming.maxGrid) || incoming.maxGrid < 1 || incoming.maxGrid > 16) errors.push('video.maxGrid 必须是 1~16 的整数')
      else merged.maxGrid = incoming.maxGrid
    }
    if (errors.length > 0) return { ok: false, why: errors.join('；') }
    next.video = merged
  }

  try {
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })
    const file = fileOf(baseDir)
    if (existsSync(file)) copyFileSync(file, `${file}.bak`)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file)
    return { ok: true }
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) }
  }
}
