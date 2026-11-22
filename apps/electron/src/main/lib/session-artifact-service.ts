/**
 * 会话交付物服务。
 *
 * Agent 通过 `Present` 工具声明本轮真正交付给用户的文件；这里按会话保存成
 * `artifacts.json`，供渲染进程在会话顶部集中展示，避免文件和脚本混在同一列表里。
 * 只保存指针与说明，不复制文件，所以后续修改在同一路径上始终可见最新内容。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { getAgentSessionWorkspacePath } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

const ARTIFACTS_FILE = 'artifacts.json'
const MAX_ARTIFACTS = 20

interface PresentedArtifact {
  /** 绝对路径；渲染进程据此打开预览或系统默认应用。 */
  path: string
  description?: string
  presentedAt: number
}

interface ArtifactsFile {
  version: 1
  artifacts: PresentedArtifact[]
}

/** 仅供测试：注入隔离的会话目录，避免测试写入真实工作区。 */
let artifactRootOverride: ((workspaceSlug: string, sessionId: string) => string) | undefined

export function setSessionArtifactRootForTesting(
  resolve: ((workspaceSlug: string, sessionId: string) => string) | undefined,
): void {
  artifactRootOverride = resolve
}

function artifactsPath(workspaceSlug: string, sessionId: string): string {
  if (artifactRootOverride) {
    const dir = artifactRootOverride(workspaceSlug, sessionId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, ARTIFACTS_FILE)
  }
  return join(getAgentSessionWorkspacePath(workspaceSlug, sessionId), ARTIFACTS_FILE)
}

/** 读取会话交付物，最新在前。 */
export function listSessionArtifacts(workspaceSlug: string, sessionId: string): PresentedArtifact[] {
  const filePath = artifactsPath(workspaceSlug, sessionId)
  if (!existsSync(filePath)) return []
  const data = readJsonFileSafe<ArtifactsFile>(filePath)
  if (!data || !Array.isArray(data.artifacts)) return []
  return data.artifacts
    .filter((item): item is PresentedArtifact => (
      !!item && typeof item.path === 'string' && item.path.length > 0 && typeof item.presentedAt === 'number'
    ))
    .sort((left, right) => right.presentedAt - left.presentedAt)
}

interface PresentInput {
  path: string
  description?: string
}

/**
 * 记录一批交付物。同一路径重复声明时更新说明并刷新时间，而不是堆叠重复条目；
 * 只接受绝对路径，避免相对路径在不同 cwd 下指向不同文件。
 */
export function presentArtifacts(
  workspaceSlug: string,
  sessionId: string,
  inputs: PresentInput[],
  now = Date.now(),
): PresentedArtifact[] {
  const accepted = inputs
    .filter((input) => typeof input.path === 'string' && isAbsolute(input.path))
    .map((input) => resolve(input.path))

  if (accepted.length === 0) {
    throw new Error('Present 需要至少一个绝对文件路径')
  }

  const existing = listSessionArtifacts(workspaceSlug, sessionId)
  const merged = [...existing]
  for (const input of inputs) {
    if (typeof input.path !== 'string' || !isAbsolute(input.path)) continue
    const path = resolve(input.path)
    const index = merged.findIndex((item) => item.path === path)
    const entry: PresentedArtifact = {
      path,
      presentedAt: now,
      ...(input.description ? { description: input.description } : {}),
    }
    if (index >= 0) merged[index] = entry
    else merged.unshift(entry)
  }

  const limited = merged.slice(0, MAX_ARTIFACTS)
  writeJsonFileAtomic(artifactsPath(workspaceSlug, sessionId), { version: 1, artifacts: limited } satisfies ArtifactsFile)
  return limited
}

/** 移除一条交付物（用户从会话顶部删除时使用）。 */
export function removeSessionArtifact(workspaceSlug: string, sessionId: string, path: string): PresentedArtifact[] {
  const remaining = listSessionArtifacts(workspaceSlug, sessionId).filter((item) => item.path !== path)
  writeJsonFileAtomic(artifactsPath(workspaceSlug, sessionId), { version: 1, artifacts: remaining } satisfies ArtifactsFile)
  return remaining
}
