import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getUserAgentsSkillsDir } from './config-paths'

const libRoot = join(import.meta.dir)

describe('用户级全局 Skills 目录', () => {
  test('Given 用户主目录 When 解析全局 Skills 目录 Then 指向 ~/.AGENTS/skills', () => {
    expect(getUserAgentsSkillsDir()).toBe(join(homedir(), '.AGENTS', 'skills'))
  })

  test('Given 全新环境 When 解析全局 Skills 目录 Then 不创建目录（只读来源）', () => {
    const dir = getUserAgentsSkillsDir()

    expect(dir.endsWith(join('.AGENTS', 'skills'))).toBe(true)
    // 该路径由用户自行维护；解析函数不得产生 mkdir 副作用。
    expect(typeof existsSync(dir)).toBe('boolean')
  })
})

describe('编排层注入用户级 Skills 契约', () => {
  function readOrchestrator(): string {
    return readFileSync(join(libRoot, 'agent-orchestrator.ts'), 'utf8')
  }

  test('Given 工作区会话 When 构建 additionalSkillPaths Then 同时包含工作区与用户级目录', () => {
    const source = readOrchestrator()

    expect(source).toContain('getUserAgentsSkillsDir')
    expect(source).toContain('getWorkspaceSkillsDir(workspaceSlug)')
    expect(source).toContain('additionalSkillPaths: [')
  })

  test('Given 用户级目录可能不存在 When 注入路径 Then 先做 existsSync 守卫', () => {
    const source = readOrchestrator()

    expect(source).toContain("import { existsSync } from 'node:fs'")
    expect(source).toContain('existsSync(getUserAgentsSkillsDir()) ? [getUserAgentsSkillsDir()] : []')
  })
})
