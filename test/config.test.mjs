/**
 * Task 1 · 配置层测试（先写、先看它红）
 *
 * 覆盖四件事：
 *   1. 掩码：`publicConfig` 绝不回明文密钥，只回 `hasSecret`
 *   2. 白名单：未知字段不许写（防止把任意键写进 relay.json）
 *   3. 空密钥不覆盖：界面留空 = 不修改，而不是把密钥清空
 *   4. 原子写：留 `.bak`、写完能解析、旧键保留
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const { readConfig, writeConfig, publicConfig, DEFAULTS } = await import('../lib/config.js')

const dir = mkdtempSync(join(tmpdir(), 'qq-relay-config-'))
const file = join(dir, 'relay.json')
const read = () => JSON.parse(readFileSync(file, 'utf8'))

try {
  // ---------- 1. 掩码 ----------
  const withSecret = {
    sessionId: 'session-a',
    transport: 'direct',
    direct: { appId: 'app-1', appSecret: 's3cret', ownerId: 'owner-1', intents: 33554432 },
    reply: { maxChars: 900, minGapMs: 2000, hint: true },
  }
  const pub = publicConfig(withSecret)
  assert.equal(pub.direct.appSecret, undefined, '明文密钥不许出现在对外快照里')
  assert.equal(pub.direct.hasSecret, true, '要告诉界面“已经配过密钥”')
  assert.equal(pub.direct.appId, 'app-1', '非密钥字段原样通过')

  const noSecret = publicConfig({ direct: { appId: 'app-1', appSecret: '', ownerId: '' } })
  assert.equal(noSecret.direct.hasSecret, false, '空密钥 = 没配过')

  // ---------- 2. 未知键被拒 ----------
  writeFileSync(file, JSON.stringify({ sessionId: null }, null, 2))
  const rejected = writeConfig(dir, { nope: 1 })
  assert.equal(rejected.ok, false, '未知顶层键必须被拒')
  assert.match(String(rejected.why), /nope/, '错误里要点名是哪个键')

  // ---------- 3. 空密钥不覆盖 ----------
  writeFileSync(file, JSON.stringify({ direct: { appId: 'a', appSecret: 'keep-me', ownerId: 'o' } }, null, 2))
  const ok = writeConfig(dir, { direct: { appId: 'a2', appSecret: '', ownerId: 'o2' } })
  assert.equal(ok.ok, true, '合法补丁应当成功')
  assert.equal(read().direct.appSecret, 'keep-me', '留空 = 不修改，不能把密钥清掉')
  assert.equal(read().direct.appId, 'a2', '其余字段正常写入')

  // ---------- 4. 原子写 ----------
  writeConfig(dir, { sessionId: 'session-b' })
  assert.ok(existsSync(`${file}.bak`), '写之前要留一份 .bak')
  assert.equal(read().sessionId, 'session-b', '写完能被解析')
  assert.equal(read().direct.appSecret, 'keep-me', '旧键要保留')
  assert.ok(!existsSync(`${file}.tmp`), '临时文件必须已改名掉')

  // ---------- 5. 默认值与校验 ----------
  const empty = readConfig(mkdtempSync(join(tmpdir(), 'qq-relay-empty-')))
  assert.equal(empty.transport, DEFAULTS.transport, '缺文件时回默认 transport')
  assert.deepEqual(empty.reply, DEFAULTS.reply, '缺字段时回默认 reply')
  assert.equal(empty.direct.appSecret, '', '没配过密钥（内部读法是空串）')

  const badTransport = writeConfig(dir, { transport: 'smoke' })
  assert.equal(badTransport.ok, false, 'transport 只认 mailbox / direct')

  const badLimit = writeConfig(dir, { reply: { maxChars: 5000 } })
  assert.equal(badLimit.ok, false, 'maxChars 超出范围要拒')

  // ---------- 6. image 组（阶段 2） ----------
  const emptyImage = readConfig(mkdtempSync(join(tmpdir(), 'qq-relay-img-')))
  assert.deepEqual(emptyImage.image, DEFAULTS.image, '缺省值必须是 12MB / 7 天 / 开 / 单图')
  assert.equal(DEFAULTS.image.maxMb, 12)
  assert.equal(DEFAULTS.image.batchMs, 800, '连发多图默认合并 800ms')
  assert.equal(writeConfig(dir, { image: { batchMs: 5001 } }).ok, false, 'batchMs 超过 5000 要拒')
  assert.equal(writeConfig(dir, { image: { batchMs: 0 } }).ok, true, '0 = 关闭合并，合法')

  assert.equal(writeConfig(dir, { image: { maxMb: 0 } }).ok, false, 'maxMb 小于 1 要拒')
  assert.equal(writeConfig(dir, { image: { maxMb: 51 } }).ok, false, 'maxMb 大于 50 要拒')
  assert.equal(writeConfig(dir, { image: { retentionDays: 0 } }).ok, true, '0 = 不落盘，是合法值')
  assert.equal(read().image.retentionDays, 0)
  assert.equal(writeConfig(dir, { image: { retentionDays: 91 } }).ok, false, '天数超过 90 要拒')
  assert.equal(writeConfig(dir, { image: { enabled: 'yes' } }).ok, false, 'enabled 必须是布尔')
  assert.equal(writeConfig(dir, { image: { nope: 1 } }).ok, false, 'image 里未知键要拒')

  // ---------- 8. send 组（发图配文放哪） ----------
  assert.equal(DEFAULTS.send.captionMode, 'merge', '默认并进同一条')
  assert.equal(writeConfig(dir, { send: { captionMode: 'separate' } }).ok, true)
  assert.equal(read().send.captionMode, 'separate')
  assert.equal(writeConfig(dir, { send: { captionMode: 'x' } }).ok, false, '只认 merge / separate')
  assert.equal(writeConfig(dir, { send: { nope: 1 } }).ok, false, 'send 里未知键要拒')
  assert.equal(DEFAULTS.send.fileMaxMb, 30, '发文件默认上限 30MB')
  assert.equal(writeConfig(dir, { send: { fileMaxMb: 60 } }).ok, true)
  assert.equal(read().send.fileMaxMb, 60)
  assert.equal(writeConfig(dir, { send: { fileMaxMb: 0 } }).ok, false, '上限不能是 0')
  assert.equal(writeConfig(dir, { send: { fileMaxMb: 201 } }).ok, false, '上限超过 200 要拒')

  // ---------- 9. sticker 组（表情包暗号） ----------
  assert.equal(DEFAULTS.sticker.trigger, '存表情包')
  assert.equal(writeConfig(dir, { sticker: { trigger: '收进表情包' } }).ok, true)
  assert.equal(read().sticker.trigger, '收进表情包')
  assert.equal(writeConfig(dir, { sticker: { trigger: '   ' } }).ok, false, '暗号不能是空白')
  assert.equal(writeConfig(dir, { sticker: { trigger: 'x'.repeat(25) } }).ok, false, '暗号太长要拒')
  assert.equal(writeConfig(dir, { sticker: { nope: 1 } }).ok, false, 'sticker 里未知键要拒')
  assert.equal(DEFAULTS.sticker.byRecent, true, '默认允许用“最近一张图”兜底')
  assert.equal(writeConfig(dir, { sticker: { byRecent: 'no' } }).ok, false, 'byRecent 必须是布尔')
  assert.equal(writeConfig(dir, { sticker: { recentMs: 600001 } }).ok, false, 'recentMs 超范围要拒')
  assert.equal(DEFAULTS.sticker.frequency, 'normal', '频率默认 normal')
  assert.equal(writeConfig(dir, { sticker: { frequency: 'rare' } }).ok, true)
  assert.equal(read().sticker.frequency, 'rare')
  assert.equal(writeConfig(dir, { sticker: { frequency: 'always' } }).ok, false, '只认 off/rare/normal/often')

  // ---------- 7. file 组（阶段 3） ----------
  const emptyFile = readConfig(mkdtempSync(join(tmpdir(), 'qq-relay-file-')))
  assert.deepEqual(emptyFile.file, DEFAULTS.file, '缺省：开 / 20MB / 7 天')
  assert.equal(DEFAULTS.file.maxMb, 20)
  assert.equal(writeConfig(dir, { file: { maxMb: 101 } }).ok, false, 'file.maxMb 超过 100 要拒')
  assert.equal(writeConfig(dir, { file: { retentionDays: 0 } }).ok, true, '0 = 不落盘')
  assert.equal(writeConfig(dir, { file: { retentionDays: 91 } }).ok, false, '文件保留天数超过 90 要拒')
  assert.equal(writeConfig(dir, { file: { nope: 1 } }).ok, false, 'file 里未知键要拒')

  console.log('config.test.mjs: all assertions passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
