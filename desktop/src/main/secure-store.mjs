/**
 * 令牌的落盘存储：safeStorage（钥匙串/凭据管理器）加密后写 userData 下的文件。
 * 系统没有可用的加密（部分 Linux 桌面没有钥匙串）时退回明文并在日志里说明——用户可自行删掉该文件即退出登录。
 */

import { readFile, rm, writeFile } from 'node:fs/promises'

const MARKER = 'enc-v1:'

export function createEncryptedStore(file, safeStorage, log = () => {}) {
  async function load() {
    let raw
    try {
      raw = await readFile(file)
    } catch {
      return null
    }
    try {
      const text = raw.toString('utf8').startsWith(MARKER)
        ? safeStorage.decryptString(Buffer.from(raw.toString('utf8').slice(MARKER.length), 'base64'))
        : raw.toString('utf8')
      const tokens = JSON.parse(text)
      return typeof tokens.accessToken === 'string' ? tokens : null
    } catch (error) {
      log(`存储里的令牌读不出来，当作未登录：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  async function save(tokens) {
    if (typeof safeStorage.isEncryptionAvailable === 'function' && !safeStorage.isEncryptionAvailable()) {
      log('系统没有可用的加密存储：令牌按明文保存（删掉这个文件即退出登录）')
      await writeFile(file, JSON.stringify(tokens), 'utf8')
      return
    }
    const sealed = safeStorage.encryptString(JSON.stringify(tokens))
    await writeFile(file, MARKER + sealed.toString('base64'))
  }

  async function clear() {
    await rm(file, { force: true })
  }

  return { load, save, clear, file }
}
