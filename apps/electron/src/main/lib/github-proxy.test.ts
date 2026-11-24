import { describe, expect, test } from 'bun:test'
import {
  GITHUB_API_PROXY_MIRRORS,
  GITHUB_FILE_PROXY_MIRRORS,
  isMissingFeedErrorMessage,
  isNetworkErrorMessage,
  proxiedGitHubUrl,
  proxiedReleaseFeedUrl,
} from './github-proxy'

describe('代理 URL 构造', () => {
  test('Given 镜像与 GitHub URL When 拼接 Then 镜像在前且保留完整 https 路径', () => {
    expect(proxiedGitHubUrl('https://gh-proxy.com/', 'https://api.github.com/repos/wdhash119/Proma/releases/latest'))
      .toBe('https://gh-proxy.com/https://api.github.com/repos/wdhash119/Proma/releases/latest')
  })

  test('Given 镜像与仓库 tag When 构造 feed Then 得到带 tag 的 download 目录', () => {
    expect(proxiedReleaseFeedUrl('https://ghfast.top/', 'wdhash119', 'Proma', 'v0.19.148'))
      .toBe('https://ghfast.top/https://github.com/wdhash119/Proma/releases/download/v0.19.148')
  })

  test('Given 镜像清单 When 检查 Then 文件镜像与 API 镜像分离且都以 / 结尾', () => {
    expect(GITHUB_FILE_PROXY_MIRRORS.length).toBeGreaterThan(0)
    expect(GITHUB_API_PROXY_MIRRORS.length).toBeGreaterThan(0)
    for (const mirror of [...GITHUB_FILE_PROXY_MIRRORS, ...GITHUB_API_PROXY_MIRRORS]) {
      expect(mirror.endsWith('/')).toBe(true)
      expect(mirror.startsWith('https://')).toBe(true)
    }
  })
})

describe('网络错误分类', () => {
  test('Given 连接类错误 When 判定 Then 视为网络错误，值得换代理', () => {
    for (const message of [
      'net::ERR_CONNECTION_RESET',
      'net::ERR_NAME_NOT_RESOLVED',
      'getaddrinfo ENOTFOUND api.github.com',
      'read ECONNRESET',
      'connect ETIMEDOUT 140.82.112.6:443',
      'connect ECONNREFUSED 127.0.0.1:443',
      'socket hang up',
      'fetch failed',
      'The operation timed out',
      'request timedout',
      '502 Bad Gateway',
      '503 Service Unavailable',
      '504 Gateway Timeout',
    ]) {
      expect(isNetworkErrorMessage(message)).toBe(true)
    }
  })

  test('Given 真实响应错误 When 判定 Then 不算网络错误，换代理无济于事', () => {
    for (const message of [
      'GitHub API 错误: 404 Not Found',
      'Cannot find latest.yml',
      'GitHub API 限流 (403)，请稍后再试',
      '429 Too Many Requests',
      'Cannot parse update info',
    ]) {
      expect(isNetworkErrorMessage(message)).toBe(false)
    }
  })

  test('Given 缺少更新清单的错误 When 判定 Then 识别为 missing feed', () => {
    expect(isMissingFeedErrorMessage('GitHub API 错误: 404 Not Found')).toBe(true)
    expect(isMissingFeedErrorMessage('Cannot find latest.yml in release')).toBe(true)
    expect(isMissingFeedErrorMessage('net::ERR_CONNECTION_RESET')).toBe(false)
  })
})