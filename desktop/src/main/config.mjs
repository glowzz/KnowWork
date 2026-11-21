/**
 * 连接的配置与设备身份的持久化（userData 下的两个小 JSON 文件）。文件读写都注入路径，
 * 纯逻辑部分（地址校验、身份名字）单独可测。
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { hostname, platform } from 'node:os'
import { parseServer } from './auth/client.mjs'

/** 服务地址：来自深链（knowwork://connect?server=…）或首屏手工输入，过 parseServer 校验后落盘。 */
export async function loadServer(file) {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    return parseServer(raw.server)
  } catch {
    return null
  }
}

export async function saveServer(file, server) {
  const origin = parseServer(server)
  if (origin === null) throw new Error(`服务地址不对：${server}`)
  await writeFile(file, JSON.stringify({ server: origin }, null, 2))
  return origin
}

export async function clearServer(file) {
  await rm(file, { force: true })
}

const PLATFORM_LABEL = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' }

export function deviceNameFor(host = hostname(), system = platform()) {
  const label = PLATFORM_LABEL[system]
  return label ? `${host}（${label}）` : host
}

/**
 * 设备身份：首次运行生成一个固定设备号（UUID）与给人看的设备名，之后一直用同一份——
 * 重装应用重登后 grant 换了、设备号不变，扩展据此认得这台电脑。
 */
export async function loadOrCreateDevice(file, { host = hostname(), system = platform() } = {}) {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    if (typeof raw.deviceId === 'string' && raw.deviceId.length > 0) {
      return { deviceId: raw.deviceId, deviceName: raw.deviceName || deviceNameFor(host, system) }
    }
  } catch {
    // 首次运行或文件坏了：重建
  }
  const device = { deviceId: randomUUID(), deviceName: deviceNameFor(host, system) }
  await writeFile(file, JSON.stringify(device, null, 2))
  return device
}
