/**
 * 每段本机对话的工作文件夹：建对话时选定（桥的 startConversation 带过来），文件读写、@ 补全、
 * 开会话的 cwd 都按它解析。落盘到 userData 的小 JSON——壳重启后交付的文件、@ 的路径还解析得出来。
 */

import { isAbsolute, join, resolve, sep } from 'node:path'
import { readFile, rm, writeFile, realpath } from 'node:fs/promises'

export function createFolders({ file, log = () => {} } = {}) {
  const map = new Map()
  let loaded = false

  async function ensureLoaded() {
    if (loaded) return
    loaded = true
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'))
      for (const [id, folder] of Object.entries(raw)) map.set(id, folder)
    } catch {
      // 首次运行或文件坏了：从空开始
    }
  }

  async function persist() {
    try {
      await writeFile(file, JSON.stringify(Object.fromEntries(map), null, 2))
    } catch (error) {
      log('工作文件夹记录写不进去：', error)
    }
  }

  return {
    async set(conversationId, folder) {
      await ensureLoaded()
      map.set(conversationId, folder)
      await persist()
    },
    async get(conversationId) {
      await ensureLoaded()
      return map.get(conversationId) ?? null
    },
    async delete(conversationId) {
      await ensureLoaded()
      if (map.delete(conversationId)) await persist()
    },
  }
}

/**
 * 把对话里的文件路径解析到工作文件夹内（安全边界，fail-closed）：
 * - 相对路径按它拼，绝对路径要求落在它里面（词法归一化挡 `..` 与同前缀目录）；
 * - 再做真实路径核对（挡符号链接逃逸：文件夹内指向外部的链接一律拒）——base 与 target 都按磁盘上的
 *   真实路径比；target 还不存在（新建文件）时对最近的已存在祖先做 realpath 再拼回未存在的余段。
 * 返回 {ok:true, path, base}（path/base 都是真实路径，relative 的基准用 base）或 {ok:false, reason}。
 */
export async function resolveInFolder(folder, rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) return { ok: false, reason: '缺少文件路径' }
  if (typeof folder !== 'string' || folder.length === 0) {
    return { ok: false, reason: '这段对话没有工作文件夹' }
  }
  const base = resolve(folder)
  const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(join(base, rawPath))
  const baseWithSep = base.endsWith(sep) ? base : base + sep
  if (target !== base && !target.startsWith(baseWithSep)) {
    return { ok: false, reason: '这个路径不在工作文件夹里' }
  }
  let realBase
  try {
    realBase = await realpath(base)
  } catch {
    return { ok: false, reason: '工作文件夹不存在' }
  }
  // target 可能还不存在（新建文件）：从它往上找第一个已存在的祖先做 realpath，再拼回未存在的余段
  let existing = target
  const missing = []
  for (;;) {
    try {
      await realpath(existing)
      break
    } catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, reason: '文件路径解析失败' }
      missing.unshift(existing)
      const parent = join(existing, '..')
      if (resolve(parent) === existing) return { ok: false, reason: '文件路径解析失败' }
      existing = resolve(parent)
    }
  }
  let realTarget = await realpath(existing)
  for (const segment of missing) {
    realTarget = join(realTarget, segment.split(sep).at(-1))
    if (realTarget !== realBase && !realTarget.startsWith(realBase.endsWith(sep) ? realBase : realBase + sep)) {
      return { ok: false, reason: '这个路径不在工作文件夹里' }
    }
  }
  const realBaseWithSep = realBase.endsWith(sep) ? realBase : realBase + sep
  if (realTarget !== realBase && !realTarget.startsWith(realBaseWithSep)) {
    return { ok: false, reason: '这个路径不在工作文件夹里' }
  }
  return { ok: true, path: realTarget, base: realBase }
}
