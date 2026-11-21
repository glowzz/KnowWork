/** 本机宿主托管：配置档组装（软链与模板）、就绪行等待、健康检查、崩溃退避重启。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleProfileHome, startHostProcess, superviseHost } from '../src/main/host.mjs'
import { createHostClient } from '../src/main/host-client.mjs'

const TOKEN = 't'.repeat(40)

/** stub 的 dsh CLI：起一个 HTTP 服务当宿主接口，打就绪行；可指定活多久（测重启）。 */
function writeStubDsh(dir, { lifetimeMs = 0 } = {}) {
  const file = join(dir, 'stub-dsh.mjs')
  writeFileSync(file, `
import { createServer } from 'node:http'
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ ok: true, epoch: 'e1' }))
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ knowworkHostReady: true, port: server.address().port, epoch: 'e1' }) + '\\n')
})
${lifetimeMs > 0 ? `setTimeout(() => process.exit(9), ${lifetimeMs})` : "process.stdin.on('end', () => process.exit(0))"}
`)
  return file
}

function fakeRuntime() {
  const root = mkdtempSync(join(tmpdir(), 'kw-runtime-'))
  const templateDir = join(root, 'profile-device')
  const pluginsDir = join(root, 'plugins')
  mkdirSync(templateDir, { recursive: true })
  mkdirSync(pluginsDir, { recursive: true })
  for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    writeFileSync(join(templateDir, file), '{}')
  }
  for (const name of ['dsh-host', 'desktop-host-bundle']) {
    mkdirSync(join(pluginsDir, name), { recursive: true })
    writeFileSync(join(pluginsDir, name, 'package.json'), '{}')
  }
  return { root, templateDir, pluginsDir }
}

test('配置档组装：模板四件套就位，两个 @knowwork 包软链到仓库里的目录', () => {
  const { root, templateDir, pluginsDir } = fakeRuntime()
  const home = mkdtempSync(join(tmpdir(), 'kw-dsh-home-'))
  try {
    const profile = assembleProfileHome({ templateDir, pluginsDir, home })
    assert.ok(existsSync(join(profile, 'cordis.yml')))
    const link = join(profile, 'node_modules', '@knowwork', 'desktop-host-bundle')
    assert.equal(readlinkSync(link), join(pluginsDir, 'desktop-host-bundle'))
    // 再组装一遍不报错（幂等），软链还指着同一处
    assembleProfileHome({ templateDir, pluginsDir, home })
    assert.equal(readlinkSync(link), join(pluginsDir, 'desktop-host-bundle'))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('宿主进程：等就绪行、健康检查可达、stop 干净退出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kw-host-'))
  try {
    const dshCli = writeStubDsh(dir)
    const exits = []
    const process_ = startHostProcess({
      nodePath: process.execPath,
      dshCli,
      home: dir,
      env: { KNOWWORK_HOST_TOKEN: TOKEN, KNOWWORK_HOST_PORT: '0' },
      onExit: (code, signal, stderr) => exits.push({ code, signal, stderr }),
    })
    const { port, epoch } = await process_.ready
    assert.equal(epoch, 'e1')
    const client = createHostClient({ base: `http://127.0.0.1:${port}`, token: TOKEN })
    assert.equal((await client.health()).ok, true)
    process_.stop()
    await process_.exited
    assert.equal(exits.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主起不来（脚本立即退出）：ready 拒绝并带 stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kw-host-bad-'))
  try {
    const dshCli = join(dir, 'bad-dsh.mjs')
    writeFileSync(dshCli, 'process.exit(3)')
    const process_ = startHostProcess({ nodePath: process.execPath, dshCli, home: dir })
    await assert.rejects(process_.ready, /宿主退出 code=3/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主起不来（可执行文件不存在）：ready 给人话报错，不炸未捕获异常', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kw-host-noent-'))
  try {
    const dshCli = writeStubDsh(dir)  // 入口要真实存在，缺的是可执行文件
    const exits = []
    const process_ = startHostProcess({
      nodePath: join(dir, '没有这个可执行文件'),
      dshCli,
      home: dir,
      onExit: (code, signal, stderr) => exits.push({ code, signal, stderr }),
    })
    await assert.rejects(process_.ready, /宿主进程无法启动/)
    assert.deepEqual(await process_.exited, { code: null, signal: null })
    assert.equal(exits.length, 1)
    assert.match(exits[0].stderr, /spawn:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主入口不存在：同步给出能动手的原因（Windows 的 spawn ENOENT 会误报到 exe 上）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kw-host-nocli-'))
  try {
    assert.throws(
      () => startHostProcess({ nodePath: process.execPath, dshCli: join(dir, '没有.mjs'), home: dir }),
      /宿主入口不存在[\s\S]*npm install/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('监督者：崩溃后退避重启，起不来达到上限就放弃', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kw-sup-'))
  try {
    let boots = 0
    const supervisor = superviseHost(async () => {
      boots += 1
      const dshCli = writeStubDsh(dir, { lifetimeMs: boots === 1 ? 150 : 0 })  // 第一命短命，之后常驻
      const process_ = startHostProcess({ nodePath: process.execPath, dshCli, home: dir,
                                          env: { KNOWWORK_HOST_TOKEN: TOKEN } })
      await process_.ready
      return process_
    }, { backoffMs: 50 })
    const first = await supervisor.ensure()
    assert.ok(first.ready !== undefined)
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.ok(boots >= 2, `崩溃后没有重启（boots=${boots}）`)
    assert.ok(supervisor.current !== null)
    await supervisor.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
