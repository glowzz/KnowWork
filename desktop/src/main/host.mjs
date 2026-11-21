/**
 * 本机宿主的托管：组装设备配置档（DSh_HOME）→ 用自带的 Node 起官方 dsh CLI → 等就绪行 → 健康检查。
 *
 * 配置档组合与 runtime-host/tests/support/harness.mjs 的 freshDshHome 同一套（service 端服务端测试也是这么搭的）：
 * 模板四件套拷进 DSH_HOME/profiles/knowwork-device-host，@knowwork 的两个包软链进去（官方 @deepseek-ai 的
 * 由 dsh 安装自带）。打包时这棵树随应用带（resources），开发期指向仓库里的 runtime-host。
 *
 * 崩溃后按退避重启（上限内）；就绪行、健康检查、令牌随 env 带（KNOWWORK_HOST_TOKEN 等，见 index.mjs 的装配）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const PROFILE_NAME = 'knowwork-device-host'
const TEMPLATE_FILES = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']
// 与 runtime-host/package.json 的 engines、desktop/resources-manifest.json 的 node.host 同一口径：
// dsh CLI 用 import.meta.main 判定入口（Node 22.13/24 起才有），更低的 Node 会什么都不做、安静退出
const MIN_HOST_NODE = { major: 24, minor: 9 }

/** 组装 DSH_HOME（幂等）：已有配置档就不重做；软链损坏（目标换了）时重建。 */
export function assembleProfileHome({ templateDir, pluginsDir, home }) {
  const profile = join(home, 'profiles', PROFILE_NAME)
  const nodeModules = join(profile, 'node_modules', '@knowwork')
  mkdirSync(nodeModules, { recursive: true })
  for (const file of TEMPLATE_FILES) {
    copyFileSync(join(templateDir, file), join(profile, file))
  }
  for (const name of ['dsh-host', 'desktop-host-bundle']) {
    const link = join(nodeModules, name)
    const target = join(pluginsDir, name)
    let broken = false
    try {
      if (readlinkTarget(link) !== target) broken = true
    } catch {
      broken = true
    }
    if (broken) {
      try {
        unlinkSyncSafe(link)
      } catch {
        // 不存在就直接建
      }
      // Windows 的普通软链要管理员权限或开发者模式（EPERM -4048），目录连接（junction）不用：
      // junction 只对目录、目标要绝对路径——插件目录正好都满足。junction 的目标用 resolve 规范成
      // 绝对路径，readlink 读回来与 target 相等，幂等判断不受影响。
      symlinkSync(resolve(target), link, process.platform === 'win32' ? 'junction' : 'dir')
    }
  }
  return profile
}

// 相对链接按 profile 目录解析
const readlinkTarget = link => {
  const target = readlinkSync(link)
  return target.startsWith('.') ? join(dirname(link), target) : target
}
const unlinkSyncSafe = link => unlinkSync(link)

/** 起宿主前核对 Node 版本：太低时 dsh CLI 会静默退出（见 MIN_HOST_NODE），必须提前说人话。探不出来就不拦，让原路径报。 */
function checkNodeVersion(nodePath, log) {
  let result
  try {
    result = spawnSync(nodePath ?? process.execPath, ['-p', 'process.versions.node'], { timeout: 5000 })
  } catch {
    return
  }
  const version = result.stdout?.toString().trim()
  const match = /^v?(\d+)\.(\d+)/.exec(version ?? '')
  if (!match) {
    log(`宿主 Node 版本没探出来（${nodePath ?? process.execPath}），继续启动`)
    return
  }
  const [major, minor] = [Number(match[1]), Number(match[2])]
  log(`宿主 Node：v${major}.${minor}.x（${nodePath ?? process.execPath}）`)
  if (major < MIN_HOST_NODE.major || (major === MIN_HOST_NODE.major && minor < MIN_HOST_NODE.minor)) {
    throw new Error(
      `宿主的 Node 太旧：v${version}（要 >=${MIN_HOST_NODE.major}.${MIN_HOST_NODE.minor}）。\n` +
      'dsh CLI 靠 import.meta.main 判定入口（Node 22.13/24 起才有），旧 Node 会什么都不做、安静退出。\n' +
      '升级机器上的 Node 到 24 LTS，或设 KNOWWORK_NODE 指到新 Node 再启动桌面端。')
  }
}

/**
 * 起宿主进程：等就绪行（{knowworkHostReady:true, port}）才算起来；进程退出触发 onExit（上层决定重启）。
 * env 里带 DSH_HOME、KNOWWORK_HOST_TOKEN/PORT、模型网关地址与令牌（desktop 的 config.mjs 与 index.mjs 装配）。
 */
export function startHostProcess({ nodePath, dshCli, home, env = {}, onExit, log = () => {} }) {
  if (typeof dshCli !== 'string' || dshCli.length === 0) throw new Error('需要 dshCli（dsh CLI 的路径）')
  // Windows 的 spawn ENOENT 会误报到可执行文件上（真实原因常是 cwd 或入口不存在）——提前查，给出能动手的原因
  if (!existsSync(dshCli)) {
    throw new Error(`宿主入口不存在：${dshCli}\n开发态先在 runtime-host 目录跑一次 npm install`)
  }
  checkNodeVersion(nodePath, log)
  const child = spawn(nodePath ?? process.execPath, [dshCli, '--profile', PROFILE_NAME], {
    cwd: dirname(dshCli),
    env: { ...process.env, DSH_HOME: home, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += chunk })
  let resolveExited
  const exited = new Promise(resolve => {
    resolveExited = resolve
    child.once('exit', (code, signal) => {
      log(`宿主进程退出 code=${code} signal=${signal}`)
      onExit?.(code, signal, stderr)
      resolve({ code, signal })
    })
  })
  const ready = new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`宿主 60 秒内未就绪\nstdout:${out}\nstderr:${stderr}`)), 60_000)
    const fail = error => {
      clearTimeout(timer)
      reject(error)
    }
    // spawn 失败（ENOENT 等）不触发 exit，error 事件没人接会变成主进程未捕获异常：
    // 当作一次立即退出上报，ready 落空给出人看得懂的原因
    child.once('error', error => {
      log('宿主进程启动失败：', error)
      onExit?.(null, null, `spawn: ${error.message}`)
      resolveExited({ code: null, signal: null })
      fail(new Error(`宿主进程无法启动：${error.message}`))
    })
    child.stdout?.on('data', chunk => {
      out += chunk
      for (const line of out.split('\n')) {
        try {
          const parsed = JSON.parse(line)
          if (parsed.knowworkHostReady === true) {
            clearTimeout(timer)
            resolve({ port: parsed.port, epoch: parsed.epoch })
          }
        } catch { /* 非就绪行 */ }
      }
    })
    child.once('exit', (code, signal) => {
      fail(new Error(`宿主退出 code=${code} signal=${signal}\nstderr:${stderr || '（空）'}\nstdout 末尾：${out.slice(-1500) || '（空）'}`))
    })
  })
  return { child, ready, exited, stop: () => { child.stdin?.end(); child.kill() } }
}

/** 崩溃退避重启的监督者：起来之前不判活；连挂 maxRestarts 次就放弃（上层提示）。 */
export function superviseHost(spawnOnce, { maxRestarts = 5, backoffMs = 2000, log = () => {} } = {}) {
  let current = null
  let restarts = 0
  let stopping = false
  const listeners = new Set()

  async function up() {
    current = await spawnOnce()
    restarts = 0
    current.exited.then(({ code }) => {
      current = null
      if (stopping) return
      restarts += 1
      if (restarts > maxRestarts) {
        log('宿主反复退出，放弃重启')
        for (const listener of listeners) listener('given-up')
        return
      }
      log(`宿主退出（code=${code}），${backoffMs}ms 后重启`)
      setTimeout(() => { if (!stopping) void up().catch(error => log('宿主重启失败：', error)) }, backoffMs)
      for (const listener of listeners) listener('restarting')
    })
    for (const listener of listeners) listener('up', current)
    return current
  }

  return {
    async ensure() {
      return current ?? up()
    },
    get current() {
      return current
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async stop() {
      stopping = true
      current?.stop()
      current = null
    },
  }
}
