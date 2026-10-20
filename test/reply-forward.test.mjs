/**
 * Task 5 · 回信测试（假会话事件 + 假 send，不联网）
 *
 * 钉住：只转发「qq-direct-」开头的 rpcId 触发的回合；跳过带 tool-call 的
 * assistant 消息；一轮只在 turn/end 发一次；Markdown 记号去掉；超长切片。
 */
import assert from 'node:assert/strict'
import { bindReplyForward, chunkText, plainForQq } from '../lib/qq-reply.js'

const SESSION = { header: { id: 'session-1' } }

function makeCtx() {
  let handler = null
  return {
    on(event, cb) {
      assert.equal(event, 'session/event')
      handler = cb
      return () => { handler = null }
    },
    emit(event) { handler(SESSION, event) },
    get handler() { return handler },
  }
}

const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }

// ---------------------------------------------------------------- 基本链路
{
  const ctx = makeCtx()
  const sent = []
  const pending = new Map([['qq-direct-m-1', { openid: 'u-owner', msgId: 'm-1' }]])
  const off = bindReplyForward(ctx, {
    send: async (...args) => { sent.push(args) },
    resolveRequest: (rpcId) => pending.get(rpcId) || null,
    maxChars: () => 900,
  })

  ctx.emit({ type: 'turn/start', data: { turn: 1 } })
  ctx.emit({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'qq-direct-m-1' } } })
  // 工具调用前的碎碎念：不许发
  ctx.emit({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '我先查一下' }, { type: 'tool-call' }] } } })
  // 终稿
  ctx.emit({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '**好了**，结果是 42。' }] } } })
  ctx.emit({ type: 'turn/end', data: { turn: 1 } })
  await flush()

  assert.equal(sent.length, 1, '一轮只发一条')
  assert.deepEqual(sent[0], ['u-owner', '好了，结果是 42。', 'm-1', 1], 'Markdown 星号要去掉')
  off()
  console.log('qq turn -> reply -> OK')
}

// ---------------------------------------------------------------- 不是 QQ 触发的回合
{
  const ctx = makeCtx()
  const sent = []
  bindReplyForward(ctx, {
    send: async (...args) => { sent.push(args) },
    resolveRequest: () => null,
    maxChars: () => 900,
  })
  ctx.emit({ type: 'turn/start', data: { turn: 2 } })
  ctx.emit({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'user-typed-1' } } })
  ctx.emit({ type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '这是手打回合的回复' }] } } })
  ctx.emit({ type: 'turn/end', data: { turn: 2 } })
  await flush()
  assert.equal(sent.length, 0, '手打回合不许发到 QQ')
  console.log('typed turn -> no send -> OK')
}

// ---------------------------------------------------------------- 超长切片
{
  const ctx = makeCtx()
  const sent = []
  bindReplyForward(ctx, {
    send: async (...args) => { sent.push(args) },
    resolveRequest: () => ({ openid: 'u-owner', msgId: 'm-2' }),
    maxChars: () => 100,
  })
  const long = '第一段。'.repeat(30) + '\n' + '第二段。'.repeat(30)
  ctx.emit({ type: 'turn/start', data: { turn: 3 } })
  ctx.emit({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'qq-direct-m-2' } } })
  ctx.emit({ type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: long }] } } })
  ctx.emit({ type: 'turn/end', data: { turn: 3 } })
  await flush()
  assert.ok(sent.length > 1, '超长要切片')
  assert.deepEqual(sent.map((item) => item[3]), sent.map((_, index) => index + 1), 'msg_seq 要递增')
  for (const item of sent) assert.ok(item[1].length <= 100, '每片不超过上限')
  console.log('long reply chunked ->', sent.length, 'parts')
}

// ---------------------------------------------------------------- 纯函数
{
  assert.equal(chunkText('abc', 10).length, 1)
  assert.deepEqual(chunkText('', 10), [])
  const parts = chunkText('a'.repeat(250), 100, 2)
  assert.equal(parts.length, 2)
  assert.match(parts[1], /还有没发完/)
  assert.equal(plainForQq('**粗** `代码`\n## 标题\n正文'), '粗 代码\n标题\n正文')
  console.log('chunk / plain helpers -> OK')
}

console.log('reply-forward.test.mjs: all assertions passed')
