/**
 * 阶段 2 · Task 7 测试（纯本地：假 fetch、临时目录，不联网）
 *
 * 钉住：文件头认类型、挑第一张图、体积闸**先看 Content-Length**、
 * 原子落盘 + 侧车、按天数清理、清空。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  sniffMime, pickImage, pickImages, downloadImage, saveImage, pruneIncoming, clearIncoming,
  imageDirOf, incomingDirOf, MAX_IMAGE_BYTES_DEFAULT,
} from '../lib/vision.js'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// ---------------------------------------------------------------- sniffMime
{
  assert.equal(sniffMime(PNG_1X1), 'image/png')
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg')
  assert.equal(sniffMime(Buffer.from('GIF89a------')), 'image/gif')
  assert.equal(sniffMime(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ')), 'image/webp')
  assert.equal(sniffMime(Buffer.from('hello world!')), null)
  assert.equal(sniffMime(Buffer.alloc(3)), null, '太短 ⇒ null')
  console.log('sniffMime -> OK')
}

// ---------------------------------------------------------------- pickImage
{
  const event = {
    attachments: [
      { content_type: 'file/pdf', url: 'http://x/a.pdf', filename: 'a.pdf' },
      { content_type: 'image/png', url: 'http://x/a.png', filename: 'a.png' },
      { content_type: 'image/jpeg', url: 'http://x/b.jpg', filename: 'b.jpg' },
    ],
  }
  const picked = pickImage(event)
  assert.deepEqual(picked, { url: 'http://x/a.png', filename: 'a.png', contentType: 'image/png', from: 'top' }, '只挑第一张图')
  assert.equal(pickImage({ attachments: [{ content_type: 'image/png' }] }), null, '没 url 不算')
  assert.equal(pickImage({}), null)
  // 后备：msg_elements 里的地址字段叫 content（与引擎一致）
  assert.deepEqual(
    pickImage({ msgElements: [{ content_type: 'image/jpeg', content: 'http://x/c.jpg' }] }),
    { url: 'http://x/c.jpg', filename: '', contentType: 'image/jpeg', from: 'element' },
  )
  assert.equal(pickImage({ msgElements: [{ content_type: 'file/pdf', content: 'http://x/c.pdf' }] }), null)
  console.log('pickImage -> OK')

  // 多图：attachments 在前、msg_elements 在后；重复 URL 去重；不超过上限
  const multi = pickImages({
    attachments: [
      { content_type: 'image/png', url: 'http://x/1.png', filename: '1.png' },
      { content_type: 'file/pdf', url: 'http://x/a.pdf' },
      { content_type: 'image/jpeg', url: 'http://x/2.jpg' },
    ],
    msgElements: [
      { content_type: 'image/png', url: 'http://x/1.png' },
      { content_type: 'image/gif', content: 'http://x/3.gif' },
    ],
  })
  assert.deepEqual(multi.map((item) => item.url), ['http://x/1.png', 'http://x/2.jpg', 'http://x/3.gif'])
  assert.equal(pickImages({ attachments: multi.map((item, i) => ({ content_type: 'image/png', url: `http://x/${i}.png` })) }, 2).length, 2, '要有上限')

  // 2026-10-18 真机：图塞在 msgElements[i].attachments 里，只认顶层会丢图
  const nested = pickImages({
    attachments: [],
    msgElements: [{
      message_type: 1,
      msg_idx: 'x',
      content: '',
      attachments: [{ content_type: 'image/gif', url: 'http://x/nested.gif', filename: 'a.gif' }],
    }],
  })
  assert.equal(nested.length, 1, '元素里嵌套的附件也算图')
  assert.equal(nested[0].url, 'http://x/nested.gif')
  assert.equal(pickImage({ msgElements: [{ attachments: [{ content_type: 'image/png', url: 'http://x/n.png' }] }] }).url, 'http://x/n.png')
  console.log('nested attachments -> OK')
  console.log('pickImages -> OK')
}

// ---------------------------------------------------------------- downloadImage
{
  // 1) ok
  const okFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => String(PNG_1X1.length) },
    arrayBuffer: async () => PNG_1X1,
  })
  const good = await downloadImage('http://x/a.png', { fetchImpl: okFetch })
  assert.equal(good.ok, true)
  assert.equal(good.mime, 'image/png')

  // 2) 先看 Content-Length：body 一个字节都不读
  let bodyRead = false
  const bigFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => '999999999' },
    arrayBuffer: async () => { bodyRead = true; return Buffer.alloc(10) },
  })
  const tooBig = await downloadImage('http://x/big.png', { fetchImpl: bigFetch })
  assert.deepEqual([tooBig.ok, tooBig.reason], [false, 'too-large'])
  assert.equal(bodyRead, false, '声明超限时不许读 body')

  // 3) 认不出的字节
  const junkFetch = async () => ({
    ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('hello world!'),
  })
  assert.equal((await downloadImage('http://x/j', { fetchImpl: junkFetch })).reason, 'unsupported')

  // 4) HTTP 错误
  const badFetch = async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) })
  assert.equal((await downloadImage('http://x/404', { fetchImpl: badFetch })).reason, 'network')

  // 5) 超时（fetch 抛 AbortError）
  const abortFetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
  assert.equal((await downloadImage('http://x/slow', { fetchImpl: abortFetch })).reason, 'timeout')

  assert.ok(MAX_IMAGE_BYTES_DEFAULT === 12 * 1024 * 1024, '默认上限必须是 12MB')
  console.log('downloadImage gates -> OK')
}

// ---------------------------------------------------------------- 落盘 / 清理
const root = mkdtempSync(join(tmpdir(), 'qq-relay-vision-'))
try {
  assert.equal(imageDirOf('D:/base', { image: { dir: '' } }), join('D:/base', 'images'))
  assert.equal(imageDirOf('D:/base', { image: { dir: 'E:/pics' } }), 'E:/pics')

  const incoming = incomingDirOf(join(root, 'images'))
  const saved = saveImage(incoming, { bytes: PNG_1X1, mime: 'image/png', msgId: 'ROBOT1.0_abc123456', at: Date.UTC(2026, 9, 18, 0, 35, 12) })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const names = readdirSync(incoming)
  assert.equal(names.filter((n) => n.endsWith('.png')).length, 1, '要有一张图')
  assert.equal(names.filter((n) => n.endsWith('.json')).length, 1, '要有侧车')
  const sidecar = JSON.parse(readFileSync(join(incoming, names.find((n) => n.endsWith('.json'))), 'utf8'))
  assert.equal(sidecar.source, 'qq-direct')
  assert.equal(sidecar.mime, 'image/png')
  assert.equal(sidecar.bytes, PNG_1X1.length)
  assert.ok(!names.some((n) => n.endsWith('.tmp')), '临时文件必须没留下')

  // tag：同一 seq 下拼图用 -frames，动图原文件用 seq 本身，两者不打架
  const tagged = saveImage(incoming, { bytes: PNG_1X1, mime: 'image/png', msgId: 'ROBOT1.0_abc123456', seq: 2, tag: 'frames', at: Date.UTC(2026, 9, 18, 0, 35, 12) })
  assert.match(tagged.path, /-2-frames\.png$/, '拼图要带 -frames')
  const gifSaved = saveImage(incoming, { bytes: PNG_1X1, mime: 'image/gif', msgId: 'ROBOT1.0_abc123456', seq: 2, at: Date.UTC(2026, 9, 18, 0, 35, 12) })
  assert.match(gifSaved.path, /-2\.gif$/, '动图原文件用 seq 命名')
  assert.notEqual(tagged.path, gifSaved.path)

  // 造一个 10 天前的图：retention 7 天 ⇒ 应被清掉
  const oldFile = join(incoming, '20260101-000000-old-1.png')
  writeFileSync(oldFile, PNG_1X1)
  const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000
  utimesSync(oldFile, tenDaysAgo, tenDaysAgo)
  const removed = pruneIncoming(incoming, 7)
  assert.equal(removed, 1, '只删超期的那张')
  assert.equal(existsSync(oldFile), false)
  assert.equal(pruneIncoming(incoming, 0), 0, '0 天 = 不清（也不落盘，调用方自己跳过）')

  const cleared = clearIncoming(incoming)
  assert.ok(cleared.removed >= 1)
  assert.ok(cleared.bytes > 0)
  assert.equal(readdirSync(incoming).length, 0, '清空后目录为空')

  // 🧩 stickers 是**永久目录**：按天清 / 清空临时图库都不许碰它
  const stickers = join(join(root, 'images'), 'stickers')
  mkdirSync(stickers, { recursive: true })
  const keep = join(stickers, '永久_1.png')
  writeFileSync(keep, PNG_1X1)
  const oldSticker = join(stickers, '永久_2.png')
  writeFileSync(oldSticker, PNG_1X1)
  const longAgo = (Date.now() - 400 * 24 * 60 * 60 * 1000) / 1000
  utimesSync(oldSticker, longAgo, longAgo)
  pruneIncoming(incoming, 1)
  clearIncoming(incoming)
  assert.equal(existsSync(keep), true, '清空临时图库不能动 stickers')
  assert.equal(existsSync(oldSticker), true, '按天清理也不能动 stickers（永久）')
  console.log('stickers are permanent -> OK')
  console.log('save/prune/clear -> OK')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('vision.test.mjs: all assertions passed')
