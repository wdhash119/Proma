import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const libRoot = join(import.meta.dir)

function read(file: string): string {
  return readFileSync(join(libRoot, file), 'utf8')
}

describe('协作跨供应商契约', () => {
  test('Given 委派解析 When 检查 Then 不再硬编码父会话渠道', () => {
    const source = read('agent-collaboration-tools.ts')

    // 三处都必须使用解析结果，而不是直接把父会话渠道透传给子会话。
    expect(source).toContain('resolveDelegationTarget(')
    expect(source).toContain('const effectiveChannelId = target.channelId')
    expect(source).not.toContain('assertEnabledModelForChannel')
    expect(source).not.toContain('listEnabledAgentModelsForChannel')

    // 子会话创建与执行都必须用解析后的渠道。
    expect(source).toContain('createAgentSession(title, effectiveChannelId, ctx.workspaceId, effectiveModelId)')
    expect(source).toContain('channelId: effectiveChannelId,')
  })

  test('Given 两个委派工具 When 检查参数 Then 都暴露 channelId', () => {
    const source = read('agent-collaboration-tools.ts')

    // 单次与批量都要能指定目标渠道。
    const channelIdParams = source.match(/channelId: Type\.Optional\(Type\.String/g) ?? []
    expect(channelIdParams.length).toBeGreaterThanOrEqual(2)

    expect(source).toContain('interface DelegateAgentArgs')
    expect(source).toContain('  channelId?: string')
  })

  test('Given 模型清单工具 When 检查描述 Then 说明默认继承与跨渠道方式', () => {
    const source = read('agent-collaboration-tools.ts')

    expect(source).toContain('listAvailableAgentModelsAcrossChannels')
    expect(source).toContain('默认继承父会话渠道与模型')
    expect(source).toContain('显式传 channelId 与 modelId')
  })

  test('Given 解析实现 When 检查 Then 歧义与非启用渠道都被拒绝', () => {
    const source = read('delegation-target.ts')

    expect(source).toContain('属于多个启用渠道，请显式指定 channelId')
    expect(source).toContain('不存在或未启用')
    expect(source).toContain('没有启用渠道提供该模型')
    expect(source).toContain('crossChannel')
  })
})
