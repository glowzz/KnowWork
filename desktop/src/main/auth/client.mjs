/**
 * 授权服务的令牌端点客户端（/api/auth/oauth/token）：授权码换令牌、刷新令牌、RFC 8693 按受众换。
 * 表单提交；出错照 RFC 6749 5.2 是 {error, error_description}，翻成 OAuthTokenError。
 * 纯 fetch：登录编排、令牌续期与测试直接用。
 */

export class OAuthTokenError extends Error {
  constructor(error, description) {
    super(description || error)
    this.error = error
  }
}

export function authorizeUrl(server, params) {
  const url = new URL('/api/auth/oauth/authorize', serverOrigin(server))
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

async function tokenRequest(server, form) {
  const response = await fetch(new URL('/api/auth/oauth/token', serverOrigin(server)), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.error) {
    throw new OAuthTokenError(body.error ?? `http_${response.status}`, body.error_description)
  }
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new OAuthTokenError('invalid_response', '授权服务没有返回访问令牌')
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined,
    expiresAt: Date.now() + Number(body.expires_in ?? 0) * 1000,
  }
}

export async function exchangeCode(server, { code, verifier, redirectUri }) {
  return tokenRequest(server, {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  })
}

export async function refresh(server, { refreshToken }) {
  return tokenRequest(server, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  })
}

/** RFC 8693：受众由业务服务与扩展登记（model、tools、skills、desktop-session），额外参数原样带上（如 conversation_id）。 */
export async function tokenExchange(server, { accessToken, audience, params = {} }) {
  return tokenRequest(server, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    client_id: CLIENT_ID,
    subject_token: accessToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    audience,
    ...params,
  })
}

export const CLIENT_ID = 'knowwork-desktop'

function serverOrigin(server) {
  const origin = parseServer(server)
  if (origin === null) throw new Error(`服务地址不对：${server}`)
  return origin
}

/** 服务地址只认 http(s) 的源（不带路径）：来自深链或手工输入，都过这里。 */
export function parseServer(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}
