/** 深链：knowwork://connect 带服务地址与部署名；Windows 补的斜杠、大小写都收；别的动作返回 null。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConnectUrl } from '../src/main/deeplink.mjs'

test('标准形态：服务地址与部署名', () => {
  assert.deepEqual(parseConnectUrl('knowwork://connect?server=https://kw.example.com&name=总部'),
                   { server: 'https://kw.example.com', name: '总部' })
})

test('Windows 会补斜杠，协议大小写不定', () => {
  assert.equal(parseConnectUrl('KNOWWORK://connect/?server=http://10.0.0.2:8000/')?.server,
               'http://10.0.0.2:8000')
})

test('地址带路径：归一到源（对粘贴进来的宽容）', () => {
  assert.equal(parseConnectUrl('knowwork://connect?server=https://kw.example.com/nested')?.server,
               'https://kw.example.com')
})

test('非 http(s) 的服务地址不认', () => {
  assert.equal(parseConnectUrl('knowwork://connect?server=file:///etc'), null)
  assert.equal(parseConnectUrl('knowwork://connect?server=ftp://x'), null)
})

test('别的动作与残缺输入返回 null', () => {
  assert.equal(parseConnectUrl('knowwork://settings'), null)
  assert.equal(parseConnectUrl('knowwork://connect'), null)
  assert.equal(parseConnectUrl('https://kw.example.com/'), null)
  assert.equal(parseConnectUrl(''), null)
  assert.equal(parseConnectUrl(undefined), null)
})
