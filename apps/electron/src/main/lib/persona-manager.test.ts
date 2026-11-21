import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_DEFAULT_PERSONA_ID, BUILTIN_PERSONAS } from '@proma/shared'

// 人设服务只依赖 electron dialog 与配置路径；重定向到临时目录，避免触碰真实 ~/.proma。
let openDialogResult: { canceled: boolean; filePaths: string[] } = { canceled: true, filePaths: [] }
let saveDialogResult: { canceled: boolean; filePath?: string } = { canceled: true }

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => join(tmpdir(), 'proma-persona-electron'), getName: () => 'Proma' },
  dialog: {
    showOpenDialog: async () => openDialogResult,
    showSaveDialog: async () => saveDialogResult,
  },
}))

let root: string
let personasPath: string
let legacyPath: string

mock.module('./config-paths', () => ({
  getPersonasPath: () => personasPath,
  getSystemPromptsPath: () => legacyPath,
}))

type PersonaManagerModule = typeof import('./persona-manager')
let manager: PersonaManagerModule

beforeAll(async () => {
  manager = await import('./persona-manager')
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-persona-test-'))
  personasPath = join(root, 'personas.json')
  legacyPath = join(root, 'system-prompts.json')
  openDialogResult = { canceled: true, filePaths: [] }
  saveDialogResult = { canceled: true }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('人设配置与 CRUD', () => {
  test('Given 无配置文件 When 读取 Then 内置人设齐全且默认为默认助手', () => {
    const config = manager.getPersonaConfig()
    expect(config.personas.length).toBe(BUILTIN_PERSONAS.length)
    expect(config.defaultPersonaId).toBe(BUILTIN_DEFAULT_PERSONA_ID)
    expect(config.migratedFromSystemPrompts).toBe(true)
  })

  test('Given 新建人设 When 更新与设默认 Then 字段生效且默认切换', () => {
    const created = manager.createPersona({ name: '测试', body: '正文', description: '说明' })
    expect(created.id).toBe('custom-1')

    const updated = manager.updatePersona(created.id, { body: '新正文', primerTurns: [{ role: 'user', content: '问' }] })
    expect(updated.body).toBe('新正文')
    expect(updated.primerTurns).toEqual([{ role: 'user', content: '问' }])

    manager.setDefaultPersona(created.id)
    expect(manager.getPersonaConfig().defaultPersonaId).toBe(created.id)

    manager.deletePersona(created.id)
    const config = manager.getPersonaConfig()
    expect(config.personas.some((p) => p.id === created.id)).toBe(false)
    // 删除默认人设后回退默认助手
    expect(config.defaultPersonaId).toBe(BUILTIN_DEFAULT_PERSONA_ID)
  })

  test('Given 内置人设 When 更新或删除 Then 拒绝（只读）', () => {
    expect(() => manager.updatePersona(BUILTIN_DEFAULT_PERSONA_ID, { body: 'x' })).toThrow('内置人设不可编辑')
    expect(() => manager.deletePersona('builtin-engineer')).toThrow('内置人设不可删除')
  })

  test('Given 连续新建 When 分配 ID Then 递增不冲突', () => {
    const a = manager.createPersona({ name: 'A', body: '' })
    const b = manager.createPersona({ name: 'B', body: '' })
    expect(a.id).toBe('custom-1')
    expect(b.id).toBe('custom-2')
  })
})

describe('旧系统提示词一次性迁移', () => {
  test('Given 旧配置含自定义提示词 When 首次读取 Then 迁移为人设且映射默认', () => {
    writeFileSync(legacyPath, JSON.stringify({
      prompts: [
        { id: 'builtin-default', name: '内置', content: '旧内置', isBuiltin: true, createdAt: 0, updatedAt: 0 },
        { id: 'p1', name: '我的提示词', content: '自定义正文', isBuiltin: false, createdAt: 1, updatedAt: 2 },
      ],
      defaultPromptId: 'p1',
      appendDateTimeAndUserName: true,
    }), 'utf-8')

    const config = manager.getPersonaConfig()
    const migrated = config.personas.find((p) => p.id === 'migrated-p1')
    expect(migrated?.name).toBe('我的提示词')
    expect(migrated?.body).toBe('自定义正文')
    expect(config.defaultPersonaId).toBe('migrated-p1')
    // 旧内置不重复迁移，内置种子来自源码
    expect(config.personas.filter((p) => p.id === BUILTIN_DEFAULT_PERSONA_ID).length).toBe(1)
  })

  test('Given 迁移后删除人设 When 再次读取 Then 不重复导入（迁移标记生效）', () => {
    writeFileSync(legacyPath, JSON.stringify({
      prompts: [{ id: 'p1', name: '提示词', content: '正文', isBuiltin: false, createdAt: 1, updatedAt: 2 }],
      defaultPromptId: 'p1',
    }), 'utf-8')

    manager.getPersonaConfig()
    manager.deletePersona('migrated-p1')
    const config = manager.getPersonaConfig()
    expect(config.personas.some((p) => p.id === 'migrated-p1')).toBe(false)
  })
})

describe('Markdown 导入导出', () => {
  test('Given 合法 Markdown When 导入 Then 新建人设；同 id 再导入则更新', () => {
    const mdPath = join(root, 'persona.md')
    writeFileSync(mdPath, '---\nid: imported\nname: 导入人设\n---\n\n正文内容\n', 'utf-8')
    openDialogResult = { canceled: false, filePaths: [mdPath] }

    const first = manager.importPersonaMarkdown()
    return first.then((result) => {
      expect(result.success).toBe(true)
      expect(result.persona?.id).toBe('imported')
      expect(result.persona?.body).toBe('正文内容')

      writeFileSync(mdPath, '---\nid: imported\nname: 导入人设 v2\n---\n\n更新正文\n', 'utf-8')
      return manager.importPersonaMarkdown()
    }).then((second) => {
      expect(second.success).toBe(true)
      expect(second.persona?.name).toBe('导入人设 v2')
      expect(manager.getPersonaConfig().personas.filter((p) => p.id === 'imported').length).toBe(1)
    })
  })

  test('Given 内置 id 的 Markdown When 导入 Then 拒绝覆盖', async () => {
    const mdPath = join(root, 'builtin.md')
    writeFileSync(mdPath, `---\nid: ${BUILTIN_DEFAULT_PERSONA_ID}\nname: 覆盖\n---\n\n正文\n`, 'utf-8')
    openDialogResult = { canceled: false, filePaths: [mdPath] }

    const result = await manager.importPersonaMarkdown()
    expect(result.success).toBe(false)
    expect(result.message).toContain('内置人设')
  })

  test('Given 取消选择 When 导入 Then 返回取消且不写入', async () => {
    const result = await manager.importPersonaMarkdown()
    expect(result.success).toBe(false)
    expect(result.message).toBe('已取消导入')
  })

  test('Given 人设 When 导出 Then 写出可往返解析的 Markdown', async () => {
    const outPath = join(root, 'out.md')
    saveDialogResult = { canceled: false, filePath: outPath }

    const result = await manager.exportPersonaMarkdown('builtin-engineer')
    expect(result.success).toBe(true)
    expect(existsSync(outPath)).toBe(true)
    const text = readFileSync(outPath, 'utf-8')
    expect(text).toContain('id: builtin-engineer')
    expect(text).toContain('严谨的工程协作者')
  })
})