import { beforeEach, describe, expect, test } from 'bun:test'
import type { ChannelPlanQuotaWindow, QianwenPlanQuotaCredentials } from '@proma/shared'
import type { ManagedProxyFetch } from './proxy-fetch'
import {
  invalidateQianwenDerivedToken,
  parseQianwenPersonalQuota,
  parseQianwenTeamQuota,
  queryQianwenPlanQuota,
} from './qianwen-plan-quota'
import {
  QIANWEN_CLI_API_URL,
  QIANWEN_CORNERSTONE_PARAM as CORNERSTONE_PARAM,
  QIANWEN_CS_DATA_ACTION,
  QIANWEN_CS_DATA_PRODUCT,
  QIANWEN_CS_DATA_URL,
  QIANWEN_GATEWAY_API_VERSION,
  QIANWEN_SOLO_COMMODITY_CODE,
  QIANWEN_SOLO_SUBSCRIPTION_API,
  QIANWEN_SOLO_USAGE_API,
  QIANWEN_TEAM_COMMODITY_CODE,
} from './qianwen-api-routes'

/**
 * 千问额度解析与查询契约。
 *
 * 全部使用注入的 transport：测试不访问 cli/cs-data 内部网关，也不依赖真实账号。
 * fixture 按官方 CLI 真实响应形态构造（flat 派生凭证、DataV2.data 业务信封、数值时间戳）。
 */

// 以测试运行时刻为锚点：登录凭据、订阅窗口与重置时间都相对它计算，避免断言依赖某一天。
const NOW = Date.now()
/** 官方 parseSoloSubscription 的 startTime/endTime 是 Unix 毫秒整数。 */
const MONTH_START = NOW - 20 * 86_400_000
const MONTH_END = NOW + 10 * 86_400_000
const MONTH_RESET = MONTH_END

const CREDENTIALS: QianwenPlanQuotaCredentials = {
  access: 'qianwen-access-token',
  expires: NOW + 3_600_000,
  accountId: 'aliyun-uid-1',
}

/**
 * 官方 cs-data 信封：`DataV2.ret[0]` 只带成功标记，业务信封在 `DataV2.data`。
 */
function csData(business: unknown): unknown {
  return {
    code: '200',
    successResponse: true,
    data: {
      success: true,
      DataV2: {
        ret: ['SUCCESS::'],
        data: { code: 'SUCCESS', success: true, data: business },
      },
    },
  }
}

/** 官方 parseSoloSubscription 的真实字段集（默认不返回 commodityCode）。 */
function soloSubscription(overrides: Record<string, unknown> = {}): unknown {
  return csData({
    status: 'VALID',
    instanceCode: 'instance-pro-1',
    specCode: 'pro',
    remainingDays: 10,
    startTime: MONTH_START,
    endTime: MONTH_END,
    autoRenewFlag: true,
    ...overrides,
  })
}

function soloUsage(overrides: Record<string, unknown> = {}): unknown {
  return csData({ per1MonthPercentage: 0.16, per1MonthResetTime: MONTH_END, ...overrides })
}

function teamBody(groupList: unknown[]): Record<string, unknown> {
  return {
    Success: true,
    Code: 'Success',
    ProductCode: QIANWEN_TEAM_COMMODITY_CODE,
    SubscriptionGroupList: groupList,
  }
}

/** 官方 extractSeatTiers：NextCycleFlushTime 在席位组上，不在 Credits 权益上。 */
function teamGroup(specType: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    SpecType: specType,
    SubscriptionTotalNumber: 5,
    NextCycleFlushTime: MONTH_RESET,
    EquityList: [{
      EquityType: 'CREDITS',
      TotalValue: '1000',
      SurplusValue: '250',
    }],
    ...overrides,
  }
}

function labels(windows: ChannelPlanQuotaWindow[]): string[] {
  return windows.map((window) => window.label)
}

describe('千问个人版额度解析', () => {
  test('Given 有效 Pro 订阅与 16% 月度用量 When 解析 Then 个人版本月剩余 84% 并带重置时间', () => {
    const result = parseQianwenPersonalQuota({ subscription: soloSubscription(), usage: soloUsage(), now: NOW })

    expect(result.planName).toBe('千问 Token Plan 个人版 Pro')
    expect(result.windows).toEqual([{
      type: 'custom',
      label: '个人版本月',
      remainingPercent: 84,
      usedPercent: 16,
      showProgress: true,
      resetAt: MONTH_RESET,
    }])
    expect(result.message).toBeUndefined()
  })

  test('Given 已用比例为 0 与 1 When 解析 Then 边界百分比正确', () => {
    const zero = parseQianwenPersonalQuota({
      subscription: soloSubscription(), usage: soloUsage({ per1MonthPercentage: 0 }), now: NOW,
    })
    expect(zero.windows[0]).toMatchObject({ remainingPercent: 100, usedPercent: 0 })

    const full = parseQianwenPersonalQuota({
      subscription: soloSubscription(), usage: soloUsage({ per1MonthPercentage: 1 }), now: NOW,
    })
    expect(full.windows[0]).toMatchObject({ remainingPercent: 0, usedPercent: 100 })
  })

  test('Given 已用比例 0.1234 When 解析 Then 百分比保留两位小数', () => {
    const result = parseQianwenPersonalQuota({
      subscription: soloSubscription(), usage: soloUsage({ per1MonthPercentage: 0.1234 }), now: NOW,
    })
    expect(result.windows[0]).toMatchObject({ usedPercent: 12.34, remainingPercent: 87.66 })
  })

  test('Given 缺少重置时间 When 解析 Then 仍展示百分比且不虚构时间', () => {
    const result = parseQianwenPersonalQuota({
      subscription: soloSubscription(),
      usage: csData({ per1MonthPercentage: 0.5 }),
      now: NOW,
    })
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0]!.resetAt).toBeUndefined()
  })

  test('Given 只有 weekly 数据 When 解析 Then 不生成月度窗口', () => {
    const result = parseQianwenPersonalQuota({
      subscription: soloSubscription(),
      usage: csData({ per1WeekPercentage: 0.4, per1WeekResetTime: MONTH_END }),
      now: NOW,
    })
    expect(result.windows).toEqual([])
  })

  test('Given 月度比例越界、字符串或 NaN When 解析 Then 不生成窗口', () => {
    for (const value of [1.2, -0.1, '0.3', null]) {
      const result = parseQianwenPersonalQuota({
        subscription: soloSubscription(), usage: csData({ per1MonthPercentage: value }), now: NOW,
      })
      expect(result.windows).toEqual([])
    }
  })

  test('Given 缺少月度字段 When 解析 Then 不生成窗口', () => {
    const result = parseQianwenPersonalQuota({
      subscription: soloSubscription(), usage: csData({}), now: NOW,
    })
    expect(result.windows).toEqual([])
  })

  test('Given 非法重置时间 When 解析 Then 丢弃 resetAt', () => {
    const result = parseQianwenPersonalQuota({
      subscription: soloSubscription(),
      usage: csData({ per1MonthPercentage: 0.2, per1MonthResetTime: '2026-12-01 00:00:00' }),
      now: NOW,
    })
    expect(result.windows[0]!.resetAt).toBeUndefined()
  })

  test('Given 非 VALID 状态 When 解析 Then 不生成个人窗口', () => {
    const result = parseQianwenPersonalQuota({
      subscription: soloSubscription({ status: 'EXPIRED' }), usage: soloUsage(), now: NOW,
    })
    expect(result.windows).toEqual([])
  })

  test('Given 当前时间不在订阅有效期 When 解析 Then 不生成个人窗口', () => {
    const beforeStart = parseQianwenPersonalQuota({
      subscription: soloSubscription({ startTime: NOW + 86_400_000 }),
      usage: soloUsage(),
      now: NOW,
    })
    expect(beforeStart.windows).toEqual([])

    const afterEnd = parseQianwenPersonalQuota({
      subscription: soloSubscription({ endTime: NOW - 86_400_000 }),
      usage: soloUsage(),
      now: NOW,
    })
    expect(afterEnd.windows).toEqual([])
  })

  test('Given 响应未返回 commodityCode When 解析 Then 仍按其他真实字段展示个人窗口', () => {
    const result = parseQianwenPersonalQuota({ subscription: soloSubscription(), usage: soloUsage(), now: NOW })
    expect(result.windows).toHaveLength(1)
    expect(result.planName).toBe('千问 Token Plan 个人版 Pro')
  })

  test('Given 显式 commodityCode 是团队版 When 解析 Then 拒绝当作个人版', () => {
    const result = parseQianwenPersonalQuota({
      subscription: soloSubscription({ commodityCode: QIANWEN_TEAM_COMMODITY_CODE }),
      usage: soloUsage(),
      now: NOW,
    })
    expect(result.windows).toEqual([])
  })

  test('Given 未知档位 When 解析 Then 只显示个人版通用名称', () => {
    const result = parseQianwenPersonalQuota({
      subscription: soloSubscription({ specCode: 'mystery-tier' }), usage: soloUsage(), now: NOW,
    })
    expect(result.planName).toBe('千问 Token Plan 个人版')
  })

  test('Given specCode 是 professional When 解析 Then 不归为 Pro', () => {
    const result = parseQianwenPersonalQuota({
      subscription: soloSubscription({ specCode: 'professional' }), usage: soloUsage(), now: NOW,
    })
    expect(result.planName).toBe('千问 Token Plan 个人版')
  })

  test('Given 旧字段 spectype 是 professional When 解析 Then 不归为 Pro', () => {
    const result = parseQianwenPersonalQuota({
      subscription: csData({ status: 'VALID', startTime: MONTH_START, endTime: MONTH_END, spectype: 'professional' }),
      usage: soloUsage(),
      now: NOW,
    })
    expect(result.planName).toBe('千问 Token Plan 个人版')
  })

  test('Given 旧字段 planname 是 Pro套餐 When 解析 Then 按完整单词归为 Pro', () => {
    const result = parseQianwenPersonalQuota({
      subscription: csData({ status: 'VALID', startTime: MONTH_START, endTime: MONTH_END, planname: 'Pro套餐' }),
      usage: soloUsage(),
      now: NOW,
    })
    expect(result.planName).toBe('千问 Token Plan 个人版 Pro')
  })

  test('Given 未登录 envelope When 解析 Then 提示重新登录且不展示窗口', () => {
    const result = parseQianwenPersonalQuota({
      subscription: {
        code: '200',
        successResponse: true,
        data: { success: false, errorCode: 'BailianGateway.Login.NotLogined' },
      },
      usage: soloUsage(),
      now: NOW,
    })
    expect(result.windows).toEqual([])
    expect(result.message).toBe('千问个人版额度需要重新登录')
  })

  test('Given cs-data 外层业务失败 When 解析 Then 不采信 HTTP 200', () => {
    const result = parseQianwenPersonalQuota({
      subscription: { code: '200', successResponse: true, data: { success: false } },
      usage: soloUsage(),
      now: NOW,
    })
    expect(result.windows).toEqual([])
    expect(result.message).toContain('响应异常')
  })
})

describe('千问团队版额度解析', () => {
  test('Given Standard/Pro/Max 各一个席位组 When 解析 Then 分别映射百分比与重置时间', () => {
    const result = parseQianwenTeamQuota(teamBody([
      teamGroup('standard'),
      teamGroup('pro', { EquityList: [{ EquityType: 'CREDITS', TotalValue: '200', SurplusValue: '50' }] }),
      teamGroup('max', { NextCycleFlushTime: undefined, EquityList: [{ EquityType: 'CREDITS', TotalValue: '400', SurplusValue: '400' }] }),
    ]))

    expect(labels(result.windows)).toEqual(['团队 Standard', '团队 Pro', '团队 Max'])
    expect(result.windows[0]).toMatchObject({ remainingPercent: 25, usedPercent: 75, resetAt: MONTH_RESET, showProgress: true })
    expect(result.windows[2]).toMatchObject({ remainingPercent: 100, usedPercent: 0 })
    expect(result.windows[2]!.resetAt).toBeUndefined()
    expect(result.message).toBeUndefined()
  })

  test('Given 业务数据在 Data 包裹里 When 解析 Then 同样可解析', () => {
    const result = parseQianwenTeamQuota({ code: '200', data: teamBody([teamGroup('standard')]) })
    expect(labels(result.windows)).toEqual(['团队 Standard'])
  })

  test('Given 空组列表 When 解析 Then 无团队窗口且无错误', () => {
    const result = parseQianwenTeamQuota(teamBody([]))
    expect(result.windows).toEqual([])
    expect(result.message).toBeUndefined()
  })

  test('Given 非 Credits 单位 When 解析 Then 跳过该组并提示部分数据不可用', () => {
    const result = parseQianwenTeamQuota(teamBody([
      teamGroup('standard', { EquityList: [{ EquityType: 'CREDITS', Unit: 'CNY', TotalValue: '100', SurplusValue: '10' }] }),
      teamGroup('pro'),
    ]))
    expect(labels(result.windows)).toEqual(['团队 Pro'])
    expect(result.message).toBe('部分团队席位额度数据无法解析')
  })

  test('Given Credits 权益缺失或重复 When 解析 Then 跳过该组', () => {
    const missing = parseQianwenTeamQuota(teamBody([
      teamGroup('standard', { EquityList: [{ EquityType: 'API_CALLS', TotalValue: '100', SurplusValue: '10' }] }),
    ]))
    expect(missing.windows).toEqual([])

    const duplicated = parseQianwenTeamQuota(teamBody([
      teamGroup('pro', {
        EquityList: [
          { EquityType: 'CREDITS', TotalValue: '100', SurplusValue: '10' },
          { EquityType: 'CREDITS', TotalValue: '200', SurplusValue: '20' },
        ],
      }),
    ]))
    expect(duplicated.windows).toEqual([])
  })

  test('Given Credits 数值非法 When 解析 Then 跳过该组且不猜测', () => {
    const cases: unknown[] = [
      [{ EquityType: 'CREDITS', TotalValue: '0', SurplusValue: '0' }],
      [{ EquityType: 'CREDITS', TotalValue: '100', SurplusValue: '-1' }],
      [{ EquityType: 'CREDITS', TotalValue: '100', SurplusValue: '200' }],
      [{ EquityType: 'CREDITS', TotalValue: 'abc', SurplusValue: '10' }],
      [{ EquityType: 'CREDITS', TotalValue: '100' }],
    ]
    for (const equityList of cases) {
      const result = parseQianwenTeamQuota(teamBody([teamGroup('standard', { EquityList: equityList })]))
      expect(result.windows).toEqual([])
    }
  })

  test('Given 未知 SpecType When 解析 Then 不生成任意上游标签', () => {
    const result = parseQianwenTeamQuota(teamBody([
      teamGroup('basic'),
      teamGroup('enterprise-plus'),
    ]))
    expect(result.windows).toEqual([])
    expect(result.message).toBeUndefined()
  })

  test('Given 同一 SpecType 多个席位组 When 解析 Then 加序号分别展示且不合并求和', () => {
    const result = parseQianwenTeamQuota(teamBody([
      teamGroup('max'),
      teamGroup('max', { EquityList: [{ EquityType: 'CREDITS', TotalValue: '200', SurplusValue: '100' }] }),
    ]))
    expect(labels(result.windows)).toEqual(['团队 Max 1', '团队 Max 2'])
    expect(result.windows[0]).toMatchObject({ remainingPercent: 25 })
    expect(result.windows[1]).toMatchObject({ remainingPercent: 50 })
  })

  test('Given 合法组与非法组混合 When 解析 Then 保留合法组并提示部分数据', () => {
    const result = parseQianwenTeamQuota(teamBody([
      teamGroup('standard'),
      teamGroup('pro', { EquityList: [] }),
    ]))
    expect(labels(result.windows)).toEqual(['团队 Standard'])
    expect(result.message).toBe('部分团队席位额度数据无法解析')
  })

  test('Given Success 为 false When 解析 Then 不采信组列表', () => {
    const result = parseQianwenTeamQuota({ ...teamBody([teamGroup('standard')]), Success: false })
    expect(result.windows).toEqual([])
    expect(result.message).toContain('响应异常')
  })

  test('Given flat 响应用 Code 200 冒充业务成功 When 解析 Then 仍视为响应异常', () => {
    const result = parseQianwenTeamQuota({ ...teamBody([teamGroup('standard')]), Code: '200' })
    expect(result.windows).toEqual([])
    expect(result.message).toContain('响应异常')
  })

  test('Given 传输信封 code 200 包裹业务对象 When 解析 Then 按业务 Code 校验并正常展示', () => {
    const result = parseQianwenTeamQuota({ code: '200', data: teamBody([teamGroup('standard')]) })
    expect(labels(result.windows)).toEqual(['团队 Standard'])
  })

  test('Given 外层 Success 为 false 而 Data 内含组列表 When 解析 Then 不采信组列表', () => {
    const result = parseQianwenTeamQuota({ Success: false, Data: teamBody([teamGroup('standard')]) })
    expect(result.windows).toEqual([])
    expect(result.message).toContain('响应异常')
  })

  test('Given Code 不是 Success When 解析 Then 不采信组列表', () => {
    const result = parseQianwenTeamQuota({ ...teamBody([teamGroup('standard')]), Code: 'Failed' })
    expect(result.windows).toEqual([])
    expect(result.message).toContain('响应异常')
  })

  test('Given ProductCode 不匹配 When 解析 Then 视为响应异常/接口漂移', () => {
    const result = parseQianwenTeamQuota({ ...teamBody([teamGroup('standard')]), ProductCode: 'sfm_otherproduct' })
    expect(result.windows).toEqual([])
    expect(result.message).toContain('响应异常')
  })

  test('Given 外层 Unit 声明为 CNY When 解析 Then 与权益 Unit 一样拒绝该组', () => {
    const result = parseQianwenTeamQuota(teamBody([
      teamGroup('standard', { Unit: 'CNY' }),
      teamGroup('pro'),
    ]))
    expect(labels(result.windows)).toEqual(['团队 Pro'])
    expect(result.message).toBe('部分团队席位额度数据无法解析')
  })

  test('Given 外层 UnitName 声明为 Credits When 解析 Then 正常展示', () => {
    const result = parseQianwenTeamQuota(teamBody([teamGroup('standard', { UnitName: 'Credits' })]))
    expect(labels(result.windows)).toEqual(['团队 Standard'])
  })
})

interface CapturedCall {
  url: string
  /** application/json 请求体（flat 管理接口）。 */
  json: Record<string, unknown>
  /** application/x-www-form-urlencoded 请求体（cs-data 信封）；其他接口为 null。 */
  form: URLSearchParams | null
  rawBody: string
  contentType: string | undefined
  authorization: string | undefined
  userAgent: string | undefined
}

interface FakeTransport {
  transport: ManagedProxyFetch
  calls: CapturedCall[]
  closeCount: () => number
}

function createQuotaTransport(handler: (call: CapturedCall) => Response | Promise<Response>): FakeTransport {
  const calls: CapturedCall[] = []
  let closed = 0
  return {
    transport: {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        const rawBody = typeof init?.body === 'string' ? init.body : ''
        const contentType = headers['Content-Type']
        const form = contentType === 'application/x-www-form-urlencoded' ? new URLSearchParams(rawBody) : null
        const call: CapturedCall = {
          url: String(input),
          rawBody,
          form,
          json: form ? {} : (rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {}),
          contentType,
          authorization: headers.Authorization,
          userAgent: headers['User-Agent'],
        }
        calls.push(call)
        return handler(call)
      }) as unknown as typeof globalThis.fetch,
      close: async () => { closed += 1 },
    },
    calls,
    closeCount: () => closed,
  }
}

/** 解析 cs-data 表单里的 params JSON。 */
function csParamsOf(call: CapturedCall): Record<string, unknown> {
  const raw = call.form?.get('params')
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function actionOf(call: CapturedCall): string {
  if (call.form) {
    const api = csParamsOf(call).Api
    return typeof api === 'string' ? api : ''
  }
  return typeof call.json.action === 'string' ? call.json.action : ''
}

const GENERATE = 'GenerateCLIAccessToken'
const TEAM_ACTION = 'GetSeatSubscriptionSummary'

/** 官方 GenerateCLIAccessToken 是 cli.qianwenai.com 的 flat 响应：直接读 cliAccessToken。 */
function generateResponse(token: string): Response {
  return jsonResponse({ code: '200', successResponse: true, cliAccessToken: token })
}

/** 默认成功链路：个人版 + 团队版都存在。 */
function defaultHandler(call: CapturedCall): Response {
  const action = actionOf(call)
  if (action === GENERATE) return generateResponse('cli-access-token-1')
  if (action === QIANWEN_SOLO_SUBSCRIPTION_API) return jsonResponse(soloSubscription())
  if (action === QIANWEN_SOLO_USAGE_API) return jsonResponse(soloUsage())
  if (action === TEAM_ACTION) return jsonResponse(teamBody([teamGroup('max')]))
  return jsonResponse({ error: 'unexpected action' }, 500)
}

async function query(
  transport: ManagedProxyFetch,
  credentials: QianwenPlanQuotaCredentials = CREDENTIALS,
  channelId = 'channel-1',
) {
  return queryQianwenPlanQuota(
    channelId,
    'qianwen-token-plan',
    credentials,
    undefined,
    (() => transport) as unknown as typeof import('./proxy-fetch').createManagedProxyFetch,
  )
}

beforeEach(() => {
  // 派生凭证缓存是模块级状态：用不同 channelId 隔离用例，避免跨用例污染。
})

describe('千问额度查询：请求链路', () => {
  test('Given 个人版与团队版都存在 When 查询 Then Generate 派生凭证后分别请求 cs-data 与 BSS', async () => {
    const fake = createQuotaTransport(defaultHandler)
    const result = await query(fake.transport, CREDENTIALS, 'chain-1')

    // 个人版与团队版并行查询：只断言请求集合与各自契约，不依赖完成顺序。
    const actions = fake.calls.map(actionOf)
    expect(actions).toHaveLength(4)
    expect(actions.filter((action) => action === GENERATE)).toHaveLength(1)
    expect(actions.filter((action) => action === QIANWEN_SOLO_SUBSCRIPTION_API)).toHaveLength(1)
    expect(actions.filter((action) => action === QIANWEN_SOLO_USAGE_API)).toHaveLength(1)
    expect(actions.filter((action) => action === TEAM_ACTION)).toHaveLength(1)

    const generate = fake.calls.find((call) => actionOf(call) === GENERATE)!
    const subscription = fake.calls.find((call) => actionOf(call) === QIANWEN_SOLO_SUBSCRIPTION_API)!
    const usage = fake.calls.find((call) => actionOf(call) === QIANWEN_SOLO_USAGE_API)!
    const team = fake.calls.find((call) => actionOf(call) === TEAM_ACTION)!

    expect(generate!.url).toBe(QIANWEN_CLI_API_URL)
    expect(generate!.authorization).toBe(`Bearer ${CREDENTIALS.access}`)
    expect(generate!.userAgent).toBe('qianwen-cli/1.12.0')
    expect(generate!.contentType).toBe('application/json')
    expect(generate!.json).toMatchObject({
      product: 'ModelStudioRegional',
      action: GENERATE,
      version: '2026-02-10',
      region: 'cn-beijing',
      params: {},
    })

    for (const call of [subscription!, usage!]) {
      const url = new URL(call.url)
      expect(url.origin + url.pathname).toBe(QIANWEN_CS_DATA_URL)
      expect(url.searchParams.get('action')).toBe(QIANWEN_CS_DATA_ACTION)
      expect(url.searchParams.get('product')).toBe(QIANWEN_CS_DATA_PRODUCT)
      expect(url.searchParams.get('api')).toBe(actionOf(call))
      expect(call.contentType).toBe('application/x-www-form-urlencoded')
      expect(call.authorization).toBe('Bearer cli-access-token-1')
      expect(call.form!.get('region')).toBe('cn-beijing')
      const params = csParamsOf(call)
      expect(params.Api).toBe(actionOf(call))
      expect(params.V).toBe(QIANWEN_GATEWAY_API_VERSION)
    }

    // subscription 的业务参数白名单只有 commodityCode；usage 必须为空。
    expect(csParamsOf(subscription!).Data).toEqual({
      commodityCode: QIANWEN_SOLO_COMMODITY_CODE,
      cornerstoneParam: CORNERSTONE_PARAM,
    })
    expect(csParamsOf(usage!).Data).toEqual({ cornerstoneParam: CORNERSTONE_PARAM })

    expect(team!.url).toBe(QIANWEN_CLI_API_URL)
    expect(team!.authorization).toBe(`Bearer ${CREDENTIALS.access}`)
    expect(team!.contentType).toBe('application/json')
    expect(team!.json.product).toBe('BssOpenAPI-V3')
    expect(team!.json.params).toEqual({ productCode: QIANWEN_TEAM_COMMODITY_CODE })

    expect(result.supported).toBe(true)
    expect(result.planName).toBe('千问 Token Plan（个人版 + 团队版）')
    expect(labels(result.windows)).toEqual(['个人版本月', '团队 Max'])
    expect(result.message).toBeUndefined()
    expect(fake.closeCount()).toBe(1)
  })

  test('Given 同一渠道重复查询 When 派生凭证已缓存 Then 不重复 Generate', async () => {
    const fake = createQuotaTransport(defaultHandler)
    await query(fake.transport, CREDENTIALS, 'cache-same-channel')
    await query(fake.transport, CREDENTIALS, 'cache-same-channel')
    expect(fake.calls.filter((call) => actionOf(call) === GENERATE)).toHaveLength(1)
  })

  test('Given access token 变化 When 查询 Then 立即弃用旧派生凭证', async () => {
    const fake = createQuotaTransport(defaultHandler)
    await query(fake.transport, CREDENTIALS, 'cache-access-change')
    await query(fake.transport, { ...CREDENTIALS, access: 'qianwen-access-token-2' }, 'cache-access-change')
    const generateCalls = fake.calls.filter((call) => actionOf(call) === GENERATE)
    expect(generateCalls).toHaveLength(2)
    expect(generateCalls[1]!.authorization).toBe('Bearer qianwen-access-token-2')
  })

  test('Given access token 已过期 When 查询 Then 零请求并提示重新登录', async () => {
    const fake = createQuotaTransport(defaultHandler)
    const result = await query(fake.transport, { ...CREDENTIALS, expires: NOW - 1_000 }, 'expired-1')
    expect(fake.calls).toHaveLength(0)
    expect(result.supported).toBe(false)
    expect(result.message).toBe('千问登录已过期，请重新登录')
  })

  test('Given 个人无有效订阅但团队成功 When 查询 Then 只返回团队窗口且不生成空个人窗口', async () => {
    const fake = createQuotaTransport((call) => {
      const action = actionOf(call)
      if (action === QIANWEN_SOLO_SUBSCRIPTION_API) return jsonResponse(csData({ status: 'EXPIRED' }))
      return defaultHandler(call)
    })
    const result = await query(fake.transport, CREDENTIALS, 'solo-none-team-ok')

    expect(result.supported).toBe(true)
    expect(result.planName).toBe('千问 Token Plan 团队版')
    expect(labels(result.windows)).toEqual(['团队 Max'])
    expect(result.message).toBeUndefined()
  })

  test('Given 个人查询失败但团队成功 When 查询 Then 保留团队窗口并提示部分不可用', async () => {
    const fake = createQuotaTransport((call) => {
      if (actionOf(call) === QIANWEN_SOLO_USAGE_API) return jsonResponse({ broken: true }, 500)
      return defaultHandler(call)
    })
    const result = await query(fake.transport, CREDENTIALS, 'solo-fail-team-ok')

    expect(result.supported).toBe(true)
    expect(labels(result.windows)).toEqual(['团队 Max'])
    expect(result.message).toBe('部分千问额度暂不可用')
  })

  test('Given 团队查询失败但个人成功 When 查询 Then 保留个人窗口并提示部分不可用', async () => {
    const fake = createQuotaTransport((call) => {
      if (actionOf(call) === TEAM_ACTION) return jsonResponse({ message: 'boom' }, 502)
      return defaultHandler(call)
    })
    const result = await query(fake.transport, CREDENTIALS, 'team-fail-solo-ok')

    expect(result.supported).toBe(true)
    expect(labels(result.windows)).toEqual(['个人版本月'])
    expect(result.message).toBe('部分千问额度暂不可用')
  })

  test('Given 团队业务失败但个人成功 When 查询 Then 保留个人窗口并提示部分不可用', async () => {
    const fake = createQuotaTransport((call) => {
      if (actionOf(call) === TEAM_ACTION) return jsonResponse({ Success: false, Code: 'Failed' })
      return defaultHandler(call)
    })
    const result = await query(fake.transport, CREDENTIALS, 'team-business-fail')

    expect(result.supported).toBe(true)
    expect(labels(result.windows)).toEqual(['个人版本月'])
    expect(result.message).toBe('部分千问额度暂不可用')
  })

  test('Given 团队部分席位组无法解析 When 查询 Then 保留合法组并提示部分不可用', async () => {
    const fake = createQuotaTransport((call) => {
      if (actionOf(call) === TEAM_ACTION) {
        return jsonResponse(teamBody([teamGroup('standard'), teamGroup('pro', { EquityList: [] })]))
      }
      return defaultHandler(call)
    })
    const result = await query(fake.transport, CREDENTIALS, 'team-partial-groups')

    expect(labels(result.windows)).toEqual(['个人版本月', '团队 Standard'])
    expect(result.message).toBe('部分千问额度暂不可用')
  })

  test('Given 两个版本都失败 When 查询 Then 返回不可用与固定脱敏文案', async () => {
    const fake = createQuotaTransport((call) => {
      if (actionOf(call) === QIANWEN_SOLO_USAGE_API) return jsonResponse({}, 500)
      if (actionOf(call) === TEAM_ACTION) return jsonResponse({}, 503)
      return defaultHandler(call)
    })
    const result = await query(fake.transport, CREDENTIALS, 'both-fail')

    expect(result.supported).toBe(false)
    expect(result.windows).toEqual([])
    expect(result.message).toBe('千问额度查询失败，请检查网络或代理后重试')
    expect(fake.closeCount()).toBe(1)
  })

  test('Given 两版本都未订阅 When 查询 Then 返回未订阅原因', async () => {
    const fake = createQuotaTransport((call) => {
      const action = actionOf(call)
      if (action === QIANWEN_SOLO_SUBSCRIPTION_API) return jsonResponse(csData({ status: 'EXPIRED' }))
      if (action === TEAM_ACTION) return jsonResponse(teamBody([]))
      return defaultHandler(call)
    })
    const result = await query(fake.transport, CREDENTIALS, 'not-subscribed')

    expect(result.supported).toBe(false)
    expect(result.message).toBe('当前千问账号未订阅 Token Plan 个人版或团队版')
  })
})

describe('千问额度查询：异常与凭证缓存', () => {
  const notLoginedBody = {
    code: '200',
    successResponse: true,
    data: { success: false, errorCode: 'BailianGateway.Login.NotLogined' },
  }

  test('Given 缓存派生凭证被上游判定未登录 When 查询 Then 重签一次并重试成功', async () => {
    let generateCount = 0
    let rejectCachedToken = false
    const fake = createQuotaTransport((call) => {
      const action = actionOf(call)
      if (action === GENERATE) {
        generateCount += 1
        return generateResponse(`cli-token-${generateCount}`)
      }
      if (action === QIANWEN_SOLO_SUBSCRIPTION_API || action === QIANWEN_SOLO_USAGE_API) {
        if (rejectCachedToken && call.authorization === 'Bearer cli-token-1') {
          return jsonResponse(notLoginedBody)
        }
        return action === QIANWEN_SOLO_SUBSCRIPTION_API ? jsonResponse(soloSubscription()) : jsonResponse(soloUsage())
      }
      return jsonResponse(teamBody([teamGroup('max')]))
    })

    // 首次查询把 cli-token-1 写入缓存。
    await expect(query(fake.transport, CREDENTIALS, 'reauth-cached')).resolves.toMatchObject({ supported: true })
    rejectCachedToken = true

    const result = await query(fake.transport, CREDENTIALS, 'reauth-cached')
    expect(result.supported).toBe(true)
    expect(result.message).toBeUndefined()

    const actions = fake.calls.map(actionOf)
    expect(actions.filter((action) => action === GENERATE)).toHaveLength(2)
    // 缓存 token 一次 + 重签后重试一次，共三次业务请求。
    expect(actions.filter((action) => action === QIANWEN_SOLO_SUBSCRIPTION_API)).toHaveLength(3)
    expect(actions.filter((action) => action === QIANWEN_SOLO_USAGE_API)).toHaveLength(3)
    expect(fake.calls.filter((call) => actionOf(call) === QIANWEN_SOLO_SUBSCRIPTION_API).at(-1)!.authorization)
      .toBe('Bearer cli-token-2')
  })

  test('Given 新签发凭证首次即被判定未登录 When 查询 Then 不重签直接提示重新登录', async () => {
    const fake = createQuotaTransport((call) => {
      const action = actionOf(call)
      if (action === GENERATE) return generateResponse('fresh-token')
      if (action === QIANWEN_SOLO_SUBSCRIPTION_API || action === QIANWEN_SOLO_USAGE_API) {
        return jsonResponse(notLoginedBody)
      }
      return jsonResponse(teamBody([]))
    })

    const result = await query(fake.transport, CREDENTIALS, 'fresh-not-logined')
    expect(result.supported).toBe(false)
    expect(result.message).toBe('千问登录已失效，请重新登录')
    expect(fake.calls.filter((call) => actionOf(call) === GENERATE)).toHaveLength(1)
    expect(fake.calls.filter((call) => actionOf(call) === QIANWEN_SOLO_SUBSCRIPTION_API)).toHaveLength(1)
  })

  test('Given 重签后仍判定未登录 When 查询 Then 最多重签一次并返回重新登录提示', async () => {
    let generateCount = 0
    let rejectAll = false
    const fake = createQuotaTransport((call) => {
      const action = actionOf(call)
      if (action === GENERATE) {
        generateCount += 1
        return generateResponse(`cli-token-${generateCount}`)
      }
      if (action === QIANWEN_SOLO_SUBSCRIPTION_API || action === QIANWEN_SOLO_USAGE_API) {
        if (rejectAll) return jsonResponse(notLoginedBody)
        return action === QIANWEN_SOLO_SUBSCRIPTION_API ? jsonResponse(soloSubscription()) : jsonResponse(soloUsage())
      }
      return jsonResponse(teamBody([]))
    })

    // 首次查询把 cli-token-1 写入缓存。
    await query(fake.transport, CREDENTIALS, 'reauth-exhausted')
    rejectAll = true

    const result = await query(fake.transport, CREDENTIALS, 'reauth-exhausted')
    const actions = fake.calls.map(actionOf)
    // 首次签发 + 缓存失效后的重签，共两次；不会为了新签发的失败凭证再签第三次。
    expect(actions.filter((action) => action === GENERATE)).toHaveLength(2)
    expect(result.supported).toBe(false)
    expect(result.message).toBe('千问登录已失效，请重新登录')
  })

  test('Given 限流 When 两版本都 429 Then 提示稍后重试', async () => {
    const fake = createQuotaTransport((call) => {
      if (actionOf(call) === GENERATE) return generateResponse('cli-token')
      return jsonResponse({ message: 'rate limited' }, 429)
    })
    const result = await query(fake.transport, CREDENTIALS, 'rate-limited')
    expect(result.supported).toBe(false)
    expect(result.message).toBe('千问额度查询过于频繁，请稍后重试')
  })

  test('Given 认证失败 When 两版本都 401 Then 优先提示重新登录', async () => {
    const fake = createQuotaTransport((call) => {
      if (actionOf(call) === GENERATE) return generateResponse('cli-token')
      return jsonResponse({ message: 'unauthorized' }, 401)
    })
    const result = await query(fake.transport, CREDENTIALS, 'auth-failed')
    expect(result.message).toBe('千问登录已失效，请重新登录')
  })

  test('Given 响应非法 JSON When 查询 Then 返回脱敏格式错误且不泄露正文', async () => {
    const fake = createQuotaTransport(() => new Response('{secret-access-token', { status: 200 }))
    const result = await query(fake.transport, CREDENTIALS, 'invalid-json')
    expect(result.supported).toBe(false)
    expect(result.message).not.toContain('secret-access-token')
    expect(result.message).toBe('千问额度查询失败，请稍后重试')
  })

  test('Given 请求超时 When 查询 Then 提示检查网络或代理', async () => {
    const fake = createQuotaTransport(() => {
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      throw error
    })
    const result = await query(fake.transport, CREDENTIALS, 'timeout')
    expect(result.message).toBe('千问额度查询失败，请检查网络或代理后重试')
    expect(fake.closeCount()).toBe(1)
  })

  test('Given 所有失败路径 When 收集消息 Then 不包含 access token、派生凭证或代理地址', async () => {
    const secret = 'qianwen-access-token'
    const fake = createQuotaTransport((call) => {
      if (actionOf(call) === GENERATE) {
        return jsonResponse({ code: '500', successResponse: false, data: { success: false }, echo: secret })
      }
      return jsonResponse({ echo: secret }, 500)
    })
    const result = await query(fake.transport, CREDENTIALS, 'no-leak')
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('cli-access-token')
    expect(serialized).not.toContain('127.0.0.1')
  })

  test('Given 渠道 provider 是 OpenAI 兼容千问 When 查询 Then provider 原样保留', async () => {
    const fake = createQuotaTransport(defaultHandler)
    const result = await queryQianwenPlanQuota(
      'openai-provider',
      'qianwen-token-plan-openai',
      CREDENTIALS,
      undefined,
      (() => fake.transport) as unknown as typeof import('./proxy-fetch').createManagedProxyFetch,
    )
    expect(result.provider).toBe('qianwen-token-plan-openai')
    expect(result.supported).toBe(true)
  })

  test('Given GenerateCLIAccessToken 返回 ConsoleNeedLogin When 查询 Then 映射为认证失效', async () => {
    const fake = createQuotaTransport((call) => {
      if (actionOf(call) === GENERATE) return jsonResponse({ code: 'ConsoleNeedLogin', message: 'login required' })
      if (actionOf(call) === TEAM_ACTION) return jsonResponse({ Code: 'ConsoleNeedLogin' })
      return jsonResponse({}, 500)
    })
    const result = await query(fake.transport, CREDENTIALS, 'console-need-login')

    expect(result.supported).toBe(false)
    expect(result.message).toBe('千问登录已失效，请重新登录')
    // 认证失败不重签，也不重试业务接口。
    expect(fake.calls.filter((call) => actionOf(call) === GENERATE)).toHaveLength(1)
  })

  test('Given 团队响应是 ConsoleNeedLogin 但个人成功 When 查询 Then 保留个人窗口并提示部分不可用', async () => {
    const fake = createQuotaTransport((call) => {
      if (actionOf(call) === TEAM_ACTION) return jsonResponse({ Code: 'ConsoleNeedLogin' })
      return defaultHandler(call)
    })
    const result = await query(fake.transport, CREDENTIALS, 'team-console-need-login')

    expect(result.supported).toBe(true)
    expect(labels(result.windows)).toEqual(['个人版本月'])
    expect(result.message).toBe('部分千问额度暂不可用')
  })

  test('Given 在途签发完成前渠道缓存被清除 When 查询结束 Then 旧结果不复活缓存', async () => {
    let pendingResolve: ((response: Response) => void) | undefined
    let generateCount = 0
    const fake = createQuotaTransport((call) => {
      const action = actionOf(call)
      if (action === GENERATE) {
        generateCount += 1
        if (generateCount === 1) {
          return new Promise<Response>((resolve) => { pendingResolve = resolve })
        }
        return generateResponse('second-token')
      }
      if (action === QIANWEN_SOLO_SUBSCRIPTION_API) return jsonResponse(soloSubscription())
      if (action === QIANWEN_SOLO_USAGE_API) return jsonResponse(soloUsage())
      return jsonResponse(teamBody([teamGroup('max')]))
    })

    const first = query(fake.transport, CREDENTIALS, 'race-delete')
    await Bun.sleep(0)
    expect(pendingResolve).toBeDefined()

    invalidateQianwenDerivedToken('race-delete')
    pendingResolve!(generateResponse('late-token'))
    await expect(first).resolves.toMatchObject({ supported: true })

    // 在途结果不得复活缓存：下一次查询必须重新签发。
    await query(fake.transport, CREDENTIALS, 'race-delete')
    expect(fake.calls.filter((call) => actionOf(call) === GENERATE)).toHaveLength(2)
    expect(fake.calls.filter((call) => actionOf(call) === QIANWEN_SOLO_SUBSCRIPTION_API).at(-1)!.authorization)
      .toBe('Bearer second-token')
  })

  test('Given 旧 access 的签发晚于新 access 完成 When 再次查询 Then 不覆盖新凭证', async () => {
    let resolveOld: ((response: Response) => void) | undefined
    const fake = createQuotaTransport((call) => {
      const action = actionOf(call)
      if (action === GENERATE) {
        if (call.authorization === 'Bearer access-old') {
          return new Promise<Response>((resolve) => { resolveOld = resolve })
        }
        return generateResponse('token-new')
      }
      if (action === QIANWEN_SOLO_SUBSCRIPTION_API) return jsonResponse(soloSubscription())
      if (action === QIANWEN_SOLO_USAGE_API) return jsonResponse(soloUsage())
      return jsonResponse(teamBody([teamGroup('max')]))
    })

    const oldQuery = query(fake.transport, { ...CREDENTIALS, access: 'access-old' }, 'race-access')
    await Bun.sleep(0)
    expect(resolveOld).toBeDefined()

    const newQuery = query(fake.transport, { ...CREDENTIALS, access: 'access-new' }, 'race-access')
    await newQuery

    resolveOld!(generateResponse('token-old'))
    await oldQuery

    // 旧 access 的晚到结果不能覆盖新 access 的缓存。
    await query(fake.transport, { ...CREDENTIALS, access: 'access-new' }, 'race-access')
    expect(fake.calls.filter((call) => actionOf(call) === GENERATE)).toHaveLength(2)
    expect(fake.calls.filter((call) => actionOf(call) === QIANWEN_SOLO_SUBSCRIPTION_API).at(-1)!.authorization)
      .toBe('Bearer token-new')
  })

  test('Given 显式失效派生凭证 When 再次查询 Then 重新 Generate', async () => {
    const fake = createQuotaTransport(defaultHandler)
    await query(fake.transport, CREDENTIALS, 'invalidate-channel')
    expect(fake.calls.filter((call) => actionOf(call) === GENERATE)).toHaveLength(1)

    invalidateQianwenDerivedToken('invalidate-channel')

    await query(fake.transport, CREDENTIALS, 'invalidate-channel')
    expect(fake.calls.filter((call) => actionOf(call) === GENERATE)).toHaveLength(2)
  })

  test('Given flat 派生凭证裹在一层 Data 里 When 查询 Then 仍能读取', async () => {
    const fake = createQuotaTransport((call) => {
      if (actionOf(call) === GENERATE) {
        return jsonResponse({ code: '200', successResponse: true, data: { cliAccessToken: 'cli-access-token-1' } })
      }
      return defaultHandler(call)
    })
    const result = await query(fake.transport, CREDENTIALS, 'wrapped-generate')
    expect(result.supported).toBe(true)
    expect(fake.calls.find((call) => actionOf(call) === QIANWEN_SOLO_USAGE_API)!.authorization)
      .toBe('Bearer cli-access-token-1')
  })
})
