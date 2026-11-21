/**
 * 变更请求（PR）追踪服务。
 *
 * 绑定来源有四条：用户在改动区手动关联、按当前分支自动发现、
 * Agent 创建 PR 后从命令输出识别、以及正文里引用的链接。
 * 所有来源都先过一遍「当前会话仓库」校验，避免把别的仓库 PR 混进会话。
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { BrowserWindow } from 'electron'
import type { ChangeRequestBinding, ChangeRequestSnapshot, ChangeRequestsActionInput } from '@proma/shared'
import { CHANGE_REQUESTS_IPC_CHANNELS, extractChangeRequestUrls, normalizeChangeRequestUrl, parseChangeRequestUrl } from '@proma/shared'
import { getAgentSessionMeta, resolveAgentCwd } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import type { ChangeRequestFetchResult } from './change-request-store'
import {
  applyBindingResult,
  dismissBinding,
  listBindings,
  listBoundSessions,
  mergeBindings,
  ownersOfUrl,
  removeBinding,
  restoreBinding,
  trackBinding,
} from './change-request-store'
import { ChangeRequestPoller } from './change-request-poller'
import { isTurnEndEvent, shouldDiscoverAfterTurn, TurnDiscoveryScheduler } from './change-request-turn-discovery'
import {
  commandFromToolInput,
  isPullRequestCreateCommand,
  isPullRequestReferenceCommand,
  isPushCommand,
  isShellToolName,
  ownChangeRequestUrlFromOutput,
  PendingCommandTracker,
  pushedBranchesFromOutput,
  textOfToolResult,
} from './change-request-observer'
import { changeRequestGitHubService, type GitHubRepository } from './github-change-request-service'

const SCOPE_TTL_MS = 60_000

/** 会话所在目录：优先活动 worktree，其次项目根，最后默认检出。 */
function resolveSessionRepositoryCwd(sessionId: string): string | null {
  const session = getAgentSessionMeta(sessionId)
  if (!session) return null
  if (session.activeWorktree?.path) return session.activeWorktree.path
  const workspace = session.workspaceId ? getAgentWorkspace(session.workspaceId) : undefined
  if (workspace?.projectRootPath) return workspace.projectRootPath
  return resolveAgentCwd(workspace, session.id, session.agentCwdMode, session.activeWorktree) ?? null
}

function notifyChangeRequestsChanged(sessionIds: string[]): void {
  const unique = [...new Set(sessionIds)]
  if (unique.length === 0) return
  const payload = { sessionIds: unique }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send(CHANGE_REQUESTS_IPC_CHANNELS.CHANGED, payload)
  }
}

function settleUrl(url: string, result: ChangeRequestFetchResult): string[] {
  const affected: string[] = []
  for (const sessionId of ownersOfUrl(url)) {
    applyBindingResult(sessionId, url, result)
    affected.push(sessionId)
  }
  return affected
}

function fetchUrl(url: string): Promise<ChangeRequestFetchResult> {
  return changeRequestGitHubService.viewUrlFromHome(url).then(
    (view) => ({ snapshot: view.snapshot }),
    (error) => ({ error: error instanceof Error ? error.message : String(error) }),
  )
}

const poller = new ChangeRequestPoller({
  fetch: fetchUrl,
  settle: settleUrl,
  notify: notifyChangeRequestsChanged,
})

function syncPoller(): void {
  poller.sync(listBoundSessions())
}

interface RepositoryScope {
  cwd: string
  repo: GitHubRepository
  upstream: GitHubRepository | null
  repositories: Set<string>
}

const scopeCache = new Map<string, { cwd: string; at: number; value: RepositoryScope | null }>()

function repositoryKey(repo: GitHubRepository): string {
  return `${repo.host}/${repo.owner}/${repo.name}`.toLowerCase()
}

function urlRepositoryKey(url: string): string | null {
  const ref = parseChangeRequestUrl(url)
  return ref ? `${ref.host}/${ref.owner}/${ref.repo}`.toLowerCase() : null
}

async function sessionRepositoryScope(sessionId: string): Promise<RepositoryScope | null> {
  const cwd = resolveSessionRepositoryCwd(sessionId)
  if (!cwd) return null
  const now = Date.now()
  const cached = scopeCache.get(sessionId)
  if (cached && cached.cwd === cwd && now - cached.at < SCOPE_TTL_MS) return cached.value

  let value: RepositoryScope | null = null
  try {
    const repo = await changeRequestGitHubService.discoverRepository(cwd)
    const upstream = await changeRequestGitHubService.upstreamRepositoryOf(cwd, repo)
    const repositories = new Set([repositoryKey(repo)])
    if (upstream) repositories.add(repositoryKey(upstream))
    value = { cwd, repo, upstream, repositories }
  } catch {
    value = null
  }
  scopeCache.set(sessionId, { cwd, at: now, value })
  return value
}

function scopeFilter(
  scope: RepositoryScope | null,
  allowUnknownScope: boolean,
): ((url: string) => boolean) | undefined {
  // 无法识别仓库时：明确要求限制范围就全部拒绝，否则不额外过滤（手动关联仍需用户显式动作）。
  if (!scope) return allowUnknownScope ? undefined : () => false
  return (url) => {
    const key = urlRepositoryKey(url)
    return key !== null && scope.repositories.has(key)
  }
}

async function applyObservedBindings(
  sessionId: string,
  urls: string[],
  source: ChangeRequestBinding['source'],
  options: { allowUnknownScope?: boolean } = {},
): Promise<void> {
  if (urls.length === 0) return
  const scope = await sessionRepositoryScope(sessionId)
  const accept = scopeFilter(scope, options.allowUnknownScope === true)
  const before = listBindings(sessionId).length
  const after = mergeBindings(sessionId, urls, source, accept)
  if (after.length === before) return
  syncPoller()
  poller.refresh(sessionId)
  notifyChangeRequestsChanged([sessionId])
}

/** 按当前分支发现未关闭的 PR；返回可读错误但不阻塞其它操作。 */
async function discoverSession(sessionId: string): Promise<string | undefined> {
  const scope = await sessionRepositoryScope(sessionId)
  if (!scope) return undefined
  try {
    const branch = await changeRequestGitHubService.currentBranch(scope.cwd)
    if (!branch) return undefined
    const matches = await changeRequestGitHubService.findByHead(scope.cwd, scope.repo, branch)
    if (matches.length === 0) return undefined
    const accept = scopeFilter(scope, false)
    const urls = matches.map((match) => match.url).filter((url) => accept === undefined || accept(url))
    if (urls.length > 0) {
      const before = listBindings(sessionId).length
      const after = mergeBindings(sessionId, urls, 'discovered', accept)
      if (after.length > before) poller.refresh(sessionId)
    }
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function normalizeRequestedUrl(url: string | undefined): string {
  const normalized = url ? normalizeChangeRequestUrl(url) : null
  if (!normalized) throw new Error('请输入当前 GitHub host 的变更请求链接。')
  return normalized
}

export async function handleChangeRequestsAction(input: ChangeRequestsActionInput): Promise<{
  bindings: ChangeRequestBinding[]
  error?: string
}> {
  const session = getAgentSessionMeta(input.sessionId)
  if (!session) throw new Error('会话不存在')
  let error: string | undefined

  switch (input.action) {
    case 'list':
      listBindings(session.id)
      break
    case 'discover':
      error = await discoverSession(session.id)
      break
    case 'refresh': {
      listBindings(session.id)
      syncPoller()
      const results = await poller.refreshAndWait(
        session.id,
        input.url ? normalizeRequestedUrl(input.url) : undefined,
      )
      const failures = results.filter((result): result is { error: string } => 'error' in result)
      if (failures.length > 0) error = `刷新失败：${failures[0]!.error}`
      break
    }
    case 'track': {
      const url = normalizeRequestedUrl(input.url)
      const view = await changeRequestGitHubService.viewUrlFromHome(url)
      trackBinding(session.id, view.url, 'tracked')
      applyBindingResult(session.id, view.url, { snapshot: view.snapshot })
      poller.refreshUrl(view.url)
      break
    }
    case 'dismiss':
      dismissBinding(session.id, normalizeRequestedUrl(input.url))
      syncPoller()
      break
    case 'restore':
      restoreBinding(session.id, normalizeRequestedUrl(input.url))
      poller.refresh(session.id)
      break
    case 'remove':
      removeBinding(session.id, normalizeRequestedUrl(input.url))
      syncPoller()
      break
    default:
      throw new Error('变更请求操作无效')
  }

  syncPoller()
  const bindings = listBindings(session.id)
  if (input.action !== 'list') notifyChangeRequestsChanged([session.id])
  return { bindings, ...(error ? { error } : {}) }
}

// ===== 从 Agent 输出里自动发现 =====

const pendingCommands = new PendingCommandTracker()

/**
 * `git push` 之后按实际推送的分支逐个发现 PR。
 *
 * 只按当前分支发现会漏掉「一个 turn 里推了多个分支」的情况；
 * 每条推送先解析 remote 得到仓库，再用仓库范围过滤，避免跨仓库串绑定。
 */
function observePushedBranches(sessionId: string, output: string): void {
  const pushed = pushedBranchesFromOutput(output)
  if (pushed.length === 0) return

  void (async () => {
    const scope = await sessionRepositoryScope(sessionId)
    for (const pushedRef of pushed) {
      const repository = changeRequestGitHubService.repositoryFromRemote(pushedRef.remote) ?? scope?.repo ?? null
      if (!repository) continue
      if (scope && !scope.repositories.has(repositoryKey(repository))) continue

      const matches = await changeRequestGitHubService
        .findByHead(scope?.cwd ?? homedir(), repository, pushedRef.branch)
        .catch(() => [])
      if (matches.length === 0) continue
      await applyObservedBindings(sessionId, matches.map((match) => match.url), 'discovered', {
        allowUnknownScope: true,
      })
    }
  })().catch((error) => {
    console.warn('[变更请求] 推送后发现失败:', error)
  })
}

/**
 * 订阅 Agent 流：识别 PR 创建与推送，并把正文里出现的 PR 链接自动关联。
 * 只处理新产生的消息（重放的不算），避免历史会话一打开就批量写绑定。
 */
export function observeAgentStreamPayload(
  sessionId: string,
  payload: { kind: string; message?: unknown; event?: unknown },
): void {
  if (payload.kind === 'proma_event') {
    // 轮次结束是唯一可靠的「这一轮改完了」信号：刷新状态，再安排一次分支发现。
    if (isTurnEndEvent(payload.event)) {
      poller.refresh(sessionId)
      turnDiscovery.schedule(sessionId)
    }
    return
  }
  if (payload.kind !== 'sdk_message' || !payload.message) return
  const message = payload.message as Record<string, unknown>
  if (message.isReplay === true) return

  if (message.type === 'assistant') {
    const content = (message.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return
    const urls: string[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const typed = block as { type?: string; name?: string; id?: string; input?: unknown; text?: string }
      if (typed.type === 'text' && typeof typed.text === 'string') {
        urls.push(...extractChangeRequestUrls(typed.text))
        continue
      }
      if (typed.type !== 'tool_use') continue
      const name = typeof typed.name === 'string' ? typed.name : ''
      if (!isShellToolName(name)) continue
      const command = commandFromToolInput(typed.input)
      if (!command || typeof typed.id !== 'string') continue
      if (isPullRequestCreateCommand(command) || isPushCommand(command)) {
        pendingCommands.remember(typed.id, command)
      }
    }
    if (urls.length > 0) void applyObservedBindings(sessionId, urls, 'referenced')
    return
  }

  if (message.type !== 'user') return
  const content = (message.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const typed = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
    if (typed.type !== 'tool_result' || typeof typed.tool_use_id !== 'string') continue
    const command = pendingCommands.take(typed.tool_use_id)
    if (!command) continue
    // 失败的命令不会有真实 PR；跳过可避免把报错信息里的链接当成本轮产物。
    if (typed.is_error === true) continue
    const output = textOfToolResult(typed.content)
    if (isPullRequestCreateCommand(command)) {
      // 真正创建出来的链接：gh 直接打印 URL，也可能带 url: 前缀或 JSON 字段。
      const created = extractChangeRequestUrls(output)
      const own = ownChangeRequestUrlFromOutput(output)
      const urls = created.length > 0 ? created : own ? [own] : []
      if (urls.length > 0) void applyObservedBindings(sessionId, urls, 'created', { allowUnknownScope: true })
      continue
    }
    if (isPullRequestReferenceCommand(command)) {
      const own = ownChangeRequestUrlFromOutput(output)
      if (own) void applyObservedBindings(sessionId, [own], 'referenced')
      continue
    }
    if (isPushCommand(command)) observePushedBranches(sessionId, output)
  }
}


// ===== 轮次结束时的分支发现 =====

function defaultTurnDiscovery(sessionId: string): void {
  const session = getAgentSessionMeta(sessionId)
  if (!session) return
  const hasBindings = listBindings(sessionId).length > 0
  const cwd = resolveSessionRepositoryCwd(sessionId)
  const projectRoot = session.workspaceId
    ? getAgentWorkspace(session.workspaceId)?.projectRootPath ?? null
    : null

  void changeRequestGitHubService.repositoryRoot(cwd ?? homedir())
    .then((repositoryRoot) => {
      if (!shouldDiscoverAfterTurn({ hasBindings, repositoryRoot, projectRoot })) return
      void discoverSession(sessionId).then(() => syncPoller())
    })
    .catch(() => {
      // 非 Git 仓库或目录不可读：这一轮没有可发现的 PR，静默跳过。
    })
}

const turnDiscovery = new TurnDiscoveryScheduler({ run: defaultTurnDiscovery })

/** 安排一次防抖的分支发现；同一会话的新请求会顶掉旧请求。 */
export function scheduleTurnDiscovery(sessionId: string): void {
  turnDiscovery.schedule(sessionId)
}

// ===== 生命周期 =====

/** 应用启动时同步一次绑定，并让轮询器开始工作。 */
export function initChangeRequestService(): void {
  try {
    syncPoller()
    // 启动即刷新一次，避免显示上次运行留下的过期状态。
    poller.refresh()
  } catch (error) {
    console.warn('[变更请求] 初始化失败:', error)
  }
}

export function disposeChangeRequestService(): void {
  poller.dispose()
  turnDiscovery.cancelAll()
  scopeCache.clear()
  pendingCommands.clear()
}

/** 供测试注入：解析会话仓库时使用的目录。 */
export function resolveChangeRequestRepositoryCwd(sessionId: string): string | null {
  const fallback = resolveSessionRepositoryCwd(sessionId) ?? homedir()
  return resolve(fallback)
}

export type { ChangeRequestSnapshot }
