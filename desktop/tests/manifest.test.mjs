/** 清单一致性（「Python 的库和云端沙箱镜像是同一份清单、同一个版本」）：desktop 的钉版清单与
 * deploy/docker/sandbox.Dockerfile 的钉版对不上就变红——上游升了版本，桌面打包跟着同步。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')
const MANIFEST = JSON.parse(readFileSync(join(REPO, 'desktop', 'resources-manifest.json'), 'utf8'))
const DOCKERFILE = readFileSync(join(REPO, 'deploy', 'docker', 'sandbox.Dockerfile'), 'utf8')

function pipPinsOf(dockerfile) {
  // RUN pip install --no-cache-dir … && rm 的那一段里的所有 包==版本
  const block = dockerfile.match(/pip install --no-cache-dir([\s\S]*?)&& rm -rf/)?.[1] ?? ''
  const pins = {}
  for (const match of block.matchAll(/([^\s\\]+)==([\d.]+)/g)) {
    pins[match[1].replaceAll('"', '')] = match[2]
  }
  return pins
}

function npmPinsOf(dockerfile) {
  // RUN npm install -g …（有续行）里的 包@版本
  const block = dockerfile.match(/npm install -g([\s\S]*?)&& npm cache/)?.[1] ?? ''
  const pins = {}
  for (const match of block.matchAll(/([A-Za-z0-9@/_.-]+)@([\d.]+)/g)) {
    pins[match[1].replace(/^@/, '')] = match[2]
  }
  return pins
}

test('Python 的库与沙箱镜像同一份清单、同一个版本', () => {
  assert.deepEqual(MANIFEST.python.packages, pipPinsOf(DOCKERFILE))
})

test('生成 Word/PPT 的 Node 库与沙箱镜像同一版本', () => {
  assert.deepEqual(MANIFEST.node.npmGlobals, npmPinsOf(DOCKERFILE))
})

test('Python 3.12：技能源码用 PEP 701 的 f-string 嵌套引号', () => {
  assert.equal(MANIFEST.python.version, '3.12')
  assert.match(DOCKERFILE, /python:3\.12/)
})

test('LibreOffice 版本跟沙箱镜像的说明一致', () => {
  const dockerfileVersion = DOCKERFILE.match(/LibreOffice (\d+\.\d+)/)?.[1]
  assert.equal(MANIFEST.libreoffice, dockerfileVersion)
})

test('本机宿主的 Node 满足 runtime-host 的 engines（>=24.9.0）', () => {
  const engines = readFileSync(join(REPO, 'runtime-host', 'package.json'), 'utf8').match(/"node": ">=([\d.]+)"/)
  const [major, minor] = MANIFEST.node.host.split('.').map(Number)
  const [needMajor, needMinor] = engines[1].split('.').map(Number)
  assert.ok(major > needMajor || (major === needMajor && minor >= needMinor),
            `桌面自带的 Node ${MANIFEST.node.host} 低于宿主要求的 ${engines[1]}`)
})

test('DSH 版本与 runtime-host 锁的同一个', () => {
  const dsh = readFileSync(join(REPO, 'runtime-host', 'package.json'), 'utf8').match(/"@deepseek-ai\/dsh": "([^"]+)"/)
  assert.equal(MANIFEST.dsh, dsh[1])
})
