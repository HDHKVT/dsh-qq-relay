/**
 * 阶段 3 · 文件（`lib/files.js`）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  pickFile, downloadFile, sanitizeName, saveFile, pruneFiles, clearFiles, filesDirOf, MAX_FILE_BYTES_DEFAULT,
} from '../lib/files.js'

// ---------------------------------------------------------------- pickFile
{
  const event = {
    attachments: [
      { content_type: 'image/png', url: 'http://x/a.png' },
      { content_type: 'file/pdf', url: 'http://x/a.pdf', filename: '说明.pdf' },
    ],
  }
  assert.deepEqual(pickFile(event), { url: 'http://x/a.pdf', filename: '说明.pdf', contentType: 'file/pdf' }, '图片要被跳过')
  assert.equal(pickFile({ attachments: [{ content_type: 'image/png', url: 'http://x/a.png' }] }), null)
  assert.equal(pickFile({}), null)
  assert.deepEqual(
    pickFile({ msgElements: [{ content_type: 'file', url: 'http://x/e.txt', filename: 'e.txt' }] }),
    { url: 'http://x/e.txt', filename: 'e.txt', contentType: 'file' },
  )
  // 2026-10-18 真机回归：表情元素 content 里是 <faceType=…>，不能当文件 URL 去下载
  assert.equal(pickFile({ msgElements: [{ content_type: '', content: '<faceType=6,faceId="0",ext="x">' }] }), null, '表情标记不是文件')
  assert.equal(pickFile({ msgElements: [{ content_type: 'file', content: 'http://x/no-url.txt' }] }), null, '没有 url 字段的不当文件')
  assert.equal(pickFile({ attachments: [{ content_type: 'file/pdf', url: 'ftp://x/a.pdf' }] }), null, '非 http(s) 不下载')
  console.log('pickFile -> OK')
}

// ---------------------------------------------------------------- 下载闸
{
  const okFetch = async () => ({ ok: true, status: 200, headers: { get: () => '10' }, arrayBuffer: async () => Buffer.from('hello') })
  const good = await downloadFile('http://x/a.txt', { fetchImpl: okFetch })
  assert.equal(good.ok, true)
  assert.equal(good.bytes.toString(), 'hello')

  let read = false
  const bigFetch = async () => ({ ok: true, status: 200, headers: { get: () => '999999999' }, arrayBuffer: async () => { read = true; return Buffer.alloc(1) } })
  assert.deepEqual(await downloadFile('http://x/big', { fetchImpl: bigFetch }).then((r) => [r.ok, r.reason]), [false, 'too-large'])
  assert.equal(read, false, '声明超限时不许读 body')

  const abortFetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
  assert.equal((await downloadFile('http://x/slow', { fetchImpl: abortFetch })).reason, 'timeout')
  assert.ok(MAX_FILE_BYTES_DEFAULT === 20 * 1024 * 1024, '默认上限 20MB')
  console.log('downloadFile gates -> OK')
}

// ---------------------------------------------------------------- 名字 / 落盘 / 清理
const root = mkdtempSync(join(tmpdir(), 'qq-relay-files-'))
try {
  assert.equal(sanitizeName('a/b\\c:d?.pdf'), 'a_b_c_d_.pdf')
  assert.equal(sanitizeName(''), 'file.bin')
  assert.equal(filesDirOf('D:/base', { file: { dir: '' } }), join('D:/base', 'files'))
  assert.equal(filesDirOf('D:/base', { file: { dir: 'E:/dl' } }), 'E:/dl')

  const dir = filesDirOf(join(root, 'x'), { file: {} })
  const saved = saveFile(dir, { bytes: Buffer.from('abc'), filename: '报告.pdf', msgId: 'ROBOT1.0_zz123456', at: Date.UTC(2026, 9, 18, 2, 0, 0) })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const names = readdirSync(dir)
  assert.equal(names.filter((n) => n.endsWith('.pdf')).length, 1)
  assert.equal(names.filter((n) => n.endsWith('.json')).length, 1)
  assert.ok(names.some((n) => n.includes('报告.pdf')), '文件名要保留原名')
  const sidecar = JSON.parse(readFileSync(join(dir, names.find((n) => n.endsWith('.json'))), 'utf8'))
  assert.equal(sidecar.name, '报告.pdf')
  assert.equal(sidecar.source, 'qq-direct')

  const old = join(dir, '20260101-000000-old-1.txt')
  writeFileSync(old, 'x')
  const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000
  utimesSync(old, tenDaysAgo, tenDaysAgo)
  assert.equal(pruneFiles(dir, 7), 1, '只删超期那一个')
  assert.equal(existsSync(old), false)
  assert.equal(pruneFiles(dir, 0), 0, '0 天不清')

  const cleared = clearFiles(dir)
  assert.ok(cleared.removed >= 1 && cleared.bytes > 0)
  assert.equal(readdirSync(dir).length, 0)
  console.log('save/prune/clear -> OK')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('files.test.mjs: all assertions passed')
