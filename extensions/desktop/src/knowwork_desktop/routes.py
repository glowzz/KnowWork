"""桌面端的路由（/api/desktop）：只认桌面端登录（原生应用的 OAuth 令牌），核对是建对话的那台设备。

- 会话、事件、游标、审批授权这些操作都交 DeviceConversations（开源侧的设备对话合同），这里只管闸门与错误的说法；
- 准备一轮的错误与云端发消息同一套说法（conversations/api.py 的 TURN_REJECTIONS 与 turn_rejected，同一套准备）；
- 空间关掉本机会话后：建对话与准备一轮拒绝（403），已跑着的轮次事件照收、历史照读；
- 别处（网页、手机）只读提示用的设备名走 /place：不核对设备（网页没有设备号），只认属主。
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from knowwork_server.access.vocab import WORKSPACE_RESOURCE, Action
from knowwork_server.auth.principal import Principal
from knowwork_server.conversations.api import TURN_REJECTIONS, turn_rejected
from knowwork_server.conversations.device import DeviceConversations, InvalidEvents
from knowwork_server.db.base import in_workspace
from knowwork_server.kernel.contract import TurnInput

from . import store
from .tables import DesktopConversation

NOT_FOUND = {"code": "not_found", "message": "没有这段对话"}
LOCAL_DISABLED = {"code": "local_sessions_disabled", "message": "本空间已停用本机会话，请联系空间管理员"}
DESKTOP_ONLY = {"code": "desktop_only", "message": "只认桌面端的登录，请在桌面端里继续"}


class CreateBody(BaseModel):
    workspace_id: str = Field(min_length=1, max_length=64)
    title: str = Field(default="", max_length=200)


class EventsBody(BaseModel):
    events: list[Any]
    session: str | None = None


class LiveBody(BaseModel):
    frames: list[Any]


class RememberBody(BaseModel):
    tool_name: str = Field(min_length=1, max_length=64)


class SpaceBody(BaseModel):
    local_sessions: bool
    monthly_turn_limit: int | None = Field(default=None, ge=0, le=1_000_000)


def build_routes(ctx) -> APIRouter:
    """装配桌面端路由。ctx 是业务服务的 ApiContext（只碰这里用到的字段），测试里可用替身。"""
    Who = Annotated[Principal, Depends(ctx.principal(None))]
    conversations: DeviceConversations = ctx.device_conversations
    sessions = ctx.global_sessionmaker

    router = APIRouter(prefix="/api/desktop")

    def forbidden(detail: dict) -> HTTPException:
        return HTTPException(status_code=403, detail=detail)

    def not_found() -> HTTPException:
        return HTTPException(status_code=404, detail=NOT_FOUND)

    async def device_of(principal: Principal) -> str:
        """这次登录报的固定设备号：桌面端登录必带；浏览器会话、API Key 没有 grant，直接拒。"""
        if principal.grant_id is None:
            raise forbidden(DESKTOP_ONLY)
        device_id = await ctx.oauth_device_id(principal.grant_id)
        if not device_id:
            raise HTTPException(status_code=400, detail={"code": "device_unknown",
                                                         "message": "这次登录没有报设备号，请重新登录桌面端"})
        return device_id

    async def bound(principal: Principal, conversation_id: str, *, need_space_open: bool) -> DesktopConversation:
        """找到这段对话的绑定并核对属主与设备：绑定表里没有、不是这个人的、不是这台设备的，都不给。"""
        row = await store.binding_of(sessions, conversation_id)
        if row is None or row.user_id != principal.user_id:
            raise not_found()
        device_id = await device_of(principal)
        if device_id != row.device_id:
            raise forbidden({"code": "device_mismatch", "message": "这段对话是在另一台电脑上创建的，请在那台电脑上继续"})
        if need_space_open:
            space = await store.space_settings(sessions, row.workspace_id)
            if space is not None and not space.local_sessions:
                raise forbidden(LOCAL_DISABLED)
        return row

    async def owned(principal: Principal, row: DesktopConversation):
        conversation = await conversations.owned(workspace_id=row.workspace_id, user_id=principal.user_id,
                                                 conversation_id=row.conversation_id)
        if conversation is None:
            raise not_found()
        return conversation

    @router.post("/conversations", status_code=201)
    async def create(body: CreateBody, who: Who):
        device_id = await device_of(who)
        space = await store.space_settings(sessions, body.workspace_id)
        if space is not None and not space.local_sessions:
            raise forbidden(LOCAL_DISABLED)
        with in_workspace(body.workspace_id):
            conversation = await conversations.create(workspace_id=body.workspace_id, user_id=who.user_id,
                                                      title=body.title)
        device_name = ""
        for device in await ctx.oauth_devices(who.user_id):
            if device.id == who.grant_id:
                device_name = device.device_name
                break
        await store.bind(sessions, conversation_id=conversation.id, workspace_id=body.workspace_id,
                         user_id=who.user_id, grant_id=who.grant_id, device_id=device_id, device_name=device_name)
        return {"id": conversation.id, "title": conversation.title, "device": device_name}

    @router.get("/conversations/{conversation_id}/session")
    async def session_body(conversation_id: str, who: Who):
        row = await bound(who, conversation_id, need_space_open=False)
        with in_workspace(row.workspace_id):
            return await conversations.session(await owned(who, row))

    @router.post("/conversations/{conversation_id}/prepare-turn")
    async def prepare_turn(conversation_id: str, turn: TurnInput, who: Who):
        row = await bound(who, conversation_id, need_space_open=True)
        with in_workspace(row.workspace_id):
            try:
                bodies = await conversations.prepare_turn(await owned(who, row), turn)
            except TURN_REJECTIONS as error:
                raise turn_rejected(error) from error
        return {"session": bodies.session, "turn": bodies.turn}

    @router.post("/conversations/{conversation_id}/events")
    async def push_events(conversation_id: str, body: EventsBody, who: Who):
        row = await bound(who, conversation_id, need_space_open=False)
        with in_workspace(row.workspace_id):
            try:
                seq = await conversations.push(await owned(who, row), body.events, session=body.session)
            except InvalidEvents as error:
                raise HTTPException(status_code=400, detail={"code": "invalid_events", "message": str(error)}) from error
        return {"seq": seq}

    @router.post("/conversations/{conversation_id}/live")
    async def push_live(conversation_id: str, body: LiveBody, who: Who):
        row = await bound(who, conversation_id, need_space_open=False)
        with in_workspace(row.workspace_id):
            try:
                await conversations.push_live(await owned(who, row), body.frames)
            except InvalidEvents as error:
                raise HTTPException(status_code=400, detail={"code": "invalid_events", "message": str(error)}) from error
        return {"ok": True}

    @router.get("/conversations/{conversation_id}/position")
    async def position(conversation_id: str, who: Who):
        row = await bound(who, conversation_id, need_space_open=False)
        with in_workspace(row.workspace_id):
            got = await conversations.position(await owned(who, row))
        return {"seq": got.seq, "children": got.children}

    @router.post("/conversations/{conversation_id}/remember-approval")
    async def remember_approval(conversation_id: str, body: RememberBody, who: Who):
        row = await bound(who, conversation_id, need_space_open=False)
        with in_workspace(row.workspace_id):
            remembered = await conversations.remember_approval(await owned(who, row), body.tool_name)
        return {"remembered": remembered}

    @router.get("/conversations/{conversation_id}/models")
    async def models(conversation_id: str, who: Who):
        await bound(who, conversation_id, need_space_open=False)
        return await conversations.models()

    @router.delete("/conversations/{conversation_id}", status_code=204)
    async def delete(conversation_id: str, who: Who):
        row = await bound(who, conversation_id, need_space_open=False)
        with in_workspace(row.workspace_id):
            await conversations.delete(await owned(who, row))
        await store.unbind(sessions, conversation_id)

    @router.get("/conversations/{conversation_id}/place")
    async def place(conversation_id: str, who: Who):
        """这段本机会话在哪台设备上：给前端插槽 chat.place 用。网页没有设备号，只认属主，不核对设备。"""
        row = await store.binding_of(sessions, conversation_id)
        if row is None or row.user_id != who.user_id:
            raise not_found()
        return {"device": row.device_name or None}

    @router.get("/admin/space/{workspace_id}/settings")
    async def get_space(workspace_id: str, who: Who):
        require_workspace_admin(ctx, who, workspace_id)
        return space_view(await store.space_settings(sessions, workspace_id))

    @router.put("/admin/space/{workspace_id}/settings")
    async def put_space(workspace_id: str, body: SpaceBody, who: Who):
        require_workspace_admin(ctx, who, workspace_id)
        row = await store.set_space_settings(sessions, workspace_id, local_sessions=body.local_sessions,
                                             monthly_turn_limit=body.monthly_turn_limit)
        return space_view(row)

    return router


def space_view(row) -> dict:
    return {"localSessions": row is None or bool(row.local_sessions),
            "monthlyTurnLimit": None if row is None else row.monthly_turn_limit}


def require_workspace_admin(ctx, who: Principal, workspace_id: str) -> None:
    """这个空间的管理员（系统管理员任何空间都算）：同 principals.workspace_admin 的判定。"""
    if not ctx.access.check(who.user_id, workspace_id, WORKSPACE_RESOURCE, Action.EDIT):
        raise HTTPException(status_code=403, detail={"code": "not_admin",
                                                     "message": "只有这个空间的管理员能改桌面端设置"})
