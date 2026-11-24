/**
 * GitHub Release 服务
 *
 * 从 fork 仓库（wdhash119/Proma）的 GitHub API 获取项目的发布日志（Release Notes）。
 * 国内网络下直连失败（网络错误/超时）时，自动回退到支持 API JSON 的代理镜像
 * （实测仅 gh-proxy.com 支持 api.github.com，见 github-proxy.ts）。
 */

import type {
  GitHubRelease,
  GitHubReleaseListOptions,
} from '@proma/shared'
import { GITHUB_API_PROXY_MIRRORS, proxiedGitHubUrl } from './github-proxy'

/** GitHub API 基础 URL */
const GITHUB_API_BASE = 'https://api.github.com'

/** GitHub 仓库配置（与 electron-builder.yml 的 publish 一致，指向现 fork） */
const GITHUB_REPO = {
  owner: 'wdhash119',
  repo: 'Proma',
}

export const GITHUB_REPO_OWNER = GITHUB_REPO.owner
export const GITHUB_REPO_NAME = GITHUB_REPO.repo

/** 单次请求超时，避免国内网络下无限挂起 */
const FETCH_TIMEOUT_MS = 12_000

/** Release 缓存 */
interface ReleaseCache {
  data: GitHubRelease[]
  timestamp: number
}

let releaseCache: ReleaseCache | null = null

/** 单个 Release 缓存（按 tag） */
const tagCache = new Map<string, { data: GitHubRelease; timestamp: number }>()

/** 最新 tag 缓存（供更新器代理回退构造 feed，较短 TTL 以便追赶新发布） */
let latestTagCache: { tag: string; timestamp: number } | null = null
const LATEST_TAG_TTL = 5 * 60 * 1000

/** 缓存有效期（30 分钟） */
const CACHE_TTL = 30 * 60 * 1000

/** Rate limit 冷却标记 */
let rateLimitUntil = 0

/** 进程内记住可用的 API 代理镜像；重启后重新尝试直连 */
let apiProxyMirror: string | null = null

/** 带超时的单次 fetch */
async function fetchOnce(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Proma-Desktop-App',
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从 GitHub API 获取 releases
 *
 * 直连失败（网络错误/超时/响应解析失败）时逐个尝试 API 代理镜像；
 * 403/429 限流与其余真实响应错误不做代理重试。
 *
 * @param endpoint - API 端点
 * @returns Release 数据
 */
async function fetchFromGitHub<T>(endpoint: string): Promise<T> {
  // Rate limit 冷却期内直接跳过
  if (Date.now() < rateLimitUntil) {
    throw new Error('GitHub API 请求过于频繁，请稍后再试')
  }

  const directUrl = `${GITHUB_API_BASE}/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}${endpoint}`
  const urls = apiProxyMirror
    ? [proxiedGitHubUrl(apiProxyMirror, directUrl)]
    : [directUrl, ...GITHUB_API_PROXY_MIRRORS.map((mirror) => proxiedGitHubUrl(mirror, directUrl))]

  let lastError: Error | null = null
  for (const url of urls) {
    console.log(`[GitHub Release] 正在请求: ${url}`)

    let response: Response
    try {
      response = await fetchOnce(url)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      console.warn(`[GitHub Release] 请求失败，尝试回退: ${url} (${lastError.message})`)
      continue
    }

    if (response.status === 403 || response.status === 429) {
      // Rate limited — 冷却 15 分钟
      rateLimitUntil = Date.now() + 15 * 60 * 1000
      throw new Error('GitHub API 请求过于频繁，请 15 分钟后重试')
    }

    if (!response.ok) {
      throw new Error(
        `GitHub API 请求失败 (${response.status})，请检查网络连接后重试`
      )
    }

    try {
      const data = await response.json() as T
      if (url !== directUrl) {
        const mirror = GITHUB_API_PROXY_MIRRORS.find((m) => url.startsWith(m))
        if (mirror) {
          apiProxyMirror = mirror
          console.log(`[GitHub Release] 已切换到 API 代理镜像: ${mirror}`)
        }
      }
      return data
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      console.warn(`[GitHub Release] 响应解析失败，尝试回退: ${url}`)
      continue
    }
  }

  throw new Error(`无法连接 GitHub API（含代理回退）: ${lastError?.message ?? '未知错误'}`)
}

/**
 * 获取最新 release 的 tag（供更新器代理回退时构造带 tag 的 feed 地址）。
 * 失败返回 null，不抛异常；5 分钟内复用结果。
 */
export async function getLatestReleaseTag(): Promise<string | null> {
  if (latestTagCache && Date.now() - latestTagCache.timestamp < LATEST_TAG_TTL) {
    return latestTagCache.tag
  }
  try {
    const release = await fetchFromGitHub<GitHubRelease>('/releases/latest')
    const tag = release?.tag_name
    if (!tag) return null
    latestTagCache = { tag, timestamp: Date.now() }
    return tag
  } catch (error) {
    console.warn('[GitHub Release] 获取最新 tag 失败:', error)
    return null
  }
}

/**
 * 获取 Release 列表
 *
 * @param options - 查询选项
 * @returns Release 列表
 */
export async function listReleases(
  options: GitHubReleaseListOptions = {}
): Promise<GitHubRelease[]> {
  const {
    perPage = 10,
    page = 1,
    includePrerelease = false,
  } = options

  try {
    // 检查缓存
    if (
      releaseCache &&
      Date.now() - releaseCache.timestamp < CACHE_TTL &&
      page === 1
    ) {
      console.log('[GitHub Release] 使用缓存的 Release 列表')
      const filtered = includePrerelease
        ? releaseCache.data
        : releaseCache.data.filter(r => !r.prerelease && !r.draft)
      return filtered.slice(0, perPage)
    }

    // 构建查询参数
    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
    })

    const releases = await fetchFromGitHub<GitHubRelease[]>(
      `/releases?${params.toString()}`
    )

    console.log(`[GitHub Release] 获取到 ${releases.length} 个 Releases`)

    // 过滤草稿和预发布版本（如果需要）
    const filtered = includePrerelease
      ? releases
      : releases.filter(r => !r.prerelease && !r.draft)

    // 更新缓存（仅第一页）
    if (page === 1) {
      releaseCache = {
        data: releases,
        timestamp: Date.now(),
      }
    }

    return filtered
  } catch (error) {
    console.error('[GitHub Release] 获取 Release 列表失败:', error)
    // 如果有缓存，即使过期也返回
    if (releaseCache) {
      console.log('[GitHub Release] API 请求失败，使用过期缓存')
      const filtered = includePrerelease
        ? releaseCache.data
        : releaseCache.data.filter(r => !r.prerelease && !r.draft)
      return filtered.slice(0, perPage)
    }
    // 没有缓存时抛出异常，让前端知道加载失败
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * 根据标签名获取指定的 Release
 *
 * @param tag - 标签名（版本号）
 * @returns 指定的 Release，如果没有则返回 null
 */
export async function getReleaseByTag(tag: string): Promise<GitHubRelease | null> {
  try {
    // 检查缓存
    const cached = tagCache.get(tag)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data
    }

    const release = await fetchFromGitHub<GitHubRelease>(
      `/releases/tags/${tag}`
    )
    console.log(`[GitHub Release] 获取 Release: ${tag}`)

    tagCache.set(tag, { data: release, timestamp: Date.now() })
    return release
  } catch (error) {
    console.error(`[GitHub Release] 获取 Release ${tag} 失败:`, error)
    // 返回过期缓存
    const cached = tagCache.get(tag)
    if (cached) return cached.data
    return null
  }
}