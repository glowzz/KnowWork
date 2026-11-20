/** 「本机」来源：对话在这台电脑上执行（desktop/src/main 的编排驱动本机宿主），发消息、停止、审批、
 * 回答提问经桥交到这台电脑上；工作文件夹在建对话时选定（发出第一句后就定了），三档访问方式在会话页切。 */

import { useEffect, useState } from 'react';
import { Select } from '@openai/apps-sdk-ui/components/Select';
import { Folder } from '@openai/apps-sdk-ui/components/Icon';
import { DEVICE_SOURCE } from '@knowwork/web/api/conversations';
import { ApiError } from '@knowwork/web/api/http';
import { useWorkspaceStore } from '@knowwork/web/stores/workspace';
import type { AnswerMode, QuestionAnswer } from '@knowwork/web/api/conversations';
import type { ConversationSource } from '@knowwork/web/features/chat/sources';
import type { InputLimits } from '@knowwork/web/features/chat/components/Composer';
import { bridge, unwrap, bridgeAvailable } from './bridge';

type TurnRequest = {
  readonly text: string;
  readonly mode: 'followup' | 'steer';
  readonly language?: string;
  readonly time_zone?: string;
  readonly answer_mode?: AnswerMode;
  readonly attachments?: readonly string[];
  readonly dropped_conditions?: readonly string[];
  readonly mentions?: readonly Record<string, unknown>[];
  readonly model?: string;
};

const FOLDER_TIP = '选一个工作文件夹：智能体在这台电脑上读写它里面的文件（按访问方式）';
const PRESET_LABELS: Record<string, string> = {
  'workspace-modify': '工作区内修改（默认）',
  'view-only': '仅可查看',
  'full-access': '完全权限',
};

/** 工作文件夹：Picker 选定，start 时用（发出第一句后就定了）。 */
let workingFolder: string | null = null;
const folderListeners = new Set<() => void>();
function setWorkingFolder(path: string | null): void {
  workingFolder = path;
  for (const listener of folderListeners) listener();
}

function FolderPicker(): React.ReactNode {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((value) => value + 1);
    folderListeners.add(listener);
    return () => folderListeners.delete(listener);
  }, []);
  return (
    <div role="group" aria-label="工作文件夹" className="kw-place flex items-center">
      <Select
        variant="ghost"
        size="sm"
        block={false}
        opticallyAlign="start"
        align="start"
        listWidth={320}
        TriggerStartIcon={Folder}
        value={workingFolder ?? ''}
        options={[
          ...(workingFolder === null ? [] : [{ value: workingFolder, label: workingFolder.split(/[\\/]/).at(-1) ?? workingFolder }]),
          { value: '__pick__', label: workingFolder === null ? FOLDER_TIP : '换一个文件夹' },
        ]}
        onChange={(option) => {
          if (option.value === '__pick__') void unwrap(bridge().pickFolder()).then((result) => setWorkingFolder(result.path ?? null));
        }}
      />
    </div>
  );
}

/** 三档访问方式（DSH 官方权限预设，切换是官方会话操作，记录随事件流回业务服务）。 */
function AccessControl({ conversationId }: { readonly conversationId: string }): React.ReactNode {
  const [catalog, setCatalog] = useState<{ defaultPreset: string; entries: { value: string; label: string }[] } | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const unwraped = await unwrap(bridge().accessCatalog());
        const raw = unwraped as unknown as { defaultPreset: string; catalog: { options: { value: string; name?: string }[] } };
        const entries = raw.catalog.options.map((option) => ({
          value: option.value,
          label: PRESET_LABELS[option.value] ?? option.name ?? option.value,
        }));
        let preset = raw.defaultPreset;
        try {
          preset = (await unwrap(bridge().getAccess(conversationId))).preset ?? preset;
        } catch {
          // 会话还没在宿主上开着：按默认档显示
        }
        if (!alive) return;
        setCatalog({ defaultPreset: raw.defaultPreset, entries });
        setCurrent(preset);
      } catch {
        // 宿主没起或这段对话不在这台电脑上：不显示
      }
    })();
    return () => { alive = false; };
  }, [conversationId]);
  if (catalog === null || current === null) return null;
  return (
    <div role="group" aria-label="访问方式" className="kw-place flex items-center">
      <Select
        variant="ghost"
        size="sm"
        block={false}
        opticallyAlign="start"
        align="start"
        listWidth={280}
        value={current}
        options={catalog.entries.map((entry) => ({ value: entry.value, label: entry.label }))}
        onChange={(option) => {
          setCurrent(option.value);
          void bridge().setAccess(conversationId, option.value);
        }}
      />
    </div>
  );
}

const LIMITS: InputLimits = {
  attachments: { tip: '本机对话的文件在工作文件夹里：用 @ 或拖进来提（即将支持拖入）', blocked: '本机对话暂不收附件：文件在工作文件夹里用 @ 提' },
};

/** 发一轮：附件不传（本机对话的文件在工作文件夹里，M5 起经 dropFiles 转 @ 路径），其余原样。 */
function deviceTurn(turn: TurnRequest): Record<string, unknown> {
  return {
    text: turn.text,
    mode: turn.mode,
    ...(turn.language !== undefined ? { language: turn.language } : {}),
    ...(turn.time_zone !== undefined ? { time_zone: turn.time_zone } : {}),
    ...(turn.answer_mode !== undefined ? { answer_mode: turn.answer_mode } : {}),
    ...(turn.mentions !== undefined ? { mentions: turn.mentions } : {}),
    ...(turn.model !== undefined ? { model: turn.model } : {}),
  };
}

export function deviceSource(): ConversationSource {
  return {
    id: DEVICE_SOURCE,
    label: '本机',
    description: '在这台电脑上执行：读写工作文件夹里的文件、跑本机程序，交付的文件直接存回文件夹',
    server: false,
    limits: LIMITS,
    Picker: FolderPicker,
    Controls: AccessControl,
    welcome: '在这台电脑上干活',
    footnote: '智能体在这台电脑上执行：读写工作文件夹、跑本机程序；账号、权限与对话记录仍在服务端',
    useBlocker: () => (bridgeAvailable() ? (workingFolder === null ? '先选一个工作文件夹（旁边那个）' : null) : '本机对话要在 KnowWork 桌面端里开'),
    start: async (input) => {
      const workspaceId = useWorkspaceStore.getState().id;
      if (workspaceId === null) throw new ApiError(0, '先在网页版里选择工作空间');
      if (workingFolder === null) throw new ApiError(0, '先选一个工作文件夹');
      const turn: Record<string, unknown> = {
        text: input.text,
        mode: 'followup',
        ...(input.answerMode !== undefined ? { answer_mode: input.answerMode } : {}),
        ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
      };
      const result = await unwrap(bridge().startConversation({ workspaceId, title: input.text.slice(0, 60), turn }));
      return { id: result.id as string, firstMessage: { text: input.text, mentions: input.mentions } };
    },
    actions: {
      check: async (conversationId: string) => {
        const { reason } = await unwrap(bridge().canContinue(conversationId));
        return reason ?? null;
      },
      send: async (conversationId: string, turn: TurnRequest) => {
        await unwrap(bridge().send(conversationId, deviceTurn(turn)));
        return undefined;
      },
      cancel: async (conversationId: string) => {
        await unwrap(bridge().cancel(conversationId));
      },
      decide: async (conversationId: string, approvalId: string, allow: boolean, remember: boolean) => {
        await unwrap(bridge().decide(conversationId, approvalId, allow, remember));
      },
      answer: async (conversationId: string, questionId: string, answers: readonly QuestionAnswer[]) => {
        await unwrap(bridge().answer(conversationId, questionId, answers));
      },
      remembersApprovals: true,
    },
    // files/dropFiles 在 M5 接：本机对话里的文件读写、另存、拖入拖出
  };
}
