/**
 * 等人的提示判定：宿主停下来等批准或等回答、窗口又不在前台时，值得叫一下（系统通知 + Mac Dock 跳动）。
 * 只做判定（纯逻辑）；弹什么、怎么跳由 Electron 胶水做。
 */

/** 官方事件里「宿主在等人」的类型：审批待决与向用户提问。 */
export function asksForUser(event) {
  const type = event?.type
  if (type === 'approval/asked') return { kind: 'approval' }
  if (type === 'question/requested') return { kind: 'question' }
  return null
}

/**
 * 中继看到的每一帧都过这里；值得提示且与上次不同（同一批里重复的只叫一次）时给动作。
 * focused 是窗口此刻是否在前方；每次事件都调，由调用方维护前台状态。
 */
export function createNotifier({ isFocused, notify, log = () => {} } = {}) {
  let lastKey = null

  return function onFrame(frame) {
    // 官方事件在根会话的 session/event 帧、子会话经转发帧带来，两种都看
    const events = []
    if (frame.kind === 'session/event' && frame.data !== undefined) events.push(frame.data)
    if (frame.kind === 'subagent/event' && frame.data?.event !== undefined) events.push(frame.data.event)
    for (const event of events) {
      const ask = asksForUser(event)
      if (ask === null) continue
      const key = `${ask.kind}:${event.data?.id ?? event.data?.callId ?? ''}`
      if (isFocused()) continue  // 前台看得见，不叫也不占去重键（走开没处理时会再提醒一次）
      if (key === lastKey) continue
      lastKey = key
      try {
        notify(ask.kind)
      } catch (error) {
        log('提示失败：', error)
      }
    }
  }
}
