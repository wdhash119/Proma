import { describe, expect, test } from 'bun:test'
import {
  isQianwenPlanQuotaCredentialExpired,
  isQianwenTokenPlanProvider,
  parseQianwenPlanQuotaCredentials,
  serializeQianwenPlanQuotaCredentials,
  type QianwenPlanQuotaCredentials,
} from './channel'

const sample: QianwenPlanQuotaCredentials = {
  access: 'qianwen-access-token',
  expires: 1_800_000_000_000,
  accountId: 'aliyun-uid-123',
}

describe('千问额度凭据序列化', () => {
  test('Given 完整凭据 When 序列化再解析 Then 往返一致', () => {
    expect(parseQianwenPlanQuotaCredentials(serializeQianwenPlanQuotaCredentials(sample))).toEqual(sample)
  })

  test('Given 无 accountId 的凭据 When 往返 Then 省略可选字段', () => {
    const minimal: QianwenPlanQuotaCredentials = { access: 'a', expires: 123 }
    expect(parseQianwenPlanQuotaCredentials(serializeQianwenPlanQuotaCredentials(minimal))).toEqual(minimal)
  })

  test('Given 带 refresh 的宽松对象 When 序列化 Then 只保留 access/expires/accountId', () => {
    const withRefresh = { ...sample, refresh: 'must-not-be-persisted' } as QianwenPlanQuotaCredentials
    const serialized = serializeQianwenPlanQuotaCredentials(withRefresh)
    expect(serialized).not.toContain('refresh')
    expect(serialized).not.toContain('must-not-be-persisted')
    expect(JSON.parse(serialized)).toEqual(sample)
  })
})

describe('千问额度凭据解析', () => {
  test('Given 空值 When 解析 Then null', () => {
    expect(parseQianwenPlanQuotaCredentials('')).toBeNull()
    expect(parseQianwenPlanQuotaCredentials('   ')).toBeNull()
  })

  test('Given 非 JSON 或非法 JSON When 解析 Then null（不抛错）', () => {
    expect(parseQianwenPlanQuotaCredentials('sk-sp-plain-api-key')).toBeNull()
    expect(parseQianwenPlanQuotaCredentials('{"access":')).toBeNull()
    expect(parseQianwenPlanQuotaCredentials('[]')).toBeNull()
    expect(parseQianwenPlanQuotaCredentials('null')).toBeNull()
  })

  test('Given 缺少 access When 解析 Then null', () => {
    expect(parseQianwenPlanQuotaCredentials(JSON.stringify({ expires: 1 }))).toBeNull()
    expect(parseQianwenPlanQuotaCredentials(JSON.stringify({ access: '', expires: 1 }))).toBeNull()
    expect(parseQianwenPlanQuotaCredentials(JSON.stringify({ access: '   ', expires: 1 }))).toBeNull()
  })

  test('Given expires 非正数或非有限数 When 解析 Then null', () => {
    expect(parseQianwenPlanQuotaCredentials(JSON.stringify({ access: 'a', expires: 0 }))).toBeNull()
    expect(parseQianwenPlanQuotaCredentials(JSON.stringify({ access: 'a', expires: -1 }))).toBeNull()
    expect(parseQianwenPlanQuotaCredentials(JSON.stringify({ access: 'a', expires: 'soon' }))).toBeNull()
    expect(parseQianwenPlanQuotaCredentials('{"access":"a","expires":null}')).toBeNull()
  })

  test('Given accountId 非字符串 When 解析 Then 丢弃该字段但保留凭据', () => {
    const parsed = parseQianwenPlanQuotaCredentials(JSON.stringify({ access: 'a', expires: 1000, accountId: 42 }))
    expect(parsed).toEqual({ access: 'a', expires: 1000 })
  })

  test('Given 上游额外字段 When 解析 Then 只返回已知字段', () => {
    const parsed = parseQianwenPlanQuotaCredentials(JSON.stringify({
      access: 'a',
      expires: 1000,
      refresh: 'r',
      token: 't',
    }))
    expect(parsed).toEqual({ access: 'a', expires: 1000 })
  })
})

describe('千问额度凭据过期判定', () => {
  test('Given 远期 expires When 判定 Then 未过期', () => {
    const now = Date.now()
    expect(isQianwenPlanQuotaCredentialExpired({ access: 'a', expires: now + 3_600_000 })).toBe(false)
  })

  test('Given 已过期 expires When 判定 Then 已过期', () => {
    const now = Date.now()
    expect(isQianwenPlanQuotaCredentialExpired({ access: 'a', expires: now - 1 })).toBe(true)
  })

  test('Given 剩余不足 60 秒 When 判定 Then 视为过期（预留时钟偏移）', () => {
    const now = Date.now()
    expect(isQianwenPlanQuotaCredentialExpired({ access: 'a', expires: now + 30_000 })).toBe(true)
    expect(isQianwenPlanQuotaCredentialExpired({ access: 'a', expires: now + 120_000 })).toBe(false)
  })

  test('Given 自定义 skew When 判定 Then 按传入余量计算', () => {
    const now = Date.now()
    expect(isQianwenPlanQuotaCredentialExpired({ access: 'a', expires: now + 5_000 }, 0)).toBe(false)
    expect(isQianwenPlanQuotaCredentialExpired({ access: 'a', expires: now + 5_000 }, 10_000)).toBe(true)
  })
})

describe('千问 Token Plan provider 判定', () => {
  test('Given 两个 Token Plan provider When 判定 Then 为 true', () => {
    expect(isQianwenTokenPlanProvider('qianwen-token-plan')).toBe(true)
    expect(isQianwenTokenPlanProvider('qianwen-token-plan-openai')).toBe(true)
  })

  test('Given 按量计费千问 provider When 判定 Then 为 false', () => {
    expect(isQianwenTokenPlanProvider('qianwen')).toBe(false)
    expect(isQianwenTokenPlanProvider('qianwen-anthropic')).toBe(false)
  })

  test('Given 其他供应商 When 判定 Then 为 false', () => {
    expect(isQianwenTokenPlanProvider('anthropic')).toBe(false)
    expect(isQianwenTokenPlanProvider('qwen-token-plan')).toBe(false)
    expect(isQianwenTokenPlanProvider('custom')).toBe(false)
  })
})
