"""桌面端扩展（extensions/desktop）：路由的闸门（只认桌面端登录、核对设备、属主）、空间开关、配额、
令牌交换的受众、迁移分支。DeviceConversations 与服务栈是真的（同 test_device_conversations 的搭法），
闸门与错误说法是这里要钉住的。"""

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from knowwork_desktop.extension import CLIENT, EXTENSION
from knowwork_desktop.tables import DesktopConversation
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from knowwork_server.auth.principal import Principal
from knowwork_server.conversations.device import DeviceConversations
from knowwork_server.conversations.listeners import Broadcaster
from knowwork_server.conversations.pump import EventPump
from knowwork_server.conversations.quota import QuotaExceeded, QuotaPolicies, TurnStart
from knowwork_server.conversations.replay import EventFeed
from knowwork_server.conversations.service import ConversationService
from knowwork_server.conversations.writer import BatchWriter
from knowwork_server.db.migrate import Branches, upgrade_to_head
from knowwork_server.identity.models import User
from knowwork_server.identity.oauth import DeviceLogin, OAuthError
from knowwork_server.identity.oauth_clients import OAuthClients
from knowwork_server.identity.oauth_exchange import Exchanged, TokenExchangers

from ..fakes import FakeKernel

pytestmark = pytest.mark.anyio
GRANTS = {"g1": "dev-A", "g2": "dev-B"}  # grant → 这次登录报的设备号


def principal(user_id: str, grant_id: str | None) -> Principal:
    return Principal(user_id=user_id, auth_method="oauth", grant_id=grant_id)


async def devices_of(user_id: str):
    """oauth_devices 的替身：这个人登录过的设备（DeviceLogin 形状，id 是 grant）。"""
    now = datetime.now(UTC)
    return [DeviceLogin(id=grant, client_id=CLIENT.client_id, client_name=CLIENT.name,
                        device_name=f"设备-{device}", created_at=now, last_used_at=now, device_id=device)
            for grant, device in GRANTS.items()]


async def device_id_of(grant: str | None):
    """oauth_device_id 的替身：grant → 这次登录报的设备号。"""
    return GRANTS.get(grant)


@pytest.fixture
async def world(sessionmaker):
    ws = f"ws_{uuid.uuid4().hex[:8]}"  # 每个用例一个独立空间：pgserver 的库在用例间不重建，开关与绑定不能互相看见
    kernel = FakeKernel()
    writer, broadcaster = BatchWriter(sessionmaker), Broadcaster()
    writer.start()
    pump = EventPump(kernel, sessionmaker, writer, broadcaster)
    feed = EventFeed(sessionmaker, writer, broadcaster, pump.produced_upto)
    service = ConversationService(kernel, sessionmaker, pump, feed)
    device = DeviceConversations(service, pump)
    issued: list[tuple[str, str, str]] = []

    async def issue_tools(workspace_id: str, session_id: str, user_id: str) -> Exchanged:
        issued.append(("tools", workspace_id, session_id, user_id))
        return Exchanged(token="t" * 40, expires_in=60)

    async def issue_skills(workspace_id: str, session_id: str, user_id: str) -> Exchanged:
        issued.append(("skills", workspace_id, session_id, user_id))
        return Exchanged(token="s" * 40, expires_in=60)

    holder: dict[str, Principal | None] = {"principal": None}
    ctx = SimpleNamespace(
        device_conversations=device,
        oauth_device_id=device_id_of,
        oauth_devices=devices_of,
        oauth_clients=OAuthClients(),
        oauth_exchangers=TokenExchangers(),
        device_tokens={"tools": issue_tools, "skills": issue_skills},
        global_sessionmaker=sessionmaker,
        usage=None,
        quota=QuotaPolicies(),
        settings=SimpleNamespace(usage_timezone="Asia/Shanghai"),
        access=SimpleNamespace(check=lambda user, workspace, resource, action: user == "admin" and workspace == ws),
        principal=lambda scope: lambda: holder["principal"],
    )
    routers = EXTENSION.setup_api(ctx)
    assert len(routers) == 1
    app = FastAPI()
    app.include_router(routers[0])
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://kw")

    async def call(method: str, path: str, *, user_id: str = "owner", grant_id: str | None = "g1", **kwargs):
        holder["principal"] = principal(user_id, grant_id)
        return await http.request(method, path, **kwargs)

    yield SimpleNamespace(ctx=ctx, http=http, call=call, sessionmaker=sessionmaker, issued=issued,
                          device=device, pump=pump, writer=writer, holder=holder, ws=ws)
    await http.aclose()
    await pump.close()
    await writer.close()


async def a_conversation(world, *, user_id: str = "owner", grant_id: str | None = "g1") -> str:
    response = await world.call("POST", "/api/desktop/conversations",
                                user_id=user_id, grant_id=grant_id,
                                json={"workspace_id": world.ws, "title": "分公司台账"})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def raw(seq: int, type_: str = "assistant/message", data: dict | None = None) -> dict:
    return {"type": type_, "seq": seq, "time": 1000 + seq, "data": data or {}}


async def test_client_and_audiences_are_registered(world):
    assert world.ctx.oauth_clients.get("knowwork-desktop") is CLIENT
    assert CLIENT.redirect_path == "/oauth/desktop"
    for audience in ("tools", "skills"):
        assert world.ctx.oauth_exchangers.get(audience) is not None


async def test_create_records_binding_and_device_name(world):
    conversation_id = await a_conversation(world)
    row = await (world.sessionmaker()).get(DesktopConversation, conversation_id)
    assert (row.workspace_id, row.user_id, row.grant_id, row.device_id, row.device_name) == \
        (world.ws, "owner", "g1", "dev-A", "设备-dev-A")
    place = await world.call("GET", f"/api/desktop/conversations/{conversation_id}/place")
    assert place.json() == {"device": "设备-dev-A"}


async def test_only_the_creating_device_continues(world):
    conversation_id = await a_conversation(world)
    # 另一台电脑的登录：设备号不同
    other = await world.call("GET", f"/api/desktop/conversations/{conversation_id}/session", grant_id="g2")
    assert other.status_code == 403
    assert other.json()["detail"]["code"] == "device_mismatch"
    # 浏览器会话（没有 grant）：直接拒
    browser = await world.call("GET", f"/api/desktop/conversations/{conversation_id}/session", grant_id=None)
    assert browser.status_code == 403
    assert browser.json()["detail"]["code"] == "desktop_only"
    # 别人：404（不说有没有这段对话）
    stranger = await world.call("GET", f"/api/desktop/conversations/{conversation_id}/session", user_id="mallory")
    assert stranger.status_code == 404


async def test_prepare_turn_returns_bodies(world):
    conversation_id = await a_conversation(world)
    response = await world.call("POST", f"/api/desktop/conversations/{conversation_id}/prepare-turn",
                                json={"text": "算一下完成率"})
    assert response.status_code == 200, response.text
    bodies = response.json()
    assert bodies["session"]["sessionId"] == conversation_id and bodies["turn"]["text"] == "算一下完成率"
    stranger = await world.call("POST", f"/api/desktop/conversations/{conversation_id}/prepare-turn",
                                user_id="mallory", json={"text": "你好"})
    assert stranger.status_code == 404


async def test_space_toggle_blocks_create_and_prepare_but_not_history(world):
    conversation_id = await a_conversation(world)
    from knowwork_desktop.store import set_space_settings
    await set_space_settings(world.sessionmaker, world.ws, local_sessions=False, monthly_turn_limit=None)
    blocked = await world.call("POST", "/api/desktop/conversations", json={"workspace_id": world.ws, "title": ""})
    assert blocked.status_code == 403
    assert blocked.json()["detail"]["code"] == "local_sessions_disabled"
    prepare = await world.call("POST", f"/api/desktop/conversations/{conversation_id}/prepare-turn",
                               json={"text": "你好"})
    assert prepare.status_code == 403
    assert prepare.json()["detail"]["code"] == "local_sessions_disabled"
    # 已跑着的轮次事件照收、历史照读
    events = await world.call("POST", f"/api/desktop/conversations/{conversation_id}/events",
                              json={"events": [raw(1)]})
    assert events.status_code == 200
    session = await world.call("GET", f"/api/desktop/conversations/{conversation_id}/session")
    assert session.status_code == 200


async def test_push_events_validates_and_position_tracks_children(world):
    conversation_id = await a_conversation(world)
    push = await world.call("POST", f"/api/desktop/conversations/{conversation_id}/events",
                            json={"events": [raw(1), raw(2)]})
    assert push.json() == {"seq": 2}
    child = await world.call("POST", f"/api/desktop/conversations/{conversation_id}/events",
                             json={"events": [raw(1)], "session": "child-1"})
    assert child.status_code == 200
    bad = await world.call("POST", f"/api/desktop/conversations/{conversation_id}/events",
                           json={"events": [raw(5), raw(3)]})
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "invalid_events"
    position = await world.call("GET", f"/api/desktop/conversations/{conversation_id}/position")
    assert position.json() == {"seq": 2, "children": {"child-1": 1}}
    live = await world.call("POST", f"/api/desktop/conversations/{conversation_id}/live",
                            json={"frames": [{"kind": "assistant/stream"}]})
    assert live.status_code == 200


async def test_remember_approval_needs_grants(world):
    conversation_id = await a_conversation(world)
    response = await world.call("POST", f"/api/desktop/conversations/{conversation_id}/remember-approval",
                                json={"tool_name": "bash"})
    assert response.json() == {"remembered": False}  # 没接授权账本时记不了，照常问


async def test_exchange_gates_then_issues(world):
    conversation_id = await a_conversation(world)
    exchange = world.ctx.oauth_exchangers.get("tools")
    issued = await exchange(principal("owner", "g1"), {"conversation_id": conversation_id})
    assert issued.token == "t" * 40
    assert world.issued == [("tools", world.ws, conversation_id, "owner")]
    # 设备不对、不是本人、空间关了、签发器不在：一律拒绝
    with pytest.raises(OAuthError):
        await exchange(principal("owner", "g2"), {"conversation_id": conversation_id})
    with pytest.raises(OAuthError):
        await exchange(principal("mallory", "g1"), {"conversation_id": conversation_id})
    from knowwork_desktop.store import set_space_settings
    await set_space_settings(world.sessionmaker, world.ws, local_sessions=False, monthly_turn_limit=None)
    with pytest.raises(OAuthError):
        await exchange(principal("owner", "g1"), {"conversation_id": conversation_id})
    await set_space_settings(world.sessionmaker, world.ws, local_sessions=True, monthly_turn_limit=None)
    world.ctx.device_tokens = {}
    with pytest.raises(OAuthError):
        await exchange(principal("owner", "g1"), {"conversation_id": conversation_id})


async def test_session_audience_mints_a_web_session(world):
    """desktop-session 受众：换出来的令牌是一张网页会话（壳拿它设 kw_session，网页版就是登录着的）。"""
    from knowwork_server.identity.config import IdentityConfig
    from knowwork_server.identity.sessions import SessionService

    async with world.sessionmaker() as session, session.begin():
        session.add(User(id="owner", email="owner@example.com", name="本人"))
    exchange = world.ctx.oauth_exchangers.get("desktop-session")
    issued = await exchange(principal("owner", "g1"), {})  # 不需要会话参数：登录发生在建对话之前
    assert issued.expires_in == int(IdentityConfig().session_ttl.total_seconds())
    sessions = SessionService(world.sessionmaker, ttl=IdentityConfig().session_ttl,
                              sliding=IdentityConfig().session_sliding)
    who = await sessions.resolve(issued.token)
    assert who is not None and who.user_id == "owner" and who.auth_method == "desktop"


async def test_admin_space_settings(world):
    # 没配置过的空间：默认开着、不限
    fresh = await world.call("GET", f"/api/desktop/admin/space/{world.ws}/settings", user_id="admin")
    assert fresh.json() == {"localSessions": True, "monthlyTurnLimit": None}
    # 只有这个空间的管理员能改
    forbidden = await world.call("PUT", f"/api/desktop/admin/space/{world.ws}/settings",
                                 json={"local_sessions": False, "monthly_turn_limit": 100})
    assert forbidden.status_code == 403
    saved = await world.call("PUT", f"/api/desktop/admin/space/{world.ws}/settings", user_id="admin",
                             json={"local_sessions": False, "monthly_turn_limit": 100})
    assert saved.json() == {"localSessions": False, "monthlyTurnLimit": 100}
    got = await world.call("GET", f"/api/desktop/admin/space/{world.ws}/settings", user_id="admin")
    assert got.json() == {"localSessions": False, "monthlyTurnLimit": 100}


async def test_quota_uses_monthly_limit(world):
    conversation_id = await a_conversation(world)
    start = TurnStart(workspace_id=world.ws, user_id="owner", conversation_id=conversation_id)
    # 没配上限：不判
    await world.ctx.quota.before_turn(start)
    from knowwork_desktop.store import set_space_settings
    await set_space_settings(world.sessionmaker, world.ws, local_sessions=True, monthly_turn_limit=5)

    class UsedAll:
        async def turns(self, workspace_id: str, month_start, month_end) -> int:
            assert (workspace_id, month_start.day, month_end.day) == (world.ws, 1, 1)
            return 5

    world.ctx.usage = UsedAll()
    with pytest.raises(QuotaExceeded) as exceeded:
        await world.ctx.quota.before_turn(start)
    assert exceeded.value.scope == "workspace" and exceeded.value.resets_on is not None
    assert "5 轮" in exceeded.value.message

    # 用量没到上限：放行
    class UsedTwo:
        async def turns(self, workspace_id: str, month_start, month_end) -> int:
            return 2

    world.ctx.usage = UsedTwo()
    await world.ctx.quota.before_turn(start)


async def test_delete_unbinds(world):
    conversation_id = await a_conversation(world)
    response = await world.call("DELETE", f"/api/desktop/conversations/{conversation_id}")
    assert response.status_code == 204
    row = await (world.sessionmaker()).get(DesktopConversation, conversation_id)
    assert row is None
    again = await world.call("GET", f"/api/desktop/conversations/{conversation_id}/session")
    assert again.status_code == 404


async def test_migration_branch(fresh_url):
    """扩展的迁移分支和主线一起升到最新：两张表建出来，重跑幂等。"""
    branches = Branches(locations=(EXTENSION.migrations,))
    await upgrade_to_head(fresh_url, branches=branches)
    await upgrade_to_head(fresh_url, branches=branches)
    engine = create_async_engine(fresh_url)
    try:
        async with engine.connect() as connection:
            rows = await connection.execute(text(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'desktop_%'"))
            assert {row[0] for row in rows} == {"desktop_conversation", "desktop_space"}
    finally:
        await engine.dispose()
