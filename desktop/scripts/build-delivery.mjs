/**
 * M6 交付包整理：electron-builder 出的安装包与更新清单 → 交付目录（deploy/html/desktop/），
 * 直接落在更新 feed 的根（壳的 generic provider 到 /desktop/latest.yml、/desktop/latest-mac.yml 取清单），
 * 另加一份 manifest.json（版本、文件、摘要）给运维核对。对应「解开放进部署目录，不用重启服务」。
 *
 *   node scripts/build-delivery.mjs                 # desktop/release → deploy/html/desktop/
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

// 更新清单与安装包都在 feed 根（generic provider 固定到 <feed>/latest*.yml）；两个平台的清单文件名不同、不互踩
const installers = readdirSync(RELEASE).filter(name =>
  /\.(dmg|exe|zip)$/i.test(name) || /^latest(-mac)?\.yml$/.test(name) || name.endsWith('.blockmap'))

if (installers.length === 0) {
  console.error(`release 里没有安装包：${RELEASE}（先 electron-builder）`)
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })
const manifest = { version: VERSION, files: [] }
for (const name of installers) {
  const bytes = readFileSync(join(RELEASE, name))
  copyFileSync(join(RELEASE, name), join(OUT, name))
  manifest.files.push({ name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`交付包就位：${OUT}（版本 ${VERSION}）`)
for (const file of manifest.files) console.log(`  ${file.name}  ${file.bytes}  ${file.sha256.slice(0, 12)}…`)
console.log('部署：把 deploy/html/desktop/ 挂进网关的静态目录（nginx 的 /desktop/ 位置），不用重启服务')
