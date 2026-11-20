# 桌面端实现方案（设计讨论稿）

> 整理于 2026-11-18，基于 v0.1.1 之后的代码现状（分支 `feature/mineru-4.1` 时刻）。
> 需求出处：上游公众号文章的桌面端发布说明（见附录 A）。
> **结论先行**：不新建仓库——设备宿主环境层（`runtime-host/plugins/desktop-host-bundle/`）与桌面壳（`desktop/`）落本仓，
> 扩展包进扩展仓；开源库的接缝已全部就位，要造的只有三块东西；落地从 M1（设备环境层，无头）开始。
> 仓库与 fork 维护的讨论结论见第 8 节。
>
> **落地进度**：M1 已完成（2026-11-19）——设备环境层、收件入口与 E1 测试全部落地并通过，
> 落地时的实现决定与踩坑记录见第 9 节；M2 已完成（2026-11-20）——扩展包落仓 `extensions/desktop/`
> （OAuth 登记、设备路由、令牌受众、空间开关与配额），记录见第 10 节；M3 已完成（2026-11-20）——
> 桌面壳落仓 `desktop/`（深链、系统浏览器登录、令牌入安全存储、内嵌网页版带登录态），记录见第 11 节；
> M4 已完成（2026-11-20）——本机对话全链路（宿主托管、事件回传、审批/提问/三档经桥、系统通知、
> 扩展前端包登记「本机」来源），记录见第 12 节。
> 文中早期的目录名 `dsh-host-device` 按仓库既有约定改成了 `desktop-host-bundle`。

---

## 1. 现状盘点：接缝已经齐了

文章里 v0.1.1 那半段（扩展接口、设备对话、来源、配额、插槽）本仓库已全部落地。桌面端要用的接缝：

| 已有 | 位置 | 桌面端怎么用 |
|---|---|---|
| 设备对话合同（建对话不开宿主、prepare_turn、收事件、断点续传、记审批授权） | `server/src/knowwork_server/conversations/device.py` | 桌面端唯一要对接的服务端契约 |
| OAuth 授权码 + PKCE（回调只认回环地址，RFC 8252）、设备号、设备列表 | `identity/oauth.py`、`oauth_clients.py`、迁移 0052/0053 | 登录与「在哪台电脑上」的显示 |
| 令牌交换 RFC 8693（受众 model、tools、skills） | `identity/oauth_exchange.py`（注释已写明「凭据只在桌面端主进程，照 DSH 官方桌面版的做法」） | 给本机宿主喂短期令牌 |
| 每会话回调令牌签发口（tools/skills 受众，公开入口 `/api/extensions/tools`、`/api/extensions/skills`） | `extensions/contract.py` 的 `device_tokens` | 本机宿主回调查知识库、技能 |
| 扩展合同（登记 oauth_clients / exchangers / device_conversations / quota / 管理路由） | `extensions/contract.py` | 桌面端扩展包的挂载点 |
| 前端来源抽象 + 插槽（`chat.sources`、`chat.place`、files 的 read/pdf/save/open/references、dropFiles） | `web/src/features/chat/sources.ts`、`web/src/slots/registry.ts` | 本机来源只做登记，界面零改动 |
| 外壳桥预留 | `web/src/utils/publicOrigin.ts`（`window.knowworkShell.origin`） | 桌面壳注入服务地址 |
| 网关 `/desktop/` 静态位置（安装包 + 更新清单，no-cache） | `deploy/gateway/nginx.conf` | 交付包落地点 |
| 用量配额口子（各端开轮前判定，429） | `conversations/quota.py` | 扩展 `quota.set` 时把设备对话算进去 |
| DSH 官方件 | `runtime-host/node_modules/@deepseek-ai/`：`dsh-permission-presets`、`dsh-fs-local`、`dsh-subprocess-local`、`dsh-bash-local`、`dsh-sandbox-local`、`dsh-sandbox-windows-acl`、`dsh-host-directory-picker-native`、`libreoffice-kit`、`dsh-credentials-local` | 设备环境层直接挂官方件，不自研 |

## 2. 总体架构

```
员工电脑（桌面端，Electron）                        业务服务
┌──────────────────────────────┐   每一轮先准备好   ┌─────────────────┐
│ 壳：窗口 = 内嵌网页版 + preload 桥 │ ─prepare_turn──▶ │ 扩展包（桌面端扩展）│
│ 主进程：登录、令牌、宿主托管、推送、通知 │ ◀─push 事件──  │  设备对话路由      │
│ 本机宿主（DSH，自带 Node，127.0.0.1）│ ──换短期令牌──▶ │  模型网关(公开位置) │
│   工作文件夹、本机文件与命令、三档权限 │               │ 对话记录、配额、技能 │
└──────────────────────────────┘                 └─────────────────┘
```

分工照需求：设备上是官方宿主 + 工作文件夹 + 自带 Python/Node；服务端管账号权限、每轮准备、短期令牌、模型网关、对话记录。
**对话页不写第二套**——壳里就是内嵌网页版，`chat.sources` 里登记「本机」来源即可。

## 3. 要造的三块

### 3.1 设备宿主环境层 `@knowwork/dsh-host-device`（runtime-host 里新增）

服务端层 `host-bundle` 的镜像操作，原则同为「只停用和插入，不改官方插件」。关键差异：

| 官方插件 | host-bundle（服务端） | device（设备） |
|---|---|---|
| `filesystem` / `subprocess` | 停用，换 remote-fs / remote-subprocess | **保留官方本机实现**（`dsh-fs-local`、`dsh-subprocess-local`） |
| bash / terminal / 工作目录 | 全停 | **全开**，工作目录 = 对话的工作文件夹，`dsh-bash-local` + `dsh-sandbox-local`（macOS seatbelt）/ `dsh-sandbox-windows-acl`（Windows） |
| `dsh-permission-presets` | 不挂 | **挂**：预设表配三档——`workspace-write`（默认「工作区内修改」）、只读档（「仅可查看」）、`danger-full-access`（「完全权限」），预设自带 sandbox+审批捆绑，切档是会话投影操作 |
| sdk-app / jsonrpc | 停用，HTTP 驱动 | 同样停用，仍走 `knowwork-http-host`（监听 127.0.0.1 + 随机令牌，主进程专用） |
| 凭据 | `credentials-local` + 网关令牌 | 同样 `credentials-local`；令牌由桌面主进程换好后经私有通道注入轮换 |
| 多用户适配层（owners/schedule） | 需要 | 不挂：一台宿主一个属主 |
| 技能 | `resourceRoot=/opt/knowwork`（镜像内） | 同一插件，`resourceRoot` 指向应用资源目录 |
| PTC 运行时 | 沙箱里的 dsh-ssh | 自带 Node + npm 全局 `dsh-ssh`/`dsh-ptc-runtime-node`（`DSH_VERSION` 同版，摘要校验照旧） |

profile 组合不变：`sdk-minimal + @knowwork/dsh-host（通用层，两处共用）+ @knowwork/dsh-host-device`。
服务端的 profile 不动，设备 profile 随桌面端打包。

测试照 `runtime-host/tests/` 的 E1 套路（真实 DSH + `dsh-llm-mock-server`），验证：本机读写限制在工作文件夹、
越界停下等审批、三档行为、事件序号与子 Agent 帧、断点续传。

### 3.2 桌面应用（Electron，本仓新目录 `desktop/`）

选 Electron 的理由：DSH 宿主是 Node 生态，Electron 自带 Node 与自动更新；官方桌面版同为壳 + 内嵌网页的做法；
`knowworkShell` 桥就是按这个设计的。

```
desktop/src/main/
  index.ts     窗口、单实例、托盘、深链（knowwork://connect?server=…）
  login.ts     起回环监听 → 系统浏览器授权（PKCE、device_id）→ 换令牌
  tokens.ts    刷新令牌存 safeStorage（钥匙串/凭据管理器）；按受众换 model/tools/skills，
               定时续期；每会话回调令牌随轮请求
  host.ts      用 resources/node（独立 Node 22.19+ 二进制，不依赖 Electron 的 Node）起本机宿主，
               只监听 127.0.0.1 + 随机令牌；崩溃重启；按 position() 续传事件
  turn.ts      建对话 → prepare_turn → （有 session 体先 provision）→ POST 轮 →
               收宿主事件流 → 批量（≤500）push 回业务服务，逐字片段走 push_live
  bridge.ts    contextBridge（knowworkDesktop）：选工作文件夹、files 的
               read/pdf/saveAs/open/reveal/references、dropFiles、访问档切换
  notify.ts    宿主等审批/提问且窗口不在前台 → 系统通知 + Mac Dock 跳动 / Win 任务栏闪烁
  update.ts    启动时拉 /desktop/ 清单（electron-updater generic provider，
               autoDownload=false + 装在退出时）——正好就是「下次打开时提示更新」
resources/     node/、python/（uv + 与 sandbox.Dockerfile 同一份钉版清单）、
               office/（LibreOffice 25.2，预览与生成走 libreoffice-kit）、dsh/（PTC 运行时）
```

要点：

- **UI 零新建**：窗口加载服务端网页版，preload 同时给 `knowworkShell.origin` 和 `knowworkDesktop` 桥。
  浏览器里扩展前端发现没有桥，本机来源自动退化为只读（`sources.ts` 的 `READ_ONLY` 路径现成）。
- **Office 引擎**：回答里文件链接的 PDF 预览走 `files.pdf` → 桥 → 主进程 `libreoffice-kit` 转换；
  自带技能用的还是同一套 `soffice.py` 资源脚本，只是 resourceRoot 指到应用内，两边产物一致。
- **Python 清单同源**：不改 `sandbox.Dockerfile`——桌面打包脚本直接从现有 Dockerfile 读 pip 清单生成自己的
  manifest，另加一个一致性测试（上游升版本时测试变红，提示同步）。用「新增检查」替代「修改上游文件」。

### 3.3 桌面端扩展包（Python 包 + 前端包，进扩展仓）

后端（`setup_api` / `ApiContext` 登记）：

- `oauth_clients`：登记桌面端应用（redirect 路径如 `/oauth/desktop/callback`，回环任意端口）；
- `oauth_exchangers`：model / tools / skills 三个受众（model 走直连网关，tools/skills 是按会话回调令牌）；
- `device_tokens`：`(空间, 会话, 用户) → 短期令牌`，计算与服务端会话同源；
- 设备路由（只认桌面端登录的 Principal）：建对话、`prepare_turn`、`push`/`push_live`、`position`、
  `remember_approval`；建对话时把 `oauth_device_id(grant_id)` 记下来，push 时核对是同一台设备；
- `quota.set`：设备对话并入（服务端已在各端开轮前调）；
- 「管理 → 桌面端」（`admin.nav` + `admin.routes`）：按空间开关本机会话，关掉时 `prepare_turn` 直接拒绝，
  网页对话不受影响。

前端（插槽登记，全部现成接口）：

- `chat.sources`：本机来源——`Picker`（选工作文件夹）、`Controls`（三档访问方式）、`limits`、
  `useBlocker`（未连接/空间已关闭）、`dropFiles`（拖进来转 @ 路径，不传文件）、`files`（read/pdf/save/open/references 全走桥）；
- `chat.place`：`describe()` 按对话查出设备名（`oauth_devices`），别处只读时提示「在『李雷的 MacBook Pro』上执行」；
- `settings.tabs`：**设置 → 桌面端**——按平台给下载链接（探 `/desktop/` 清单）+「打开桌面端并连接」按钮（深链带服务地址）；
- `app.sidebar.groups`：本机对话按工作文件夹分组（可选）。

浏览器里（没有桥）自动退化为只读：`check()` 返回「这段对话在创建它的电脑上执行，请到那台电脑上继续」。

## 4. 关键流程

1. **连接与登录**：网页设置页点「打开桌面端并连接」→ `knowwork://connect?server=…` → 壳打开 →
   主进程回环监听 → 系统浏览器登录（带固定 device_id）→ 拿刷新令牌入钥匙串。
2. **一轮**：壳里输入框发送 → 来源 `send()` → 桥 → 主进程 `prepare_turn`（服务端做 @ 核对、回答方式、
   运行配置、配额判定，超了回 429 文案直接显示在输入框上）→ 原样喂宿主 → 事件批量回传 → 网页/手机只读实时可见。
3. **审批/提问**：宿主官方审批与 `ask_user_question` → 帧随事件回传 → 对话页出卡片（与云端同一套）→
   点按钮 → 桥 → 主进程答宿主；勾「本会话内不再询问」先 `remember_approval`，宿主应答者经工具公开入口查到自动放行。
4. **断线恢复**：宿主有官方会话检查点；桌面重启后先 `position()` 再从宿主 `framesAfter` 补送，
   服务端按序号去重。
5. **更新**：启动拉清单比版本 → 提示 → 退出时装。未签名照需求写清放行步骤（Mac「系统设置 → 隐私与安全性」、
   Windows「未知发布者」）。

## 5. 安全要点

- 本机宿主只监听 127.0.0.1，带随机令牌，仅桌面主进程可调；
- 刷新令牌与各受众令牌只进主进程 + 系统 keychain（safeStorage）；宿主经 `credentials-local` 的轮换机制拿令牌，
  模型/工具/技能各换各的、都是短期；
- 会话回调令牌按 (空间, 会话, 用户) 签发、短期有效；工具/技能公开入口只认它；
- 事件回传鉴权：会话属主 + 登录 grant 对应的设备号，双重核对；重传按序号幂等；
- 服务端不在设备上执行代码、设备不碰服务端密钥；模型网关令牌按受众短签，网关自己校验；
- 三档权限默认「工作区内修改」，切「完全权限」要二次确认；macOS 用 seatbelt、Windows 用 ACL 落实，
  越界动作停下等审批（fail-closed）；
- 附件/知识库的提示词注入面与云端一致：每轮都在服务端准备，密钥不下设备。

## 6. 开源库要补的改动（都很小）

1. ~~模型网关的对外位置~~：**不需要了**——开源侧在登记原生应用时已经把模型网关挂到公开入口
   `/api/model/v1`（`app.py` 的 `router_from_settings(..., path_prefix=PUBLIC_PREFIX)`），走 `/api/` 现有转发，
   令牌校验不变（model 受众的交换器也是开源自动登记的）。M2 落地时确认，见第 10.2 节。
2. **打包脚本**：`scripts/` 里加一个交付包整理脚本（安装包 + 更新清单 → `html/desktop/<版本>/`），
   对应「解开放进部署目录，不用重启」。
3. **Python 清单一致性测试**（新增，不改 Dockerfile）：核对桌面 resources 的 Python/Node/LibreOffice 版本
   与 `deploy/docker/sandbox.Dockerfile` 的一致，上游升版本时变红提醒同步。

## 7. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | 设备环境层（无头，不起壳） | E1 测试：本机读写限工作文件夹、越界等审批、三档、事件序号/子 Agent 帧、续传 |
| M2 | 扩展包后端 | 登录登记、设备路由只认桌面端且核对设备、push 幂等、429 配额、空间开关 |
| M3 | 桌面壳：深链、登录、令牌、嵌网页 | 浏览器登录回到壳内已登录；重启免登 |
| M4 | 本机对话全链路 + 通知 | 壳里发一句，另一台机器的网页只读看到全程；审批/提问往返；后台通知 + Dock 跳 |
| M5 | 文件与 Office | @ 补全、拖入、另存、打开、PDF 预览；Word/Excel/PPT 产物与云端一致 |
| M6 | 打包与交付 | mac arm64 / win x64 安装包、`/desktop/` 交付包、更新提示、兼容矩阵（老桌面连新服务端） |

M1 是技术核心且完全不依赖 Electron，可以最先无头跑通。服务端契约（`device.py` 那套 prepare/push/position +
事件帧）从 M1 起按 v1 冻结——这是「旧桌面端连新服务端照样能用」的根基。

## 8. 仓库与维护决策（讨论结论）

### 8.1 要不要新建 repo —— 不用

三块东西两处放，都在现有仓库体系里：

| 东西 | 放哪 | 理由 |
|---|---|---|
| 设备宿主环境层 `dsh-host-device` | 本仓 `runtime-host/plugins/` | 它就是宿主插件，跟 `host-bundle` 同一套机制；DSH 版本钉（0.2.1-rc.2）、profile 组合、E1 测试全在 runtime-host，分开放必然版本漂移 |
| 桌面壳（Electron） | 本仓新目录 `desktop/` | 和 `runtime-host`、`web` 耦合最紧：壳打包直接引用 `../runtime-host` 组出来的 profile 树；preload 桥契约和 `sources.ts` 是一份契约，要能原子地一起改 |
| 桌面端扩展包 | 扩展仓（不新建） | 按仓库约定，扩展本来就不在开源库里（入口组 `knowwork.extensions`、`KNOWWORK_WEB_EXTENSIONS` 指到外部包）——跟现有扩展放同一个仓 |

「以后不是每一版都出桌面端」靠**版本解耦**解决，不靠仓库解耦：桌面端在 `desktop/` 里独立版本号、独立打 tag
（如 `desktop-v0.1.0`），CHANGELOG 单独放 `desktop/CHANGELOG.md`。CI 用路径过滤：只在 `desktop/**` 变动时
才跑 mac（arm64）/win（x64）的 electron-builder 任务；安装包产物进交付包，不进仓库。

什么时候才值得拆仓库：桌面端要闭源而主仓继续开源、多人分工需要权限隔离、原生模块把主仓 CI 拖垮。
届时把 `desktop/` 整目录挪走、CI 加一步拉 runtime-host 的 profile 构建产物即可（桥契约和设备对话契约按版本冻结）。

### 8.2 fork 维护：跟上游同步

本仓是 fork，要持续 pull 主仓（upstream）。原则：**本地改动尽量只增不改，必须改上游文件的地方登记成清单，
合并走 merge 不走 rebase**。

远端与分支模型：

```sh
git remote add upstream <主仓地址>
git fetch upstream --tags --prune

git switch main                 # main 就是集成分支
git merge upstream/main --no-ff # 跟着上游发版同步
# 冲突处理 → 跑 server pytest / web vitest / runtime-host npm test → push
```

- 上游历史原样保留合并进来，不 rebase 自己的 main、不 squash 上游提交；
- 功能分支做完先并回 main，再接上游；别让长命分支跨着一次上游同步。

桌面端工作对上游的冲突面：

| 改动 | 冲突面 |
|---|---|
| `runtime-host/plugins/dsh-host-device/` | 零：全新目录 |
| `desktop/` | 零：全新目录，版本号、CHANGELOG 都独立在目录里 |
| web 界面（本机来源、设置页、管理页、chat.place） | 零：全走扩展包 + 现有插槽机制，`web/src` 一行不碰 |
| 网关 `/model-gateway/` 位置 | 唯一一处改上游文件（`nginx.conf` 加一个 location 块） |
| Python 清单同源 | 不改 `sandbox.Dockerfile`，用一致性测试替代（见 3.2） |
| 迁移 | 见下 |
| `CHANGELOG.md` | 每次必有冲突，认了：上游的版本节照抄进来，自己的节保留 |

迁移编号约定（建议趁早换）：自己的迁移从预留号段开始（**8001** 起），链在合并当时上游的 head 后面；
上游再出新迁移也不冲突，只需把自己第一条迁移的 `down_revision` 改成新上游 head——一行改动，
不用再改号、不用动升级说明。已发给用户的 0055 不动，从下一条开始换约定。

两件省力的事：

- **差异清单**：在 `CONTRIBUTING.md`（或单独 `FORK.md`）维护「相对上游改过哪些文件」，
  每次同步后跑 `git diff upstream/main...main --stat -- ':!CHANGELOG.md'` 补录；升级审查只聚焦这张清单；
- **自动同步 PR**：定时 workflow（cron）fetch upstream，有新提交自动开「sync: upstream vX.Y.Z」PR 到 main。

上游将来也会做自己的桌面端：我们的实现里服务端契约只用开源仓已有的 `device.py` 接口，真要对齐时，
替换成本收敛在扩展包和 `desktop/` 两个「上游没有的目录」里，主干不伤筋动骨。

## 9. M1 落地记录（2026-11-19）

### 9.1 落了什么

| 东西 | 位置 | 说明 |
|---|---|---|
| 设备环境层 | `runtime-host/plugins/desktop-host-bundle/` | 纯配置包（与 host-bundle 同构：patch + 空 index.js）。基于 `dsh-base`——本机执行世界、官方沙箱（macOS seatbelt / Windows ACL / Linux bwrap/Landlock）、审批、提问、权限预设都是 base 自带，环境层只改配置 |
| 设备收件入口 | `runtime-host/plugins/dsh-host/src/device-host.mjs`（exports `./device-host`） | 与 http-host 同源：合同收在 `intake.mjs`（同一份）、审批/提问收在 `answers.mjs`（同一份）、事件流/令牌轮换/模型清单同构。差异只有两处：会话工作目录随开会话合同来（`cwd` 字段，桌面主进程补）；多按会话查/切访问档（`GET/POST /v1/sessions/{id}/access`、`GET /v1/access`） |
| 设备配置档 | `runtime-host/profile-device/` | bundles：`dsh-base + @knowwork/dsh-host + @knowwork/desktop-host-bundle` |
| E1 测试 | `runtime-host/tests/e1-device.test.mjs` | 5 个用例全过：工作文件夹内读写/命令直接执行不问；工作区外等批准（批准落盘、拒绝不落盘）；三档行为与切换记录进会话日志；恢复会话历史与档位都在；缺令牌拒启、错令牌 401 |
| harness | `tests/support/harness.mjs` | 支持按 profile 起宿主（`options.profile`）；设备测试的模型走配置档里的 knowwork-gateway provider；失败即杀子进程（`readyTimeoutMs`） |

### 9.2 实现决定

- **环境层定名 `@knowwork/desktop-host-bundle`**：`common.patch.yml` 头注释里既定的名字（通用层之前就写好了两种宿主的分工），不叫 `dsh-host-device`。
- **收件入口放 `dsh-host/src/` 而不是环境层包里**：环境层是纯配置包（host-bundle 的先例：remote-fs/remote-subprocess 逻辑都在 dsh-host），避免跨包 import 的解析问题（插件目录不在 node_modules 里，靠 harness 软链进 profile）。
- **Agent 生灭走 `ctx.agents` 直驱（同 http-host）**：intake.mjs 注释设想的「官方会话控制器」（dsh-api-session-controller）依赖 web 栈一串件（connection、file-references、workspace、preset roster），桌面没有它的客户端；M1 先直驱，接口面不变，桌面壳阶段再评估是否换。
- **三档映射**：`workspace-modify = {workspace-write, ask}`、`view-only = {read-only, never}`、`full-access = {danger-full-access, never}`。view-only 的审批故意配 `never`：`never` 把越权提升一律拒绝不问，杜绝「问了、批了、写进去了」破掉只读；沙箱本身硬拒绝写入。切换/初装按官方机制记 `permission/preset`、`sandbox/mode`、`approval/policy` 三种会话事件，业务服务原样收到。
- **「允许的临时目录」**：官方沙箱的 `additionalWritableRoots`（seatbelt/bwrap/Landlock 都认），环境层从 `KNOWWORK_SANDBOX_EXTRA_DIRS`（冒号分隔）读，桌面壳阶段再定具体目录。

### 9.3 踩坑与机制备忘

- **模拟模型服务只吃 `/v1/messages`**（Anthropic 风格），而设备配置档里的 knowwork-gateway 是 `openai-completions`（真实网关是 OpenAI 兼容）。设备 patch 的 `api` 留了 `KNOWWORK_MODEL_API` 覆盖口，测试里换 `anthropic-messages` 对准模拟服务。
- **`bash`/`write` 等工具的 `description` 必填**：模拟模型的工具调用参数缺它会 `invalid arguments` 直接报错，轮次照常结束，很容易误判成「档位没生效」。
- **模拟模型 `repeatLast` 只重复序列末项**：要跑几轮工具调用就得显式写足几组 `['tool_call_success', 'success']`；否则后续轮次是纯文本回复，看起来像「工具没执行」。
- **cordis 插件装配失败不会退出宿主进程**（例如缺令牌、配置错）：条目不激活、进程继续挂着。所以「缺令牌直接拒绝启动」要靠调用方的就绪超时兜底；harness 对起不来的宿主 SIGKILL 并关模拟服务，不然子进程与句柄漏进后续用例、整个测试进程退不出去。
- **bwrap 的 `/tmp` 是沙箱内临时盘**（workspace-write 下可写但不落盘）：「工作区外」的测试落点要用 `/var/tmp`（宿主根只读，写入走提升），不能放 `/tmp`。
- **profile 里捆绑包的软链名是包名、不是目录名**：harness 把 `plugins/host-bundle` 链成 `@knowwork/dsh-host-bundle`——链名写成目录名时整个环境层静默丢失（dsh 只警告 skip，组合缺了 HTTP 驱动就没有就绪行，表现为全部用例 60 秒就绪超时）。设备层的目录名恰好等于包名才没暴露；服务端回归测出来后已修。
- **DSH 官方件确认**：`dsh-permission-presets`（预设表 + `ctx.permissionPresets.set/current/catalog`）、`dsh-sandbox-local`（Linux 上 bwrap→Landlock 链，本机有 bwrap 0.9.0）、`dsh-bash-sandbox`（提升字段 `sandbox_permissions`/`justification`，拒绝标记与提升提示有固定文案）、`dsh-tool-fs`（`write` 的 `file_path`/`content`，覆写要先读）。
- **服务端回归**：harness 改动后 `e1-admission` 照跑（见本节末的验证记录）。

## 10. M2 落地记录（2026-11-20）

### 10.1 落了什么

扩展包落仓 `extensions/desktop/`（Python 包 `knowwork_desktop`，入口组 `knowwork.extensions`，装了即启用）：

| 部分 | 位置 | 内容 |
|---|---|---|
| 扩展对象 | `src/knowwork_desktop/extension.py` | 装配时登记 OAuth 客户端（`knowwork-desktop`，回调路径 `/oauth/desktop`）、tools/skills 两个受众的交换器、用量配额判定；挂上设备路由 |
| 设备路由 | `src/knowwork_desktop/routes.py`（`/api/desktop`） | 建对话、开会话合同、准备一轮、收事件/逐字片段、查游标、记审批授权、对话模型清单、`/place`（别处只读的设备名提示）、DELETE（扩展收回）、管理路由 `admin/space/{workspace_id}/settings` |
| 两张表 | `src/knowwork_desktop/tables.py` + 迁移 `desktop_0001` | `desktop_conversation`（本机会话的设备绑定）、`desktop_space`（空间开关与月度轮次上限）；分支 `desktop` 接在主线 0055 之后 |
| 存储层 | `src/knowwork_desktop/store.py` | 绑定与开关的读写、自然月区间 |
| 测试 | `server/tests/desktop/`（conftest 把扩展 src 加进 import 路径） | 12 个用例全过：闸门（只认桌面端登录、设备比对、属主 404）、空间开关拦建对话与准备一轮但不拦历史与事件、事件序号与子会话游标、交换受众的四道闸、管理接口权限、配额 429 说法与恢复日期、删除解绑、迁移分支幂等 |

### 10.2 实现决定

- **开源侧比原计划多做完了三件事**（`app.py`）：`device_tokens` 签发器（tools/skills，同一套计算、去掉服务端沙箱工具）、模型受众的交换器（登记了原生应用就自动登记）、公开回调路由（`/api/extensions/tools`、`/api/extensions/skills`）与模型网关公开入口（`/api/model/v1`，走 `/api/` 现有转发，**不需要**原计划里的 nginx 改动）。扩展只负责闸门：对话归属、设备绑定、空间开关，过了就交给开源签发器。
- **设备绑定用设备号比对、不用 grant**：重装应用重新登录后 grant 换了、设备号不变，照样认得这台电脑；换台电脑拿着偷来的令牌则被拒。绑定表里 grant_id 只留档。
- **两张表不开行级安全**（同 `oauth_grant` 这类全局身份/配置表）：绑定查找发生在知道空间之前（按 conversation_id 找行），RLS 按 `current_setting('app.workspace_id')` 放行反而查不到；属主在代码里判，`Extension.rls_tables = ()`。
- **配额是空间级的月度轮次上限**（`desktop_space.monthly_turn_limit`，NULL 不限）：计数用业务服务的用量记录（`ApiContext.usage.turns`），各端一起算；登记经开源的配额口子（`quota.set`，只有一个名额），429 的 `detail()` 照 `QuotaExceeded.detail()` 的 code。
- **镜像接线留给 M6**：现在的镜像构建不装这个包（部署里还没有桌面端），装法写在 `extensions/desktop/README.md`（`uv pip install --no-deps`）。装上之后授权端点、公开回调路由即生效——所以和桌面应用一个版本走。
- **前端包**（`chat.sources` 登记、设置页、管理页）属 M3/M4，随桌面壳一起；`/place` 的数据端已就位。

### 10.3 踩坑与机制备忘

- **pgserver 的测试库跨用例不重建**（`create_all` 幂等但数据留着）：上一个用例关掉的空间开关会让后面所有 `a_conversation` 403。每个用例建独立空间（`world.ws`）。
- **`in_workspace` 是同步上下文管理器**（设 ContextVar，包住 async 查询没问题），不是 `async with`。
- **仓库的 API 惯例**：请求体 snake_case（同 `SendMessage`/`AuthorizeBody`），响应 camelCase（同设备视图 `_device_view`）。
- **准备一轮的错误映射直接用开源的 `TURN_REJECTIONS` + `turn_rejected`**（conversations/api.py）——注释明说扩展路由用同一套，QuotaExceeded 也在里面映射成 429。
- **测试里搭真实服务栈很便宜**：`ConversationService(FakeKernel(), sessionmaker, pump, feed)` + `DeviceConversations`，不碰宿主、不碰沙箱；`prepare_on_device` 不做任何内核调用，正好测路由闸门。

---

## 11. M3 落地记录（2026-11-20）

### 11.1 落了什么

桌面壳落仓 `desktop/`（Electron，纯逻辑 .mjs 零构建、零运行时依赖——同 runtime-host 的路子；Electron 胶水隔离在 `index.mjs` 与 `preload`）：

| 部分 | 位置 | 内容 |
|---|---|---|
| 纯逻辑 | `src/main/auth/`（pkce、loopback、client、login）、`config.mjs`、`deeplink.mjs`、`tokens.mjs` | PKCE、回环监听收授权码（RFC 8252 7.3）、三种 grant（授权码/刷新/RFC 8693）、登录编排、服务地址与设备身份持久化、令牌存取与快过期自动刷新 |
| Electron 胶水 | `src/main/index.mjs`、`secure-store.mjs`、`src/preload/index.cjs`、`resources/connect.html` | 单实例与深链（`knowwork://connect`，mac open-url / win second-instance）、连接页（深链预填或手工输入）、safeStorage 加密令牌文件、网页会话 Cookie 注入、加载服务端网页版；导航守卫（站内新窗口交系统浏览器、越界导航拒绝）、权限全拒 |
| 打包 | `electron-builder.yml` | Mac（arm64 dmg/zip）+ Windows（x64 nsis/zip），未签名；`protocols` 注册 knowwork 深链。M6 接交付 |
| 测试 | `tests/`（node:test） | 20 个用例全过：PKCE 合规、深链各种形态、回环收码/拒/state 串线/超时/关停、登录编排对 stub 授权服务全流程（PKCE 校验器被端点核对、拒绝路径）、令牌刷新与吊销清空、按受众换、加密存储往返与明文回退、配置与设备身份往返 |

### 11.2 实现决定

- **登录态怎么到内嵌网页版**（M3 的核心问题）：网页版吃 Cookie 会话（`kw_session`），开源没有 token→session 的交接。做法是扩展新增 `desktop-session` 换令牌受众——原生登录换一张网页会话令牌（`SessionService.create(method='desktop')`，时长照 `IdentityConfig` 默认），壳拿它设成服务地址上的 Cookie。系统浏览器批一次授权，壳里的网页版就是登录着的；重启时刷新令牌静默续期。**开源文件零改动**，全部走 M2 的扩展合同。
- **两份身份、一个账号**：主进程的原生 OAuth 身份（设备绑定、换受众令牌）与壳内网页版的 Cookie 会话（网页版自己的登录态）都指向同一个人；前者是设备对话的凭据来源，后者保证界面与云端完全同一套。
- **桌面壳选 Electron**（按方案第 3.2 节的理由）：DSH 宿主是 Node 生态、自带 Node 与自动更新、官方桌面同构；壳内直接加载服务端网页版（`window.knowworkShell.origin` 桥已预留），对话页零新建。
- **深链的宽容度**：Windows 会在 URL 后补斜杠、协议大小写不定；服务地址带路径时归一到源（对手工粘贴宽容）。
- **回环监听拒绝的竞态**：`done` 的拒绝可能早于编排 `await`（用户当场点拒绝、超时）——创建时就挂兜底 catch，否则 Node 把「暂无人处理的拒绝」当未捕获异常退进程（调试实录见测试）。
- **测试里的「浏览器」**：登录编排的浏览器一步是注入的（壳里 `shell.openExternal`），测试用抓地址的 fetch 顺着 302 打到回环监听——整条 RFC 8252 流程无显示环境即可验证。

### 11.3 环境备忘

- Electron 二进制下载（~110MB）在受限网络可能解压失败（dist 只剩 `locales`）：缓存在 `~/.cache/electron/`，手动解压到 `node_modules/electron/dist/` 并写 `path.txt`（内容 `electron`），见 `desktop/README.md`。
- 无显示环境跑不了壳本体；`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron --test tests/*.test.mjs` 可以用 Electron 自带的 Node 跑全套测试（20/20 验证过，自带 Node 22.21.1）。壳本体的验收在开发机上做：`npm start` → 深链或填地址 → 浏览器批准 → 壳内网页版已登录；重启免登。
- 运行时宿主要求 Node 24.9+（`runtime-host` 的 engines），桌面打包自带独立 Node 时按这个版本带（M4 接入）。

桌面端，对话在员工自己的电脑上执行。服务端版本里，智能体运行的命令和读写的文件，一律落在这段对话自己的沙箱容器里。
服务器是多人共用的，上面有数据库连接、密钥和别人的数据，附件和知识库里夹带的提示词不能碰到它。可是不少工作的材料
就在员工自己电脑上，比如一个项目文件夹、本机装的程序、不便上传的文件。桌面端是给这类工作准备的。

这一版有两个安装包，Mac（Apple 芯片）和 Windows（x64），从你们自己的服务端下载。员工在网页的「设置 → 桌面端」里下载，
点「打开桌面端并连接」会把服务地址带过去。登录走系统浏览器，和网页同一套账号。服务端换了新版桌面端，员工下次打开时
会提示更新。

开新对话时，输入框下面选「在哪执行」，选本机就再选一个工作文件夹。访问方式有三档，用的是 DSH 官方的权限预设。默认的
「工作区内修改」只能在工作文件夹和允许的临时目录里写，要超出这个范围就停下来请本人批准。「仅可查看」只读，「完全权限」
不再询问，切到完全权限前要再确认一次。

智能体停下来等批准或等人回答，窗口又不在前台时，桌面端会发系统通知，Mac 上 Dock 图标跳一下，免得一段对话卡在那里没人管。

员工电脑上跑的是 DSH 官方的宿主，桌面端用自带的 Node 把它起起来，只监听本机。模型和工具的密钥不落到员工电脑上。宿主要调
模型、查知识库时，桌面端拿员工自己的登录凭证去业务服务换短期令牌，模型、工具、技能各换各的。每一轮对话先由业务服务准备好
（@ 了哪些资料、这个人能不能用、用哪种回答方式，和网页上发消息走同一段准备），再交给本机的宿主去执行。执行中产生的事件原样
按顺序送回业务服务，所以本机对话也是业务服务里的一条普通对话，网页和手机上都看得到，只读，写明是在哪台电脑上执行的。
对话在员工的电脑上执行，账号、权限、模型和对话记录仍然在服务端。

分工：员工电脑上是 DSH 官方宿主、工作文件夹、自带的 Python 和 Node；业务服务管账号权限、每一轮的准备、短期令牌、
模型网关和对话记录。本机上，知识库和 @、技能、选模型、专家照常能用。工作文件夹里的文件能 @，能把文件拖进对话，
也能把交付的文件拖出去。桌面端自带 Python 和 Node，Python 的库和云端沙箱镜像是同一份清单、同一个版本，自带的
Word、Excel、PPT 技能在两边做出来的东西一样。Office 文件用桌面端自带的引擎预览和生成，员工电脑上不用另装 Office。

有的企业规定不能在个人电脑上执行：空间管理员在「管理 → 桌面端」里关掉本空间的本机会话就行，网页上的对话不受影响。

桌面端单独一个交付包，解开放进部署目录，不用重启服务。以后不是每一版都出桌面端，旧桌面端连新服务端照样能用。
这一版的安装包还没有签名：Mac 第一次打开要在「系统设置 → 隐私与安全性」里放行，Windows 会提示「未知发布者」。
