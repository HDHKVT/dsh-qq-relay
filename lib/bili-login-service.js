/**
 * B 站扫码登录的服务层（2026-10-24）。
 *
 * 分工：
 *   本文件负责**联网**：要二维码、轮询、把拿到的 cookie 存起来；
 *   「状态怎么变」交给 `login-machine.js`（纯 reducer），
 *   「轮询结果怎么解释」交给 `bili-login.js` 的 `interpretQrPoll`，
 *   「cookie 怎么抠」交给 `extractLoginCookies`。
 *
 * 安全边界：
 *   - 二维码是给用户扫的，**只落在本地文件里**，不经任何第三方服务；
 *   - 拿到的 cookie 只写进 `credential.json`（已收紧权限），不入日志。
 */

import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

import { interpretQrPoll, extractLoginCookies } from './bili-login.js'
import { writeCredential } from './credential-store.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const HEADERS = { 'user-agent': UA, referer: 'https://www.bilibili.com/' }

/**
 * 要一张新的登录二维码，并渲染成 PNG。
 *
 * @param {object} options
 * @param {string} options.dir         放二维码图片的目录
 * @param {string} options.pythonPath
 * @param {string} options.qrScript    video/qr_render.py
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ok:true, qrKey:string, qrUrl:string, pngPath:string}
 *   | {ok:false, why:string}>}
 */
export async function startQrLogin({ dir, pythonPath, qrScript, fetchImpl = fetch }) {
  let json
  try {
    const res = await fetchImpl('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { headers: HEADERS })
    json = await res.json()
  } catch (error) {
    return { ok: false, why: `请求二维码失败：${String((error && error.message) || error)}` }
  }
  if (!json || json.code !== 0 || !json.data || !json.data.url || !json.data.qrcode_key) {
    return { ok: false, why: `二维码接口返回异常：${(json && json.message) || '响应异常'}（${json && json.code}）` }
  }

  mkdirSync(dir, { recursive: true })
  const pngPath = join(dir, `qr-${json.data.qrcode_key.slice(0, 8)}.png`)
  const rendered = await renderQr({ pythonPath, qrScript, text: json.data.url, pngPath })
  if (!rendered.ok) return { ok: false, why: rendered.why }

  return { ok: true, qrKey: String(json.data.qrcode_key), qrUrl: String(json.data.url), pngPath }
}

/**
 * 轮询一次。**不重试、不循环**——节奏由调用方按 `nextPollDelay` 决定。
 * @returns {Promise<object>}  interpretQrPoll 的返回（已含 state / redirectUrl / reason）
 */
export async function pollQrLogin({ qrKey, fetchImpl = fetch }) {
  let json
  try {
    const res = await fetchImpl(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrKey)}`,
      { headers: HEADERS },
    )
    json = await res.json()
    // 确认登录时，Set-Cookie 里也带着凭据；一起交给抠 cookie 的模块
    const setCookies = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    const verdict = interpretQrPoll(json)
    if (verdict.ok && verdict.state === 'confirmed' && setCookies.length > 0) {
      verdict.setCookieHeaders = setCookies
    }
    return verdict
  } catch (error) {
    return { ok: false, reason: `轮询失败：${String((error && error.message) || error)}` }
  }
}

/**
 * 登录成功后把凭据存下来。
 *
 * @param {object} options
 * @param {string} options.baseDir      插件数据目录（凭证写这里）
 * @param {object} options.pollResult   confirmed 状态的轮询结果
 * @param {number} [options.nowMs]
 * @returns {{ok:true, path:string, cookies:object} | {ok:false, why:string}}
 */
export function saveLoginCredential({ baseDir, pollResult, nowMs = Date.now() }) {
  const extracted = extractLoginCookies({
    redirectUrl: pollResult && pollResult.redirectUrl ? pollResult.redirectUrl : '',
    setCookieHeaders: Array.isArray(pollResult && pollResult.setCookieHeaders) ? pollResult.setCookieHeaders : [],
  })
  if (!extracted.ok) return { ok: false, why: extracted.reason }

  const written = writeCredential(baseDir, {
    cookies: extracted.cookies,
    savedAtMs: nowMs,
    expiresAtMs: null, // 由 credential-store 从 SESSDATA 内部读出来
  })
  if (!written.ok) return { ok: false, why: written.why }
  return { ok: true, path: written.path, cookies: extracted.cookies }
}

/** 调 Python 把 url 渲染成 PNG */
function renderQr({ pythonPath, qrScript, text, pngPath, timeoutMs = 30 * 1000 }) {
  return new Promise((resolve) => {
    if (!existsSync(pythonPath)) return resolve({ ok: false, why: `python 不存在：${pythonPath}` })
    if (!existsSync(qrScript)) return resolve({ ok: false, why: `渲染脚本不存在：${qrScript}` })

    execFile(
      pythonPath,
      [qrScript, '--text', text, '--output', pngPath, '--scale', '8'],
      { windowsHide: true, timeout: timeoutMs },
      (error) => {
        if (error) return resolve({ ok: false, why: `渲染二维码失败：${String(error.message || error)}` })
        if (!existsSync(pngPath)) return resolve({ ok: false, why: '渲染脚本没产出图片' })
        resolve({ ok: true })
      },
    )
  })
}
