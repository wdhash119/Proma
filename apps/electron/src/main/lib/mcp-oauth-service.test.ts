import { describe, expect, mock, test } from 'bun:test'

/**
 * MCP OAuth token 端点响应解析的行为契约。
 *
 * 重点覆盖 GitHub 的「HTTP 200 + error JSON」约定：凭据或授权码错误时响应不含
 * access_token，解析必须把提供方原始错误透出，而不是笼统报「缺少 access_token」。
 * 纯函数测试，不访问真实授权服务。
 */

mock.module('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  shell: { openExternal: async () => undefined },
}))
mock.module('./config-paths', () => ({ getMcpOAuthCredentialsPath: () => '/tmp/proma-mcp-oauth-test.json' }))
mock.module('./oauth-proxy-scope', () => ({ runWithOAuthProxyScope: <T>(fn: () => Promise<T>) => fn() }))

// 静态 import 会被提升到 mock.module 之前，导致加载真实 electron；必须在 mock 后动态加载。
const { parseOAuthTokenResponse } = await import('./mcp-oauth-service')

describe('parseOAuthTokenResponse', () => {
  test('正常令牌响应解析 access/refresh 与过期时间', () => {
    const before = Date.now()
    const tokens = parseOAuthTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 28800 })
    const after = Date.now()
    expect(tokens.accessToken).toBe('a')
    expect(tokens.refreshToken).toBe('r')
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 28800_000)
    expect(tokens.expiresAt).toBeLessThanOrEqual(after + 28800_000)
  })

  test('缺少 refresh_token 或 expires_in 非法时不产生对应字段', () => {
    const tokens = parseOAuthTokenResponse({ access_token: 'a', expires_in: 0 })
    expect(tokens.refreshToken).toBeUndefined()
    expect(tokens.expiresAt).toBeUndefined()
    expect(parseOAuthTokenResponse({ access_token: 'a', expires_in: '28800' }).expiresAt).toBeUndefined()
    expect(parseOAuthTokenResponse({ access_token: 'a', expires_in: Number.NaN }).expiresAt).toBeUndefined()
  })

  test('GitHub 200 + incorrect_client_credentials 错误体原样透出并附排查提示', () => {
    const body = {
      error: 'incorrect_client_credentials',
      error_description: 'The client_id and/or client_secret passed are incorrect.',
    }
    expect(() => parseOAuthTokenResponse(body)).toThrow('incorrect_client_credentials')
    expect(() => parseOAuthTokenResponse(body)).toThrow('client_id and/or client_secret')
    expect(() => parseOAuthTokenResponse(body)).toThrow('同一个 OAuth App')
  })

  test('仅有 error 没有 description 时仍透出错误码', () => {
    expect(() => parseOAuthTokenResponse({ error: 'bad_verification_code' })).toThrow('bad_verification_code')
  })

  test('空响应、非对象或空 access_token 报缺少 access_token', () => {
    for (const body of [null, undefined, 'ok', {}, { access_token: '' }]) {
      expect(() => parseOAuthTokenResponse(body)).toThrow('缺少 access_token')
    }
  })
})