import { describe, expect, test } from 'bun:test'
import { extractChangeRequestUrls } from '@proma/shared'
import {
  commandFromToolInput,
  isPullRequestCreateCommand,
  isPullRequestReferenceCommand,
  isPushCommand,
  isShellToolName,
  ownChangeRequestUrlFromOutput,
  PendingCommandTracker,
  pushedBranchesFromOutput,
  textOfToolResult,
} from './change-request-observer'

describe('命令识别', () => {
  test('Given shell 工具名 When 判断 Then Bash/Shell/TerminalExecute 都算', () => {
    for (const name of ['Bash', 'bash', 'Shell', 'TerminalExecute', 'run_command']) {
      expect(isShellToolName(name)).toBe(true)
    }
    expect(isShellToolName('Read')).toBe(false)
    expect(isShellToolName('TaskCreate')).toBe(false)
  })

  test('Given 各种写法的 gh pr create When 判断 Then 都能识别', () => {
    for (const command of [
      'gh pr create --fill',
      'cd /repo && gh pr create --title "x"',
      'FOO=1 gh pr create',
      'gh pr create \\\n  --title "x"',
      'git push && gh pr create --fill',
    ]) {
      expect(isPullRequestCreateCommand(command)).toBe(true)
    }
  })

  test('Given 非创建类命令 When 判断 Then 不算 gh pr create', () => {
    for (const command of [
      'gh pr view 1',
      'gh pr list',
      'echo "gh pr create"',
      'git commit -m "gh pr create later"',
      '',
      null,
    ]) {
      expect(isPullRequestCreateCommand(command)).toBe(false)
    }
  })

  test('Given 引用已有 PR 的命令 When 判断 Then 识别 view/edit/checkout', () => {
    expect(isPullRequestReferenceCommand('gh pr view 12')).toBe(true)
    expect(isPullRequestReferenceCommand('gh pr checkout 3')).toBe(true)
    expect(isPullRequestReferenceCommand('gh pr edit 4 --add-label x')).toBe(true)
    expect(isPullRequestReferenceCommand('gh pr create --fill')).toBe(false)
  })

  test('Given git push 变体 When 判断 Then 都算推送', () => {
    for (const command of [
      'git push',
      'git push origin feat',
      'git -C /repo push',
      'git push --force-with-lease',
      'git push \\\n origin HEAD',
    ]) {
      expect(isPushCommand(command)).toBe(true)
    }
    expect(isPushCommand('git pull')).toBe(false)
    expect(isPushCommand('git commit -m "push later"')).toBe(false)
  })

  test('Given 工具输入 When 提取命令 Then 只取非空 command 字段', () => {
    expect(commandFromToolInput({ command: '  git push  ' })).toBe('  git push  ')
    expect(commandFromToolInput({ command: '   ' })).toBeNull()
    expect(commandFromToolInput({ cmd: 'git push' })).toBeNull()
    expect(commandFromToolInput(null)).toBeNull()
  })
})

describe('从 gh pr create 输出取链接', () => {
  test('Given url: 行 When 解析 Then 返回归一化链接', () => {
    const output = [
      'Creating pull request for feat into main in owner/repo',
      '',
      'url: https://github.com/owner/repo/pull/42',
      '',
    ].join('\n')
    expect(ownChangeRequestUrlFromOutput(output)).toBe('https://github.com/owner/repo/pull/42')
  })

  test('Given 裸 URL 行 When 解析 Then own 版不负责，交给 extractChangeRequestUrls', () => {
    // gh pr create 默认只打印裸 URL；这条路径由 shared 的抽取函数覆盖。
    const output = 'Creating pull request for feat into main in owner/repo\n\nhttps://github.com/owner/repo/pull/42\n'
    expect(ownChangeRequestUrlFromOutput(output)).toBeNull()
    expect(extractChangeRequestUrls(output)).toEqual(['https://github.com/owner/repo/pull/42'])
  })

  test('Given JSON 输出 When 解析 Then 取 url 字段', () => {
    expect(ownChangeRequestUrlFromOutput('{"url":"https://github.com/a/b/pull/7","number":7}'))
      .toBe('https://github.com/a/b/pull/7')
  })

  test('Given 没有链接 When 解析 Then 返回 null', () => {
    expect(ownChangeRequestUrlFromOutput('error: not authenticated')).toBeNull()
    expect(ownChangeRequestUrlFromOutput('')).toBeNull()
  })

  test('Given 超大输出 When 解析 Then 直接跳过', () => {
    expect(ownChangeRequestUrlFromOutput('x'.repeat(600 * 1024))).toBeNull()
  })
})

describe('从 git push 输出解析推送分支', () => {
  test('Given 单分支推送 When 解析 Then 得到 remote 与分支', () => {
    const output = [
      'To git@github.com:owner/repo.git',
      '   abc1234..def5678  feat/login -> feat/login',
    ].join('\n')

    expect(pushedBranchesFromOutput(output)).toEqual([
      { remote: 'git@github.com:owner/repo.git', branch: 'feat/login' },
    ])
  })

  test('Given 同一 remote 推多个分支 When 解析 Then 全部返回并去重', () => {
    const output = [
      'To https://github.com/owner/repo.git',
      '   abc1234..def5678  feat/a -> feat/a',
      '   abc1234..def5678  feat/b -> feat/b',
      '   abc1234..def5678  feat/a -> feat/a',
    ].join('\n')

    expect(pushedBranchesFromOutput(output)).toEqual([
      { remote: 'https://github.com/owner/repo.git', branch: 'feat/a' },
      { remote: 'https://github.com/owner/repo.git', branch: 'feat/b' },
    ])
  })

  test('Given 多个 remote When 解析 Then 每条推送跟随最近的 To 行', () => {
    const output = [
      'To git@github.com:me/repo.git',
      '   abc1234..def5678  main -> main',
      'To git@github.com:upstream/repo.git',
      '   abc1234..def5678  patch -> patch',
    ].join('\n')

    expect(pushedBranchesFromOutput(output)).toEqual([
      { remote: 'git@github.com:me/repo.git', branch: 'main' },
      { remote: 'git@github.com:upstream/repo.git', branch: 'patch' },
    ])
  })

  test('Given 创建或删除标签 When 解析 Then 跳过，不当作分支', () => {
    const output = [
      'To git@github.com:owner/repo.git',
      ' * [new tag]         v1.0.0 -> v1.0.0',
      ' - [deleted]         old-branch',
      '   abc1234..def5678  feat -> feat',
    ].join('\n')

    expect(pushedBranchesFromOutput(output)).toEqual([
      { remote: 'git@github.com:owner/repo.git', branch: 'feat' },
    ])
  })

  test('Given 推送 tag 引用 When 解析 Then 跳过', () => {
    const output = [
      'To git@github.com:owner/repo.git',
      ' * [new tag]         refs/tags/v1 -> refs/tags/v1',
      '   abc1234..def5678  refs/heads/feat -> refs/heads/feat',
    ].join('\n')

    expect(pushedBranchesFromOutput(output)).toEqual([
      { remote: 'git@github.com:owner/repo.git', branch: 'feat' },
    ])
  })

  test('Given 推到 HEAD 或裸 refs When 解析 Then 跳过', () => {
    const output = [
      'To git@github.com:owner/repo.git',
      '   abc1234..def5678  HEAD -> HEAD',
      '   abc1234..def5678  x -> refs/notes/commits',
    ].join('\n')

    expect(pushedBranchesFromOutput(output)).toEqual([])
  })

  test('Given 没有 To 行 When 解析 Then 返回空', () => {
    expect(pushedBranchesFromOutput('Everything up-to-date')).toEqual([])
    expect(pushedBranchesFromOutput('   abc1234..def5678  feat -> feat')).toEqual([])
  })

  test('Given forced update When 解析 Then 仍识别为推送', () => {
    const output = [
      'To git@github.com:owner/repo.git',
      ' + abc1234...def5678 feat -> feat (forced update)',
    ].join('\n')

    expect(pushedBranchesFromOutput(output)).toEqual([
      { remote: 'git@github.com:owner/repo.git', branch: 'feat' },
    ])
  })
})

describe('工具结果文本与待取命令表', () => {
  test('Given 字符串或多文本块 When 拼接 Then 只保留文本内容', () => {
    expect(textOfToolResult('plain')).toBe('plain')
    expect(textOfToolResult([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\nb')
    expect(textOfToolResult(null)).toBe('')
    expect(textOfToolResult([{ type: 'image' }])).toBe('')
  })

  test('Given 登记后取回 When take Then 只返回一次', () => {
    const tracker = new PendingCommandTracker()
    tracker.remember('t1', 'git push')

    expect(tracker.take('t1')).toBe('git push')
    expect(tracker.take('t1')).toBeNull()
    expect(tracker.size).toBe(0)
  })

  test('Given 超过上限 When 登记 Then 丢弃最旧的记录', () => {
    const tracker = new PendingCommandTracker(3)
    for (let index = 0; index < 5; index += 1) tracker.remember(`t${index}`, `cmd-${index}`)

    expect(tracker.size).toBe(3)
    expect(tracker.take('t0')).toBeNull()
    expect(tracker.take('t4')).toBe('cmd-4')
  })

  test('Given clear When 调用 Then 全部清空', () => {
    const tracker = new PendingCommandTracker()
    tracker.remember('t1', 'git push')
    tracker.clear()

    expect(tracker.size).toBe(0)
    expect(tracker.take('t1')).toBeNull()
  })
})
