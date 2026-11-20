/**
 * PKCE（RFC 7636）：公开客户端不能存密钥，用一次性校验器与它的 S256 摘要对上授权请求。
 * 纯逻辑、不碰 Electron：登录编排与测试直接用。
 */

import { createHash, randomBytes } from 'node:crypto'

export function createPkce() {
  // 64 个 base64url 字符：够长、字符集是 RFC 7636 允许的非保留字符
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge, method: 'S256' }
}
