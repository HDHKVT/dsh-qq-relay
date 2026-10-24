/**
 * 无字幕时的兜底：下纯音频 → 本地 Whisper 转写（2026-10-24）。
 *
 * 为什么不下载整个视频：ASR 只要音频。实测 3 分钟的视频音频约 2 MB，
 * 比 720P 视频小一个量级。
 *
 * 成本（实测）：turbo 模型跑 3 分钟音频 ≈ 85 秒，其中大头是加载 1.6 GB 模型。
 * 所以**默认只对短于阈值的视频自动跑**，长视频把决定权交给用户。
 *
 * 边界：只认音频、不抽帧；失败一律返回 {ok:false}，不抛给上层。
 */

import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { fetchPlayUrl, downloadVideo } from './bilibili.js'

/** 自动转写的时长上限（秒）。超过这个长度，转写要等好几分钟，交给人决定。 */
export const ASR_AUTO_LIMIT_SECONDS = 600

/**
 * @param {object} options
 * @param {string} options.bvid
 * @param {number} options.cid
 * @param {number} options.duration        视频时长（秒）
 * @param {string} options.dir             本次工作的目录
 * @param {string} options.pythonPath
 * @param {string} options.scriptPath      video/video_processor.py
 * @param {string} [options.modelDir]      本地模型目录（优先）
 * @param {string} [options.mode='accurate']
 * @param {string} [options.cookie]
 * @param {number} [options.timeoutMs]
 * @param {(line:string)=>void} [options.log]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ok:true, segments:Array<{time:string,text:string}>, seconds:number, elapsedMs:number}
 *   | {ok:false, why:string}>}
 */
export async function transcribeBili(options) {
  const {
    bvid, cid, duration, dir, pythonPath, scriptPath,
    modelDir = '', mode = 'accurate', cookie = '',
    timeoutMs = 30 * 60 * 1000, log = () => {}, fetchImpl = fetch,
  } = options

  const audioPath = join(dir, 'audio.m4a')
  try {
    const got = await fetchPlayUrl(bvid, cid, { audioOnly: true, cookie, fetchImpl })
    const url = Array.isArray(got.urls) ? got.urls[0] : got.url
    if (!url) throw new Error('没拿到音频地址')
    const saved = await downloadVideo(url, audioPath, { maxBytes: 300 * 1024 * 1024, log, fetchImpl })
    if (!saved.ok) throw new Error(saved.why || '音频下载失败')
    log(`[asr] 音频 ${(saved.bytes / 1024 / 1024).toFixed(1)}MB`)
  } catch (error) {
    return { ok: false, why: `下载音频失败：${String((error && error.message) || error)}` }
  }

  const outJson = join(dir, 'asr.json')
  const started = Date.now()
  const ran = await runProcessor({ pythonPath, scriptPath, audioPath, outJson, modelDir, mode, timeoutMs, log, workDir: dir })
  if (!ran.ok) return { ok: false, why: ran.why }

  let result
  try {
    result = JSON.parse(readFileSync(outJson, 'utf8'))
  } catch (error) {
    return { ok: false, why: `转写结果读不了：${String((error && error.message) || error)}` }
  }
  const segments = Array.isArray(result.subtitles) ? result.subtitles : []
  if (segments.length === 0) return { ok: false, why: '转写出来是空的（可能是纯音乐或静音）' }

  log(`[asr] 转写完成：${segments.length} 段，用时 ${Math.round((Date.now() - started) / 1000)} 秒`)
  return { ok: true, segments, seconds: Number(result.duration_seconds) || duration, elapsedMs: Date.now() - started }
}

/** 起 video_processor.py；音频输入它会自己跳过抽帧。 */
function runProcessor({ pythonPath, scriptPath, audioPath, outJson, modelDir, mode, timeoutMs, log, workDir }) {
  return new Promise((resolve) => {
    if (!existsSync(pythonPath)) return resolve({ ok: false, why: `python 不存在：${pythonPath}` })
    if (!existsSync(scriptPath)) return resolve({ ok: false, why: `脚本不存在：${scriptPath}` })

    const args = [scriptPath, '--input', audioPath, '--output', outJson, '--mode', mode, '--max-grid', '1']
    if (modelDir) args.push('--model-dir', modelDir)

    let child
    try {
      child = spawn(pythonPath, args, {
        cwd: workDir,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', HF_HUB_DISABLE_XET: '1' },
      })
    } catch (error) {
      return resolve({ ok: false, why: `spawn 失败：${String((error && error.message) || error)}` })
    }

    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 忽略 */ }
      resolve({ ok: false, why: `转写超时（>${Math.round(timeoutMs / 1000)} 秒）` })
    }, timeoutMs)

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stderr += text
      for (const line of text.split(/\r?\n/)) if (line.trim() !== '') log(`[asr] ${line.trim()}`)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, why: String((error && error.message) || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!existsSync(outJson)) {
        return resolve({ ok: false, why: `转写脚本退出码 ${code}：${stderr.slice(-200)}` })
      }
      resolve({ ok: true })
    })
  })
}
