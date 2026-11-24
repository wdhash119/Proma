import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getWorkspaceMemoryGuidance } from './agent-workspace-manager'
import { getAgentWorkspacePath } from './config-paths'

/**
 * 这些用例把 HOME/USERPROFILE 指向临时目录，从而让 config-paths 把工作区建在测试夹具里，
 * 不触碰真实的 ~/.proma。
 */
const workspaceSlug = 'guidance-workspace'
const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
const originalPromaDev = process.env.PROMA_DEV

let home: string

function memoryDir(): string {
  // 通过 config-paths 解析，避免依赖 .proma / .proma-dev 具体模式，也避免同进程其他测试的 electron mock 影响。
  return join(getAgentWorkspacePath(workspaceSlug), 'memory')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'proma-guidance-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.PROMA_DEV = '1'
  // 先落地工作区与 memory 目录，避免 getAgentWorkspacePath 之外的副作用
  mkdirSync(memoryDir(), { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
})

describe('工作区记忆引导的协作画像判定', () => {
  test('Given 记忆目录为空 When 读取引导 Then 需要协作画像', () => {
    expect(getWorkspaceMemoryGuidance(workspaceSlug).needsCollaborationProfile).toBe(true)
  })

  test('Given 只有旧画像 user-profile.md When 读取引导 Then 仍需要协作画像', () => {
    writeFileSync(join(memoryDir(), 'user-profile.md'), '# 旧用户画像\n\n- 用户是教师\n', 'utf8')

    expect(getWorkspaceMemoryGuidance(workspaceSlug).needsCollaborationProfile).toBe(true)
  })

  test('Given 只有旧画像 user_profile.md When 读取引导 Then 仍需要协作画像', () => {
    writeFileSync(join(memoryDir(), 'user_profile.md'), '# 旧用户画像\n\n- 用户是教师\n', 'utf8')

    expect(getWorkspaceMemoryGuidance(workspaceSlug).needsCollaborationProfile).toBe(true)
  })

  test('Given 存在常规 collaboration.md When 读取引导 Then 不再需要协作画像', () => {
    writeFileSync(join(memoryDir(), 'collaboration.md'), '# 项目协作画像\n\n- 用户偏好中文\n', 'utf8')

    expect(getWorkspaceMemoryGuidance(workspaceSlug).needsCollaborationProfile).toBe(false)
  })

  test('Given collaboration.md 是目录 When 读取引导 Then 仍需要协作画像', () => {
    mkdirSync(join(memoryDir(), 'collaboration.md'), { recursive: true })

    expect(getWorkspaceMemoryGuidance(workspaceSlug).needsCollaborationProfile).toBe(true)
  })

  test('Given collaboration.md 是符号链接 When 读取引导 Then 仍需要协作画像', () => {
    const outside = join(home, 'outside-collaboration.md')
    writeFileSync(outside, '# 外部画像\n\n- 外部事实\n', 'utf8')
    try {
      symlinkSync(outside, join(memoryDir(), 'collaboration.md'))
    } catch {
      // Windows 未开启开发者模式时无法创建符号链接，跳过该边界用例
      return
    }

    expect(getWorkspaceMemoryGuidance(workspaceSlug).needsCollaborationProfile).toBe(true)
  })

  test('Given collaboration.md 为空文件 When 读取引导 Then 视为已建立协作画像', () => {
    writeFileSync(join(memoryDir(), 'collaboration.md'), '', 'utf8')

    expect(getWorkspaceMemoryGuidance(workspaceSlug).needsCollaborationProfile).toBe(false)
  })
})
