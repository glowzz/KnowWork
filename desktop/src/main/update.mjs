/**
 * 自动更新：网关的 /desktop/ 位置（deploy/gateway/nginx.conf）放安装包与更新清单（electron-builder 的
 * generic provider）。策略照需求——启动时检查、有新版只提示、下载完装在退出时（「下次打开时会提示更新」）。
 * electron-updater 注入（glue 里传真件，测试传替身）。
 */

export function createUpdater({ updater, server, log = () => {}, onUpdate = () => {} } = {}) {
  if (typeof updater?.setFeedURL !== 'function') throw new Error('需要 electron-updater 的 autoUpdater')
  updater.autoDownload = false        // 只提示，不自动下
  updater.autoInstallOnAppQuit = true // 下载完，退出时装（员工下次打开就是新版）
  updater.disableWebInstaller = true
  updater.setFeedURL({ provider: 'generic', url: `${server}/desktop/` })

  const listeners = new Set([onUpdate])
  let downloading = false
  let downloaded = false

  updater.on('update-available', info => {
    log('发现新版桌面端：', info?.version)
    for (const listener of listeners) listener({ kind: 'available', version: info?.version })
  })
  updater.on('update-not-available', () => {
    for (const listener of listeners) listener({ kind: 'none' })
  })
  updater.on('download-progress', progress => {
    for (const listener of listeners) listener({ kind: 'progress', percent: Math.round(progress?.percent ?? 0) })
  })
  updater.on('update-downloaded', info => {
    downloaded = true
    downloading = false
    log('新版下载完成，退出时安装：', info?.version)
    for (const listener of listeners) listener({ kind: 'downloaded', version: info?.version })
  })
  updater.on('error', error => {
    downloading = false
    log('更新出错：', error)
    for (const listener of listeners) listener({ kind: 'error', message: error?.message })
  })

  return {
    /** 服务地址变了（深链重连另一台服务器）：feed 跟着换，并清掉旧服务器的下载状态——
     * electron-updater 的「已下载待装」内部清不掉（autoInstallOnAppQuit 仍会装旧的），
     * 所以这里同时重置本层标记，让 download() 可以从新 feed 重新取；旧包残余由
     * electron-updater 自己的下一次下载覆盖，跨服务器误装的残余风险记录在此。 */
    setServer(origin) {
      downloading = false
      downloaded = false
      updater.setFeedURL({ provider: 'generic', url: `${origin}/desktop/` })
    },
    check() {
      void updater.checkForUpdates().catch(error => log('检查更新失败：', error))
    },
    async download() {
      if (downloading || downloaded) return
      downloading = true
      await updater.downloadUpdate().catch(error => {
        downloading = false
        log('下载更新失败：', error)
      })
    },
    installAndRestart() {
      updater.quitAndInstall()
    },
    onState(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
