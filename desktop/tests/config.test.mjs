/** 连接配置与设备身份的持久化：地址校验、往返、设备号稳定、名字带平台标签。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearServer, deviceNameFor, loadOrCreateDevice, loadServer, saveServer } from '../src/main/config.mjs'
import { parseServer } from '../src/main/auth/client.mjs'

test('服务地址只认 http(s) 的源、剥掉路径', () => {
  assert.equal(parseServer('https://kw.example.com/'), 'https://kw.example.com')
  assert.equal(parseServer('  http://10.0.0.2:8000/base  '), 'http://10.0.0.2:8000')
  assert.equal(parseServer('kw.example.com'), null)
  assert.equal(parseServer('file:///etc'), null)
  assert.equal(parseServer(''), null)
})

test('落盘与读回：坏文件按未配置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kw-config-'))
  try {
    const file = join(dir, 'server.json')
    assert.equal(await loadServer(file), null)
    assert.equal(await saveServer(file, 'https://kw.example.com/'), 'https://kw.example.com')
    assert.equal(await loadServer(file), 'https://kw.example.com')
    await clearServer(file)
    assert.equal(await loadServer(file), null)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '不是 json')
    assert.equal(await loadServer(file), null)
    await assert.rejects(saveServer(file, '不是地址'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设备身份：首跑生成，之后一直同一份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kw-identity-'))
  try {
    const file = join(dir, 'identity.json')
    const first = await loadOrCreateDevice(file, { host: 'lilei-mbp', system: 'darwin' })
    const second = await loadOrCreateDevice(file, { host: 'lilei-mbp', system: 'darwin' })
    assert.equal(first.deviceId, second.deviceId)
    assert.match(first.deviceId, /^[0-9a-f-]{36}$/)
    assert.equal(first.deviceName, 'lilei-mbp（Mac）')
    assert.equal(deviceNameFor('pc-01', 'win32'), 'pc-01（Windows）')
    assert.equal(deviceNameFor('box', 'sunos'), 'box')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
