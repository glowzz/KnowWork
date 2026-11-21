/**
 * 事件回传的中继：消费宿主根会话的事件流（子 Agent 的事件已被 knowwork 插件转发到根会话上），
 * 按帧分类回传业务服务——
 * - `session/event`：官方会话事件，原样成批送 push（一批最多 500；序号在批内从小到大，重传业务服务按序号跳过）；
 * - `subagent/event`：子会话事件，带子会话编号送 push（业务服务收成 subagent/event 帧）；
 * - `assistant/stream`：逐字片段，正在跑一轮时才转发（push_live 只推给正在看的页面，不落库）；
 * - `agent/status`：不回传（运行状态由官方事件推导）。
 *
 * 续传：宿主的事件流从 after=0 重放也安全——官方序号在业务服务那边去重（重传跳过）。逐字片段只在
 * 轮次进行中转发，重放不会刷屏。turn/end 之后回传停止转发逐字片段（turnLive 由编排置位）。
 */

const MAX_BATCH = 500

export function createRelay({ api, backoffMs = 1000, onFrame: onEveryFrame = null, log = () => {} } = {}) {
  /** conversationId → { streaming, close, liveOpen } */
  const relays = new Map()

  async function start(conversationId, client, { onFrame = null } = {}) {
    if (relays.has(conversationId)) return relays.get(conversationId)
    const state = { liveOpen: false, closed: false }
    const streams = new Map()

    // 逐会话的待批：根会话与各子会话各自的批，序号都在批内从小到大；
    // 满 500 立即冲刷，其余去抖 150ms（事件不能在批里干等，网页版等着渲染）
    const batches = new Map()
    const timers = new Map()
    const flush = async session => {
      const batch = batches.get(session)
      if (batch === undefined || batch.events.length === 0) return
      batches.delete(session)
      const timer = timers.get(session)
      if (timer !== undefined) {
        clearTimeout(timer)
        timers.delete(session)
      }
      try {
        await api.pushEvents(conversationId, batch.events, session === '' ? undefined : session)
      } catch (error) {
        log('回传事件失败（会话 %s，%d 条）：', conversationId, batch.events.length, error)
      }
    }
    const addEvent = async (session, event) => {
      const key = session ?? ''
      const batch = batches.get(key) ?? { events: [] }
      batch.events.push(event)
      batches.set(key, batch)
      if (batch.events.length >= MAX_BATCH) return flush(key)
      if (!timers.has(key)) {
        timers.set(key, setTimeout(() => void flush(key), 150))
        timers.get(key).unref?.()
      }
    }

    const handle = {
      setLiveOpen(value) {
        state.liveOpen = value
      },
      async stop() {
        state.closed = true
        streams.get(conversationId)?.close()  // 主动断开当前流，不等它自己断
        streams.delete(conversationId)
        relays.delete(conversationId)
      },
    }
    relays.set(conversationId, handle)

    void (async () => {
      let after = 0
      while (!state.closed) {
        try {
          const stream = client.streamEvents(conversationId, {
            after,
            onFrame: frame => {
              if (typeof frame.cursor === 'number' && frame.cursor >= after) after = frame.cursor + 1
              onEveryFrame?.(frame, state)
              onFrame?.(frame, state)
              if (frame.kind === 'session/event') {
                if (frame.data?.type === 'turn/end') state.liveOpen = false
                void addEvent('', frame.data)
              } else if (frame.kind === 'subagent/event') {
                void addEvent(frame.data?.sessionId, frame.data?.event)
              } else if (frame.kind === 'assistant/stream' && state.liveOpen) {
                void api.pushLive(conversationId, [frame]).catch(error => log('回传逐字失败：', error))
              }
              // agent/status：不回传（运行状态由官方事件推导）
            },
          })
          streams.set(conversationId, stream)
          await stream.done
          streams.delete(conversationId)
          if (state.closed) break
          log('宿主事件流断开，1 秒后续传')
          await new Promise(resolve => setTimeout(resolve, backoffMs))
        } catch (error) {
          streams.delete(conversationId)
          if (state.closed) break
          log('宿主事件流出错，1 秒后从头续传（业务服务按序号去重）：', error)
          after = 0  // 宿主重启过（epoch 变了）：从头重放，业务服务去重
          await new Promise(resolve => setTimeout(resolve, backoffMs))
        }
      }
      for (const key of [...batches.keys(), ...timers.keys()]) await flush(key)
    })()

    return handle
  }

  return {
    start,
    get(conversationId) {
      return relays.get(conversationId)
    },
    async stop(conversationId) {
      await relays.get(conversationId)?.stop()
    },
    isRunning(conversationId) {
      return relays.has(conversationId)
    },
  }
}
