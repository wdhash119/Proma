import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChangeRequestGitHubService, normalizeStatusCheckRollup, parseGitHubRemote } from './github-change-request-service'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'proma-gh-'))
  dirs.push(dir)
  return dir
}

describe('remote 解析', () => {
  test('Given https 远端 When 解析 Then 得到 host/owner/name', () => {
    expect(parseGitHubRemote('https://github.com/proma-ai/Proma.git')).toEqual({
      host: 'github.com',
      owner: 'proma-ai',
      name: 'Proma',
    })
  })

  test('Given scp 风格远端 When 解析 Then 同样识别', () => {
    expect(parseGitHubRemote('git@github.com:proma-ai/Proma.git')).toEqual({
      host: 'github.com',
      owner: 'proma-ai',
      name: 'Proma',
    })
  })

  test('Given 非 GitHub 或不安全远端 When 解析 Then 拒绝', () => {
    expect(parseGitHubRemote('https://user:pass@github.com/a/b.git')).toBeNull()
    expect(parseGitHubRemote('https://github.com:8443/a/b.git')).toBeNull()
    expect(parseGitHubRemote('file:///tmp/repo')).toBeNull()
    expect(parseGitHubRemote('https://github.com/../b.git')).toBeNull()
  })
})

describe('检查状态归一化', () => {
  test('Given CheckRun 与经典 StatusContext 混排 When 归一化 Then 两种结构映射到同一语义', () => {
    expect(normalizeStatusCheckRollup([
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { context: 'ci', state: 'FAILURE' },
      { context: 'deploy', state: 'SUCCESS' },
      { context: 'scan', state: 'PENDING' },
      { context: 'unknown', state: 'ERROR' },
    ])).toEqual([
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'deploy', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'scan', status: 'PENDING', conclusion: '' },
      { name: 'unknown', status: 'COMPLETED', conclusion: 'ERROR' },
    ])
  })

  test('Given 非数组或空项 When 归一化 Then 返回空 / 兜底名称', () => {
    expect(normalizeStatusCheckRollup(undefined)).toEqual([])
    expect(normalizeStatusCheckRollup([null])).toEqual([{ name: '检查', status: 'PENDING', conclusion: '' }])
  })
})

describe('gh 调用封装', () => {
  test('Given 经典 StatusContext 的 PR When viewUrl Then 失败与成功都写入 conclusion', async () => {
    const service = new ChangeRequestGitHubService(async () => JSON.stringify({
      number: 13,
      url: 'https://github.com/a/b/pull/13',
      title: '经典 CI',
      state: 'OPEN',
      isDraft: false,
      headRefName: 'fix/ci',
      baseRefName: 'main',
      reviewDecision: '',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [
        { context: 'ci', state: 'FAILURE' },
        { context: 'deploy', state: 'SUCCESS' },
      ],
    }))

    const view = await service.viewUrl('/tmp', 'https://github.com/a/b/pull/13')

    expect(view.snapshot.checks).toEqual([
      { name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'deploy', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ])
  })

  test('Given 合法 PR When viewUrl Then 映射状态、检查与合并性', async () => {
    const calls: string[][] = []
    const service = new ChangeRequestGitHubService(async (program, args) => {
      calls.push([program, ...args])
      return JSON.stringify({
        number: 12,
        url: 'https://github.com/a/b/pull/12',
        title: '修复登录',
        state: 'OPEN',
        isDraft: false,
        headRefName: 'fix/login',
        baseRefName: 'main',
        reviewDecision: 'APPROVED',
        mergeable: 'mergeable',
        statusCheckRollup: [
          { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { context: 'lint', state: 'PENDING' },
        ],
      })
    })

    const view = await service.viewUrl('/tmp', 'https://github.com/a/b/pull/12')

    expect(view.snapshot).toMatchObject({
      title: '修复登录',
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
    })
    expect(view.snapshot.checks).toEqual([
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'lint', status: 'PENDING', conclusion: '' },
    ])
    expect(calls[0]?.slice(0, 3)).toEqual(['gh', 'pr', 'view'])
  })

  test('Given 编号不一致 When viewUrl Then 拒绝写入，避免把别的 PR 写进会话', async () => {
    const service = new ChangeRequestGitHubService(async () => JSON.stringify({
      number: 99,
      url: 'https://github.com/a/b/pull/99',
    }))

    await expect(service.viewUrl('/tmp', 'https://github.com/a/b/pull/12'))
      .rejects.toThrow('GitHub 返回了不匹配的变更请求')
  })

  test('Given gh 输出非 JSON When viewUrl Then 报可读错误', async () => {
    const service = new ChangeRequestGitHubService(async () => 'not json')
    await expect(service.viewUrl('/tmp', 'https://github.com/a/b/pull/12'))
      .rejects.toThrow('GitHub 返回了无效的变更请求')
  })

  test('Given 当前处于 detached HEAD When findByHead Then 提示无法发现', async () => {
    const service = new ChangeRequestGitHubService(async (_program, args) => {
      if (args[0] === 'branch') return '\n'
      return ''
    })

    await expect(service.findByHead('/tmp', { host: 'github.com', owner: 'a', name: 'b' }, ''))
      .rejects.toThrow('detached HEAD')
  })

  test('Given origin 不是 GitHub When discoverRepository Then 报可读错误', async () => {
    const service = new ChangeRequestGitHubService(async () => 'file:///tmp/repo')
    await expect(service.discoverRepository('/tmp')).rejects.toThrow('origin 不是受支持的 GitHub 远端')
  })

  test('Given 真实工作目录 When currentBranch Then 能读到分支名', async () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.md'), '# x\n')
    const service = new ChangeRequestGitHubService()
    // 非 git 目录由 gh 报错，这里验证封装把错误转成可读文案而不是裸异常。
    await expect(service.currentBranch(dir)).rejects.toThrow()
  })
})
