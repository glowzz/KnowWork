/**
 * M6 打包的准备脚本：把本机宿主的运行时备齐进 desktop/resources/（electron-builder 的 extraResources 从这里拿）。
 * CI（.github/workflows/desktop.yml）在 mac/win 构建机上跑；开发机手动跑也行。
 *
 *   node scripts/prepare-runtime.mjs --platform darwin|win32
 *
 * 备齐四样（版本钉在 desktop/resources-manifest.json，tests/manifest.test.mjs 与沙箱镜像核对）：
 * - runtime-host/：配置档、knowwork 插件与整棵生产依赖树（npm prune 后拷贝；dsh CLI 从 lib/bin.js 直接起）
 * - node/：独立 Node（>=24.9.0，宿主与 PTC 用）——官方发行包解压（内容上移一层，别留 node-vX 目录）
 * - python/：Python 3.12 + 清单里的包（uv 装 venv：CI 有 astral-sh/setup-uv；Windows 走 Scripts/python.exe）
 * - office/：LibreOffice 25.2（KNOWWORK_OFFICE_DIR 指向安装/免安装目录；mac 把 LibreOffice.app 的
 *   Contents 归一到 resources/office/Contents——运行时 resolveSoffice 找 office/Contents/MacOS/soffice）
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { manifest } from './manifest.mjs'

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(DESKTOP, '..')
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
  log('下载：', url)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`)
  // 流式写盘，不把上百 MB 归档整进内存；失败由调用方清理
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
  return destination
}

/** 官方发行包解压：内容上移一层（不留 node-vX 的顶层目录）。Windows 用 System32 的 bsdtar
 * （绝对路径，避开 Git Bash 里 GNU tar 不吃 zip 的坑；它支持 --strip-components 且能解 zip）。 */
function extractStrip(archive, destination) {
  if (platform === 'win32') {
    const bsdtar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    execFileSync(bsdtar, ['-xf', archive, '-C', destination, '--strip-components=1'], { stdio: 'inherit' })
    return
  }
  execFileSync('tar', ['-xzf', archive, '-C', destination, '--strip-components=1'], { stdio: 'inherit' })
}

/** Windows 的 npm 是 .cmd（spawn 不自动补）；uv 是 uv.exe（setup-uv 装的可执行）。类 Unix 直接用。 */
function run(command, args, options = {}) {
  if (platform === 'win32') {
    const executable = command === 'npm' ? 'npm.cmd' : `${command}.exe`
    execFileSync(executable, args, { stdio: 'inherit', ...options })
  } else {
    execFileSync(command, args, { stdio: 'inherit', ...options })
  }
}

function stageRuntimeHost() {
  const source = join(ROOT, 'runtime-host')
  const target = join(RESOURCES, 'runtime-host')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(join(target, 'node_modules', '@deepseek-ai'), { recursive: true })
  for (const entry of ['profile-device', 'plugins', 'package.json', 'package-lock.json']) {
    cpSync(join(source, entry), join(target, entry), { recursive: true })
  }
  cpSync(join(source, 'node_modules'), join(target, 'node_modules'), { recursive: true })
  // 依赖树裁到生产依赖；Windows 的 npm 是 .cmd，走 run()
  run('npm', ['prune', '--omit=dev'], { cwd: target })
  log('runtime-host 就位：', target)
}

async function stageNode() {
  const target = join(RESOURCES, 'node')
  const archive = join(RESOURCES, `node-${platform}.archive`)
  const version = manifest.node.host
  const archiveName = platform === 'darwin' ? `node-v${version}-darwin-arm64.tar.gz` : `node-v${version}-win-x64.zip`
  const url = `https://nodejs.org/dist/v${version}/${archiveName}`
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  try {
    await download(url, archive)
    extractStrip(archive, target)
  } finally {
    rmSync(archive, { force: true })
  }
  log('独立 Node 就位：', target)
}

async function stagePython() {
  // Python 3.12 + 清单里的包：uv 装 venv（CI 有 astral-sh/setup-uv；开发机装了 uv 即可）
  const target = join(RESOURCES, 'python')
  rmSync(target, { recursive: true, force: true })
  const requirements = Object.entries(manifest.python.packages)
    .map(([name, version]) => `${name}==${version}`).join('\n')
  writeFileSync(join(DESKTOP, 'requirements-desktop.txt'), requirements + '\n')
  run('uv', ['python', 'install', manifest.python.version], { stdio: 'inherit' })
  run('uv', ['venv', '--python', manifest.python.version, target], { stdio: 'inherit' })
  const pythonBin = platform === 'win32' ? join(target, 'Scripts', 'python.exe') : join(target, 'bin', 'python')
  run('uv', ['pip', 'install', '--python', pythonBin, '-r', join(DESKTOP, 'requirements-desktop.txt')], { stdio: 'inherit' })
  log('Python 就位：', target)
}

function stageOffice() {
  const officeDir = process.env.KNOWWORK_OFFICE_DIR
  const target = join(RESOURCES, 'office')
  if (officeDir === undefined || !existsSync(officeDir)) {
    log('office：没有 KNOWWORK_OFFICE_DIR，先跳过（CI 里装好 LibreOffice 25.2 后指向它）')
    return
  }
  rmSync(target, { recursive: true, force: true })
  // mac 的形态是 LibreOffice.app：把 Contents 归一到 resources/office/Contents
  // （运行时 resolveSoffice 找 office/Contents/MacOS/soffice）；Windows/Linux 的 program/soffice 原样拷
  const appContents = join(officeDir, 'LibreOffice.app', 'Contents')
  if (platform === 'darwin' && existsSync(appContents)) {
    cpSync(appContents, join(target, 'Contents'), { recursive: true })
  } else {
    cpSync(officeDir, target, { recursive: true })
  }
  // 备齐后断言可执行真的在（布局与 resolveSoffice 的期望一致；不对齐就地报错，别静默出货）
  const executable = platform === 'darwin'
    ? join(target, 'Contents', 'MacOS', 'soffice')
    : join(target, 'program', platform === 'win32' ? 'soffice.exe' : 'soffice')
  if (!existsSync(executable)) {
    throw new Error(`LibreOffice 的可执行没到位（期望 ${executable}）；检查 KNOWWORK_OFFICE_DIR 的形态`)
  }
  log('LibreOffice 就位：', executable)
}

mkdirSync(RESOURCES, { recursive: true })
stageRuntimeHost()
await stageNode()
await stagePython()
stageOffice()
log('resources/ 备齐')
