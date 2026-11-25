import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as os from 'node:os'
import { join } from 'node:path'

/**
 * 千问 device-code 登录的行为契约。
 *
 * 全部通过注入的 transport / sleep / clock 运行：测试永不访问真实授权服务，
 * 也不使用真实定时器等待轮询间隔。
 */

let tempHome = ''
const originalHome = process.env.HOME
// Windows 的 os.homedir() 优先读 USERPROFILE：只设 HOME 会让夹具落到真实用户目录。
const originalUserProfile = process.env.USERPROFILE
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => tempHome },
  shell: { openExternal: async () => undefined },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

const getEffectiveProxyUrl = mock<() => Promise<string | undefined>>(async () => undefined)
mock.module('./proxy-settings-service', () => ({ getEffectiveProxyUrl }))

// 固定「当前时间」，避免测试依赖真实时钟。
const NOW = Date.UTC(2026, 10, 22, 4, 0, 0)

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

interface FakeTransport {
  transport: { fetch: typeof globalThis.fetch; close: () => Promise<void> }
  calls: FetchCall[]
  closeCount: () => number
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createTransport(handler: (call: FetchCall, index: number) => Response | Promise<Response>): FakeTransport {
  const calls: FetchCall[] = []
  let closed = 0
  return {
    transport: {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const call: FetchCall = { url: String(input), init }
        calls.push(call)
        return handler(call, calls.length - 1)
      }) as unknown as typeof globalThis.fetch,
      close: async () => { closed += 1 },
    },
    calls,
    closeCount: () => closed,
  }
}

/** 官方 postDeviceCode 真实结构：Success + Data.{Token,VerificationUrl,ExpiresIn,Interval}。 */
const DEVICE_CODE_BODY = {
  Success: true,
  Data: {
    Token: 'device-token-abc',
    VerificationUrl: 'https://account.qianwenai.com/device?user_code=ABCD-EFGH',
    ExpiresIn: 300,
    Interval: 2,
  },
}

/** 旧式字段名（DeviceCode / VerificationUri）仅作为兼容性验证。 */
const LEGACY_DEVICE_CODE_BODY = {
  Success: true,
  Data: {
    DeviceCode: 'device-token-abc',
    VerificationUri: 'https://account.qianwenai.com/device?user_code=ABCD-EFGH',
    ExpiresIn: 300,
    Interval: 2,
  },
}

/** 官方 postDeviceToken 真实结构：Data.{Status, Credentials}。 */
const SUCCESS_BODY = {
  Success: true,
  Data: {
    Status: 'complete',
    Credentials: {
      AccessToken: 'access-token-xyz',
      ExpireTime: '2026-11-23T12:00:00+08:00',
      User: { AliyunId: 'aliyun-uid-1' },
    },
  },
}

const PENDING_BODY = { Success: true, Data: { Status: 'authorization_pending' } }

type OAuthService = typeof import('./qianwen-oauth-service')

let oauth: OAuthService
let now = NOW
let slept: number[] = []
let sleepImpl: (ms: number, signal: AbortSignal) => Promise<void>
let opened: string[]
let deviceCodes: { verificationUri: string }[]

function baseDependencies(transport: FakeTransport['transport']) {
  return {
    createTransport: (() => transport) as unknown as typeof import('./proxy-fetch').createManagedProxyFetch,
    sleep: (ms: number, signal: AbortSignal) => {
      slept.push(ms)
      return sleepImpl(ms, signal)
    },
    openExternal: async (url: string) => { opened.push(url) },
    now: () => now,
  }
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-qianwen-oauth-'))
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome
  process.env.PROMA_DEV = '0'
  // 全量混跑时 config-paths 可能已被更早的文件加载并缓存真实数据根，必须先重置。
  const { resetConfigDirCacheForTests } = await import('./config-paths')
  resetConfigDirCacheForTests()
  mkdirSync(join(tempHome, '.proma'), { recursive: true })
  oauth = await import('./qianwen-oauth-service')
})

beforeEach(() => {
  rmSync(join(tempHome, '.proma'), { recursive: true, force: true })
  mkdirSync(join(tempHome, '.proma'), { recursive: true })
  getEffectiveProxyUrl.mockReset()
  getEffectiveProxyUrl.mockResolvedValue(undefined)
  now = NOW
  slept = []
  sleepImpl = async () => undefined
  opened = []
  deviceCodes = []
})

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
  // 先恢复环境再重置缓存，避免本文件的 tempHome 反向污染后续文件。
  const { resetConfigDirCacheForTests } = await import('./config-paths')
  resetConfigDirCacheForTests()
  rmSync(tempHome, { recursive: true, force: true })
})

function runLogin(transport: FakeTransport['transport']) {
  return oauth.loginQianwenOAuth(
    { onDeviceCode: (deviceCode) => deviceCodes.push(deviceCode) },
    baseDependencies(transport),
  )
}

describe('千问 device-code 登录：成功路径', () => {
  test('Given 首次 pending 后授权成功 When 登录 Then 返回凭据并发送合规的授权请求', async () => {
    const fake = createTransport((_call, index) => {
      if (index === 0) return jsonResponse(DEVICE_CODE_BODY)
      if (index === 1) return jsonResponse(PENDING_BODY)
      return jsonResponse(SUCCESS_BODY)
    })

    const credentials = await runLogin(fake.transport)

    expect(credentials).toEqual({ access: 'access-token-xyz', expires: Date.parse('2026-11-23T12:00:00+08:00'), accountId: 'aliyun-uid-1' })
    expect(fake.calls).toHaveLength(3)
    expect(fake.closeCount()).toBe(1)
    expect(slept).toEqual([2_000, 2_000])

    const deviceUrl = new URL(fake.calls[0]!.url)
    expect(deviceUrl.origin).toBe('https://t.qianwenai.com')
    expect(deviceUrl.pathname).toBe('/cli/device/code')
    expect(deviceUrl.searchParams.get('code_challenge_method')).toBe('S256')
    const clientId = deviceUrl.searchParams.get('client_id')
    expect(clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const challenge = deviceUrl.searchParams.get('code_challenge')
    expect(challenge).toBeTruthy()

    const tokenUrl = new URL(fake.calls[2]!.url)
    expect(tokenUrl.pathname).toBe('/cli/device/token')
    expect(tokenUrl.searchParams.get('client_id')).toBe(clientId!)
    expect(tokenUrl.searchParams.get('token')).toBe('device-token-abc')
    const verifier = tokenUrl.searchParams.get('code_verifier')!
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge!)

    for (const call of fake.calls) {
      const headers = call.init?.headers as Record<string, string>
      expect(headers['User-Agent']).toBe('qianwen-cli/1.12.0')
      expect(call.init?.method).toBe('POST')
      expect(call.init?.redirect).toBe('error')
    }

    expect(deviceCodes).toEqual([{ verificationUri: 'https://account.qianwenai.com/device?user_code=ABCD-EFGH' }])
    expect(opened).toEqual(['https://account.qianwenai.com/device?user_code=ABCD-EFGH'])
  })

  test('Given 上游响应带 RefreshToken When 登录成功 Then 凭据不包含 refresh 且不声称可续期', async () => {
    const fake = createTransport((_call, index) => {
      if (index === 0) return jsonResponse(DEVICE_CODE_BODY)
      return jsonResponse({
        Success: true,
        Data: {
          Status: 'complete',
          Credentials: { ...SUCCESS_BODY.Data.Credentials, RefreshToken: 'refresh-should-not-persist' },
        },
      })
    })

    const credentials = await runLogin(fake.transport)
    expect(credentials).toEqual({ access: 'access-token-xyz', expires: Date.parse('2026-11-23T12:00:00+08:00'), accountId: 'aliyun-uid-1' })
    expect(JSON.stringify(credentials)).not.toContain('refresh')
  })

  test('Given 同一配置目录 When 两次登录 Then 复用同一个 client_id 并写入设备标识文件', async () => {
    const fakeA = createTransport((_call, index) => index === 0 ? jsonResponse(DEVICE_CODE_BODY) : jsonResponse(SUCCESS_BODY))
    await runLogin(fakeA.transport)
    const fakeB = createTransport((_call, index) => index === 0 ? jsonResponse(DEVICE_CODE_BODY) : jsonResponse(SUCCESS_BODY))
    await runLogin(fakeB.transport)

    const first = new URL(fakeA.calls[0]!.url).searchParams.get('client_id')
    const second = new URL(fakeB.calls[0]!.url).searchParams.get('client_id')
    expect(second).toBe(first!)

    const stored = JSON.parse(readFileSync(join(tempHome, '.proma', 'qianwen-device.json'), 'utf-8')) as { clientId: string }
    expect(stored.clientId).toBe(first!)
  })

  test('Given 设备标识文件损坏 When 登录 Then 重建为合法 UUID', () => {
    writeFileSync(join(tempHome, '.proma', 'qianwen-device.json'), '{"clientId":"not-a-uuid"}', 'utf-8')
    const clientId = oauth.readOrCreateQianwenClientId(join(tempHome, '.proma'))
    expect(clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const stored = JSON.parse(readFileSync(join(tempHome, '.proma', 'qianwen-device.json'), 'utf-8')) as { clientId: string }
    expect(stored.clientId).toBe(clientId)
  })
})

describe('千问 device-code 登录：轮询策略', () => {
  test('Given slow_down When 继续轮询 Then 后续间隔从 2 秒增加到 7 秒', async () => {
    const fake = createTransport((_call, index) => {
      if (index === 0) return jsonResponse(DEVICE_CODE_BODY)
      if (index === 1) return jsonResponse({ Success: true, Data: { Status: 'slow_down' } })
      return jsonResponse(SUCCESS_BODY)
    })

    await runLogin(fake.transport)
    expect(slept).toEqual([2_000, 7_000])
  })

  test('Given HTTP 429 When 轮询 Then 按 slow_down 退避而不是直接失败', async () => {
    const fake = createTransport((_call, index) => {
      if (index === 0) return jsonResponse(DEVICE_CODE_BODY)
      if (index === 1) return jsonResponse({ message: 'too many requests' }, 429)
      return jsonResponse(SUCCESS_BODY)
    })

    await runLogin(fake.transport)
    expect(slept).toEqual([2_000, 7_000])
  })

  test('Given access_denied When 轮询 Then 返回脱敏拒绝文案并关闭 transport', async () => {
    const fake = createTransport((_call, index) => {
      if (index === 0) return jsonResponse(DEVICE_CODE_BODY)
      return jsonResponse({ Success: true, Data: { Status: 'access_denied' } })
    })

    await expect(runLogin(fake.transport)).rejects.toThrow('千问授权已被拒绝或取消')
    expect(fake.closeCount()).toBe(1)
  })

  test('Given expired_token When 轮询 Then 提示重新登录', async () => {
    const fake = createTransport((_call, index) => {
      if (index === 0) return jsonResponse(DEVICE_CODE_BODY)
      return jsonResponse({ Success: true, Data: { Status: 'expired_token' } })
    })

    await expect(runLogin(fake.transport)).rejects.toThrow('千问授权已过期，请重新登录')
  })

  test('Given 超过 ExpiresIn 仍未授权 When 轮询 Then 超时停止且不再请求 token', async () => {
    const fake = createTransport((_call, index) => {
      if (index === 0) return jsonResponse({ ...DEVICE_CODE_BODY, Data: { ...DEVICE_CODE_BODY.Data, ExpiresIn: 5 } })
      return jsonResponse(PENDING_BODY)
    })
    sleepImpl = async () => { now += 6_000 }

    await expect(runLogin(fake.transport)).rejects.toThrow('千问授权已超时，请重新登录')
    expect(fake.calls).toHaveLength(1)
    expect(fake.closeCount()).toBe(1)
  })
})

describe('千问 device-code 登录：异常与取消', () => {
  test('Given 非法 ExpireTime When 轮询成功 Then 拒绝伪造过期时间', async () => {
    const fake = createTransport((_call, index) => {
      if (index === 0) return jsonResponse(DEVICE_CODE_BODY)
      return jsonResponse({
        Success: true,
        Data: { Status: 'complete', Credentials: { AccessToken: 'access-token-xyz', ExpireTime: '2026-11-23 12:00:00' } },
      })
    })

    await expect(runLogin(fake.transport)).rejects.toThrow('千问授权响应缺少有效的过期时间')
  })

  test('Given 已过期的 ExpireTime When 轮询成功 Then 视为无效响应', async () => {
    const fake = createTransport((_call, index) => {
      if (index === 0) return jsonResponse(DEVICE_CODE_BODY)
      return jsonResponse({
        Success: true,
        Data: { Status: 'complete', Credentials: { AccessToken: 'access-token-xyz', ExpireTime: '2020-01-01T00:00:00Z' } },
      })
    })

    await expect(runLogin(fake.transport)).rejects.toThrow('千问授权响应缺少有效的过期时间')
  })

  test('Given 授权地址不在受信任域名 When 处理 device code Then 不打开浏览器', async () => {
    const fake = createTransport(() => jsonResponse({
      Success: true,
      Data: { Token: 'device-token-abc', VerificationUrl: 'https://evil.example.com/device', ExpiresIn: 300, Interval: 2 },
    }))

    await expect(runLogin(fake.transport)).rejects.toThrow('千问授权地址不在受信任域名下，已取消登录')
    expect(opened).toEqual([])
    expect(fake.closeCount()).toBe(1)
  })

  test('Given 旧式 DeviceCode/VerificationUri 字段 When 登录 Then 仍然兼容', async () => {
    const fake = createTransport((_call, index) => {
      if (index === 0) return jsonResponse(LEGACY_DEVICE_CODE_BODY)
      return jsonResponse(SUCCESS_BODY)
    })

    await expect(runLogin(fake.transport)).resolves.toMatchObject({ access: 'access-token-xyz' })
    expect(opened).toEqual(['https://account.qianwenai.com/device?user_code=ABCD-EFGH'])
  })

  test('Given 响应只有其他字段里的千问 URL When 解析设备码 Then 不把任意 URL 当作授权地址', async () => {
    const fake = createTransport(() => jsonResponse({
      Success: true,
      Data: {
        Token: 'device-token-abc',
        HelpUrl: 'https://account.qianwenai.com/help',
        ExpiresIn: 300,
        Interval: 2,
      },
    }))

    await expect(runLogin(fake.transport)).rejects.toThrow('千问授权服务未返回有效的设备码')
    expect(opened).toEqual([])
    expect(fake.closeCount()).toBe(1)
  })

  test('Given 设备标识写入失败 When 登录 Then 返回固定文案且不泄露本地路径', async () => {
    // 把配置目录换成同名文件，让 clientId 落盘不可预期地失败（ENOTDIR）。
    rmSync(join(tempHome, '.proma'), { recursive: true, force: true })
    writeFileSync(join(tempHome, '.proma'), 'not-a-directory', 'utf-8')

    const fake = createTransport(() => jsonResponse(DEVICE_CODE_BODY))
    let message = ''
    try {
      await runLogin(fake.transport)
      throw new Error('expected login to fail')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toBe('千问授权失败，请稍后重试')
    expect(message).not.toContain(tempHome)
    expect(message).not.toContain('.proma')
    expect(fake.calls).toHaveLength(0)
  })

  test('Given 用户取消 When 已收到 device code Then 不再请求 token 并关闭 transport', async () => {
    const fake = createTransport((_call, index) => {
      if (index === 0) return jsonResponse(DEVICE_CODE_BODY)
      return jsonResponse(SUCCESS_BODY)
    })

    const login = oauth.loginQianwenOAuth(
      { onDeviceCode: () => oauth.cancelQianwenOAuthLogin() },
      baseDependencies(fake.transport),
    )

    await expect(login).rejects.toThrow('千问登录已取消')
    expect(fake.calls).toHaveLength(1)
    expect(fake.closeCount()).toBe(1)
  })

  test('Given 正在轮询 When 发起新登录 Then 旧登录被中止且新登录独立完成', async () => {
    let gateResolve: (() => void) | undefined
    let gateSleepCalls = 0
    sleepImpl = async (_ms, signal) => {
      gateSleepCalls += 1
      if (gateSleepCalls > 1) return
      await new Promise<void>((resolve, reject) => {
        gateResolve = resolve
        signal.addEventListener('abort', () => reject(new Error('千问登录已取消')), { once: true })
      })
    }

    const firstTransport = createTransport((_call, index) => index === 0 ? jsonResponse(DEVICE_CODE_BODY) : jsonResponse(SUCCESS_BODY))
    const first = runLogin(firstTransport.transport)
    // 等待第一次登录进入 sleep。
    await Bun.sleep(0)
    expect(gateResolve).toBeDefined()

    const secondTransport = createTransport((_call, index) => index === 0 ? jsonResponse(DEVICE_CODE_BODY) : jsonResponse(SUCCESS_BODY))
    const second = runLogin(secondTransport.transport)

    await expect(first).rejects.toThrow('千问登录已取消')
    await expect(second).resolves.toMatchObject({ access: 'access-token-xyz' })
    expect(firstTransport.calls).toHaveLength(1)
    expect(firstTransport.closeCount()).toBe(1)
    expect(secondTransport.closeCount()).toBe(1)
  })

  test('Given 响应为空或非法 JSON When 登录 Then 返回固定文案且不泄露响应内容', async () => {
    const empty = createTransport(() => new Response('', { status: 200 }))
    await expect(runLogin(empty.transport)).rejects.toThrow('千问授权服务返回空响应')
    expect(empty.closeCount()).toBe(1)

    const broken = createTransport(() => new Response('{not-json', { status: 200 }))
    await expect(runLogin(broken.transport)).rejects.toThrow('千问授权服务响应格式错误')
    expect(broken.closeCount()).toBe(1)
  })

  test('Given 网络异常 When 登录 Then 错误不包含 URL、verifier 或代理地址', async () => {
    getEffectiveProxyUrl.mockResolvedValue('http://127.0.0.1:7890')
    const fake = createTransport(() => {
      throw new TypeError('fetch failed: https://t.qianwenai.com/cli/device/code?code_verifier=secret-verifier')
    })

    let message = ''
    try {
      await runLogin(fake.transport)
      throw new Error('expected login to fail')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toBe('千问登录请求失败，请检查网络或代理后重试')
    expect(message).not.toContain('secret-verifier')
    expect(message).not.toContain('t.qianwenai.com')
    expect(message).not.toContain('7890')
    expect(fake.closeCount()).toBe(1)
  })

  test('Given 请求超时 When 登录 Then 使用固定超时文案', async () => {
    const fake = createTransport(() => {
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      throw error
    })

    await expect(runLogin(fake.transport)).rejects.toThrow('千问授权请求超时，请检查网络或代理后重试')
    expect(fake.closeCount()).toBe(1)
  })
})

describe('千问授权路由校验', () => {
  test('Given 受信任与非受信任地址 When 校验 Then 只接受 account.qianwenai.com 的 HTTPS 默认端口', async () => {
    const routes = await import('./qianwen-api-routes')
    expect(routes.isQianwenVerificationUri('https://account.qianwenai.com/device')).toBe(true)
    expect(routes.isQianwenVerificationUri('https://account.qianwenai.com:8443/device')).toBe(false)
    expect(routes.isQianwenVerificationUri('http://account.qianwenai.com/device')).toBe(false)
    expect(routes.isQianwenVerificationUri('https://account.qianwenai.com.evil.com/device')).toBe(false)
    expect(routes.isQianwenVerificationUri('https://evil-account.qianwenai.com/device')).toBe(false)
    expect(routes.isQianwenVerificationUri('not a url')).toBe(false)
  })
})
