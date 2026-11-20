"""桌面端扩展的第一条迁移：设备绑定与空间开关两张表。单独一条分支，接在开源主线 0055 之后。"""

import sqlalchemy as sa
from alembic import op

revision = "desktop_0001"
down_revision = None
branch_labels = ("desktop",)
depends_on = "0055"


def upgrade() -> None:
    op.create_table(
        "desktop_conversation",
        sa.Column("conversation_id", sa.String(length=64), primary_key=True),
        sa.Column("workspace_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("grant_id", sa.String(length=32), nullable=False),
        sa.Column("device_id", sa.String(length=64), nullable=False),
        sa.Column("device_name", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_desktop_conversation_workspace_id", "desktop_conversation", ["workspace_id"])
    op.create_index("ix_desktop_conversation_user_id", "desktop_conversation", ["user_id"])
    op.create_table(
        "desktop_space",
        sa.Column("workspace_id", sa.String(length=64), primary_key=True),
        sa.Column("local_sessions", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("monthly_turn_limit", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("desktop_space")
    op.drop_index("ix_desktop_conversation_user_id", table="desktop_conversation")
    op.drop_index("ix_desktop_conversation_workspace_id", table="desktop_conversation")
    op.drop_table("desktop_conversation")
