/**
 * 回执（`lib/ack.js`）：该不该发、怎么填。
 */
import assert from 'node:assert/strict'
import { ackKind, shouldAck, renderAck } from '../lib/ack.js'

const ack = { enabled: true, mode: 'media', text: '收到你的{what}啦，正在看～' }

assert.equal(ackKind(true, false), '图片')
assert.equal(ackKind(false, true), '文件')
assert.equal(ackKind(false, false), '消息')

// 只对图片/文件发
assert.equal(shouldAck(ack, { hasImage: true, hasFile: false }), true)
assert.equal(shouldAck(ack, { hasImage: false, hasFile: true }), true)
assert.equal(shouldAck(ack, { hasImage: false, hasFile: false }), false, 'media 模式不发纯文字')

// 全部消息
assert.equal(shouldAck({ ...ack, mode: 'all' }, { hasImage: false, hasFile: false }), true)

// 关掉 / 空文案
assert.equal(shouldAck({ ...ack, enabled: false }, { hasImage: true, hasFile: false }), false)
assert.equal(shouldAck({ ...ack, text: '   ' }, { hasImage: true, hasFile: false }), false, '空文案等于不发')

// 文案替换
assert.equal(renderAck('收到你的{what}啦', '图片'), '收到你的图片啦')
assert.equal(renderAck('{what} / {what}', '文件'), '文件 / 文件')
assert.equal(renderAck('没有占位符', '消息'), '没有占位符')

console.log('ack.test.mjs: all assertions passed')
