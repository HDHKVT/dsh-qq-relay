/**
 * 连发多图的合并（`lib/batch.js`）。用假定时器，不碰真等待。
 */
import assert from 'node:assert/strict'
import { createImageBatcher } from '../lib/batch.js'

function fakeTimers() {
  let next = 1
  const pending = new Map()
  return {
    timers: {
      setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id },
      clearTimeout: (id) => { pending.delete(id) },
    },
    fire() { const all = [...pending.values()]; pending.clear(); for (const item of all) item.fn() },
    get size() { return pending.size },
  }
}

const imageEvent = (id, url) => ({
  type: 'C2C_MESSAGE_CREATE',
  openid: 'u-owner',
  msgId: id,
  text: '',
  attachments: [{ content_type: 'image/png', url }],
  msgElements: [],
})

// 1. 纯图消息：攒着，定时器到了合成一条
{
  const f = fakeTimers()
  const batches = []
  const batcher = createImageBatcher({ windowMs: 800, max: 4, onBatch: (e) => batches.push(e), timers: f.timers })
  assert.equal(batcher.offer(imageEvent('m1', 'http://x/1.png')), true)
  assert.equal(batcher.offer(imageEvent('m2', 'http://x/2.png')), true)
  assert.equal(batches.length, 0, '没到时间不该投')
  f.fire()
  assert.equal(batches.length, 1)
  assert.equal(batches[0].text, '（发来 2 张图）')
  assert.equal(batches[0].attachments.length, 2)
  assert.equal(batches[0].msgId, 'm1', '用第一条的 msgId 去重')
  batcher.dispose()
}

// 2. 带字的消息不进批次
{
  const f = fakeTimers()
  const batcher = createImageBatcher({ windowMs: 800, onBatch: () => assert.fail('不该合并'), timers: f.timers })
  assert.equal(batcher.offer({ ...imageEvent('m1', 'http://x/1.png'), text: '看这个' }), false)
  assert.equal(batcher.offer({ type: 'C2C_MESSAGE_CREATE', openid: 'u', msgId: 'm2', text: '', attachments: [] }), false)
  // 📎 纯文件消息也不该被当成“图”攒起来
  assert.equal(batcher.offer({
    type: 'C2C_MESSAGE_CREATE', openid: 'u', msgId: 'm3', text: '',
    attachments: [{ content_type: 'file/pdf', url: 'http://x/a.pdf' }], msgElements: [],
  }), false)
  batcher.dispose()
}

// 3. 攒够 max 张立刻 flush
{
  const f = fakeTimers()
  const batches = []
  const batcher = createImageBatcher({ windowMs: 800, max: 3, onBatch: (e) => batches.push(e), timers: f.timers })
  batcher.offer(imageEvent('a', 'http://x/a.png'))
  batcher.offer(imageEvent('b', 'http://x/b.png'))
  assert.equal(batches.length, 0)
  batcher.offer(imageEvent('c', 'http://x/c.png'))
  assert.equal(batches.length, 1, '到上限要立刻合并')
  assert.equal(batches[0].attachments.length, 3)
  batcher.dispose()
}

// 4. windowMs = 0 或函数返回 0 ⇒ 关闭合并
{
  const f = fakeTimers()
  const batcher = createImageBatcher({ windowMs: () => 0, onBatch: () => assert.fail('关闭时不该合并'), timers: f.timers })
  assert.equal(batcher.offer(imageEvent('m1', 'http://x/1.png')), false)
  batcher.dispose()
}

// 5. dispose 之后不残留定时器
{
  const f = fakeTimers()
  const batcher = createImageBatcher({ windowMs: 800, onBatch: () => assert.fail('dispose 后不该再发'), timers: f.timers })
  batcher.offer(imageEvent('m1', 'http://x/1.png'))
  assert.equal(f.size, 1)
  batcher.dispose()
  assert.equal(f.size, 0, 'dispose 要清掉定时器')
}

// 6. 超过 4 张也不许提前切（2026-10-18 真机：6 张被切成 4+2）
{
  const f = fakeTimers()
  const batches = []
  const batcher = createImageBatcher({ windowMs: 800, onBatch: (e) => batches.push(e), timers: f.timers })
  for (let i = 0; i < 6; i += 1) batcher.offer(imageEvent(`m${i}`, `http://x/${i}.png`))
  assert.equal(batches.length, 0, '6 张不该在 4 张时就被切走')
  f.fire()
  assert.equal(batches.length, 1)
  assert.equal(batches[0].attachments.length, 6)
  assert.equal(batches[0].text, '（发来 6 张图）')
  batcher.dispose()
}

console.log('batch.test.mjs: all assertions passed')
