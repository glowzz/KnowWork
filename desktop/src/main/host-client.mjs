/**
 * 本机宿主的 HTTP 客户端（设备宿主 device-host.mjs 暴露的接口，与服务端 http-host 同一套）。
 * base/token 来自宿主进程的就绪行与装配时的令牌；fetch 注入便于测试。令牌过期由上层经 rotateModel 续。
 */

export class HostApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function createHostClient({ base, token, fetch: httpFetch = fetch } = {}) {
  if (typeof base !== 'string' || typeof token !== 'string' || token.length < 32) {
    throw new Error('宿主客户端需要 base 与至少 32 个字符的令牌')
  }

  async function call(method, path, body) {
    const response = await httpFetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new HostApiError(response.status, json?.error?.code ?? `http_${response.status}`,
                             json?.error?.message ?? '宿主接口出错')
    }
    return json
  }

  const segment = value => encodeURIComponent(value)

  return {
    async health() {
      return call('GET', '/health')
    },
    /** 开/恢复会话：合同体原样交（policy/tools/skills/owner 由上层并进去）。已开着时宿主 409 session_busy。 */
    async openSession(body) {
      return call('POST', '/v1/sessions', body)
    },
    async sendMessage(sessionId, turn) {
      return call('POST', `/v1/sessions/${segment(sessionId)}/messages`, turn)
    },
    async cancel(sessionId) {
      return call('POST', `/v1/sessions/${segment(sessionId)}/cancel`)
    },
    async dispose(sessionId) {
      return call('DELETE', `/v1/sessions/${segment(sessionId)}`)
    },
    /** 事件流（NDJSON）：onFrame 按行收 {kind, data, cursor}；返回关闭函数（断开订阅）。 */
    streamEvents(sessionId, { after = 0, epoch, onFrame, signal } = {}) {
      const query = new URLSearchParams({ after: String(after) })
      if (epoch) query.set('epoch', epoch)
      const controller = new AbortController()
      signal?.addEventListener('abort', () => controller.abort(), { once: true })
      const running = httpFetch(`${base}/v1/sessions/${segment(sessionId)}/events?${query}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      }).then(async response => {
        if (!response.ok || !response.body) {
          const body = await response.json().catch(() => ({}))
          throw new HostApiError(response.status, body?.error?.code ?? `http_${response.status}`,
                                 body?.error?.message ?? '宿主事件流出错')
        }
        const decoder = new TextDecoder()
        let buffer = ''
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true })
          let index
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim()
            buffer = buffer.slice(index + 1)
            if (line.length === 0) continue  // 心跳
            onFrame(JSON.parse(line))
          }
        }
        return { closed: true }
      })
      return { done: running, close: () => controller.abort() }
    },
    async listApprovals(sessionId) {
      return call('GET', `/v1/sessions/${segment(sessionId)}/approvals`)
    },
    async decideApproval(sessionId, approvalId, outcome) {
      return call('POST', `/v1/sessions/${segment(sessionId)}/approvals/${segment(approvalId)}`, { outcome })
    },
    async listQuestions(sessionId) {
      return call('GET', `/v1/sessions/${segment(sessionId)}/questions`)
    },
    async answerQuestion(sessionId, questionId, answers) {
      return call('POST', `/v1/sessions/${segment(sessionId)}/questions/${segment(questionId)}`, { answers })
    },
    /** 访问方式（三档）：查当前、按预设名切换（permission/preset 会话事件随事件流回业务服务）。 */
    async accessCatalog() {
      return call('GET', '/v1/access')
    },
    async getAccess(sessionId) {
      return call('GET', `/v1/sessions/${segment(sessionId)}/access`)
    },
    async setAccess(sessionId, preset) {
      return call('POST', `/v1/sessions/${segment(sessionId)}/access`, { preset })
    },
    /** 模型网关短期令牌轮换（写进官方凭据服务，下一次模型请求生效）。 */
    async rotateModelCredential(token) {
      return call('PUT', '/v1/model-credential', { token })
    },
    async rotateToolCredential(sessionId, token) {
      return call('PUT', `/v1/sessions/${segment(sessionId)}/tool-credential`, { token })
    },
    async rotateSkillCredential(sessionId, token) {
      return call('PUT', `/v1/sessions/${segment(sessionId)}/skill-credential`, { token })
    },
    async syncModels(body) {
      return call('PUT', '/v1/models', body)
    },
  }
}
