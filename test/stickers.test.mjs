/**
 * 表情包仓库（`lib/stickers.js`）：存、列、改名、删。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  stickerDirOf, cleanStickerName, addSticker, listStickers, stickerPath, renameSticker, removeSticker, pickStickerSource,
} from '../lib/stickers.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex')
const GIF = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex')

const root = mkdtempSync(join(tmpdir(), 'qq-relay-stickers-'))
try {
  const dir = stickerDirOf(root, { sticker: { dir: '' } })
  assert.equal(dir, join(root, 'images', 'stickers'))
  assert.equal(stickerDirOf(root, { sticker: { dir: 'E:/s' } }), 'E:/s')

  assert.equal(cleanStickerName('开心 / 笑'), '开心_笑')
  assert.equal(cleanStickerName(''), cleanStickerName(''), '空名字要稳住')
  assert.ok(cleanStickerName('').length > 0)

  const one = addSticker(dir, { bytes: PNG, name: '开心' })
  assert.equal(one.ok, true, JSON.stringify(one))
  assert.equal(one.name, '开心')
  assert.ok(one.path.endsWith('开心.png'))

  // 重名不覆盖，自动加序号
  const two = addSticker(dir, { bytes: PNG, name: '开心' })
  assert.equal(two.name, '开心_2')

  const gif = addSticker(dir, { bytes: GIF, name: '跳舞' })
  assert.equal(gif.ok, true)
  assert.ok(gif.path.endsWith('跳舞.gif'), '动图要按 gif 存')

  // 不是图就拒
  assert.equal(addSticker(dir, { bytes: Buffer.from('hello'), name: 'x' }).ok, false)

  const list = listStickers(dir)
  assert.equal(list.length, 3)
  assert.ok(list.some((item) => item.name === '跳舞' && item.mime === 'image/gif'))

  assert.ok(stickerPath(dir, '开心').endsWith('开心.png'))
  assert.equal(stickerPath(dir, '没有'), null)

  // 改名：文件跟着改，索引跟着改
  const renamed = renameSticker(dir, '开心', '开心_大笑')
  assert.equal(renamed.ok, true, JSON.stringify(renamed))
  assert.ok(renamed.path.endsWith('开心_大笑.png'))
  assert.equal(stickerPath(dir, '开心'), null)
  assert.ok(stickerPath(dir, '开心_大笑'))
  assert.equal(renameSticker(dir, '开心_大笑', '跳舞').ok, false, '名字被占了要拒')

  // 删
  assert.equal(removeSticker(dir, '跳舞').ok, true)
  assert.equal(stickerPath(dir, '跳舞'), null)
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.gif')).length, 0, 'gif 文件也要删掉')

  // 两条取图路：引用优先；各自能单独关掉
  const quoted = { attachments: [], msgElements: [{ message_type: 103, msg_idx: 'REFIDX_x', attachments: [{ content_type: 'image/png', url: 'http://q' }] }] }
  const own = { attachments: [{ content_type: 'image/gif', url: 'http://a' }], msgElements: [] }
  assert.deepEqual(pickStickerSource(quoted, {}), { url: 'http://q', kind: 'quote' })
  assert.deepEqual(pickStickerSource(own, {}), { url: 'http://a', kind: 'attach' })
  assert.equal(pickStickerSource(own, { byAttach: false }), null, '关掉直发就不收')
  assert.equal(pickStickerSource(quoted, { byQuote: false }), null, '关掉引用就不收')
  assert.deepEqual(
    pickStickerSource({ attachments: [{ content_type: 'image/png', url: 'http://a' }], msgElements: quoted.msgElements }, {}),
    { url: 'http://q', kind: 'quote' },
    '两边都有图时引用优先',
  )

  console.log('stickers.test.mjs: all assertions passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
