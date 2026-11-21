/**
 * KnowWork 桌面端主进程。
 *
 * M3：深链连接、系统浏览器登录（OAuth 授权码 + PKCE）、令牌入 safeStorage、内嵌网页版带登录态。
 * M4：本机宿主托管（自带 Node 起官方 dsh 设备配置档）、本机对话编排（prepare → 喂宿主 → 事件回传）、
 *     审批/提问/三档访问方式的桥接、等审批提问的系统通知。
 *
 * Electron 的东西都在这个文件与 preload；纯逻辑（PKCE、回环、令牌客户端、宿主托管、事件中继、编排）
 * 在旁边、零依赖可测。
 */

import { randomBytes } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { BrowserWindow, app, dialog, ipcMain, Notification, safeStorage, shell } from 'electron'
import pkg from 'electron-updater'
const { autoUpdater } = pkg
import { createBusinessApi } from './api.mjs'
import * as oauthClient from './auth/client.mjs'
import { parseServer } from './auth/client.mjs'
import { browserLogin } from './auth/login.mjs'
import { clearServer, loadOrCreateDevice, loadServer, saveServer } from './config.mjs'
import { parseConnectUrl } from './deeplink.mjs'
import { assembleProfileHome, startHostProcess, superviseHost } from './host.mjs'
import { createFileOps } from './files.mjs'
import { createFolders } from './folders.mjs'
import { convertToPdf } from './office.mjs'
import { createHostClient } from './host-client.mjs'
import { createNotifier } from './notify.mjs'
import { createRelay } from './relay.mjs'
import { createEncryptedStore } from './secure-store.mjs'
import { createTokens, NotLoggedIn } from './tokens.mjs'
import { createUpdater } from './update.mjs'
import { createConversations } from './turns.mjs'

const SCHEME = 'knowwork'
const SESSION_COOKIE = 'kw_session'  // 业务服务身份模块的固定 Cookie 名（IdentityConfig 默认，主线不可配）

app.setAsDefaultProtocolClient(SCHEME)

let window = null
let server = null
let folders = null
let runtime = null  // 登录后的运行件：{ tokens, api, relay, conversations, supervisor }
/** 启动参数或 second-instance 带来的深链：还没准备好应用时先收住。 */
let pendingConnect = null

const log = (...parts) => console.log(new Date().toISOString(), ...parts)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find(value => typeof value === 'string' && value.startsWith(`${SCHEME}:`))
    if (url) handleConnect(url)
    if (window !== null) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleConnect(url)
  })
  app.on('window-all-closed', () => {
    app.quit()  // 桌面端没有后台形态：关窗即退出（宿主进程随主进程收掉）
  })
  app.whenReady().then(start).catch(error => {
    log('启动失败：', error)
    app.quit()
  })
}

function parseArgvUrl(argv) {
  return argv.find(value => typeof value === 'string' && value.startsWith(`${SCHEME}:`)) ?? null
}

/** 本机宿主的运行时（runtime-host 仓库）与 Node：打包后随应用带，开发期指向仓库与机器上的 Node 24+。 */
function resolveRuntime() {
  const runtimeRoot = process.env.KNOWWORK_RUNTIME_ROOT
    ?? (app.isPackaged ? join(process.resourcesPath, 'runtime-host') : join(app.getAppPath(), '..', 'runtime-host'))
  return {
    runtimeRoot,
    // 打包态用 PATH 里前置的自带 Node。开发态优先 npm 带进来的 node 绝对路径（npm_node_execpath——
    // 裸 'node' 在 Windows 的 Electron 里 spawn 不着，实测 ENOENT；Electron 自带的 Node 只有 22，
    // 低于 runtime-host 的 engines >=24.9，只作兜底并用 ELECTRON_RUN_AS_NODE 跑，见 startDeviceSide）
    nodePath: process.env.KNOWWORK_NODE
      ?? (app.isPackaged ? 'node' : process.env.npm_node_execpath ?? process.execPath),
    // dsh 的真实 JS 入口：.bin 里的包装脚本是给 shell 的，node 跑不了
    dshCli: join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    templateDir: join(runtimeRoot, 'profile-device'),
    pluginsDir: join(runtimeRoot, 'plugins'),
  }
}

async function start() {
  const userData = app.getPath('userData')
  server = await loadServer(join(userData, 'server.json'))
  pendingConnect ??= parseArgvUrl(process.argv)

  window = new BrowserWindow({
    width: 1120,
    height: 760,
    title: 'KnowWork 桌面端',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: server === null ? [] : [`--knowwork-origin=${server}`],
    },
  })
  window.once('ready-to-show', () => window.show())
  guardNavigation(window)
  window.on('focus', () => window.flashFrame(false))

  ipcMain.handle('knowwork:connect', (_event, address) => applyServer(address, userData))
  ipcMain.handle('knowwork:login', async () => {
    if (server === null) return { ok: false, error: { message: '先填服务地址' } }
    try {
      await enter(server, userData, { forceLogin: true })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorOf(error) }
    }
  })
  ipcMain.handle('knowwork:ready', () => {
    sendState({ kind: 'need-server', server })
    if (server !== null) void enter(server, userData).catch(error => {
      log('自动进入失败：', error)
      sendState({ kind: 'need-server', server })
    })
    return true
  })
  // 更新的两个 IPC 也按 {ok} 形状答（前端/调试才拿得到失败原因）
  ipcMain.handle('knowwork:download-update', async () => {
    try {
      if (updater === null) return { ok: false, error: { message: '还没有连接到服务端' } }
      await updater.download()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorOf(error) }
    }
  })
  ipcMain.handle('knowwork:install-update', () => {
    if (updater === null) return { ok: false, error: { message: '还没有连接到服务端' } }
    updater.installAndRestart()
    return { ok: true }
  })

  // 本机对话的桥（M4/M5）：网页版的「本机」来源经 preload 调到这里；文件能力按每段对话的工作文件夹解析
  folders = createFolders({ file: join(app.getPath('userData'), 'conversation-folders.json'), log })
  const fileOps = createFileOps({ folders, office: { convertToPdf: (source, options = {}) => convertToPdf(source, { ...options, sofficePath: resolveSoffice() }) }, dialog, shell, log })
  const conversationCall = handler => async (_event, ...args) => {
    try {
      if (runtime === null) throw new Error('还没有登录，或宿主没有就绪')
      return { ok: true, ...(await handler(...args)) }
    } catch (error) {
      return { ok: false, error: errorOf(error) }
    }
  }
  ipcMain.handle('knowwork:start-conversation', conversationCall(async payload => {
    // 工作文件夹是文件能力的安全边界根：主进程自己校验（绝对路径 + 存在且是目录），不信任渲染进程的任意字符串
    if (typeof payload.folder !== 'string' || !isAbsolute(payload.folder)) {
      return { ok: false, error: { message: '工作文件夹要用绝对路径' } }
    }
    try {
      if (!(await stat(payload.folder)).isDirectory()) {
        return { ok: false, error: { message: '工作文件夹不是一个目录' } }
      }
    } catch {
      return { ok: false, error: { message: '工作文件夹不存在' } }
    }
    const conversation = await runtime.api.createConversation(payload.workspaceId, payload.title ?? '')
    await folders.set(conversation.id, payload.folder)
    await runtime.conversations.send(conversation.id, payload.turn)
    return { id: conversation.id }
  }))
  // 文件能力（M5）：读原件、转 PDF（预览）、另存、用本机程序打开、@ 补全、拖入转 @ 路径
  const bytes = value => Buffer.from(value)
  ipcMain.handle('knowwork:files-read', conversationCall(async (conversationId, path) => ({
    bytes: bytes(await fileOps.read(conversationId, path)),
  })))
  ipcMain.handle('knowwork:files-pdf', conversationCall(async (conversationId, path) => ({
    bytes: bytes(await fileOps.pdf(conversationId, path)),
  })))
  ipcMain.handle('knowwork:files-save', conversationCall((conversationId, path) => fileOps.save(conversationId, path)))
  ipcMain.handle('knowwork:files-open', conversationCall((conversationId, path, how) => fileOps.open(conversationId, path, how)))
  ipcMain.handle('knowwork:files-references', conversationCall(async (conversationId, query) => ({
    references: await fileOps.references(conversationId, query),
  })))
  ipcMain.handle('knowwork:drop-files', conversationCall((conversationId, paths) => fileOps.mentionsForPaths(conversationId, paths)))
  ipcMain.handle('knowwork:send', conversationCall((conversationId, turn) => runtime.conversations.send(conversationId, turn)))
  ipcMain.handle('knowwork:cancel', conversationCall(conversationId => runtime.conversations.cancel(conversationId)))
  ipcMain.handle('knowwork:decide', conversationCall((conversationId, approvalId, allow, remember) =>
    runtime.conversations.decide(conversationId, approvalId, allow, remember)))
  ipcMain.handle('knowwork:answer', conversationCall((conversationId, questionId, answers) =>
    runtime.conversations.answer(conversationId, questionId, answers)))
  ipcMain.handle('knowwork:delete', conversationCall(conversationId => runtime.conversations.deleteConversation(conversationId)))
  ipcMain.handle('knowwork:set-access', conversationCall((conversationId, preset) => runtime.conversations.setAccess(conversationId, preset)))
  ipcMain.handle('knowwork:get-access', conversationCall(conversationId => runtime.conversations.access(conversationId)))
  ipcMain.handle('knowwork:access-catalog', conversationCall(() => runtime.conversations.accessCatalog()))
  ipcMain.handle('knowwork:can-continue', conversationCall(async conversationId => {
    if (runtime === null || runtime.supervisor.current === null) {
      return { reason: '本机宿主没有在运行，请稍等它起来或重启桌面端' }
    }
    return { reason: null }
  }))
  ipcMain.handle('knowwork:place', conversationCall(async conversationId => {
    const place = await runtime.api.place(conversationId)
    return { device: place.device }
  }))
  ipcMain.handle('knowwork:pick-folder', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
    return { ok: true, path: result.canceled ? null : result.filePaths[0] }
  })

  window.loadFile(join(import.meta.dirname, 'resources', 'connect.html'))
  window.show()

  // 启动参数里的深链（Windows/Linux）：页面就绪后再应用
  if (pendingConnect !== null) handleConnect(pendingConnect)
}

function handleConnect(raw) {
  pendingConnect = raw
  const parsed = parseConnectUrl(raw)
  if (parsed === null || window === null || !app.isReady()) return
  pendingConnect = null
  void applyServer(parsed.server, app.getPath('userData'))
}

async function applyServer(address, userData) {
  const origin = parseServer(address)
  if (origin === null) return { ok: false, error: { message: '服务地址要用 http(s) 的完整地址' } }
  server = origin
  await saveServer(join(userData, 'server.json'), origin)
  ensureUpdater(origin)
  updater?.setServer(origin)
  sendState({ kind: 'logging-in' })
  try {
    await enter(origin, userData)
    return { ok: true }
  } catch (error) {
    log('进入失败：', error)
    sendState({ kind: 'need-server', server: origin })
    return { ok: false, error: errorOf(error) }
  }
}

/** 从「当前令牌可用」到「重新走一遍浏览器」都进这里；成功后设 Cookie、加载网页版，并把本机宿主拉起来。 */
async function enter(origin, userData, { forceLogin = false } = {}) {
  const device = await loadOrCreateDevice(join(userData, 'identity.json'))
  const tokens = createTokens({
    server: origin,
    client: oauthClient,
    store: createEncryptedStore(join(userData, 'tokens.bin'), safeStorage, log),
  })
  if (forceLogin || !await tokens.loaded()) {
    await tokens.set(await browserLogin({ server: origin, browser: url => shell.openExternal(url), device }))
  } else {
    try {
      await tokens.access()
    } catch (error) {
      if (!(error instanceof NotLoggedIn)) throw error
      log('存的登录已失效，重新走浏览器：', error.message)
      await tokens.set(await browserLogin({ server: origin, browser: url => shell.openExternal(url), device }))
    }
  }
  // 原生登录已可用：换一张网页会话令牌设成 Cookie，内嵌网页版就是登录着的
  const webSession = await tokens.forAudience('desktop-session')
  await setSessionCookie(origin, webSession)
  server = origin
  sendState({ kind: 'ready' })
  await window.loadURL(origin)
  ensureUpdater(origin)
  void startDeviceSide(origin, userData, tokens, folders).catch(error => log('本机宿主启动失败：', error))
}

/** 本机宿主与对话编排：登录成功后就在后台拉起来（起宿主要几秒，别等第一次发消息）。 */
async function startDeviceSide(origin, userData, tokens, folders) {
  const api = createBusinessApi({
    server: origin,
    accessToken: () => tokens.access().then(current => current.accessToken),
  })
  // 等人的提示：宿主停下来等批准/回答、窗口又不在前台时
  const notifier = createNotifier({
    isFocused: () => window !== null && window.isFocused(),
    notify: kind => {
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: kind === 'approval' ? '有一项操作等你批准' : '智能体有一个问题等你回答',
          body: '回到 KnowWork 桌面端处理。',
        })
        notification.on('click', () => {
          window?.show()
          window?.focus()
        })
        notification.show()
      }
      window?.flashFrame(true)
    },
    log,
  })
  const relay = createRelay({ api, onFrame: frame => notifier(frame), log })
  const runtimeInfo = resolveRuntime()
  const home = join(userData, 'dsh-home')
  assembleProfileHome({ templateDir: runtimeInfo.templateDir, pluginsDir: runtimeInfo.pluginsDir, home })
  const hostToken = randomBytes(24).toString('hex')
  const model = await tokens.forAudience('model')

  const supervisor = superviseHost(async () => {
    const process_ = startHostProcess({
      nodePath: runtimeInfo.nodePath,
      dshCli: runtimeInfo.dshCli,
      home,
      env: {
        KNOWWORK_HOST_TOKEN: hostToken,
        KNOWWORK_HOST_PORT: '0',
        KNOWWORK_MODEL_PROVIDER: 'knowwork-gateway',
        KNOWWORK_MODEL_BASE_URL: `${origin}/api/model/v1`,
        KNOWWORK_MODEL_TOKEN: model.accessToken,
        // 开发态兜底用 Electron 二进制跑宿主（见 resolveRuntime）：env 里切到 Node 模式；真 node 不认这个变量
        ...(runtimeInfo.nodePath === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        // 打包态把自带 Node/Python 前置进 PATH：宿主起的 bash 与技能脚本找得到（分隔符按平台）
        ...(app.isPackaged
          ? {
              PATH: [
                ...(process.platform === 'darwin'
                  ? [join(process.resourcesPath, 'node', 'bin'), join(process.resourcesPath, 'python', 'bin')]
                  : [process.resourcesPath + '\\node', process.resourcesPath + '\\python',
                     process.resourcesPath + '\\python\\Scripts']),
                process.env.PATH ?? '',
              ].join(process.platform === 'win32' ? ';' : ':'),
            }
          : {}),
      },
      onExit: () => conversations?.hostRestarted(),
      log,
    })
    const ready = await process_.ready
    process_.client = createHostClient({ base: `http://127.0.0.1:${ready.port}`, token: hostToken })
    log('本机宿主就绪：', ready.port)
    return process_
  }, { log })

  const conversations = createConversations({ api, host: supervisor, relay, tokens, folders, log })

  // 模型网关令牌按期轮换（写进官方凭据服务，下一次模型请求生效）
  const rotateModel = async () => {
    try {
      const fresh = await tokens.forAudience('model')
      await supervisor.current?.client.rotateModelCredential(fresh.accessToken)
      setTimeout(() => void rotateModel(), Math.max(30_000, (fresh.expiresIn - 60) * 500)).unref?.()
    } catch (error) {
      log('模型令牌轮换失败，1 分钟后重试：', error)
      setTimeout(() => void rotateModel(), 60_000).unref?.()
    }
  }
  setTimeout(() => void rotateModel(), Math.max(30_000, (model.expiresIn - 60) * 500)).unref?.()

  runtime = { tokens, api, relay, conversations, supervisor, notifier, origin }
  await supervisor.ensure()
}

let updater = null

/** 自动更新（M6）：网关 /desktop/ 的清单，有新版只提示、装在退出时。服务地址定了才建（一次）。 */
function ensureUpdater(origin) {
  if (updater !== null) return
  updater = createUpdater({
    updater: autoUpdater,
    server: origin,
    log,
    onUpdate: state => {
      if (state.kind === 'available') {
        sendState({ kind: 'update', version: state.version })
        // 需求口径：提示更新，员工同意就下载（下载完成装在退出时；点通知可立即重启安装）
        const version = state.version ?? ''
        dialog.showMessageBox(window, {
          type: 'info',
          message: `发现新版桌面端 ${version}`,
          detail: '现在下载吗？下载完成后会在退出时安装，下次打开就是新版本。',
          buttons: ['现在下载', '以后再说'],
          defaultId: 0,
          cancelId: 1,
        }).then(({ response }) => {
          if (response === 0) updater.download()
        }).catch(error => log('更新对话框失败：', error))
      }
      if (state.kind === 'downloaded') {
        const notification = Notification.isSupported()
          ? new Notification({ title: '新版桌面端已就绪', body: '下次打开就是新版本；现在就装的话会重启应用。' })
          : null
        notification?.on('click', () => updater.installAndRestart())
        notification?.show()
      }
    },
  })
  updater.check()
}

function setSessionCookie(origin, webSession) {
  return window.webContents.session.cookies.set({
    url: origin,
    name: SESSION_COOKIE,
    value: webSession.accessToken,
    expirationDate: Math.floor(Date.now() / 1000) + webSession.expiresIn,
    httpOnly: true,
    secure: origin.startsWith('https:'),
  })
}

function sendState(state) {
  window?.webContents.send('knowwork:state', state)
}

function errorOf(error) {
  const status = typeof error?.status === 'number' ? error.status : undefined
  return { status, code: typeof error?.code === 'string' ? error.code : undefined, message: error?.message ?? '操作没有成功' }
}

function resolveSoffice() {
  // Office 引擎：打包用 resources/office 自带的 soffice（prepare-runtime 备齐），开发机 PATH 里
  if (process.env.KNOWWORK_SOFFICE) return process.env.KNOWWORK_SOFFICE
  if (!app.isPackaged) return 'soffice'
  const resources = process.resourcesPath
  if (process.platform === 'win32') {
    // Windows 的可执行带扩展名（spawn 不会自动补 .exe）
    return join(resources, 'office', 'program', 'soffice.exe')
  }
  if (process.platform === 'darwin') {
    // macOS：prepare-runtime 把 LibreOffice.app 的 Contents 拷到 resources/office/Contents
    return join(resources, 'office', 'Contents', 'MacOS', 'soffice')
  }
  return join(resources, 'office', 'program', 'soffice')
}

function messageOf(error) {
  if (error instanceof NotLoggedIn || error instanceof oauthClient.OAuthTokenError) return error.message
  return '登录没有完成，请稍后重试'
}

/** 站内新窗口交给系统浏览器（网页版 newWindowUrl 生成完整 http(s) 地址）；站内只许在服务地址里导航。 */
function guardNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (parseServer(url) !== null) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (server === null || !url.startsWith(`${server}/`)) {
      if (parseServer(url) !== null) void shell.openExternal(url)
      event.preventDefault()
    }
  })
  win.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write')
  })
}
