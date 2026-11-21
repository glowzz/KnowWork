"""桌面端扩展对象：装配时登记原生应用客户端、令牌交换的受众与用量配额，挂上设备路由。"""

from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from knowwork_server.identity.oauth import OAuthError
from knowwork_server.identity.oauth_clients import OAuthClient
from knowwork_server.identity.oauth_exchange import Exchanged
from knowwork_server.kernel.tokens import TOOLS_AUDIENCE
from knowwork_server.skills.tokens import SKILLS_AUDIENCE

from . import store
from .routes import build_routes

# 桌面端应用：回调只认本机回环地址的这个路径（RFC 8252 7.3，端口随应用每次启动临时监听）
CLIENT = OAuthClient(client_id="knowwork-desktop", name="KnowWork 桌面端", redirect_path="/oauth/desktop")
# 壳的内嵌网页版的会话受众：换出来的是 kw_session 的令牌（见 register_exchangers）
SESSION_AUDIENCE = "desktop-session"


class Desktop:
    """装了就启用（license_module=None：自己的产品，不走授权校验）。"""

    name = "desktop"
    license_module = None
    model_modules = ("knowwork_desktop.tables",)
    rls_tables = ()  # 两张表是全局的绑定与配置（tables.py 的说明），不开行级安全
    migrations = Path(__file__).with_name("migrations")

    def setup_api(self, ctx):
        ctx.oauth_clients.register(CLIENT)
        register_exchangers(ctx)
        return [build_routes(ctx)]

    def setup_worker(self, ctx) -> None:
        pass  # 桌面端扩展没有后台任务

    async def start(self) -> None:
        return None

    async def aclose(self) -> None:
        return None


def register_exchangers(ctx) -> None:
    """换令牌的受众：模型受众由业务服务在登记原生应用时自动登记（app.py），这里不重复。

    - tools、skills：闸门一样——本机会话的绑定在、还是这个人的、还是这台设备（重装应用重登后 grant 换了、
      设备号不变，照样认）、空间开着本机会话——过了才交给开源侧的签发器（ApiContext.device_tokens，
      和服务端会话同一种令牌、同一套计算）。
    - desktop-session：壳的内嵌网页版要登录态，而网页版吃 Cookie 会话——这里把原生登录直接换成一张网页
      会话令牌，壳拿它设 Cookie（kw_session），网页版就是登录着的（系统浏览器批一次，壳里不用再登一次）。
      会话时长照身份模块的默认（IdentityConfig 的 session_ttl），method 记 desktop。
    """

    async def exchange(audience: str, principal, params: dict[str, str]):
        conversation_id = params.get("conversation_id", "")
        row = await store.binding_of(ctx.global_sessionmaker, conversation_id)
        if row is None or row.user_id != principal.user_id:
            raise OAuthError("access_denied", "没有这段对话，或不是你的")
        device_id = await ctx.oauth_device_id(principal.grant_id) if principal.grant_id else None
        if not device_id or device_id != row.device_id:
            raise OAuthError("access_denied", "这段对话是在另一台电脑上创建的，请在那台电脑上继续")
        space = await store.space_settings(ctx.global_sessionmaker, row.workspace_id)
        if space is not None and not space.local_sessions:
            raise OAuthError("access_denied", "本空间已停用本机会话，请联系空间管理员")
        issue = (ctx.device_tokens or {}).get(audience)
        if issue is None:
            raise OAuthError("invalid_target", "这个受众现在换不了令牌")
        return await issue(row.workspace_id, row.conversation_id, principal.user_id)

    for audience in (TOOLS_AUDIENCE, SKILLS_AUDIENCE):
        async def exchange_for(principal, params, audience=audience):
            return await exchange(audience, principal, params)

        ctx.oauth_exchangers.register(audience, exchange_for)

    # 网页会话服务：与业务服务同一个库表，时长照身份模块的默认（主线不另外配这两个值）
    from knowwork_server.identity.config import IdentityConfig
    from knowwork_server.identity.sessions import SessionService
    identity_config = IdentityConfig()
    web_sessions = SessionService(ctx.global_sessionmaker, ttl=identity_config.session_ttl,
                                  sliding=identity_config.session_sliding)

    async def exchange_session(principal, params: dict[str, str]):
        issued = await web_sessions.create(principal.user_id, method="desktop")
        return Exchanged(token=issued.token, expires_in=int(identity_config.session_ttl.total_seconds()))

    ctx.oauth_exchangers.register(SESSION_AUDIENCE, exchange_session)


EXTENSION = Desktop()
