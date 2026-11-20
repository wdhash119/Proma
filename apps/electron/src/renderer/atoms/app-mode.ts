/**
 * App Mode Atom - 应用模式状态
 *
 * Chat 模式已退役：主入口统一为 Agent，所有对话在 Agent 中进行。
 *
 * 这里保留 `AppMode` 联合类型与 atom 形状，让既有的 `mode === 'chat'` 分支
 * 保持类型合法（运行时永远不成立），并把 atom 值固定为 'agent'、setter 拒绝切换。
 * 这样历史 localStorage 中残留的 'chat' 也不会让界面回到已退役的模式。
 *
 * 历史 Chat 数据保留在 conversations.json / JSONL 中，可在
 * 「设置 → 历史 Chat」检索并逐条交给 Agent 继续。
 */

import { atom } from 'jotai'

export type AppMode = 'chat' | 'agent'

/** 当前唯一生效模式。setter 拒绝任何非 agent 切换。 */
export const appModeAtom = atom<AppMode, [AppMode], void>(
  () => 'agent',
  (_get, _set, next) => {
    if (next !== 'agent') {
      console.warn('[AppMode] Chat 模式已退役，模式切换被忽略')
    }
  },
)
