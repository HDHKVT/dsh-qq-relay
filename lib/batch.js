/**
 * 把“连发几张图”合成一条消息（阶段 2 补丁，2026-10-18）。
 *
 * 为什么需要：QQ 客户端一次发多张图时，**会拆成多条 C2C 消息**（实测四条
 * 在 0.5 秒内到达，每条只带一张图），所以 `image.multi`（一条消息多个附件）
 * 根本不会触发 —— 会话里就变成一张一张排队进来。
 *
 * 做法：只收「只有图、没有字」的主人私聊，在 `windowMs` 内攒起来，
 * 超时或攒够 `max` 张就合成一条：正文「（发来 N 张图）」，附件合并。
 * 有文字的消息**不攒**，立刻走原路（否则“两句话”会被合成一句）。
 */
import { stripFaces } from './delivery.js'

/**
 * @param {object} options
 * @param {number|(() => number)} [options.windowMs] - 攒多久（毫秒）；`<= 0` = 关闭合并；可传函数以实时读配置
 * @param {number} [options.max] - 最多几张就提前 flush
 * @param {(event: object) => void} options.onBatch
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers]
 * @returns {{offer: (event: object) => boolean, flush: () => void, dispose: () => void}}
 */
export function createImageBatcher(options) {
  const {
    windowMs = 800,
    max = 20,
    onBatch,
    timers = { setTimeout, clearTimeout },
  } = options
  let buffer = null
  let timer = null

  const flush = () => {
    if (timer) { timers.clearTimeout(timer); timer = null }
    if (!buffer) return
    const done = buffer
    buffer = null
    onBatch({
      type: 'C2C_MESSAGE_CREATE',
      openid: done.openid,
      msgId: done.msgId,
      text: `（发来 ${done.count} 张图）`,
      attachments: done.attachments,
      msgElements: done.msgElements,
      at: Date.now(),
    })
  }

  /**
   * 试着把一条事件塞进批次。
   * @param {object} event
   * @returns {boolean} true = 已收进批次（调用方不要再单独投递）
   */
  function offer(event) {
    const win = typeof windowMs === 'function' ? Number(windowMs()) : windowMs
    if (!Number.isFinite(win) || win <= 0) return false
    if (!event || event.type !== 'C2C_MESSAGE_CREATE') return false
    const { text } = stripFaces(event.text)
    if (text !== '') return false // 带字的走原路
    const attachments = Array.isArray(event.attachments) ? event.attachments : []
    const msgElements = Array.isArray(event.msgElements) ? event.msgElements : []
    if (attachments.length + msgElements.length === 0) return false // 纯表情/空消息
    // 📎 只攒**图片**：混着文件的、或纯文件的消息走原路（文件有自己的落盘流程）
    const allImages = [...attachments, ...msgElements].every((item) => String(item && item.content_type || '').startsWith('image/'))
    if (!allImages) return false

    if (!buffer) {
      buffer = { openid: event.openid, msgId: event.msgId, attachments: [], msgElements: [], count: 0 }
    }
    buffer.attachments.push(...attachments)
    buffer.msgElements.push(...msgElements)
    buffer.count = buffer.attachments.length + buffer.msgElements.length
    if (buffer.count >= max) { flush(); return true }
    if (timer) timers.clearTimeout(timer)
    timer = timers.setTimeout(flush, win)
    return true
  }

  return {
    offer,
    flush,
    dispose() {
      if (timer) { timers.clearTimeout(timer); timer = null }
      buffer = null
    },
  }
}
