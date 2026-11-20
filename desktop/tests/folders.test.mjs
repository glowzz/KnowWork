/** 工作文件夹的注册与路径解析：往返持久化、相对拼绝对、越界拒收。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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

test('路径解析：相对按文件夹拼，越界不读', () => {
  const folder = '/Users/lei/台账'
  assert.deepEqual(resolveInFolder(folder, '2025/完成率.xlsx'),
                   { ok: true, path: join(folder, '2025/完成率.xlsx') })
  assert.deepEqual(resolveInFolder(folder, '/Users/lei/台账/notes.md'),
                   { ok: true, path: '/Users/lei/台账/notes.md' })
  const outside = resolveInFolder(folder, '/Users/lei/其他/secret.md')
  assert.equal(outside.ok, false)
  assert.match(outside.reason, /不在工作文件夹/)
  const climb = resolveInFolder(folder, '../../etc/passwd')
  assert.equal(climb.ok, false)
  assert.deepEqual(resolveInFolder(null, 'a.txt').ok, false)
  assert.deepEqual(resolveInFolder(folder, '  ').ok, false)
})
