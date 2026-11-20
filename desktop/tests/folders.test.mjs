/** 工作文件夹的注册与路径解析：往返持久化、相对拼绝对、越界拒收。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFolders, resolveInFolder } from '../src/main/folders.mjs'

test('注册表：落盘、跨实例读回、删除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kw-folders-'))
  try {
    const file = join(dir, 'conversation-folders.json')
    const first = createFolders({ file })
    await first.set('c_1', '/Users/lei/台账')
    assert.equal(await first.get('c_1'), '/Users/lei/台账')
    const second = createFolders({ file })
    assert.equal(await second.get('c_1'), '/Users/lei/台账', '壳重启后还解析得出来')
    await second.delete('c_1')
    const third = createFolders({ file })  // 全新实例读落盘的文件（第一实例的内存缓存里还有旧值）
    assert.equal(await third.get('c_1'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('路径解析：相对按文件夹拼，越界不读（返回的是磁盘上的真实路径）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kw-resolve-'))
  try {
    const folder = join(dir, '台账')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'notes.md'), '')
    // macOS 的 tmpdir（/var/…）realpath 后是 /private/var/…：期望值按磁盘真实路径算
    const realFolder = realpathSync(folder)
    const resolved = await resolveInFolder(folder, '2025/完成率.xlsx')
    assert.deepEqual(resolved, { ok: true, path: join(realFolder, '2025/完成率.xlsx'), base: realFolder })
    const existing = await resolveInFolder(folder, 'notes.md')
    assert.deepEqual(existing, { ok: true, path: join(realFolder, 'notes.md'), base: realFolder })
    const outside = await resolveInFolder(folder, join(dir, '其他', 'secret.md'))
    assert.equal(outside.ok, false)
    assert.match(outside.reason, /不在工作文件夹/)
    const climb = await resolveInFolder(folder, '../../etc/passwd')
    assert.equal(climb.ok, false)
    assert.equal((await resolveInFolder(null, 'a.txt')).ok, false)
    assert.equal((await resolveInFolder(folder, '  ')).ok, false)
    assert.equal((await resolveInFolder(folder, '不存在/新文件.txt')).ok, true, '新建文件也放行（还没落盘）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
