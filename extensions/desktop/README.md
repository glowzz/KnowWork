# KnowWork 桌面端扩展

装进业务服务镜像的扩展包（入口组 `knowwork.extensions`）：对话在员工自己的电脑上执行（本机会话），
账号、权限、每一轮的准备与对话记录仍在业务服务。开源侧只提供接口（`docs/desktop.md` 第 1 节），
本包是对接它们的产品实现。

## 提供什么

- **原生应用登录**：登记客户端 `knowwork-desktop`（OAuth 授权码 + PKCE，系统浏览器登录，回调路径
  `/oauth/desktop`，登录时带固定设备号）。
- **按受众换令牌**（RFC 8693，`POST /api/auth/oauth/token`）：受众 `tools`、`skills` 由这里登记——核对
  对话归属、设备绑定、空间开着本机会话，才交给开源侧的签发器（和服务端会话同一种令牌、同一套计算）。
  模型受众（`model`）由业务服务在登记了原生应用时自动登记，这里不碰。
- **设备路由**（`/api/desktop`）：建对话、开会话合同、准备一轮（与网页发消息同一套准备）、收事件与逐字片段、
  查游标、记「本会话内不再询问」、取对话模型清单、`/place` 给别处只读时的设备名提示。只认桌面端登录、
  核对是建对话的那台设备（设备号比对，重装应用重登后仍认）。
- **空间开关与用量上限**（`/api/desktop/admin/space/{workspace_id}/settings`）：空间管理员停用本空间的本机会话、
  按月限轮次（超了照配额口子回 429）。限的是整个空间各端一起算的月度轮次。

两张表（`desktop_conversation` 绑定、`desktop_space` 开关）是全局表、不开行级安全，理由见
`src/knowwork_desktop/tables.py` 的模块说明。

## 装进镜像

业务服务镜像构建时把本包装进同一个环境（`knowwork-server` 已在那里）：

```sh
uv pip install --no-deps /path/to/extensions/desktop
```

入口组 `knowwork.extensions` 里登记了 `desktop`，装了即启用；迁移随 api 启动自动执行（分支 `desktop`，
接在主线 0055 之后）。

## 测试

测试放在 `server/tests/desktop/`（复用服务端的数据库与测试基建，conftest 里把本包的 `src` 加进 import 路径）：

```sh
cd server && pytest tests/desktop
```
