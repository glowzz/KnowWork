/** 真机冒烟（不在单测里跑）：用 desktop 的托管模块起真实的 DSH 设备宿主 + 官方模拟模型服务，
 * 验证 profile 组装、就绪行、健康检查与三档预设的目录接口都成立。跑完即删也行，留着手动验证用。 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUNTIME = join(REPO, 'runtime-host')
const requireRuntime = createRequire(join(RUNTIME, 'package.json'))
const { startMockLlmServer } = requireRuntime('@deepseek-ai/dsh-llm-mock-server')

const { assembleProfileHome, startHostProcess } = await import('../src/main/host.mjs')
const { createHostClient } = await import('../src/main/host-client.mjs')

const home = mkdtempSync(join(tmpdir(), 'kw-smoke-home-'))
const llm = await startMockLlmServer({ sequence: ['success'], repeatLast: true })
const token = 's'.repeat(40)

try {
  const profile = assembleProfileHome({
    templateDir: join(RUNTIME, 'profile-device'),
    pluginsDir: join(RUNTIME, 'plugins'),
    home,
  })
  console.log('profile 组装：', profile)
  const process_ = startHostProcess({
    nodePath: process.execPath,
    dshCli: join(RUNTIME, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    home,
    env: {
      KNOWWORK_HOST_TOKEN: token,
      KNOWWORK_HOST_PORT: '0',
      KNOWWORK_MODEL_PROVIDER: 'knowwork-gateway',
      KNOWWORK_MODEL_BASE_URL: `${llm.baseURL}`,
      KNOWWORK_MODEL_API: 'anthropic-messages',
      KNOWWORK_MODEL_TOKEN: 'mock-gateway-token-0123456789abcdef',
      KNOWWORK_MODEL: 'deepseek-chat',
    },
    log: (...parts) => console.log('[host]', ...parts),
  })
  const ready = await process_.ready
  console.log('宿主就绪：port', ready.port, 'epoch', ready.epoch)
  const client = createHostClient({ base: `http://127.0.0.1:${ready.port}`, token })
  const health = await client.health()
  console.log('health:', JSON.stringify(health))
  const catalog = await client.accessCatalog()
  const names = JSON.stringify(catalog.catalog?.options ?? catalog.catalog)
  console.log('三档预设：', names.includes('workspace-modify') && names.includes('view-only') && names.includes('full-access') ? '全在' : names)
  console.log('SMOKE OK')
  process_.stop()
} finally {
  await llm.close?.()
  rmSync(home, { recursive: true, force: true })
}
