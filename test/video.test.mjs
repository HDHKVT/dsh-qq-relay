import { fileURLToPath } from 'node:url'
/**
 * 视频壳子（`lib/video.js`）：结构校验 + 体积闸 + 真 spawn 一次占位脚本。
 * 不依赖 ffmpeg / faster-whisper（占位脚本只用标准库）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateResult, checkVideoSize, runVideoProcessor } from '../lib/video.js'

// 1. 结构校验：好 / 坏
{
  const good = validateResult({
    status: 'success',
    duration_seconds: 150,
    subtitles: [{ time: '00:00', text: '大家好' }, { time: '00:15', text: '这卡有 8GB 显存', extra: 1 }],
    images: ['D:/x/grid_00-00.jpg', '', 42],
  })
  assert.equal(good.ok, true)
  assert.equal(good.result.durationSeconds, 150)
  assert.equal(good.result.subtitles.length, 2)
  assert.deepEqual(good.result.images, ['D:/x/grid_00-00.jpg'], '空串和非字符串要滤掉')

  assert.equal(validateResult(null).ok, false)
  assert.equal(validateResult({ status: 'error' }).ok, false, 'status 不是 success 要拒')
  assert.equal(validateResult({ status: 'success', duration_seconds: -1, subtitles: [], images: [] }).ok, false)
  assert.equal(validateResult({ status: 'success', duration_seconds: 1, subtitles: 'x', images: [] }).ok, false)
  assert.equal(validateResult({ status: 'success', duration_seconds: 1, subtitles: [], images: {} }).ok, false)
  console.log('validateResult -> OK')
}

// 2. 体积闸
{
  const dir = mkdtempSync(join(tmpdir(), 'qq-relay-video-'))
  try {
    const file = join(dir, 'small.mp4')
    writeFileSync(file, Buffer.alloc(1024))
    assert.deepEqual(checkVideoSize(file, 1), { ok: true, bytes: 1024 })
    assert.equal(checkVideoSize(file, 0.0005).ok, false, '超过上限要拒')
    assert.equal(checkVideoSize(join(dir, 'nope.mp4'), 10).ok, false, '不存在要拒')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('checkVideoSize -> OK')
}

// 3. 真 spawn 占位脚本（优先用视频专用 venv 的 python 3.12，其次系统 python）
{
  const pythonCandidates = [
    process.env.QQ_RELAY_PYTHON,
    fileURLToPath(new URL('../video/.venv/Scripts/python.exe', import.meta.url)),
    'D:/Python/python.exe',
    'python',
  ].filter(Boolean)
  const python = pythonCandidates.find((candidate) => {
    if (candidate === 'python') return true
    return existsSync(candidate)
  })
  const script = fileURLToPath(new URL('./video-fixture/video_stub.py', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'qq-relay-video-run-'))
  try {
    const input = join(dir, 'fake.mp4')
    writeFileSync(input, Buffer.alloc(2048))
    const output = join(dir, 'result.json')
    const run = await runVideoProcessor({ python, script, input, output, timeoutMs: 30000 })
    assert.equal(run.ok, true, JSON.stringify(run.error || run))
    assert.equal(run.result.status, 'success')
    assert.equal(run.result.subtitles.length, 2, '占位脚本应给两条字幕')
    assert.equal(existsSync(output), true, '结果文件必须落盘')
    console.log('runVideoProcessor (stub) -> OK')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 4. 中文路径 → ASCII 硬链接（OpenCV 的坑）
{
  const { ensureAsciiInput } = await import('../lib/video.js')
  const dir = mkdtempSync(join(tmpdir(), 'qq-relay-video-ascii-'))
  try {
    const cjk = join(dir, '演示 视频.mp4')
    writeFileSync(cjk, Buffer.alloc(64))
    const out = join(dir, 'out')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(out)
    const result = ensureAsciiInput(cjk, out, '.mp4')
    assert.notEqual(result.path, cjk, '中文路径要换成 ASCII 路径')
    assert.ok(result.path.endsWith('input.mp4'))
    assert.equal(existsSync(result.path), true)
    assert.equal(result.mode === 'link' || result.mode === 'copy', true)

    const plain = ensureAsciiInput(join(dir, 'plain.mp4'), out, '.mp4')
    assert.equal(plain.mode, 'as-is', '纯 ASCII 路径不要动')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('ensureAsciiInput -> OK')
}

console.log('video.test.mjs: all assertions passed')
