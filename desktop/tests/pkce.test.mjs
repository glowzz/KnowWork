/** PKCE：校验器字符集与长度合规，challenge 就是校验器的 S256 摘要（RFC 7636 4.2/4.3）。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createPkce } from '../src/main/auth/pkce.mjs'

test('challenge 是 verifier 的 S256 摘要，字符集合规', () => {
  const { verifier, challenge, method } = createPkce()
  assert.equal(method, 'S256')
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/)
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
})

test('两次生成互不相同', () => {
  assert.notEqual(createPkce().verifier, createPkce().verifier)
})
