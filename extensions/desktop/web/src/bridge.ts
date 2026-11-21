/**
 * window.knowworkDesktop 的桥（desktop/src/preload/index.cjs 注入）：本机对话的动作都从这里过。
 * 桥的应答是 {ok:true, ...} 或 {ok:false, error:{status?, code?, message}}——解包成网页版的 ApiError，
 * 让对话页照常显示（额度、空间停用、设备不符这些说法都在 error.message 里）。
 */

import { ApiError } from '@knowwork/web/api/http';

type Bridge = {
  startConversation(payload: { workspaceId: string; folder: string; title?: string; turn: Record<string, unknown> }): Promise<Result & { id?: string }>;
  send(conversationId: string, turn: Record<string, unknown>): Promise<Result>;
  cancel(conversationId: string): Promise<Result>;
  decide(conversationId: string, approvalId: string, allow: boolean, remember: boolean): Promise<Result>;
  answer(conversationId: string, questionId: string, answers: readonly unknown[]): Promise<Result>;
  delete(conversationId: string): Promise<Result>;
  setAccess(conversationId: string, preset: string): Promise<Result>;
  accessCatalog(): Promise<Result>;
  canContinue(conversationId: string): Promise<Result & { reason?: string | null }>;
  place(conversationId: string): Promise<Result & { device?: string | null }>;
  pickFolder(): Promise<Result & { path?: string | null }>;
  filesRead(conversationId: string, path: string): Promise<Result & { bytes: Uint8Array }>;
  filesPdf(conversationId: string, path: string): Promise<Result & { bytes: Uint8Array }>;
  filesSave(conversationId: string, path: string): Promise<Result & { saved?: boolean }>;
  filesOpen(conversationId: string, path: string, how: 'app' | 'reveal'): Promise<Result>;
  filesReferences(conversationId: string, query: string): Promise<Result & { references?: FileReference[] }>;
  dropFiles(files: readonly File[], conversationId: string): Promise<Result & { mentions?: string[]; skipped?: string[] }>;
};

type FileReference = { path: string; kind: 'file' | 'directory'; insert: string };

export type Result = { ok: true } | { ok: false; error?: { status?: number; code?: string; message?: string } };

export function bridgeAvailable(): boolean {
  return typeof window !== 'undefined' && typeof (window as { knowworkDesktop?: unknown }).knowworkDesktop === 'object';
}

export function bridge(): Bridge {
  if (!bridgeAvailable()) throw new ApiError(0, '请在 KnowWork 桌面端里继续本机对话');
  return (window as { knowworkDesktop: Bridge }).knowworkDesktop;
}

/** 桥的应答解包：ok 直接给数据；失败翻成 ApiError（status 与 code 都带上，界面按 code 换说法）。 */
export async function unwrap<T extends Result>(promise: Promise<T>): Promise<Omit<T, 'ok'>> {
  const result = await promise;
  if (!result.ok) {
    throw new ApiError(result.error?.status ?? 0, result.error?.message ?? '操作没有成功', result.error?.code);
  }
  const { ok: _ok, ...rest } = result;
  return rest as Omit<T, 'ok'>;
}
