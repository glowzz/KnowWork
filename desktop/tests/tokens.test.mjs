/**
 * 令牌存取：没登录抛 NotLoggedIn；快过期自动刷新，刷新被拒清空回登录；按受众换令牌把参数与当前
 * 访问令牌原样带上；加密文件存储的往返（含无加密环境的明文回退）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotLoggedIn, createTokens } from '../src/main/tokens.mjs'
import { createEncryptedStore } from '../src/main/secure-store.mjs'
import { OAuthTokenError } from '../src/main/auth/client.mjs'

function stubClient({ refreshFails = false } = {}) {
  const calls = { refresh: [], exchange: [] }
  const client = {
    OAuthTokenError,
    async refresh(server, { refreshToken }) {
      calls.refresh.push(refreshToken)
      if (refreshFails) throw new OAuthTokenError('invalid_grant', '刷新令牌已吊销')
      return { accessToken: `at-${calls.refresh.length + 1}`, refreshToken: `rt-${calls.refresh.length + 1}`, expiresAt: 0 }
    },
    async tokenExchange(server, request) {
      calls.exchange.push(request)
      return { accessToken: `aud-${request.audience}-${calls.exchange.length}`, expiresAt: 0 }
    },
  }
  return { client, calls }
}

function memoryStore() {
  let saved = null
  return {
    async load() { return saved },
    async save(tokens) { saved = tokens },
    async clear() { saved = null },
  }
}

test('没登录过：access 抛 NotLoggedIn', async () => {
  const { client } = stubClient()
  const tokens = createTokens({ server: 'https://kw', client, store: memoryStore() })
  await assert.rejects(tokens.access(), NotLoggedIn)
})

test('快过期先刷新；刷新被吊销清空存储回登录', async () => {
  const { client, calls } = stubClient()
  let now = 1_000_000
  const tokens = createTokens({ server: 'https://kw', client, store: memoryStore(), now: () => now })
  await tokens.set({ accessToken: 'at-0', refreshToken: 'rt-0', expiresAt: now + 120_000 })
  assert.equal((await tokens.access()).accessToken, 'at-0')  // 还有两分钟，不刷新
  now += 61_000
  assert.equal((await tokens.access()).accessToken, 'at-2')  // 剩 59 秒，先刷新
  assert.deepEqual(calls.refresh, ['rt-0'])
  // 刷新令牌被服务端拒：清掉存的，下一次回 NotLoggedIn（重新走浏览器）
  now += 120_000
  const failing = stubClient({ refreshFails: true }).client
  const broken = createTokens({ server: 'https://kw', client: failing, store: memoryStore(), now: () => now })
  await broken.set({ accessToken: 'at-x', refreshToken: 'rt-dead', expiresAt: now + 1000 })
  await assert.rejects(broken.access(), NotLoggedIn)
  assert.equal(await broken.loaded(), false)
})

test('按受众换令牌：带上当前访问令牌与额外参数', async () => {
  const { client, calls } = stubClient()
  const tokens = createTokens({ server: 'https://kw', client, store: memoryStore(), now: () => 1_000_000 })
  await tokens.set({ accessToken: 'at-0', refreshToken: 'rt-0', expiresAt: 9_000_000 })
  const tools = await tokens.forAudience('tools', { conversation_id: 'c_1' })
  const session = await tokens.forAudience('desktop-session')
  assert.equal(tools.accessToken, 'aud-tools-1')
  assert.deepEqual(calls.exchange[0], { accessToken: 'at-0', audience: 'tools', params: { conversation_id: 'c_1' } })
  assert.deepEqual(calls.exchange[1], { accessToken: 'at-0', audience: 'desktop-session', params: {} })
})

test('加密文件存储：往返、坏文件按未登录、无加密环境明文回退', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kw-store-'))
  try {
    const file = join(dir, 'tokens.bin')
    const realCrypto = {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(`sealed:${value}`),
      decryptString: buffer => Buffer.from(buffer.toString('utf8').replace(/^sealed:/, '')),
    }
    const store = createEncryptedStore(file, realCrypto)
    assert.equal(await store.load(), null)
    await store.save({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1 })
    assert.ok(readFileSync(file, 'utf8').startsWith('enc-v1:'), '落盘是加密后的形态')
    assert.equal((await store.load()).accessToken, 'at-1')

    await writeFileBroken(file)
    assert.equal(await store.load(), null, '读不出来的文件当作未登录')

    const plain = createEncryptedStore(join(dir, 'plain.bin'), { isEncryptionAvailable: () => false })
    await plain.save({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: 1 })
    assert.ok(existsSync(join(dir, 'plain.bin')))
    assert.equal((await plain.load()).accessToken, 'at-2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function writeFileBroken(file) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, 'enc-v1:not-base64-中文')
}
