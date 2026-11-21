/**
 * 登录编排对真实的授权流程：本地 stub 授权服务（authorize 直接带 code 回跳、token 端点按 PKCE 核对校验器），
 * 「浏览器」就是抓地址的 fetch。授权被拒的路径也走一遍。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { browserLogin } from '../src/main/auth/login.mjs'
import { LoopbackDenied } from '../src/main/auth/loopback.mjs'

const DEVICE = { deviceId: '0f2e-1', deviceName: '测试机（Linux）' }

/** stub 授权服务：authorize 记下 challenge 与 redirect_uri 就回跳 code；token 端点按 PKCE 核对。 */
async function startStub({ deny = false } = {}) {
  const calls = { authorize: [], token: [] }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub')
    if (url.pathname === '/oauth/authorize') {
      const params = Object.fromEntries(url.searchParams)
      calls.authorize.push(params)
      const query = deny
        ? `error=access_denied&error_description=${encodeURIComponent('用户拒绝了')}&state=${params.state}`
        : `code=c-${calls.authorize.length}&state=${params.state}`
      response.writeHead(302, { location: `${params.redirect_uri}?${query}` }).end()
      return
    }
    if (url.pathname === '/api/auth/oauth/token') {
      let raw = ''
      request.on('data', chunk => { raw += chunk })
      request.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(raw))
        calls.token.push(form)
        const json = (body) => { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)) }
        if (form.grant_type === 'authorization_code') {
          const expected = createHash('sha256').update(form.code_verifier ?? '').digest('base64url')
          if (form.code !== 'c-1' || form.client_id !== 'knowwork-desktop' ||
              calls.authorize.at(-1)?.code_challenge !== expected) {
            return json({ error: 'invalid_grant', error_description: '校验器对不上' })
          }
          return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' })
        }
        json({ error: 'unsupported_grant_type' })
      })
      return
    }
    response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, calls, close: () => server.close() }
}

test('完整登录：PKCE 校验器被核对，令牌与刷新令牌都拿到', async () => {
  const stub = await startStub()
  try {
    const tokens = await browserLogin({
      server: stub.base,
      browser: async url => { await fetch(url, { redirect: 'manual' }).then(response => fetch(response.headers.get('location'))) },
      device: DEVICE,
    })
    assert.equal(tokens.accessToken, 'at-1')
    assert.equal(tokens.refreshToken, 'rt-1')
    assert.ok(tokens.expiresAt > Date.now())
    const authorize = stub.calls.authorize[0]
    assert.equal(authorize.client_id, 'knowwork-desktop')
    assert.equal(authorize.device_id, DEVICE.deviceId)
    assert.equal(authorize.device_name, DEVICE.deviceName)
    assert.equal(authorize.code_challenge_method, 'S256')
    assert.match(authorize.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/desktop$/)
    assert.equal(stub.calls.token[0].redirect_uri, authorize.redirect_uri)
  } finally {
    stub.close()
  }
})

test('浏览器里拒绝登录：编排把拒绝翻成给人看的错误', async () => {
  const stub = await startStub({ deny: true })
  try {
    await assert.rejects(
      browserLogin({ server: stub.base, browser: async url => { await fetch(url) }, device: DEVICE }),
      error => error instanceof LoopbackDenied && error.error === 'access_denied',
    )
  } finally {
    stub.close()
  }
})
