/**
 * 本机对话的文件能力（网页版 ConversationFiles 的桌面实现）：读原件、转 PDF（预览）、另存、
 * 用本机程序打开、@ 补全。路径一律经 folders.resolveInFolder 解析并限制在工作文件夹内
 * （真实路径核对，符号链接逃逸也拒）。对话框与 shell（另存、打开、显示）注入，纯逻辑与编排可测。
 */

import { copyFile, readFile, readdir } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { resolveInFolder } from './folders.mjs'

const WALK_DEPTH = 3
const WALK_LIMIT = 500
const MATCH_LIMIT = 20
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.dsh'])

export class FileNotFoundError extends Error {}

export function createFileOps({ folders, office, dialog = null, shell = null, log = () => {} } = {}) {
  async function resolveTarget(conversationId, path) {
    const folder = await folders.get(conversationId)
    const resolved = await resolveInFolder(folder, path)
    if (!resolved.ok) throw new FileNotFoundError(resolved.reason)
    return resolved
  }

  return {
    /** 整个文件的原件字节。 */
    async read(conversationId, path) {
      const { path: target } = await resolveTarget(conversationId, path)
      try {
        return await readFile(target)
      } catch (error) {
        throw fileError(target, error)
      }
    },

    /** Word、PPT 等转成 PDF 的字节（给网页版的 PDF 阅读器）；PDF 原件直接回。 */
    async pdf(conversationId, path) {
      const { path: target } = await resolveTarget(conversationId, path)
      if (target.toLowerCase().endsWith('.pdf')) return readFile(target)
      return office.convertToPdf(target, { log })
    },

    /** 另存为（弹系统的保存对话框，默认用交付时的名字）。 */
    async save(conversationId, path) {
      const { path: target } = await resolveTarget(conversationId, path)
      if (dialog === null) throw new Error('另存为需要对话框')
      const result = await dialog.showSaveDialog({
        defaultPath: basename(target),
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      })
      if (result.canceled || result.filePath === undefined) return { saved: false }
      await copyFile(target, result.filePath)
      return { saved: true, savedTo: result.filePath }
    },

    /** 用本机程序打开（app）或在文件管理器里显示（reveal）。 */
    async open(conversationId, path, how) {
      if (shell === null) throw new Error('打开文件需要 shell')
      const { path: target } = await resolveTarget(conversationId, path)
      if (how === 'reveal') {
        shell.showItemInFolder(target)
        return { opened: true }
      }
      const error = await shell.openPath(target)
      if (error) throw new FileNotFoundError(`打开失败：${error}`)
      return { opened: true }
    },

    /**
     * @ 点名工作文件夹里的文件（照官方 @file 补全）：按查找词列出文件与文件夹（相对路径，统一 / 分隔），
     * insert 自带 @——文件是完整引用，文件夹是不闭合的引号加尾 /（选中后接着往下列）。
     */
    async references(conversationId, query) {
      const folder = await folders.get(conversationId)
      const root = await resolveInFolder(folder, '.')
      if (!root.ok) return []
      const tokens = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const found = []
      const state = { count: 0 }
      await walk(root.base, root.base, 0, state, entry => {
        if (found.length >= MATCH_LIMIT) return
        const relativePath = relative(root.base, entry.path).replaceAll(sep, '/')
        if (tokens.length > 0 && !tokens.every(token => relativePath.toLowerCase().includes(token))) return
        // 含引号的路径不进补全（官方 fileMention 对它不生成 @，@ 菜单的正则也解析不了）
        const insert = entry.kind === 'directory' ? directoryMention(relativePath) : fileMention(relativePath)
        if (insert === null) return
        found.push({ path: relativePath, kind: entry.kind, insert })
      })
      return found
    },

    /** 拖进输入框的文件转成 @路径（文件就在这台电脑上，不传也不复制）；工作文件夹外的不悄悄外带。 */
    async mentionsForPaths(conversationId, paths) {
      const folder = await folders.get(conversationId)
      const mentions = []
      const skipped = []
      for (const raw of paths) {
        const resolved = await resolveInFolder(folder, raw)
        if (!resolved.ok) {
          skipped.push(raw)
          continue
        }
        const relativePath = relative(resolved.base, resolved.path).replaceAll(sep, '/')
        if (relativePath.startsWith('..')) {
          skipped.push(raw)
          continue
        }
        // 官方 fileMention 的口径：含引号的路径退回原样文字（不是合法 @）——进 skipped
        const mention = relativePath.includes('"')
          ? null
          : /\s/.test(relativePath) ? `@"${relativePath}"` : `@${relativePath}`
        if (mention === null) {
          skipped.push(raw)
          continue
        }
        mentions.push(mention)
      }
      return { mentions, skipped }
    },
  }
}

async function walk(current, root, depth, state, visit) {
  if (depth > WALK_DEPTH || state.count > WALK_LIMIT) return
  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (state.count > WALK_LIMIT) return
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const path = join(current, entry.name)
    state.count += 1
    if (entry.isDirectory()) {
      await visit({ path, kind: 'directory' })
      await walk(path, root, depth + 1, state, visit)
    } else if (entry.isFile()) {
      await visit({ path, kind: 'file' })
    }
  }
}

/** 官方 fileMention（editRequest.ts）的口径：无空格 @原样；有空格 @"引号闭合"；含引号不生成 @（null）。 */
export function fileMention(relativePath) {
  if (!/\s/.test(relativePath)) return `@${relativePath}`
  return relativePath.includes('"') ? null : `@"${relativePath}"`
}

/** 官方 @file 语法里的文件夹（补全列表）：引号不闭合、结尾带 /——网页版的补全菜单接着往下列子项。
 * 含引号的路径解析不了，返回 null。 */
export function directoryMention(relativePath) {
  if (relativePath.includes('"')) return null
  return /\s/.test(relativePath) ? `@"${relativePath}/` : `@${relativePath}/`
}

function fileError(target, error) {
  if (error?.code === 'ENOENT') return new FileNotFoundError(`文件不在了：${basename(target)}`)
  return new FileNotFoundError(`文件读不了：${error?.message ?? '未知原因'}`)
}
