/**
 * 变更请求观察者：从 Agent 的 shell 命令与输出里识别 PR。
 *
 * 纯逻辑模块，不依赖 electron，便于直接测试：
 * - 判断命令是 `gh pr create`、`git push` 还是引用某个 PR 的 `gh pr view/edit/checkout`；
 * - 从 `gh pr create` 输出里取出它自己创建的链接；
 * - 从 `git push` 输出里解析实际推送的 remote 与分支。
 *
 * 这些判断都刻意保持保守：宁可漏掉一次自动关联（用户可以手动补），
 * 也不要把仓库里无关分支的 PR 绑进会话。
 */

import { normalizeChangeRequestUrl } from '@proma/shared'

/** 单条输出最多解析 512KB，避免把超大日志整段正则扫描。 */
const MAX_OUTPUT_LENGTH = 512 * 1024

export interface PushedBranch {
  /** 远端名或 URL，来自 `To <remote>` 行 */
  remote: string
  branch: string
}

export function isShellToolName(name: string): boolean {
  const value = name.toLowerCase()
  return value === 'bash' || value === 'shell' || value === 'terminalexecute' || value === 'run_command'
}

export function commandFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const command = (input as { command?: unknown }).command
  return typeof command === 'string' && command.trim() ? command : null
}

/** `git push` 与 `gh pr` 命令都可能跨行书写，统一先压成一行再匹配。 */
function flattenCommand(command: string): string {
  return command.replace(/\\\r?\n/g, ' ')
}

export function isPullRequestCreateCommand(command: string | null): boolean {
  if (!command) return false
  const normalized = flattenCommand(command).trim()
  if (!/\bgh\b/.test(normalized)) return false
  return /(^|[;&|]\s*)(?:cd\s+[^;&|]+?[;&|]\s*)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*gh\s+pr\s+create\b/.test(normalized)
}

/** 读取/编辑/检出某个 PR：输出里出现的那条链接属于本会话。 */
export function isPullRequestReferenceCommand(command: string | null): boolean {
  if (!command) return false
  return /\bgh\s+pr\s+(?:view|edit|checkout)\b/.test(flattenCommand(command))
}

export function isPushCommand(command: string | null): boolean {
  if (!command) return false
  return /\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+push\b/.test(flattenCommand(command))
}

/** 从 `gh pr create` 输出里取它自己创建的链接（优先 `url:` 行与 JSON 字段）。 */
export function ownChangeRequestUrlFromOutput(text: string): string | null {
  if (!text || text.length > MAX_OUTPUT_LENGTH) return null
  const candidates: string[] = []
  for (const match of text.matchAll(/^\s*url:\s*(\S+)\s*$/gim)) candidates.push(match[1] ?? '')
  for (const match of text.matchAll(/"url"\s*:\s*"([^"]+)"/g)) candidates.push(match[1] ?? '')
  for (const candidate of candidates) {
    const normalized = normalizeChangeRequestUrl(candidate.replace(/[.,;:]+$/, ''))
    if (normalized) return normalized
  }
  return null
}

/**
 * 解析 `git push` 的输出，得到实际推送的 remote 与分支。
 *
 * 输出形如：
 * ```text
 * To git@github.com:owner/repo.git
 *    abc1234..def5678  feat/login -> feat/login
 *  ! [rejected]        main -> main (non-fast-forward)
 * ```
 * 只保留 `refs/heads/`（或裸分支名）的目标：tag 推送与删除不产生 PR。
 */
export function pushedBranchesFromOutput(text: string): PushedBranch[] {
  if (!text || text.length > MAX_OUTPUT_LENGTH) return []
  const pushed: PushedBranch[] = []
  let remote: string | null = null

  for (const line of text.split(/\r?\n/)) {
    const target = /^To (\S+)$/.exec(line.trim())
    if (target) {
      remote = target[1] ?? null
      continue
    }
    if (remote === null) continue

    const updated = /^\s*[+\-*! ]*\s*(.+?)\s*->\s*(\S+)\s*(?:\(forced update\))?$/.exec(line)
    if (!updated) continue

    const left = updated[1] ?? ''
    // 标签与已删除的引用不会产生 PR。
    if (/\[new tag\]|\[tag update\]|\[deleted\]/.test(left)) continue

    const source = left.split(/\s+/).pop() ?? ''
    const destination = updated[2] ?? ''
    if (source.startsWith('refs/tags/') || destination.startsWith('refs/tags/')) continue
    if (destination.startsWith('refs/') && !destination.startsWith('refs/heads/')) continue

    const branch = destination.replace(/^refs\/heads\//, '')
    if (!branch || branch === 'HEAD' || branch.startsWith('refs/')) continue

    if (!pushed.some((entry) => entry.remote === remote && entry.branch === branch)) {
      pushed.push({ remote, branch })
    }
  }

  return pushed
}

/** 把 tool_result 的 content（字符串或文本块数组）拼成纯文本。 */
export function textOfToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block && typeof block === 'object' && 'text' in block) {
        const text = (block as { text?: unknown }).text
        return typeof text === 'string' ? text : ''
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 待取结果的命令登记表。
 * tool_use 阶段记下命令，tool_result 阶段按 id 取回，因此不依赖消息顺序假设。
 * 有上限，避免长时间会话里无限增长。
 */
export class PendingCommandTracker {
  private commands = new Map<string, string>()
  private limit: number

  constructor(limit = 200) {
    this.limit = limit
  }

  remember(toolUseId: string, command: string): void {
    this.commands.set(toolUseId, command)
    while (this.commands.size > this.limit) {
      const oldest = this.commands.keys().next().value
      if (oldest === undefined) break
      this.commands.delete(oldest)
    }
  }

  take(toolUseId: string): string | null {
    const command = this.commands.get(toolUseId) ?? null
    this.commands.delete(toolUseId)
    return command
  }

  get size(): number {
    return this.commands.size
  }

  clear(): void {
    this.commands.clear()
  }
}
