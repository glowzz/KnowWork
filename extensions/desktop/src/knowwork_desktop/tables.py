"""桌面端扩展的两张表：本机会话的设备绑定与空间的开关配置。

两张表都是全局表、不开行级安全（同 oauth_grant 这类身份/配置表，不按工作空间分）：绑定表在设备请求里按
conversation_id 找到行之后才在代码里核对属主与设备，开关表只在已知空间的配额判定与管理接口里读写；
行级安全按 current_setting('app.workspace_id') 放行，而绑定查找发生在此之前，开了反而查不到。
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from knowwork_server.db.base import Base


class DesktopConversation(Base):
    """一段本机会话跑在哪台设备上（conversations/device.py 的对话由扩展建，建的时候记下这次登录）。

    - grant_id 是建对话那次登录（oauth_grant.id）；device_id 是那次登录报的固定设备号：设备重装应用重新登录后
      grant 换了、device_id 不变，照样认得是这台电脑（核对用 device_id，grant_id 只留档）；
    - device_name 给别处只读时的提示用（前端插槽 chat.place：在「李雷的 MacBook Pro」上执行）。
    """

    __tablename__ = "desktop_conversation"

    conversation_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(64), index=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    grant_id: Mapped[str] = mapped_column(String(32))
    device_id: Mapped[str] = mapped_column(String(64))
    device_name: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DesktopSpace(Base):
    """一个空间的本机会话开关与用量上限（空间管理员在「管理 → 桌面端」里改）。

    - local_sessions 关掉后本空间不能再建本机会话、也不能开始一轮（已建的对话在设备上还能看完历史）；
    - monthly_turn_limit 是这个空间每月（按部署时区自然月）的轮次上限：本机对话与网页等各端一起算，
      超了按配额口子回 429。NULL 是不限。
    """

    __tablename__ = "desktop_space"

    workspace_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    local_sessions: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    monthly_turn_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
