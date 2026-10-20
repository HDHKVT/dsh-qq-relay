/**
 * 上行图片（`qq-direct.sendImage`）：先把图传上去拿 file_info，再 msg_type 7 发出去。
 * 用假 fetch，不碰真网络。
 */
import assert from 'node:assert/strict'
import { createDirect } from '../lib/qq-direct.js'

const calls = []
const fetchImpl = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null
  calls.push({ url, body })
  if (url.includes('/app/getAppAccessToken')) {
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 7200 }) }
  }
  if (url.endsWith('/files')) {
    return { ok: true, status: 200, json: async () => ({ file_info: 'FILE_INFO_1' }) }
  }
  if (url.endsWith('/messages')) {
    return { ok: true, status: 200, json: async () => ({ id: 'sent-1' }) }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}

const direct = createDirect({
  config: { appId: 'app', appSecret: 'secret' },
  fetchImpl,
  log: () => {},
  timers: { setTimeout, clearTimeout, setInterval, clearInterval },
})

const bytes = Buffer.from('fake-image-bytes')
const out = await direct.sendImage('user-openid', bytes, 'cat.png')
assert.equal(out.filename, 'cat.png')

const upload = calls.find((c) => c.url.endsWith('/files'))
assert.ok(upload, '要先上传')
assert.equal(upload.body.file_type, 1, '图片 file_type=1')
assert.equal(upload.body.srv_send_msg, false, '上传时不要立刻发')
assert.equal(upload.body.file_data, bytes.toString('base64'), '本地图用 base64 传')

const send = calls.find((c) => c.url.endsWith('/messages'))
assert.ok(send, '上传完要发消息')
assert.equal(send.body.msg_type, 7, '图片消息 msg_type=7')
assert.equal('content' in send.body, false, '不带配文时不许有 content 字段（空串/空格都会撑出空白）')
assert.equal(send.body.media.file_info, 'FILE_INFO_1')

// 合并模式：配文塞进同一条图片消息
calls.length = 0
await direct.sendImage('user-openid', bytes, 'cat.png', '', '看看这张')
const merged = calls.find((c) => c.url.endsWith('/messages'))
assert.equal(merged.body.content, '看看这张', 'merge 模式配文要并进图片消息')

// 被动回复时带上 msg_id / msg_seq（错开正式回复的编号）
calls.length = 0
await direct.sendImage('user-openid', bytes, 'cat.png', 'msg-1')
const passive = calls.find((c) => c.url.endsWith('/messages'))
assert.equal(passive.body.msg_id, 'msg-1')
assert.equal(passive.body.msg_seq, 2)

// 上传失败要抛错（调用方负责告诉用户）
const failing = createDirect({
  config: { appId: 'app', appSecret: 'secret' },
  fetchImpl: async (url) => (url.includes('getAppAccessToken')
    ? { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 7200 }) }
    : { ok: false, status: 400, json: async () => ({ code: 40034, message: 'bad media' }) }),
  log: () => {},
  timers: { setTimeout, clearTimeout, setInterval, clearInterval },
})
await assert.rejects(() => failing.sendImage('u', bytes), /传图失败.*40034/, '上传失败必须抛错')

// 发文件：file_type=4 + file_name；同样不带 content
calls.length = 0
await direct.sendFile('user-openid', Buffer.from('pdf-bytes'), '说明.pdf')
const fileUp = calls.find((c) => c.url.endsWith('/files'))
assert.equal(fileUp.body.file_type, 4, '文件 file_type=4')
assert.equal(fileUp.body.file_name, '说明.pdf')
assert.equal(fileUp.body.file_data, Buffer.from('pdf-bytes').toString('base64'))
const fileMsg = calls.find((c) => c.url.endsWith('/messages'))
assert.equal(fileMsg.body.msg_type, 7)
assert.equal('content' in fileMsg.body, false, '没配文就不带 content')

console.log('send-image.test.mjs: all assertions passed')
