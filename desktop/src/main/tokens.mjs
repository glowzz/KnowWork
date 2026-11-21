/**
 * 令牌的存取与续期：原生登录的访问/刷新令牌存 store（壳里是 safeStorage 加密文件，测试里是内存/明文），
 * 快过期先刷新；要哪个受众（model、tools、skills、desktop-session）拿原生令牌现换一个短期的。
 * now 注入便于测试过期；client 参数是 auth/client.mjs（或同形状的替身）。
 */

const EXPIRY_MARGIN_MS = 60_000

export function createTokens({ server, client, store, now = Date.now }) {
  if (typeof store?.load !== 'function' || typeof store?.save !== 'function' || typeof store?.clear !== 'function') {
    throw new Error('需要 store（load/save/clear）')
  }
  let cached = null

  async function live() {
    if (cached === null) cached = await store.load()
    if (cached === null) throw new NotLoggedIn()
    if (cached.expiresAt - now() > EXPIRY_MARGIN_MS) return cached
    if (typeof cached.refreshToken !== 'string' || cached.refreshToken.length === 0) {
      await clear()
      throw new NotLoggedIn()
    }
    const refreshed = await client.refresh(server, { refreshToken: cached.refreshToken })
    return await save(refreshed)
  }

  async function save(tokens) {
    cached = tokens
    await store.save(tokens)
    return tokens
  }

  async function clear() {
    cached = null
    await store.clear()
  }

  return {
    /** 有活的令牌就返回（快过期先刷新）；没登录过或刷新被拒（吊销）抛 NotLoggedIn 并清掉存的。 */
    async access() {
      try {
        return await live()
      } catch (error) {
        if (error instanceof client.OAuthTokenError) {
          // 刷新令牌被吊销或过期：回到重新登录
          await clear()
          throw new NotLoggedIn()
        }
        throw error
      }
    },
    async set(tokens) {
      return save(tokens)
    },
    /** 按受众换短期令牌：额外参数原样带上（tools/skills 要 conversation_id，model 不带）。 */
    async forAudience(audience, params = {}) {
      const current = await this.access()
      return client.tokenExchange(server, { accessToken: current.accessToken, audience, params })
    },
    async clear() {
      await clear()
    },
    async loaded() {
      if (cached === null) cached = await store.load()
      return cached !== null
    },
  }
}

export class NotLoggedIn extends Error {
  constructor() {
    super('还没有登录，或登录已失效')
  }
}
