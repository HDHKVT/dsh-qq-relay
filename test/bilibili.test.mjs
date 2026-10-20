/**
 * B 站下载模块的纯逻辑（不联网）：
 *  - wbi 签名 / 文件名 / 链接嗅探
 *  - resolveShare 的 BV 直连分支（不发请求）
 */
import assert from 'node:assert/strict'
import { mixinKeyOf, encodeWbi, safeFileName, findBiliLink, resolveShare, hostnameOf, decideAudioOnly } from '../lib/bilibili.js'

// 1. mixinKey：固定 orig → 固定 32 位
{
  const orig = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const key = mixinKeyOf(orig)
  assert.equal(key.length, 32)
  assert.equal(key, mixinKeyOf(orig), '同一 orig 必须得到同一 key')
  assert.notEqual(key, mixinKeyOf(orig.split('').reverse().join('')), '换 orig 应该变')
  console.log('mixinKeyOf -> OK')
}

// 2. wbi 签名：稳定、含 w_rid、按 key 排序、过滤特殊字符
{
  const key = '0123456789abcdef0123456789abcdef'
  const q = encodeWbi({ bvid: 'BV1xx411c7mD', cid: 123, fnval: 1 }, key, 1700000000)
  assert.match(q, /^bvid=BV1xx411c7mD&cid=123&fnval=1&wts=1700000000&w_rid=[0-9a-f]{32}$/)
  assert.equal(q, encodeWbi({ cid: 123, fnval: 1, bvid: 'BV1xx411c7mD' }, key, 1700000000), '参数顺序不影响结果')
  const dirty = encodeWbi({ q: "a'b(c)d*e" }, key, 1)
  assert.match(dirty, /q=abcde/, "!'()* 必须被过滤")
  console.log('encodeWbi -> OK')
}

// 3. 文件名安全化
{
  assert.equal(safeFileName('标题/带:非法*字符?', 'BV1xx411c7mD'), 'bili-BV1xx411c7mD-标题 带 非法 字符.mp4')
  assert.equal(safeFileName('多P', 'BV1xx411c7mD', 3), 'bili-BV1xx411c7mD-P3-多P.mp4')
  assert.equal(safeFileName('', 'BV1xx411c7mD'), 'bili-BV1xx411c7mD-video.mp4')
  console.log('safeFileName -> OK')
}

// 4. 链接嗅探
{
  assert.equal(findBiliLink('看这个 https://www.bilibili.com/video/BV1GJ411x7h7 好笑'), 'BV1GJ411x7h7')
  assert.equal(findBiliLink('【标题】 https://b23.tv/abc123'), 'https://b23.tv/abc123')
  assert.equal(findBiliLink('没有链接'), '')
  console.log('findBiliLink -> OK')
}

// 5. resolveShare 直连分支（纯文本，不发网络）
{
  assert.deepEqual(await resolveShare('https://www.bilibili.com/video/BV1GJ411x7h7?p=2'), { bvid: 'BV1GJ411x7h7', page: 2 })
  assert.deepEqual(await resolveShare('就是 BV1GJ411x7h7 这个'), { bvid: 'BV1GJ411x7h7', page: 1 })
  await assert.rejects(() => resolveShare('完全没有链接'), /没找到/)
  console.log('resolveShare (direct) -> OK')
}

// 6. 日志里只留主机名
{
  const host = hostnameOf('https://upos-sz-mirrorcos.bilivideo.com/x/y?token=secret')
  assert.equal(host, 'upos-sz-mirrorcos.bilivideo.com')
  assert.equal(host.includes('token'), false, '主机名里不能带签名参数')
  console.log('hostnameOf -> OK')
}

// 7. 音频分诊
{
  assert.equal(decideAudioOnly({ tid: 193, title: '某 MV' }, 'auto'), true, 'MV 分区应该只下音频')
  assert.equal(decideAudioOnly({ tid: 3, title: '纯音乐' }, 'auto'), true)
  assert.equal(decideAudioOnly({ tid: 228, title: '名将风云61' }, 'auto'), false, '纪录片必须下视频')
  assert.equal(decideAudioOnly({ tid: 201, title: '知识区' }, 'auto'), false)
  assert.equal(decideAudioOnly({ tid: 3, title: '历史纪录片解说' }, 'auto'), false, '标题命中排除词要下视频')
  assert.equal(decideAudioOnly({ tid: 228, title: '播客电台' }, 'auto'), true, '标题命中音频词也可以')
  assert.equal(decideAudioOnly({ tid: 228, title: '随便' }, 'true'), true, '强制音频')
  assert.equal(decideAudioOnly({ tid: 3, title: 'MV' }, 'false'), false, '强制视频')
  console.log('decideAudioOnly -> OK')
}

console.log('bilibili.test.mjs: all assertions passed')
