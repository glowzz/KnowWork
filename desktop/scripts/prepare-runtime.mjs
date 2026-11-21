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

/** uv 托管 Python 的安装根（linux/macOS：~/.local/share/uv/python；Windows：%APPDATA%\\uv\\python）。 */
function uvPythonDir() {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return platform === 'win32'
    ? join(appData, 'uv', 'python')
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'uv', 'python')
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

/** Windows：npm 是 .cmd（Node 18+ 的 execFileSync 直跑 .cmd 会 EINVAL，必须 shell）；uv 是 uv.exe 直跑。 */
function run(command, args, options = {}) {
  if (platform === 'win32') {
    if (command === 'npm') {
      execFileSync('npm.cmd', args, { stdio: 'inherit', shell: true, ...options })
      return
    }
    execFileSync(`${command}.exe`, args, { stdio: 'inherit', ...options })
    return
  }
  execFileSync(command, args, { stdio: 'inherit', ...options })
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
  // Python 3.12 + 清单里的包。注意不能只装一个 venv：venv 的解释器软链与标准库都留在 uv 的托管目录里，
  // 拷到用户机器就起不来。做法：uv 装托管解释器（python-build-standalone，可重定位）→ 整棵拷进
  // resources/python → 用它装清单里的包 → 收尾冒烟真拉起解释器 import 一轮
  const target = join(RESOURCES, 'python')
  rmSync(target, { recursive: true, force: true })
  const requirements = Object.entries(manifest.python.packages)
    .map(([name, version]) => `${name}==${version}`).join('\n')
  writeFileSync(join(DESKTOP, 'requirements-desktop.txt'), requirements + '\n')
  // CI 的 setup-uv 已把 3.12 装进 uv 的托管目录：--managed-python 强制只取托管 standalone
  // （否则 PATH 上的系统 python 会抢先，反推出的「安装根」就是 /usr 之类的错误目录）。
  // uv python find 返回可执行文件路径，反推安装根（darwin 是 bin/python3 的上两级；
  // win 是 python.exe 的上一级）整树拷进 resources/python——python-build-standalone 可重定位
  const managed = execFileSync('uv', ['python', 'find', '--managed-python', manifest.python.version],
                               { encoding: 'utf8' }).trim()
  const installRoot = platform === 'darwin' ? join(managed, '..', '..') : dirname(managed)
  if (!join(installRoot, 'bin').startsWith(join(uvPythonDir()))) {
    // find 到的必须是 uv 托管目录里的 standalone：系统 python 不可重定位，拷出去起不来
    throw new Error(`uv python find 返回的不是托管解释器：${managed}（期望在 ${uvPythonDir()} 下）`)
  }
  cpSync(installRoot, target, { recursive: true })
  const pythonBin = platform === 'win32' ? join(target, 'python.exe') : join(target, 'bin', 'python3')
  if (!existsSync(pythonBin)) throw new Error(`拷贝后的解释器不在期望位置：${pythonBin}`)
  // python-build-standalone 不自带 pip：用 uv 以它为解释器装清单
  run('uv', ['pip', 'install', '--python', pythonBin, '-r', join(DESKTOP, 'requirements-desktop.txt')], { stdio: 'inherit' })
  execFileSync(pythonBin, ['-c', 'import pandas, openpyxl, docx, pptx, matplotlib, markitdown'], { stdio: 'inherit' })
  log('Python 就位（含解释器与标准库）：', target)
}

function stageOffice() {
  const officeDir = process.env.KNOWWORK_OFFICE_DIR
  const target = join(RESOURCES, 'office')
  if (officeDir === undefined || !existsSync(officeDir)) {
    // 静默跳过会打包出没有 Office 引擎的产物（预览/转换真机全废）：宁可让打包直接失败
    throw new Error('office：KNOWWORK_OFFICE_DIR 没有设置或不存在（CI 里先装 LibreOffice 25.2 再跑本脚本）')
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
