/**
 * 登录编排：PKCE + 回环监听 + 系统浏览器授权 + 换令牌。browser 是开浏览器的那一步（壳里 shell.openExternal，
 * 测试里是抓地址的替身）；device 是这次登录报的固定设备号（扩展据此绑定对话）。
 */

import { randomBytes } from 'node:crypto'
import { CLIENT_ID, authorizeUrl, exchangeCode } from './client.mjs'
import { startLoopback } from './loopback.mjs'
import { createPkce } from './pkce.mjs'

export async function browserLogin({ server, browser, device, timeoutMs = 5 * 60_000 }) {
  if (typeof browser !== 'function') throw new Error('需要 browser（打开系统浏览器的那一步）')
  if (typeof device?.deviceId !== 'string' || device.deviceId.length === 0) throw new Error('需要 device.deviceId')
  const pkce = createPkce()
  const state = randomBytes(16).toString('base64url')
  const listener = await startLoopback({ expectedState: state, timeoutMs })
  try {
    const url = authorizeUrl(server, {
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: listener.redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method,
      state,
      device_id: device.deviceId,
      device_name: device.deviceName ?? '',
    })
    await browser(url)
    const { code } = await listener.done
    return await exchangeCode(server, { code, verifier: pkce.verifier, redirectUri: listener.redirectUri })
  } finally {
    listener.close()
  }
}
