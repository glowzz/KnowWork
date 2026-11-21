/** 本机对话的编排：首轮开会话并带上受众令牌、已开就轮换凭据、宿主丢会话后恢复重发、
 * 审批的「不再询问」先记授权、删除要解绑停中继。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConversations } from '../src/main/turns.mjs'

function stubApi({ sessionBody = { sessionId: 'c_1', resume: false, policy: {} } } = {}) {
  const calls = []
  return {
    calls,
    async prepareTurn(conversationId, turn) {
      calls.push(['prepare', conversationId, turn])
      return { session: sessionBody, turn: { ...turn, id: 'm1' } }
    },
    async sessionBody(conversationId) {
      calls.push(['session-body', conversationId])
      return { ...sessionBody, resume: true }
    },
    async models() {
      calls.push(['models'])
      return { models: [{ id: 'default', name: '默认' }] }
    },
    async rememberApproval(conversationId, toolName) {
      calls.push(['remember', conversationId, toolName])
      return true
    },
    async deleteConversation(conversationId) {
      calls.push(['delete', conversationId])
    },
  }
}

function stubTokens() {
  const exchanges = []
  return {
    exchanges,
    async forAudience(audience, params) {
      exchanges.push([audience, params])
      return { accessToken: `tok-${audience}`, expiresAt: 0 }
    },
  }
}

function stubRelay() {
  const calls = []
  const handles = new Map()
  return {
    calls,
    async start(conversationId) {
      calls.push(['relay-start', conversationId])
      const handle = { setLiveOpen: v => calls.push(['live', v]), stop: async () => calls.push(['relay-stop', conversationId]) }
      handles.set(conversationId, handle)
      return handle
    },
    get(conversationId) {
      return handles.get(conversationId)
    },
    async stop(conversationId) {
      calls.push(['relay-stop', conversationId])
    },
  }
}

function stubHost() {
  const calls = []
  let failSessionOnce = false
  const client = {
      async openSession(body) {
        calls.push(['open', body])
        if (failSessionOnce && calls.filter(c => c[0] === 'open').length === 1) {
          throw Object.assign(new Error('宿主上没有会话'), { code: 'session_not_found' })
        }
        return { sessionId: body.sessionId, status: 'idle' }
      },
      async sendMessage(sessionId, turn) {
        calls.push(['send', sessionId, turn.id ?? turn.text])
        return { messageId: 'm1', mode: 'followup' }
      },
      async rotateToolCredential(sessionId, token) { calls.push(['rotate-tools', sessionId, token]) },
      async rotateSkillCredential(sessionId, token) { calls.push(['rotate-skills', sessionId, token]) },
      async syncModels(body) { calls.push(['sync-models', body.models.length]) },
      async listApprovals(sessionId) {
        calls.push(['approvals', sessionId])
        return [{ id: 'ap1', toolName: 'bash' }, { id: 'ap2', toolName: 'write' }]
      },
      async decideApproval(sessionId, approvalId, outcome) {
        calls.push(['decide', sessionId, approvalId, outcome])
        return { decided: true }
      },
      async answerQuestion(sessionId, questionId, answers) {
        calls.push(['answer', sessionId, questionId, answers])
        return { answered: true }
      },
      async getAccess(sessionId) { calls.push(['access', sessionId]); return { sessionId, preset: 'workspace-modify' } },
      async setAccess(sessionId, preset) { calls.push(['set-access', sessionId, preset]); return { sessionId, preset } },
      async accessCatalog() { return { defaultPreset: 'workspace-modify', catalog: {} } },
      async dispose(sessionId) { calls.push(['dispose', sessionId]) },
    }
    return {
      calls,
      setFailSessionOnce() { failSessionOnce = true },
      current: { client },
    }
}

function makeWorld({ api, host, tokens, relay, folders } = {}) {
  const world = {
    api: api ?? stubApi(),
    tokens: tokens ?? stubTokens(),
    relay: relay ?? stubRelay(),
    host: host ?? stubHost(),
    folders: folders ?? stubFolders(),
  }
  world.conversations = createConversations({ api: world.api, host: world.host, relay: world.relay,
                                              tokens: world.tokens, folders: world.folders })
  return world
}

function stubFolders({ missing = false } = {}) {
  const calls = []
  return {
    calls,
    async get(conversationId) {
      calls.push(['get', conversationId])
      return missing ? null : '/Users/lei/工作 文件夹'
    },
  }
}

test('首轮：同步模型清单、带受众令牌开会话、启动中继、发这一轮', async () => {
  const world = makeWorld()
  await world.conversations.send('c_1', { text: '算一下完成率', mode: 'followup' })
  const order = world.host.calls.map(c => c[0])
  assert.deepEqual(order, ['sync-models', 'open', 'send'])
  const open = world.host.calls.find(c => c[0] === 'open')[1]
  assert.equal(open.sessionId, 'c_1')
  assert.equal(open.cwd, '/Users/lei/工作 文件夹', '会话的工作目录就是工作文件夹')
  assert.equal(open.tools.token, 'tok-tools')
  assert.equal(open.skills.token, 'tok-skills')
  assert.equal(open.resume, false)
  assert.deepEqual(world.tokens.exchanges, [['tools', { conversation_id: 'c_1' }], ['skills', { conversation_id: 'c_1' }]])
  assert.ok(world.relay.calls.some(c => c[0] === 'relay-start' && c[1] === 'c_1'))
})

test('已开着：轮换凭据、不再开会话、不再同步清单', async () => {
  const world = makeWorld()
  await world.conversations.send('c_1', { text: '第一轮', mode: 'followup' })
  await world.conversations.send('c_1', { text: '第二轮', mode: 'followup' })
  const order = world.host.calls.map(c => c[0])
  assert.deepEqual(order, ['sync-models', 'open', 'send', 'rotate-tools', 'rotate-skills', 'send'])
})

test('宿主丢了会话：按恢复合同重开再发一次', async () => {
  const world = makeWorld()
  world.host.setFailSessionOnce()
  await world.conversations.send('c_1', { text: '第一轮', mode: 'followup' })
  await world.conversations.send('c_1', { text: '第二轮', mode: 'followup' })
  const calls = world.host.calls
  assert.ok(calls.some(c => c[0] === 'open' && c[1].resume === true), '恢复方式重开')
  const sends = calls.filter(c => c[0] === 'send')
  assert.equal(sends.length, 2, '第二轮发出去了')
})

test('没有记录工作文件夹：发不出去并给说法', async () => {
  const world = makeWorld({ folders: stubFolders({ missing: true }) })
  await assert.rejects(
    world.conversations.send('c_1', { text: '第一轮', mode: 'followup' }),
    /没有记录工作文件夹/,
  )
})

test('审批：勾了不再询问先记授权（按待答项找工具名），再交宿主', async () => {
  const world = makeWorld()
  await world.conversations.decide('c_1', 'ap1', true, true)
  assert.deepEqual(world.api.calls.find(c => c[0] === 'remember'), ['remember', 'c_1', 'bash'])
  assert.deepEqual(world.host.calls.find(c => c[0] === 'decide'), ['decide', 'c_1', 'ap1', 'allowed-once'])
  await world.conversations.decide('c_1', 'ap2', false, false)
  assert.equal(world.api.calls.filter(c => c[0] === 'remember').length, 1, '没勾不记')
  assert.deepEqual(world.host.calls.at(-1), ['decide', 'c_1', 'ap2', 'rejected'])
})

test('三档访问方式：查与切', async () => {
  const world = makeWorld()
  await world.conversations.setAccess('c_1', 'view-only')
  assert.deepEqual(world.host.calls.at(-1), ['set-access', 'c_1', 'view-only'])
  await world.conversations.access('c_1')
  assert.deepEqual(world.host.calls.at(-1), ['access', 'c_1'])
})

test('删除：停中继、释放宿主会话、解绑', async () => {
  const world = makeWorld()
  await world.conversations.send('c_1', { text: '第一轮', mode: 'followup' })
  await world.conversations.deleteConversation('c_1')
  const relayCalls = world.relay.calls.filter(c => c[0] === 'relay-stop')
  assert.equal(relayCalls.length, 1)
  assert.ok(world.host.calls.some(c => c[0] === 'dispose'))
  assert.ok(world.api.calls.some(c => c[0] === 'delete' && c[1] === 'c_1'))
})
