/**
 * E1 设备宿主测试：桌面端本机宿主的执行世界与三档访问方式。
 * 用真实 DSH 组合（dsh-base + 通用层 + 设备环境层）加官方模拟模型服务，验证：
 * - 会话开在员工选的工作文件夹里，里面的写入与命令直接执行；
 * - 默认档「工作区内修改」下，工作区外的写入停下来等批准（官方沙箱拒绝、bash 带理由提升），批准才落盘；
 * - 「仅可查看」不写也不问；「完全权限」不再询问直接落盘；
 * - 访问方式的切换按官方 permission/preset 记进会话日志（业务服务看得到）；
 * - 释放后恢复会话，历史与权限档都还在。
 * 断言一律落到实际效果（文件真的在不在、模型请求内容），不只看回合结束。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHost, collectEvents, isTurnEnd, isApprovalAsked, decidedOutcome, pendingApprovals } from './support/harness.mjs'

const DEVICE = { profile: 'knowwork-device-host' }
const sessionEvents = frames => frames.filter(f => f.kind === 'session/event').map(f => f.data)
const messagesText = request => JSON.stringify(request.body?.messages ?? [])
const lastCursor = frames => frames.at(-1)?.cursor ?? 0
const turnEndReason = frames => sessionEvents(frames).find(e => e.type === 'turn/end')?.data?.reason?.kind

/** 工作文件夹：在 /tmp 下（bwrap 的 workspace-write 档里它绑定为唯一可写的工作区）。 */
function freshWorkDir() {
  return mkdtempSync(join(tmpdir(), 'kw-device-work-'))
}

/**
 * 工作文件夹之外的落点：/var/tmp 下（不是 bwrap 的临时 /tmp，宿主根只读，写入要提升；
 * 批准后不隔沙箱落盘，测试进程看得到）。每个用例一个目录，用完删。
 */
function freshOutsideDir() {
  return mkdtempSync('/var/tmp/kw-device-outside-')
}

/** 模拟模型的脚本：每轮先调一次工具（参数固定），轮末给正文；要跑几轮就写几组。一个宿主只编一种工具。 */
const writeCall = (path, content, turns = 1) => ({
  sequence: Array.from({ length: turns }, () => ['tool_call_success', 'success']).flat(),
  toolName: 'write',
  toolArguments: JSON.stringify({ file_path: path, content }),
})
const bashCall = (command, escalate) => ({
  sequence: ['tool_call_success', 'success'],
  toolName: 'bash',
  toolArguments: JSON.stringify(escalate
    ? { description: '写工作文件夹之外的文件', command, sandbox_permissions: 'danger-full-access', justification: '需要写入工作文件夹之外' }
    : { description: '看当前目录', command }),
})

test('默认档「工作区内修改」：工作文件夹里的写入直接执行，不问；命令的工作目录就是它', async () => {
  const work = freshWorkDir()
  const host = await startHost(writeCall(join(work, 'notes.md'), '工作文件夹里的笔记'), {}, DEVICE)
  try {
    assert.equal((await host.call('POST', '/v1/sessions', { sessionId: 'in-work', policy: {}, cwd: work })).status, 201)
    await host.call('POST', '/v1/sessions/in-work/messages', { text: '建一个笔记', model: 'deepseek-chat' })
    const frames = await collectEvents(host, 'in-work', isTurnEnd)
    assert.equal(turnEndReason(frames), 'completed')
    assert.ok(!frames.some(isApprovalAsked), '工作区里的写入不该问')
    assert.equal(readFileSync(join(work, 'notes.md'), 'utf8'), '工作文件夹里的笔记')
  } finally {
    await host.stop()
    rmSync(work, { recursive: true, force: true })
  }

  const workForBash = freshWorkDir()
  const hostForBash = await startHost(bashCall('pwd'), {}, DEVICE)
  try {
    assert.equal((await hostForBash.call('POST', '/v1/sessions', { sessionId: 'in-work-bash', policy: {}, cwd: workForBash })).status, 201)
    await hostForBash.call('POST', '/v1/sessions/in-work-bash/messages', { text: '看下当前目录', model: 'deepseek-chat' })
    const frames = await collectEvents(hostForBash, 'in-work-bash', isTurnEnd)
    assert.equal(turnEndReason(frames), 'completed')
    assert.ok(!frames.some(isApprovalAsked), '工作文件夹里的命令不该问')
    assert.ok(messagesText(hostForBash.llm.requests.at(-1)).includes(workForBash), '命令的工作目录不是工作文件夹')
  } finally {
    await hostForBash.stop()
    rmSync(workForBash, { recursive: true, force: true })
  }
})

test('默认档：工作区外的写入等本人批准——批准落盘，拒绝不落盘', async () => {
  for (const outcome of ['allowed-once', 'rejected']) {
    const outside = freshOutsideDir()
    const target = join(outside, 'escape.txt')
    const host = await startHost(bashCall(`echo 台账行 > ${JSON.stringify(target)}`, true), {}, DEVICE)
    try {
      assert.equal((await host.call('POST', '/v1/sessions', { sessionId: `escape-${outcome}`, policy: {}, cwd: freshWorkDir() })).status, 201)
      await host.call('POST', `/v1/sessions/escape-${outcome}/messages`, { text: '把这份台账写到工作文件夹外面', model: 'deepseek-chat' })
      await collectEvents(host, `escape-${outcome}`, isApprovalAsked)
      const pending = await pendingApprovals(host, `escape-${outcome}`)
      assert.equal(pending.length, 1, `工作区外的写入没有停下来等批准：${JSON.stringify(pending)}`)
      assert.equal((await host.call('POST', `/v1/sessions/escape-${outcome}/approvals/${pending[0].id}`, { outcome })).status, 200)
      const rest = await collectEvents(host, `escape-${outcome}`, isTurnEnd)
      assert.equal(turnEndReason(rest), 'completed')
      assert.equal(decidedOutcome(rest), outcome)
      assert.equal(existsSync(target), outcome === 'allowed-once', `批准与否之后文件落盘状态不对：${target}`)
      if (outcome === 'allowed-once') assert.equal(readFileSync(target, 'utf8').trim(), '台账行')
    } finally {
      await host.stop()
      rmSync(outside, { recursive: true, force: true })
    }
  }
})

test('三档切换：仅可查看不写也不问；完全权限不再询问；切换记进会话日志', async () => {
  const outside = freshOutsideDir()
  const target = join(outside, 'tiers.txt')
  const host = await startHost(writeCall(target, '完全权限下的写入', 2), {}, DEVICE)
  try {
    assert.equal((await host.call('POST', '/v1/sessions', { sessionId: 'tiers', policy: {}, cwd: freshWorkDir() })).status, 201)
    // 档位清单：三档都在，默认工作区内修改
    const catalog = await host.call('GET', '/v1/access')
    assert.equal(catalog.status, 200)
    assert.equal(catalog.body.defaultPreset, 'workspace-modify')
    const names = JSON.stringify(catalog.body.catalog)
    for (const name of ['workspace-modify', 'view-only', 'full-access']) assert.ok(names.includes(name), `档位清单缺 ${name}：${names}`)

    // 仅可查看：审批 never——越权提升一律拒绝不问，写入（这里编的是工作区外的目标）不落盘
    const toView = await host.call('POST', '/v1/sessions/tiers/access', { preset: 'view-only' })
    assert.equal(toView.status, 200)
    assert.equal(toView.body.preset, 'view-only')
    await host.call('POST', '/v1/sessions/tiers/messages', { text: '试试写', model: 'deepseek-chat' })
    const viewFrames = await collectEvents(host, 'tiers', isTurnEnd)
    assert.equal(turnEndReason(viewFrames), 'completed')
    assert.ok(!viewFrames.some(isApprovalAsked), '仅可查看不该问')
    assert.ok(!existsSync(target), '仅可查看下写入不该落盘')

    // 完全权限：不再询问，直接落盘
    const toFull = await host.call('POST', '/v1/sessions/tiers/access', { preset: 'full-access' })
    assert.equal(toFull.body.preset, 'full-access')
    await host.call('POST', '/v1/sessions/tiers/messages', { text: '写到外面', model: 'deepseek-chat' })
    const fullFrames = await collectEvents(host, 'tiers', isTurnEnd, { after: lastCursor(viewFrames) })
    assert.equal(turnEndReason(fullFrames), 'completed')
    assert.ok(!fullFrames.some(isApprovalAsked), '完全权限不该问')
    assert.equal(existsSync(target), true, '完全权限下写入没有落盘')
    assert.equal(readFileSync(target, 'utf8'), '完全权限下的写入')

    // 切换按官方 permission/preset 记进会话日志，业务服务原样收到
    const logged = [...viewFrames, ...fullFrames].filter(f => f.kind === 'session/event' && f.data?.type === 'permission/preset')
    const loggedNames = JSON.stringify(logged.map(f => f.data))
    assert.ok(loggedNames.includes('view-only') && loggedNames.includes('full-access'), `切换没有记进会话日志：${loggedNames}`)
  } finally {
    await host.stop()
    rmSync(outside, { recursive: true, force: true })
  }
})

test('恢复会话：历史与权限档都还在', async () => {
  const host = await startHost({ sequence: ['success'] }, {}, DEVICE)
  const work = freshWorkDir()
  try {
    assert.equal((await host.call('POST', '/v1/sessions', { sessionId: 'resume-access', policy: {}, cwd: work })).status, 201)
    await host.call('POST', '/v1/sessions/resume-access/messages', { text: '第一轮的提问内容', model: 'deepseek-chat' })
    await collectEvents(host, 'resume-access', isTurnEnd)
    assert.equal((await host.call('DELETE', '/v1/sessions/resume-access')).status, 200)
    const resumed = await host.call('POST', '/v1/sessions', { sessionId: 'resume-access', resume: true, policy: {} })
    assert.equal(resumed.status, 201, JSON.stringify(resumed.body))
    assert.equal((await host.call('GET', '/v1/sessions/resume-access/access')).body.preset, 'workspace-modify', '恢复后权限档丢了')
    await host.call('POST', '/v1/sessions/resume-access/messages', { text: '恢复后的提问', model: 'deepseek-chat' })
    await collectEvents(host, 'resume-access', isTurnEnd)
    assert.ok(messagesText(host.llm.requests.at(-1)).includes('第一轮的提问内容'), '恢复后的请求里没有之前的历史')
  } finally {
    await host.stop()
    rmSync(work, { recursive: true, force: true })
  }
})

test('收件入口只给主进程：缺宿主令牌起不来，错令牌一律 401', async () => {
  await assert.rejects(
    startHost({ sequence: ['success'] }, { KNOWWORK_HOST_TOKEN: 'short' }, { ...DEVICE, readyTimeoutMs: 10_000 }),
    /令牌/,
  )
  const host = await startHost({ sequence: ['success'] }, {}, DEVICE)
  try {
    assert.equal((await fetch(`${host.base}/health`)).status, 200)
    const denied = await fetch(`${host.base}/v1/sessions`, { method: 'POST', headers: { authorization: 'Bearer nope-nope-nope-nope-nope-nope' } })
    assert.equal(denied.status, 401)
  } finally {
    await host.stop()
  }
})
