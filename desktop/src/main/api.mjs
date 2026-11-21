/**
 * 业务服务的设备对话客户端（M2 扩展的 /api/desktop 路由）：桌面主进程是唯一调用方，带原生登录的访问令牌。
 * 令牌由上层给（tokens.access() 的取值函数），401 时抛 NotLoggedIn 让上层走重新登录。
 */

import { NotLoggedIn } from './tokens.mjs'

export function createBusinessApi({ server, accessToken, fetch: httpFetch = fetch } = {}) {
  if (typeof server !== 'string') throw new Error('需要 server（服务地址）')
  const token = typeof accessToken === 'function' ? accessToken : () => accessToken

  async function call(method, path, body, { expect = null } = {}) {
    const authorization = `Bearer ${await token()}`
    const response = await httpFetch(`${server}${path}`, {
      method,
      headers: { authorization, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.status === 401) throw new NotLoggedIn()
    if (expect !== null && response.status !== expect) {
      const detail = await response.json().catch(() => ({}))
      const message = typeof detail?.detail === 'object' ? detail.detail.message : detail?.detail
      const error = new Error(message || `业务服务返回 ${response.status}`)
      error.status = response.status
      error.code = typeof detail?.detail === 'object' ? detail.detail.code : undefined
      error.detail = detail?.detail
      throw error
    }
    if (response.status === 204) return {}
    return response.json().catch(() => ({}))
  }

  const segment = value => encodeURIComponent(value)

  return {
    async createConversation(workspaceId, title) {
      return call('POST', '/api/desktop/conversations', { workspace_id: workspaceId, title }, { expect: 201 })
    },
    async deleteConversation(conversationId) {
      return call('DELETE', `/api/desktop/conversations/${segment(conversationId)}`, undefined, { expect: 204 })
    },
    async sessionBody(conversationId) {
      return call('GET', `/api/desktop/conversations/${segment(conversationId)}/session`)
    },
    async prepareTurn(conversationId, turn) {
      return call('POST', `/api/desktop/conversations/${segment(conversationId)}/prepare-turn`, turn)
    },
    /** 收一批官方会话事件（session 是子 Agent 的会话编号，不给是根会话）；返回已收到的最后一个序号。 */
    async pushEvents(conversationId, events, session) {
      return call('POST', `/api/desktop/conversations/${segment(conversationId)}/events`,
                  session === undefined ? { events } : { events, session })
    },
    async pushLive(conversationId, frames) {
      return call('POST', `/api/desktop/conversations/${segment(conversationId)}/live`, { frames })
    },
    async rememberApproval(conversationId, toolName) {
      return call('POST', `/api/desktop/conversations/${segment(conversationId)}/remember-approval`,
                  { tool_name: toolName })
    },
    async models(conversationId) {
      return call('GET', `/api/desktop/conversations/${segment(conversationId)}/models`)
    },
    async place(conversationId) {
      return call('GET', `/api/desktop/conversations/${segment(conversationId)}/place`)
    },
  }
}
