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
  let downloadEpoch = 0  // setServer 换 feed 时自增：旧 feed 的在途下载完成后不再置「已下载」

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
    const stale = downloadEpoch
    downloaded = true
    downloading = false
    log('新版下载完成，退出时安装：', info?.version, stale === downloadEpoch ? '' : '（旧服务器的在途下载，已过时忽略）')
    if (stale !== downloadEpoch) return  // 旧 feed 的在途下载：feed 已换，装了就是跨服务器误装
    for (const listener of listeners) listener({ kind: 'downloaded', version: info?.version })
  })
  updater.on('error', error => {
    downloading = false
    log('更新出错：', error)
    for (const listener of listeners) listener({ kind: 'error', message: error?.message })
  })

  return {
    /** 服务地址变了（深链重连另一台服务器）：feed 跟着换、下载标记清零、代次自增——
     * 旧 feed 的在途下载完成后不会把「已下载」状态带回来（跨服务器误装的窗口被代次挡住）。 */
    setServer(origin) {
      downloading = false
      downloaded = false
      downloadEpoch += 1
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
