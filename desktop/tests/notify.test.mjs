/** 等人的提示判定：等审批/等回答且窗口不在前台才叫，同一项不重复叫。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotifier } from '../src/main/notify.mjs'

const frame = (kind, data) => ({ kind, cursor: 1, time: 1, data })

function make() {
  const calls = []
  let focused = false
  const notifier = createNotifier({
    isFocused: () => focused,
    notify: kind => calls.push(kind),
  })
  return { calls, notifier, setFocused: value => { focused = value } }
}

test('等审批且窗口不在前台：叫一次', () => {
  const { calls, notifier } = make()
  notifier(frame('session/event', { type: 'approval/asked', data: { id: 'ap1' } }))
  assert.deepEqual(calls, ['approval'])
})

test('等回答：也叫', () => {
  const { calls, notifier } = make()
  notifier(frame('session/event', { type: 'question/requested', data: { callId: 'q1' } }))
  assert.deepEqual(calls, ['question'])
})

test('同一项只叫一次；前台不叫；回到前台再问新的叫新的', () => {
  const { calls, notifier, setFocused } = make()
  notifier(frame('session/event', { type: 'approval/asked', data: { id: 'ap1' } }))
  notifier(frame('session/event', { type: 'approval/asked', data: { id: 'ap1' } }))  // 重传的同一条
  assert.deepEqual(calls, ['approval'])
  setFocused(true)
  notifier(frame('session/event', { type: 'approval/asked', data: { id: 'ap2' } }))
  assert.deepEqual(calls, ['approval'], '在前台不叫')
  setFocused(false)
  notifier(frame('session/event', { type: 'approval/asked', data: { id: 'ap2' } }))
  assert.deepEqual(calls, ['approval', 'approval'], '新的一项再叫')
})

test('子会话经转发帧带来的等审批也算', () => {
  const { calls, notifier } = make()
  notifier(frame('subagent/event', { sessionId: 'child-1', event: { type: 'approval/asked', data: { id: 'ap9' } } }))
  assert.deepEqual(calls, ['approval'])
})

test('别的帧不叫', () => {
  const { calls, notifier } = make()
  notifier(frame('session/event', { type: 'turn/start', data: {} }))
  notifier(frame('agent/status', { status: 'running' }))
  assert.deepEqual(calls, [])
})
