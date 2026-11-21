/** 自动更新：generic feed 指向服务端的 /desktop/，只提示不自动下，下载完成装在退出时；错误不打断运行。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdater } from '../src/main/update.mjs'

function stubUpdater() {
  const calls = []
  const handlers = new Map()
  const on = (event, handler) => {
    handlers.set(event, handler)
  }
  return {
    calls,
    handlers,
    autoDownload: null,
    feedUrl: null,
    setFeedURL(feed) { calls.push(['feed', feed]); this.feed = feed },
    checkForUpdates: async () => {
      calls.push(['check'])
      handlers.get('update-available')?.({ version: '0.2.0' })
      return null
    },
    downloadUpdate: async () => {
      calls.push(['download'])
      handlers.get('update-downloaded')?.({ version: '0.2.0' })
      return []
    },
    quitAndInstall: () => { calls.push(['install']) },
    on: (event, handler) => {
      handlers.set(event, handler)
      return undefined
    },
  }
}

test('feed 指向服务端的 /desktop/，只提示不自动下', async () => {
  const updater = stubUpdater()
  const states = []
  createUpdater({ updater, server: 'https://kw.example.com', onUpdate: state => states.push(state) })
  assert.deepEqual(updater.calls[0], ['feed', { provider: 'generic', url: 'https://kw.example.com/desktop/' }])
  assert.equal(updater.autoDownload, false)
  await updater.checkForUpdates()
  assert.deepEqual(states, [{ kind: 'available', version: '0.2.0' }])
})

test('下载一次；下载完成的事件到了就不再重复下', async () => {
  const updater = stubUpdater()
  const handle = createUpdater({ updater, server: 'https://kw' })
  const done = new Promise(resolve => handle.onState(state => { if (state.kind === 'downloaded') resolve() }))
  await handle.download()
  await handle.download()  // 下载中重复触发不排队
  assert.deepEqual(updater.calls.filter(c => c[0] === 'download').length, 1)
  await done
})

test('setServer：feed 跟着换、下载标记重置后可从新 feed 再下', async () => {
  const updater = stubUpdater()
  const handle = createUpdater({ updater, server: 'https://kw' })
  await handle.download()
  updater.calls.splice(0)
  handle.setServer('https://kw-2.example.com')
  await handle.download()
  const feeds = updater.calls.filter(c => c[0] === 'feed').map(c => c[1].url)
  assert.equal(feeds.at(-1), 'https://kw-2.example.com/desktop/', 'feed 换到新服务地址')
  assert.ok(updater.calls.filter(c => c[0] === 'download').length >= 1, '重置后能重新下载')
})

test('installAndRestart 与错误事件', async () => {
  const updater = stubUpdater()
  const states = []
  const handle = createUpdater({ updater, server: 'https://kw', onUpdate: state => states.push(state) })
  handle.installAndRestart()
  assert.deepEqual(updater.calls.at(-1), ['install'])
  updater.on === undefined // noop
  // 错误经 on('error') 进来：转成 error 状态，不抛
  createUpdater({ updater: { setFeedURL() {}, on(event, handler) { if (event === 'error') handler(new Error('网络')) } }, server: 'https://kw', onUpdate: s => states.push(s) })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(states.some(state => state.kind === 'error' && state.message === '网络'))
})
