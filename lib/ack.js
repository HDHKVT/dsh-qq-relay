/**
 * 回执（“收到啦，正在看”）的纯逻辑：该不该发、文案怎么填。
 * 抽出来是为了能单测 —— 真正发消息的动作在 `index.js`。
 */

/**
 * 这条消息在回执里算“什么”。
 * @param {boolean} hasImage
 * @param {boolean} hasFile
 * @returns {'图片'|'文件'|'消息'}
 */
export function ackKind(hasImage, hasFile) {
  if (hasImage) return '图片'
  if (hasFile) return '文件'
  return '消息'
}

/**
 * @param {{enabled?: boolean, mode?: 'media'|'all', text?: string}} ack
 * @param {{hasImage: boolean, hasFile: boolean}} input
 * @returns {boolean}
 */
export function shouldAck(ack, { hasImage, hasFile }) {
  if (!ack || ack.enabled !== true) return false
  if (ack.mode === 'media' && !hasImage && !hasFile) return false
  return String(ack.text || '').trim() !== ''
}

/**
 * 把 `{what}` 换成实际类型。
 * @param {string} text
 * @param {string} kind
 * @returns {string}
 */
export function renderAck(text, kind) {
  return String(text || '').replace(/\{what\}/g, kind)
}
