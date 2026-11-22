import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = join(import.meta.dir, '..')
const appRoot = join(rendererRoot, '../..')

describe('旧版 Scratch Pad 数据迁移退役', () => {
  test('Given 渲染入口 When 检查 Then 迁移触发组件与挂载点已移除', () => {
    const source = readFileSync(join(rendererRoot, 'main.tsx'), 'utf8')

    expect(source).not.toContain('LegacyScratchPadMigrationInitializer')
    expect(source).not.toContain('triggerLegacyScratchPadMigration')
    // 活链路：渲染入口仍挂载应用主体与初始化组件。
    expect(source).toContain('<App />')
    expect(source).toContain('<GlobalShortcuts />')
  })

  test('Given preload bridge When 检查 Then loadScratchPad 桥接已移除', () => {
    const source = readFileSync(join(appRoot, 'src/preload/index.ts'), 'utf8')

    expect(source).not.toContain('loadScratchPad')
    expect(source).not.toContain('SCRATCH_PAD_IPC_CHANNELS')
  })

  test('Given 主进程配置路径 When 检查 Then 旧文件迁移入口已移除', () => {
    const source = readFileSync(join(appRoot, 'src/main/lib/config-paths.ts'), 'utf8')

    expect(source).not.toContain('getScratchPadPath')
    // 迁移机制整体下线，状态文件与内容指纹相关符号一并退役。
    expect(source).not.toContain('ScratchPadMigrationState')
    expect(source).not.toContain('scratch-pad-migration.json')
    // 活链路：默认 Vault 目录解析保留。
    expect(source).toContain('function getDefaultVaultDir')
  })

  test('Given 类型常量 When 检查 Then Scratch Pad IPC 通道已移除', () => {
    const source = readFileSync(join(appRoot, 'src/types/settings.ts'), 'utf8')

    expect(source).not.toContain('SCRATCH_PAD_IPC_CHANNELS')
    expect(source).not.toContain('scratch-pad:load')
  })

  test('Given 主进程 IPC 注册 When 检查 Then 加载 handler 已移除', () => {
    const source = readFileSync(join(appRoot, 'src/main/ipc.ts'), 'utf8')

    expect(source).not.toContain('SCRATCH_PAD_IPC_CHANNELS')
    expect(source).not.toContain('getScratchPadPath')
  })

  test('Given 渲染层迁移工具文件 When 检查 Then 文件已删除', () => {
    expect(existsSync(join(rendererRoot, 'lib/legacy-scratch-pad-migration.ts'))).toBe(false)
  })
})