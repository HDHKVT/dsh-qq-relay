/**
 * bili-subtitle.test.mjs —— 字幕取用的**失败分类**测试（不联网）
 *
 * 测的重点不是「能不能拿到字幕」，而是「拿不到的时候，能不能分清原因」：
 * 风控拦截和「真没字幕」如果都返回同一句话，上层会把每条视频都当无语音跳过，
 * 报告看着正常、实际什么都没看。这是这个模块存在的主要理由。
 */
import assert from 'node:assert/strict'
import { fetchSubtitle } from '../lib/bili-subtitle.js'

const NAV = {
  code: 0,
  data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/aaa.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/bbb.png' } },
}

/** 造一个假 fetch：按 URL 分流，不联网。 */
function makeFetch({ playerResponse, subtitlePayload }) {
  return async (url) => {
    if (String(url).includes('/x/web-interface/nav')) return { ok: true, json: async () => NAV }
    if (String(url).includes('/x/player/wbi/v2')) return { ok: true, json: async () => playerResponse }
    return { ok: true, json: async () => subtitlePayload }
  }
}

// 1. 没配 cookie：必须说清楚是「没权限」，不能算没字幕
{
  const result = await fetchSubtitle({ aid: 1, cid: 2, cookie: '' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no-cookie')
  console.log('✓ 1 没 cookie → code=no-cookie')
}

// 2. 风控拦截：-412 必须被认出来，并且带上原始码
{
  const fetchImpl = makeFetch({ playerResponse: { code: -412, message: '请求过于频繁' } })
  const result = await fetchSubtitle({ aid: 1, cid: 2, cookie: 'SESSDATA=x', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'blocked')
  assert.equal(result.apiCode, -412)
  assert.match(result.why, /风控/)
  console.log('✓ 2 接口 -412 → code=blocked、apiCode=-412')
}

// 3. 请求成功但确实没有字幕轨
{
  const fetchImpl = makeFetch({ playerResponse: { code: 0, data: { subtitle: { subtitles: [] } } } })
  const result = await fetchSubtitle({ aid: 1, cid: 2, cookie: 'SESSDATA=x', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no-track')
  console.log('✓ 3 请求成功但没字幕轨 → code=no-track（与 blocked 明确区分）')
}

// 4. 正常路径：列表有中文轨 → 下载 → 返回 body
{
  const fetchImpl = makeFetch({
    playerResponse: {
      code: 0,
      data: { subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/x.json' }] } },
    },
    subtitlePayload: { body: [{ from: 0, to: 1, content: '你好' }] },
  })
  const result = await fetchSubtitle({ aid: 1, cid: 2, cookie: 'SESSDATA=x', fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.lan, 'ai-zh')
  assert.equal(result.payload.body.length, 1)
  assert.ok(result.url.startsWith('https://'))
  console.log('✓ 4 正常：选中中文轨、相对地址补成 https、body 原样带回')
}

// 5. 非风控的接口报错（比如 -400）：算 bad-shape，不许冒充 blocked
{
  const fetchImpl = makeFetch({ playerResponse: { code: -400, message: '参数错误' } })
  const result = await fetchSubtitle({ aid: 1, cid: 2, cookie: 'SESSDATA=x', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad-shape')
  assert.equal(result.apiCode, -400)
  console.log('✓ 5 非风控错误码 → code=bad-shape，不冒充 blocked')
}

console.log('\n共 5 项，失败 0 项')
