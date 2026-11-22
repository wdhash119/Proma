import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROJECT_MAP_MAX_CHARS,
  PROJECT_MAP_MIN_CHARS,
  PROJECT_MAP_REVIEW_INTERVAL_MS,
  buildProjectMapActionPrompt,
  completeProjectMapReview,
  inspectProjectMap,
  readProjectMapReviewState,
} from './project-map-review'

let root: string
let projectRoot: string
let workspaceRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-map-'))
  projectRoot = join(root, 'project')
  workspaceRoot = join(root, 'workspace')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 写一份超过最小阈值的项目地图。 */
function writeMap(body: string): string {
  const content = `# 项目约定\n\n${body}\n`
  writeFileSync(join(projectRoot, 'AGENTS.md'), content, 'utf8')
  return content
}

describe('项目地图读取', () => {
  test('Given 文件不存在 When 读取 Then 标记缺失且无 revision', () => {
    const map = inspectProjectMap(projectRoot)

    expect(map.status).toBe('缺失')
    expect(map.revision).toBeUndefined()
  })

  test('Given 内容过短 When 读取 Then 标记待完善并给出字符数', () => {
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 项目\n\n- 短\n', 'utf8')

    const map = inspectProjectMap(projectRoot)

    expect(map.status).toBe('待完善')
    expect(map.characterCount).toBeLessThan(PROJECT_MAP_MIN_CHARS)
  })

  test('Given 内容充分 When 读取 Then 标记已存在', () => {
    writeMap('- 使用 Bun 运行测试\n'.repeat(20))

    const map = inspectProjectMap(projectRoot)

    expect(map.status).toBe('已存在')
    expect(map.characterCount).toBeGreaterThanOrEqual(PROJECT_MAP_MIN_CHARS)
  })

  test('Given 存在记忆关联块 When 计算字符数 Then 排除脚手架', () => {
    const section = '<!-- proma:memory:start -->\n## 记忆维护\n\n' + '- 占位内容\n'.repeat(200) + '<!-- proma:memory:end -->'
    writeFileSync(join(projectRoot, 'AGENTS.md'), `# 项目\n\n- 规则\n\n${section}\n`, 'utf8')

    const map = inspectProjectMap(projectRoot)

    // 只有 "# 项目" 与 "- 规则" 计入，标记块整体排除。
    expect(map.characterCount).toBeLessThan(50)
  })

  test('Given 规则文件是符号链接 When 读取 Then 标记不可安全修改', () => {
    const real = join(root, 'real-agents.md')
    writeFileSync(real, '# 真实文件\n', 'utf8')
    symlinkSync(real, join(projectRoot, 'AGENTS.md'))

    expect(inspectProjectMap(projectRoot).status).toBe('不可安全修改')
  })
})

describe('复查记录', () => {
  test('Given 从未复查 When 读取状态 Then 不逾期', () => {
    writeMap('- 规则\n'.repeat(60))

    const state = readProjectMapReviewState(workspaceRoot, projectRoot)

    expect(state.checkedAt).toBeUndefined()
    expect(state.reviewDue).toBe(false)
  })

  test('Given 修改已超一周 When 读取状态 Then 需要复查', () => {
    writeMap('- 规则\n'.repeat(60))
    const later = Date.now() + PROJECT_MAP_REVIEW_INTERVAL_MS + 1000

    const state = readProjectMapReviewState(workspaceRoot, projectRoot, later)

    expect(state.reviewDue).toBe(true)
  })

  test('Given 刚完成复查 When 读取状态 Then 不再逾期', () => {
    writeMap('- 规则\n'.repeat(60))
    const now = Date.now() + PROJECT_MAP_REVIEW_INTERVAL_MS + 1000
    const map = inspectProjectMap(projectRoot)

    completeProjectMapReview(workspaceRoot, projectRoot, map.revision!, '核验了脚本与目录结构', now)
    const state = readProjectMapReviewState(workspaceRoot, projectRoot, now)

    expect(state.checkedAt).toBe(now)
    expect(state.reviewDue).toBe(false)
  })

  test('Given revision 不匹配 When 记录复查 Then 拒绝', () => {
    writeMap('- 规则\n'.repeat(60))

    expect(() => completeProjectMapReview(workspaceRoot, projectRoot, 'stale-revision', '核验'))
      .toThrow('已发生变化')
  })

  test('Given 文件在复查后被改动 When 读取状态 Then 记录失效', () => {
    writeMap('- 规则\n'.repeat(60))
    const map = inspectProjectMap(projectRoot)
    completeProjectMapReview(workspaceRoot, projectRoot, map.revision!, '核验完成')
    writeMap('- 规则\n'.repeat(60) + '- 新增一条\n')

    const state = readProjectMapReviewState(workspaceRoot, projectRoot)

    expect(state.checkedAt).toBeUndefined()
  })

  test('Given 空摘要 When 记录复查 Then 拒绝', () => {
    writeMap('- 规则\n'.repeat(60))
    const map = inspectProjectMap(projectRoot)

    expect(() => completeProjectMapReview(workspaceRoot, projectRoot, map.revision!, '   '))
      .toThrow('请说明实际核验')
  })

  test('Given 项目地图缺失 When 记录复查 Then 拒绝', () => {
    expect(() => completeProjectMapReview(workspaceRoot, projectRoot, 'x', '核验'))
      .toThrow('缺失或不可安全修改')
  })
})

describe('项目地图行动提示', () => {
  test('Given 地图缺失 When 生成提示 Then 要求本轮建立', () => {
    const prompt = buildProjectMapActionPrompt(readProjectMapReviewState(workspaceRoot, projectRoot))

    expect(prompt).toContain('本轮项目地图行动')
    expect(prompt).toContain('缺失')
    expect(prompt).toContain('建立项目地图')
    expect(prompt).toContain('ProjectMapInspect')
    expect(prompt).toContain('ProjectMapReviewComplete')
  })

  test('Given 内容超预算 When 生成提示 Then 要求下沉瘦身而非继续追加', () => {
    writeMap('- 细则\n'.repeat(PROJECT_MAP_MAX_CHARS))

    const prompt = buildProjectMapActionPrompt(readProjectMapReviewState(workspaceRoot, projectRoot))

    expect(prompt).toContain('超过常驻项目护栏预算')
    expect(prompt).toContain('禁止继续直接追加细节')
    expect(prompt).toContain('下沉式瘦身')
  })

  test('Given 不可安全修改 When 生成提示 Then 不产生行动', () => {
    const real = join(root, 'real.md')
    writeFileSync(real, '# x\n', 'utf8')
    symlinkSync(real, join(projectRoot, 'AGENTS.md'))

    expect(buildProjectMapActionPrompt(readProjectMapReviewState(workspaceRoot, projectRoot)))
      .toBeUndefined()
  })

  test('Given 内容充分且刚复查 When 生成提示 Then 不打扰', () => {
    writeMap('- 这条规则描述了项目里必须遵守的约定、常用命令与目录结构说明\n'.repeat(20))
    const map = inspectProjectMap(projectRoot)
    const now = Date.now()
    completeProjectMapReview(workspaceRoot, projectRoot, map.revision!, '核验完成', now)

    const prompt = buildProjectMapActionPrompt(readProjectMapReviewState(workspaceRoot, projectRoot, now))

    expect(prompt).toBeUndefined()
  })
})
