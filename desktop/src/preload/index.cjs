/**
 * preload：给内嵌网页版的外壳桥。
 * - window.knowworkShell.origin：服务地址（web/src/utils/publicOrigin.ts 与 shellFileDrag.ts 的约定；
 *   页面在服务地址里加载时 location.origin 本来就对，桥主要给本地连接页与非页面代码用）；
 * - window.knowworkDesktop：连接与登录的页面流程（connect.html 用）+ 本机对话的桥（M4：网页版的「本机」
 *   来源经它把发消息、停止、审批、回答交到这台电脑上）。所有方法返回 {ok:true, ...} 或 {ok:false, error}；
 *   文件能力在 M5 按同一座桥补。
 * 沙箱开启的 preload：只拿 ipcRenderer 与命令行里的参数。
 */

const { contextBridge, ipcRenderer } = require('electron')

const argvArgument = (name) => {
  const prefix = `--${name}=`
  const argument = process.argv.find(value => typeof value === 'string' && value.startsWith(prefix))
  return argument === undefined ? '' : argument.slice(prefix.length)
}

contextBridge.exposeInMainWorld('knowworkShell', {
  origin: argvArgument('knowwork-origin') || undefined,
})

const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('knowworkDesktop', {
  /** 连到某个服务地址（含校验与登录编排）；ok 为假时 error.message 给人看。 */
  connect: invoke('knowwork:connect'),
  /** 重新打开系统浏览器走一次登录。 */
  login: invoke('knowwork:login'),
  /** 连接页就绪：主进程回当前状态（need-server/logging-in/ready）。 */
  ready: invoke('knowwork:ready'),
  onState: callback => {
    ipcRenderer.on('knowwork:state', (_event, state) => callback(state))
  },

  // —— 本机对话（M4）：网页版的「本机」来源把动作交到这台电脑上 ——
  /** 建本机对话并发第一轮：{workspaceId, title?, turn} → {id}。 */
  startConversation: invoke('knowwork:start-conversation'),
  /** 发一轮（turn 是网页版的 TurnRequest 原样，去掉附件）。 */
  send: invoke('knowwork:send'),
  cancel: invoke('knowwork:cancel'),
  /** 审批：{approvalId, allow, remember}。 */
  decide: invoke('knowwork:decide'),
  /** 回答提问：{questionId, answers}。 */
  answer: invoke('knowwork:answer'),
  delete: invoke('knowwork:delete'),
  /** 三档访问方式：切档、查当前、可选清单。 */
  setAccess: invoke('knowwork:set-access'),
  getAccess: invoke('knowwork:get-access'),
  accessCatalog: invoke('knowwork:access-catalog'),
  /** 这里能不能接着这段对话：reason 为 null 是能。 */
  canContinue: invoke('knowwork:can-continue'),
  /** 这段对话在哪台设备上（别处只读时的提示）：device 为 null 说不出。 */
  place: invoke('knowwork:place'),
  /** 选工作文件夹：弹系统目录选择框，返回 {path}（取消是 null）。 */
  pickFolder: invoke('knowwork:pick-folder'),
})
