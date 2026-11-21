/** desktop/resources-manifest.json 的 ESM 出口（脚本与打包流程共用；一致性测试直接读 JSON）。 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'resources-manifest.json'), 'utf8'),
)
