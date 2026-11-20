/**
 * 深链（knowwork://connect?server=…&name=…）：网页「设置 → 桌面端」的「打开桌面端并连接」把服务地址带过来。
 * Windows 的壳参数会在 URL 后补斜杠、协议大小写不定，URL 解析都吃得下。
 */

import { parseServer } from './auth/client.mjs'

export const SCHEME = 'knowwork'

/** 解析深链：knowwork 的 connect 请求才认，服务地址要合法；其余（比如别的 knowwork 动作）返回 null 交给上层忽略。 */
export function parseConnectUrl(raw) {
  if (typeof raw !== 'string') return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${SCHEME}:` || url.hostname.toLowerCase() !== 'connect') return null
  const server = url.searchParams.get('server')
  const parsed = parseServer(server)
  if (parsed === null) return null
  const name = (url.searchParams.get('name') ?? '').trim()
  return { server: parsed, name: name ? name : null }
}
