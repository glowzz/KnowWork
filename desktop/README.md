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
├── folders.mjs        # 每段本机对话的工作文件夹注册表 + 路径解析（纯逻辑）
├── files.mjs          # 文件能力：读/转 PDF/另存/打开/@ 补全/拖入转 @（纯逻辑）
├── office.mjs         # LibreOffice 无头转换（Office → PDF 预览）
├── host.mjs           # 本机宿主托管：配置档组装 + 进程监督重启（M4，纯逻辑）
├── host-client.mjs    # 本机宿主 HTTP 客户端（M4）
├── api.mjs            # 业务服务设备路由客户端（M4）
├── relay.mjs          # 事件回传中继：分类、成批、断流续传（M4，纯逻辑）
├── turns.mjs          # 本机对话编排：prepare → 喂宿主 → 回传，审批/提问/三档（M4）
├── notify.mjs         # 等批准/回答且窗口不在前台时的提示判定（M4）
├── update.mjs         # 自动更新：网关 /desktop/ 清单，提示 + 退出时安装（M6）
├── auth/
│   ├── pkce.mjs       # RFC 7636（纯逻辑）
│   ├── loopback.mjs   # 回环监听收授权码（RFC 8252 7.3，纯逻辑）
│   ├── client.mjs     # 授权码/刷新/令牌交换三种 grant（纯逻辑）
│   └── login.mjs      # 登录编排（纯逻辑）
└── resources/connect.html  # 连接页（手工填地址或等待深链）
src/preload/index.cjs # 外壳桥：window.knowworkShell.origin + window.knowworkDesktop
scripts/
├── prepare-runtime.mjs     # M6：备齐 resources/（runtime-host 树、独立 Node、Python、LibreOffice）
├── build-delivery.mjs      # M6：安装包 + 更新清单 → 交付目录（网关 /desktop/）
├── manifest.mjs            # 清单的 ESM 出口
└── smoke-real-host.mjs     # 真机冒烟：托管模块起真实 DSH 设备宿主 + 官方模拟模型服务
tests/                # node:test，58 个用例（纯逻辑全量 + 清单一致性 + 更新；Electron 胶水不进单测）
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

## 文件能力（M5）与本机对话（M4）

- 新对话选「本机」→ 选工作文件夹 → 发第一句：主进程 prepare（业务服务同一套准备）→ 带工作文件夹开会话
  → 发给本机宿主 → 事件成批回传业务服务（网页和手机只读实时可见）。
- 回答里的文件链接/交付卡片：读原件预览、Office 转 PDF（自带引擎）、另存、用本机程序打开、在文件管理器
  显示；拖进输入框的文件转 @ 路径（工作文件夹外的不外带）。
- 三档访问方式在会话页切换（DSH 官方权限预设，切换记录进会话日志）。

## 打包与交付（M6）

```sh
node scripts/prepare-runtime.mjs --platform darwin|win32   # 备齐 resources/（含独立 Node 与清单钉版）
npx electron-builder --mac --arm64 | --win --x64           # 出安装包（未签名）
node scripts/build-delivery.mjs                            # 安装包 + 更新清单 → deploy/html/desktop/（feed 根）
```

CI（`.github/workflows/desktop.yml`，手动触发）在 mac/win 构建机上跑：装依赖 → npm test → prepare →
electron-builder → 上传产物；交付包整理（build-delivery.mjs）是人工步骤。版本清单见
`desktop/resources-manifest.json`（与沙箱镜像的一致性由 `desktop/tests/manifest.test.mjs` 钉着）。
