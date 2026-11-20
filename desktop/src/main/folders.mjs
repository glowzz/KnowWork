/**
 * 每段本机对话的工作文件夹：建对话时选定（桥的 startConversation 带过来），文件读写、@ 补全、
 * 开会话的 cwd 都按它解析。落盘到 userData 的小 JSON——壳重启后交付的文件、@ 的路径还解析得出来。
 */

import { isAbsolute, join, resolve, sep } from 'node:path'
import { readFile, rm, writeFile } from 'node:fs/promises'

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
 * 把对话里的文件路径解析到工作文件夹内：相对路径按它拼，绝对路径要求落在它里面（文件能力都按
 * 「这盘对话的工作文件夹」给，越界不读——交付与文件链接的路径都来自这段对话自己的工作区）。
 * 返回 {ok:true, path} 或 {ok:false, reason}。
 */
export function resolveInFolder(folder, rawPath) {
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
  return { ok: true, path: target }
}
