/** KnowWork 桌面端扩展的前端包：登记「本机」来源（对话在这台电脑上执行）与设备名提示。
 * 构建带扩展的镜像时经 KNOWWORK_WEB_EXTENSIONS 指到本入口（web/vite.config.ts）；动作经
 * window.knowworkDesktop 桥（desktop/src/preload）交到这台电脑上。 */

import type { Register } from '@knowwork/web/slots/registry';
import { bridge, bridgeAvailable } from './bridge';
import { deviceSource } from './deviceSource';

export function install(register: Register): void {
  register('chat.sources', deviceSource(), 'desktop');
  // 别处（网页、手机）只读时的提示：写明在哪台电脑上执行
  register('chat.place', {
    describe: async (conversationId: string) => {
      if (!bridgeAvailable()) return null;
      try {
        const { device } = await bridge().place(conversationId);
        return device ?? null;
      } catch {
        return null;
      }
    },
  }, 'desktop');
  void bridge; // bridge 在 deviceSource 与 place 里用；这里只确保模块被引用
}
