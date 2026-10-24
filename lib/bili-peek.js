/**
 * 「轻量看」一条 B 站视频（2026-10-24）。
 *
 * 它做的事：拿稿件信息 → 拿故事板 → 算抽哪几帧 → 下载拼图 → 交给 Python 裁图
 * → 组装成给模型读的文本 + 一张总览图。
 *
 * 它**不**做的事：
 *   - 不下载视频本体、不做 ASR。那是 `analyze_video` 那条重路径的活，两条互补：
 *     轻量看回答「值不值得点开」，analyze_video 回答「里面到底讲了什么」。
 *   - 不把图片塞进工具返回值。DSH 的工具结果只能是文本，图要靠模型自己用
 *     read_image 去读，所以这里返回的是**路径**。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'

import { resolveShare } from './bilibili.js'
import { fetchVideoBrief, fetchStoryboardMeta, downloadSprite } from './bili-storyboard.js'
import { planStoryboardFrames } from './plan-storyboard-frames.js'
import { buildWatchPackage } from './build-watch-package.js'
import { fetchSubtitle } from './bili-subtitle.js'
import { subtitleToText } from './subtitle-to-text.js'
import { fetchVideoConclusion } from './bili-conclusion.js'
import { parseVideoConclusion } from './conclusion.js'
import { transcribeBili, ASR_AUTO_LIMIT_SECONDS } from './bili-asr.js'

/**
 * @param {object} options
 * @param {string} options.text        用户给的链接 / BV 号 / 分享文案
 * @param {string} options.workRoot    工作目录根（每次调用在其下建一个子目录）
 * @param {string} options.pythonPath  venv 里的 python
 * @param {string} options.scriptPath  video/storyboard_crop.py
 * @param {number} [options.count]     抽几帧（默认 6）
 * @param {(line:string)=>void} [options.log]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ok:true, text:string, montage:string, frames:Array, dir:string}
 *   | {ok:false, why:string}>}
 */
/** 字幕最多送多少句进上下文：再多就按比例抽样，保证覆盖全片而不是只留开头 */
const MAX_SUBTITLE_SEGMENTS = 160

/**
 * 按比例抽样句子。step === 1 表示原样返回（没抽）。
 * 为什么不是截断：截断只留下开头，长视频后半段等于没看。
 */
function sampleSegments(body, limit) {
  const list = Array.isArray(body) ? body : []
  if (list.length <= limit) return { body: list, step: 1 }
  const step = Math.ceil(list.length / limit)
  return { body: list.filter((_, index) => index % step === 0), step }
}

export async function peekBili(options) {
  const {
    text,
    workRoot,
    pythonPath,
    scriptPath,
    count = 6,
    cookie = '',
    asrModelDir = '',
    asrMode = 'accurate',
    asrAutoLimitSeconds = ASR_AUTO_LIMIT_SECONDS,
    log = () => {},
    fetchImpl = fetch,
  } = options

  let bvid
  try {
    const parsed = await resolveShare(String(text || ''), fetchImpl)
    bvid = parsed.bvid
  } catch (error) {
    return { ok: false, why: `认不出这是哪个视频：${String((error && error.message) || error)}` }
  }

  let brief
  try {
    brief = await fetchVideoBrief(bvid, fetchImpl)
    log(`[peek] ${brief.title}（${brief.duration} 秒，${brief.uploader || '未知 UP'}）`)
  } catch (error) {
    return { ok: false, why: String((error && error.message) || error) }
  }

  const dir = join(workRoot, `${bvid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })

  const meta = {
    title: brief.title,
    uploader: brief.uploader,
    durationSeconds: brief.duration,
    url: brief.url,
    description: brief.description,
  }

  // 取字幕（有 cookie 才可能拿到）。拿不到不影响画面这条腿。
  let subtitleText = ''
  let subtitleNote = ''
  // 被风控时不能混进「没有字幕」——那样上层会把每个视频都当"无语音"跳过，静默失效
  let blockedCode = 0
  if (cookie) {
    try {
      const sub = await fetchSubtitle({ aid: brief.aid, cid: brief.cid, cookie, fetchImpl })
      if (sub.ok) {
        // 字幕太长时**均匀抽样**而不是靠 maxChars 截断：
        // 截断只会留下开头（往往是铺垫），长视频后半段等于没看。
        const rawBody = Array.isArray(sub.payload.body) ? sub.payload.body : []
        const sampled = sampleSegments(rawBody, MAX_SUBTITLE_SEGMENTS)
        // B 站的 AI 字幕没有标点，整段拼起来读不动；按句分行 + 带时间轴，
        // 既好读，也让模型能指着某个时刻说"这一帧给我看看"
        const converted = subtitleToText({ ...sub.payload, body: sampled.body }, { maxChars: 9000, timecodes: true })
        if (converted.ok) {
          subtitleText = converted.text
          const isAi = String(sub.lan).toLowerCase().startsWith('ai')
          const sampleNote = sampled.step > 1 ? `（共 ${rawBody.length} 句，每 ${sampled.step} 句取 1 句，覆盖全片）` : ''
          subtitleNote = `【字幕来源】${sub.lanDoc || sub.lan}${isAi ? '（AI 自动生成，同音字可能有误）' : ''}，${converted.stats.kept} 段${sampleNote}`
          log(`[peek] 字幕 ${sub.lan}（原文 ${converted.stats.total} 段，抽样后 ${converted.stats.kept} 段，${converted.stats.chars} 字）`)
        } else {
          log(`[peek] 字幕转文本失败：${converted.reason}`)
        }
      } else if (sub.code === 'blocked') {
        blockedCode = Number(sub.apiCode) || -1
        subtitleNote = `【字幕状态】拉取被风控拦截（${blockedCode}），本条字幕情况未知；不要把「没拉到」写成「没有字幕」。`
        log(`[peek] ⚠️ 字幕被风控拦截（${blockedCode}），本次不做任何重试`)
      } else if (sub.code === 'no-track') {
        log('[peek] 这条视频确实没有字幕轨')
      } else {
        log(`[peek] 字幕没拿到（${sub.code}）：${sub.why}`)
      }
    } catch (error) {
      log(`[peek] 字幕异常：${String((error && error.message) || error)}`)
    }
  }

  // 没有 AI 字幕时的兜底：下纯音频跑本地 Whisper。
  // 语音是理解的主干，画面只能补旁支——所以这一级排在抽帧之前。
  // 但转写要等几十秒到几分钟，长视频不自动跑，把决定权交给调用方。
  if (!subtitleText && brief.duration > 0 && brief.duration <= asrAutoLimitSeconds) {
    const processorPath = join(dirname(scriptPath), 'video_processor.py')
    log(`[peek] 没有 AI 字幕，改跑本地转写（${brief.duration} 秒的音频）`)
    const asr = await transcribeBili({
      bvid: brief.bvid,
      cid: brief.cid,
      duration: brief.duration,
      dir,
      pythonPath,
      scriptPath: processorPath,
      modelDir: asrModelDir,
      mode: asrMode,
      cookie,
      log,
      fetchImpl,
    })
    if (asr.ok) {
      const lines = asr.segments.map((segment) => `[${segment.time}] ${segment.text}`)
      subtitleText = lines.join('\n')
      subtitleNote = `【字幕来源】本地 Whisper 转写（${asrMode === 'fast' ? 'base' : 'large-v3-turbo'}），${asr.segments.length} 段，用时 ${Math.round(asr.elapsedMs / 1000)} 秒｜B 站没有提供字幕`
    } else {
      log(`[peek] 转写失败：${asr.why}`)
      subtitleNote = `【字幕状态】B 站没有字幕，本地转写也失败了：${asr.why}`
    }
  } else if (!subtitleText && brief.duration > asrAutoLimitSeconds) {
    subtitleNote = `【字幕状态】B 站没有字幕；这条 ${Math.round(brief.duration / 60)} 分钟，本地转写要等几分钟，需要的话说一声`
  }

  // 官方 AI 总结：摘要 + 带时间戳的大纲。拿不到就跳过——接口偶发 -504，内部已重试一次。
  // 那些时间点是 B 站自己标的内容要点，模型可以拿它调 bili_frame 精确抽帧。
  let conclusionText = ''
  try {
    const got = await fetchVideoConclusion({ bvid: brief.bvid, cid: brief.cid, upMid: brief.upMid, cookie, fetchImpl })
    if (got.ok) {
      const parsed = parseVideoConclusion(got.data)
      if (parsed.ok && (parsed.summary !== '' || parsed.pointCount > 0)) {
        const blocks = []
        if (parsed.summary) blocks.push(`【B站官方摘要】${parsed.summary}`)
        const outlineLines = []
        for (const section of parsed.sections) {
          for (const point of section.points) {
            outlineLines.push(`  ${formatStamp(point.timeSeconds)} ${point.content}`)
            if (outlineLines.length >= 40) break
          }
          if (outlineLines.length >= 40) break
        }
        if (outlineLines.length > 0) blocks.push(['【官方大纲】（可用这些时刻调 bili_frame 精确抽帧）', ...outlineLines].join('\n'))
        conclusionText = blocks.join('\n\n')
        log(`[peek] 官方总结：摘要 ${parsed.summary.length} 字，要点 ${parsed.pointCount} 个${got.retried ? '（重试后拿到）' : ''}`)
      }
    } else {
      log(`[peek] 官方总结没拿到：${got.why}`)
    }
  } catch (error) {
    log(`[peek] 官方总结异常：${String((error && error.message) || error)}`)
  }

  const subtitleInput = subtitleText ? { text: subtitleText } : null
  // 字幕正文的预算在 subtitleToText 里已经处理过，这里放大到不会触发二次截断
  const packageOptions = { maxSubtitleChars: 7000 }

  // 被风控拦截时，把「没有字幕」那一行换成实话——两者绝不能混
  const applyBlocked = (text) => {
    if (!blockedCode) return text
    return text.replace(
      '【字幕】本条没有字幕，只能依据标题和简介判断，不要臆测画面内容',
      `【字幕】拉取被风控拦截（${blockedCode}），本条字幕情况未知——不要据此判断「没有语音」`,
    )
  }

  // 取故事板；拿不到就降级成「只有文字」的观看包，别让整个调用失败
  let storyboard = null
  try {
    storyboard = await fetchStoryboardMeta(brief.aid, brief.cid, fetchImpl)
    log(`[peek] 故事板 ${storyboard.sheets} 张，${storyboard.columns}×${storyboard.rows} 格，单格 ${storyboard.cellWidth}×${storyboard.cellHeight}`)
  } catch (error) {
    log(`[peek] 故事板拿不到，降级为纯文字：${String((error && error.message) || error)}`)
  }

  if (!storyboard) {
    const built = buildWatchPackage({ meta, frames: [], subtitle: subtitleInput }, packageOptions)
    if (!built.ok) return { ok: false, why: `组装观看包失败：${built.reason}` }
    const extra = subtitleNote ? `\n\n${subtitleNote}` : ''
    const tail = conclusionText ? `\n\n${conclusionText}` : ''
    return { ok: true, text: `${applyBlocked(built.text)}${extra}${tail}\n\n（这条视频没有可用的故事板，所以一张画面都没有取到。）`, montage: '', frames: [], dir }
  }

  // 故事板自带时间轴（index 字段有值）时，用纯函数规划；
  // 没有时间轴时不能按时长平铺——实测 B 站是「只填前若干格，其余留黑」，
  // 平铺会一路裁到黑格上。这种情况交给 Python 先扫出哪几格真有画面再挑。
  const hasTimeline = Array.isArray(storyboard.cellTimes) && storyboard.cellTimes.length > 1
  let plan = null
  if (hasTimeline) {
    plan = planStoryboardFrames({
      durationSeconds: brief.duration,
      columns: storyboard.columns,
      rows: storyboard.rows,
      cellWidth: storyboard.cellWidth,
      cellHeight: storyboard.cellHeight,
      imageUrls: storyboard.imageUrls,
      cellTimes: storyboard.cellTimes,
    }, { count })
  }

  if (hasTimeline && !plan.ok) {
    const built = buildWatchPackage({ meta, frames: [], subtitle: subtitleInput }, packageOptions)
    const extra = subtitleNote ? `\n\n${subtitleNote}` : ''
    return { ok: !!built.ok, text: built.ok ? `${applyBlocked(built.text)}${extra}\n\n（故事板数据异常：${plan.reason}）` : '', montage: '', frames: [], dir }
  }

  // 有时间轴时只下真正用到的那几张；auto 模式要扫描，得全下
  const neededSheets = hasTimeline
    ? [...new Set(plan.frames.map((frame) => storyboard.imageUrls.indexOf(frame.imageUrl)))].filter((index) => index >= 0)
    : storyboard.imageUrls.map((_, index) => index)
  const spritePaths = new Array(storyboard.imageUrls.length).fill('')
  const downloadErrors = []
  for (const sheetIndex of neededSheets) {
    const dest = join(dir, `sprite-${sheetIndex}.jpg`)
    try {
      await downloadSprite(storyboard.imageUrls[sheetIndex], dest, fetchImpl)
      spritePaths[sheetIndex] = dest
    } catch (error) {
      downloadErrors.push(`拼图 ${sheetIndex}：${String((error && error.message) || error)}`)
    }
  }

  const planJson = hasTimeline
    ? {
        sprites: spritePaths,
        frames: plan.frames.map((frame) => ({
          sprite: storyboard.imageUrls.indexOf(frame.imageUrl),
          x: frame.x,
          y: frame.y,
          w: frame.w,
          h: frame.h,
          timeSeconds: frame.timeSeconds,
        })),
        montage: { enabled: true, columns: Math.min(3, plan.frames.length), maxWidth: 1600 },
      }
    : {
        sprites: spritePaths,
        frames: [],
        auto: true,
        columns: storyboard.columns,
        rows: storyboard.rows,
        cellWidth: storyboard.cellWidth,
        cellHeight: storyboard.cellHeight,
        count,
        durationSeconds: brief.duration,
        montage: { enabled: true, columns: 3, maxWidth: 1600 },
      }
  const planPath = join(dir, 'plan.json')
  const resultPath = join(dir, 'result.json')
  writeFileSync(planPath, JSON.stringify(planJson, null, 2), 'utf8')

  const cropped = await runCropScript({ pythonPath, scriptPath, planPath, resultPath, log, workDir: dir })
  const frames = cropped.ok && Array.isArray(cropped.result.frames) ? cropped.result.frames : []
  const montage = cropped.ok ? String(cropped.result.montage || '') : ''

  const built = buildWatchPackage({ meta, frames: frames.map((frame) => ({ timeSeconds: frame.timeSeconds })), subtitle: subtitleInput }, packageOptions)
  if (!built.ok) return { ok: false, why: `组装观看包失败：${built.reason}` }

  const lines = [applyBlocked(built.text)]
  if (conclusionText) lines.push('', conclusionText)
  if (subtitleNote) lines.push('', subtitleNote)
  if (montage && existsSync(montage)) {
    lines.push('', `【总览图】${montage}（这是全部帧拼成的一张图，用 read_image 看它）`)
  }
  if (frames.length > 0) {
    lines.push('', '【单帧】')
    for (const frame of frames) lines.push(`  ${formatStamp(frame.timeSeconds)}  ${frame.path}`)
  }
  if (downloadErrors.length > 0) lines.push('', `【下载异常】${downloadErrors.join('；')}`)
  const cropErrors = cropped.ok && Array.isArray(cropped.result.errors) ? cropped.result.errors : []
  if (cropErrors.length > 0) lines.push('', `【裁切异常】${cropErrors.map((item) => item.reason).join('；')}`)

  return { ok: true, text: lines.join('\n'), montage, frames, dir }
}

/** 秒 → mm:ss，只用于给单帧列表标时间 */
function formatStamp(seconds) {
  const total = Math.round(Number(seconds) || 0)
  const minutes = Math.floor(total / 60)
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** 起 Python 脚本裁图；超时或非零退出都当作「没裁出来」，不抛给上层。 */
function runCropScript({ pythonPath, scriptPath, planPath, resultPath, workDir, log, timeoutMs = 120 * 1000 }) {
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
      resolve({ ok: false, why: '裁切超时' })
    }, timeoutMs)

    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, why: String((error && error.message) || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!existsSync(resultPath)) {
        log(`[peek] 裁图脚本没产出结果（退出码 ${code}）：${stderr.slice(-300)}`)
        return resolve({ ok: false, why: `裁图脚本退出码 ${code}` })
      }
      try {
        const result = JSON.parse(readFileSync(resultPath, 'utf8'))
        resolve({ ok: result.status === 'ok', why: result.status, result })
      } catch (error) {
        resolve({ ok: false, why: `结果 JSON 解析失败：${String((error && error.message) || error)}` })
      }
    })
  })
}

/** 清理过期的轻量看目录（按天保留）。 */
export function prunePeekDirs(workRoot, retentionDays = 3) {
  if (!existsSync(workRoot)) return 0
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000
  let removed = 0
  try {
    for (const name of readdirSync(workRoot)) {
      const full = join(workRoot, name)
      try {
        if (statSync(full).mtimeMs < cutoff) { rmSync(full, { recursive: true, force: true }); removed += 1 }
      } catch { /* 单个目录失败不影响其他 */ }
    }
  } catch { /* 目录读不了就算了 */ }
  return removed
}
