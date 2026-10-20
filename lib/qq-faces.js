/**
 * QQ 自带小表情的 id → 名字（**跟着插件走**，不联网、不依赖任何包）。
 *
 * 为什么要它：QQ 的表情在消息里只是一段 `<faceType=6,faceId="0",…>`，
 * 没有像素也没有名字。没有这张表，会话里只能看到「（发来一个表情）」；
 * 有了它，就能读到「（表情：微笑）」—— 便宜、离线、可测。
 *
 * ⚠️ 只收**常见的那一批**（0~100 及少数几个）。表里没有的 id 一律显示
 * `（表情 #id）`，**不猜名字**：猜错比不认得更糟。
 *
 * ⚠️ 微信/QQ 的标记里 `faceType` 与 `faceId` 都可能承载编号；本机实测的
 * 样本是 `<faceType=6,faceId="0">`，按 `faceId` 取（取不到再退 `faceType`）。
 */

/** 经典表情 0~100（QQ 默认表情包的那一套） */
export const FACE_NAMES = Object.freeze({
  0: '微笑', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪',
  6: '害羞', 7: '闭嘴', 8: '睡', 9: '大哭', 10: '尴尬',
  11: '发怒', 12: '调皮', 13: '呲牙', 14: '惊讶', 15: '难过',
  16: '酷', 17: '冷汗', 18: '抓狂', 19: '吐', 20: '偷笑',
  21: '可爱', 22: '白眼', 23: '傲慢', 24: '饥饿', 25: '困',
  26: '惊恐', 27: '流汗', 28: '憨笑', 29: '大兵', 30: '奋斗',
  31: '咒骂', 32: '疑问', 33: '嘘', 34: '晕', 35: '折磨',
  36: '衰', 37: '骷髅', 38: '敲打', 39: '再见', 40: '擦汗',
  41: '抠鼻', 42: '鼓掌', 43: '糗大了', 44: '坏笑', 45: '左哼哼',
  46: '右哼哼', 47: '哈欠', 48: '鄙视', 49: '委屈', 50: '快哭了',
  51: '阴险', 52: '亲亲', 53: '吓', 54: '可怜', 55: '菜刀',
  56: '西瓜', 57: '啤酒', 58: '篮球', 59: '乒乓', 60: '咖啡',
  61: '饭', 62: '猪头', 63: '玫瑰', 64: '凋谢', 65: '示爱',
  66: '爱心', 67: '心碎', 68: '蛋糕', 69: '闪电', 70: '炸弹',
  71: '刀', 72: '足球', 73: '瓢虫', 74: '便便', 75: '月亮',
  76: '太阳', 77: '礼物', 78: '抱抱', 79: '赞', 80: '踩',
  81: '握手', 82: '胜利', 83: '抱拳', 84: '勾引', 85: '拳头',
  86: '差劲', 87: '爱你', 88: 'NO', 89: 'OK', 90: '爱情',
  91: '飞吻', 92: '跳跳', 93: '发抖', 94: '怄火', 95: '转圈',
  96: '磕头', 97: '回头', 98: '跳绳', 99: '挥手', 100: '激动',
  101: '街舞', 102: '献吻', 103: '左太极', 104: '右太极', 105: '双喜',
  106: '鞭炮', 107: '灯笼', 108: '发财', 109: 'K歌', 110: '购物',
  111: '邮件', 112: '帅', 113: '喝彩', 114: '祈祷', 115: '爆筋',
  116: '棒棒糖', 117: '喝奶', 118: '下面', 119: '香蕉', 120: '飞机',
})

/**
 * 用户自定义表（`faces.json`）：id → 名字。**优先于内置表**。
 * 这样不认识的 id（比如新版 478）可以现场教，不用改代码。
 */
let custom = new Map()

/**
 * 整体替换自定义表（宿主在启动/导入时调用）。
 * @param {Record<string|number, string>} map
 */
export function setCustomFaces(map) {
  custom = new Map()
  if (!map || typeof map !== 'object' || Array.isArray(map)) return
  for (const [key, value] of Object.entries(map)) {
    const id = Number(key)
    if (!Number.isInteger(id) || id < 0) continue
    if (typeof value !== 'string' || value.trim() === '') continue
    custom.set(String(id), value.trim())
  }
}

/** 自定义表里有多少条 */
export function customFaceCount() {
  return custom.size
}

/**
 * 取表情名（自定义表优先，其次内置表）。
 * @param {number|string} id
 * @returns {string|null}
 */
export function faceName(id) {
  if (id === undefined || id === null || id === '') return null
  const key = Number(id)
  if (!Number.isInteger(key)) return null
  const hit = custom.get(String(key))
  if (hit) return hit
  return FACE_NAMES[key] ?? null
}

/**
 * 生成给会话看的标签：认识就写名字，不认识就写编号。
 * @param {string} faceType - 标记里的 `faceType`
 * @param {string} faceId - 标记里的 `faceId`
 * @returns {string}
 */
export function faceLabel(faceType, faceId) {
  const id = faceId !== undefined && faceId !== '' ? faceId : faceType
  const name = faceName(id)
  return name ? `（表情：${name}）` : `（表情 #${id ?? '?'}）`
}
