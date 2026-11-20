import { describe, expect, test } from 'bun:test'
import type { BashOperations } from '@earendil-works/pi-coding-agent'
import {
  PROMA_DEFAULT_BASH_TIMEOUT_SECONDS,
  buildWslBashArgs,
  windowsPathToWslPath,
  withDefaultBashTimeout,
} from './pi-agent-adapter'

describe('Pi WSL Bash', () => {
  test('Given a Windows workspace path When building WSL Bash arguments Then uses its mounted Linux path', () => {
    expect(buildWslBashArgs(
      { wslDistro: 'Ubuntu-24.04' },
      'C:\\Users\\alice\\Workspace\\project',
      'pwd',
      undefined,
    )).toEqual([
      '--distribution',
      'Ubuntu-24.04',
      '--cd',
      '/mnt/c/Users/alice/Workspace/project',
      '--exec',
      'bash',
      '-lc',
      'pwd',
    ])
  })

  test('Given a Linux path When converting for WSL Then leaves it unchanged', () => {
    expect(windowsPathToWslPath('/home/alice/project')).toBe('/home/alice/project')
  })

})

describe('Pi Bash 默认超时', () => {
  const createRecorder = (): { operations: BashOperations; timeouts: Array<number | undefined> } => {
    const timeouts: Array<number | undefined> = []
    return {
      timeouts,
      operations: {
        exec(_command, _cwd, options) {
          timeouts.push(options.timeout)
          return Promise.resolve({ exitCode: 0 })
        },
      },
    }
  }

  test('Given 模型未传 timeout When 执行 Then 默认使用 300 秒', async () => {
    const recorder = createRecorder()
    await withDefaultBashTimeout(recorder.operations).exec('ls', '/', { onData: () => {} })

    expect(PROMA_DEFAULT_BASH_TIMEOUT_SECONDS).toBe(300)
    expect(recorder.timeouts).toEqual([300])
  })

  test('Given 模型显式传入 timeout When 执行 Then 保留原值', async () => {
    const recorder = createRecorder()
    await withDefaultBashTimeout(recorder.operations).exec('sleep 10', '/', { onData: () => {}, timeout: 10 })

    expect(recorder.timeouts).toEqual([10])
  })

  test('Given timeout 为非正数 When 执行 Then 回退到默认上限', async () => {
    const recorder = createRecorder()
    const operations = withDefaultBashTimeout(recorder.operations)
    await operations.exec('ls', '/', { onData: () => {}, timeout: 0 })
    await operations.exec('ls', '/', { onData: () => {}, timeout: -1 })

    expect(recorder.timeouts).toEqual([300, 300])
  })
})
