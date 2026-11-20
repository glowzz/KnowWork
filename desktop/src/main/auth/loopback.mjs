/**
 * 登录的回环监听（RFC 8252 7.3）：临时起在 127.0.0.1 的随机端口上，系统浏览器批完授权带着 code 回来，
 * 这里收下并答一个给用户看的页面。路径与扩展登记的回调路径一致（/oauth/desktop），主机必须回环、端口随缘。
 * 纯 node:http：登录编排与测试直接用。
 */

import { createServer } from 'node:http'

export const REDIRECT_PATH = '/oauth/desktop'

const OK_PAGE = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>KnowWork 桌面端</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>已连接</h1><p>回到 KnowWork 桌面端继续，这个页面可以关掉了。</p></div>
<script>setTimeout(() => window.close(), 1200)</script></body></html>`

const DENIED_PAGE = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>KnowWork 桌面端</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>没有完成登录</h1><p>回到 KnowWork 桌面端再试一次，这个页面可以关掉了。</p></div></body></html>`

export class LoopbackDenied extends Error {
  constructor(error, description) {
    super(description || error)
    this.error = error
  }
}

/**
 * 起监听并等授权码。expectedState 必须与回调里带回的 state 一致（授权请求与回调配对，防串线）。
 * done 在收到合法回调时兑现 {code}；用户在浏览器点了拒绝、state 对不上或超时则拒绝。
 */
export async function startLoopback({ expectedState, timeoutMs = 5 * 60_000 } = {}) {
  if (typeof expectedState !== 'string' || expectedState.length === 0) throw new Error('需要 expectedState')
  let settled = false
  let settle = () => {}
  const done = new Promise((resolve, reject) => { settle = { resolve, reject } })
  // 编排要等浏览器回来才 await done，而拒绝可能更早发生（用户当场点拒绝、超时）：先兜住，
  // 免得 Node 把「暂无人处理的拒绝」当未捕获异常退进程；await done 的调用方照常拿到错误。
  done.catch(() => {})
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== REDIRECT_PATH) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    const fail = (error, description) => {
      response.end(DENIED_PAGE)
      finish(() => settle.reject(new LoopbackDenied(error, description)))
    }
    if (url.searchParams.get('error')) return fail(url.searchParams.get('error'), url.searchParams.get('error_description'))
    if (url.searchParams.get('state') !== expectedState) return fail('state_mismatch', '回调与请求对不上（state）')
    const code = url.searchParams.get('code')
    if (!code) return fail('invalid_request', '回调里没有授权码')
    response.end(OK_PAGE)
    finish(() => settle.resolve({ code }))
  })
  const timeout = setTimeout(() => finish(() => settle.reject(new Error('登录超时，请重试'))), timeoutMs)
  timeout.unref?.()

  function finish(run) {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    server.close()
    run()
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return { port, redirectUri: `http://127.0.0.1:${port}${REDIRECT_PATH}`, done, close: () => finish(() => {}) }
}
