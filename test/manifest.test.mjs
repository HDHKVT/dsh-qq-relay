/**
 * 发布清单的护栏（2026-10-25）。
 *
 * 背景：DSH STORE 的自动检查报过一次「Catalog blocked」——原因是 package.json 的
 * `files` 白名单只写了 `lib/client.js`，**宿主那十几个模块全被排除在发布包之外**，
 * `index.js` 一 require 就找不到文件。本地装看不出来，因为本地是整个目录 link 进去的。
 *
 * 所以这里钉三件事：
 *   ① `files` 必须覆盖 `index.js` 里 require 的每一个 `./lib/*.js`；
 *   ② 必须声明 Node 与 DSH 的兼容范围（STORE 的硬要求）；
 *   ③ `main` / `exports` 指向的文件必须真实存在。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const indexSource = readFileSync(join(ROOT, 'index.js'), 'utf8')

// ---- ① index.js 里 require 的本地模块 ----
const required = new Set()
for (const match of indexSource.matchAll(/from\s+'\.\/(lib\/[A-Za-z0-9_-]+\.js)'/g)) {
  required.add(match[1])
}
assert.ok(required.size > 5, `index.js 里的本地模块太少（${required.size}），正则可能失效了`)

const files = Array.isArray(pkg.files) ? pkg.files : []
const covered = (rel) => files.some((pattern) => {
  if (pattern === rel) return true
  if (pattern.endsWith('/')) return rel.startsWith(pattern)
  return false
})
const missing = [...required].filter((rel) => !covered(rel))
assert.deepEqual(missing, [], `这些模块没有进发布清单：${missing.join(', ')}`)

// ---- 每个模块在磁盘上也要真的存在 ----
const notOnDisk = [...required].filter((rel) => !existsSync(join(ROOT, rel)))
assert.deepEqual(notOnDisk, [], `这些模块在磁盘上不存在：${notOnDisk.join(', ')}`)

// ---- ② 兼容范围 ----
assert.ok(pkg.engines && typeof pkg.engines.node === 'string', 'package.json 必须声明 engines.node')
assert.ok(
  pkg.peerDependencies && typeof pkg.peerDependencies['@deepseek-ai/dsh'] === 'string',
  'package.json 必须声明 peerDependencies["@deepseek-ai/dsh"]（STORE 检查的就是这个）',
)

// ---- ③ 入口文件存在 ----
assert.ok(existsSync(join(ROOT, pkg.main)), `main 指向的文件不存在：${pkg.main}`)
for (const [key, value] of Object.entries(pkg.exports || {})) {
  if (typeof value === 'string' && value.endsWith('.js')) {
    assert.ok(existsSync(join(ROOT, value)), `exports["${key}"] 指向的文件不存在：${value}`)
  }
}

// ---- 附带：本地备份绝不能被 npm 带出去 ----
// npm 对 README* / LICENSE* 是"总是包含"，所以仓库里放 README.md.bak-* 会被打包
assert.ok(!files.some((pattern) => pattern.includes('.bak')), 'files 里不许出现 .bak')

console.log(`manifest: ${required.size} 个本地模块全部覆盖，兼容范围已声明，入口文件存在`)
console.log('manifest test: PASS')
