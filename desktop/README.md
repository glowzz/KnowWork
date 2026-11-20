# KnowWork 桌面端

内嵌网页版的外壳（Electron）：深链连接、系统浏览器登录（OAuth 授权码 + PKCE）、令牌入安全存储、
内嵌网页版带登录态。设计见仓库 `docs/desktop.md`（M3 节）。

## 结构

```
src/main/
├── index.mjs          # Electron 胶水：窗口、单实例、深链、登录编排、Cookie 注入（只有这里碰 electron）
├── secure-store.mjs   # safeStorage 加密文件存储（无钥匙串的 Linux 明文回退）
├── config.mjs         # 服务地址与设备身份的持久化（纯逻辑）
├── deeplink.mjs       # knowwork://connect 解析（纯逻辑）
├── tokens.mjs         # 令牌存取 + 快过期刷新 + 按受众换（纯逻辑）
├── auth/
│   ├── pkce.mjs       # RFC 7636（纯逻辑）
│   ├── loopback.mjs   # 回环监听收授权码（RFC 8252 7.3，纯逻辑）
│   ├── client.mjs     # 授权码/刷新/令牌交换三种 grant（纯逻辑）
│   └── login.mjs      # 登录编排（纯逻辑）
└── resources/connect.html  # 连接页（手工填地址或等待深链）
src/preload/index.cjs # 外壳桥：window.knowworkShell.origin + window.knowworkDesktop
tests/                # node:test，20 个用例（纯逻辑全量；Electron 胶水不进单测）
```

纯逻辑模块零依赖、零构建（同 runtime-host 的路子）；`login` 编排的浏览器一步是注入的，
测试里用抓地址的 fetch，壳里是 `shell.openExternal`。

## 登录态怎么到内嵌网页版

网页版吃 Cookie 会话（`kw_session`）。壳用原生登录换取扩展登记的 `desktop-session` 受众
（`extensions/desktop` 的换令牌受众），拿到一张网页会话令牌，设成服务地址上的 Cookie——
系统浏览器批一次授权，壳里就是登录着的。重启时刷新令牌静默续期，续不上才再走一次浏览器。

## 开发与打包

```sh
npm install          # 会下载 Electron 二进制（约 110MB；解压失败时见下）
npm test             # node:test，纯逻辑，无显示也能跑
npm start            # 需要桌面环境（浏览器授权、加载网页版）
npm run dist         # electron-builder：Mac（arm64 dmg/zip）与 Windows（x64 nsis/zip），见 electron-builder.yml
```

- `npm install` 后若 `node_modules/electron/dist` 缺二进制（只剩 `locales`）：缓存里的 zip 在
  `~/.cache/electron/`，手动解压到 `node_modules/electron/dist/` 并写 `path.txt`（内容 `electron`）。
- 深链：`knowwork://connect?server=https://…&name=…`（打包后由系统注册；开发期手动触发看
  `electron-builder.yml` 的 `protocols` 与各平台注册差异）。
- 这一版安装包不签名：Mac 首次打开在「系统设置 → 隐私与安全性」放行，Windows 提示「未知发布者」。

## M3 之后

- M4：本机宿主托管（`resources/node` 起设备宿主）、每一轮的 prepare→喂宿主→事件回传、审批/提问通知。
- M5：文件能力（工作文件夹、@ 补全、拖入拖出、Office 预览）走同一座桥（`knowworkDesktop`）补。
- M6：`/desktop/` 更新清单对接（启动检查、下次打开安装）与交付包。
