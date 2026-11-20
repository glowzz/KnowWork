/**
 * M6 交付包整理：electron-builder 出的安装包与更新清单 → 交付目录（deploy/html/desktop/<版本>/），
 * 加一份 manifest.json（版本、文件、摘要）给运维核对；壳的更新检查吃旁边的 latest.yml（electron-updater）。
 * 对应「桌面端单独一个交付包，解开放进部署目录，不用重启服务」。
 *
 *   node scripts/build-delivery.mjs                 # desktop/release → deploy/html/desktop/<版本>/
 *   node scripts/build-delivery.mjs --out /tmp/交付  # 指定交付根目录
 */

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(DESKTOP, '..')
const VERSION = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).version
const RELEASE = join(DESKTOP, 'release')

const outIndex = process.argv.indexOf('--out')
const OUT = outIndex >= 0 ? process.argv[outIndex + 1] : join(ROOT, 'deploy', 'html', 'desktop')

const installers = readdirSync(RELEASE).filter(name =>
  /\.(dmg|exe)$/i.test(name) || /^latest\.yml$/.test(name) || name.endsWith('.blockmap'))

if (installers.length === 0) {
  console.error(`release 里没有安装包：${RELEASE}（先 electron-builder）`)
  process.exit(1)
}

const target = join(OUT, VERSION)
mkdirSync(target, { recursive: true })
const manifest = { version, files: [] }
for (const name of installers) {
  const bytes = readFileSync(join(RELEASE, name))
  copyFileSync(join(RELEASE, name), join(target, name))
  manifest.files.push({ name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
}
writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`交付包就位：${target}`)
for (const file of manifest.files) console.log(`  ${file.name}  ${file.bytes}  ${file.sha256.slice(0, 12)}…`)
console.log('部署：把 deploy/html/desktop/ 挂进网关的静态目录（nginx 的 /desktop/ 位置），不用重启服务')
