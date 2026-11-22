import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type ChannelManagerModule = typeof import('./channel-manager')

let channelManager: ChannelManagerModule
let tempHome: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  shell: {
    openExternal: async () => undefined,
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))


interface ChannelsFile {
  version: number
  channels: Record<string, unknown>[]
}

function channelsPath(): string {
  return join(tempHome, '.proma', 'channels.json')
}

function writeChannels(channels: unknown[], version = 7): void {
  mkdirSync(join(tempHome, '.proma'), { recursive: true })
  writeFileSync(channelsPath(), JSON.stringify({ version, channels }), 'utf-8')
}

function readChannels(): ChannelsFile {
  return JSON.parse(readFileSync(channelsPath(), 'utf-8')) as ChannelsFile
}

function qianwenChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'qianwen-channel',
    name: '千问 Token Plan',
    provider: 'qianwen-token-plan',
    baseUrl: 'https://token-plan.maas.qianwenaiapi.com/apps/anthropic',
    apiKey: 'sk-sp-inference-key',
    models: [],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const VALID_CREDENTIAL = JSON.stringify({ access: 'qianwen-access', expires: Date.now() + 3_600_000 })
const EXPIRED_CREDENTIAL = JSON.stringify({ access: 'qianwen-access', expires: Date.now() - 3_600_000 })

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-channel-qianwen-plan-quota-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  channelManager = await import('./channel-manager')
})

beforeEach(() => {
  rmSync(join(tempHome, '.proma'), { recursive: true, force: true })
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
  rmSync(tempHome, { recursive: true, force: true })
})

describe('千问额度凭据生命周期', () => {
  test('Given 千问渠道 When 保存额度凭据 Then 不改动推理 API Key', async () => {
    writeChannels([qianwenChannel()])

    channelManager.updateChannel('qianwen-channel', { planQuotaCredential: VALID_CREDENTIAL })

    await expect(channelManager.resolveChannelRuntimeApiKey('qianwen-channel'))
      .resolves.toBe('sk-sp-inference-key')

    const channel = readChannels().channels[0]!
    expect(channel.apiKey).toBe('sk-sp-inference-key')
    expect(channel.planQuotaCredential).toBe(VALID_CREDENTIAL)
  })

  test('Given 已登录 Who 其他字段更新 When 未传凭据 Then 保留已保存的登录', () => {
    writeChannels([qianwenChannel({ planQuotaCredential: VALID_CREDENTIAL })])

    channelManager.updateChannel('qianwen-channel', { name: '改名后的千问' })

    const channel = readChannels().channels[0]!
    expect(channel.name).toBe('改名后的千问')
    expect(channel.planQuotaCredential).toBe(VALID_CREDENTIAL)
  })

  test('Given 已登录 When 传 null Then 清除登录但保留 API Key', async () => {
    writeChannels([qianwenChannel({ planQuotaCredential: VALID_CREDENTIAL })])

    channelManager.updateChannel('qianwen-channel', { planQuotaCredential: null })

    const channel = readChannels().channels[0]!
    expect(channel.planQuotaCredential).toBeUndefined()
    expect(channel.apiKey).toBe('sk-sp-inference-key')
    await expect(channelManager.resolveChannelRuntimeApiKey('qianwen-channel'))
      .resolves.toBe('sk-sp-inference-key')
  })

  test('Given 千问渠道已登录 When provider 改为非千问 Then 自动移除额度凭据', () => {
    writeChannels([qianwenChannel({ planQuotaCredential: VALID_CREDENTIAL })])

    channelManager.updateChannel('qianwen-channel', { provider: 'anthropic' })

    const channel = readChannels().channels[0]!
    expect(channel.provider).toBe('anthropic')
    expect(channel.planQuotaCredential).toBeUndefined()
    expect(channel.apiKey).toBe('sk-sp-inference-key')
  })

  test('Given 非千问渠道 When 写入非空额度凭据 Then 拒绝并保持配置不变', () => {
    writeChannels([qianwenChannel({ id: 'anthropic-channel', provider: 'anthropic', name: 'Anthropic' })])

    expect(() => channelManager.updateChannel('anthropic-channel', { planQuotaCredential: VALID_CREDENTIAL }))
      .toThrow('只有千问 Token Plan 渠道可以保存额度查询凭据')
    expect(readChannels().channels[0]!.planQuotaCredential).toBeUndefined()
  })
})

describe('千问渠道额度查询入口', () => {
  test('Given 未登录 When 查询额度 Then 返回可操作的登录提示', async () => {
    writeChannels([qianwenChannel()])

    const result = await channelManager.getChannelPlanQuota('qianwen-channel')
    expect(result.supported).toBe(false)
    expect(result.provider).toBe('qianwen-token-plan')
    expect(result.message).toBe('请先在编辑渠道中登录千问账号')
  })

  test('Given access token 已过期 When 查询额度 Then 提示重新登录且不发请求', async () => {
    writeChannels([qianwenChannel({ planQuotaCredential: EXPIRED_CREDENTIAL })])

    const result = await channelManager.getChannelPlanQuota('qianwen-channel')
    expect(result.supported).toBe(false)
    expect(result.message).toBe('千问登录已过期，请重新登录')
  })

  test('Given 额度凭据无法解析 When 查询额度 Then 提示重新登录', async () => {
    writeChannels([qianwenChannel({ planQuotaCredential: 'not-json' })])

    const result = await channelManager.getChannelPlanQuota('qianwen-channel')
    expect(result.supported).toBe(false)
    expect(result.message).toBe('千问登录凭据无效，请重新登录')
  })

  test('Given OpenAI 兼容千问渠道 When 查询额度 Then provider 保持原类型', async () => {
    writeChannels([qianwenChannel({
      id: 'qianwen-openai',
      provider: 'qianwen-token-plan-openai',
      baseUrl: 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
    })])

    const result = await channelManager.getChannelPlanQuota('qianwen-openai')
    expect(result.provider).toBe('qianwen-token-plan-openai')
    expect(result.supported).toBe(false)
  })
})

describe('渠道删除', () => {
  test('Given 已登录的千问渠道 When 删除 Then 渠道被移除', () => {
    writeChannels([qianwenChannel({ planQuotaCredential: VALID_CREDENTIAL })])

    channelManager.deleteChannel('qianwen-channel')

    expect(channelManager.getChannelById('qianwen-channel')).toBeUndefined()
    expect(readChannels().channels).toHaveLength(0)
  })

  test('Given 渠道管理器源码 When 删除渠道 Then 必须清除派生凭证缓存', () => {
    // mock.module 是进程级全局状态，会污染并行运行的其他测试文件；
    // 这里用源码契约锁定 deleteChannel 的清理接线，行为本身由
    // qianwen-plan-quota.test.ts 的 invalidateQianwenDerivedToken 用例覆盖。
    const source = readFileSync(new URL('./channel-manager.ts', import.meta.url), 'utf-8')
    const deleteBlock = source.slice(source.indexOf('export function deleteChannel'))
    expect(deleteBlock).toContain('invalidateQianwenDerivedToken(removed.id)')
    expect(source).toContain('invalidateQianwenDerivedToken')
  })
})

describe('配置兼容性', () => {
  test('Given 旧版 channels.json 没有额度凭据字段 When 读取 Then 正常返回且不升级版本', () => {
    writeChannels([qianwenChannel()])

    const channel = channelManager.getChannelById('qianwen-channel')
    expect(channel?.provider).toBe('qianwen-token-plan')
    expect(channel?.planQuotaCredential).toBeUndefined()

    const file = readChannels()
    expect(file.version).toBe(7)
    expect(file.channels).toHaveLength(1)
  })
})
