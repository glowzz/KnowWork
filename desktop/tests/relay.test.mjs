/** 事件回传的中继：分类（根/子会话/逐字/状态）、成批与去抖、轮末停逐字、断流重连续传。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRelay } from '../src/main/relay.mjs'

const frame = (cursor, kind, data) => ({ kind, cursor, time: cursor, data })
const event = (seq, type = 'assistant/message') => ({ type, seq, time: seq, data: {} })

/** stub 宿主：事件流按脚本吐帧（可中途断流重连、帧间停顿可关）；记录 after 参数。 */
function stubHost({ frames, cutAfterFrame = null, pace = 2 } = {}) {
  const requests = []
  let connections = 0
  const client = {
    // 与真宿主客户端同形：同步返回 {done, close}，done 是流的 Promise
    streamEvents(sessionId, { after, onFrame }) {
      requests.push(after)
      connections += 1
      const mine = connections
      const controller = new AbortController()
      const done = (async () => {
        const slice = cutAfterFrame === null || mine <= 1 ? frames : frames.slice(cutAfterFrame)
        for (const item of slice) {
          if (controller.signal.aborted) return { closed: true }
          if (typeof item === 'number') {
            await new Promise(resolve => setTimeout(resolve, item))  // 停顿（测断流）
            continue
          }
          if (pace > 0) await new Promise(resolve => setTimeout(resolve, pace))  // 帧间让出：编排来得及置 liveOpen
          onFrame(item)
        }
        await new Promise((resolve, reject) => setTimeout(() => reject(new Error('流断了')), 30))
      })()
      return { done, close: () => controller.abort() }
    },
  }
  return { client, requests }
}

function stubApi() {
  const pushes = []
  const lives = []
  return {
    pushes, lives,
    async pushEvents(conversationId, events, session) {
      pushes.push({ conversationId, events, session: session ?? null })
      const last = events.at(-1)
      return { seq: last?.seq ?? 0 }
    },
    async pushLive(conversationId, frames) {
      lives.push({ conversationId, frames })
    },
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('分类回传：根会话成批、子会话带编号、状态帧忽略、逐字只在轮次进行中转发', async () => {
  const api = stubApi()
  const relay = createRelay({ api })
  const host = stubHost({
    frames: [
      frame(1, 'agent/status', { status: 'running' }),                       // 忽略
      frame(2, 'session/event', event(1, 'turn/start')),
      frame(3, 'assistant/stream', { kind: 'assistant/stream', data: {} }),  // 轮次没开：不转发
      frame(4, 'subagent/event', { sessionId: 'child-1', event: event(1, 'tool/call') }),
    ],
  })
  const handle = await relay.start('c_1', host.client)
  await sleep(300)
  await relay.stop('c_1')
  assert.ok(api.pushes.some(p => p.session === null && p.events.some(e => e.type === 'turn/start')),
            '根会话事件要回传')
  assert.ok(api.pushes.some(p => p.session === 'child-1' && p.events[0].type === 'tool/call'),
            '子会话事件带编号回传')
  assert.equal(api.lives.length, 0, '轮次进行中才有逐字')
  // 开着逐字再补一轮
  const api2 = stubApi()
  const relay2 = createRelay({ api: api2 })
  const handle2 = await relay2.start('c_1', host.client)
  handle2.setLiveOpen(true)
  await sleep(250)
  await relay2.stop('c_1')
  assert.ok(api2.lives.length >= 1, '轮次进行中逐字要转发')
  // 编排拿到的是同一份 handle（turns.mjs 经 relay.get 置逐字开关）
  assert.equal(relay2.get('c_1'), undefined, 'stop 之后取不到')
  const handle3 = await relay2.start('c_2', host.client)
  assert.equal(relay2.get('c_2'), handle3)
  await relay2.stop('c_2')
})

test('去抖成批：150ms 内的事件合成一批，一批最多 500 条', async () => {
  const api = stubApi()
  const relay = createRelay({ api })
  const many = Array.from({ length: 3 }, (_, index) => frame(index + 1, 'session/event', event(index + 1)))
  const host = stubHost({ frames: many })
  const handle = await relay.start('c_1', host.client)
  await sleep(250)
  await relay.stop('c_1')
  assert.equal(api.pushes.length, 1, '去抖后三帧并一批')
  assert.equal(api.pushes[0].events.length, 3)
  void host

  const api500 = stubApi()
  const relay500 = createRelay({ api: api500 })
  const frames500 = Array.from({ length: 600 }, (_, index) => frame(index + 1, 'session/event', event(index + 1)))
  await relay500.start('c_1', stubHost({ frames: frames500, pace: 0 }).client)
  await sleep(300)
  await relay500.stop('c_1')
  assert.equal(api500.pushes[0].events.length, 500, '满 500 立即冲刷')
  assert.ok(api500.pushes.at(-1).events.length >= 100)
})

test('断流重连：从头重放（业务服务按序号去重），after 从 0 开始', async () => {
  const api = stubApi()
  const relay = createRelay({ api, backoffMs: 30 })
  const host = stubHost({
    frames: [
      frame(1, 'session/event', event(1)),
      frame(2, 'session/event', event(2)),
      60,  // 停顿让第一轮流超时断开
      frame(3, 'session/event', event(3)),
    ],
    cutAfterFrame: 2,  // 第二连接起只给新事件（测 after=0 重放的业务去重靠服务端，这里看请求参数）
  })
  const handle = await relay.start('c_1', host.client)
  await sleep(400)
  await relay.stop('c_1')
  const relayed = createRelay({ api: stubApi(), backoffMs: 30 })
  void relayed
  assert.ok(host.requests.length >= 2, '断过一次流')
  assert.equal(host.requests[0], 0)
  assert.equal(host.requests[1], 0, '重连从头重放，业务服务按序号去重')
  assert.ok(api.pushes.at(-1).events.some(e => e.seq === 3), '新事件照常回传')
})
