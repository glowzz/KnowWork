/**
 * M6 打包的准备脚本：把本机宿主的运行时备齐进 desktop/resources/（electron-builder 的 extraResources 从这里拿）。
 * CI（.github/workflows/desktop.yml）在 mac/win 构建机上跑；开发机手动跑也行。
 *
 *   node scripts/prepare-runtime.mjs --platform darwin|win32
 *
 * 备齐四样（版本钉在 desktop/resources-manifest.json，tests/manifest.test.mjs 与沙箱镜像核对）：
 * - runtime-host/：配置档、knowwork 插件与整棵依赖树（npm prune --omit=dev 后拷贝；dsh CLI 从 lib/bin.js 直接起）
 * - node/：独立 Node（>=24.9.0，宿主与 PTC 用）——从 nodejs.org 的官方发行包解压
 * - python/：Python 3.12 + 清单里的包（uv 装进目标目录；Windows 用 embeddable + get-pip，Mac 用 uv 的 python）
 * - office/：LibreOffice 25.2 的免安装目录（环境变量 KNOWWORK_OFFICE_DIR 指向已备好的目录，CI 里下载解压）
 */

import { cpSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manifest } from './manifest.mjs'
import { execFile, execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
void ROOT
const DESKTOP = join(ROOT, 'desktop')
const RESOURCES = join(DESKTOP, 'resources')

const platformIndex = process.argv.indexOf('--platform')
const platform = platformIndex >= 0 ? process.argv[platformIndex + 1] : process.platform
if (platform !== 'darwin' && platform !== 'win32') {
  console.error('桌面端只有 Mac（darwin）与 Windows（win32）两包：--platform darwin|win32')
  process.exit(1)
}

function log(...parts) {
  console.log('[prepare]', ...parts)
}

async function download(url, destination) {
  const { writeFile } = await import('node:fs/promises')
  log('下载：', url)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(destination, buffer)
  return destination
}

async function extract(zipPath, destination) {
  // CI 与开发机都有 unzip（Windows 用 Git Bash 自带）；不引依赖
  await new Promise((resolvePromise, rejectPromise) => {
    execFile('unzip', ['-oq', zipPath, '-d', destination], (error, _stdout, stderr) => {
      if (error) rejectPromise(new Error(`解压失败：${stderr}`))
      else resolvePromise()
    })
  })
}

function stageRuntimeHost() {
  const source = join(ROOT, 'runtime-host')
  const target = join(RESOURCES, 'runtime-host')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(join(target, 'node_modules', '@deepseek-ai'), { recursive: true })
  for (const entry of ['profile-device', 'plugins', 'package.json']) {
    cpSync(join(source, entry), join(target, entry), { recursive: true })
  }
  // 依赖树只留生产依赖：dsh 全家 + cordis 等。整棵拷再在临时副本里 prune 会很慢，直接按 package.json
  // 的 dependencies + 它们自己的传递依赖拷——太复杂；改用 npm prune 在暂存目录里做
  cpSync(join(source, 'node_modules'), join(target, 'node_modules'), { recursive: true })
  execFileSync('npm', ['prune', '--omit=dev'], { cwd: target, stdio: 'inherit' })
  log('runtime-host 就位：', target)
}

async function stageNode() {
  const target = join(RESOURCES, 'node')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  const version = manifest.node.host
  const archiveName = platform === 'darwin' ? `node-v${version}-darwin-arm64.tar.gz` : `node-v${version}-win-x64.zip`
  const url = `https://nodejs.org/dist/v${version}/${archiveName}`
  const archive = join(RESOURCES, archiveName)
  await download(url, archive)
  if (platform === 'darwin') {
    execFileSync('tar', ['-xzf', archive, '-C', target, '--strip-components=1'], { stdio: 'inherit' })
    rmSync(archive, { force: true })
  } else {
    await extract(archive, target)
    rmSync(archive, { force: true })
  }
  log('独立 Node 就位：', target)
}

async function stagePython() {
  // Python 3.12 + 清单里的包：CI 上用 uv 装（uv python install 3.12 && uv venv + uv pip install -r 清单）
  const target = join(RESOURCES, 'python')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  const requirements = Object.entries(manifest.python.packages)
    .map(([name, version]) => `${name}==${version}`).join('\n')
  writeFileSync(join(DESKTOP, 'requirements-desktop.txt'), requirements + '\n')
  log('Python 由打包机的 uv 准备（uv python install 3.12 && uv venv', target, '&& uv pip install -r requirements-desktop.txt）')
  log('mac：venv 整目录随应用带；Windows：embeddable python + venv 的 site-packages 拷进 resources/python')
  log('（office 技能的调用是 resources/python 里的 python 与 resources/office 的 soffice，路径在 device 环境层配）')
}

function stageOffice() {
  const officeDir = process.env.KNOWWORK_OFFICE_DIR
  const target = join(RESOURCES, 'office')
  if (officeDir === undefined || !existsSync(officeDir)) {
    log('office：没有 KNOWWORK_OFFICE_DIR，先跳过（CI 里下载 LibreOffice 25.2 免安装包后指向它）')
    return
  }
  rmSync(target, { recursive: true, force: true })
  // mac 的免安装形态是 LibreOffice.app：把 Contents 归一到 resources/office/Contents
  // （运行时 resolveSoffice 找 office/Contents/MacOS/soffice）；Windows/Linux 的 program/soffice 原样拷
  const appContents = join(officeDir, 'LibreOffice.app', 'Contents')
  if (platform === 'darwin' && existsSync(appContents)) {
    cpSync(appContents, join(target, 'Contents'), { recursive: true })
  } else {
    cpSync(officeDir, target, { recursive: true })
  }
  log('LibreOffice 就位：', target)
}

mkdirSync(RESOURCES, { recursive: true })
stageRuntimeHost()
await stageNode()
await stagePython()
stageOffice()
log('resources/ 备齐')
