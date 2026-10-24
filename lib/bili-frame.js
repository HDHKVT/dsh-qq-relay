/**
 * 按时刻从 B 站视频里抽帧（2026-10-24）。
 *
 * 不下载整片：拿一次播放地址，然后在 CDN 上远程 seek，解一帧就停。
 * 实测 720P、一帧 2~3 秒。
 *
 * 为什么要这个：B 站 AI 字幕会出错（实测把「十分之一」听成「110」），
 * 而这些视频大多带**画内字幕**——抽一帧就能拿画面上的原文校对。
 * ⚠️ 实测 AI 字幕的时间轴和画内字幕有 3~5 秒时差，所以校对时要给窗口，
 *    不要只抽单点。`window` 参数就是干这个的。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { resolveShare, fetchPlayUrl } from './bilibili.js'
import { fetchVideoBrief } from './bili-storyboard.js'
import { fetchSubtitle } from './bili-subtitle.js'
import { planFrameRequests, locateSubtitleLine } from './frame-plan.js'

/**
 * @param {object} options
 * @param {string} options.text         BV 号 / 链接
 * @param {Array<string|number>} options.times  要抽的时刻
 * @param {string} options.workRoot     工作目录根
 * @param {string} options.pythonPath
 * @param {string} options.scriptPath   video/remote_frame.py
 * @param {string} [options.cookie]     登录态（拿 720P 用）
 * @param {number} [options.window]     每个时刻前后各扩几秒（校对字幕用，默认 0）
 * @param {number} [options.maxFrames=6]
 * @param {(line:string)=>void} [options.log]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function grabBiliFrames(options) {
  const {
    text, times, workRoot, pythonPath, scriptPath,
    cookie = '', window = 0, maxFrames = 8, qn = 64, log = () => {}, fetchImpl = fetch,
  } = options

  let bvid
  try {
    bvid = (await resolveShare(String(text || ''), fetchImpl)).bvid
  } catch (error) {
    return { ok: false, why: `认不出视频：${String((error && error.message) || error)}` }
  }

  let brief
  try {
    brief = await fetchVideoBrief(bvid, fetchImpl)
  } catch (error) {
    return { ok: false, why: String((error && error.message) || error) }
  }

  // 窗口展开：每个时刻扩成 [t-window, t, t+window]
  const offsets = window > 0 ? [-window, 0, window] : [0]
  const planned = planFrameRequests({
    durationSeconds: brief.duration,
    times: Array.isArray(times) ? times : [times],
    offsetsSeconds: offsets,
    maxFrames,
  })
  if (!planned.ok) return { ok: false, why: planned.reason }
  if (planned.targets.length === 0) return { ok: false, why: '没有一个效的时刻' }

  const dir = join(workRoot, `${bvid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })

  let playUrl
  try {
    const got = await fetchPlayUrl(bvid, brief.cid, { qn: Number(qn) || 64, cookie, fetchImpl })
    playUrl = Array.isArray(got.urls) ? got.urls[0] : got.url
    if (!playUrl) throw new Error('播放地址为空')
  } catch (error) {
    return { ok: false, why: `拿播放地址失败：${String((error && error.message) || error)}` }
  }

  const planPath = join(dir, 'plan.json')
  const resultPath = join(dir, 'result.json')
  const outDir = join(dir, 'frames')
  writeFileSync(planPath, JSON.stringify({
    url: playUrl,
    referer: 'https://www.bilibili.com/',
    times: planned.targets.map((target) => target.seconds),
    outDir,
  }, null, 2), 'utf8')

  const ran = await runFrameScript({ pythonPath, scriptPath, planPath, resultPath, workDir: dir, log })
  if (!ran.ok) return { ok: false, why: ran.why }
  const raw = ran.result
  const frames = Array.isArray(raw.frames) ? raw.frames : []
  if (frames.length === 0) {
    const firstError = (raw.errors && raw.errors[0] && raw.errors[0].reason) || '没有解出任何帧'
    return { ok: false, why: firstError }
  }

  // 附上该时刻附近的字幕，方便"图"和"文"对照
  let subtitleBody = []
  if (cookie) {
    try {
      const sub = await fetchSubtitle({ aid: brief.aid, cid: brief.cid, cookie, fetchImpl })
      if (sub.ok) subtitleBody = sub.payload.body || []
    } catch { /* 字幕拿不到不影响抽帧 */ }
  }

  const enriched = frames.map((frame) => {
    const located = subtitleBody.length > 0
      ? locateSubtitleLine(subtitleBody, frame.timeSeconds)
      : { ok: false }
    return {
      path: frame.path,
      timeSeconds: frame.timeSeconds,
      width: frame.width,
      height: frame.height,
      subtitle: located.ok && located.found ? located.text : '',
    }
  })

  return {
    ok: true,
    bvid,
    title: brief.title,
    frames: enriched,
    dropped: planned.dropped,
    rejected: planned.rejected,
    errors: Array.isArray(raw.errors) ? raw.errors : [],
    dir,
  }
}

/** 起 Python 抽帧；超时或非零退出都当失败，不抛给上层。 */
function runFrameScript({ pythonPath, scriptPath, planPath, resultPath, workDir, log, timeoutMs = 180 * 1000 }) {
  return new Promise((resolve) => {
    if (!existsSync(pythonPath)) return resolve({ ok: false, why: `python 不存在：${pythonPath}` })
    if (!existsSync(scriptPath)) return resolve({ ok: false, why: `脚本不存在：${scriptPath}` })

    let child
    try {
      child = spawn(pythonPath, [scriptPath, '--plan', planPath, '--output', resultPath], {
        cwd: workDir,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (error) {
      return resolve({ ok: false, why: `spawn 失败：${String((error && error.message) || error)}` })
    }

    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 忽略 */ }
      resolve({ ok: false, why: '抽帧超时' })
    }, timeoutMs)

    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, why: String((error && error.message) || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!existsSync(resultPath)) {
        log(`[frame] 脚本没产出结果（退出码 ${code}）：${stderr.slice(-300)}`)
        return resolve({ ok: false, why: `抽帧脚本退出码 ${code}` })
      }
      try {
        resolve({ ok: true, result: JSON.parse(readFileSync(resultPath, 'utf8')) })
      } catch (error) {
        resolve({ ok: false, why: `结果解析失败：${String((error && error.message) || error)}` })
      }
    })
  })
}
