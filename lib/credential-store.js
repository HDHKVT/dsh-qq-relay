/**
 * 登录凭证的落盘与搬迁（2026-10-24）。
 *
 * 为什么从 `relay.json` 搬出来：
 *   ① `relay.json` 会被人复制、备份、发出去排查问题，明文 cookie 就跟着到处跑；
 *   ② 凭证和普通配置的生命周期不同——它几个月就过期一次，应该单独管；
 *   ③ 单独一个文件才能收紧权限（去掉继承，只留当前用户）。
 *
 * 写入规矩（和 config.js 同一套）：先写 `.tmp` → 改名 → 旧的留 `.bak`。
 * 权限：Windows 上 `icacls /inheritance:r` 去掉继承，只给当前用户完全控制。
 */

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

import { normalizeCredential, validateCredential } from './credential.js'
import { parseSessdataExpiry } from './sessdata.js'

export const CREDENTIAL_FILE = 'credential.json'

/** 凭证文件的绝对路径 */
export function credentialPathOf(baseDir) {
  return join(baseDir, CREDENTIAL_FILE)
}

/**
 * 读凭证。文件不存在或读坏了都返回 {ok:false}，不抛。
 * @returns {{ok:true, record:object, validation:object} | {ok:false, why:string}}
 */
export function readCredential(baseDir) {
  const path = credentialPathOf(baseDir)
  if (!existsSync(path)) return { ok: false, why: '还没有凭证文件' }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { ok: false, why: `凭证文件读不了：${String((error && error.message) || error)}` }
  }
  const normalized = normalizeCredential(raw && raw.cookies ? raw.cookies : raw, {
    savedAtMs: raw && raw.savedAtMs,
    expiresAtMs: raw && raw.expiresAtMs,
  })
  if (!normalized.ok) return { ok: false, why: `凭证文件内容不合法：${normalized.reason}` }
  return {
    ok: true,
    record: normalized.record,
    validation: validateCredential(normalized.record, { nowMs: Date.now() }),
  }
}

/**
 * 写凭证（原子 + 留 .bak + 收紧权限）。
 * @param {string} baseDir
 * @param {{cookies:object, savedAtMs?:number|null, expiresAtMs?:number|null}} record
 * @returns {{ok:true, path:string} | {ok:false, why:string}}
 */
export function writeCredential(baseDir, record) {
  const path = credentialPathOf(baseDir)
  const tmp = `${path}.tmp`
  const bak = `${path}.bak`
  // 过期时间的来源：优先用调用方给的；没给就从 SESSDATA 自己身上读
  // （SESSDATA 的第二段就是它印的过期时间，见 sessdata.js）
  let expiresAtMs = Number.isFinite(record.expiresAtMs) ? record.expiresAtMs : null
  if (expiresAtMs === null) {
    const parsed = parseSessdataExpiry(record.cookies && record.cookies.SESSDATA)
    if (parsed.ok) expiresAtMs = parsed.expiresAtMs
  }
  // 最小化原则：只存真正用得到的凭据。
  // 只读场景只要有 SESSDATA；bili_jct / DedeUserID 这些我们用不上，
  // 存着就是多留一份密钥——不存。
  const kept = typeof record.cookies?.SESSDATA === 'string' ? { SESSDATA: record.cookies.SESSDATA } : {}
  const payload = {
    version: 1,
    cookies: kept,
    savedAtMs: Number.isFinite(record.savedAtMs) ? record.savedAtMs : Date.now(),
    expiresAtMs,
  }
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    // 凭证不留备份：备份等于把同一份密钥多存一次
    if (existsSync(bak)) unlinkSync(bak)
    renameSync(tmp, path)
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 忽略 */ }
    return { ok: false, why: `写凭证失败：${String((error && error.message) || error)}` }
  }
  tightenPermissions(path)
  return { ok: true, path }
}

/**
 * 收紧权限：去掉继承，只给当前用户完全控制。
 * 失败不影响功能（只是权限没变紧），所以只回调不报错。
 */
function tightenPermissions(path, onError = () => {}) {
  if (process.platform !== 'win32') return
  const user = process.env.USERNAME || ''
  if (!user) return
  execFile('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true }, (error) => {
    if (error) onError(String(error.message || error))
  })
}

/**
 * 把 `relay.json` 里的裸 cookie 搬进独立凭证文件。
 * 已经有凭证文件就什么都不做（不覆盖）。
 *
 * @param {string} baseDir
 * @param {{video?:{biliCookie?:string}}} cfg
 * @returns {{migrated:boolean, why:string, path?:string}}
 */
export function migrateFromConfig(baseDir, cfg) {
  const path = credentialPathOf(baseDir)
  if (existsSync(path)) return { migrated: false, why: '已经有凭证文件，未覆盖' }
  const rawCookie = String((cfg && cfg.video && cfg.video.biliCookie) || '').trim()
  if (rawCookie === '') return { migrated: false, why: 'relay.json 里没有 cookie' }

  const normalized = normalizeCredential(rawCookie, { savedAtMs: Date.now() })
  if (!normalized.ok) return { migrated: false, why: `旧 cookie 解析失败：${normalized.reason}` }

  const written = writeCredential(baseDir, normalized.record)
  if (!written.ok) return { migrated: false, why: written.why }
  return { migrated: true, why: '已从 relay.json 搬迁', path: written.path }
}

/**
 * 删掉凭证文件（用户主动"退出登录"）。
 * 备份也一并删：留着 .bak 等于没退干净。
 */
export function clearCredential(baseDir) {
  const path = credentialPathOf(baseDir)
  const bak = `${path}.bak`
  let removed = false
  for (const target of [path, bak]) {
    if (!existsSync(target)) continue
    try {
      unlinkSync(target)
      removed = true
    } catch (error) {
      return { ok: false, why: `删除失败：${String((error && error.message) || error)}` }
    }
  }
  return { ok: true, removed }
}

/** 把凭证拼成请求头（只读场景只要 SESSDATA，但带上其余也无妨） */
export function cookieHeaderOf(record) {
  const cookies = (record && record.cookies) || {}
  const names = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3']
  return names
    .filter((name) => typeof cookies[name] === 'string' && cookies[name] !== '')
    .map((name) => `${name}=${cookies[name]}`)
    .join('; ')
}
