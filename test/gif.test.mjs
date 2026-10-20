/**
 * 阶段 2 · Task 8 测试：GIF 解码 / 采样 / 拼图 / PNG 编码
 *
 * `sharp` 只在这里当**对照组**（造测试图 + 读回结果），生产代码一行都不 require；
 * 没有 sharp 的环境会自动跳过“造图”那几段，纯逻辑测试照跑。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { gifInfo, lzwDecode, sampleIndices, renderFrames, pngEncode, montage, CELL, GAP } from '../lib/gif.js'

const requireHere = createRequire(import.meta.url)
// sharp 只作为“对照组”出现在测试里：从 DSH 安装目录解析（和 client-contract 同一个办法）
const DSH_INSTALL = process.env.DSH_INSTALL ?? 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh'
let sharp = null
try {
  const requireFromDsh = createRequire(join(DSH_INSTALL, 'package.json'))
  sharp = requireFromDsh('sharp')
} catch { sharp = null }

// ---------------------------------------------------------------- 采样（纯逻辑）
{
  assert.deepEqual(sampleIndices(3, 4), [0, 1, 2], '帧数不够就全要')
  assert.deepEqual(sampleIndices(77, 4), [0, 25, 51, 76], '引擎的边界值')
  assert.deepEqual(sampleIndices(5, 4), [0, 1, 3, 4], '中间取整 + 去重')
  console.log('sampleIndices -> OK')
}

// ---------------------------------------------------------------- LZW（用手造流）
{
  // minCodeSize=2：clear=4, eoi=5；先 clear 再 eoi ⇒ 输出全 0
  const clear = 4, eoi = 5
  const codes = [clear, eoi]
  const bits = []
  for (const code of codes) for (let i = 0; i < 3; i += 1) bits.push((code >> i) & 1)
  const bytes = new Uint8Array(Math.ceil(bits.length / 8))
  bits.forEach((bit, i) => { if (bit) bytes[i >> 3] |= 1 << (i & 7) })
  const out = lzwDecode(bytes, 2, 4)
  assert.equal(out.length, 4)
  assert.deepEqual([...out], [0, 0, 0, 0], 'clear 之后没有数据 ⇒ 全 0')
  console.log('lzwDecode -> OK')
}

if (!sharp) {
  console.log('gif.test.mjs: sharp 不可用 ⇒ 跳过“造图”部分（纯逻辑已过）')
} else {
  const makeFrame = (r, g, b) => sharp({ create: { width: 20, height: 20, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toBuffer()
  const frames = [await makeFrame(255, 0, 0), await makeFrame(0, 255, 0), await makeFrame(0, 0, 255)]
  const gif = await sharp(frames, { join: { animated: true } }).gif({ delay: [100, 100, 100] }).toBuffer()

  // ---------------------------------------------------------------- info
  const info = gifInfo(gif)
  assert.equal(info.w, 20)
  assert.equal(info.h, 20)
  assert.equal(info.frames, 3)
  assert.equal(info.animated, true)
  assert.equal(info.delayMs, 300, '延时合计 100ms×3')
  assert.equal(gifInfo(Buffer.from('not a gif at all')), null)
  console.log('gifInfo ->', JSON.stringify({ w: info.w, h: info.h, frames: info.frames }))

  // ---------------------------------------------------------------- 解码像素
  const rendered = renderFrames(gif, [0, 2])
  assert.equal(rendered.frames.length, 2)
  const pixelAt = (frame, x, y) => {
    const o = (y * frame.w + x) * 4
    return [frame.rgba[o], frame.rgba[o + 1], frame.rgba[o + 2], frame.rgba[o + 3]]
  }
  assert.deepEqual(pixelAt(rendered.frames[0], 10, 10), [255, 0, 0, 255], '第 0 帧是红的')
  assert.deepEqual(pixelAt(rendered.frames[1], 10, 10), [0, 0, 255, 255], '第 2 帧是蓝的')
  console.log('renderFrames -> OK')

  // ---------------------------------------------------------------- 拼图
  const made = montage(gif, 4)
  assert.ok(made, '动图必须拼出图')
  assert.deepEqual(made.frames, [0, 1, 2])
  assert.equal(made.cols, 2)
  assert.equal(made.rows, 2)
  assert.equal(made.w, 2 * CELL + GAP)
  assert.equal(made.h, 2 * CELL + GAP)
  assert.equal(made.png.subarray(0, 4).toString('hex'), '89504e47', 'PNG 头')
  const back = await sharp(made.png).metadata()
  assert.deepEqual([back.width, back.height], [made.w, made.h])
  // 左上格中心应该是红、右上格中心是绿、左下是蓝（中心取整：CELL 是奇数）
  const mid = Math.floor(CELL / 2)
  const step = CELL + GAP
  const at = (x, y) => { const o = (y * made.w + x) * 4; return [made.rgba[o], made.rgba[o + 1], made.rgba[o + 2]] }
  assert.deepEqual(at(mid, mid), [255, 0, 0], '格 0 = 红')
  assert.deepEqual(at(step + mid, mid), [0, 255, 0], '格 1 = 绿')
  assert.deepEqual(at(mid, step + mid), [0, 0, 255], '格 2 = 蓝')
  console.log('montage ->', `${made.w}x${made.h}, frames=${JSON.stringify(made.frames)}`)

  // ---------------------------------------------------------------- 静态图
  const still = await sharp(await makeFrame(10, 20, 30)).gif().toBuffer()
  assert.equal(gifInfo(still).animated, false)
  assert.equal(montage(still), null, '单帧 GIF 不拼图')
  console.log('still gif -> null -> OK')

  // ---------------------------------------------------------------- PNG 编码
  const onePixel = new Uint8Array([255, 0, 0, 255])
  const png = pngEncode(1, 1, onePixel)
  const decoded = await sharp(png).raw().toBuffer()
  assert.deepEqual([...decoded], [255, 0, 0, 255], 'PNG 编出来要能读回同样的像素')
  console.log('pngEncode -> OK')
}

console.log('gif.test.mjs: all assertions passed')
