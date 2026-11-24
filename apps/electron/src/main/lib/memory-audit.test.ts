import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { auditMemory } from './memory-audit'
import * as memoryService from './memory-service'

const workspaceSlug = 'audit-workspace'
const root = mkdtempSync(join(tmpdir(), 'proma-memory-audit-'))
const globalMemoryDir = join(root, 'global')
const projectMemoryRoot = join(root, 'workspaces')

function projectDir(): string {
  return join(projectMemoryRoot, workspaceSlug, 'memory')
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function writeGlobal(content: string): void {
  write(memoryService.getGlobalMemoryFilePath(), content)
}

function writeTheme(name: string, content: string): void {
  write(join(projectDir(), name), content)
}

function writeIndex(content: string): void {
  write(join(projectDir(), 'MEMORY.md'), content)
}

/** 读所有记忆文件正文，用于断言审计没有改动磁盘。 */
function snapshotMemoryFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  const globalPath = memoryService.getGlobalMemoryFilePath()
  files['global-profile'] = readFileSync(globalPath, 'utf8')
  for (const name of ['MEMORY.md', 'collaboration.md', 'lessons.md', 'deploy.md', 'decisions.md']) {
    const path = join(projectDir(), name)
    try {
      files[name] = readFileSync(path, 'utf8')
    } catch {
      // 文件不存在时跳过。
    }
  }
  return files
}

beforeEach(() => {
  rmSync(globalMemoryDir, { recursive: true, force: true })
  rmSync(projectMemoryRoot, { recursive: true, force: true })
  memoryService.setMemoryRootsForTesting({
    globalMemoryDir,
    projectMemoryDir: (slug) => join(projectMemoryRoot, slug, 'memory'),
  })
  mkdirSync(globalMemoryDir, { recursive: true })
  mkdirSync(projectDir(), { recursive: true })
  writeGlobal('# 用户画像\n\n')
  writeIndex('# 项目记忆索引\n')
})

afterAll(() => {
  memoryService.setMemoryRootsForTesting(undefined)
  rmSync(root, { recursive: true, force: true })
})

describe('完全重复候选', () => {
  test('Given 同一主题两行同一事实 When 审计 Then 报 exact-duplicate 且带全部行号', () => {
    writeTheme('collaboration.md', '# 协作\n\n- 用户偏好中文回复\n- 其他事实\n- 用户偏好中文回复\n')
    writeIndex('# 项目记忆索引\n\n- [协作](collaboration.md) — 协作偏好\n')

    const report = auditMemory(workspaceSlug)

    const found = report.findings.filter((finding) => finding.kind === 'exact-duplicate')
    expect(found).toHaveLength(1)
    expect(found[0]!.target).toBe('collaboration.md')
    expect(found[0]!.lines).toEqual([3, 5])
    expect(found[0]!.texts).toEqual(['用户偏好中文回复', '用户偏好中文回复'])
  })

  test('Given 同一事实出现三次 When 审计 Then 合并为一组并返回全部行号', () => {
    writeTheme('collaboration.md', '# 协作\n\n- 用户偏好中文回复\n- 用户偏好中文回复\n- 用户偏好中文回复\n')

    const report = auditMemory(workspaceSlug)

    const found = report.findings.filter((finding) => finding.kind === 'exact-duplicate')
    expect(found).toHaveLength(1)
    expect(found[0]!.lines).toEqual([3, 4, 5])
    expect(found[0]!.texts).toHaveLength(3)
  })

  test('Given 元数据后缀不同但正文相同 When 审计 Then 仍算完全重复', () => {
    writeGlobal(
      '# 用户画像\n\n'
      + '- 喜欢简洁回答 〔记忆：来源=session-a｜发生=2026-01-02｜记录=2026-01-02T00:00:00.000Z〕\n'
      + '- 喜欢简洁回答\n',
    )

    const report = auditMemory(workspaceSlug)

    const found = report.findings.filter((finding) => finding.kind === 'exact-duplicate')
    expect(found).toHaveLength(1)
    expect(found[0]!.target).toBe('global-profile')
    expect(found[0]!.lines).toEqual([3, 4])
  })
})

describe('近似与冲突候选', () => {
  test('Given 仅个别字不同 When 审计 Then 报 near-duplicate 并给相似度', () => {
    writeTheme(
      'lessons.md',
      '# 经验\n\n'
      + '- 提交前必须运行 bun run typecheck 与全部相关测试\n'
      + '- 提交前必须运行 bun run typecheck 与相关全部测试\n',
    )
    writeIndex('# 项目记忆索引\n\n- [经验](lessons.md) — 经验\n')

    const report = auditMemory(workspaceSlug)

    const found = report.findings.filter((finding) => finding.kind === 'near-duplicate')
    expect(found).toHaveLength(1)
    expect(found[0]!.target).toBe('lessons.md')
    expect(found[0]!.lines).toEqual([3, 4])
    expect(found[0]!.similarity).toBeGreaterThanOrEqual(0.82)
    expect(found[0]!.similarity).toBeLessThan(1)
  })

  test('Given 相似事实在原始文件中相距较远 When 审计 Then 先按正文排序再比较', () => {
    writeTheme(
      'lessons.md',
      '# 经验\n\n'
      + '- 提交前必须运行 bun run typecheck 与全部相关测试\n'
      + '- 中间主题 A\n- 中间主题 B\n- 中间主题 C\n- 中间主题 D\n- 中间主题 E\n- 中间主题 F\n'
      + '- 提交前必须运行 bun run typecheck 与相关全部测试\n',
    )

    const report = auditMemory(workspaceSlug)

    const found = report.findings.filter((finding) => finding.kind === 'near-duplicate')
    expect(found).toHaveLength(1)
    expect(found[0]!.lines).toEqual([3, 10])
  })

  test('Given 同一主题下否定标记不对称 When 审计 Then 报 possible-conflict 但不裁决', () => {
    writeTheme(
      'decisions.md',
      '# 决策\n\n'
      + '- 部署脚本总是创建新的 worktree\n'
      + '- 部署脚本不要创建新的 worktree\n',
    )
    writeIndex('# 项目记忆索引\n\n- [决策](decisions.md) — 决策\n')

    const report = auditMemory(workspaceSlug)

    const found = report.findings.filter((finding) => finding.kind === 'possible-conflict')
    expect(found).toHaveLength(1)
    expect(found[0]!.lines).toEqual([3, 4])
    // 只提示候选：不能包含任何「谁正确/谁更新」的结论字段。
    expect(Object.keys(found[0]!).sort()).toEqual(['kind', 'lines', 'similarity', 'target', 'texts'])
  })

  test('Given 同一主题里语义无关的事实 When 审计 Then 不误报近似或冲突', () => {
    writeTheme(
      'deploy.md',
      '# 部署\n\n'
      + '- 使用 Bun 构建主应用\n'
      + '- 发布产物写入 dist 目录\n'
      + '- 团队周会固定在周四下午\n',
    )
    writeIndex('# 项目记忆索引\n\n- [部署](deploy.md) — 部署\n')

    const report = auditMemory(workspaceSlug)

    expect(report.findings.filter((finding) => finding.kind === 'near-duplicate')).toHaveLength(0)
    expect(report.findings.filter((finding) => finding.kind === 'possible-conflict')).toHaveLength(0)
  })

  test('Given 两条否定次数不同 When 审计 Then 报冲突候选而不是近似重复', () => {
    writeTheme('decisions.md', '# 决策\n\n- 不要直接提交到主干分支\n- 不要不直接提交到主干分支\n')

    const report = auditMemory(workspaceSlug)

    expect(report.findings.filter((finding) => finding.kind === 'possible-conflict')).toHaveLength(1)
    expect(report.findings.filter((finding) => finding.kind === 'near-duplicate')).toHaveLength(0)
  })

  test('Given 分别不同与不确定等非否定措辞 When 审计 Then 不误报冲突', () => {
    writeTheme(
      'deploy.md',
      '# 部署\n\n- 部署脚本分别创建测试与生产两个 worktree\n- 部署脚本创建测试与生产两个 worktree\n- 接口行为不确定时先查文档\n- 接口行为先查文档\n',
    )

    const report = auditMemory(workspaceSlug)

    expect(report.findings.filter((finding) => finding.kind === 'possible-conflict')).toHaveLength(0)
  })

  test('Given 完全重复行与近似行同时存在 When 审计 Then 近似候选不被重复行放大', () => {
    writeTheme(
      'lessons.md',
      '# 经验\n\n- 格式检查一定要跑\n- 格式检查一定要跑\n- 格式检查一定要跑\n- 格式检查一定要跑啊\n',
    )

    const report = auditMemory(workspaceSlug)

    expect(report.findings.filter((finding) => finding.kind === 'exact-duplicate')).toHaveLength(1)
    expect(report.findings.filter((finding) => finding.kind === 'near-duplicate')).toHaveLength(1)
  })

  test('Given 不同主题里相同正文 When 审计 Then 不做跨 target 相似度比较', () => {
    writeTheme('deploy.md', '# 部署\n\n- 使用 Bun 构建主应用\n')
    writeTheme('lessons.md', '# 经验\n\n- 使用 Bun 构建主应用\n')
    writeIndex('# 项目记忆索引\n\n- [部署](deploy.md) — 部署\n- [经验](lessons.md) — 经验\n')

    const report = auditMemory(workspaceSlug)

    expect(report.findings.filter((finding) => finding.kind === 'exact-duplicate')).toHaveLength(0)
  })
})

describe('路由审计', () => {
  test('Given 活跃主题没有路由 When 审计 Then 报 unindexed-theme', () => {
    writeTheme('collaboration.md', '# 协作\n\n- 用户偏好中文回复\n')
    writeTheme('lessons.md', '# 经验\n\n- 先写失败测试\n')
    writeIndex('# 项目记忆索引\n\n- [协作](collaboration.md) — 协作偏好\n')

    const report = auditMemory(workspaceSlug)

    const found = report.findings.filter((finding) => finding.kind === 'unindexed-theme')
    expect(found).toHaveLength(1)
    expect(found[0]!.target).toBe('lessons.md')
  })

  test('Given 路由指向不存在的主题 When 审计 Then 报 dangling-route', () => {
    writeTheme('collaboration.md', '# 协作\n\n- 用户偏好中文回复\n')
    writeIndex('# 项目记忆索引\n\n- [协作](collaboration.md) — 协作偏好\n- [旧](removed-theme.md) — 已删除\n')

    const report = auditMemory(workspaceSlug)

    const found = report.findings.filter((finding) => finding.kind === 'dangling-route')
    expect(found).toHaveLength(1)
    expect(found[0]!.route).toBe('removed-theme.md')
    expect(found[0]!.lines).toEqual([4])
  })

  test('Given 路由指向旧画像 When 审计 Then 报 dangling-route 而不是把它当活跃主题', () => {
    write(memoryService.getGlobalMemoryFilePath(), '# 用户画像\n\n- 用户偏好中文回复\n')
    write(join(projectDir(), 'user-profile.md'), '# 旧画像\n\n- 旧事实\n')
    writeIndex('# 项目记忆索引\n\n- [画像](user-profile.md) — 旧画像\n')

    const report = auditMemory(workspaceSlug)

    const found = report.findings.filter((finding) => finding.kind === 'dangling-route')
    expect(found).toHaveLength(1)
    expect(found[0]!.route).toBe('user-profile.md')
  })

  test('Given 外部 .context 绝对路径与各类外部链接 When 审计 Then 全部跳过不误报', () => {
    writeTheme('collaboration.md', '# 协作\n\n- 用户偏好中文回复\n')
    writeIndex(
      '# 项目记忆索引\n\n'
      + '- [协作](collaboration.md) — 协作偏好\n'
      + '- [长调研](C:/Users/devix/.proma/agent-workspaces/src/demo/.context/research.md) — 外部上下文\n'
      + '- [外部上下文](D:\\workspace\\src\\Proma\\.context\\plan.md) — Windows 路径\n'
      + '- [外部上下文](../.context/plan.md) — 相对外部\n'
      + '- [绝对](../../absolute.md) — 相对外部\n'
      + '- [根路径](/memory/collaboration.md) — 根路径\n'
      + '- [网页](https://example.com/memory.md) — 网页\n'
      + '- [pdf](notes.pdf) — 非 Markdown\n',
    )

    const report = auditMemory(workspaceSlug)

    expect(report.findings.filter((finding) => finding.kind === 'dangling-route')).toHaveLength(0)
  })

  test('Given URL 编码、锚点与 ./ 前缀 When 审计 Then 识别为已登记主题', () => {
    writeTheme('协作 偏好.md', '# 协作偏好\n\n- 用户偏好中文回复\n')
    writeIndex(
      '# 项目记忆索引\n\n'
      + '- [协作](./%E5%8D%8F%E4%BD%9C%20%E5%81%8F%E5%A5%BD.md#偏好) — 协作偏好\n',
    )

    const report = auditMemory(workspaceSlug)

    expect(report.findings.filter((finding) => finding.kind === 'unindexed-theme')).toHaveLength(0)
    expect(report.findings.filter((finding) => finding.kind === 'dangling-route')).toHaveLength(0)
  })

  test('Given MEMORY.md 路由行 When 审计 Then 不把路由行当事实做相似度分析', () => {
    writeIndex(
      '# 项目记忆索引\n\n'
      + '- [协作](collaboration.md) — 协作偏好\n'
      + '- [协作](collaboration.md) — 协作偏好\n',
    )
    writeTheme('collaboration.md', '# 协作\n\n- 用户偏好中文回复\n')

    const report = auditMemory(workspaceSlug)

    expect(report.findings.filter((finding) => finding.kind === 'exact-duplicate')).toHaveLength(0)
  })
  test('Given 行内代码与转义链接示例 When 审计 Then 不生成悬空路由', () => {
    writeTheme('collaboration.md', '# 协作\n\n- 用户偏好中文回复\n')
    writeIndex(
      '# 项目记忆索引\n\n'
      + '- [协作](collaboration.md) — 协作偏好\n'
      + '用 `[链接](ghost-inline.md)` 表示路由\n'
      + '\\[转义](ghost-escaped.md)\n',
    )

    const report = auditMemory(workspaceSlug)

    expect(report.findings.filter((finding) => finding.kind === 'dangling-route')).toHaveLength(0)
  })

  test('Given 多反引号行内代码 When 审计 Then 代码内链接仍被忽略', () => {
    writeTheme('collaboration.md', '# 协作\n\n- 用户偏好中文回复\n')
    writeIndex(
      '# 项目记忆索引\n\n'
      + '``[示例](ghost-double.md)`` 与 [协作](collaboration.md)\n',
    )

    const report = auditMemory(workspaceSlug)

    expect(report.findings.filter((finding) => finding.kind === 'dangling-route')).toHaveLength(0)
  })

  test('Given 未闭合代码围栏 When 审计 Then 后续事实仍参与扫描', () => {
    writeTheme('lessons.md', '# 经验\n\n```\n未闭合\n- 重复事实\n- 重复事实\n')

    const report = auditMemory(workspaceSlug)

    expect(report.scannedEntries).toBe(2)
    expect(report.findings.filter((finding) => finding.kind === 'exact-duplicate')).toHaveLength(1)
  })

  test('Given 路由大小写与主题文件名不同 When 审计 Then 按平台文件系统语义判断', () => {
    writeTheme('Lessons.md', '# 经验\n\n- 先写失败测试\n')
    writeIndex('# 项目记忆索引\n\n- [经验](lessons.md) — 经验\n')

    const report = auditMemory(workspaceSlug)
    const unindexed = report.findings.filter((finding) => finding.kind === 'unindexed-theme')
    const dangling = report.findings.filter((finding) => finding.kind === 'dangling-route')
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(unindexed).toHaveLength(0)
      expect(dangling).toHaveLength(0)
    } else {
      expect(unindexed).toHaveLength(1)
      expect(dangling).toHaveLength(1)
    }
  })
})

describe('候选数量与稳定性', () => {
  function seedManyDuplicates(count: number): void {
    const lines = ['# 协作', '']
    for (let index = 0; index < count; index += 1) {
      lines.push(`- 重复事实 ${index}`, `- 重复事实 ${index}`)
    }
    writeTheme('lessons.md', `${lines.join('\n')}\n`)
    writeIndex('# 项目记忆索引\n\n- [经验](lessons.md) — 经验\n')
  }

  test('Given 超过 limit 的发现 When 审计 Then 每类截断并记入 truncatedKinds', () => {
    seedManyDuplicates(5)

    const report = auditMemory(workspaceSlug, 2)

    expect(report.findings.filter((finding) => finding.kind === 'exact-duplicate')).toHaveLength(2)
    expect(report.truncatedKinds).toContain('exact-duplicate')
  })

  test('Given limit 非法 When 审计 Then 夹到 1–50', () => {
    seedManyDuplicates(3)

    expect(auditMemory(workspaceSlug, 0).findings.filter((finding) => finding.kind === 'exact-duplicate')).toHaveLength(1)
    expect(auditMemory(workspaceSlug, 1000).findings.filter((finding) => finding.kind === 'exact-duplicate')).toHaveLength(3)
  })

  test('Given 多次审计 When 比较报告 Then 候选顺序稳定', () => {
    seedManyDuplicates(4)
    writeTheme('deploy.md', '# 部署\n\n- 使用 Bun 构建主应用\n')

    const first = auditMemory(workspaceSlug, 5)
    const second = auditMemory(workspaceSlug, 5)

    expect(first.findings).toEqual(second.findings)
    expect(first.findings.filter((finding) => finding.kind === 'exact-duplicate')[0]!.lines).toEqual([3, 4])
  })

  test('Given 审计调用 When 比较前后磁盘与 revision Then 完全不变', () => {
    writeGlobal('# 用户画像\n\n- 用户偏好中文回复\n- 用户偏好中文回复\n')
    writeTheme('collaboration.md', '# 协作\n\n- 用户偏好中文回复\n')
    writeIndex('# 项目记忆索引\n\n- [协作](collaboration.md) — 协作偏好\n- [旧](gone.md) — 悬空\n')

    const beforeFiles = snapshotMemoryFiles()
    const beforeTargets = memoryService.listMemoryTargets(workspaceSlug)
    auditMemory(workspaceSlug)
    const afterTargets = memoryService.listMemoryTargets(workspaceSlug)

    expect(snapshotMemoryFiles()).toEqual(beforeFiles)
    expect(afterTargets).toEqual(beforeTargets)
    // 不应创建任何历史快照：审计不写文件。
    expect(memoryService.listMemoryHistory('collaboration.md', workspaceSlug)).toEqual([])
  })

  test('Given 没有工作区 When 审计 Then 只扫描全局画像并统计目标数', () => {
    writeGlobal('# 用户画像\n\n- 用户偏好中文回复\n- 用户偏好中文回复\n')

    const report = auditMemory(undefined)

    expect(report.scannedTargets).toBe(1)
    expect(report.scannedEntries).toBe(2)
    expect(report.findings.filter((finding) => finding.kind === 'exact-duplicate')).toHaveLength(1)
  })
})
