/**
 * P4：会话工具栏 Live Compact 按钮的状态机与渲染接线测试。
 *
 * 状态机语义必须与主进程 resolveLiveCompactEnabled 一致：
 *   effective = globalEnabled && (meta.liveCompact ?? true)
 * 三态（开启 / 显式关闭 / 继承全局）+ 全局关闭禁用态都在纯函数里断言；
 * AgentView 只负责把 state 映射到 className / tooltip / 点击处理，用源码契约锁住。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LIVE_COMPACT_BUTTON_TOOLTIPS,
  resolveLiveCompactButtonState,
} from './live-compact-button'

const appRoot = join(import.meta.dir, '../../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

describe('Live Compact 按钮状态机', () => {
  test('Given 全局开启且会话继承 When 解析 Then 生效并提示可关闭', () => {
    const state = resolveLiveCompactButtonState({ globalEnabled: true, sessionLiveCompact: undefined })

    expect(state.effective).toBe(true)
    expect(state.disabled).toBe(false)
    expect(state.nextSessionValue).toBe(false)
    expect(state.tooltip).toBe(LIVE_COMPACT_BUTTON_TOOLTIPS.on)
  })

  test('Given 全局开启且会话显式 true When 解析 Then 与继承等价，同样生效', () => {
    const state = resolveLiveCompactButtonState({ globalEnabled: true, sessionLiveCompact: true })

    expect(state.effective).toBe(true)
    expect(state.nextSessionValue).toBe(false)
  })

  test('Given 全局开启且会话显式 false When 解析 Then 不生效且点击写 true', () => {
    const state = resolveLiveCompactButtonState({ globalEnabled: true, sessionLiveCompact: false })

    expect(state.effective).toBe(false)
    expect(state.disabled).toBe(false)
    expect(state.nextSessionValue).toBe(true)
    expect(state.tooltip).toBe(LIVE_COMPACT_BUTTON_TOOLTIPS.off)
  })

  test('Given 全局关闭 When 任一会话取值 Then 禁用并提示先去设置启用', () => {
    for (const sessionLiveCompact of [undefined, true, false]) {
      const state = resolveLiveCompactButtonState({ globalEnabled: false, sessionLiveCompact })

      expect(state.effective).toBe(false)
      expect(state.disabled).toBe(true)
      expect(state.tooltip).toBe(LIVE_COMPACT_BUTTON_TOOLTIPS.globalOff)
    }
  })

  test('Given 提交中 When 解析 Then 点击被禁用但不改变生效态', () => {
    const state = resolveLiveCompactButtonState({
      globalEnabled: true,
      sessionLiveCompact: true,
      pending: true,
    })

    expect(state.effective).toBe(true)
    expect(state.disabled).toBe(true)
  })
})

describe('AgentView 工具栏接线', () => {
  test('Given AgentView When 检查工具栏项 Then 有 Live Compact 按钮且用 Layers 图标与 active 样式', () => {
    const view = readAppFile('src/renderer/components/agent/AgentView.tsx')

    expect(view).toContain("key: 'live-compact'")
    expect(view).toContain('<Layers className="size-[17px]" />')
    expect(view).toContain('liveCompactButtonState.effective && inputToolbarActiveButtonClass')
    expect(view).toContain('disabled={liveCompactButtonState.disabled}')
    expect(view).toContain('aria-pressed={liveCompactButtonState.effective}')
    expect(view).toContain('{liveCompactButtonState.tooltip}')
  })

  test('Given AgentView When 点击按钮 Then 经专用 IPC 写显式布尔并允许运行中切换', () => {
    const view = readAppFile('src/renderer/components/agent/AgentView.tsx')
    const start = view.indexOf('const handleLiveCompactToggle')
    expect(start).toBeGreaterThan(-1)
    const body = view.slice(start, start + 1600)

    // 写的是显式 true/false，不做继承态回退。
    expect(body).toContain('window.electronAPI.updateSessionLiveCompact(sessionId, nextEnabled)')
    expect(body).toContain('const nextEnabled = liveCompactButtonState.nextSessionValue')
    // 失败回滚 + toast，与设置页开关一致。
    expect(body).toContain('setAgentSessions((prev) => prev.map((item) => item.id === sessionId ? previousSessionMeta : item))')
    expect(body).toContain("toast.error('Live Compact 切换失败'")
    // 运行中开启需要在下一轮生效，提示里写明边界。
    expect(body).toContain('Live Compact 已开启，下一轮消息起生效')
  })

  test('Given 全局主闸 atom When 检查 Then 启动与设置页保存都同步它', () => {
    const atoms = readAppFile('src/renderer/atoms/agent-atoms.ts')
    expect(atoms).toContain('export const liveCompactGlobalEnabledAtom = atom<boolean>(false)')

    const main = readAppFile('src/renderer/main.tsx')
    expect(main).toContain('setLiveCompactGlobalEnabled(settings.liveCompact?.enabled === true)')

    const settings = readAppFile('src/renderer/components/settings/LiveCompactSettings.tsx')
    expect(settings).toContain('setGlobalEnabledAtom(enabled)')
  })
})
