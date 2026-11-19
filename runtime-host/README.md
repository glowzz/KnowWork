# KnowWork 运行时宿主

基于 DeepSeek Harness（DSH）官方配置档机制的宿主：

- `profile/`：宿主配置档模板，依次组合 `@deepseek-ai/dsh-sdk-minimal`、`@knowwork/dsh-host`（通用层）与 `@knowwork/dsh-host-bundle`（环境层）。
- `plugins/dsh-host/`：KnowWork 插件（收合同的逻辑 `intake.mjs` 与 HTTP 驱动、审批与提问转发、会话工具策略、技能门、技能提供方与专业工具解锁、工具桥、子 Agent 策略继承、测试工具）。它同时是一层配置：`common.patch.yml` 挂只认会话状态、和机器无关的通用插件（回答方式、知识库目录、每轮上下文、会话策略、技能、工具桥等），服务端宿主和用户设备上的本机宿主都挂这一份。
- `plugins/host-bundle/`：服务端宿主的环境层，停用官方 stdio 协议与本机 shell，插入 HTTP 驱动、会话容器里的文件与命令、官方审批服务、官方提问（`ask_user_question`）与待办（`todo_write`）、官方技能注册表与 `skill` 工具、多用户适配层。
- `profile-device/` 与 `plugins/desktop-host-bundle/`：桌面端本机宿主的配置档与环境层（见下节「本机宿主」）。
- `tests/`：E1 准入测试，真实 DSH 组合加官方 `dsh-llm-mock-server`。

## 运行

需要 Node 22.19 以上（本机用 nvm 的 v24.18.0）。

```sh
npm install
npm test
```

DSH 所有包锁定在 0.2.1-rc.2。

## 本机宿主（桌面端）

对话在员工自己的电脑上执行：配置档 `profile-device/` 依次组合 `@deepseek-ai/dsh-base`、`@knowwork/dsh-host`（通用层）
与 `@knowwork/desktop-host-bundle`（环境层）。官方 dsh-base 自带本机执行世界（本机文件与命令、沙箱、审批、提问、
工作目录）与权限预设，环境层只做三件事：

- **三档访问方式**照官方 `dsh-permission-presets` 配表：`workspace-modify`（工作区内修改，默认：写限工作文件夹，
  越界停下来等批准）、`view-only`（仅可查看：只读，审批配 `never`，越权提升一律拒绝不问，杜绝「问了就放行」破掉只读）、
  `full-access`（完全权限：不再询问）。切换按官方机制记成 `permission/preset` 会话事件，业务服务原样收到。
  沙箱另许的写入目录（「允许的临时目录」）取 `KNOWWORK_SANDBOX_EXTRA_DIRS`（冒号分隔的绝对路径）。
- **收件入口** `@knowwork/dsh-host/device-host`（`src/device-host.mjs`）：合同怎么收在 `intake.mjs`，同一份；
  这里只管本机 HTTP 与 Agent 的生灭（同 http-host），差异是会话的工作目录随开会话的合同来（`cwd` 字段，
  桌面主进程补上员工选的工作文件夹），以及多了按会话查与切访问方式（`GET/POST /v1/sessions/{id}/access`、
  `GET /v1/access`）。只监听 127.0.0.1，缺令牌或令牌太短直接拒绝启动（同 http-host 的规矩）。
  Agent 的建与恢复经 `ctx.agents` 直驱；intake.mjs 注释里设想的官方会话控制器方案（依赖 web 栈一串件）等桌面壳
  阶段评估，接口面不变。
- **产品停用**：网页搜索（服务端也没有）、设备磁盘上的技能目录（技能只来自业务服务的会话清单）、会话遥测、
  fork 型子 Agent（同服务端环境层）。

E1 测试在 `tests/e1-device.test.mjs`：工作文件夹内的写入与命令直接执行、工作区外等批准（批准落盘、拒绝不落盘）、
三档行为与切换记录、恢复会话后历史与权限档都还在、收件入口只给主进程。

## 技能

会话打开时业务服务在建会话请求里给出 `skills: { token }`（受众 skills 的短期令牌），宿主据此：

1. 拉本会话可用技能清单（`GET /internal/extensions/skills/catalog`，地址取 `KNOWWORK_SKILLS_BASE_URL`）；
   拉取失败或清单不合格，会话打开失败；
2. 用官方 `createScope(ctx, agent)` 按 agent 注册技能提供方，官方 `dsh-tool-skill` 出目录与 `skill` 工具；
   模型加载技能时才拉正文（`GET /content?name=&digest=`），按清单里的 `contentDigest` 校验；
3. 被技能认领的专业工具（清单里的 `unlocks`）在加载该技能之前不注册、不可见、不可执行；
   经 `skill` 工具加载或用户 `/技能名` 显式调用之后解锁；
4. 加载过的技能把 `completionTools` 交给技能门：本轮任一完成工具没成功，最终回答被拦下。

令牌续期：`PUT /v1/sessions/{id}/skill-credential`。

## 向用户提问与待办

官方 `dsh-tool-ask-user` 用 timed 模式（legacy 模式的请求不带工具调用 id，问题也不进官方投影，宿主重启就丢）。
提问应答者 `question-broker` 照审批应答者的形态，把问题以 `question/requested` 帧推给业务服务，用户作答后：

- `GET /v1/sessions/{id}/questions`：待答问题，`state` 为 `open`（前台等待中）或 `continued`（等待已结束，仍可答）；
- `POST /v1/sessions/{id}/questions/{callId}`，请求体 `{ answers: [{ id, selected, custom? }] }`：回答先按原问题核对
  （选项存在、单选最多一个、每题恰好一条）。`open` 的直接交回工具；`continued` 的经官方 `userQuestions.answer`
  以 `user-question-reply` 消息送回，会话空闲时开新一轮。

前台等待上限 `KNOWWORK_QUESTION_TIMEOUT_MS`（默认 30 分钟，同时是工具的默认期限）。到期后模型先继续，问题转入
`continued`；模型自己传 `-1`（不限时）的提问到上限按超时关闭。宿主崩溃后恢复会话，没答完的问题转入 `continued`；
宿主正常关闭（SIGTERM）时官方会把前台等待中的提问记成已中止，恢复后不能再答（`question/closed`，`reason=interrupted`），
用户改在输入框直接回复。

官方 `dsh-tool-todo` 每次整表写入，落成 `todo/write` 会话事件，业务服务据此展示待办进度。
