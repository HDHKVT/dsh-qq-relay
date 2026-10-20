/**
 * Task 3 · 连接层测试（假 WebSocket / 假 fetch / 假定时器，无网络）
 *
 * 钉住与 Rust 引擎对齐的那几步：
 *   Hello(op 10) → identify(op 2, token 前缀 `QQBot `)
 *   心跳(op 1) 带 lastSeq
 *   READY → 状态 ready
 *   C2C / 群 @ 事件 → 交给 onEvent（**这一层不做主人过滤**，那是 Task 4）
 *   致命关闭码 4013 → 停止，并把原因说清楚
 */
import assert from 'node:assert/strict'
import { createDirect, fetchAccessToken, fetchGatewayUrl } from '../lib/qq-direct.js'

const CONFIG = { appId: 'app-1', appSecret: 'secret-1', ownerId: 'owner-1', intents: 33554432 }

function makeFakes() {
  const sockets = []
  const logs = []
  const intervals = []
  let fetchCalls = 0
  class FakeSocket {
    constructor(url) {
      this.url = url
      this.sent = []
      this.closed = false
      sockets.push(this)
    }
    send(data) { this.sent.push(JSON.parse(data)) }
    close() { this.closed = true }
    push(frame) { this.onmessage({ data: JSON.stringify(frame) }) }
  }
  const fetchImpl = async (url, init) => {
    fetchCalls += 1
    if (url.includes('getAppAccessToken')) {
      assert.deepEqual(JSON.parse(init.body), { appId: 'app-1', clientSecret: 'secret-1' })
      return { status: 200, json: async () => ({ access_token: 'tok-1', expires_in: 7200 }) }
    }
    if (url.includes('/gateway')) {
      assert.equal(init.headers.Authorization, 'QQBot tok-1')
      return { status: 200, json: async () => ({ url: 'wss://fake.qq/websocket/' }) }
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  const timers = {
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
    clearInterval: () => {},
    setTimeout: (fn, ms) => ({ fn, ms }),
    clearTimeout: () => {},
  }
  return { FakeSocket, fetchImpl, timers, sockets, logs, intervals, fetchCalls: () => fetchCalls }
}

// ---------------------------------------------------------------- 连接 + 鉴权
{
  const fakes = makeFakes()
  const events = []
  const direct = createDirect({
    config: CONFIG,
    onEvent: (event) => events.push(event),
    log: (line) => fakes.logs.push(line),
    WebSocketImpl: fakes.FakeSocket,
    fetchImpl: fakes.fetchImpl,
    timers: fakes.timers,
    now: () => 1_000_000,
  })
  await direct.start()
  assert.equal(fakes.fetchCalls(), 2, '先换 token、再取网关地址')
  assert.equal(fakes.sockets.length, 1)
  assert.equal(fakes.sockets[0].url, 'wss://fake.qq/websocket/')

  const ws = fakes.sockets[0]
  ws.push({ op: 10, d: { heartbeat_interval: 30000 } })
  const identify = ws.sent.find((frame) => frame.op === 2)
  assert.ok(identify, '收到 Hello 必须发 identify')
  assert.equal(identify.d.token, 'QQBot tok-1', 'token 前缀必须是 QQBot ')
  assert.equal(identify.d.intents, CONFIG.intents)
  assert.deepEqual(identify.d.shard, [0, 1])
  assert.equal(direct.state().phase, 'identifying')
  assert.ok(fakes.intervals.length === 1 && fakes.intervals[0].ms === 30000, '要按 Hello 给的间隔装心跳')

  // 心跳带 lastSeq
  ws.push({ op: 0, t: 'READY', s: 1, d: { user: { username: 'bot' } } })
  assert.equal(direct.state().phase, 'ready')
  fakes.intervals[0].fn()
  const beat = ws.sent.filter((frame) => frame.op === 1).at(-1)
  assert.equal(beat.d, 1, '心跳要带上最后一次 seq')

  // 私聊消息
  ws.push({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'm-1', content: ' 你好 ', author: { user_openid: 'u-1' } } })
  assert.equal(events.length, 1)
  assert.deepEqual(
    { type: events[0].type, openid: events[0].openid, text: events[0].text, msgId: events[0].msgId },
    { type: 'C2C_MESSAGE_CREATE', openid: 'u-1', text: '你好', msgId: 'm-1' },
  )

  // 群 @ 消息也要能被认出来（Task 4 负责拒绝它）
  ws.push({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 3, d: { id: 'g-1', content: '在吗', group_openid: 'grp-1', author: { member_openid: 'u-2' } } })
  assert.equal(events.length, 2)
  assert.equal(events[1].type, 'GROUP_AT_MESSAGE_CREATE')
  assert.equal(events[1].text, '在吗')

  direct.stop()
  assert.equal(ws.closed, true, 'stop() 要关 socket')
  assert.equal(direct.state().phase, 'closed')
  console.log('connect/identify/heartbeat/dispatch -> OK')
}

// ---------------------------------------------------------------- 致命关闭码
{
  const fakes = makeFakes()
  const direct = createDirect({
    config: CONFIG,
    onEvent: () => {},
    log: (line) => fakes.logs.push(line),
    WebSocketImpl: fakes.FakeSocket,
    fetchImpl: fakes.fetchImpl,
    timers: fakes.timers,
    now: () => 1_000_000,
  })
  await direct.start()
  fakes.sockets[0].onclose({ code: 4014 })
  assert.equal(direct.state().phase, 'closed', '4014 是致命的，不许重连')
  assert.match(direct.state().lastError, /4014/)
  assert.match(direct.state().lastError, /接收所有消息/, '提示要告诉人去后台开哪个开关')
  console.log('fatal close code -> OK')
}

// ---------------------------------------------------------------- 缺凭据
{
  const fakes = makeFakes()
  const direct = createDirect({
    config: { appId: '', appSecret: '', ownerId: '', intents: 33554432 },
    onEvent: () => {},
    log: (line) => fakes.logs.push(line),
    WebSocketImpl: fakes.FakeSocket,
    fetchImpl: fakes.fetchImpl,
    timers: fakes.timers,
    now: () => 1_000_000,
  })
  await direct.start()
  assert.equal(fakes.sockets.length, 0, '没凭据不许连')
  assert.match(direct.state().lastError, /缺 appId/)
  console.log('missing credentials -> OK')
}

// ---------------------------------------------------------------- token 失败要说清楚
{
  const fetchImpl = async () => ({ status: 401, json: async () => ({ code: 100016, message: 'invalid appid' }) })
  await assert.rejects(
    () => fetchAccessToken({ appId: 'x', appSecret: 'y', fetchImpl }),
    /invalid appid/,
    'token 失败要把对端原文带出来',
  )
  console.log('token failure surfaces upstream message -> OK')
}

console.log('direct-receive.test.mjs: all assertions passed')
