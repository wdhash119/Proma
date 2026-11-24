import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as memoryService from './memory-service'

const workspaceSlug = 'demo-workspace'
const root = mkdtempSync(join(tmpdir(), 'proma-memory-'))
const globalMemoryDir = join(root, 'global')
const projectMemoryRoot = join(root, 'workspaces')

function projectDir(): string {
  return join(projectMemoryRoot, workspaceSlug, 'memory')
}

function seedProjectMemory(): void {
  const dir = projectDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '# 项目记忆索引\n\n- [部署](deploy.md) — 发布流程\n', 'utf8')
  writeFileSync(join(dir, 'deploy.md'), '# 部署\n\n- 使用 Bun 构建\n- 发布产物在 dist\n', 'utf8')
}

beforeEach(() => {
  rmSync(globalMemoryDir, { recursive: true, force: true })
  rmSync(projectMemoryRoot, { recursive: true, force: true })
  memoryService.setMemoryRootsForTesting({
    globalMemoryDir,
    projectMemoryDir: (slug) => join(projectMemoryRoot, slug, 'memory'),
  })
  mkdirSync(globalMemoryDir, { recursive: true })
  seedProjectMemory()
})

afterAll(() => {
  memoryService.setMemoryRootsForTesting(undefined)
  rmSync(root, { recursive: true, force: true })
})

describe('单条事实维护', () => {
  test('Given 已有一条事实 When add Then 只追加这一条，其他内容不变', () => {
    const content = '# 部署\n\n- 使用 Bun 构建\n'

    const next = memoryService.applyMemoryOperations(content, [
      { op: 'add', entry: '- 发布产物在 dist' },
    ])

    expect(next).toBe('# 部署\n\n- 使用 Bun 构建\n- 发布产物在 dist\n')
  })

  test('Given 指定 after When add Then 插入到锚点之后', () => {
    const content = '- 甲\n- 乙\n'

    const next = memoryService.applyMemoryOperations(content, [
      { op: 'add', entry: '- 丙', after: '- 甲' },
    ])

    expect(next).toBe('- 甲\n- 丙\n- 乙\n')
  })

  test('Given 命中唯一事实 When update Then 原地替换且不触碰其他行', () => {
    const content = '# 标题\n\n- 旧结论\n- 无关\n'

    const next = memoryService.applyMemoryOperations(content, [
      { op: 'update', match: '- 旧结论', entry: '- 新结论' },
    ])

    expect(next).toBe('# 标题\n\n- 新结论\n- 无关\n')
  })

  test('Given 命中唯一事实 When remove Then 删除该行', () => {
    const content = '- 甲\n- 乙\n'

    const next = memoryService.applyMemoryOperations(content, [
      { op: 'remove', match: '- 甲' },
    ])

    expect(next).toBe('- 乙\n')
  })

  test('Given 匹配文本命中多行 When remove Then 报错并保留原文', () => {
    const content = '- 甲\n- 甲\n'

    expect(() => memoryService.applyMemoryOperations(content, [
      { op: 'remove', match: '- 甲' },
    ])).toThrow('匹配到多条相同条目')
  })

  test('Given 条目缺少列表前缀 When add Then 拒绝写入', () => {
    expect(() => memoryService.applyMemoryOperations('- 甲\n', [
      { op: 'add', entry: '乙' },
    ])).toThrow('必须是以 "- " 开头')
  })
})

describe('写入与版本历史', () => {
  test('Given 全局画像 When 首次写入 Then 建立文件并返回新 revision', () => {
    const initial = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    expect(initial.content).toBe('')

    const result = memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: initial.revision,
      summary: '新增个人画像事实',
      content: '# 全局用户画像\n\n- 用户是教师\n',
    })

    const stored = readFileSync(initial.path, 'utf8')
    expect(stored).toContain('用户是教师')
    expect(result.chars).toBeGreaterThan(0)
  })

  test('Given revision 已过期 When 写入 Then 拒绝覆盖并提示重新读取', () => {
    const initial = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: initial.revision,
      summary: '第一次写入',
      content: '- 事实一\n',
    })

    expect(() => memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: initial.revision,
      summary: '并发写入',
      content: '- 事实二\n',
    })).toThrow('记忆已被修改')
  })

  test('Given 覆盖已有内容 When 写入 Then 生成可恢复的历史快照', () => {
    const first = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    const created = memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: first.revision,
      summary: '建立画像',
      content: '- 事实一\n',
    })

    const current = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: current.revision,
      summary: '追加事实二',
      operations: [{ op: 'add', entry: '- 事实二' }],
    })

    const history = memoryService.listMemoryHistory(memoryService.GLOBAL_PROFILE_TARGET)
    expect(history.length).toBe(1)
    expect(history[0]?.summary).toBe('追加事实二')
    // 首版写入时旧内容为空，因此历史里只保留被 operations 覆盖掉的那一版。
    expect(created.chars).toBeGreaterThan(0)
  })

  test('Given 存在历史版本 When 恢复 Then 正文回到旧版本且当前内容另存快照', () => {
    const first = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: first.revision,
      summary: '第一版',
      content: '- 事实一\n',
    })
    const second = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: second.revision,
      summary: '第二版',
      content: '- 事实一\n- 事实二\n',
    })

    const history = memoryService.listMemoryHistory(memoryService.GLOBAL_PROFILE_TARGET)
    const restoreTarget = history[0]!
    const beforeRestore = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.restoreMemoryRevision(
      memoryService.GLOBAL_PROFILE_TARGET,
      restoreTarget.id,
      beforeRestore.revision,
    )

    const restored = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    expect(restored.content).toBe('- 事实一\n')
    // 恢复本身也可回退：历史里新增一条自动快照。
    expect(memoryService.listMemoryHistory(memoryService.GLOBAL_PROFILE_TARGET).length).toBe(2)
  })

  test('Given 内容未变化 When 写入 Then 不产生历史快照', () => {
    const first = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: first.revision,
      summary: '建立',
      content: '- 事实一\n',
    })
    const current = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    const result = memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: current.revision,
      summary: '重复写入',
      content: '- 事实一\n',
    })

    expect(result.snapshotId).toBeUndefined()
    // 两次写入内容完全相同，全程没有产生任何历史快照。
    expect(memoryService.listMemoryHistory(memoryService.GLOBAL_PROFILE_TARGET)).toEqual([])
  })
})

/** 检索夹具：全部为构造数据，不读取真实用户记忆。 */
const SEARCH_TARGET_LINE = '- 用户希望优化中文记忆检索，减少漏召回'
const SEARCH_ORDER_LINE = '- 检索结果必须按得分排序并给出稳定次序'
const SEARCH_ASCII_LINE = '- 部署使用 Bun 0.19.141，主逻辑在 apps/electron/src/main/lib/memory-service.ts'
const SEARCH_MODEL_LINE = '- 长文摘要使用 k3.1-pro 模型，短文本用 haiku-lite'
const SEARCH_NOISE_LINE = '- 天气晴，会议室在三层，咖啡机需要清理'
const SEARCH_SPECK_LINE = '- 优化构建优化压缩优化缓存优化配置'

function seedSearchCorpus(): void {
  const dir = projectDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), [
    '# 项目记忆索引',
    '',
    '- [检索](retrieval.md) — 中文记忆检索约定',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(dir, 'retrieval.md'), [
    '# 检索约定',
    '',
    SEARCH_TARGET_LINE,
    SEARCH_ORDER_LINE,
    SEARCH_ASCII_LINE,
    SEARCH_MODEL_LINE,
    SEARCH_NOISE_LINE,
    SEARCH_SPECK_LINE,
    '',
  ].join('\n'), 'utf8')
}

function hitTexts(query: string, limit = 20): string[] {
  return memoryService.searchMemory(query, workspaceSlug, limit).map((hit) => hit.text)
}

describe('跨层检索', () => {
  test('Given 全局与项目记忆都有相关内容 When 检索 Then 两层都能命中并带行号', () => {
    const first = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: first.revision,
      summary: '建立画像',
      content: '# 全局用户画像\n\n- 用户使用 Bun 构建\n',
    })

    const hits = memoryService.searchMemory('Bun 构建', workspaceSlug)
    const sources = hits.map((hit) => hit.source)

    expect(sources).toContain('全局画像')
    expect(sources).toContain('项目记忆/deploy.md')
    expect(hits.every((hit) => hit.line > 0)).toBe(true)
  })

  test('Given 空查询 When 检索 Then 不返回任何片段', () => {
    expect(memoryService.searchMemory('   ', workspaceSlug)).toEqual([])
    expect(memoryService.searchMemory('', workspaceSlug)).toEqual([])
    expect(memoryService.searchMemory('，。;、', workspaceSlug)).toEqual([])
  })
})

describe('词法检索：中文与混合查询', () => {
  test('Given 中文长句查询 When 检索 Then 命中相关事实而不是整句子串缺失导致漏召回', () => {
    seedSearchCorpus()

    const hits = memoryService.searchMemory('如何优化中文记忆检索', workspaceSlug)

    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.text).toBe(SEARCH_TARGET_LINE)
    expect(hits[0]?.source).toBe('项目记忆/retrieval.md')
    expect(hits[0]?.line).toBe(3)
  })

  test('Given 中文关键词 When 检索 Then 含该关键词的事实排在只含部分片段的行之前', () => {
    seedSearchCorpus()

    const texts = hitTexts('记忆检索')

    expect(texts[0]).toBe(SEARCH_TARGET_LINE)
    // 索引行含「中文记忆检索」，可以命中但必须排在其后。
    const indexPosition = texts.findIndex((text) => text.includes('[检索](retrieval.md)'))
    expect(indexPosition).toBeGreaterThan(0)
  })

  test('Given 中英混合查询 When 检索 Then 中文事实与 ASCII 事实都能命中', () => {
    seedSearchCorpus()

    const texts = hitTexts('Bun 中文记忆检索')

    expect(texts).toContain(SEARCH_TARGET_LINE)
    expect(texts).toContain(SEARCH_ASCII_LINE)
    expect(hitTexts('deploy 部署').length).toBeGreaterThan(0)
  })

  test('Given 非 CJK 非 ASCII 文字查询 When 检索 Then 与旧 substring 能力一致仍能命中', () => {
    const dir = projectDir()
    writeFileSync(join(dir, 'notes.md'), '# 杂项\n\n- Привет мир 问候\n- Γειά σου κόσμε\n- 标记 🔥 与 café\n', 'utf8')

    expect(hitTexts('привет')).toContain('- Привет мир 问候')
    expect(hitTexts('κόσμε')).toContain('- Γειά σου κόσμε')
    expect(hitTexts('🔥')).toContain('- 标记 🔥 与 café')
    expect(hitTexts('é')).toContain('- 标记 🔥 与 café')
  })

  test('Given 查询含重复词 When 检索 Then 去重后排序与单次查询一致', () => {
    seedSearchCorpus()

    const once = memoryService.searchMemory('记忆检索', workspaceSlug)
    const repeated = memoryService.searchMemory('记忆检索 记忆检索 记忆检索', workspaceSlug)

    expect(repeated.map((hit) => hit.text)).toEqual(once.map((hit) => hit.text))
    expect(repeated.map((hit) => hit.score)).toEqual(once.map((hit) => hit.score))
  })

  test('Given 完整 ASCII 版本号与路径 When 检索 Then 完整 token 精确命中', () => {
    seedSearchCorpus()

    expect(hitTexts('0.19.141')[0]).toBe(SEARCH_ASCII_LINE)
    expect(hitTexts('k3.1-pro')[0]).toBe(SEARCH_MODEL_LINE)
    expect(hitTexts('apps/electron/src/main/lib/memory-service.ts')[0]).toBe(SEARCH_ASCII_LINE)
  })

  test('Given ASCII 子段 When 检索 Then 仍可命中含该子段的事实', () => {
    seedSearchCorpus()

    expect(hitTexts('memory-service.ts')).toContain(SEARCH_ASCII_LINE)
    expect(hitTexts('electron')).toContain(SEARCH_ASCII_LINE)
  })

  test('Given 长查询只有碎片命中 When 与高覆盖行比较 Then 碎片行不得排前', () => {
    seedSearchCorpus()

    const texts = hitTexts('如何优化中文记忆检索，减少漏召回')

    expect(texts.indexOf(SEARCH_SPECK_LINE)).toBeGreaterThan(texts.indexOf(SEARCH_TARGET_LINE))
    expect(texts.indexOf(SEARCH_NOISE_LINE)).toBe(-1)
  })

  test('Given 同一查询重复执行 When 检索 Then 排序与得分完全确定', () => {
    seedSearchCorpus()

    const first = memoryService.searchMemory('记忆检索 0.19.141 部署', workspaceSlug)
    const second = memoryService.searchMemory('记忆检索 0.19.141 部署', workspaceSlug)

    expect(second).toEqual(first)
    expect(first.length).toBeGreaterThan(1)
  })

  test('Given limit 取 1 到 40 When 检索 Then 结果条数不超过上限且不空', () => {
    seedSearchCorpus()

    for (const limit of [1, 2, 5, 20, 39, 40]) {
      const hits = memoryService.searchMemory('记忆检索 部署 优化', workspaceSlug, limit)
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.length).toBeLessThanOrEqual(limit)
    }
    // 超出上限按 40 截断。
    expect(memoryService.searchMemory('记忆检索 部署 优化', workspaceSlug, 500).length).toBeLessThanOrEqual(40)
  })
})

describe('写入护栏：条目长度', () => {
  const maxEntry = `- ${'甲'.repeat(998)}`
  const overLongEntry = `- ${'甲'.repeat(999)}`

  test('Given 条目正好 1000 码元 When add Then 允许写入', () => {
    expect(maxEntry.length).toBe(1000)

    const next = memoryService.applyMemoryOperations('- 已有事实\n', [
      { op: 'add', entry: maxEntry },
    ])

    expect(next).toContain(maxEntry)
  })

  test('Given 条目 1001 码元 When add Then 拒绝并说明上限', () => {
    expect(overLongEntry.length).toBe(1001)

    expect(() => memoryService.applyMemoryOperations('- 已有事实\n', [
      { op: 'add', entry: overLongEntry },
    ])).toThrow('1000')
  })

  test('Given 整篇 content 含超长条目 When 写入 Then 同样拒绝，不能绕过长度上限', () => {
    const initial = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)

    expect(() => memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: initial.revision,
      summary: '整篇写入超长条目',
      content: `# 全局用户画像\n\n${overLongEntry}\n`,
    })).toThrow('1000')
    expect(memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET).content).toBe('')
  })
})

describe('写入护栏：完全重复条目', () => {
  test('Given 已存在完全相同的条目 When add Then 幂等跳过且不产生快照', () => {
    const first = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: first.revision,
      summary: '建立画像',
      content: '# 全局用户画像\n\n- 用户偏好中文\n',
    })
    const current = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)

    const result = memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: current.revision,
      summary: '重复添加同一条事实',
      operations: [{ op: 'add', entry: '- 用户偏好中文' }],
    })

    expect(result.revision).toBe(current.revision)
    expect(result.snapshotId).toBeUndefined()
    expect(memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET).content).toBe(current.content)
    expect(memoryService.listMemoryHistory(memoryService.GLOBAL_PROFILE_TARGET)).toEqual([])
  })

  test('Given 已存在仅行首尾空白不同的条目 When add Then 仍按完全重复跳过', () => {
    const next = memoryService.applyMemoryOperations('- 甲\n', [
      { op: 'add', entry: '  - 甲  ' },
    ])

    expect(next).toBe('- 甲\n')
  })

  test('Given 新条目已存在于其他位置 When add Then 不重复追加', () => {
    const next = memoryService.applyMemoryOperations('# 标题\n\n- 甲\n- 乙\n', [
      { op: 'add', entry: '- 甲', after: '- 乙' },
    ])

    expect(next).toBe('# 标题\n\n- 甲\n- 乙\n')
  })

  test('Given 正文没有末尾换行 When add 已存在条目 Then 返回原文，byte-for-byte 不变', () => {
    const content = '- 甲\n- 乙'

    const next = memoryService.applyMemoryOperations(content, [{ op: 'add', entry: '- 甲' }])

    expect(next).toBe(content)
  })

  test('Given 普通段落与待新增事实同名 When add Then 仍新增列表事实', () => {
    const next = memoryService.applyMemoryOperations('用户偏好中文\n', [{ op: 'add', entry: '- 用户偏好中文' }])

    expect(next).toBe('用户偏好中文\n- 用户偏好中文\n')
  })

  test('Given content 使用独立 CR 换行 When 写入 Then 拒绝且不落盘', () => {
    const current = memoryService.readMemoryDocument('collaboration.md', workspaceSlug)

    expect(() => memoryService.updateMemory({
      target: 'collaboration.md',
      revision: current.revision,
      summary: '独立 CR 不应绕过条目校验',
      content: '- 事实甲\r- 事实甲',
    }, workspaceSlug)).toThrow('独立的 CR 换行')
    expect(memoryService.readMemoryDocument('collaboration.md', workspaceSlug).content).toBe('')
  })

  test('Given 正文没有末尾换行 When add 新条目 Then 只追加一条并补末尾换行', () => {
    const next = memoryService.applyMemoryOperations('- 甲\n- 乙', [{ op: 'add', entry: '- 丙' }])

    expect(next).toBe('- 甲\n- 乙\n- 丙\n')
  })

  test('Given 目标文本已是另一条事实 When update Then 拒绝并提示可操作', () => {
    expect(() => memoryService.applyMemoryOperations('- 甲\n- 乙\n', [
      { op: 'update', match: '- 乙', entry: '- 甲' },
    ])).toThrow('已存在的另一条事实')
  })

  test('Given 整篇 content 含重复条目 When 写入 Then 拒绝并指出重复行号', () => {
    const initial = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)

    let message = ''
    try {
      memoryService.updateMemory({
        target: memoryService.GLOBAL_PROFILE_TARGET,
        revision: initial.revision,
        summary: '整篇写入重复条目',
        content: '# 全局用户画像\n\n- 用户偏好中文\n- 用户偏好中文\n',
      })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('重复')
    expect(message).toContain('3')
    expect(message).toContain('4')
    expect(memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET).content).toBe('')
  })

  test('Given 只差首尾空白的条目重复 When 整篇写入 Then 同样拒绝', () => {
    const initial = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)

    expect(() => memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: initial.revision,
      summary: '空白差异重复',
      content: '- 甲\n  - 甲  \n',
    })).toThrow('重复')
  })
})

describe('活跃主题与旧画像边界', () => {
  test('Given 旧画像文件 When MemoryUpdate 写入 Then 拒绝续写但保留迁移读取', () => {
    const dir = projectDir()
    for (const target of ['user-profile.md', 'user_profile.md']) {
      const original = `# 旧画像\n\n- ${target} 的原始事实\n`
      writeFileSync(join(dir, target), original, 'utf8')
      const current = memoryService.readMemoryDocument(target, workspaceSlug)

      expect(() => memoryService.updateMemory({
        target,
        revision: current.revision,
        summary: '旧画像不应再续写',
        operations: [{ op: 'add', entry: '- 新事实' }],
      }, workspaceSlug)).toThrow('只作为迁移输入')
      expect(memoryService.readMemoryDocument(target, workspaceSlug).content).toBe(original)
    }
    expect(memoryService.readLegacyProfileLocations(workspaceSlug)).toHaveLength(2)
  })

  test('Given 同时存在 collaboration.md 与两种旧画像 When 列举与检索 Then 只有 collaboration.md 是活跃主题', () => {
    const dir = projectDir()
    writeFileSync(join(dir, 'collaboration.md'), '# 协作\n\n- 用户偏好中文回复\n', 'utf8')
    writeFileSync(join(dir, 'user-profile.md'), '# 旧画像\n\n- 用户是教师\n', 'utf8')
    writeFileSync(join(dir, 'user_profile.md'), '# 下划线旧画像\n\n- 用户是医生\n', 'utf8')

    const targets = memoryService.listMemoryTargets(workspaceSlug).map((info) => info.target)
    expect(targets).toContain('collaboration.md')
    expect(targets).not.toContain('user-profile.md')
    expect(targets).not.toContain('user_profile.md')

    const targetOf = (query: string): string[] => memoryService.searchMemory(query, workspaceSlug).map((hit) => hit.target)
    expect(targetOf('中文回复')).toContain('collaboration.md')
    expect(targetOf('教师')).not.toContain('user-profile.md')
    expect(targetOf('医生')).not.toContain('user_profile.md')

    // 两种旧画像仍作为迁移输入可被扫描，只是不再进入活跃主题。
    const legacyPaths = memoryService.readLegacyProfileLocations(workspaceSlug).map((location) => location.path)
    expect(legacyPaths).toContain(join(dir, 'user-profile.md'))
    expect(legacyPaths).toContain(join(dir, 'user_profile.md'))
  })
})

// ===== 阶段 2：来源与时间语义 =====

/** 规范后缀前缀；测试用它断言格式，而不是把整段字符串复制得到处都是。 */
const META_PREFIX = '〔记忆：'

/** 从完整条目里拆出后缀段，便于逐段断言字段顺序与缺省。 */
function metaSegments(entry: string): string[] {
  const start = entry.indexOf(META_PREFIX)
  if (start < 0) return []
  const end = entry.indexOf('〕', start)
  if (end < 0) return []
  return entry
    .slice(start + META_PREFIX.length, end)
    .split('｜')
}

const RECORDED_PATTERN = /^记录=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function addEntry(content: string, entry: string, extra: Partial<memoryService.MemoryEntryOperation> = {}): string {
  return memoryService.applyMemoryOperations(content, [{ op: 'add', entry, ...extra }])
}

function singleThemeContent(): string {
  return memoryService.readMemoryDocument('collaboration.md', workspaceSlug).content
}

function writeTheme(content: string): void {
  const current = memoryService.readMemoryDocument('collaboration.md', workspaceSlug)
  memoryService.updateMemory({
    target: 'collaboration.md',
    revision: current.revision,
    summary: '建立协作主题',
    content,
  }, workspaceSlug)
}

function updateTheme(
  operations: memoryService.MemoryEntryOperation[],
  summary = '修订协作主题',
): memoryService.MemoryUpdateResult {
  const current = memoryService.readMemoryDocument('collaboration.md', workspaceSlug)
  return memoryService.updateMemory({
    target: 'collaboration.md',
    revision: current.revision,
    summary,
    operations,
  }, workspaceSlug)
}

function entryLines(content: string): string[] {
  return content.split('\n').filter((line) => line.trim().startsWith('- ')).map((line) => line.trim())
}

describe('来源与时间：写入格式', () => {
  test('Given 普通稳定事实 When add 不带元数据 Then 不生成任何后缀', () => {
    const next = addEntry('- 用户偏好中文回复\n', '- 用户偏好中文回复请直接说结论')

    expect(next).toBe('- 用户偏好中文回复\n- 用户偏好中文回复请直接说结论\n')
    expect(next).not.toContain(META_PREFIX)
  })

  test('Given 普通正文包含记忆字样但不是行尾后缀 When add Then 按普通事实写入', () => {
    const next = addEntry('- 已有\n', '- 〔记忆：宫殿〕是术语')

    expect(next).toContain('- 〔记忆：宫殿〕是术语')
    expect(() => addEntry('- 已有\n', '- 甲〔记忆：来源=x')).toThrow('不完整')
  })

  test('Given 只给 source When add Then 只写来源与记录时间，字段顺序固定', () => {
    const next = addEntry('- 甲\n', '- 用户偏好中文回复', { source: 'session:abc123' })
    const line = entryLines(next)[1]!

    expect(line.startsWith('- 用户偏好中文回复')).toBe(true)
    expect(metaSegments(line)).toHaveLength(2)
    expect(metaSegments(line)[0]).toBe('来源=session:abc123')
    expect(metaSegments(line)[1]).toMatch(RECORDED_PATTERN)
    expect(line.endsWith('〕')).toBe(true)
  })

  test('Given 只给 occurredAt 日期 When add Then 写发生与记录时间并保持日期原样', () => {
    const next = addEntry('- 甲\n', '- 项目在 11 月切换构建工具', { occurredAt: '2026-11-20' })
    const segments = metaSegments(entryLines(next)[1]!)

    expect(segments).toHaveLength(2)
    expect(segments[0]).toBe('发生=2026-11-20')
    expect(segments[1]).toMatch(RECORDED_PATTERN)
  })

  test('Given source 与带时区时间 When add Then 顺序为来源、发生、记录，时间规范为 UTC ISO', () => {
    const next = addEntry('- 甲\n', '- 结论在评审后确定', {
      source: 'user:dm',
      occurredAt: '2026-11-24T11:20:00+08:00',
    })
    const segments = metaSegments(entryLines(next)[1]!)

    expect(segments).toHaveLength(3)
    expect(segments[0]).toBe('来源=user:dm')
    expect(segments[1]).toBe('发生=2026-11-24T03:20:00.000Z')
    expect(segments[2]).toMatch(RECORDED_PATTERN)
  })

  test('Given 两个相邻 add 都带元数据 When 调用方未记录时间 Then 记录时间由服务产生而非 entry 自带', () => {
    const next = addEntry('- 甲\n', '- 用户偏好中文回复', { source: 'session:abc123' })

    expect(next).not.toContain('记录=2026-11-24T03:20:00.000Z')
    expect(metaSegments(entryLines(next)[1]!)[1]).toMatch(RECORDED_PATTERN)
  })

  test('Given entry 已带服务记录时间 When add Then 重新生成记录时间且不双写后缀', () => {
    const entry = '- 用户偏好中文回复〔记忆：来源=session:x｜记录=2026-11-24T03:20:00.000Z〕'

    const next = addEntry('- 甲\n', entry)
    const line = entryLines(next)[1]!
    expect(line.match(new RegExp(META_PREFIX, 'g'))).toHaveLength(1)
    expect(metaSegments(line)[0]).toBe('来源=session:x')
    expect(metaSegments(line)[1]).toMatch(RECORDED_PATTERN)
    expect(metaSegments(line)[1]).not.toBe('记录=2026-11-24T03:20:00.000Z')
  })
})

describe('来源与时间：入参校验', () => {
  test('Given source 为空或含分隔符 When add Then 拒绝', () => {
    expect(() => addEntry('- 甲\n', '- 乙', { source: '   ' })).toThrow('source')
    expect(() => addEntry('- 甲\n', '- 乙', { source: 'a｜b' })).toThrow('source')
    expect(() => addEntry('- 甲\n', '- 乙', { source: 'a〕b' })).toThrow('source')
    expect(() => addEntry('- 甲\n', '- 乙', { source: 'a\nb' })).toThrow('source')
  })

  test('Given source 首尾有空白 When add Then trim 后写入', () => {
    const next = addEntry('- 甲\n', '- 乙', { source: '  session:abc123  ' })

    expect(metaSegments(entryLines(next)[1]!)[0]).toBe('来源=session:abc123')
  })

  test('Given occurredAt 非法或不存在的日期 When add Then 拒绝而不是写入假日期', () => {
    for (const occurredAt of ['2026-02-30', '2026-13-01', '2026-11-31', '2026-1-1', '2026-11-24T03:20:00', '昨天', '2026-11-24 03:20']) {
      expect(() => addEntry('- 甲\n', '- 乙', { occurredAt })).toThrow('occurredAt')
    }
  })

  test('Given 极早 ISO 年份 When add Then 校验原年份并生成可再次解析的后缀', () => {
    let next = '- 已有\n'
    for (const occurredAt of ['0000-01-01', '0099-12-31', '0100-01-01']) {
      next = memoryService.applyMemoryOperations(next, [{
        op: 'add',
        entry: `- 年份 ${occurredAt}`,
        occurredAt,
      }])
      const line = entryLines(next).at(-1)!
      expect(metaSegments(line)[0]).toBe(`发生=${occurredAt}`)
      next = memoryService.applyMemoryOperations(next, [{ op: 'add', entry: `- 后续 ${occurredAt}` }])
    }
  })

  test('Given 时区转换进入扩展年份 When add Then 写入前拒绝', () => {
    expect(() => addEntry('- 已有\n', '- 时间边界', {
      occurredAt: '9999-12-31T23:59:59-01:00',
    })).toThrow('四位年份')
  })

  test('Given occurredAt 是合法带时区时间 When add Then 统一成 UTC ISO', () => {
    const next = addEntry('- 甲\n', '- 乙', { occurredAt: '2026-11-24T03:20:00.000Z' })

    expect(metaSegments(entryLines(next)[1]!)[0]).toBe('发生=2026-11-24T03:20:00.000Z')
  })

  test('Given 后缀把条目推到 1001 码元 When add Then 拒绝，后缀计入长度预算', () => {
    // 后缀 = "〔记忆：" 4 + "来源=" 3 + 6 + "｜记录=" 4 + 24 + "〕" 1 = 38 码元，加分隔空格 1。
    const suffix = ` 〔记忆：来源=${'s'.repeat(6)}｜记录=2026-11-24T03:20:00.000Z〕`
    const body = `- ${'甲'.repeat(1001 - 2 - suffix.length)}`

    expect(body.length + suffix.length).toBe(1001)
    expect(() => addEntry('- 已有\n', body, { source: 's'.repeat(6) })).toThrow('1000')
  })

  test('Given 后缀存在但条目仍刚好 1000 码元 When add Then 允许写入', () => {
    const suffixLength = ' 〔记忆：来源='.length + 6 + '｜记录='.length + 24 + '〕'.length
    const body = `- ${'甲'.repeat(1000 - 2 - suffixLength)}`
    const next = addEntry('- 已有\n', body, { source: 's'.repeat(6) })
    const lines = entryLines(next)

    expect(lines[1]!.length).toBeLessThanOrEqual(1000)
    expect(metaSegments(lines[1]!)[0]).toBe(`来源=${'s'.repeat(6)}`)
  })
})

describe('来源与时间：add 幂等与重复判定', () => {
  test('Given 已存在普通事实 When add 带新来源 Then 拒绝而不是静默丢弃证据', () => {
    writeTheme('# 协作\n\n- 用户偏好中文回复\n')

    expect(() => updateTheme([
      { op: 'add', entry: '- 用户偏好中文回复', source: 'session:new' },
    ])).toThrow('update')
    expect(singleThemeContent()).toBe('# 协作\n\n- 用户偏好中文回复\n')
  })

  test('Given 已存在带来源事实 When add 完全相同元数据 Then 幂等跳过且不产生快照', () => {
    writeTheme('# 协作\n\n- 用户偏好中文回复〔记忆：来源=session:x｜发生=2026-11-20｜记录=2026-11-20T00:00:00.000Z〕\n')
    const before = memoryService.readMemoryDocument('collaboration.md', workspaceSlug)

    const result = updateTheme([
      { op: 'add', entry: '- 用户偏好中文回复', source: 'session:x', occurredAt: '2026-11-20' },
    ], '重复记账')

    expect(result.revision).toBe(before.revision)
    expect(result.snapshotId).toBeUndefined()
    expect(singleThemeContent()).toBe(before.content)
    expect(memoryService.listMemoryHistory('collaboration.md', workspaceSlug)).toEqual([])
  })

  test('Given 已存在带来源事实 When add 只带原文不带元数据 Then 也按重复跳过', () => {
    writeTheme('# 协作\n\n- 用户偏好中文回复〔记忆：来源=session:x｜记录=2026-11-20T00:00:00.000Z〕\n')
    const before = memoryService.readMemoryDocument('collaboration.md', workspaceSlug)

    const result = updateTheme([{ op: 'add', entry: '- 用户偏好中文回复' }], '重复记账')

    expect(result.revision).toBe(before.revision)
    expect(result.snapshotId).toBeUndefined()
  })

  test('Given 重复 add 仅提供已有元数据子集 When 没有新增或变化 Then 幂等跳过', () => {
    writeTheme('# 协作\n\n- 用户偏好中文回复〔记忆：来源=session:a｜发生=2026-11-20｜记录=2026-11-20T00:00:00.000Z〕\n')
    const before = memoryService.readMemoryDocument('collaboration.md', workspaceSlug)

    const result = updateTheme([
      { op: 'add', entry: '- 用户偏好中文回复', source: 'session:a' },
      { op: 'add', entry: '- 用户偏好中文回复', occurredAt: '2026-11-20' },
    ], '部分元数据重复记账')

    expect(result.revision).toBe(before.revision)
    expect(result.snapshotId).toBeUndefined()
    expect(singleThemeContent()).toBe(before.content)
  })

  test('Given 同一正文不同来源 When add Then 仍判重复，来源不能绕过去重', () => {
    writeTheme('# 协作\n\n- 用户偏好中文回复〔记忆：来源=session:a｜记录=2026-11-20T00:00:00.000Z〕\n')

    expect(() => updateTheme([
      { op: 'add', entry: '- 用户偏好中文回复', source: 'session:b' },
    ])).toThrow('update')
  })

  test('Given entry 自带规范后缀 When add 同时给显式字段 Then 合并，而不是双写后缀', () => {
    const entry = '- 用户偏好中文回复〔记忆：来源=session:a｜记录=2026-11-20T00:00:00.000Z〕'

    const next = addEntry('- 已有\n', entry, { occurredAt: '2026-11-19' })
    const line = entryLines(next)[1]!

    expect(line.match(new RegExp(META_PREFIX, 'g'))).toHaveLength(1)
    expect(metaSegments(line)[0]).toBe('来源=session:a')
    expect(metaSegments(line)[1]).toBe('发生=2026-11-19')
    // 记录时间是服务产生的必要字段，因此合并结果是「来源 + 发生 + 记录」三段。
    expect(metaSegments(line)).toHaveLength(3)
    expect(metaSegments(line)[2]).toMatch(RECORDED_PATTERN)
  })

  test('Given entry 自带规范后缀 When 显式字段与后缀冲突 Then 拒绝', () => {
    const entry = '- 用户偏好中文回复〔记忆：来源=session:a｜记录=2026-11-20T00:00:00.000Z〕'

    expect(() => addEntry('- 已有\n', entry, { source: 'session:b' })).toThrow('source')
  })

  test('Given entry 后缀格式非法 When add Then 报可操作错误', () => {
    expect(() => addEntry('- 已有\n', '- 甲〔记忆：来源=〕')).toThrow('后缀')
    expect(() => addEntry('- 已有\n', '- 甲〔记忆：外观=a〕')).toThrow('后缀')
  })

  test('Given 整篇 content 写入重复正文但元数据不同 When 写入 Then 拒绝', () => {
    const current = memoryService.readMemoryDocument('collaboration.md', workspaceSlug)

    expect(() => memoryService.updateMemory({
      target: 'collaboration.md',
      revision: current.revision,
      summary: '元数据变体重复',
      content: '# 协作\n\n- 用户偏好中文〔记忆：来源=a｜记录=2026-11-20T00:00:00.000Z〕\n- 用户偏好中文〔记忆：来源=b｜记录=2026-11-21T00:00:00.000Z〕\n',
    }, workspaceSlug)).toThrow('重复')
  })
  test('Given content 与 operations 同时传入 When 写入 Then 明确拒绝且原文不变', () => {
    writeTheme('# 协作\n\n- 原事实\n')
    const before = memoryService.readMemoryDocument('collaboration.md', workspaceSlug)

    expect(() => memoryService.updateMemory({
      target: 'collaboration.md',
      revision: before.revision,
      summary: '双写入路径应互斥',
      content: '- content 覆盖\n',
      operations: [{ op: 'add', entry: '- operation 新增' }],
    }, workspaceSlug)).toThrow('二选一')
    expect(singleThemeContent()).toBe(before.content)
    expect(memoryService.listMemoryHistory('collaboration.md', workspaceSlug)).toEqual([])
  })
})

describe('来源与时间：update 保留规则', () => {
  const seeded = '# 协作\n\n- 用户偏好中文回复〔记忆：来源=session:a｜发生=2026-11-20｜记录=2026-11-20T00:00:00.000Z〕\n'

  test('Given 未显式给字段 When update 改写正文 Then 保留来源与发生时间并刷新记录时间', () => {
    writeTheme(seeded)
    const match = entryLines(singleThemeContent())[0]!

    updateTheme([{ op: 'update', match, entry: '- 用户偏好中文回复，先给结论' }])
    const line = entryLines(singleThemeContent())[0]!

    expect(line.startsWith('- 用户偏好中文回复，先给结论')).toBe(true)
    expect(metaSegments(line)[0]).toBe('来源=session:a')
    expect(metaSegments(line)[1]).toBe('发生=2026-11-20')
    expect(metaSegments(line)[2]).toMatch(RECORDED_PATTERN)
    expect(metaSegments(line)[2]).not.toBe('记录=2026-11-20T00:00:00.000Z')
  })

  test('Given 只换来源 When update 正文不变 Then 刷新记录时间但保留发生时间', () => {
    writeTheme(seeded)
    const match = entryLines(singleThemeContent())[0]!

    updateTheme([{ op: 'update', match, entry: '- 用户偏好中文回复', source: 'session:b' }])
    const segments = metaSegments(entryLines(singleThemeContent())[0]!)

    expect(segments[0]).toBe('来源=session:b')
    expect(segments[1]).toBe('发生=2026-11-20')
    expect(segments[2]).not.toBe('记录=2026-11-20T00:00:00.000Z')
  })

  test('Given entry 与元数据都未变化 When update Then 保持原文、不刷新记录时间、不产生快照', () => {
    writeTheme(seeded)
    const before = memoryService.readMemoryDocument('collaboration.md', workspaceSlug)
    const match = entryLines(singleThemeContent())[0]!

    const result = updateTheme([{ op: 'update', match, entry: '- 用户偏好中文回复' }], '无变化改写')

    expect(result.revision).toBe(before.revision)
    expect(result.snapshotId).toBeUndefined()
    expect(singleThemeContent()).toBe(before.content)
    expect(memoryService.listMemoryHistory('collaboration.md', workspaceSlug)).toEqual([])
  })

  test('Given update 直接复制完整旧条目 When 正文与元数据均未变化 Then 保持幂等', () => {
    writeTheme(seeded)
    const before = memoryService.readMemoryDocument('collaboration.md', workspaceSlug)
    const match = entryLines(before.content)[0]!

    const result = updateTheme([{ op: 'update', match, entry: match }], '复制旧条目')

    expect(result.revision).toBe(before.revision)
    expect(result.snapshotId).toBeUndefined()
    expect(singleThemeContent()).toBe(before.content)
  })

  test('Given update 显式传入相同来源与发生时间 When 无实际变化 Then 不刷新记录时间', () => {
    writeTheme(seeded)
    const before = memoryService.readMemoryDocument('collaboration.md', workspaceSlug)
    const match = entryLines(before.content)[0]!

    const result = updateTheme([{
      op: 'update',
      match,
      entry: '- 用户偏好中文回复',
      source: 'session:a',
      occurredAt: '2026-11-20',
    }])

    expect(result.revision).toBe(before.revision)
    expect(result.snapshotId).toBeUndefined()
    expect(singleThemeContent()).toBe(before.content)
  })

  test('Given 普通事实没有元数据 When update 且未给字段 Then 仍不生成后缀', () => {
    writeTheme('# 协作\n\n- 用户偏好中文回复\n')

    updateTheme([{ op: 'update', match: '- 用户偏好中文回复', entry: '- 用户偏好中文回复，直接给结论' }])

    expect(singleThemeContent()).toBe('# 协作\n\n- 用户偏好中文回复，直接给结论\n')
  })

  test('Given update 显式带时区发生时间 When 写入 Then 规范为 UTC ISO', () => {
    writeTheme('# 协作\n\n- 甲\n')

    updateTheme([{ op: 'update', match: '- 甲', entry: '- 甲', occurredAt: '2026-11-24T11:20:00+08:00' }])

    expect(metaSegments(entryLines(singleThemeContent())[0]!)[0]).toBe('发生=2026-11-24T03:20:00.000Z')
  })

  test('Given update 会把正文改成另一条已存在事实 When 仅元数据不同 Then 仍拒绝', () => {
    writeTheme('# 协作\n\n- 甲〔记忆：来源=a｜记录=2026-11-20T00:00:00.000Z〕\n- 乙\n')

    expect(() => updateTheme([
      { op: 'update', match: '- 乙', entry: '- 甲', source: 'session:z' },
    ])).toThrow('已存在的另一条事实')
  })
})

describe('来源与时间：match / remove / 搜索 / 历史 / 预算', () => {
  const seededLine = '- 甲〔记忆：来源=session:a｜记录=2026-11-20T00:00:00.000Z〕'

  test('Given 条目带后缀 When remove 用完整行匹配 Then 删除且不影响其他条目', () => {
    writeTheme(`# 协作\n\n${seededLine}\n- 乙\n`)

    updateTheme([{ op: 'remove', match: seededLine }])

    expect(singleThemeContent()).toBe('# 协作\n\n- 乙\n')
  })

  test('Given match 只给正文 When 条目带后缀 Then 不按前缀误匹配', () => {
    writeTheme(`# 协作\n\n${seededLine}\n`)

    expect(() => updateTheme([{ op: 'update', match: '- 甲', entry: '- 丙' }])).toThrow('未找到匹配条目')
  })

  test('Given 带来源事实 When 全文检索 Then 正文与来源都能命中同一条', () => {
    writeTheme(`# 协作\n\n- 用户偏好中文回复〔记忆：来源=session:abc123｜记录=2026-11-20T00:00:00.000Z〕\n`)

    const byBody = memoryService.searchMemory('中文回复', workspaceSlug, 5)
    const bySource = memoryService.searchMemory('session:abc123', workspaceSlug, 5)

    expect(byBody[0]?.text).toContain('用户偏好中文回复')
    expect(bySource[0]?.text).toContain('来源=session:abc123')
  })

  test('Given 带后缀事实被覆盖 When 恢复历史 Then 后缀原样回到正文', () => {
    const seeded = `# 协作\n\n${seededLine}\n`
    writeTheme(seeded)
    updateTheme([{ op: 'add', entry: '- 乙' }], '追加乙')

    const history = memoryService.listMemoryHistory('collaboration.md', workspaceSlug)
    expect(history).toHaveLength(1)
    const before = memoryService.readMemoryDocument('collaboration.md', workspaceSlug)
    memoryService.restoreMemoryRevision('collaboration.md', history[0]!.id, before.revision, workspaceSlug)

    expect(singleThemeContent()).toBe(seeded)
  })

  test('Given 画像接近预算 When 带后缀 add Then 后缀计入 5000 码元预算', () => {
    const GLOBAL_BUDGET = 5000
    // 尾部按 2 的幂累加填充，使剩余空间精确逼近上限。
    let doc = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    let round = 0
    let docSize = doc.chars
    for (const size of [960, 480, 240, 120, 60, 30, 15, 8, 4, 2]) {
      const cost = size + 3
      while (docSize + cost <= GLOBAL_BUDGET - 60) {
        round += 1
        const latest = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
        const written = memoryService.updateMemory({
          target: memoryService.GLOBAL_PROFILE_TARGET,
          revision: latest.revision,
          summary: `画像填充 ${round}`,
          operations: [{ op: 'add', entry: `- ${'甲'.repeat(size - 2)}${round}` }],
        })
        docSize = written.chars
        doc = latest
      }
    }
    const remaining = GLOBAL_BUDGET - docSize
    doc = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    expect(remaining).toBeLessThan(80)

    // 正文剩余-40 码元 + 来源 60 + 记录时间（约 30）与换行会越过剩余空间。
    expect(() => memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: doc.revision,
      summary: '后缀把画像推过预算',
      operations: [{ op: 'add', entry: `- ${'乙'.repeat(Math.max(1, remaining - 40))}`, source: 's'.repeat(60) }],
    })).toThrow('全局画像超预算')

    // 同样正文不带元数据放得下，证明是后缀本身推过了预算。
    const ok = memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: doc.revision,
      summary: '不带元数据可写入',
      operations: [{ op: 'add', entry: `- ${'乙'.repeat(Math.max(1, remaining - 40))}` }],
    })
    expect(ok.chars).toBeLessThanOrEqual(GLOBAL_BUDGET)
  })

  test('Given 归档主题含带后缀条目 When 归档 Then 正文原样移动，无需格式迁移', () => {
    const seeded = `# 协作\n\n${seededLine}\n`
    writeTheme(seeded)
    const index = memoryService.readMemoryDocument(memoryService.PROJECT_INDEX_TARGET, workspaceSlug)
    const theme = memoryService.readMemoryDocument('collaboration.md', workspaceSlug)

    const result = memoryService.archiveMemoryTheme(
      workspaceSlug,
      'collaboration.md',
      theme.revision,
      index.revision,
      '# 项目记忆索引\n\n- [检索](retrieval.md) — 发布流程\n',
    )

    expect(readFileSync(result.archivedTo, 'utf8')).toBe(seeded)
  })
})
