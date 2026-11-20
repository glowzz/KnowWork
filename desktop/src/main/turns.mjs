/**
 * 本机对话的编排：网页版（本机来源）经桥把一轮交到这里——业务服务准备（同一套准备）→ 宿主对齐会话 →
 * 发给本机宿主 → 中继把事件送回业务服务。停止、审批、回答提问、三档访问方式也从这里进。
 *
 * 会话的对齐规矩：宿主会话开着就不动（prepare 的 session 体只在建会话时用）；宿主重启过（sendMessage 报
 * session_not_found）时按开会话的合同以恢复方式重开再发一次。工具/技能的受众令牌每轮都换（短令牌），
 * 开会话随合同带上，已开着就轮换凭据。
 */

export function createConversations({ api, host, relay, tokens, folders, log = () => {} } = {}) {
  /** conversationId → 会话已在宿主上开着（宿主重启后由 ensure 对齐流程重开） */
  const open = new Map()

  function hostClient() {
    const current = host.current?.client
    if (current === undefined) throw new Error('本机宿主没有在运行')
    return current
  }

  async function audienceTokens(conversationId) {
    const [tools, skills] = await Promise.all([
      tokens.forAudience('tools', { conversation_id: conversationId }),
      tokens.forAudience('skills', { conversation_id: conversationId }),
    ])
    return { tools: { token: tools.accessToken }, skills: { token: skills.accessToken } }
  }

  async function syncModels(conversationId, client) {
    try {
      await client.syncModels(await api.models(conversationId))
    } catch (error) {
      log('模型清单同步失败（不拦这一轮）：', error)
    }
  }

  async function send(conversationId, turn) {
    const client = hostClient()
    const prepared = await api.prepareTurn(conversationId, turn)
    if (!open.has(conversationId)) await syncModels(conversationId, client)
    const credentials = await audienceTokens(conversationId)
    try {
      if (!open.has(conversationId)) {
        // 开会话的合同随这一轮来（followup 才带；插话说明会话在跑，壳重启过就拿开会话的合同恢复）。
        // 工作文件夹随合同带上（cwd）：本机宿主按它定会话的工作目录，文件与命令都在里面
        const body = prepared.session ?? await api.sessionBody(conversationId)
        const folder = await folders.get(conversationId)
        if (folder === null) throw new Error('这段对话没有记录工作文件夹，请重新创建本机对话')
        await client.openSession({ ...body, cwd: folder, ...credentials })
        open.set(conversationId, true)
        void relay.start(conversationId, client)
      } else {
        await client.rotateToolCredential(conversationId, credentials.tools.token).catch(() => {})
        await client.rotateSkillCredential(conversationId, credentials.skills.token).catch(() => {})
      }
      relay.get(conversationId)?.setLiveOpen(true)
      await client.sendMessage(conversationId, prepared.turn)
    } catch (error) {
      if (error?.code !== 'session_not_found') throw error
      // 宿主重启过，会话不在了：以恢复方式重开（业务服务说有历史）再发一次
      log('宿主上没有会话 %s，恢复重开后再发', conversationId)
      open.delete(conversationId)
      const folder = await folders.get(conversationId)
      if (folder === null) throw new Error('这段对话没有记录工作文件夹，请重新创建本机对话')
      await client.openSession({ ...await api.sessionBody(conversationId), cwd: folder, ...credentials })
      open.set(conversationId, true)
      void relay.start(conversationId, client)
      relay.get(conversationId)?.setLiveOpen(true)
      await client.sendMessage(conversationId, prepared.turn)
    }
  }

  async function cancel(conversationId) {
    await hostClient().cancel(conversationId)
  }

  /** 批准或拒绝：勾了「本会话内同类操作不再询问」先到业务服务记授权（宿主的审批应答者查到就自动放行）。 */
  async function decide(conversationId, approvalId, allow, remember) {
    const client = hostClient()
    if (remember) {
      try {
        const pending = await client.listApprovals(conversationId)
        const tool = pending.find(item => item.id === approvalId)?.toolName
        if (tool !== undefined) await api.rememberApproval(conversationId, tool)
      } catch (error) {
        log('记授权失败（照常问下次）：', error)
      }
    }
    await client.decideApproval(conversationId, approvalId, allow ? 'allowed-once' : 'rejected')
  }

  async function answer(conversationId, questionId, answers) {
    await hostClient().answerQuestion(conversationId, questionId, answers)
  }

  async function access(conversationId) {
    return hostClient().getAccess(conversationId)
  }

  async function setAccess(conversationId, preset) {
    return hostClient().setAccess(conversationId, preset)
  }

  async function accessCatalog() {
    return hostClient().accessCatalog()
  }

  async function deleteConversation(conversationId) {
    relay.get(conversationId) !== undefined && void relay.stop(conversationId)
    if (open.has(conversationId)) {
      await hostClient().dispose(conversationId).catch(() => {})
      open.delete(conversationId)
    }
    await api.deleteConversation(conversationId)
  }

  /** 宿主重启过：所有会话都要按合同重开（prepare 的下一轮自动带）。 */
  function hostRestarted() {
    open.clear()
  }

  return { send, cancel, decide, answer, access, setAccess, accessCatalog, deleteConversation, hostRestarted,
           isOpen: id => open.has(id) }
}
