/**
 * 视频处理的宿主侧壳子（阶段 1，2026-10-20）。
 *
 * 分工：Python（`video/video_processor.py`）做抽音频、ASR、抽帧、拼图，吐一份 JSON；
 * 这里只负责 **spawn → 等 → 读 JSON → 校验结构**，不解析视频本身。
 *
 * 约定（与云端架构师确认过）：
 *   python video_processor.py --input "<视频绝对路径>" --output "<结果 json 绝对路径>"
 *   stdout 不解析；错误看退出码 + stderr；结果只看 --output 那个文件。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, linkSync, copyFileSync, unlinkSync } from 'node:fs'

/**
 * @param {object} options
 * @param {string} options.python - python 可执行文件绝对路径（venv 里的那个）
 * @param {string} options.script - video_processor.py 的绝对路径
 * @param {string} options.input - 视频绝对路径
 * @param {string} options.output - 结果 JSON 绝对路径
 * @param {string} [options.cwd]
 * @param {number} [options.timeoutMs]
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{ok: true, result: object, stdout: string, stderr: string, elapsedMs: number}
 *   | {ok: false, error: string, stdout?: string, stderr?: string, code?: number|null}>}
 */
export function runVideoProcessor(options) {
  const {
    python,
    script,
    input,
    output,
    cwd,
    extraPath = '',
    hfHome = '',
    extraArgs = [],
    timeoutMs = 30 * 60 * 1000,
    log = () => {},
  } = options

  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let finished = false

    const done = (value) => {
      if (finished) return
      finished = true
      resolve(value)
    }

    if (!existsSync(python)) return done({ ok: false, error: `python 不存在：${python}` })
    if (!existsSync(script)) return done({ ok: false, error: `脚本不存在：${script}` })
    if (!existsSync(input)) return done({ ok: false, error: `视频不存在：${input}` })

    let child
    try {
      const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH'
      const basePath = process.env[pathKey] || ''
      const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      // 把插件自带的 ffmpeg（video\bin）放到 PATH 最前，Python 里直接 `ffmpeg` 就能找到
      if (extraPath !== '') env[pathKey] = `${extraPath};${basePath}`
      // 这台机器直连 HuggingFace 不通：默认走镜像，并关掉 xet（镜像不代理 xet 的 CAS）
      if (!env.HF_ENDPOINT) env.HF_ENDPOINT = 'https://hf-mirror.com'
      if (!env.HF_HUB_DISABLE_XET) env.HF_HUB_DISABLE_XET = '1'
      if (!env.HF_HUB_DISABLE_SYMLINKS_WARNING) env.HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
      if (hfHome && !env.HF_HOME) env.HF_HOME = hfHome
      child = spawn(python, [script, '--input', input, '--output', output, ...extraArgs], {
        cwd,
        windowsHide: true,
        env,
      })
    } catch (error) {
      return done({ ok: false, error: `spawn 失败：${String((error && error.message) || error)}` })
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 忽略 */ }
      done({ ok: false, error: `处理超时（>${Math.round(timeoutMs / 1000)} 秒）`, stdout, stderr })
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stderr += text
      for (const line of text.split(/\r?\n/)) if (line.trim() !== '') log(`[video] ${line.trim()}`)
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      done({ ok: false, error: `子进程错误：${String((error && error.message) || error)}`, stdout, stderr })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      const elapsedMs = Date.now() - started
      if (code !== 0) {
        const tail = stderr.trim().split(/\r?\n/).slice(-6).join(' / ')
        return done({ ok: false, error: `处理器退出码 ${code}${tail ? `：${tail}` : ''}`, stdout, stderr, code })
      }
      try {
        const parsed = JSON.parse(readFileSync(output, 'utf8'))
        const checked = validateResult(parsed)
        if (!checked.ok) return done({ ok: false, error: `结果结构不对：${checked.why}`, stdout, stderr, code })
        done({ ok: true, result: checked.result, stdout, stderr, elapsedMs })
      } catch (error) {
        done({ ok: false, error: `读结果失败：${String((error && error.message) || error)}`, stdout, stderr, code })
      }
    })
  })
}

/**
 * OpenCV 在 Windows 上遇到非 ASCII 路径常直接打不开：路径含中文时，
 * 在 outDir 里做一个 ASCII 名的硬链接（同盘几乎零成本），失败再退化成复制。
 *
 * @param {string} input
 * @param {string} outDir
 * @param {string} [ext]
 * @returns {{path: string, mode: 'as-is'|'link'|'copy', error?: string}}
 */
export function ensureAsciiInput(input, outDir, ext = '.mp4') {
  if (!/[^\x00-\x7F]/.test(input)) return { path: input, mode: 'as-is' }
  const safe = `${outDir}/input${ext}`
  try {
    try { unlinkSync(safe) } catch { /* 不存在就算了 */ }
    try {
      linkSync(input, safe)
      return { path: safe, mode: 'link' }
    } catch {
      copyFileSync(input, safe)
      return { path: safe, mode: 'copy' }
    }
  } catch (error) {
    return { path: input, mode: 'as-is', error: String((error && error.message) || error) }
  }
}

/**
 * 校验 Python 侧产出的结构（只认约定里的字段，多出来的忽略）。
 * @param {unknown} raw
 * @returns {{ok: true, result: {status: string, durationSeconds: number, subtitles: Array<{time: string, text: string}>, images: string[]}}
 *   | {ok: false, why: string}}
 */
export function validateResult(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, why: '不是对象' }
  const value = /** @type {any} */ (raw)
  if (value.status !== 'success') return { ok: false, why: `status=${String(value.status)}` }

  const duration = Number(value.duration_seconds)
  if (!Number.isFinite(duration) || duration < 0) return { ok: false, why: 'duration_seconds 非法' }

  if (!Array.isArray(value.subtitles)) return { ok: false, why: 'subtitles 不是数组' }
  const subtitles = []
  for (const item of value.subtitles) {
    if (!item || typeof item !== 'object') continue
    const time = typeof item.time === 'string' ? item.time : ''
    const text = typeof item.text === 'string' ? item.text : ''
    if (time === '' || text === '') continue
    subtitles.push({ time, text })
  }

  if (!Array.isArray(value.images)) return { ok: false, why: 'images 不是数组' }
  const images = value.images.filter((item) => typeof item === 'string' && item.trim() !== '')

  return {
    ok: true,
    result: {
      status: 'success',
      durationSeconds: duration,
      subtitles,
      images,
      mode: typeof value.mode === 'string' ? value.mode : '',
      model: typeof value.model === 'string' ? value.model : '',
      media: value.media === 'audio' ? 'audio' : 'video',
    },
  }
}

/**
 * 文件大小闸：超过上限直接拒（不截断）。
 * @param {string} file
 * @param {number} maxMb
 * @returns {{ok: true, bytes: number} | {ok: false, why: string}}
 */
export function checkVideoSize(file, maxMb) {
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return { ok: false, why: '不是文件' }
    const limit = maxMb * 1024 * 1024
    if (stat.size > limit) {
      return { ok: false, why: `视频太大（${(stat.size / 1024 / 1024).toFixed(1)}MB，上限 ${maxMb}MB）` }
    }
    return { ok: true, bytes: stat.size }
  } catch (error) {
    return { ok: false, why: String((error && error.message) || error) }
  }
}
