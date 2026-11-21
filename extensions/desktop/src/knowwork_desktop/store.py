"""绑定与开关的读写（tables.py 两张全局表）：设备路由、令牌交换与配额判定共用。"""

from collections.abc import Awaitable, Callable
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from .tables import DesktopConversation, DesktopSpace


async def binding_of(sessionmaker: async_sessionmaker, conversation_id: str) -> DesktopConversation | None:
    async with sessionmaker() as session:
        return (await session.execute(select(DesktopConversation).where(
            DesktopConversation.conversation_id == conversation_id))).scalar_one_or_none()


async def bind(sessionmaker: async_sessionmaker, *, conversation_id: str, workspace_id: str, user_id: str,
               grant_id: str, device_id: str, device_name: str) -> None:
    async with sessionmaker() as session:
        session.add(DesktopConversation(conversation_id=conversation_id, workspace_id=workspace_id,
                                        user_id=user_id, grant_id=grant_id, device_id=device_id,
                                        device_name=device_name))
        await session.commit()


async def unbind(sessionmaker: async_sessionmaker, conversation_id: str) -> None:
    async with sessionmaker() as session:
        row = (await session.execute(select(DesktopConversation).where(
            DesktopConversation.conversation_id == conversation_id))).scalar_one_or_none()
        if row is not None:
            await session.delete(row)
            await session.commit()


async def space_settings(sessionmaker: async_sessionmaker, workspace_id: str) -> DesktopSpace | None:
    async with sessionmaker() as session:
        return (await session.execute(select(DesktopSpace).where(
            DesktopSpace.workspace_id == workspace_id))).scalar_one_or_none()


async def set_space_settings(sessionmaker: async_sessionmaker, workspace_id: str, *,
                             local_sessions: bool, monthly_turn_limit: int | None) -> DesktopSpace:
    async with sessionmaker() as session:
        row = (await session.execute(select(DesktopSpace).where(
            DesktopSpace.workspace_id == workspace_id))).scalar_one_or_none()
        if row is None:
            row = DesktopSpace(workspace_id=workspace_id)
            session.add(row)
        row.local_sessions = local_sessions
        row.monthly_turn_limit = monthly_turn_limit
        await session.commit()
        await session.refresh(row)
        return row


def month_range(today: date) -> tuple[date, date]:
    """这个自然月的 [第一天, 下个月第一天)：用量计数与恢复日期都用它。"""
    start = today.replace(day=1)
    next_month = (start + timedelta(days=45)).replace(day=1)
    return start, next_month


async def local_sessions_open(load: Callable[[str], Awaitable[Any]], workspace_id: str) -> bool:
    """这个空间还开不开本机会话：没有配置行就是开着（装了扩展不改行为，管理员去关）。"""
    row = await load(workspace_id)
    return row is None or bool(row.local_sessions)
