/** 回环监听：收授权码、核对 state、拒绝时带错误、超时与关停。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LoopbackDenied, startLoopback } from '../src/main/auth/loopback.mjs'

test('收到授权码并答一个可关掉的页面', async () => {
  const listener = await startLoopback({ expectedState: 'st1' })
  try {
    const response = await fetch(`${listener.redirectUri}?code=c1&state=st1`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /已连接/)
    assert.equal((await listener.done).code, 'c1')
    assert.match(listener.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/desktop$/)
  } finally {
    listener.close()
  }
})

test('浏览器里点了拒绝：LoopbackDenied 带错误码', async () => {
  const listener = await startLoopback({ expectedState: 'st1' })
  const pending = listener.done.catch(error => error)
  await fetch(`${listener.redirectUri}?error=access_denied&state=st1`)
  const error = await pending
  assert.ok(error instanceof LoopbackDenied)
  assert.equal(error.error, 'access_denied')
})

test('state 对不上：拒绝（防串线）', async () => {
  const listener = await startLoopback({ expectedState: 'st1' })
  const pending = listener.done.catch(error => error)
  const response = await fetch(`${listener.redirectUri}?code=c1&state=wrong`)
  assert.match(await response.text(), /没有完成登录/)
  const error = await pending
  assert.ok(error instanceof LoopbackDenied && error.error === 'state_mismatch')
})

test('别的路径 404；close 之后端口释放', async () => {
  const listener = await startLoopback({ expectedState: 'st1' })
  const base = listener.redirectUri.replace(/\/oauth\/desktop$/, '')
  assert.equal((await fetch(`${base}/nothing`)).status, 404)
  listener.close()
  await assert.rejects(fetch(`${base}/oauth/desktop`))
})
