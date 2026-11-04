"""把本轮消息带的附件 id 换成交给宿主的文件说明（kernel.contract.TurnAttachment）。

原件在 /workspace/input/<input_name>；配了文档解析的另给解析出的 Markdown 路径。还在解析时也给，并标明现在还没有：
网页发送前会等解析完，用户点了「直接发送」、或经接口发来的消息才会赶上解析没完，模型知道它会出现在哪，
过一会儿能自己去看，不然只能拿原件从头转一遍。
迁移 0013 之前的旧行（PDF、Word、PPT 只放了 Markdown，parsed_name 等于 input_name）照它实际放的那份给路径。

用户传完附件马上发消息时解析多半还在跑：短暂等它出结果（有上限），等到了模型才能被告知解析稿路径，
不然模型面对目录里「来历不明」的 .md 只会自己再从 PDF 抽一遍文本。等不到或解析失败就按原件继续，
解析完成的 .md 模型在后面的轮次自然可见。

怎么读（reading.py，照 Claude 的做法）：解析好的文字、纯文本附件，放得下的整篇放进这一轮，放不下的给字数、页数和目录。
一轮的预算按附件顺序用，前面的用掉了后面的就给目录。
"""

import asyncio
import time
from collections.abc import Sequence

from ..conversations.models import Conversation
from ..conversations.service import AttachmentUnavailable
from ..kernel.contract import OutlineEntry, TurnAttachment
from .reading import plan
from .service import AttachmentService, AttachmentView
from .settings import AttachmentSettings
from .types import AttachmentRejected

INPUT_DIR = "/workspace/input/"
POLL_SECONDS = 0.5


def turn_attachment(item: AttachmentView) -> TurnAttachment:
    separate = bool(item.parsed_name) and item.parsed_name != item.input_name
    pending = separate and item.parse_status == "parsing"
    extracted = INPUT_DIR + item.parsed_name if separate and (pending or item.parse_status == "ready") else None
    digesting = item.digest_status == "digesting"
    digest = INPUT_DIR + item.digest_name if item.digest_name and (digesting or item.digest_status == "ready") else None
    return TurnAttachment(name=item.filename, path=INPUT_DIR + item.input_name, bytes=item.size,
                          sha256=item.digest, extracted_path=extracted, extraction_pending=pending,
                          digest_path=digest, digest_pending=digest is not None and digesting)


class TurnAttachments:
    def __init__(self, service: AttachmentService, settings: AttachmentSettings | None = None) -> None:
        self._service = service
        # settings 不传就不等（测试直接调 for_turn、任务还没跑的场景）；生产装配处（app.py）总是传
        self._wait_seconds = settings.attachment_parse_wait_seconds if settings else 0.0

    async def for_turn(self, conversation: Conversation, ids: Sequence[str]) -> tuple[TurnAttachment, ...]:
        """还没发出去的（输入框里暂存的）这时认领进会话、放进沙箱。"""
        try:
            items = await self._service.claim(conversation, ids)
            items = await self._settled(conversation, ids, items)
        except AttachmentRejected as error:
            raise AttachmentUnavailable(error.message) from error
        inline_limit, budget = self._service.inline_limits
        files = []
        for item in items:
            file = turn_attachment(item)
            text = await self._service.readable_text(conversation.workspace_id, item)
            if text is None:
                files.append(file)
                continue
            reading = plan(text, inline_limit=inline_limit, budget=budget)
            if reading.text is not None:
                budget -= reading.chars
            files.append(file.model_copy(update={
                "text": reading.text, "text_chars": reading.chars, "text_pages": item.page_count or reading.pages,
                "outline": tuple(OutlineEntry(line=e.line, text=e.text) for e in reading.outline)}))
        return tuple(files)

    async def _settled(self, conversation: Conversation, ids: Sequence[str],
                       items: tuple[AttachmentView, ...]) -> tuple[AttachmentView, ...]:
        """解析还在跑的附件等它出结果（上限 attachment_parse_wait_seconds）：等到了正文、解析稿路径一起进来，
        等不到或解析失败就按现在的样子继续（还在解析的模型知道 .md 一会儿出现在哪）。"""
        deadline = time.monotonic() + self._wait_seconds
        pending = {item.id for item in items if item.parse_status == "parsing"}
        while pending and time.monotonic() < deadline:
            await asyncio.sleep(min(POLL_SECONDS, max(0.0, deadline - time.monotonic())))
            items = await self._service.claim(conversation, ids)
            pending = {item.id for item in items if item.parse_status == "parsing"}
        return items
