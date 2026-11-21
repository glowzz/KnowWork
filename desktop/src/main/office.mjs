/**
 * Office → PDF 的转换（回答里的文件链接与交付卡片预览用）：自带引擎（打包的 LibreOffice），
 * 开发期 soffice 在 PATH 里也行。独立 UserInstallation 目录跑，避免和用户开着的 LibreOffice 抢配置。
 * 真实转换需要 soffice；单测用假的 soffice 脚本验证编排（输出定位、超时、失败）。
 */

import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export class OfficeError extends Error {}

/**
 * 把一份 Office 文件转成 PDF，返回字节。sofficePath 可注入（测试用假脚本）；转换在临时目录里做，
 * 用完即删。
 */
export async function convertToPdf(sourcePath, { sofficePath = 'soffice', timeoutMs = 120_000, log = () => {} } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), 'kw-office-'))
  try {
    const result = await runSoffice(sourcePath, outDir, { sofficePath, timeoutMs, log })
    if (result.code !== 0) throw new OfficeError(`转换没有完成（exit=${result.code}）：${result.stderr.slice(0, 300)}`)
    const produced = await findPdf(outDir)
    if (produced === null) throw new OfficeError('转换跑完但没有 PDF 产出')
    return await readFile(produced)
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}

async function runSoffice(sourcePath, outDir, { sofficePath, timeoutMs, log }) {
  // 独立用户目录：用户自己开着 LibreOffice 也不冲突
  const profile = mkdtempSync(join(tmpdir(), 'kw-office-profile-'))
  // -env:UserInstallation 是引导参数，放最前；路径用 pathToFileURL（Windows 的 file://C:\ 会畸形）
  const args = [
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    '--headless', '--norestore', '--invisible', '--nolockcheck',
    '--convert-to', 'pdf', '--outdir', outDir, sourcePath,
  ]
  try {
    return await new Promise((resolvePromise) => {
      const child = spawn(sofficePath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr?.on('data', chunk => { stderr += chunk })
      const timer = setTimeout(() => {
        child.kill()
        resolvePromise({ code: 'timeout', stderr: stderr + '\n转换超时' })
      }, timeoutMs)
      timer.unref?.()
      child.once('error', error => {
        clearTimeout(timer)
        resolvePromise({ code: 'spawn', stderr: `${error.message}` })
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        resolvePromise({ code: code ?? signal, stderr })
      })
    })
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(error => log('临时配置目录删不掉：', error))
  }
}

async function findPdf(outDir) {
  const names = await readdir(outDir)
  const pdf = names.find(name => name.toLowerCase().endsWith('.pdf'))
  return pdf === undefined ? null : join(outDir, pdf)
}
