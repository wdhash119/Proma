/**
 * 通过 `gh` CLI 读取 GitHub 变更请求。
 *
 * 不引入额外依赖、也不读取用户的 token：直接复用系统里已登录的 gh，
 * 这样凭据仍由用户自己管理。所有调用都带超时与环境变量硬化，
 * 避免 gh 弹交互提示或更新通知把后台轮询卡住。
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { ChangeRequestCheck, ChangeRequestSnapshot } from '@proma/shared'
import { normalizeChangeRequestState, normalizeChangeRequestUrl, parseChangeRequestUrl, sameChangeRequestUrl } from '@proma/shared'

const execFileAsync = promisify(execFile)

export interface GitHubRepository {
  host: string
  owner: string
  name: string
}

export interface ChangeRequestView {
  snapshot: ChangeRequestSnapshot
  url: string
  host: string
  owner: string
  repo: string
  number: number
}

export type GhRunner = (program: string, args: string[], cwd: string) => Promise<string>

const VIEW_FIELDS = 'number,url,title,state,isDraft,headRefName,baseRefName,reviewDecision,mergeable,statusCheckRollup'
const LIST_FIELDS = 'number,url,headRefName,headRepositoryOwner'

const defaultRunner: GhRunner = async (program, args, cwd) => {
  try {
    const { stdout } = await execFileAsync(program, args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_PAGER: '',
        NO_COLOR: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    return stdout
  } catch (error) {
    const failure = error as { code?: string; killed?: boolean; stderr?: string }
    if (failure.code === 'ENOENT') throw new Error(`找不到 ${program}，请安装并确保它在 PATH 中。`)
    if (failure.killed) throw new Error(`${program} 请求超时，请检查网络后重试。`)
    throw new Error(failure.stderr?.trim() || `${program} 执行失败，请检查仓库、登录状态和网络。`)
  }
}

/** 解析 git remote 的 URL，支持 https 与 scp 风格。 */
export function parseGitHubRemote(remote: string): GitHubRepository | null {
  const value = remote.trim()
  let host: string | undefined
  let path: string

  const scp = /^git@([a-zA-Z0-9.-]+):([^?#]+)$/.exec(value)
  if (scp) {
    host = scp[1]!.toLowerCase()
    path = scp[2]!
  } else {
    try {
      const url = new URL(value)
      if (!['https:', 'ssh:'].includes(url.protocol)) return null
      if (url.password || url.port || url.search || url.hash) return null
      if (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) return null
      host = url.hostname.toLowerCase()
      path = url.pathname.replace(/^\//, '')
    } catch {
      return null
    }
  }

  if (!host || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) return null
  const match = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(path)
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') return null
  return { host, owner: match[1]!, name: match[2]! }
}

function repositoryArg(repo: GitHubRepository): string {
  return `${repo.owner}/${repo.name}`
}

function parseRemoteTarget(target: string): GitHubRepository | null {
  const direct = parseGitHubRemote(target)
  if (direct) return direct
  const scpLike = /^([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}):(\/?[^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(target.trim())
  return scpLike ? parseGitHubRemote(`git@${scpLike[1]}:${scpLike[2]}`) : null
}

/**
 * 把 `statusCheckRollup` 归一化为统一的 check 模型。
 *
 * GitHub 混用两种结构：
 * - CheckRun：带 `status`（QUEUED/IN_PROGRESS/COMPLETED）与 `conclusion`；
 * - 经典 StatusContext：只带 `state`（PENDING/SUCCESS/FAILURE/ERROR）。
 * 后者必须映射成相同的 status/conclusion 语义，否则 UI 按 conclusion 判断会错显。
 */
export function normalizeStatusCheckRollup(rollup: unknown): ChangeRequestCheck[] {
  if (!Array.isArray(rollup)) return []
  return rollup.map((item) => {
    const check = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const name = String(check.name ?? check.context ?? '检查')
    const status = typeof check.status === 'string' ? check.status : ''
    if (status) {
      return {
        name,
        status,
        conclusion: typeof check.conclusion === 'string' ? check.conclusion : '',
      }
    }
    // 经典 StatusContext：state 是终态或进行中态，没有独立的 status/conclusion。
    const state = typeof check.state === 'string' ? check.state.toUpperCase() : ''
    const pending = state === '' || state === 'PENDING' || state === 'EXPECTED'
    return {
      name,
      status: pending ? 'PENDING' : 'COMPLETED',
      conclusion: pending ? '' : state === 'SUCCESS' ? 'SUCCESS' : state,
    }
  })
}

function parseJsonArray(output: string, message: string): Array<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error(message)
  }
  if (!Array.isArray(parsed)) throw new Error(message)
  return parsed as Array<Record<string, unknown>>
}

function parseRepositorySlug(slug: string, host: string): GitHubRepository | null {
  const match = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/.exec(slug.trim())
  if (!match || match[1] === '.' || match[2] === '.') return null
  return { host, owner: match[1]!, name: match[2]! }
}

export class ChangeRequestGitHubService {
  private run: GhRunner

  constructor(run: GhRunner = defaultRunner) {
    this.run = run
  }

  /** 读取 origin 并解析成仓库；不是受支持的 GitHub 远端时抛出可读错误。 */
  async discoverRepository(cwd: string): Promise<GitHubRepository> {
    const remote = await this.run('git', ['remote', 'get-url', 'origin'], cwd)
    const repo = parseGitHubRemote(remote)
    if (!repo) throw new Error('origin 不是受支持的 GitHub 远端，请检查仓库远端配置。')
    return repo
  }

  /** 当前分支；detached HEAD 返回 null（此时不做分支发现）。 */
  async currentBranch(cwd: string): Promise<string | null> {
    const branch = (await this.run('git', ['branch', '--show-current'], cwd)).trim()
    return branch || null
  }

  /** 仓库根目录；用于判断会话 cwd 是否就在该项目里。 */
  async repositoryRoot(cwd: string): Promise<string | null> {
    try {
      const root = (await this.run('git', ['rev-parse', '--show-toplevel'], cwd)).trim()
      return root || null
    } catch {
      return null
    }
  }

  repositoryFromRemote(target: string): GitHubRepository | null {
    return parseRemoteTarget(target)
  }

  /** origin 是 fork 时返回其 upstream 仓库，否则 null。 */
  async upstreamRepositoryOf(cwd: string, repo: GitHubRepository): Promise<GitHubRepository | null> {
    try {
      const output = await this.run('gh', ['repo', 'view', repositoryArg(repo), '--json', 'parent'], cwd)
      const parsed = JSON.parse(output) as { parent?: { nameWithOwner?: string } }
      const slug = parsed.parent?.nameWithOwner
      return slug ? parseRepositorySlug(slug, repo.host) : null
    } catch {
      return null
    }
  }

  /** 按分支列出 open 变更请求：先查 origin，fork 再查 upstream，合并去重。 */
  async findByHead(
    cwd: string,
    repo: GitHubRepository,
    branch: string,
  ): Promise<Array<{ repository: GitHubRepository; number: number; url: string }>> {
    if (!branch.trim()) throw new Error('当前处于 detached HEAD，无法自动发现变更请求。')
    const upstream = await this.upstreamRepositoryOf(cwd, repo)
    const repositories = upstream ? [repo, upstream] : [repo]
    const allowedOwners = new Set(
      [repo.owner, upstream?.owner].filter((owner): owner is string => Boolean(owner)).map((owner) => owner.toLowerCase()),
    )

    const matches: Array<{ repository: GitHubRepository; number: number; url: string }> = []
    const seen = new Set<string>()
    for (const target of repositories) {
      const output = await this.run(
        'gh',
        ['pr', 'list', '--repo', `${target.host}/${repositoryArg(target)}`, '--state', 'open', '--head', branch, '--limit', '100', '--json', LIST_FIELDS],
        cwd,
      )
      for (const item of parseJsonArray(output, 'GitHub 返回了无效的变更请求列表。')) {
        if (item.headRefName !== branch) continue
        const headOwner = (item.headRepositoryOwner as { login?: string } | undefined)?.login?.toLowerCase()
        if (headOwner && !allowedOwners.has(headOwner)) continue
        const number = item.number
        if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) continue
        const url = normalizeChangeRequestUrl(String(item.url ?? ''))
        if (!url || seen.has(url)) continue
        const ref = parseChangeRequestUrl(url)
        if (!ref || ref.number !== number) continue
        seen.add(url)
        matches.push({ repository: target, number, url })
      }
    }
    return matches
  }

  /** URL 查询不依赖仓库，也不依赖临时 worktree。 */
  async viewUrlFromHome(url: string): Promise<ChangeRequestView> {
    return this.viewUrl(homedir(), url)
  }

  /** 读取一条变更请求的最新状态；URL 或编号不一致时拒绝写入。 */
  async viewUrl(cwd: string, url: string): Promise<ChangeRequestView> {
    const normalized = normalizeChangeRequestUrl(url)
    const ref = normalized ? parseChangeRequestUrl(normalized) : null
    if (!ref || !normalized) throw new Error('请输入当前 GitHub host 的变更请求链接。')

    const output = await this.run('gh', ['pr', 'view', normalized, '--json', VIEW_FIELDS], cwd)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(output) as Record<string, unknown>
    } catch {
      throw new Error('GitHub 返回了无效的变更请求。')
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('GitHub 返回了无效的变更请求。')
    if (parsed.number !== ref.number || !sameChangeRequestUrl(String(parsed.url ?? ''), normalized)) {
      throw new Error('GitHub 返回了不匹配的变更请求。')
    }

    return {
      snapshot: {
        title: typeof parsed.title === 'string' ? parsed.title : '',
        state: normalizeChangeRequestState(typeof parsed.state === 'string' ? parsed.state : undefined),
        isDraft: parsed.isDraft === true,
        headRefName: typeof parsed.headRefName === 'string' ? parsed.headRefName : '',
        baseRefName: typeof parsed.baseRefName === 'string' ? parsed.baseRefName : '',
        reviewDecision: typeof parsed.reviewDecision === 'string' ? parsed.reviewDecision : '',
        mergeable: String(parsed.mergeable ?? 'UNKNOWN').toUpperCase(),
        checks: normalizeStatusCheckRollup(parsed.statusCheckRollup),
        fetchedAt: Date.now(),
      },
      url: normalized,
      host: ref.host,
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
    }
  }
}

export const changeRequestGitHubService = new ChangeRequestGitHubService()
