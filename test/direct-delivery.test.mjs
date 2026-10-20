/**
 * Task 4 · 投递判定测试（纯函数，不起宿主、不联网）
 *
 * 每一条都对应“安全顺序”里的一步：群聊 / 没配 owner / 别人 / 空消息 /
 * 没锁会话 / 重复 msgId；最后一条是快乐路径（带 hint、requestId 前缀）。
 */
import assert from 'node:assert/strict'
import { decideDelivery, makeDeduper, REASON_TEXT, deliverEvent, bindPrompt, stripFaces } from '../lib/delivery.js'

const owner = 'u-owner'
const base = {
  type: 'C2C_MESSAGE_CREATE',
  openid: owner,
  text: '在吗',
  msgId: 'm-1',
}

const decide = (over) => decideDelivery({ event: { ...base, ...over.event }, ownerId: 'ownerId' in over ? over.ownerId : owner, sessionId: 'sessionId' in over ? over.sessionId : 'session-1', hint: over.hint, maxChars: 900, deduper: over.deduper })

// 1. 群聊
assert.deepEqual(decide({ event: { type: 'GROUP_AT_MESSAGE_CREATE' } }), { deliver: false, reason: 'group-unsupported' })

// 2. 没配 owner
assert.deepEqual(decide({ ownerId: '' }), { deliver: false, reason: 'owner-unset' })

// 3. 别人
assert.deepEqual(decide({ event: { openid: 'someone-else' } }), { deliver: false, reason: 'not-owner' })

// 4. 空消息 / 只有附件
assert.deepEqual(decide({ event: { text: '   ' } }), { deliver: false, reason: 'empty' })

// 5. 没锁会话
assert.deepEqual(decide({ sessionId: null }), { deliver: false, reason: 'no-session' })

// 6. 重复 msgId
const deduper = makeDeduper(2)
deduper.add('m-1')
assert.deepEqual(decide({ deduper }), { deliver: false, reason: 'duplicate' })

// 7. 快乐路径：带 hint、requestId 前缀
const ok = decide({ deduper: makeDeduper() })
assert.equal(ok.deliver, true)
assert.equal(ok.requestId, 'qq-direct-m-1')
assert.match(ok.text, /^（来自 QQ/)
assert.match(ok.text, /900 字内/)
assert.match(ok.text, /表情包：正常/, '默认带上「正常」的频率约束')
assert.match(ok.text, /在吗$/)

// 7b. 表情包频率会随消息送到会话里（给我当约束读）
{
  const rare = decideDelivery({ event: { ...base }, ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900, stickerFrequency: 'rare' })
  assert.match(rare.text, /表情包：偶尔/, '偶尔要写明')
  const off = decideDelivery({ event: { ...base }, ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900, stickerFrequency: 'off' })
  assert.match(off.text, /表情包：关/, '关掉要写明')
  console.log('sticker frequency hint -> OK')
}

// 8. 关掉 hint ⇒ 正文逐字不变
const plain = decide({ hint: false })
assert.equal(plain.text, '在吗')

// 9. 去重集合有上限（不无限涨）
const bounded = makeDeduper(3)
for (const id of ['a', 'b', 'c', 'd']) bounded.add(id)
assert.equal(bounded.has('a'), false, '超过上限的老 id 应当被挤掉')
assert.equal(bounded.size, 3)

// 10. 每个原因都有给人看的一句话
for (const reason of ['group-unsupported', 'owner-unset', 'not-owner', 'empty', 'no-session', 'duplicate']) {
  assert.equal(typeof REASON_TEXT[reason], 'string', `${reason} 缺文案`)
}

// ---------------------------------------------------------------- deliverEvent
// 11. 主人私聊 ⇒ 真投一次；同 msgId 重推 ⇒ 不再投
{
  const calls = []
  const deduper = makeDeduper(10)
  const config = { ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900 }
  const prompt = async (request) => { calls.push(request); return { accepted: true } }

  const first = await deliverEvent({ event: { ...base }, config, deduper, prompt })
  assert.equal(first.delivered, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(
    { requestId: calls[0].requestId, sessionId: calls[0].sessionId, mode: calls[0].mode, type: calls[0].content[0].type },
    { requestId: 'qq-direct-m-1', sessionId: 'session-1', mode: 'queue', type: 'text' },
  )

  const again = await deliverEvent({ event: { ...base }, config, deduper, prompt })
  assert.deepEqual(again, { delivered: false, reason: 'duplicate' }, '同一 msgId 只投一次')
  assert.equal(calls.length, 1)
}

// 12. 非主人 / 群聊 ⇒ 一次都不调 prompt
{
  const calls = []
  const config = { ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900 }
  const prompt = async (request) => { calls.push(request); return { accepted: true } }
  await deliverEvent({ event: { ...base, openid: 'stranger' }, config, deduper: makeDeduper(), prompt })
  await deliverEvent({ event: { ...base, type: 'GROUP_AT_MESSAGE_CREATE' }, config, deduper: makeDeduper(), prompt })
  assert.equal(calls.length, 0)
}

// 13. prompt 抛错 ⇒ 不标已读，错误带回去（下一条还能重试）
{
  const deduper = makeDeduper()
  const config = { ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900 }
  const out = await deliverEvent({
    event: { ...base },
    config,
    deduper,
    prompt: async () => { throw new Error('session gone') },
  })
  assert.equal(out.delivered, false)
  assert.match(out.error, /session gone/)
  assert.equal(deduper.has('m-1'), false, '失败不能标记成已投')
}

// 14. 没有 prompt（会话服务没就绪）⇒ 明确返回 no-prompt
{
  const out = await deliverEvent({
    event: { ...base },
    config: { ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900 },
    deduper: makeDeduper(),
    prompt: undefined,
  })
  assert.deepEqual(out, { delivered: false, reason: 'no-prompt' })
}

// 15. bindPrompt：信号必须真的传下去 —— 2026-10-17 真机 bug 的回归钉
//     宿主实现会无条件读 `signal.throwIfAborted()`；不传 signal 就抛
//     `Cannot read properties of undefined (reading 'throwIfAborted')`。
{
  const controller = new AbortController()
  const hostLike = {
    async prompt(request, signal) {
      signal.throwIfAborted()      // 宿主真的这么干
      return { accepted: true }
    },
  }
  const bound = bindPrompt(hostLike, controller.signal)
  assert.equal(typeof bound, 'function')
  const result = await bound({ requestId: 'x', sessionId: 's', mode: 'queue', content: [] })
  assert.deepEqual(result, { accepted: true })

  // 反证：不绑信号就会炸（证明这条测试真的能抓到那个错误）
  await assert.rejects(() => hostLike.prompt({ requestId: 'x' }), /throwIfAborted/)

  assert.equal(bindPrompt(null, controller.signal), undefined)
  assert.equal(bindPrompt({}, controller.signal), undefined)
}

// 16. 带图投递：content = [文字块, 图片块]，文字块在前
{
  const calls = []
  const config = { ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900 }
  // 16a. 只有图、没有字：必须投递（2026-10-18 真机 bug：曾经被判成 empty 丢掉）
  const imageOnly = await deliverEvent({
    event: { ...base, text: '', attachments: [{ content_type: 'image/png', url: 'https://x/a.png' }] },
    config,
    deduper: makeDeduper(),
    prompt: async (request) => { calls.push(request); return { accepted: true } },
    prepareImage: async () => ({ image: { mediaType: 'image/png', data: 'AAAA' } }),
  })
  assert.equal(imageOnly.delivered, true, '只有图没有字也是合法消息')
  assert.match(calls[0].content[0].text, /（发来一张图）/, '正文要有占位说明')
  assert.equal(calls[0].content[1].type, 'image')
  calls.length = 0

  const out = await deliverEvent({
    event: { ...base, attachments: [{ content_type: 'image/png', url: 'https://x/a.png' }] },
    config,
    deduper: makeDeduper(),
    prompt: async (request) => { calls.push(request); return { accepted: true } },
    prepareImage: async () => ({ image: { mediaType: 'image/png', data: 'AAAA' } }),
  })
  assert.equal(out.delivered, true)
  assert.equal(calls[0].content.length, 2)
  assert.equal(calls[0].content[0].type, 'text')
  assert.deepEqual(calls[0].content[1], { type: 'image', mediaType: 'image/png', data: 'AAAA' })
  console.log('image block -> OK')
}

// 17. 图处理失败：文字照发 + 正文注明原因
{
  const calls = []
  const out = await deliverEvent({
    event: { ...base },
    config: { ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900 },
    deduper: makeDeduper(),
    prompt: async (request) => { calls.push(request); return { accepted: true } },
    prepareImage: async () => ({ error: '图太大（上限 12MB）' }),
  })
  assert.equal(out.delivered, true, '图失败不影响文字投递')
  assert.equal(calls[0].content.length, 1, '没有图片块')
  assert.match(calls[0].content[0].text, /图没进来：图太大/)
  console.log('image failure note -> OK')
}

// 18. 动图拼图的说明要出现在正文里
{
  const calls = []
  await deliverEvent({
    event: { ...base },
    config: { ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900 },
    deduper: makeDeduper(),
    prompt: async (request) => { calls.push(request); return { accepted: true } },
    prepareImage: async () => ({ image: { mediaType: 'image/png', data: 'BBBB' }, note: '动图：取了 3 帧拼成一张' }),
  })
  assert.match(calls[0].content[0].text, /动图：取了 3 帧拼成一张/)
  console.log('gif note -> OK')
}

// 19. prepareImage 自己抛错：不能把整条消息炸掉
{
  const calls = []
  const out = await deliverEvent({
    event: { ...base },
    config: { ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900 },
    deduper: makeDeduper(),
    prompt: async (request) => { calls.push(request); return { accepted: true } },
    prepareImage: async () => { throw new Error('boom') },
  })
  assert.equal(out.delivered, true)
  assert.match(calls[0].content[0].text, /处理图片时抛错/)
  console.log('prepareImage throw -> OK')
}

// 20. QQ 表情标记要被换成可读标签；纯表情消息也投
{
  const stripped = stripFaces('好的哦<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">')
  assert.equal(stripped.text, '好的哦（表情：微笑）', '认识的 id 要写名字')
  assert.equal(stripped.hadFace, true)
  assert.equal(stripFaces('a<b 这种正文不动').text, 'a<b 这种正文不动', '不能误伤普通尖括号')
  assert.equal(stripFaces('<faceType=1,faceId="999">').text, '（表情 #999）', '不认识的 id 只写编号，不猜名字')

  const calls = []
  const out = await deliverEvent({
    event: { ...base, text: '<faceType=6,faceId="0",ext="x">' },
    config: { ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900 },
    deduper: makeDeduper(),
    prompt: async (request) => { calls.push(request); return { accepted: true } },
  })
  assert.equal(out.delivered, true, '纯表情消息不该被当空消息丢掉')
  assert.match(calls[0].content[0].text, /（表情：微笑）/)
  assert.ok(!calls[0].content[0].text.includes('faceType'), '正文里不许留标记')
  console.log('qq face strip -> OK')
}

// 21. 多图：prepareImage 回 images 数组 ⇒ 每个都成一个图片块
{
  const calls = []
  await deliverEvent({
    event: { ...base, text: '看这两张' },
    config: { ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900 },
    deduper: makeDeduper(),
    prompt: async (request) => { calls.push(request); return { accepted: true } },
    prepareImage: async () => ({
      images: [
        { mediaType: 'image/png', data: 'AAA' },
        { mediaType: 'image/png', data: 'BBB' },
      ],
      note: '共 2 张图',
    }),
  })
  assert.equal(calls[0].content.length, 3, '文字 + 两张图')
  assert.equal(calls[0].content[1].data, 'AAA')
  assert.equal(calls[0].content[2].data, 'BBB')
  assert.match(calls[0].content[0].text, /共 2 张图/)
  console.log('multi-image blocks -> OK')
}

// 22. 纯文件消息：不再被当空消息丢掉；文件只出说明、不进内容块
{
  const calls = []
  const out = await deliverEvent({
    event: {
      ...base,
      text: '',
      attachments: [{ content_type: 'file/pdf', url: 'http://x/a.pdf', filename: '报告.pdf' }],
    },
    config: { ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900 },
    deduper: makeDeduper(),
    prompt: async (request) => { calls.push(request); return { accepted: true } },
    prepareFile: async () => ({ note: '发来文件：报告.pdf（12KB，已存到 D:/x/files/a.pdf）' }),
  })
  assert.equal(out.delivered, true, '纯文件消息必须投递')
  assert.match(calls[0].content[0].text, /发来文件：报告\.pdf/)
  assert.equal(calls[0].content.length, 1, '文件不是图片块')
  console.log('file-only delivery -> OK')
}

// 23. 文件失败：文字照发 + 注明
{
  const calls = []
  await deliverEvent({
    event: { ...base, text: '帮我看这个', attachments: [{ content_type: 'file/zip', url: 'http://x/a.zip' }] },
    config: { ownerId: owner, sessionId: 'session-1', hint: true, maxChars: 900 },
    deduper: makeDeduper(),
    prompt: async (request) => { calls.push(request); return { accepted: true } },
    prepareFile: async () => ({ error: '文件太大（上限 20MB）' }),
  })
  assert.match(calls[0].content[0].text, /文件没进来：文件太大/)
  console.log('file failure note -> OK')
}

console.log('direct-delivery.test.mjs: all assertions passed')
