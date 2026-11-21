import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONSERVATIVE_CONPTY_BUILD_NUMBER,
  MODERN_CONPTY_BUILD_NUMBER,
  getWindowsPtyOptions,
  parseWindowsBuildNumber,
} from './terminal-windows-pty'

describe('Windows ConPTY build 号解析', () => {
  test('Given Win11 release When 解析 Then 取第三段 build', () => {
    expect(parseWindowsBuildNumber('10.0.22631')).toBe(22631)
    expect(parseWindowsBuildNumber('10.0.26100')).toBe(26100)
  })

  test('Given 旧 Win10 release When 解析 Then 保留旧 build', () => {
    expect(parseWindowsBuildNumber('10.0.19041')).toBe(19041)
  })

  test('Given 非法 release When 解析 Then 返回 0', () => {
    expect(parseWindowsBuildNumber('')).toBe(0)
    expect(parseWindowsBuildNumber('Darwin')).toBe(0)
    expect(parseWindowsBuildNumber('10.0')).toBe(0)
  })
})

describe('xterm windowsPty 选项', () => {
  test('Given 现代 build When 生成选项 Then 透传真实 build（≥21376 关闭旧版启发式）', () => {
    const options = getWindowsPtyOptions(22631)
    expect(options.backend).toBe('conpty')
    expect(options.buildNumber).toBe(22631)
    expect(options.buildNumber).toBeGreaterThanOrEqual(MODERN_CONPTY_BUILD_NUMBER)
  })

  test('Given 未知或非法 build When 生成选项 Then 回退保守值', () => {
    expect(getWindowsPtyOptions().buildNumber).toBe(CONSERVATIVE_CONPTY_BUILD_NUMBER)
    expect(getWindowsPtyOptions(0).buildNumber).toBe(CONSERVATIVE_CONPTY_BUILD_NUMBER)
    expect(getWindowsPtyOptions(Number.NaN).buildNumber).toBe(CONSERVATIVE_CONPTY_BUILD_NUMBER)
  })
})

describe('终端组件 ConPTY 适配契约', () => {
  test('Given TerminalTabContent When 检查 Then 使用真实 build 且 Windows 关闭 convertEol', () => {
    const source = readFileSync(join(import.meta.dir, '../components/tabs/TerminalTabContent.tsx'), 'utf8')
    expect(source).toContain('getWindowsPtyOptions(window.electronAPI.getWindowsBuildNumber())')
    expect(source).toContain('convertEol: !detectIsWindows()')
  })

  test('Given preload When 检查 Then 经同步 IPC 暴露 getWindowsBuildNumber（沙箱不可读 node:os）', () => {
    const source = readFileSync(join(import.meta.dir, '../../preload/index.ts'), 'utf8')
    expect(source).toContain('getWindowsBuildNumber: () => number')
    expect(source).toContain('ipcRenderer.sendSync(TERMINAL_IPC_CHANNELS.GET_WINDOWS_BUILD_NUMBER)')
    expect(source).not.toContain("from 'node:os'")
  })
})