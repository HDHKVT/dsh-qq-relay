/**
 * GIF → 网格 PNG（阶段 2 · Task 8）。
 *
 * **纯 JS，零依赖**：这是“DSH 怎么升级都不影响动图”的关键 —— 不 require sharp，
 * 也不碰任何平台内部包。逻辑逐段移植自小屋引擎的 `daisy-session/src/gif.rs`
 * （该文件有 17 条测试兜底），包括几个容易翻车的点：
 *   - 帧之间的 **disposal 0/1/2/3** 合成（GIF 常只存“变化的部分”）
 *   - 透明色索引（跳过，不覆盖已有像素）
 *   - **隔行**（interlace）帧的行序：0,8,16… → 4,12… → 2,6… → 1,3…
 *   - 注释扩展（`21 FE`）不能被当成块长度 —— 引擎那边真踩过，会把帧数读成 0
 *
 * 验收口径和引擎一致：**解出来的像素一致**，不是压缩字节一致。
 */
import { deflateSync } from 'node:zlib'

/** 网格每格边长（引擎同值） */
export const CELL = 255
/** 格间留缝（引擎同值） */
export const GAP = 2

const u16 = (buf, p) => buf[p] | (buf[p + 1] << 8)
const sliceOrEmpty = (buf, start, len) => (start >= buf.length ? new Uint8Array(0) : buf.subarray(start, Math.min(start + len, buf.length)))

function skipSubBlocks(buf, state) {
  while (state.p < buf.length) {
    const n = buf[state.p]
    state.p += 1
    if (n === 0) break
    state.p += n
  }
}

/**
 * 只走块结构、不解压：拿尺寸 / 帧数 / 总延时 / 循环次数。
 * @param {Uint8Array|Buffer} buf
 * @returns {{w:number,h:number,frames:number,delayMs:number,loops:number|null,animated:boolean}|null}
 */
export function gifInfo(buf) {
  if (!buf || buf.length < 13) return null
  if (!(buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)) return null
  const w = u16(buf, 6)
  const h = u16(buf, 8)
  const packed = buf[10]
  const state = { p: 13 }
  if (packed & 0x80) state.p += 3 * (1 << ((packed & 7) + 1))

  let frames = 0
  let delayMs = 0
  let loops = null

  while (state.p < buf.length) {
    const b = buf[state.p]
    if (b === 0x3b) break
    if (b === 0x21) {
      const label = buf[state.p + 1]
      state.p += 2
      if (label === 0xf9 && buf.length - state.p >= 5) {
        delayMs += u16(buf, state.p + 2) * 10
        state.p += 6
      } else if (label === 0xff && buf.length - state.p >= 1) {
        const size = buf[state.p]
        const end = Math.min(state.p + 1 + size, buf.length)
        const app = Buffer.from(buf.subarray(state.p + 1, end)).toString('latin1').toUpperCase()
        state.p += 1 + size
        if (app.includes('NETSCAPE')) {
          const n = buf[state.p]
          state.p += 1
          if (n >= 3 && state.p + 1 < buf.length) loops = u16(buf, state.p + 1)
          state.p += n
          state.p += 1
        } else {
          skipSubBlocks(buf, state)
        }
      } else {
        skipSubBlocks(buf, state)
      }
      continue
    }
    if (b === 0x2c) {
      if (state.p + 10 > buf.length) break
      frames += 1
      const ipacked = buf[state.p + 9]
      state.p += 10
      if (ipacked & 0x80) state.p += 3 * (1 << ((ipacked & 7) + 1))
      state.p += 1
      skipSubBlocks(buf, state)
      continue
    }
    break
  }
  return { w, h, frames, delayMs, loops, animated: frames > 1 }
}

/**
 * GIF 版 LZW 解压（返回 `pixelCount` 个索引，不足补 0）。
 * @param {Uint8Array|Buffer} data
 * @param {number} minCodeSize
 * @param {number} pixelCount
 * @returns {Uint8Array}
 */
export function lzwDecode(data, minCodeSize, pixelCount) {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  const out = new Uint8Array(pixelCount)
  let oi = 0
  let dict = []
  let codeSize = minCodeSize + 1
  const reset = () => {
    dict = []
    for (let i = 0; i < clear; i += 1) dict.push([i])
    dict.push([])
    dict.push([])
    codeSize = minCodeSize + 1
  }
  reset()
  let prev = null
  const totalBits = data.length * 8
  let bitPos = 0

  while (bitPos + codeSize <= totalBits) {
    let code = 0
    for (let i = 0; i < codeSize; i += 1) {
      const bit = (data[(bitPos + i) >> 3] >> ((bitPos + i) & 7)) & 1
      code |= bit << i
    }
    bitPos += codeSize
    if (code === clear) { reset(); prev = null; continue }
    if (code === eoi) break

    let entry
    if (code < dict.length && dict[code].length > 0) entry = dict[code].slice()
    else if (prev) entry = [...prev, prev[0]]
    else break

    for (let i = 0; i < entry.length && oi < pixelCount; i += 1) out[oi++] = entry[i]
    if (prev) {
      dict.push([...prev, entry[0]])
      if (dict.length === (1 << codeSize) && codeSize < 12) codeSize += 1
    }
    prev = entry
    if (oi >= pixelCount) break
  }
  return out
}

/**
 * 从 `frames` 帧里均匀抽 `n` 帧（去重）。
 * @param {number} frames
 * @param {number} n
 * @returns {number[]}
 */
export function sampleIndices(frames, n) {
  if (frames <= n) return Array.from({ length: frames }, (_, i) => i)
  const out = []
  for (let i = 0; i < n; i += 1) {
    const index = Math.round((i * (frames - 1)) / (n - 1))
    if (!out.includes(index)) out.push(index)
  }
  return out
}

function clearRect(canvas, w, h, left, top, rw, rh) {
  const yEnd = Math.min(top + rh, h)
  const xEnd = Math.min(left + rw, w)
  for (let y = top; y < yEnd; y += 1) {
    for (let x = left; x < xEnd; x += 1) {
      const o = (y * w + x) * 4
      canvas[o] = 0; canvas[o + 1] = 0; canvas[o + 2] = 0; canvas[o + 3] = 0
    }
  }
}

function drawFrame(canvas, w, h, left, top, fw, fh, idx, colorTable, transparent, interlaced) {
  let srcRows = null
  if (interlaced) {
    srcRows = []
    for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
      for (let y = start; y < fh; y += step) srcRows.push(y)
    }
  }
  for (let ry = 0; ry < fh; ry += 1) {
    const y = top + ry
    if (y >= h) continue
    const srcRow = srcRows ? srcRows[ry] : ry
    if (srcRow >= fh) continue
    for (let rx = 0; rx < fw; rx += 1) {
      const x = left + rx
      if (x >= w) continue
      const ci = idx[srcRow * fw + rx]
      if (transparent >= 0 && ci === transparent) continue
      if (!colorTable || ci * 3 + 2 >= colorTable.length) continue
      const o = (y * w + x) * 4
      canvas[o] = colorTable[ci * 3]
      canvas[o + 1] = colorTable[ci * 3 + 1]
      canvas[o + 2] = colorTable[ci * 3 + 2]
      canvas[o + 3] = 255
    }
  }
}

/**
 * 逐帧解码 + 按 disposal 合成，返回请求的那几帧的完整画布。
 * @param {Uint8Array|Buffer} buf
 * @param {number[]} wantIndices
 * @param {number} [maxPixels]
 * @returns {{info: object, frames: Array<{index:number,w:number,h:number,rgba:Uint8Array,delayMs:number}>}|null}
 */
export function renderFrames(buf, wantIndices, maxPixels = 4096 * 4096) {
  const g = gifInfo(buf)
  if (!g) return null
  if (g.w * g.h > maxPixels) return null
  const canvasW = g.w
  const canvasH = g.h
  const want = wantIndices.filter((index) => index < g.frames)
  const maxWant = want.length > 0 ? Math.max(...want) : -1

  const canvas = new Uint8Array(canvasW * canvasH * 4)
  let snapshot = null
  const out = []
  let prevFrame = null

  const packed = buf[10]
  let p = 13
  let gct = null
  if (packed & 0x80) {
    const n = 1 << ((packed & 7) + 1)
    gct = sliceOrEmpty(buf, p, n * 3)
    p += n * 3
  }
  const readSubBlocks = () => {
    const parts = []
    while (p < buf.length) {
      const n = buf[p]
      p += 1
      if (n === 0) break
      parts.push(sliceOrEmpty(buf, p, n))
      p += n
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    const joined = new Uint8Array(total)
    let at = 0
    for (const part of parts) { joined.set(part, at); at += part.length }
    return joined
  }

  let disposal = 0
  let delayMs = 0
  let transparent = -1
  let index = -1

  while (p < buf.length && index < maxWant) {
    const b = buf[p]
    if (b === 0x3b) break
    if (b === 0x21) {
      const label = buf[p + 1]
      p += 2
      if (label === 0xf9) {
        if (p + 5 > buf.length) break
        const gp = buf[p + 1]
        const tIdx = buf[p + 4]
        disposal = (gp >> 2) & 7
        delayMs = u16(buf, p + 2) * 10
        transparent = gp & 0x01 ? tIdx : -1
        p += 6
      } else if (label === 0xff) {
        const size = buf[p]
        p += 1 + size
        readSubBlocks()
      } else {
        readSubBlocks()
      }
      continue
    }
    if (b === 0x2c) {
      if (p + 10 > buf.length) break
      const left = u16(buf, p + 1)
      const top = u16(buf, p + 3)
      const fw = u16(buf, p + 5)
      const fh = u16(buf, p + 7)
      const ipacked = buf[p + 9]
      p += 10
      let ct = gct
      if (ipacked & 0x80) {
        const n = 1 << ((ipacked & 7) + 1)
        ct = sliceOrEmpty(buf, p, n * 3)
        p += n * 3
      }
      const interlaced = (ipacked & 0x40) !== 0
      if (p >= buf.length) break
      const minCodeSize = buf[p]
      p += 1
      const data = readSubBlocks()
      index += 1

      if (index > 0 && prevFrame) {
        if (prevFrame.disposal === 2) clearRect(canvas, canvasW, canvasH, prevFrame.left, prevFrame.top, prevFrame.w, prevFrame.h)
        else if (prevFrame.disposal === 3 && snapshot) canvas.set(snapshot)
      }
      if (disposal === 3) snapshot = canvas.slice()

      const need = want.includes(index)
      if (need || index < maxWant) {
        const pixels = lzwDecode(data, minCodeSize, fw * fh)
        drawFrame(canvas, canvasW, canvasH, left, top, fw, fh, pixels, ct, transparent, interlaced)
        prevFrame = { disposal, left, top, w: fw, h: fh }
      }
      if (need) out.push({ index, w: g.w, h: g.h, rgba: canvas.slice(), delayMs })
      continue
    }
    break
  }
  return { info: g, frames: out }
}

// ---------------------------------------------------------------- PNG 编码
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(kind, data) {
  const body = Buffer.concat([Buffer.from(kind, 'latin1'), Buffer.from(data)])
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}

/**
 * RGBA → PNG（IHDR + IDAT + IEND）。
 * @param {number} w
 * @param {number} h
 * @param {Uint8Array} rgba
 * @returns {Buffer}
 */
export function pngEncode(w, h, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.subarray(y * stride, y * stride + stride)).copy(raw, y * (stride + 1) + 1)
  }
  const idat = deflateSync(raw, { level: 6 })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 面积平均缩放 + source-over 合成到目标网格（引擎同算法）。 */
function blitScaled(dst, dstW, dstH, cellX, cellY, cellW, cellH, src, srcW, srcH) {
  const scale = Math.min(cellW / srcW, cellH / srcH)
  const dw = Math.max(1, Math.round(srcW * scale))
  const dh = Math.max(1, Math.round(srcH * scale))
  const offX = cellX + Math.floor((cellW - dw) / 2)
  const offY = cellY + Math.floor((cellH - dh) / 2)

  for (let y = 0; y < dh; y += 1) {
    const y0 = (y * srcH) / dh
    const y1 = ((y + 1) * srcH) / dh
    const iy0 = Math.floor(y0)
    const iy1 = Math.max(iy0 + 1, Math.min(Math.ceil(y1), srcH))
    const ty = offY + y
    if (ty >= dstH) continue
    for (let x = 0; x < dw; x += 1) {
      const x0 = (x * srcW) / dw
      const x1 = ((x + 1) * srcW) / dw
      const ix0 = Math.floor(x0)
      const ix1 = Math.max(ix0 + 1, Math.min(Math.ceil(x1), srcW))
      const tx = offX + x
      if (tx >= dstW) continue

      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = iy0; sy < iy1; sy += 1) {
        for (let sx = ix0; sx < ix1; sx += 1) {
          const so = (sy * srcW + sx) * 4
          const sa = src[so + 3] / 255
          r += src[so] * sa
          g += src[so + 1] * sa
          b += src[so + 2] * sa
          a += sa
          n += 1
        }
      }
      if (n === 0) continue
      const avgA = a / n
      if (avgA <= 0) continue
      const o = (ty * dstW + tx) * 4
      const sr = r / a
      const sg = g / a
      const sb = b / a
      const da = dst[o + 3] / 255
      const oa = avgA + da * (1 - avgA)
      dst[o] = Math.round((sr * avgA + dst[o] * da * (1 - avgA)) / oa)
      dst[o + 1] = Math.round((sg * avgA + dst[o + 1] * da * (1 - avgA)) / oa)
      dst[o + 2] = Math.round((sb * avgA + dst[o + 2] * da * (1 - avgA)) / oa)
      dst[o + 3] = Math.round(oa * 255)
    }
  }
}

/**
 * 把动图采样成一张网格 PNG（默认 4 帧 2×2）。
 *
 * 尺寸刻意算在 512 附近：模型对 >512 的图会多花一个 tile 的钱。
 * @param {Uint8Array|Buffer} buf
 * @param {number} [maxFrames]
 * @returns {{png: Buffer, frames: number[], cols: number, rows: number, w: number, h: number, rgba: Uint8Array}|null}
 */
export function montage(buf, maxFrames = 4) {
  const g = gifInfo(buf)
  if (!g || !g.animated) return null
  const limit = Math.min(9, Math.max(2, maxFrames))
  const useFrames = sampleIndices(g.frames, limit)
  const rendered = renderFrames(buf, useFrames, 4096 * 4096)
  if (!rendered || rendered.frames.length === 0) return null

  const count = useFrames.length
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3
  const rows = Math.ceil(count / cols)
  const w = cols * CELL + (cols - 1) * GAP
  const h = rows * CELL + (rows - 1) * GAP

  const dst = new Uint8Array(w * h * 4)
  for (let o = 0; o < dst.length; o += 4) {
    dst[o] = 0x30; dst[o + 1] = 0x30; dst[o + 2] = 0x34; dst[o + 3] = 255
  }
  rendered.frames.forEach((frame, i) => {
    const cx = (i % cols) * (CELL + GAP)
    const cy = Math.floor(i / cols) * (CELL + GAP)
    blitScaled(dst, w, h, cx, cy, CELL, CELL, frame.rgba, frame.w, frame.h)
  })

  return {
    png: pngEncode(w, h, dst),
    frames: useFrames,
    cols,
    rows,
    w,
    h,
    rgba: dst,
  }
}
