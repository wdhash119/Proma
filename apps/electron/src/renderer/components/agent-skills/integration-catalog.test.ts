import { expect, test } from 'bun:test'
import type { McpServerEntry } from '@proma/shared'
import { MCP_INTEGRATION_CATALOG, compareCatalogConnectionCards, mergeCatalogMcpEntry, type CatalogCredentialIntegration, type CatalogMcpIntegration } from './integration-catalog'

function mcpIntegration(id: string): CatalogMcpIntegration {
  const integration = MCP_INTEGRATION_CATALOG.find((item) => item.id === id)
  if (!integration || integration.kind !== 'mcp') throw new Error(`missing mcp integration: ${id}`)
  return integration
}

function credentialIntegration(id: string): CatalogCredentialIntegration {
  const integration = MCP_INTEGRATION_CATALOG.find((item) => item.id === id)
  if (!integration || integration.kind !== 'credential') throw new Error(`missing credential integration: ${id}`)
  return integration
}

test('Given the MCP connection catalog When listing search providers Then Brave and Tavily require only their API key with official console links', () => {
  const brave = credentialIntegration('brave-search-mcp')
  const tavily = credentialIntegration('tavily-search-mcp')

  expect(brave.entry).toEqual({
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
    enabled: false,
  })
  expect(brave.credential).toMatchObject({
    envName: 'BRAVE_API_KEY',
    credentialStorageUrl: 'https://api.search.brave.com/',
    acquisitionUrl: 'https://api-dashboard.search.brave.com/app/keys',
  })

  expect(tavily.entry).toEqual({ type: 'http', url: 'https://mcp.tavily.com/mcp', enabled: false })
  expect(tavily.credential).toMatchObject({
    headerName: 'Authorization',
    valuePrefix: 'Bearer ',
    credentialStorageUrl: 'https://mcp.tavily.com/mcp',
    acquisitionUrl: 'https://app.tavily.com/home',
  })
})

test('搜索服务目录顺序固定为飞书、钉钉、企业微信、Tavily、Brave，再到其他集成', () => {
  const expected = ['feishu-cli', 'dingtalk-cli', 'wecom-cli', 'tavily-search-mcp', 'brave-search-mcp']
  const actual = [...MCP_INTEGRATION_CATALOG]
    .sort((left, right) => compareCatalogConnectionCards(
      { priority: left.priority, placement: left.placement, featured: left.featured, statusRank: 1 },
      { priority: right.priority, placement: right.placement, featured: right.featured, statusRank: 1 },
    ))
    .map((integration) => integration.id)

  expect(actual.slice(0, expected.length)).toEqual(expected)
})

test('GitHub 远程 MCP 没有动态注册，目录模板只声明需要用户自建应用的 Client Secret', () => {
  const github = mcpIntegration('github-mcp')

  expect(github.serverName).toBe('github')
  expect(github.entry.oauth?.registrationEndpoint).toBeUndefined()
  expect(github.entry.oauth?.clientId).toBeUndefined()
  expect(github.entry.oauth?.clientSecretRequired).toBe(true)
})

test('Given 工作区条目已由 Agent 写入公开 clientId When 与目录模板合并 Then 工作区的 OAuth 元数据与 url 胜出', () => {
  const github = mcpIntegration('github-mcp')
  const configured: McpServerEntry = {
    type: 'http',
    url: 'https://api.githubcopilot.com/mcp/readonly',
    enabled: false,
    oauth: { provider: 'github', clientId: 'Iv1.publicclientid0000', clientSecretRequired: true, scopes: ['repo'] },
  }

  const merged = mergeCatalogMcpEntry(github.entry, configured)

  expect(merged.url).toBe('https://api.githubcopilot.com/mcp/readonly')
  expect(merged.oauth?.clientId).toBe('Iv1.publicclientid0000')
  expect(merged.oauth?.scopes).toEqual(['repo'])
})

test('Given 工作区条目没有写 oauth When 与目录模板合并 Then 保留模板的 OAuth 元数据，不会静默跳过密钥要求', () => {
  const github = mcpIntegration('github-mcp')

  const merged = mergeCatalogMcpEntry(github.entry, { type: 'http', url: github.entry.url, enabled: true })

  expect(merged.enabled).toBe(true)
  expect(merged.oauth?.clientSecretRequired).toBe(true)
  expect(merged.oauth?.authorizationEndpoint).toBe('https://github.com/login/oauth/authorize')
})

test('Given 还没有工作区条目 When 合并 Then 原样返回目录模板', () => {
  const github = mcpIntegration('github-mcp')

  expect(mergeCatalogMcpEntry(github.entry)).toBe(github.entry)
})
